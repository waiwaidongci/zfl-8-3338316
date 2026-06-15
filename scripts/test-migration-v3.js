#!/usr/bin/env node

import {
  runMigrations,
  getMigrationStatus,
  CURRENT_VERSION,
  readEntityCollection,
  restoreFromBackup,
  detectCurrentVersion,
  ENTITY_FILES
} from "../store/migration.js";
import { clearDataDirCache } from "../store/common.js";
import {
  normalizeStatusHistory,
  validateItem,
  V3_SCHEMAS,
  getSchema,
  transformV2ToV3Item,
  transformV3ToV2Item,
  addStatusHistory
} from "../store/compatibility.js";
import { mkdir, writeFile, rm, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const dataDir = join(projectRoot, "data");
const testDataDir = join(projectRoot, "test-data-v3");
const testBackup = join(dataDir, "backups", "test-backup-v3");

let passed = 0;
let failed = 0;
let lastBackupName = null;

function logTest(name, success, detail = "") {
  if (success) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
    if (detail) console.log(`    ${detail}`);
  }
}

function assert(condition, testName, detail = "") {
  logTest(testName, !!condition, detail);
  return !!condition;
}

async function setupTestData() {
  console.log("\n[1/6] 准备测试数据...");

  if (existsSync(testDataDir)) {
    await rm(testDataDir, { recursive: true, force: true });
  }
  await mkdir(testDataDir, { recursive: true });
  const testV2Dir = join(testDataDir, "v2");
  await mkdir(testV2Dir, { recursive: true });

  const now = new Date().toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();

  const testCylinders = {
    cylinders: [
      {
        id: "TEST-CY-001",
        gasType: "高纯氩",
        capacity: "40L",
        inspectionDue: "2026-12-31",
        location: "一号仓",
        status: "in_stock",
        customer: null,
        depositStatus: "none",
        fills: [{ id: "fill-t1", filledAt: "2026-06-01", pressure: "13.5MPa", operator: "陈起" }],
        events: [
          { id: "evt-t1", type: "create", at: monthAgo, note: "新建钢瓶" },
          { id: "evt-t2", type: "outbound", at: weekAgo, note: "客户租借" },
          { id: "evt-t3", type: "return", at: now, note: "客户归还" }
        ]
      },
      {
        id: "TEST-CY-002",
        gasType: "混合标准气",
        capacity: "8L",
        inspectionDue: "2026-08-15",
        location: "宁川检测",
        status: "rented",
        customer: "宁川检测",
        depositStatus: "paid",
        fills: [],
        events: [
          { id: "evt-t4", type: "inbound", at: monthAgo, note: "初始入库" },
          { id: "evt-t5", type: "outbound", at: weekAgo, note: "客户租借" }
        ]
      }
    ],
    _schemaVersion: "2.0",
    _meta: {
      createdAt: monthAgo,
      migratedAt: monthAgo,
      migratedFrom: "v1",
      entity: "cylinders",
      sourceFile: "cylinders.json",
      storageType: "object"
    }
  };

  const testOrders = {
    orders: [
      {
        id: "TEST-RO-001",
        customerId: "CUST-001",
        customerName: "宁川检测",
        cylinderCount: 1,
        cylinders: [
          {
            id: "TEST-CY-002",
            gasType: "混合标准气",
            capacity: "8L",
            depositStatus: "paid",
            returned: false,
            returnedAt: null,
            returnNote: ""
          }
        ],
        note: "测试订单",
        status: "completed",
        returnedCount: 0,
        returnHistory: [],
        createdAt: weekAgo
      }
    ],
    _schemaVersion: "2.0",
    _meta: {
      createdAt: weekAgo,
      migratedAt: weekAgo,
      migratedFrom: "v1",
      entity: "rentalOrders",
      sourceFile: "rentalOrders.json",
      storageType: "object"
    }
  };

  const testTasks = {
    tasks: [
      {
        id: "TEST-IT-001",
        cylinderId: "TEST-CY-001",
        gasType: "高纯氩",
        capacity: "40L",
        inspectionDue: "2026-12-31",
        status: "pending",
        result: null,
        createdAt: weekAgo,
        sentAt: null,
        inspectedAt: null,
        restockedAt: null
      }
    ],
    _schemaVersion: "2.0",
    _meta: {
      createdAt: weekAgo,
      migratedAt: weekAgo,
      migratedFrom: "v1",
      entity: "inspectionTasks",
      sourceFile: "inspectionTasks.json",
      storageType: "object"
    }
  };

  const testChecks = {
    checks: [
      {
        id: "TEST-IC-001",
        title: "测试盘点单",
        scope: { location: "一号仓", gasType: null, status: null },
        expectedCount: 1,
        expectedCylinderIds: ["TEST-CY-001"],
        expectedCylinderDetails: [
          {
            id: "TEST-CY-001",
            gasType: "高纯氩",
            capacity: "40L",
            status: "in_stock",
            location: "一号仓",
            customer: null
          }
        ],
        scannedEntries: [
          {
            cylinderId: "TEST-CY-001",
            scannedAt: now,
            operator: "测试员",
            scanIndex: 1,
            duplicate: false
          }
        ],
        scanIndexCounter: 1,
        differences: null,
        suggestions: null,
        status: "scanning",
        createdAt: weekAgo,
        scanningStartedAt: now,
        completedAt: null,
        confirmedAt: null,
        confirmedBy: null,
        createdBy: "测试员",
        note: null
      }
    ],
    _schemaVersion: "2.0",
    _meta: {
      createdAt: weekAgo,
      migratedAt: weekAgo,
      migratedFrom: "v1",
      entity: "inventoryChecks",
      sourceFile: "inventoryChecks.json",
      storageType: "object"
    }
  };

  await writeFile(join(testV2Dir, "cylinders.json"), JSON.stringify(testCylinders, null, 2));
  await writeFile(join(testV2Dir, "rentalOrders.json"), JSON.stringify(testOrders, null, 2));
  await writeFile(join(testV2Dir, "inspectionTasks.json"), JSON.stringify(testTasks, null, 2));
  await writeFile(join(testV2Dir, "inventoryChecks.json"), JSON.stringify(testChecks, null, 2));
  await writeFile(join(testV2Dir, "customers.json"), JSON.stringify({ customers: [], _schemaVersion: "2.0", _meta: {} }, null, 2));
  await writeFile(join(testV2Dir, "operationLogs.json"), JSON.stringify({ logs: [], _schemaVersion: "2.0", _meta: {} }, null, 2));
  await writeFile(join(testV2Dir, "complianceReports.json"), JSON.stringify({ reports: [], _schemaVersion: "2.0", _meta: {} }, null, 2));
  await writeFile(join(testV2Dir, "idempotency.json"), JSON.stringify({ records: [], _schemaVersion: "2.0", _meta: {} }, null, 2));
  await writeFile(join(testV2Dir, "users.json"), JSON.stringify({ users: [], _schemaVersion: "2.0", _meta: {} }, null, 2));
  await writeFile(join(testV2Dir, "tokens.json"), JSON.stringify({ tokens: [], _schemaVersion: "2.0", _meta: {} }, null, 2));

  await writeFile(
    join(dataDir, "meta.json"),
    JSON.stringify({
      currentVersion: 2,
      migrations: [
        {
          version: 2,
          description: "版本化目录结构 - 实体独立存储与Schema版本管理",
          executedAt: monthAgo,
          backupName: "v1-to-v2-test"
        }
      ],
      createdAt: monthAgo,
      lastMigration: monthAgo
    },
    null,
    2
  )
  );

  logTest("测试数据准备完成", true);
}

