# 特种气体钢瓶流转API

运行：

```bash
npm start
```

默认端口是`3008`，数据保存在`data/`目录下。

## 项目结构

```
├── server.js              # 主入口，组合路由
├── store/                 # 数据读写层
│   ├── common.js          # 公共工具（send、body、loadJson、saveJson）
│   ├── cylinders.js       # 钢瓶数据 CRUD
│   ├── customers.js       # 客户数据 CRUD
│   ├── bulkImport.js      # 批量导入校验逻辑
│   ├── rentalOrders.js    # 租借订单数据 CRUD
│   ├── dashboard.js       # 看板统计计算逻辑
│   └── inspectionTasks.js # 检验任务数据 CRUD 与状态流转逻辑
├── routes/                # 路由处理层
│   ├── cylinders.js       # 钢瓶流转路由
│   ├── customers.js       # 客户档案路由
│   ├── reports.js         # 报警路由
│   ├── rentalOrders.js    # 租借订单路由
│   └── inspectionTasks.js # 检验任务路由
├── data/                  # 持久化存储
│   ├── cylinders.json     # 钢瓶数据
│   ├── customers.json     # 客户数据
│   ├── rentalOrders.json  # 租借订单数据
│   └── inspectionTasks.json # 检验任务数据
```

## 钢瓶流转端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /cylinders | 查询钢瓶列表，支持 `?status=` `?gasType=` 筛选 |
| POST | /cylinders | 新建钢瓶，需传 `id`、`gasType` |
| POST | /cylinders/bulk/preview | 批量导入预览校验，返回错误摘要 |
| POST | /cylinders/bulk/confirm | 批量导入确认写入，只写入校验通过的数据 |
| POST | /cylinders/:id/actions | 钢瓶动作，`type` 可选 `inbound`/`outbound`/`return`/`inspect`/`scrap` |
| POST | /cylinders/:id/fills | 记录充装 |
| GET | /reports/alerts | 报警列表，支持 `?inspectionDays=` `?longRentDays=` |

### 批量导入钢瓶

批量导入分为**预览校验**和**确认写入**两步，确认写入采用**部分成功**语义：只写入通过校验的数据，有错误的数据会被拒绝并返回错误明细。

**第一步：预览校验**

提交一批钢瓶 JSON 数据进行校验，返回错误摘要和通过校验的数据预览，不会写入任何数据。

```json
POST /cylinders/bulk/preview
[
  { "id": "CY-99001", "gasType": "高纯氧", "capacity": "40L", "inspectionDue": "2027-03-15", "location": "一号仓" },
  { "id": "CY-99002", "gasType": "液氮", "capacity": "50L", "inspectionDue": "2026-12-01" },
  { "id": "CY-99001", "gasType": "高纯氩", "inspectionDue": "2027-01-20" },
  { "gasType": "二氧化碳", "inspectionDue": "2027-05-10" },
  { "id": "CY-99005", "inspectionDue": "2027-05-10" },
  { "id": "CY-99006", "gasType": "氦气" },
  { "id": "CY-99007", "gasType": "混合气", "inspectionDue": "bad-date" },
  { "id": "CY-88001", "gasType": "高纯氩", "inspectionDue": "2027-06-01" }
]
```

返回结果：

```json
{
  "totalCount": 8,
  "validCount": 1,
  "errorCount": 7,
  "preview": [
    { "id": "CY-99002", "gasType": "液氮", "capacity": "50L", "inspectionDue": "2026-12-01", "status": "in_stock", ... }
  ],
  "errors": [
    { "index": 3, "id": null, "errors": ["missing_id"] },
    { "index": 4, "id": "CY-99005", "errors": ["missing_gasType"] },
    { "index": 5, "id": "CY-99006", "errors": ["missing_inspectionDue"] },
    { "index": 6, "id": "CY-99007", "errors": ["invalid_inspectionDue"] },
    { "index": 0, "id": "CY-99001", "errors": ["duplicate_id_in_batch"] },
    { "index": 2, "id": "CY-99001", "errors": ["duplicate_id_in_batch"] },
    { "index": 7, "id": "CY-88001", "errors": ["duplicate_id_in_storage"] }
  ],
  "summary": {
    "missing_id": [{ "index": 3, "id": null }],
    "missing_gasType": [{ "index": 4, "id": "CY-99005" }],
    "missing_inspectionDue": [{ "index": 5, "id": "CY-99006" }],
    "invalid_inspectionDue": [{ "index": 6, "id": "CY-99007" }],
    "duplicate_id_in_storage": [{ "index": 7, "id": "CY-88001" }],
    "duplicate_id_in_batch": [{ "index": 0, "id": "CY-99001" }, { "index": 2, "id": "CY-99001" }]
  }
}
```

