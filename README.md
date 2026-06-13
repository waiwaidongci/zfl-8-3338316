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
│   └── customers.js       # 客户数据 CRUD
├── routes/                # 路由处理层
│   ├── cylinders.js       # 钢瓶流转路由
│   ├── customers.js       # 客户档案路由
│   └── reports.js         # 报警路由
├── data/                  # 持久化存储
│   ├── cylinders.json     # 钢瓶数据
│   └── customers.json     # 客户数据
```

## 钢瓶流转端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /cylinders | 查询钢瓶列表，支持 `?status=` `?gasType=` 筛选 |
| POST | /cylinders | 新建钢瓶，需传 `id`、`gasType` |
| POST | /cylinders/:id/actions | 钢瓶动作，`type` 可选 `inbound`/`outbound`/`return`/`inspect`/`scrap` |
| POST | /cylinders/:id/fills | 记录充装 |
| GET | /reports/alerts | 报警列表，支持 `?inspectionDays=` `?longRentDays=` |

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