async function testMigrationToV3() {
  console.log("\n[2/6] 测试 v2 → v3 迁移...");

  const statusBefore = await getMigrationStatus();
  assert(statusBefore.currentVersion === 2, "迁移前版本应为 v2", `实际: v${statusBefore.currentVersion}`);
  assert(statusBefore.needsMigration === true, "应检测到需要迁移");

  const result = await runMigrations(3);
  assert(result.success === true, "迁移执行应成功", result.error || "");
  assert(result.fromVersion === 2, "源版本应为 2", `实际: ${result.fromVersion}`);
  assert(result.toVersion === 3, "目标版本应为 3", `实际: ${result.toVersion}`);
  assert(!!result.backupDir, "应生成备份目录");
  assert(result.migratedFiles && result.migratedFiles.length > 0, "应迁移至少一个文件", `迁移文件数: ${result.migratedFiles?.length}`);
  lastBackupName = result.backupName;

  const statusAfter = await getMigrationStatus();
  assert(statusAfter.currentVersion === 3, "迁移后版本应为 v3", `实际: v${statusAfter.currentVersion}`);
  assert(statusAfter.needsMigration === false, "迁移后不应再需要迁移");
}

async function testV3DataStructure() {
  console.log("\n[3/6] 测试 v3 数据结构...");

  clearDataDirCache();

  const cylinders = await readEntityCollection("cylinders");
  assert(Array.isArray(cylinders), "钢瓶数据应为数组", `实际类型: ${typeof cylinders}`);
  assert(cylinders.length >= 2, "应有至少 2 个钢瓶", `实际: ${cylinders.length}`);

  for (const cyl of cylinders) {
    assert(Array.isArray(cyl.statusHistory), `钢瓶 ${cyl.id} 应有 statusHistory 数组`, `实际: ${typeof cyl.statusHistory}`);
    if (cyl.statusHistory && cyl.statusHistory.length > 0) {
      const firstEntry = cyl.statusHistory[0];
      assert(!!firstEntry.id, `钢瓶 ${cyl.id} statusHistory 条目应有 id`);
      assert(!!firstEntry.toStatus, `钢瓶 ${cyl.id} statusHistory 条目应有 toStatus`);
      assert(!!firstEntry.at, `钢瓶 ${cyl.id} statusHistory 条目应有 at 时间戳`);
      assert("fromStatus" in firstEntry, `钢瓶 ${cyl.id} statusHistory 条目应有 fromStatus`);
    }

    const validation = validateItem(cyl, "cylinders", 3);
    assert(validation.valid, `钢瓶 ${cyl.id} 应通过 v3 schema 验证`, validation.errors.join("; "));
  }

  const testCyl = cylinders.find(c => c.id === "TEST-CY-001");
  if (testCyl) {
    assert(testCyl.statusHistory.length >= 3, `TEST-CY-001 应有至少 3 条状态历史 (create→outbound→return)`, `实际: ${testCyl.statusHistory.length}条`);
    const normalized = normalizeStatusHistory(testCyl.statusHistory);
    assert(normalized.length === testCyl.statusHistory.length, "normalizeStatusHistory 不应丢失条目");
    const sortedAsc = normalized.every((e, i, arr) => i === 0 || new Date(e.at) >= new Date(arr[i - 1].at));
    assert(sortedAsc, "statusHistory 应按时间升序排列");
  }

  const orders = await readEntityCollection("rentalOrders");
  for (const order of orders) {
    assert(Array.isArray(order.statusHistory), `订单 ${order.id} 应有 statusHistory`);
  }

  const tasks = await readEntityCollection("inspectionTasks");
  for (const task of tasks) {
    assert(Array.isArray(task.statusHistory), `任务 ${task.id} 应有 statusHistory`);
    assert(Array.isArray(task.postponements), `任务 ${task.id} 应有 postponements 数组`);
  }

  const checks = await readEntityCollection("inventoryChecks");
  for (const check of checks) {
    assert(Array.isArray(check.statusHistory), `盘点单 ${check.id} 应有 statusHistory`);
  }

  const testCheck = checks.find(c => c.id === "TEST-IC-001");
  if (testCheck) {
    assert(testCheck.statusHistory.length >= 2, `TEST-IC-001 应有至少 2 条状态历史 (draft→scanning)`, `实际: ${testCheck.statusHistory.length}条`);
  }
}

