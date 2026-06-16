# 特种气体钢瓶流转API

运行：

```bash
npm start
```

默认端口是`3008`。

## 数据版本与迁移

### 概述

系统内置数据版本管理和自动迁移机制，支持数据Schema的平滑演进。启动服务时会自动检测数据版本并执行必要的迁移。

### 数据目录结构

```
data/
  meta.json              # 版本元信息（当前版本、迁移历史等）
  v2/                    # v2 版本数据目录
    cylinders.json       # 钢瓶数据
    customers.json       # 客户数据
    rentalOrders.json    # 租瓶订单数据
    inspectionTasks.json # 检验任务数据
    operationLogs.json   # 操作流水数据
    inventoryChecks.json # 库存盘点数据
    idempotency.json     # 幂等性数据
    README.md            # 版本说明
  backups/               # 迁移备份目录
    v1-to-v2-20260615-000000/
      backup-meta.json   # 备份元信息
      ...                # 备份的数据文件
```

### 版本历史

| 版本 | 说明 |
|------|------|
| v1 | 扁平结构，数据文件直接放在 `data/` 目录下 |
| v2 | 版本化目录结构，每个实体独立存储，文件包含 Schema 版本元数据 |

### 自动迁移

服务启动时会自动执行数据迁移：

1. 检测当前数据版本
2. 如果不是最新版本，先创建完整备份
3. 按顺序执行各版本迁移脚本
4. 迁移失败时自动回滚到原版本，不破坏原始数据
5. 更新版本元信息

### 命令行工具

提供独立的迁移管理脚本 `scripts/migrate.js`：

```bash
# 查看数据版本状态
npm run migrate:status

# 执行迁移到最新版本
npm run migrate:up

# 列出所有备份
npm run migrate:list-backups

# 从指定备份恢复
npm run migrate:restore -- backup-name

# 回滚到 v1
npm run migrate:down

# 强制升级（忽略验证错误）
npm run migrate:force
```

也可以直接运行脚本：

```bash
node scripts/migrate.js status
node scripts/migrate.js up
node scripts/migrate.js down 1
node scripts/migrate.js list-backups
node scripts/migrate.js restore <backup-name>
node scripts/migrate.js force-up
```

### 迁移安全机制

- **前置备份**：迁移前自动创建完整数据备份
- **备份验证**：备份创建后自动验证完整性
- **失败回滚**：迁移过程中任何错误都会触发自动回滚
- **原子写入**：使用临时文件 + 重命名的原子写入方式，避免写入中断损坏数据
- **备份保留**：所有历史备份保留在 `data/backups/` 目录

### 向后兼容性

所有 API 接口保持完全向后兼容：

- 现有接口返回的数据格式和字段保持不变
- 内部版本元数据（`_schemaVersion`、`_meta`）不会泄露到 API 响应中
- 保存数据时自动保留版本元数据

## 权限矩阵接口

### 概述

`GET /auth/permissions` 提供可查询的权限矩阵详情，返回每个业务权限的中文说明、对应接口路径和拥有该权限的角色列表，支持按角色过滤。数据从 `auth/users.js` 的 `PERMISSIONS`、`ROLE_PERMISSIONS` 和 `PERMISSION_META` 自动生成，与代码中的真实权限定义保持同步。

### 接口

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| `GET` | `/auth/permissions` | 查询权限矩阵 | Bearer Token |
| `GET` | `/auth/permissions?role=qc` | 按角色过滤权限矩阵 | Bearer Token |

### 查询参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `role` | 按角色过滤，仅返回该角色拥有的权限 | `admin`、`warehouse`、`sales`、`qc` |

### 响应格式

```json
{
  "permissions": [
    {
      "key": "cylinder:create",
      "label": "新建钢瓶",
      "category": "钢瓶管理",
      "endpoints": ["POST /cylinders"],
      "roles": ["admin", "warehouse"]
    }
  ],
  "roleInfo": [
    { "role": "admin", "label": "管理员" },
    { "role": "warehouse", "label": "仓库" },
    { "role": "sales", "label": "销售" },
    { "role": "qc", "label": "质检" }
  ],
  "totalPermissions": 21,
  "note": "所有已认证用户均可访问 GET 查询类接口（无需特定权限），此处仅列出写操作权限"
}
```

### 权限分类

| 分类 | 包含权限 |
|------|---------|
| 钢瓶管理 | `cylinder:create`、`cylinder:bulk`、`cylinder:inbound`、`cylinder:outbound`、`cylinder:return`、`cylinder:inspect`、`cylinder:scrap`、`cylinder:fill` |
| 客户管理 | `customer:create` |
| 订单管理 | `order:create`、`order:return` |
| 检验管理 | `inspection:generate`、`inspection:send`、`inspection:inspect`、`inspection:restock`、`inspection:postpone` |
| 盘点管理 | `inventory:create`、`inventory:scan`、`inventory:complete`、`inventory:confirm` |
| 数据查询 | `query` |
| 系统管理 | `idempotency:query` |