**第二步：确认写入（部分成功语义）**

提交数据后，系统会再次校验，**只写入通过校验的数据**，有错误的数据会被拒绝。

- 如果有部分数据通过校验：返回 `201`，包含 `created`（成功数量）和 `rejected`（失败数量）
- 如果全部数据都未通过：返回 `422`

示例（包含2条正确数据和2条错误数据）：

```json
POST /cylinders/bulk/confirm
[
  { "id": "CY-99001", "gasType": "高纯氧", "capacity": "40L", "inspectionDue": "2027-03-15", "location": "一号仓" },
  { "id": "CY-99002", "gasType": "液氮", "capacity": "50L", "inspectionDue": "2026-12-01" },
  { "id": "CY-99003", "gasType": "氩气" },
  { "gasType": "二氧化碳", "inspectionDue": "2027-05-10" }
]
```

返回结果（201 部分成功）：

```json
{
  "totalCount": 4,
  "created": 2,
  "rejected": 2,
  "cylinders": [
    { "id": "CY-99001", "gasType": "高纯氧", ... },
    { "id": "CY-99002", "gasType": "液氮", ... }
  ],
  "errors": [
    { "index": 2, "id": "CY-99003", "errors": ["missing_inspectionDue"] },
    { "index": 3, "id": null, "errors": ["missing_id"] }
  ],
  "summary": {
    "missing_id": [{ "index": 3, "id": null }],
    "missing_inspectionDue": [{ "index": 2, "id": "CY-99003" }],
    "missing_gasType": [],
    "invalid_inspectionDue": [],
    "duplicate_id_in_storage": [],
    "duplicate_id_in_batch": []
  }
}
```

**校验规则：**

| 错误类型 | 说明 |
|----------|------|
| `missing_id` | 缺少钢瓶编号 |
| `missing_gasType` | 缺少气体类型 |
| `missing_inspectionDue` | 缺少检验日期 |
| `invalid_inspectionDue` | 检验日期格式无效 |
| `duplicate_id_in_batch` | 批次内编号重复 |
| `duplicate_id_in_storage` | 编号已存在于库中 |

### 出库时关联客户

`outbound` 动作必须传入 `customer`（客户ID），系统会校验客户是否存在于客户档案中，不存在则返回 `422 customer_not_found`。

```json
POST /cylinders/CY-88001/actions
{
  "type": "outbound",
  "customer": "CU-001",
  "depositStatus": "paid"
}
```

## 客户档案端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /customers | 创建客户，需传 `name`（不可重复） |
| GET | /customers | 查询客户列表 |
| GET | /customers/:id | 查看客户详情 |
| GET | /customers/:id/cylinders | 查询客户名下正在租借的钢瓶 |
| GET | /customers/:id/deposits | 查询客户押金状态汇总 |

### 创建客户

```json
POST /customers
{
  "name": "宁川检测",
  "contact": "李明",
  "phone": "13800001111",
  "address": "宁川市高新区检测路88号"
}
```

返回 `201` 和创建的客户对象。如果 `name` 已存在，返回 `409 customer_name_exists`。

### 客户详情

```json
GET /customers/CU-001
```

返回客户完整信息，不存在则 `404 customer_not_found`。

### 客户租借钢瓶

```json
GET /customers/CU-001/cylinders
```

返回该客户名下所有 `status=rented` 的钢瓶列表。

### 押金状态汇总

```json
GET /customers/CU-001/deposits
```

返回格式：

```json
{
  "customerId": "CU-001",
  "customerName": "宁川检测",
  "totalRented": 2,
  "deposits": [
    { "cylinderId": "CY-88002", "gasType": "混合标准气", "depositStatus": "paid" }
  ],
  "depositCounts": {
    "paid": 1,
    "unpaid": 0,
    "refundable": 0,
    "none": 0
  }
}
```

## 运营看板端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /reports/dashboard | 运营看板汇总统计 |

### 看板统计

基于现有 `cylinders`、`fills` 和 `events` 数据计算，不额外引入数据库。统计计算逻辑拆分在 `store/dashboard.js` 中，与 HTTP 路由层解耦。

**请求参数（可选）：**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `inspectionDays` | 45 | 即将到检的提前天数阈值 |
| `longRentDays` | 30 | 长期租借的天数阈值 |

```json
GET /reports/dashboard
```

返回结果（以下为当前示例数据的响应结构，`daysLeft` 和 `rentDays` 会随运行日期变化）：