async function testStatusHistoryOperations() {
  console.log("\n[4/6] 测试 statusHistory 操作函数...");

  const testItem = {
    id: "TEST-OP-001",
    status: "draft",
    statusHistory: [
      { id: "sh-1", fromStatus: null, toStatus: "draft", at: "2026-06-01T00:00:00.000Z", note: "创建" }
    ]
  };

  const entry = addStatusHistory(testItem, {
    fromStatus: "draft",
    toStatus: "active",
    note: "激活",
    operator: "测试员",
    extra: { reason: "test" }
  });

  assert(!!entry, "addStatusHistory 应返回新增条目");
  assert(entry.toStatus === "active", "新增条目 toStatus 应正确");
  assert(entry.fromStatus === "draft", "新增条目 fromStatus 应正确");
  assert(entry.operator === "测试员", "新增条目 operator 应正确");
  assert(!!entry.at, "新增条目应有时间戳");
  assert(!!entry.id, "新增条目应有 id");
  assert(testItem.statusHistory.length === 2, "应追加 1 条历史记录");

  const schema = getSchema("cylinders", 3);
  assert(!!schema, "getSchema('cylinders', 3) 应返回 schema");
  assert(schema.schemaVersion === "3.0", "schema 版本应为 3.0");
  assert(schema.hasStatusHistory === true, "cylinders schema 应标记 hasStatusHistory");

  const schemaCust = getSchema("customers", 3);
  assert(!!schemaCust, "getSchema('customers', 3) 应返回 schema");
  assert(schemaCust.hasStatusHistory === undefined, "customers schema 不应有 hasStatusHistory");

  const v2Item = {
    id: "CY-V2",
    gasType: "氧气",
    capacity: "40L",
    inspectionDue: "2026-12-31",
    location: "仓库",
    status: "in_stock",
    customer: null,
    depositStatus: "none",
    fills: [],
    events: [{ id: "e1", type: "create", at: "2026-06-01T00:00:00.000Z", note: "创建" }]
  };
  const transformed = transformV2ToV3Item(v2Item, "cylinders");
  assert(Array.isArray(transformed.statusHistory), "v2→v3 转换后应有 statusHistory");
  assert(transformed.statusHistory.length >= 1, "v2→v3 转换后应有至少 1 条历史");

  const backToV2 = transformV3ToV2Item(transformed, "cylinders");
  assert(!("statusHistory" in backToV2) || backToV2.statusHistory === undefined, "v3→v2 转换后 statusHistory 应被移除");
}

