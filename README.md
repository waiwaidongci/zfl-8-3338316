# 特种气体钢瓶流转API

运行：

```bash
npm start
```

默认端口是`3008`，数据保存在`data/cylinders.json`。

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
| `GET` | `/inventory-checks` | 查询盘点单列表（支持`?status=`筛选） | `query` |
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
- **surplus**：非预期但扫到的钢瓶（盘盈）
- **suggestions**：差异处理建议，区分可操作和受保护两类

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

### 权限分配

| 权限 | admin | warehouse | qc | sales |
|------|-------|-----------|-----|-------|
| `inventory:create` | ✅ | ✅ | ✅ | - |
| `inventory:scan` | ✅ | ✅ | ✅ | - |
| `inventory:complete` | ✅ | ✅ | ✅ | - |
| `inventory:confirm` | ✅ | - | ✅ | - |

### 数据文件

盘点数据保存在 `data/inventoryChecks.json`。
