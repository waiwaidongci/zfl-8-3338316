import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const { withMultiJsonTx, loadJson } = await import(join(projectRoot, "store/common.js"));
const { SEED: CYLINDERS_SEED } = await import(join(projectRoot, "store/cylinders.js"));
const { SEED: CHECKS_SEED } = await import(join(projectRoot, "store/inventoryChecks.js"));
const { SEED: LOGS_SEED } = await import(join(projectRoot, "store/operationLog.js"));
const { SEED: IDEM_SEED } = await import(join(projectRoot, "store/idempotency.js"));

const BASE = `http://localhost:${process.env.PORT || 3008}`;

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

async function cleanupTestData(TS, cylinderIds, checkIds) {
  console.log("\n🧹 清理测试数据...");

  const tsStr = String(TS);
  const idemKeyPrefixes = [`cyl-ic-${TS}-`, `check-ic-${TS}`];
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

  try {
    console.log("🚀 盘点单列表筛选验证脚本");
    console.log(`   运行标记: ${TS}\n`);

    const login = await request("POST", "/auth/login", {
      body: { username: "admin", password: "admin123" },
    });
    const token = login.body.token;
    console.log("✅ 登录成功\n");

    const LOC = `筛选测试仓-${TS}`;
    const GAS = `筛选测试气-${TS}`;
    const CREATOR = `测试员-${TS}`;

    for (let i = 0; i < 3; i++) {
      const r = await request("POST", "/cylinders", {
        token,
        idemKey: `cyl-ic-${TS}-${i}`,
        body: {
          id: `CY-IC-${TS}-${i}`,
          gasType: GAS,
          capacity: "40L",
          location: LOC,
          inspectionDue: "2027-01-01",
        },
      });
      createdCylinders.push(r.body.id);
    }

    const checkRes = await request("POST", "/inventory-checks", {
      token,
      idemKey: `check-ic-${TS}`,
      body: {
        title: `筛选测试盘点-${TS}`,
        scope: { location: LOC, gasType: GAS },
        operator: CREATOR,
        note: "筛选验证",
      },
    });
    const checkId = checkRes.body.id;
    createdChecks.push(checkId);
    assert(checkRes.statusCode === 201, `创建盘点单 ${checkId}`);

    const otherCheckRes = await request("POST", "/inventory-checks", {
      token,
      idemKey: `check-ic2-${TS}`,
      body: {
        title: `其他盘点-${TS}`,
        scope: {},
        operator: "其他人员",
        note: "不匹配筛选",
      },
    });
    const otherCheckId = otherCheckRes.body.id;
    createdChecks.push(otherCheckId);
    assert(otherCheckRes.statusCode === 201, `创建第二个盘点单 ${otherCheckId}`);

    console.log("\n=== 1. 基础列表（无筛选）===");
    const all = await request("GET", "/inventory-checks", { token });
    assert(Array.isArray(all.body), "返回数组");
    assert(all.statusCode === 200, "状态码 200");

    console.log("\n=== 2. 默认排序：createdAt 倒序 ===");
    const sorted = await request("GET", "/inventory-checks", { token });
    assert(Array.isArray(sorted.body), "返回数组");
    if (sorted.body.length >= 2) {
      const times = sorted.body.map((c) => new Date(c.createdAt).getTime());
      const isDesc = times.every((t, i) => i === 0 || times[i - 1] >= t);
      assert(isDesc, "结果按 createdAt 倒序排列");
    } else {
      assert(true, "数据不足跳过排序验证");
    }

    console.log("\n=== 3. status 筛选 ===");
    const byStatus = await request("GET", "/inventory-checks?status=draft", { token });
    assert(Array.isArray(byStatus.body), "status 筛选返回数组");
    assert(byStatus.body.every((c) => c.status === "draft"), "status=draft 筛选结果正确");

    console.log("\n=== 4. createdBy 筛选 ===");
    const byCreator = await request("GET", `/inventory-checks?createdBy=${encodeURIComponent(CREATOR)}`, { token });
    assert(Array.isArray(byCreator.body), "createdBy 筛选返回数组");
    assert(byCreator.body.every((c) => c.createdBy === CREATOR), `createdBy=${CREATOR} 筛选结果正确`);
    assert(byCreator.body.some((c) => c.id === checkId), "包含目标盘点单");
    assert(!byCreator.body.some((c) => c.id === otherCheckId), "不包含其他盘点单");

    console.log("\n=== 5. location 筛选 ===");
    const byLoc = await request("GET", `/inventory-checks?location=${encodeURIComponent(LOC)}`, { token });
    assert(Array.isArray(byLoc.body), "location 筛选返回数组");
    assert(byLoc.body.every((c) => c.scope && c.scope.location === LOC), `location=${LOC} 筛选结果正确`);
    assert(byLoc.body.some((c) => c.id === checkId), "包含目标盘点单");
    assert(!byLoc.body.some((c) => c.id === otherCheckId), "不包含其他盘点单");

    console.log("\n=== 6. gasType 筛选 ===");
    const byGas = await request("GET", `/inventory-checks?gasType=${encodeURIComponent(GAS)}`, { token });
    assert(Array.isArray(byGas.body), "gasType 筛选返回数组");
    assert(byGas.body.every((c) => c.scope && c.scope.gasType === GAS), `gasType=${GAS} 筛选结果正确`);
    assert(byGas.body.some((c) => c.id === checkId), "包含目标盘点单");
    assert(!byGas.body.some((c) => c.id === otherCheckId), "不包含其他盘点单");

    console.log("\n=== 7. createdFrom 筛选 ===");
    const fromTime = new Date(TS - 60000).toISOString();
    const byFrom = await request("GET", `/inventory-checks?createdFrom=${encodeURIComponent(fromTime)}`, { token });
    assert(Array.isArray(byFrom.body), "createdFrom 筛选返回数组");
    assert(
      byFrom.body.every((c) => new Date(c.createdAt).getTime() >= new Date(fromTime).getTime()),
      `createdFrom 筛选结果正确`
    );

    console.log("\n=== 8. createdTo 筛选 ===");
    const toTime = new Date(TS + 60000).toISOString();
    const byTo = await request("GET", `/inventory-checks?createdTo=${encodeURIComponent(toTime)}`, { token });
    assert(Array.isArray(byTo.body), "createdTo 筛选返回数组");
    assert(
      byTo.body.every((c) => new Date(c.createdAt).getTime() <= new Date(toTime).getTime()),
      `createdTo 筛选结果正确`
    );

    console.log("\n=== 9. createdFrom + createdTo 时间范围 ===");
    const rangeFrom = new Date(TS - 60000).toISOString();
    const rangeTo = new Date(TS + 60000).toISOString();
    const byRange = await request(
      "GET",
      `/inventory-checks?createdFrom=${encodeURIComponent(rangeFrom)}&createdTo=${encodeURIComponent(rangeTo)}`,
      { token }
    );
    assert(Array.isArray(byRange.body), "时间范围筛选返回数组");
    assert(
      byRange.body.every((c) => {
        const t = new Date(c.createdAt).getTime();
        return t >= new Date(rangeFrom).getTime() && t <= new Date(rangeTo).getTime();
      }),
      "时间范围筛选结果正确"
    );

    console.log("\n=== 10. 组合筛选：status + createdBy + location ===");
    const combo = await request(
      "GET",
      `/inventory-checks?status=draft&createdBy=${encodeURIComponent(CREATOR)}&location=${encodeURIComponent(LOC)}`,
      { token }
    );
    assert(Array.isArray(combo.body), "组合筛选返回数组");
    assert(combo.body.every((c) => c.status === "draft" && c.createdBy === CREATOR && c.scope && c.scope.location === LOC), "组合筛选结果正确");

    console.log("\n=== 11. 无效时间参数安全降级 ===");
    const invalidTime = await request("GET", "/inventory-checks?createdFrom=not-a-date", { token });
    assert(Array.isArray(invalidTime.body), "无效时间参数不报错，返回数组");
    assert(invalidTime.statusCode === 200, "无效时间参数状态码 200");

    console.log("\n=== 12. 详情接口不变 ===");
    const detail = await request("GET", `/inventory-checks/${checkId}`, { token });
    assert(detail.statusCode === 200, "详情接口状态码 200");
    assert(detail.body.id === checkId, "详情接口返回正确盘点单");

    console.log("\n========================================");
    console.log(`  通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
    console.log("========================================\n");

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await cleanupTestData(TS, createdCylinders, createdChecks);
  }
}

run().catch(async (err) => {
  console.error("脚本执行失败:", err.message);
  process.exit(1);
});
