# 数据迁移与版本化管理

## 概述

本项目实现了完整的数据迁移和版本化管理机制，支持从单一 `data/cylinders.json` 结构升级为可演进的多版本数据目录结构。

## 版本历史

| 版本 | 描述 | 发布日期 |
|------|------|----------|
| v1 | 单一平面数据结构，所有JSON文件直接存放在 data/ 目录 | 初始版本 |
| v2 | 版本化目录结构，每个实体独立存储，支持Schema版本管理 | 2026-06-15 |

## 目录结构

### v1 结构
```
data/
├── cylinders.json
├── customers.json
├── rentalOrders.json
├── inspectionTasks.json
├── operationLogs.json
├── inventoryChecks.json
└── idempotency.json
```

### v2 结构
```
data/
├── meta.json              # 迁移元数据和版本信息
├── backups/               # 迁移备份目录
│   └── v1-to-v2-20260615-005459/
│       ├── backup-meta.json
│       └── *.json         # 备份的原始文件
└── v2/                    # v2 数据目录
    ├── README.md
    ├── cylinders.json     # 含 _schemaVersion 和 _meta 字段
    ├── customers.json
    ├── rentalOrders.json
    ├── inspectionTasks.json
    ├── operationLogs.json
    ├── inventoryChecks.json
    ├── idempotency.json
    ├── users.json
    └── tokens.json
```

## v2 Schema 变更

每个 v2 数据文件包含以下元字段：

```json
{
  "collection_name": [...],
  "_schemaVersion": "2.0",
  "_meta": {
    "createdAt": "2026-06-15T...",
    "migratedAt": "2026-06-15T...",
    "migratedFrom": "v1",
    "entity": "cylinders",
    "sourceFile": "cylinders.json"
  }
}
```

## 实体 Schema 定义

### 钢瓶 (cylinders)
**必填字段**: `id`, `gasType`, `capacity`, `inspectionDue`, `location`, `status`
**默认字段**: `customer: null`, `depositStatus: "none"`, `fills: []`, `events: []`
**字段别名**: `gas_type` → `gasType`, `inspection_due` → `inspectionDue`, `deposit_status` → `depositStatus`

### 客户 (customers)
**必填字段**: `id`, `name`
**默认字段**: `contact: null`, `phone: null`, `address: null`, `createdAt: null`
**字段别名**: `customer_name` → `name`, `contact_person` → `contact`, `phone_number` → `phone`

### 订单 (rentalOrders)
**必填字段**: `id`, `customerId`, `customerName`, `cylinders`
**默认字段**: `cylinderCount: 0`, `note: ""`, `status: "completed"`, `createdAt: null`
**字段别名**: `customer_id` → `customerId`, `customer_name` → `customerName`, `cylinder_count` → `cylinderCount`

### 检验任务 (inspectionTasks)
**必填字段**: `id`, `cylinderId`, `status`
**默认字段**: `gasType: null`, `capacity: null`, `inspectionDue: null`, `result: null`
**字段别名**: `cylinder_id` → `cylinderId`, `gas_type` → `gasType`, `inspection_due` → `inspectionDue`

### 操作流水 (operationLogs)
**必填字段**: `id`, `operationType`, `targetType`
**默认字段**: `targetId: null`, `operator: null`, `beforeState: null`, `afterState: null`
**字段别名**: `operation_type` → `operationType`, `target_type` → `targetType`, `target_id` → `targetId`

### 库存盘点 (inventoryChecks)
**必填字段**: `id`, `status`
**默认字段**: `operator: null`, `scannedItems: []`, `discrepancies: []`
**字段别名**: `scanned_items` → `scannedItems`, `started_at` → `startedAt`

### 幂等记录 (idempotency)
**必填字段**: `key`, `status`
**默认字段**: `requestHash: null`, `response: null`, `createdAt: null`
**字段别名**: `request_hash` → `requestHash`, `created_at` → `createdAt`

### 用户 (users)
**必填字段**: `id`, `username`
**默认字段**: `role: "user"`, `name: null`, `createdAt: null`

### 令牌 (tokens)
**必填字段**: `token`, `userId`
**默认字段**: `createdAt: null`, `expiresAt: null`, `lastUsed: null`
**字段别名**: `user_id` → `userId`, `created_at` → `createdAt`

## 迁移流程

### 自动迁移（服务启动时）

1. 服务启动时自动检测当前数据版本
2. 如需要迁移，自动执行以下步骤：
   - 验证 v1 数据完整性（JSON格式校验）
   - 创建完整备份到 `data/backups/` 目录
   - 执行数据转换到 v2 schema
   - 验证迁移结果
   - 更新 `meta.json` 版本信息
3. 迁移成功：清除缓存，继续启动服务
4. 迁移失败：
   - 自动尝试回滚
   - 记录错误信息
   - 默认阻止服务启动（可通过环境变量 `ALLOW_START_WITH_MIGRATION_ERROR=true` 强制启动）

### 手动迁移

使用迁移脚本管理数据版本：

```bash
# 查看迁移状态
npm run migrate:status

# 升级到最新版本
npm run migrate:up

# 升级到指定版本
node scripts/migrate.js up 2

# 回滚到 v1
npm run migrate:down

# 从指定备份恢复
npm run migrate:restore -- v1-to-v2-20260615-005459

# 列出可用备份
npm run migrate:list-backups

# 强制升级（忽略验证错误）
npm run migrate:force
```

