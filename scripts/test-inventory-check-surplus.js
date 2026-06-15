import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const { withMultiJsonTx } = await import(join(projectRoot, "store/common.js"));
const { SEED: CYLINDERS_SEED } = await import(join(projectRoot, "store/cylinders.js"));
const { SEED: CHECKS_SEED } = await import(join(projectRoot, "store/inventoryChecks.js"));
const { SEED: LOGS_SEED } = await import(join(projectRoot, "store/operationLog.js"));
const { SEED: IDEM_SEED } = await import(join(projectRoot, "store/idempotency.js"));

const BASE = `http://localhost:${process.env.PORT || 3008}`;
const DATA_DIR = join(projectRoot, "data", "v2");
const DATA_FILES_TO_RESTORE = [
  "cylinders.json",
  "inventoryChecks.json",
  "operationLogs.json",
  "idempotency.json",
  "tokens.json"
];

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
    if (options.idemKey) headers["Idempotency-Key"] = options.idemKey;
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let body;
        try { body = data ? JSON.parse(data) : {}; } catch { body = { raw: data }; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

async function snapshotDataFiles() {
  const snapshot = new Map();
  for (const filename of DATA_FILES_TO_RESTORE) {
    for (const suffix of ["", ".bak"]) {
      const filePath = join(DATA_DIR, `${filename}${suffix}`);
      snapshot.set(filePath, existsSync(filePath) ? await readFile(filePath) : null);
    }
  }
  return snapshot;
}

async function restoreDataFiles(snapshot) {
  await mkdir(DATA_DIR, { recursive: true });
  for (const [filePath, content] of snapshot.entries()) {
    if (content === null) {
      await rm(filePath, { force: true });
    } else {
      await writeFile(filePath, content);
    }
  }
}

async function cleanupTestData(TS, cylinderIds, checkIds) {
  console.log("\n🧹 清理测试数据...");

  const tsStr = String(TS);
  const idemKeyPrefixes = [`cyl-ics-${TS}-`, `check-ics-${TS}`];
  const targetIds = new Set([...cylinderIds, ...checkIds]);

  await withMultiJsonTx(
    [
      { filename: "cylinders.json", fallback: CYLINDERS_SEED },
      { filename: "inventoryChecks.json", fallback: CHECKS_SEED },
      { filename: "operationLogs.json", fallback: LOGS_SEED },
      { filename: "idempotency.json", fallback: IDEM_SEED }
    ],
    async (dbs) => {
      const cylinders = dbs["cylinders.json"].cylinders;
      const removedCyl = [];
      for (let i = cylinders.length - 1; i >= 0; i--) {
        const c = cylinders[i];
        const matchById = cylinderIds.includes(c.id);
        const matchByStr = tsStr && (
          (c.id && c.id.includes(tsStr)) ||
          (c.gasType && c.gasType.includes(tsStr)) ||
          (c.location && c.location.includes(tsStr))
        );
        if (matchById || matchByStr) {
          removedCyl.push(c.id);
          cylinders.splice(i, 1);
        }
      }

      const checks = dbs["inventoryChecks.json"].checks;
      const removedChecks = [];
      for (let i = checks.length - 1; i >= 0; i--) {
        const ch = checks[i];
        const matchById = checkIds.includes(ch.id);
        const matchByStr = tsStr && (
          (ch.id && ch.id.includes(tsStr)) ||
          (ch.title && ch.title.includes(tsStr)) ||
          (ch.createdBy && ch.createdBy.includes(tsStr)) ||
          (ch.scope?.location && ch.scope.location.includes(tsStr)) ||
          (ch.scope?.gasType && ch.scope.gasType.includes(tsStr))
        );
        if (matchById || matchByStr) {
          removedChecks.push(ch.id);
          checks.splice(i, 1);
        }
      }

      const logs = dbs["operationLogs.json"].logs;
      for (let i = logs.length - 1; i >= 0; i--) {
        const log = logs[i];
        const targetMatch = log.targetId && targetIds.has(log.targetId);
        const strMatch = tsStr && JSON.stringify(log).includes(tsStr);
        if (targetMatch || strMatch) {
          logs.splice(i, 1);
        }
      }

      const records = dbs["idempotency.json"].records;
      if (Array.isArray(records)) {
        for (let i = records.length - 1; i >= 0; i--) {
          const rec = records[i];
          const keyMatch = idemKeyPrefixes.some((p) => rec.key && rec.key.startsWith(p));
          const strMatch = tsStr && JSON.stringify(rec).includes(tsStr);
          if (keyMatch || strMatch) {
            records.splice(i, 1);
          }
        }
      } else if (records && typeof records === "object") {
        for (const key of Object.keys(records)) {
          const rec = records[key];
          const keyMatch = idemKeyPrefixes.some((p) => (rec.key && rec.key.startsWith(p)) || key.startsWith(p));
          const strMatch = tsStr && JSON.stringify(rec).includes(tsStr);
          if (keyMatch || strMatch) {
            delete records[key];
          }
        }
      }

      console.log(`  清理钢瓶: ${removedCyl.length} 个`);
      console.log(`  清理盘点单: ${removedChecks.length} 个`);
    }
  );

  console.log("✅ 测试数据已清理\n");
}

async function run() {
  const TS = Date.now();
  const createdCylinders = [];
  const createdChecks = [];
  const dataSnapshot = await snapshotDataFiles();

  try {
    console.log("🚀 库存盘盈处理验证脚本");
    console.log(`   运行标记: ${TS}\n`);

    const login = await request("POST", "/auth/login", {
      body: { username: "admin", password: "admin123" },
    });
    const token = login.body.token;
    console.log("✅ 登录成功\n");

    const LOC_INVENTORY = `盘盈测试仓-${TS}`;
    const LOC_OTHER = `其他仓库-${TS}`;
    const GAS = `盘盈测试气-${TS}`;
    const OPERATOR = `盘盈测试员-${TS}`;

    console.log("=== 准备测试数据 ===");

    const cylInStock = await request("POST", "/cylinders", {
      token,
      idemKey: `cyl-ics-${TS}-in`,
      body: {
        id: `CY-ICS-${TS}-INSTOCK`,
        gasType: GAS,
        capacity: "40L",
        location: LOC_OTHER,
        inspectionDue: "2027-01-01",
      },
    });
    createdCylinders.push(cylInStock.body.id);
    assert(cylInStock.statusCode === 201, "创建在库钢瓶（用于盘盈迁移测试）");

    const cylRented = await request("POST", "/cylinders", {
      token,
      idemKey: `cyl-ics-${TS}-rented`,
      body: {
        id: `CY-ICS-${TS}-RENTED`,
        gasType: GAS,
        capacity: "40L",
        location: LOC_OTHER,
        inspectionDue: "2027-01-01",
      },
    });
    createdCylinders.push(cylRented.body.id);
    assert(cylRented.statusCode === 201, "创建钢瓶（用于租借后受保护测试）");

    const rentAction = await request("POST", `/cylinders/CY-ICS-${TS}-RENTED/actions`, {
      token,
      idemKey: `cyl-ics-${TS}-rent-action`,
      body: {
        type: "outbound",
        customer: "测试客户",
        depositStatus: "paid",
      },
    });
    assert(rentAction.statusCode === 200, "将钢瓶标记为租借状态（受保护）");

    const cylExpected = await request("POST", "/cylinders", {
      token,
      idemKey: `cyl-ics-${TS}-expected`,
      body: {
        id: `CY-ICS-${TS}-EXPECTED`,
        gasType: GAS,
        capacity: "40L",
        location: LOC_INVENTORY,
        inspectionDue: "2027-01-01",
      },
    });
    createdCylinders.push(cylExpected.body.id);
    assert(cylExpected.statusCode === 201, "创建预期内钢瓶（用于盘亏测试）");

    console.log("\n=== 创建盘点单 ===");
    const checkRes = await request("POST", "/inventory-checks", {
      token,
      idemKey: `check-ics-${TS}`,
      body: {
        title: `盘盈测试盘点-${TS}`,
        scope: { location: LOC_INVENTORY, gasType: GAS },
        operator: OPERATOR,
        note: "盘盈处理验证",
      },
    });
    const checkId = checkRes.body.id;
    createdChecks.push(checkId);
    assert(checkRes.statusCode === 201, `创建盘点单 ${checkId}`);
    assert(checkRes.body.expectedCount === 1, "预期钢瓶数量为 1");

    console.log("\n=== 开始扫描 ===");
    const startRes = await request("POST", `/inventory-checks/${checkId}/start`, {
      token,
      idemKey: `check-ics-${TS}-start`,
      body: {},
    });
    assert(startRes.statusCode === 200, "开始扫描成功");

    console.log("\n=== 扫描录入（盘盈场景） ===");
    const scanRes = await request("POST", `/inventory-checks/${checkId}/scan`, {
      token,
      idemKey: `check-ics-${TS}-scan`,
      body: {
        cylinderIds: [
          `CY-ICS-${TS}-INSTOCK`,
          `CY-ICS-${TS}-RENTED`,
          `CY-ICS-${TS}-UNREGISTERED`,
        ],
        operator: OPERATOR,
      },
    });
    assert(scanRes.statusCode === 200, "批量扫描成功");
    assert(scanRes.body.entries.length === 3, "扫描录入 3 个钢瓶");

    console.log("\n=== 完成扫描并计算差异 ===");
    const completeRes = await request("POST", `/inventory-checks/${checkId}/complete`, {
      token,
      idemKey: `check-ics-${TS}-complete`,
      body: {},
    });
    assert(completeRes.statusCode === 200, "完成扫描成功");
    assert(completeRes.body.differences, "差异数据已计算");

    const diffs = completeRes.body.differences;
    assert(diffs.deficitCount === 1, "盘亏数量为 1（预期内未扫到）");
    assert(diffs.surplusCount === 3, "盘盈数量为 3（扫到但不在预期内）");

    const surplusItems = diffs.surplus;
    const inStockSurplus = surplusItems.find((s) => s.cylinderId === `CY-ICS-${TS}-INSTOCK`);
    const rentedSurplus = surplusItems.find((s) => s.cylinderId === `CY-ICS-${TS}-RENTED`);
    const unregSurplus = surplusItems.find((s) => s.cylinderId === `CY-ICS-${TS}-UNREGISTERED`);

    assert(inStockSurplus?.existsInSystem === true, "在库盘盈钢瓶标记为系统已存在");
    assert(inStockSurplus?.protected === false, "在库盘盈钢瓶标记为非受保护");
    assert(rentedSurplus?.existsInSystem === true, "租借盘盈钢瓶标记为系统已存在");
    assert(rentedSurplus?.protected === true, "租借盘盈钢瓶标记为受保护");
    assert(unregSurplus?.existsInSystem === false, "未登记盘盈钢瓶标记为系统不存在");
    assert(unregSurplus?.protected === false, "未登记盘盈钢瓶标记为非受保护（默认 false）");

    console.log("\n=== 验证建议类型 ===");
    const suggestions = completeRes.body.suggestions;
    const migratableSug = suggestions.find((s) => s.type === "surplus_migratable");
    const protectedSug = suggestions.find((s) => s.type === "surplus_protected");
    const unregSug = suggestions.find((s) => s.type === "surplus_unregistered");

    assert(migratableSug !== undefined, "存在可迁移盘盈建议");
    assert(migratableSug?.action === "migrate_location", "可迁移建议动作为 migrate_location");
    assert(protectedSug !== undefined, "存在受保护盘盈建议");
    assert(protectedSug?.action === "manual_verify", "受保护建议动作为 manual_verify");
    assert(unregSug !== undefined, "存在未登记盘盈建议");
    assert(unregSug?.action === "register_suggestion", "未登记建议动作为 register_suggestion");

    console.log("\n=== 1. 确认盘点 - 盘盈迁移测试 ===");
    const confirmRes = await request("POST", `/inventory-checks/${checkId}/confirm`, {
      token,
      idemKey: `check-ics-${TS}-confirm`,
      body: {
        operator: OPERATOR,
        surplusMigrateIds: [
          `CY-ICS-${TS}-INSTOCK`,
          `CY-ICS-${TS}-RENTED`,
          `CY-ICS-${TS}-UNREGISTERED`,
        ],
      },
    });
    assert(confirmRes.statusCode === 200, "确认盘点成功");
    assert(confirmRes.body.check.status === "confirmed", "盘点单状态为 confirmed");

    const { affectedDeficit, affectedSurplusMigrated, surplusRegistrationSuggestions } = confirmRes.body;

    assert(Array.isArray(affectedDeficit), "返回 affectedDeficit 数组");
    assert(affectedDeficit.length === 1, "盘亏影响 1 个钢瓶");
    assert(affectedDeficit[0].newStatus === "pending_check", "盘亏钢瓶状态变为 pending_check");

    assert(Array.isArray(affectedSurplusMigrated), "返回 affectedSurplusMigrated 数组");
    assert(affectedSurplusMigrated.length === 1, "盘盈迁移 1 个钢瓶（仅非受保护且系统存在）");
    assert(
      affectedSurplusMigrated[0].cylinderId === `CY-ICS-${TS}-INSTOCK`,
      "迁移的是在库钢瓶"
    );
    assert(
      affectedSurplusMigrated[0].newLocation === LOC_INVENTORY,
      `迁移后库位为 ${LOC_INVENTORY}`
    );
    assert(
      affectedSurplusMigrated[0].previousLocation === LOC_OTHER,
      `迁移前库位为 ${LOC_OTHER}`
    );

    assert(Array.isArray(surplusRegistrationSuggestions), "返回 surplusRegistrationSuggestions 数组");
    assert(surplusRegistrationSuggestions.length === 1, "生成 1 条待登记建议");
    assert(
      surplusRegistrationSuggestions[0].cylinderId === `CY-ICS-${TS}-UNREGISTERED`,
      "待登记建议对应未登记钢瓶"
    );
    assert(
      surplusRegistrationSuggestions[0].suggestedLocation === LOC_INVENTORY,
      "待登记建议库位为盘点库位"
    );

    console.log("\n=== 2. 验证钢瓶实际状态变更 ===");
    const cylInStockAfter = await request("GET", `/cylinders/CY-ICS-${TS}-INSTOCK`, { token });
    assert(cylInStockAfter.statusCode === 200, "查询在库钢瓶成功");
    assert(
      cylInStockAfter.body.location === LOC_INVENTORY,
      "在库钢瓶已迁移到盘点库位"
    );

    const cylRentedAfter = await request("GET", `/cylinders/CY-ICS-${TS}-RENTED`, { token });
    assert(cylRentedAfter.statusCode === 200, "查询租借钢瓶成功");
    assert(
      cylRentedAfter.body.status === "rented",
      "租借钢瓶状态保持 rented（受保护，未被迁移）"
    );
    assert(
      cylRentedAfter.body.location === "测试客户",
      "租借钢瓶库位保持客户地址（受保护，未被迁移）"
    );

    const cylUnregCheck = await request("GET", `/cylinders/CY-ICS-${TS}-UNREGISTERED`, { token });
    assert(cylUnregCheck.statusCode === 404, "未登记钢瓶未被自动创建（生成建议而非建档）");

    const cylDeficitAfter = await request("GET", `/cylinders/CY-ICS-${TS}-EXPECTED`, { token });
    assert(cylDeficitAfter.statusCode === 200, "查询盘亏钢瓶成功");
    assert(
      cylDeficitAfter.body.status === "pending_check",
      "盘亏钢瓶状态为 pending_check"
    );

    console.log("\n=== 3. 验证钢瓶事件 ===");
    const inStockEvents = cylInStockAfter.body.events;
    const migrateEvent = inStockEvents.find((e) => e.type === "inventory_migrate");
    assert(migrateEvent !== undefined, "迁移钢瓶添加了 inventory_migrate 事件");
    assert(
      migrateEvent.note.includes(LOC_INVENTORY),
      "迁移事件备注包含目标库位"
    );

    const deficitEvents = cylDeficitAfter.body.events;
    const checkEvent = deficitEvents.find((e) => e.type === "inventory_check");
    assert(checkEvent !== undefined, "盘亏钢瓶添加了 inventory_check 事件");

    console.log("\n=== 4. 验证盘点单详情包含盘盈结果 ===");
    const checkDetail = await request("GET", `/inventory-checks/${checkId}`, { token });
    assert(checkDetail.statusCode === 200, "查询盘点单详情成功");
    assert(Array.isArray(checkDetail.body.surplusMigrated), "盘点单包含 surplusMigrated 字段");
    assert(
      checkDetail.body.surplusMigrated.length === 1,
      "盘点单 surplusMigrated 数量正确"
    );
    assert(
      Array.isArray(checkDetail.body.surplusRegistrationSuggestions),
      "盘点单包含 surplusRegistrationSuggestions 字段"
    );
    assert(
      checkDetail.body.surplusRegistrationSuggestions.length === 1,
      "盘点单 surplusRegistrationSuggestions 数量正确"
    );

    console.log("\n=== 5. 验证入参校验 - 无效 surplusMigrateId ===");
    const check2Res = await request("POST", "/inventory-checks", {
      token,
      idemKey: `check-ics-${TS}-2`,
      body: {
        title: `盘盈验证盘点2-${TS}`,
        scope: { location: LOC_INVENTORY },
        operator: OPERATOR,
      },
    });
    const check2Id = check2Res.body.id;
    createdChecks.push(check2Id);

    await request("POST", `/inventory-checks/${check2Id}/start`, {
      token,
      idemKey: `check-ics-${TS}-2-start`,
      body: {},
    });
    await request("POST", `/inventory-checks/${check2Id}/complete`, {
      token,
      idemKey: `check-ics-${TS}-2-complete`,
      body: {},
    });

    const invalidIdRes = await request("POST", `/inventory-checks/${check2Id}/confirm`, {
      token,
      idemKey: `check-ics-${TS}-2-confirm-invalid`,
      body: {
        surplusMigrateIds: ["", null, 123],
      },
    });
    assert(invalidIdRes.statusCode === 400, "无效 surplusMigrateId 返回 400");
    assert(invalidIdRes.body.error === "invalid_surplus_migrate_id", "错误码正确");

    console.log("\n=== 6. 验证操作日志 ===");
    const opLogs = await request("GET", `/operation-logs?operationType=inventory.confirm&targetId=${checkId}`, { token });
    assert(opLogs.statusCode === 200, "查询操作日志成功");
    assert(opLogs.body.items.length >= 1, "存在 inventory.confirm 操作日志");
    const log = opLogs.body.items[0];
    assert(log.status === "success", "操作日志状态为 success");
    assert(Array.isArray(log.eventIds) && log.eventIds.length > 0, "操作日志包含 eventIds");
    assert(log.beforeState !== null, "操作日志包含 beforeState");
    assert(log.afterState !== null, "操作日志包含 afterState");

    console.log("\n=== 7. 验证不传 surplusMigrateIds 时默认不迁移 ===");
    const check3Res = await request("POST", "/inventory-checks", {
      token,
      idemKey: `check-ics-${TS}-3`,
      body: {
        title: `盘盈验证盘点3-${TS}`,
        scope: { location: LOC_INVENTORY, gasType: GAS },
        operator: OPERATOR,
      },
    });
    const check3Id = check3Res.body.id;
    createdChecks.push(check3Id);

    await request("POST", `/inventory-checks/${check3Id}/start`, {
      token,
      idemKey: `check-ics-${TS}-3-start`,
      body: {},
    });

    await request("POST", `/inventory-checks/${check3Id}/scan`, {
      token,
      idemKey: `check-ics-${TS}-3-scan`,
      body: {
        cylinderIds: [`CY-ICS-${TS}-INSTOCK`],
        operator: OPERATOR,
      },
    });

    await request("POST", `/inventory-checks/${check3Id}/complete`, {
      token,
      idemKey: `check-ics-${TS}-3-complete`,
      body: {},
    });

    const confirm3Res = await request("POST", `/inventory-checks/${check3Id}/confirm`, {
      token,
      idemKey: `check-ics-${TS}-3-confirm`,
      body: { operator: OPERATOR },
    });
    assert(confirm3Res.statusCode === 200, "不传 surplusMigrateIds 也能确认成功");
    assert(confirm3Res.body.affectedSurplusMigrated.length === 0, "不传 surplusMigrateIds 时不迁移任何钢瓶");

    const cylInStockAfter3 = await request("GET", `/cylinders/CY-ICS-${TS}-INSTOCK`, { token });
    assert(
      cylInStockAfter3.body.location === LOC_INVENTORY,
      "钢瓶库位保持盘点库位（之前已迁移过）"
    );

    console.log("\n=== 8. 验证事件类型列表包含 inventory_migrate ===");
    const eventTypes = await request("GET", "/events/types", { token });
    assert(eventTypes.statusCode === 200, "查询事件类型成功");
    assert(
      eventTypes.body.types.includes("inventory_migrate"),
      "事件类型列表包含 inventory_migrate"
    );
    assert(
      eventTypes.body.types.includes("inventory_check"),
      "事件类型列表包含 inventory_check"
    );

    console.log("\n========================================");
    console.log(`  通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
    console.log("========================================\n");

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    try {
      await cleanupTestData(TS, createdCylinders, createdChecks);
    } finally {
      await restoreDataFiles(dataSnapshot);
      console.log("✅ 数据文件已恢复到脚本运行前状态\n");
    }
  }
}

run().catch(async (err) => {
  console.error("脚本执行失败:", err.message);
  console.error(err.stack);
  process.exit(1);
});