### 与 /auth/roles 的区别

- `/auth/roles`：返回角色列表及每个角色的权限字符串数组，适合 UI 角色展示
- `/auth/permissions`：以权限为中心的矩阵视图，包含中文说明和对应接口，适合权限文档化和审计

## 幂等记录查询接口

### 概述

`GET /idempotency-records` 提供幂等记录的查询能力，方便排查重复提交和失败操作。仅管理员角色可访问。响应中自动隐藏请求体和响应体中的敏感字段（password、token、secret 等），并关联 `operationLogId` 展示对应操作日志摘要。

### 接口

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| `GET` | `/idempotency-records` | 查询幂等记录 | `idempotency:query`（仅 admin） |

### 查询参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `key` | 按幂等键模糊搜索 | `auto-abc` |
| `operator` | 按操作人模糊搜索 | `admin` |
| `status` | 按状态筛选（`processing` / `completed`） | `completed` |
| `path` | 按请求路径模糊搜索 | `/cylinders` |
| `startAt` | 创建时间起始（ISO 8601） | `2026-06-01T00:00:00.000Z` |
| `endAt` | 创建时间截止（ISO 8601） | `2026-06-30T23:59:59.999Z` |
| `page` | 页码 | `1` |
| `pageSize` | 每页条数，最大 100 | `20` |

### 响应格式

```json
{
  "items": [
    {
      "key": "auto-abc123...",
      "method": "POST",
      "path": "/cylinders",
      "bodyHash": "sha256...",
      "operator": "admin",
      "status": "completed",
      "response": {
        "statusCode": 200,
        "body": { "id": "CY-001", "gasType": "高纯氩" }
      },
      "operationLogId": "op-xxx",
      "operationLog": {
        "id": "op-xxx",
        "operationType": "cylinder.create",
        "targetType": "cylinder",
        "targetId": "CY-001",
        "status": "success",
        "error": null,
        "requestBody": { "gasType": "高纯氩", "capacity": "40L" },
        "createdAt": "2026-06-15T10:00:00.000Z"
      },
      "createdAt": "2026-06-15T10:00:00.000Z",
      "completedAt": "2026-06-15T10:00:01.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalCount": 1,
    "totalPages": 1,
    "hasNext": false,
    "hasPrev": false
  }
}
```

### 敏感字段脱敏

响应体和关联的操作日志请求体中，以下字段自动替换为 `******`：

- `password`、`token`、`secret`、`authorization`
- `creditcard`、`credit_card`
- `apikey`、`api_key`
- `accesstoken`、`access_token`、`refreshtoken`、`refresh_token`

脱敏为递归处理，嵌套对象中的敏感字段同样会被隐藏。

### 权限分配

| 权限 | admin | warehouse | qc | sales |
|------|-------|-----------|-----|-------|
| `idempotency:query` | ✅ | - | - | - |

## 钢瓶列表接口

### 概述

`GET /cylinders` 支持多维度筛选与分页查询钢瓶列表。

### 筛选参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `status` | 按钢瓶状态筛选 | `in_stock`、`rented`、`returned`、`inspection`、`scrapped`、`pending_check` |
| `gasType` | 按气体类型筛选 | `高纯氩`、`混合标准气` |
| `location` | 按库位筛选 | `一号仓` |
| `customer` | 按客户筛选；传空字符串筛选无客户钢瓶 | `宁川检测` |
| `inspectionDueBefore` | 筛选到检日期早于指定日期的钢瓶 | `2026-07-01` |
| `keyword` | 关键词模糊搜索（匹配 id、gasType、capacity、location、customer） | `CY-88` |
| `latestEventType` | 按最近操作类型筛选（基于 events 字段最新一条） | `inbound`、`outbound`、`return`、`inspect`、`scrap`、`fill`、`create` |
| `latestEventTimeFrom` | 最近操作时间起始（ISO 8601），与 `latestEventType` 可组合使用 | `2026-06-01T00:00:00.000Z` |
| `latestEventTimeTo` | 最近操作时间截止（ISO 8601），与 `latestEventType` 可组合使用 | `2026-06-15T23:59:59.999Z` |

### 分页参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `pagination` | 传任意值启用分页 | 无（不传则返回全量） |
| `page` | 页码（需启用分页） | `1` |
| `pageSize` | 每页条数，最大 100（需启用分页） | `20` |