## 迁移脚本 API

### 命令列表

| 命令 | 描述 | 参数 |
|------|------|------|
| `status` | 显示当前迁移状态 | - |
| `up [version]` | 升级到指定版本 | `version`: 目标版本号（可选，默认最新） |
| `down [version]` | 回滚到指定版本 | `version`: 目标版本号（可选，默认1） |
| `restore <backup>` | 从指定备份恢复 | `backup`: 备份目录名称（必填） |
| `list-backups` | 列出可用备份 | - |
| `force-up` | 强制升级，忽略验证错误 | - |
| `help` | 显示帮助信息 | - |

### 选项

| 选项 | 描述 |
|------|------|
| `--reason <text>` | 回滚/恢复原因说明，记录到 meta.json |
| `--force` | 强制执行操作 |

## 错误处理与恢复

### 迁移失败场景

1. **数据验证失败**：备份创建前失败，无影响
2. **备份创建失败**：迁移终止，原始数据完好
3. **数据转换失败**：自动回滚，从备份恢复
4. **验证失败**：自动回滚（除非使用 `--force`）
5. **回滚失败**：输出手动恢复指南

### 手动恢复步骤

如自动回滚失败，可按以下步骤手动恢复：

1. 确认备份存在：`ls data/backups/`
2. 执行恢复命令：`node scripts/migrate.js restore <backup-name>`
3. 验证数据：`node scripts/migrate.js status`
4. 重启服务：`npm start`

### 元数据文件 (meta.json)

```json
{
  "currentVersion": 2,
  "migrations": [
    {
      "version": 2,
      "description": "版本化目录结构 - 实体独立存储与Schema版本管理",
      "executedAt": "2026-06-15T...",
      "backupName": "v1-to-v2-20260615-005459"
    }
  ],
  "createdAt": "2026-06-15T...",
  "lastMigration": "2026-06-15T...",
  "lastRestore": "2026-06-15T...",
  "restoredFrom": "v1-to-v2-20260615-005459",
  "lastRestoreReason": "manual_rollback"
}
```

## 向后兼容性

### 字段兼容性

- 读取时自动应用字段别名映射（`gas_type` → `gasType`）
- 缺失字段自动填充默认值
- 内部元字段（`_schemaVersion`, `_meta`）自动剥离，不返回给API调用者

### API 兼容性

所有现有接口保持完全兼容：
- 响应格式不变
- 字段名称不变
- 错误码不变

### 数据目录自动切换

- v1 数据：从 `data/` 目录读取
- v2 数据：从 `data/v2/` 目录读取
- 版本检测自动完成，无需手动配置

## 核心模块

### store/migration.js
数据迁移核心模块，负责：
- 版本检测
- 数据备份
- 迁移执行
- 回滚机制
- 元数据管理

### store/compatibility.js
向后兼容层，负责：
- v2 Schema 定义
- 字段别名映射
- 默认值填充
- 数据验证

### store/common.js
数据访问层，已集成：
- 动态数据目录解析
- 版本元数据自动添加
- 兼容性归一化处理

### scripts/migrate.js
命令行迁移工具，支持：
- 手动迁移/回滚
- 备份管理
- 状态查询

## 新增未来迁移

添加新的迁移版本步骤：

1. 在 `store/migration.js` 的 `MIGRATIONS` 数组中添加新迁移：
   ```javascript
   {
     version: 3,
     description: "新功能描述",
     up: migrateV2ToV3,
     down: rollbackV3ToV2
   }
   ```

2. 实现 `migrateV2ToV3` 和 `rollbackV3ToV2` 函数

3. 在 `store/compatibility.js` 中更新或添加新的 Schema 定义

4. 更新 `CURRENT_VERSION` 常量

5. 更新本文档

## 注意事项

1. **备份完整性**：迁移前确保磁盘空间充足
2. **服务停机**：建议在服务维护窗口执行迁移
3. **数据验证**：迁移后务必验证数据完整性
4. **不可删除**：`data/backups/` 目录下的备份请勿随意删除
5. **权限**：确保服务进程对 `data/` 目录有读写权限
6. **并发安全**：迁移过程中请勿启动多个服务实例

## 环境变量

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `ALLOW_START_WITH_MIGRATION_ERROR` | 迁移失败时是否允许启动服务 | `false` |
| `PORT` | 服务监听端口 | `3008` |

## 故障排查

### Q: 服务启动时报 "数据迁移失败，服务无法启动"
A: 检查日志中的具体错误，使用 `node scripts/migrate.js restore <backup>` 恢复，或设置 `ALLOW_START_WITH_MIGRATION_ERROR=true` 强制启动。

### Q: 迁移后部分数据丢失
A: 从备份恢复：`node scripts/migrate.js restore <backup-name>`，然后联系开发人员排查转换逻辑。

### Q: 如何确认迁移是否成功？
A: 运行 `npm run migrate:status` 查看当前版本和迁移历史。

### Q: 可以在多个实例间共享数据目录吗？
A: 不建议。迁移操作非分布式安全，如需共享请使用外部数据库。

### Q: v1 数据文件会被删除吗？
A: 不会。v1 文件会保留，迁移时自动备份，回滚时从备份恢复。