```json
{
  "total": 2,
  "byStatus": {
    "rented": 2
  },
  "byGasType": {
    "高纯氩": 1,
    "混合标准气": 1
  },
  "inspectionDueSoon": {
    "count": 2,
    "thresholdDays": 45,
    "items": [
      {
        "cylinderId": "CY-88001",
        "gasType": "高纯氩",
        "due": "2026-07-20",
        "daysLeft": 37
      },
      {
        "cylinderId": "CY-88002",
        "gasType": "混合标准气",
        "due": "2026-06-28",
        "daysLeft": 15
      }
    ]
  },
  "longRent": {
    "count": 1,
    "thresholdDays": 30,
    "items": [
      {
        "cylinderId": "CY-88002",
        "gasType": "混合标准气",
        "customer": "CU-001",
        "since": "2026-05-10T10:00:00.000Z",
        "rentDays": 34
      }
    ]
  },
  "fills": {
    "totalFills": 1,
    "fillsByOperator": {
      "陈起": 1
    }
  },
  "events": {
    "inbound": 1,
    "outbound": 2
  }
}
```

**响应字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `total` | number | 钢瓶库存总数 |
| `byStatus` | object | 按状态分组的数量统计，key 为状态名（`in_stock`/`rented`/`returned`/`inspection`/`scrapped`） |
| `byGasType` | object | 按气体类型分组的数量统计，key 为气体类型名称 |
| `inspectionDueSoon` | object | 即将到检汇总，含 `count`（数量）、`thresholdDays`（阈值天数）、`items`（明细列表） |
| `inspectionDueSoon.items[].daysLeft` | number | 距离检验到期的剩余天数，负数表示已逾期 |
| `longRent` | object | 长期租借汇总，含 `count`（数量）、`thresholdDays`（阈值天数）、`items`（明细列表） |
| `longRent.items[].rentDays` | number | 已租借天数 |
| `fills` | object | 充装统计，含 `totalFills`（总充装次数）和 `fillsByOperator`（按操作员分组） |
| `events` | object | 事件统计，按事件类型分组计数 |

## 检验任务端点

检验任务模块用于管理钢瓶定期检验的全流程：从临近检验的钢瓶自动生成待检任务，到送检、录入结果、恢复入库。任务状态与钢瓶状态、事件记录、到检提醒保持一致。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /inspection-tasks | 查询任务列表，支持 `?status=` `?cylinderId=` 筛选 |
| POST | /inspection-tasks/generate | 生成待检任务，将临近检验的钢瓶自动纳入任务 |
| GET | /inspection-tasks/:id | 查看任务详情 |
| POST | /inspection-tasks/:id/send | 送检，将钢瓶状态设为 `inspection` |
| POST | /inspection-tasks/:id/inspect | 录入检验结果，`passed` 为 `true` 或 `false` |
| POST | /inspection-tasks/:id/restock | 恢复入库，将检验合格的钢瓶恢复为 `in_stock` |

### 任务状态流转

```
pending → sent → passed → restocked
                ↘ failed（检验不合格，钢瓶自动报废）
```

| 任务状态 | 说明 | 钢瓶状态联动 |
|----------|------|-------------|
| `pending` | 待检，已由系统自动生成 | 不变 |
| `sent` | 已送检 | → `inspection` |
| `passed` | 检验合格 | 不变（仍为 `inspection`，等待恢复入库） |
| `failed` | 检验不合格 | → `scrapped` |
| `restocked` | 已恢复入库 | → `in_stock` |

### 生成待检任务

扫描所有钢瓶，将临近检验（默认45天内）且状态不是 `scrapped`、`inspection` 或 `rented`、且没有进行中任务的钢瓶生成待检任务。

```json
POST /inspection-tasks/generate
{
  "thresholdDays": 45
}
```

返回结果：

```json
{
  "generated": 2,
  "skipped": 0,
  "breakdown": {
    "byStatus": 0,
    "byExistingTask": 0,
    "byDueDate": 0
  },
  "tasks": [
    {
      "id": "IT-1718389234567-a1b2c3",
      "cylinderId": "CY-88001",
      "gasType": "高纯氩",
      "capacity": "40L",
      "inspectionDue": "2026-07-20",
      "status": "pending",
      "result": null,
      "createdAt": "2026-06-14T10:00:00.000Z",
      "sentAt": null,
      "inspectedAt": null,
      "restockedAt": null
    },
    {
      "id": "IT-1718389234568-d4e5f6",
      "cylinderId": "CY-88002",
      "gasType": "混合标准气",
      "capacity": "8L",
      "inspectionDue": "2026-06-28",
      "status": "pending",
      "result": null,
      "createdAt": "2026-06-14T10:00:00.000Z",
      "sentAt": null,
      "inspectedAt": null,
      "restockedAt": null
    }
  ]
}
```