### 分页响应格式

```json
{
  "items": [ ... ],
  "total": 50,
  "page": 1,
  "pageSize": 20,
  "totalPages": 3
}
```

### 筛选逻辑说明

- `latestEventType`：取钢瓶 `events` 数组中 `at` 时间最新的一条事件，若其 `type` 与参数匹配则保留。无事件的钢瓶会被排除。
- `latestEventTimeFrom` / `latestEventTimeTo`：取钢瓶最近事件的 `at` 时间，判断是否落在指定时间范围内。可单独使用或与 `latestEventType` 组合。无事件的钢瓶会被排除。

### 示例

```
GET /cylinders?status=in_stock&latestEventType=inbound&latestEventTimeFrom=2026-06-01T00:00:00.000Z&latestEventTimeTo=2026-06-30T23:59:59.999Z&pagination=1&page=1&pageSize=10
```

## 租瓶订单模块

### 概述

租瓶订单模块支持钢瓶租借订单的创建、查询和归还闭环。订单记录了客户信息、租借钢瓶明细、押金状态等，归还操作支持按订单部分或全部归还钢瓶，并自动更新钢瓶状态、押金状态、库位和操作日志。

### 订单状态

| 状态 | 说明 |
|------|------|
| `completed` | 订单已完成创建，未发生归还 |
| `partially_returned` | 部分钢瓶已归还 |
| `fully_returned` | 全部钢瓶已归还 |

### 订单数据结构

每个钢瓶在订单中包含以下归还信息：
- `returned`：是否已归还
- `returnedAt`：归还时间
- `returnNote`：归还备注

订单级别字段：
- `returnedCount`：已归还钢瓶数
- `returnHistory`：归还历史记录数组，每次归还生成一条记录

### API 接口

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| `GET` | `/rental-orders` | 查询租瓶订单列表 | `query` |
| `POST` | `/rental-orders` | 创建租瓶订单 | `order:create` |
| `GET` | `/rental-orders/:id` | 获取订单详情 | `query` |
| `POST` | `/rental-orders/:id/return` | 订单级归还钢瓶 | `order:return` |
| `GET` | `/customers/:id/orders` | 查询某客户的所有订单 | `query` |

### 创建租瓶订单

```json
POST /rental-orders
{
  "customerId": "CUS-001",
  "cylinders": [
    { "id": "CY-88001", "depositStatus": "paid", "note": "" }
  ],
  "note": "月度租借"
}
```

### 订单级归还钢瓶

```json
POST /rental-orders/:id/return
{
  "cylinderIds": ["CY-88001", "CY-88002"],
  "returnLocation": "待检区",
  "depositRefunded": false,
  "note": "客户归还"
}
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cylinderIds` | `string[]` | 是 | 要归还的钢瓶 ID 列表，支持部分归还 |
| `returnLocation` | `string` | 否 | 归还后库位，默认"待检区" |
| `depositRefunded` | `boolean` | 否 | 是否已退还押金，默认 `false` |
| `note` | `string` | 否 | 归还备注 |

#### 校验规则

- 钢瓶必须属于该订单
- 钢瓶不能已归还
- 钢瓶状态必须为 `rented`
- 钢瓶当前客户必须与订单客户匹配

#### 响应状态码

| 状态码 | 说明 |
|--------|------|
| `200` | 全部钢瓶归还成功 |
| `207` | 部分钢瓶归还成功，部分校验失败（响应中包含 `errors` 字段） |
| `400` | 请求参数校验失败 |
| `404` | 订单不存在 |
| `422` | 所有钢瓶均校验失败，未执行任何归还操作 |

#### 归还操作自动完成

1. **钢瓶状态**：`rented` → `returned`
2. **钢瓶库位**：更新为指定的归还位置
3. **押金状态**：`depositRefunded=true` → `refunded`，否则 `refundable`
4. **订单归还明细**：标记对应钢瓶为已归还，记录归还时间和备注
5. **订单状态**：自动计算为 `partially_returned` 或 `fully_returned`
6. **操作日志**：生成 `order.return` 类型操作记录
7. **钢瓶事件**：每个归还钢瓶添加 `return` 类型事件
8. **幂等保护**：使用 `Idempotency-Key` 头或自动幂等键，重复请求不会重复写事件

### 权限分配

| 权限 | admin | warehouse | qc | sales |
|------|-------|-----------|-----|-------|
| `order:create` | ✅ | ✅ | - | ✅ |
| `order:return` | ✅ | ✅ | - | ✅ |

## 检验任务模块

### 概述

