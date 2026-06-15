# v2 数据目录

版本: 2.0
创建时间: 2026-06-15T02:00:58.615Z

## 概述

v2 数据结构引入了版本化数据目录和每个实体独立的Schema版本管理。

## 实体文件

| 文件 | 实体 | Schema版本 |
|------|------|------------|
| cylinders.json | cylinders | 2.0 |
| customers.json | customers | 2.0 |
| rentalOrders.json | orders | 2.0 |
| inspectionTasks.json | tasks | 2.0 |
| operationLogs.json | logs | 2.0 |
| inventoryChecks.json | checks | 2.0 |
| idempotency.json | records | 2.0 |
| users.json | users | 2.0 |
| tokens.json | tokens | 2.0 |

## 数据结构变更

- 每个数据文件增加 `_schemaVersion` 和 `_meta` 字段
- 数据文件集中在版本目录下，便于多版本共存
- 支持增量迁移和回滚

## 注意事项

- 请勿直接修改此目录下的文件，除非你清楚自己在做什么
- 数据迁移时会自动创建备份到 `../backups/` 目录
