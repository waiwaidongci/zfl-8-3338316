# v3 数据目录

版本: 3.0
创建时间: 2026-06-16T01:42:53.268Z

## 概述

v3 数据结构为核心实体引入统一的状态历史追溯字段（statusHistory），实现完整的状态变更可追溯。

## 实体文件

| 文件 | 实体 | Schema版本 | 状态历史 |
|------|------|------------|----------|
| cylinders.json | cylinders | 3.0 | ✓ |
| customers.json | customers | 3.0 | ✗ |
| rentalOrders.json | orders | 3.0 | ✓ |
| inspectionTasks.json | tasks | 3.0 | ✓ |
| operationLogs.json | logs | 3.0 | ✗ |
| inventoryChecks.json | checks | 3.0 | ✓ |
| complianceReports.json | reports | 3.0 | ✗ |
| idempotency.json | records | 3.0 | ✗ |
| users.json | users | 3.0 | ✗ |
| tokens.json | tokens | 3.0 | ✗ |

## statusHistory 结构

每个 statusHistory 条目包含：

```json
{
  "id": "sh-xxx",
  "fromStatus": "old_status",
  "toStatus": "new_status",
  "at": "ISO8601 timestamp",
  "note": "变更说明",
  "operator": "操作人",
  "eventId": "关联事件ID",
  "extra": {}
}
```

## 数据结构变更

- 钢瓶(cylinders)：新增 statusHistory，从 events 回填历史状态
- 订单(rentalOrders)：新增 statusHistory，从 returnHistory 和创建时间回填
- 检验任务(inspectionTasks)：新增 statusHistory，从时间轴字段和 postponements 回填
- 盘点单(inventoryChecks)：新增 statusHistory，从状态时间字段回填
- 所有实体 _schemaVersion 更新为 3.0

## 注意事项

- 旧字段别名（如 status_history → statusHistory）在读取时自动兼容
- API 响应保持向后兼容，新增字段默认返回
- 数据迁移时会自动创建备份到 `../backups/` 目录