检验任务模块支持钢瓶定期检验的全流程管理，包括任务生成、送检、录入检验结果、回库以及延期检验。系统根据钢瓶到检日期自动生成检验任务，质检人员可跟踪任务状态并执行相应操作。

### 任务状态流转

```
pending → sent → passed → restocked
              ↘ failed
```

| 状态 | 说明 |
|------|------|
| `pending` | 待送检，任务已生成但尚未送出 |
| `sent` | 已送检，钢瓶已送出检验 |
| `passed` | 检验合格 |
| `failed` | 检验不合格，钢瓶已报废 |
| `restocked` | 已回库，检验完成并恢复入库 |

### API 接口

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| `GET` | `/inspection-tasks` | 查询检验任务列表 | `query` |
| `POST` | `/inspection-tasks/generate` | 生成检验任务 | `inspection:generate` |
| `GET` | `/inspection-tasks/:id` | 获取任务详情 | `query` |
| `POST` | `/inspection-tasks/:id/send` | 送检 | `inspection:send` |
| `POST` | `/inspection-tasks/:id/inspect` | 录入检验结果 | `inspection:inspect` |
| `POST` | `/inspection-tasks/:id/restock` | 回库 | `inspection:restock` |
| `POST` | `/inspection-tasks/:id/postpone` | 延期检验 | `inspection:postpone` |

### 生成检验任务

```json
POST /inspection-tasks/generate
{
  "thresholdDays": 45
}
```

系统会自动筛选距离到检日期在阈值天数内、未处于检验中/租借/报废状态、且没有活跃检验任务的钢瓶，生成检验任务。

### 送检

```json
POST /inspection-tasks/:id/send
{
  "location": "第三方检验机构"
}
```

送检后钢瓶状态变为 `inspection`，任务状态变为 `sent`。

### 录入检验结果

```json
POST /inspection-tasks/:id/inspect
{
  "passed": true,
  "inspector": "张三",
  "notes": "检验合格",
  "nextInspectionDue": "2027-06-15"
}
```

检验合格时任务状态变为 `passed`，可选择更新下次到检日期；检验不合格时钢瓶自动报废，任务状态变为 `failed`。

### 回库

```json
POST /inspection-tasks/:id/restock
{
  "location": "一号仓"
}
```

检验合格的任务执行回库操作后，钢瓶状态恢复为 `in_stock`，任务状态变为 `restocked`。

### 延期检验