async function testFieldAliases() {
  console.log("\n[5/6] 测试字段别名兼容性...");

  const { normalizeItemForAPI } = await import("../store/compatibility.js");

  const itemWithOldFields = {
    id: "CY-ALIAS",
    gas_type: "高纯氮",
    capacity: "40L",
    inspection_due: "2026-12-31",
    location: "仓库",
    status: "in_stock",
    deposit_status: "none",
    status_history: [
      { id: "sh-alias", fromStatus: null, toStatus: "in_stock", at: "2026-06-01T00:00:00.000Z" }
    ]
  };

  const normalized = normalizeItemForAPI(itemWithOldFields, "cylinders", 3);
  assert(normalized.gasType === "高纯氮", "gas_type 别名应映射为 gasType", `实际: ${normalized.gasType}`);
  assert(normalized.inspectionDue === "2026-12-31", "inspection_due 别名应映射为 inspectionDue");
  assert(normalized.depositStatus === "none", "deposit_status 别名应映射为 depositStatus");
  assert(Array.isArray(normalized.statusHistory), "status_history 别名应映射为 statusHistory");
  assert(normalized.statusHistory.length === 1, "statusHistory 内容应保留");
  assert(normalized.statusHistory[0].id === "sh-alias", "statusHistory 条目内容应正确");
}

async function testRollback() {
  console.log("\n[6/6] 测试 v3 → v2 回滚...");

  if (!lastBackupName) {
    logTest("跳过回滚测试（无备份）", false, "未找到迁移备份名称");
    return;
  }

  const result = await runMigrations(2);
  assert(result.success === true, "回滚执行应成功", result.error || "");
  assert(result.fromVersion === 3, "回滚源版本应为 3", `实际: ${result.fromVersion}`);
  assert(result.toVersion === 2, "回滚目标版本应为 2", `实际: ${result.toVersion}`);

  const statusAfter = await getMigrationStatus();
  assert(statusAfter.currentVersion === 2, "回滚后版本应为 v2", `实际: v${statusAfter.currentVersion}`);

  clearDataDirCache();
  const cylinders = await readEntityCollection("cylinders");
  for (const cyl of cylinders) {
    assert(!cyl.statusHistory || cyl.statusHistory === undefined || Array.isArray(cyl.statusHistory),
      "回滚后钢瓶数据应仍可读取（statusHistory 被移除或兼容）");
  }

  console.log("\n恢复到 v3 以便后续使用...");
  const restoreResult = await runMigrations(3);
  if (restoreResult.success) {
    logTest("重新升级到 v3 成功", true);
  } else {
    logTest("重新升级到 v3 失败", false, restoreResult.error);
  }
}

function printSummary() {
  console.log("\n========================================");
  console.log("  V3 数据迁移回归测试报告");
  console.log("========================================");
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log(`  总计: ${passed + failed}`);
  const rate = passed + failed > 0 ? ((passed / (passed + failed)) * 100).toFixed(1) : "0";
  console.log(`  通过率: ${rate}%`);
  console.log("========================================");

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function cleanupTestArtifacts() {
  if (existsSync(testDataDir)) {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  console.log("========================================");
  console.log("  V3 数据迁移回归验证");
  console.log("========================================");
  console.log(`  CURRENT_VERSION: v${CURRENT_VERSION}`);

  try {
    await setupTestData();
    await testMigrationToV3();
    await testV3DataStructure();
    await testStatusHistoryOperations();
    await testFieldAliases();
    await testRollback();
  } catch (err) {
    console.error("\n[测试异常]", err.message);
    console.error(err.stack);
    failed++;
  } finally {
    await cleanupTestArtifacts();
    printSummary();
  }
}

main();
