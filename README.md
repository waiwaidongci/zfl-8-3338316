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

盘点数据保存在当前版本数据目录下的 `inventoryChecks.json`。

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