```json
POST /inspection-tasks/:id/postpone
{
  "newInspectionDue": "2026-12-31",
  "reason": "检验机构排期紧张",
  "operator": "李四"
}
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `newInspectionDue` | `string` | 是 | 新的到检日期（YYYY-MM-DD 格式） |
| `reason` | `string` | 是 | 延期原因，不能为空 |
| `operator` | `string` | 否 | 操作人 |

#### 校验规则

- 钢瓶已报废（`scrapped`）不能延期
- 任务已完成（`passed`、`failed`、`restocked`）不能延期
- 只能对 `pending` 或 `sent` 状态的任务执行延期

#### 延期操作自动完成

1. **任务到检日期**：更新为新的 `newInspectionDue`
2. **延期历史**：在任务 `postponements` 数组中添加记录（包含原日期、新日期、原因、时间、操作人）
3. **状态历史**：在任务 `statusHistory` 数组中添加记录
4. **钢瓶到检日期**：同步更新钢瓶的 `inspectionDue`
5. **钢瓶事件**：添加 `inspect_postpone` 类型事件
6. **操作日志**：生成 `inspection.postpone` 类型操作记录
7. **幂等保护**：支持 `Idempotency-Key` 头

### 权限分配

| 权限 | admin | warehouse | qc | sales |
|------|-------|-----------|-----|-------|
| `inspection:generate` | ✅ | - | ✅ | - |
| `inspection:send` | ✅ | - | ✅ | - |
| `inspection:inspect` | ✅ | - | ✅ | - |
| `inspection:restock` | ✅ | ✅ | ✅ | - |
| `inspection:postpone` | ✅ | - | ✅ | - |

## 库存盘点模块

### 概述

库存盘点模块支持对钢瓶进行周期性实物盘点，自动比对系统账面与实际扫描结果，计算盘盈盘亏差异，并生成差异处理建议。确认盘点后，缺失的钢瓶会自动标记为"待核查"状态。

### 盘点单状态流转

```
draft → scanning → completed → confirmed
```

| 状态 | 说明 |
|------|------|
| `draft` | 新建盘点单，已确定盘点范围和预期钢瓶清单 |
| `scanning` | 开始扫描录入，可多次录入实际扫描到的钢瓶编号 |
| `completed` | 扫描完成，系统自动计算差异和处理建议 |
| `confirmed` | 确认盘点结果，缺失钢瓶标记为`pending_check`状态 |

### 受保护状态

盘点确认时，以下状态的钢瓶**不会**被变更状态，仅生成人工核实建议：
- `rented`（租借中）
- `inspection`（送检中）
- `scrapped`（已报废）

### API 接口

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| `GET` | `/inventory-checks` | 查询盘点单列表（支持多维度筛选） | `query` |
| `POST` | `/inventory-checks` | 创建盘点单 | `inventory:create` |
| `GET` | `/inventory-checks/:id` | 获取盘点单详情 | `query` |
| `POST` | `/inventory-checks/:id/start` | 开始扫描 | `inventory:scan` |
| `POST` | `/inventory-checks/:id/scan` | 录入扫描钢瓶编号 | `inventory:scan` |
| `POST` | `/inventory-checks/:id/complete` | 完成扫描并计算差异 | `inventory:complete` |
| `GET` | `/inventory-checks/:id/differences` | 获取差异报告和建议 | `query` |
| `POST` | `/inventory-checks/:id/confirm` | 确认盘点，标记缺失钢瓶 | `inventory:confirm` |
| `GET` | `/inventory-checks/:id/history?cylinderId=XX` | 查询某钢瓶在该盘点单中的历史 | `query` |
| `GET` | `/cylinders/:id/inventory-history` | 查询某钢瓶在所有盘点中的历史 | `query` |
| `GET` | `/reports/inventory-summary` | 盘点汇总报表 | `query` |

#### 盘点单列表筛选参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `status` | 按盘点单状态筛选 | `draft`、`scanning`、`completed`、`confirmed` |
| `createdBy` | 按创建人筛选 | `张三` |
| `location` | 按盘点范围库位筛选（匹配 `scope.location`） | `一号仓` |
| `gasType` | 按盘点范围气体类型筛选（匹配 `scope.gasType`） | `高纯氩` |
| `createdFrom` | 创建时间起始（ISO 8601） | `2026-06-01T00:00:00.000Z` |
| `createdTo` | 创建时间截止（ISO 8601） | `2026-06-30T23:59:59.999Z` |

返回结果默认按 `createdAt` 倒序排列。所有筛选参数均可独立使用或任意组合。

示例：

```
GET /inventory-checks?status=draft&createdBy=张三&location=一号仓&createdFrom=2026-06-01T00:00:00.000Z&createdTo=2026-06-30T23:59:59.999Z
```

### 创建盘点单

```json
POST /inventory-checks
{
  "title": "2026年6月仓库盘点",
  "scope": {
    "location": "一号仓"
  },
  "note": "月度例行盘点"
}
```

`scope` 支持按 `location`、`gasType`、`status` 筛选盘点范围，不传则包含所有钢瓶。

### 扫描录入

单条扫描：

```json
POST /inventory-checks/:id/scan
{
  "cylinderId": "CY-88001",
  "operator": "张三"
}
```

批量扫描：

```json
POST /inventory-checks/:id/scan
{
  "cylinderIds": ["CY-88001", "CY-88002", "CY-88003"],
  "operator": "张三"
}
```

重复扫描同一钢瓶编号时，系统会标记 `duplicate: true`，但不会拒绝录入，原始扫描记录可追溯。计算差异时按唯一钢瓶编号去重处理。

### 差异报告

差异报告包含以下信息：

- **matched**：预期内且已扫到的钢瓶（账实相符）
- **deficit**：预期内但未扫到的钢瓶（盘亏），标记是否受保护
- **surplus**：非预期但扫到的钢瓶（盘盈），包含 `existsInSystem` 和 `protected` 标记
- **suggestions**：差异处理建议，区分可操作和受保护两类

盘盈钢瓶分为三种类型：
- **surplus_migratable**：系统已存在且状态非受保护，确认时可选择迁移到盘点库位
- **surplus_protected**：系统已存在但状态受保护（租借中/送检中/已报废），不可迁移，需人工核实
- **surplus_unregistered**：系统中不存在，确认时生成待登记建议，需人工核实后建档

### 确认盘点

确认盘点时，除了将盘亏钢瓶标记为 `pending_check`，还可对盘盈钢瓶进行处理：

```json
POST /inventory-checks/:id/confirm
{
  "operator": "张三",
  "surplusMigrateIds": ["CY-88001", "CY-88002"]
}
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operator` | `string` | 否 | 操作人 |
| `surplusMigrateIds` | `string[]` | 否 | 需要迁移到盘点库位的盘盈钢瓶 ID 列表，仅对系统已存在且非受保护状态的钢瓶生效 |

#### 确认后自动处理

1. **盘亏处理**：非受保护状态的盘亏钢瓶标记为 `pending_check`，库位设为"待核查区"
2. **盘盈迁移**：`surplusMigrateIds` 中指定的、系统已存在且非受保护的盘盈钢瓶，库位迁移到盘点单的 `scope.location`
3. **待登记建议**：系统中不存在的盘盈钢瓶，生成待登记建议列表（不直接建档，需人工核实后登记）
4. **钢瓶事件**：盘亏钢瓶添加 `inventory_check` 事件，盘盈迁移钢瓶添加 `inventory_migrate` 事件
5. **操作日志**：生成 `inventory.confirm` 类型操作记录，包含盘点单前后状态和关联事件 ID

#### 响应示例

```json
{
  "check": { ... },
  "affectedDeficit": [
    { "cylinderId": "CY-88001", "previousStatus": "in_stock", "newStatus": "pending_check" }
  ],
  "affectedSurplusMigrated": [
    { "cylinderId": "CY-88003", "previousLocation": "二号仓", "newLocation": "一号仓" }
  ],
  "surplusRegistrationSuggestions": [
    { "cylinderId": "CY-99001", "suggestedLocation": "一号仓", "checkId": "IC-xxx" }
  ]
}
```

### 钢瓶状态

盘点确认后新增钢瓶状态 `pending_check`（待核查），仅对非保护状态的盘亏钢瓶生效。可通过以下操作恢复：

```json
POST /cylinders/:id/actions
{
  "type": "clear_pending_check",
  "targetStatus": "in_stock",
  "location": "仓库"
}
```

盘盈迁移操作会在钢瓶事件中新增 `inventory_migrate` 类型事件，记录迁移前后的库位信息。

### 权限分配

| 权限 | admin | warehouse | qc | sales |
|------|-------|-----------|-----|-------|
| `inventory:create` | ✅ | ✅ | ✅ | - |
| `inventory:scan` | ✅ | ✅ | ✅ | - |
| `inventory:complete` | ✅ | ✅ | ✅ | - |
| `inventory:confirm` | ✅ | - | ✅ | - |

### 数据文件

盘点数据保存在当前版本数据目录下的 `inventoryChecks.json`。

## 合规追溯报表

### 概述

合规追溯报表模块支持生成指定时间范围内的钢瓶全生命周期合规追溯报告，涵盖客户、订单、检验、盘点、操作日志等多维度数据。报表采用**分阶段异步生成**方式，支持断点续跑、服务重启恢复、幂等重试，避免大数据量下的阻塞和内存溢出。

### 分阶段快照架构

报表生成采用 7 个阶段的流水线式处理，每个阶段完成后持久化进度，服务重启后可从最后完成阶段继续：

| 阶段顺序 | 阶段 key | 说明 | 依赖 | 处理方式 |
|---------|----------|------|------|----------|
| 1 | `customers` | 客户数据筛选 | 无 | 全量筛选 |
| 2 | `orders` | 租瓶订单筛选 | 无 | 全量筛选 |
| 3 | `inspections` | 检验任务筛选与风险计算 | 无 | 全量筛选+聚合 |
| 4 | `inventory` | 库存盘点筛选与差异计算 | 无 | 全量筛选+聚合 |
| 5 | `operationLogs` | 操作日志筛选与操作人汇总 | 无 | 分页增量加载 |
| 6 | `cylinders` | 钢瓶追溯信息构建 | orders, inspections, inventory, operationLogs | 分批处理 |
| 7 | `finalize` | 汇总统计与最终结果组装 | 所有前置阶段 | 聚合组装 |

每个阶段独立持久化数据文件，阶段间通过 `setTimeout` 让出事件循环，避免长时间阻塞。

### 分批处理与增量加载

为应对大数据量场景，核心阶段采用流式/分批处理：

- **钢瓶追溯阶段**：按 100 个/批 的批次处理钢瓶数据，每批完成后更新进度并让出事件循环，避免单阶段阻塞事件循环。
- **操作日志阶段**：按 500 条/页 的分页增量加载，逐步累加操作日志和操作人汇总，避免一次性加载全部日志到内存。
- **阶段间让步**：每个阶段完成后暂停 10ms，允许其他请求和任务获得执行机会。

### 报表状态

| 状态 | 说明 |
|------|------|
| `pending` | 等待处理 |
| `processing` | 生成中（含当前阶段信息） |
| `completed` | 已完成 |
| `failed` | 生成失败（含失败阶段信息） |

### 阶段状态

每个阶段在 `phases` 对象中有独立的状态跟踪：

| 状态 | 说明 |
|------|------|
| `pending` | 待执行 |
| `processing` | 执行中 |
| `completed` | 已完成 |
| `failed` | 执行失败 |

### API 接口

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| `POST` | `/compliance-reports` | 创建合规追溯报表任务 | `query` |
| `GET` | `/compliance-reports` | 查询报表列表（支持多维度筛选与分页） | `query` |
| `GET` | `/compliance-reports/:id` | 获取报表详情（含阶段进度） | `query` |
| `POST` | `/compliance-reports/:id/retry` | 重试失败的报表（从失败阶段续跑） | `query` |

#### 报表列表筛选参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `status` | 按报表状态筛选 | `pending`、`processing`、`completed`、`failed` |
| `requestedBy` | 按创建人筛选 | `admin` |
| `periodFrom` | 报表覆盖周期起始（ISO 8601），按已生成报表的 `params.startAt`/`params.endAt` 判断是否与筛选区间重叠 | `2026-06-01T00:00:00.000Z` |
| `periodTo` | 报表覆盖周期截止（ISO 8601），按已生成报表的 `params.startAt`/`params.endAt` 判断是否与筛选区间重叠 | `2026-06-30T23:59:59.999Z` |
| `hasHighRisk` | 是否包含高风险（`true`/`false`），仅对已完成报表有效；未完成报表不会被误判为无风险 | `true` |
| `hasDiscrepancy` | 是否包含盘点差异（`true`/`false`），仅对已完成报表有效；未完成报表不会被误判为无差异 | `false` |
| `page` | 页码 | `1` |
| `pageSize` | 每页条数，最大 100 | `20` |

返回结果默认按 `createdAt` 倒序排列。所有筛选参数均可独立使用或任意组合。

> **注意**：`hasHighRisk` 和 `hasDiscrepancy` 筛选仅针对 `status=completed` 的报表。未完成（pending/processing/failed）的报表不包含完整的汇总数据，因此在使用这两个筛选条件时会被自动排除，不会误判为无风险或无差异。

示例：

```
GET /compliance-reports?status=completed&hasHighRisk=true&periodFrom=2026-06-01T00:00:00.000Z&periodTo=2026-06-30T23:59:59.999Z
```

### 创建报表

```json
POST /compliance-reports
{
  "startAt": "2026-01-01T00:00:00.000Z",
  "endAt": "2026-12-31T23:59:59.999Z"
}
```

`startAt` 和 `endAt` 至少需提供一个。

创建后立即返回报表任务对象（状态为 `pending`），后台异步分阶段执行。

### 报表详情响应格式

```json
{
  "id": "CR-xxx",
  "status": "processing",
  "params": { "startAt": "...", "endAt": "..." },
  "requestedBy": "admin",
  "progress": { "step": 4, "total": 7, "message": "处理中: 库存盘点" },
  "currentPhase": "inventory",
  "phaseProgress": { "current": 4, "total": 7 },
  "phases": {
    "customers": { "status": "completed", "startedAt": "...", "completedAt": "...", "itemCount": 150, "checksum": "abc123..." },
    "orders": { "status": "completed", "startedAt": "...", "completedAt": "...", "itemCount": 320, "checksum": "def456..." },
    "inspections": { "status": "completed", "startedAt": "...", "completedAt": "...", "itemCount": 80, "checksum": "ghi789..." },
    "inventory": { "status": "processing", "startedAt": "...", "completedAt": null, "itemCount": 0, "checksum": "..." },
    "operationLogs": { "status": "pending", ... },
    "cylinders": { "status": "pending", ... },
    "finalize": { "status": "pending", ... }
  },
  "result": null,
  "error": null,
  "failedPhase": null,
  "createdAt": "...",
  "startedAt": "...",
  "completedAt": null,
  "retryCount": 0,
  "lastRetriedAt": null
}
```

### 重试机制

失败的报表可通过 `/compliance-reports/:id/retry` 接口重试：

- **幂等保证**：已完成的阶段（checksum 匹配）直接跳过，不会重复生成数据
- **断点续跑**：从失败的阶段重新执行，已完成阶段保留
- **重试上限**：最多重试 3 次（含首次执行共 4 次尝试）
- **数据清理**：重试时自动删除失败阶段的不完整数据文件

### 服务启动恢复

服务启动时自动扫描合规报表任务：

1. **超时处理**：`processing` 状态且执行超过 30 分钟的任务标记为 `failed`
2. **恢复执行**：`processing` 状态且未超时的任务重置为 `pending` 后重新调度
3. **待处理调度**：所有 `pending` 状态的任务自动开始执行
4. **阶段续跑**：恢复执行时自动跳过已完成的阶段（基于 checksum）

### 幂等与操作日志联动

- **创建报表**：支持 `Idempotency-Key` 请求头，重复请求直接返回已有任务
- **重试报表**：同样支持幂等，同一幂等键的重试请求只执行一次
- **操作日志**：创建和重试操作自动生成 `compliance.report.create` 和 `compliance.report.retry` 类型的操作日志
- **日志关联**：操作日志与幂等记录互相关联，可通过 `idempotencyKey` 或 `operationLogId` 交叉查询

### 报表内容

已完成的报表包含以下数据：

- **period**：报表覆盖的时间周期
- **summary**：汇总统计（钢瓶数、客户数、订单数、高风险数、差异数等）
- **customers**：周期内新增的客户列表
- **cylinders**：钢瓶追溯详情（状态变化、关联订单、检验风险、盘点差异等）
- **rentalOrders**：周期内的租瓶订单列表
- **inspections**：周期内的检验任务列表
- **inventoryChecks**：周期内的库存盘点列表
- **operationLogs**：周期内的操作日志列表
- **risks**：全部检验风险列表
- **discrepancies**：全部盘点差异列表
- **operatorSummary**：操作人汇总统计

### 数据文件结构

报表数据采用"元数据 + 阶段数据文件"的分离存储结构：

```
data/v3/
  complianceReports.json          # 报表元数据列表（状态、阶段进度等）
  compliance-reports/
    CR-xxx/                       # 单个报表的阶段数据目录
      customers.json              # 客户数据阶段结果
      orders.json                 # 订单数据阶段结果
      inspections.json            # 检验数据阶段结果（含 risks）
      inventory.json              # 盘点数据阶段结果（含 discrepancies）
      operationLogs.json          # 操作日志阶段结果（含 operatorSummary）
      cylinders.json              # 钢瓶追溯阶段结果
      summary.json                # 最终汇总结果