**`breakdown` 字段说明：**

| 字段 | 说明 |
|------|------|
| `byStatus` | 因钢瓶状态为 `scrapped`/`inspection`/`rented` 被排除的数量 |
| `byExistingTask` | 因该钢瓶已有进行中检验任务被排除的数量 |
| `byDueDate` | 因距检验到期日超过阈值天数被排除的数量 |

重复调用不会为同一钢瓶生成重复任务（已有进行中任务的钢瓶会被跳过）。

### 送检

将任务从 `pending` 推进到 `sent`，同时将钢瓶状态设为 `inspection`，并记录事件。

```json
POST /inspection-tasks/IT-1718389234567-a1b2c3/send
{
  "location": "宁川检测站"
}
```

**校验规则：**
- 任务必须处于 `pending` 状态，否则返回 `409 transition_not_allowed`
- 钢瓶如果已被报废（`scrapped`），返回 `422 cylinder_scrapped`
- 钢瓶如果已被租出（`rented`），返回 `422 cylinder_rented`

### 录入检验结果

将任务从 `sent` 推进到 `passed` 或 `failed`。

**检验合格：**

```json
POST /inspection-tasks/IT-1718389234567-a1b2c3/inspect
{
  "passed": true,
  "inspector": "张三",
  "nextInspectionDue": "2029-07-20",
  "notes": "外观无损，压力合格"
}
```

检验合格时，如果传入 `nextInspectionDue`，会自动更新钢瓶的 `inspectionDue` 字段。

**检验不合格：**

```json
POST /inspection-tasks/IT-1718389234567-a1b2c3/inspect
{
  "passed": false,
  "inspector": "张三",
  "notes": "瓶壁腐蚀严重，无法继续使用"
}
```

检验不合格时，钢瓶状态自动变为 `scrapped`，后续无法恢复入库。

**校验规则：**
- `passed` 为必填布尔字段，缺失返回 `400 passed_boolean_required`
- 任务必须处于 `sent` 状态，否则返回 `409 transition_not_allowed`
- 钢瓶如果已被报废或租出，返回 `422`

### 恢复入库

将检验合格的任务从 `passed` 推进到 `restocked`，钢瓶恢复为 `in_stock`。

```json
POST /inspection-tasks/IT-1718389234567-a1b2c3/restock
{
  "location": "一号仓"
}
```

**校验规则：**
- 任务必须处于 `passed` 状态，否则返回 `409 transition_not_allowed`
- 钢瓶必须是 `inspection` 状态，否则返回 `409 cylinder_not_in_inspection`
- 钢瓶如果已被报废（`scrapped`），返回 `422 cylinder_scrapped_cannot_restock`
- 钢瓶如果已被租出（`rented`），返回 `422 cylinder_rented_cannot_restock`

### 到检提醒与任务联动

`GET /reports/alerts` 返回的 `inspection_due` 提醒现在包含关联的检验任务信息：

```json
{
  "type": "inspection_due",
  "cylinderId": "CY-88001",
  "due": "2026-07-20",
  "daysLeft": 36,
  "taskStatus": "sent",
  "taskId": "IT-1718389234567-a1b2c3"
}
```

- `taskStatus` 为 `null` 表示尚未生成检验任务
- `taskStatus` 为 `pending`/`sent`/`passed` 表示任务进行中
- 任务已 `failed` 或 `restocked` 后，`taskStatus` 回归 `null`

### 错误码汇总

| 错误码 | HTTP状态码 | 说明 |
|--------|-----------|------|
| `task_not_found` | 404 | 任务不存在 |
| `cylinder_not_found` | 404 | 关联钢瓶不存在 |
| `invalid_status` | 400 | 无效的目标状态 |
| `passed_boolean_required` | 400 | inspect 时缺少 passed 布尔字段 |
| `transition_not_allowed` | 409 | 当前任务状态不允许该操作 |
| `cylinder_not_in_inspection` | 409 | 钢瓶不在检验状态，无法恢复入库 |
| `cylinder_scrapped` | 422 | 钢瓶已报废，操作被拒绝 |
| `cylinder_rented` | 422 | 钢瓶已租出，操作被拒绝 |
| `cylinder_scrapped_cannot_restock` | 422 | 已报废钢瓶不能恢复入库 |
| `cylinder_rented_cannot_restock` | 422 | 已租出钢瓶不能恢复入库 |