```

### 性能与可扩展性设计

- **分阶段执行**：大任务拆分为小阶段，每阶段让出事件循环，避免阻塞
- **分批处理**：钢瓶追溯阶段按批次处理（默认 100 个/批），每批更新进度并让出事件循环
- **增量式持久化**：每阶段完成后立即落盘，内存占用与单阶段数据量正相关
- **分页加载**：操作日志阶段按页增量加载（默认 500 条/页），避免大数组一次性入内存
- **断点续跑**：服务重启或任务失败后从最近完成阶段继续，不重复劳动
- **幂等校验**：基于 phaseKey + params + dataVersion 的 SHA256 checksum 判定是否可跳过
- **文件级隔离**：每个报表的数据独立目录，便于清理和归档
- **并发安全**：基于文件锁和内存锁的事务机制，确保并发写入的数据一致性

### 测试与回归

项目提供两级测试脚本：

```bash
# 基础功能测试（20个测试用例）
npm run test:compliance-report-phases

# 压力与回归测试（30个测试用例，含并发、性能、数据文件验证）
npm run test:compliance-stress
```

压力测试覆盖范围：
- 基本功能兼容性（创建、列表、详情、重试）
- 分阶段进度跟踪与验证
- 数据文件结构与内容一致性
- 幂等性与 checksum 验证
- 10 并发报表压力测试
- 列表/详情查询性能基准
- 操作日志联动验证
- 分批处理进度验证

## 迁移开发指南

### 添加新的迁移脚本

当需要修改数据 Schema 时，按以下步骤添加新的迁移：

1. 在 `store/migration.js` 的 `MIGRATIONS` 数组中注册新的迁移步骤。

2. 迁移文件格式：

```javascript
export default {
  version: 3,  // 目标版本号
  description: "简短描述本次迁移的内容",

  async up(context) {
    // 升级逻辑
    // context.rootDataDir: 数据根目录
    // context.fromVersion: 源版本号
    // context.toVersion: 目标版本号
    // context.backupPath: 备份目录路径
  },

  async down(context) {
    // 降级逻辑（可选，用于回滚）
  }
};
```

3. 更新 `store/migration.js` 中的 `CURRENT_VERSION` 常量。

4. 编写迁移逻辑时的注意事项：
   - 迁移应该是幂等的
   - 确保迁移失败时可以通过备份恢复
   - 保持向后兼容性，新字段应该有默认值
   - 使用 `context.rootDataDir` 和版本号构造文件路径

### 迁移框架核心模块

| 文件 | 说明 |
|------|------|
| `store/migration.js` | 数据版本管理核心，包含版本检测、备份、回滚、迁移执行 |
| `store/common.js` | 数据读写公共模块，集成版本化数据目录 |
| `scripts/migrate.js` | 命令行迁移管理工具 |
| `data/meta.json` | 版本元数据文件 |
| `data/backups/` | 备份目录 |
