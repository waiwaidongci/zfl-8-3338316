import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, "http://localhost:3008");
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
    const bodyData = options.body ? JSON.stringify(options.body) : undefined;
    if (bodyData) headers["Content-Length"] = Buffer.byteLength(bodyData).toString();
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let body;
          try { body = data ? JSON.parse(data) : {}; } catch { body = { raw: data }; }
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.log(`  ❌ ${msg}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function waitForReportCompletion(reportId, token, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request("GET", `/compliance-reports/${reportId}`, { token });
    if (res.body.status === "completed" || res.body.status === "failed") {
      return res.body;
    }
    await sleep(200);
  }
  throw new Error(`Report ${reportId} did not complete within ${timeoutMs}ms`);
}

async function main() {
  console.log("合规报表分阶段快照 - 压力与回归测试");
  console.log("==========================================");

  const adminLogin = await request("POST", "/auth/login", {
    body: { username: "admin", password: "admin123" },
  });
  const adminToken = adminLogin.body.token;
  assert(!!adminToken, "管理员登录成功");

  if (!adminToken) {
    console.error("无法获取 admin token，测试终止");
    process.exit(1);
  }

  const startAt = "2020-01-01T00:00:00.000Z";
  const endAt = "2030-12-31T23:59:59.999Z";

  section("测试 1: 创建报表 - 基本兼容性");
  const createRes = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
  });
  assert(createRes.statusCode === 202, `创建返回 202 (${createRes.statusCode})`);
  assert(!!createRes.body.id, "返回报表 ID");
  assert(createRes.body.status === "pending", "初始状态为 pending");
  assert(!!createRes.body.phases, "包含 phases 字段");
  assert(!!createRes.body.progress, "包含 progress 字段");
  assert(typeof createRes.body.progress.step === "number", "progress.step 是数字");
  assert(typeof createRes.body.progress.total === "number", "progress.total 是数字");
  assert(Array.isArray(createRes.body.progress?.step) === false, "progress 格式正确（非数组）");

  const reportId = createRes.body.id;
  console.log(`  报表 ID: ${reportId}`);

  section("测试 2: 报表列表查询 - 兼容性");
  const listRes = await request("GET", "/compliance-reports?page=1&pageSize=10", { token: adminToken });
  assert(listRes.statusCode === 200, `列表返回 200 (${listRes.statusCode})`);
  assert(Array.isArray(listRes.body.items), "items 是数组");
  assert(!!listRes.body.pagination, "包含 pagination");
  assert(listRes.body.pagination.page === 1, "pagination.page 正确");
  assert(listRes.body.items.length > 0, "列表至少有一条记录");
  assert(!!listRes.body.items[0].id, "列表项包含 id");
  assert(!!listRes.body.items[0].status, "列表项包含 status");

  section("测试 3: 等待报表完成 - 分阶段进度");
  const report = await waitForReportCompletion(reportId, adminToken, 15000);
  assert(report.status === "completed", `报表最终状态为 completed (实际: ${report.status})`);
  if (report.status === "failed") {
    console.log(`  失败原因: ${report.error}`);
    console.log(`  失败阶段: ${report.failedPhase}`);
  }
  assert(!!report.result, "完成后包含 result");
  assert(!!report.result.summary, "result 包含 summary");
  assert(!!report.completedAt, "包含 completedAt");

  section("测试 4: 阶段状态验证");
  const phaseKeys = ["customers", "orders", "inspections", "inventory", "operationLogs", "cylinders", "finalize"];
  for (const key of phaseKeys) {
    assert(
      report.phases?.[key]?.status === "completed",
      `阶段 ${key} 状态为 completed (实际: ${report.phases?.[key]?.status})`
    );
    assert(
      typeof report.phases?.[key]?.itemCount === "number",
      `阶段 ${key} 有 itemCount`
    );
    assert(
      !!report.phases?.[key]?.completedAt,
      `阶段 ${key} 有 completedAt`
    );
    assert(
      !!report.phases?.[key]?.checksum,
      `阶段 ${key} 有 checksum`
    );
  }
  assert(report.phases?.finalize?.itemCount === 1, "finalize 阶段 itemCount 为 1");

  section("测试 5: 报表结果数据完整性");
  assert(Array.isArray(report.result.customers), "result 包含 customers 数组");
  assert(Array.isArray(report.result.cylinders), "result 包含 cylinders 数组");
  assert(Array.isArray(report.result.rentalOrders), "result 包含 rentalOrders 数组");
  assert(Array.isArray(report.result.inspections), "result 包含 inspections 数组");
  assert(Array.isArray(report.result.inventoryChecks), "result 包含 inventoryChecks 数组");
  assert(Array.isArray(report.result.operationLogs), "result 包含 operationLogs 数组");
  assert(Array.isArray(report.result.risks), "result 包含 risks 数组");
  assert(Array.isArray(report.result.discrepancies), "result 包含 discrepancies 数组");
  assert(Array.isArray(report.result.operatorSummary), "result 包含 operatorSummary 数组");
  assert(!!report.result.period, "result 包含 period");
  assert(!!report.result.summary, "result 包含 summary");

  const s = report.result.summary;
  assert(typeof s.totalCustomers === "number", "summary.totalCustomers 是数字");
  assert(typeof s.totalCylinders === "number", "summary.totalCylinders 是数字");
  assert(typeof s.totalOrders === "number", "summary.totalOrders 是数字");
  assert(typeof s.totalInspectionTasks === "number", "summary.totalInspectionTasks 是数字");
  assert(typeof s.totalInventoryChecks === "number", "summary.totalInventoryChecks 是数字");
  assert(typeof s.totalOperationLogs === "number", "summary.totalOperationLogs 是数字");
  assert(typeof s.highRiskCount === "number", "summary.highRiskCount 是数字");
  assert(typeof s.mediumRiskCount === "number", "summary.mediumRiskCount 是数字");
  assert(typeof s.discrepancyCount === "number", "summary.discrepancyCount 是数字");

  section("测试 6: 向后兼容字段验证");
  assert("id" in report, "兼容字段: id");
  assert("status" in report, "兼容字段: status");
  assert("params" in report, "兼容字段: params");
  assert("requestedBy" in report, "兼容字段: requestedBy");
  assert("progress" in report, "兼容字段: progress");
  assert("result" in report, "兼容字段: result");
  assert("error" in report, "兼容字段: error");
  assert("createdAt" in report, "兼容字段: createdAt");
  assert("startedAt" in report, "兼容字段: startedAt");
  assert("completedAt" in report, "兼容字段: completedAt");
  assert("retryCount" in report, "兼容字段: retryCount");
  assert("lastRetriedAt" in report, "兼容字段: lastRetriedAt");

  section("测试 7: 幂等创建 - 同一幂等键重复请求");
  const idemKey = `test-iem-${Date.now()}`;
  const create1 = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
    headers: { "Idempotency-Key": idemKey },
  });
  assert(create1.statusCode === 202, `首次创建返回 202`);

  const create2 = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
    headers: { "Idempotency-Key": idemKey },
  });
  assert(create2.statusCode === 202 || create2.statusCode === 409, `二次幂等请求返回正确状态 (${create2.statusCode})`);
  assert(!!create2.body?.id || create2.body?.error === "request_in_progress", "幂等响应合理");
  if (create2.headers["x-idempotent-replayed"] === "true") {
    assert(create1.body.id === create2.body.id, "幂等重放返回相同 ID");
  }

  section("测试 8: 并发创建多个报表 - 压力测试");
  const concurrentCount = 5;
  console.log(`  并发创建 ${concurrentCount} 个报表...`);
  const concurrentPromises = [];
  for (let i = 0; i < concurrentCount; i++) {
    const uniqueKey = `concurrent-test-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    concurrentPromises.push(
      request("POST", "/compliance-reports", {
        token: adminToken,
        body: { startAt, endAt, _batch: i },
        headers: { "Idempotency-Key": uniqueKey },
      })
    );
  }
  const concurrentResults = await Promise.all(concurrentPromises);
  const all202 = concurrentResults.every((r) => r.statusCode === 202);
  assert(all202, `并发创建全部返回 202`);
  const ids = concurrentResults.map((r) => r.body.id);
  const uniqueIds = new Set(ids);
  assert(uniqueIds.size === concurrentCount, `${concurrentCount} 个报表 ID 互不重复`);

  console.log(`  等待所有并发报表完成...`);
  const waitPromises = ids.map((id) => waitForReportCompletion(id, adminToken, 30000));
  const completedReports = await Promise.all(waitPromises);
  const allCompleted = completedReports.every((r) => r.status === "completed");
  assert(allCompleted, `并发报表全部成功完成`);
  if (!allCompleted) {
    const failed = completedReports.filter((r) => r.status === "failed");
    console.log(`  失败报表: ${failed.map((r) => `${r.id} (${r.failedPhase}: ${r.error})`).join(", ")}`);
  }

  section("测试 9: 列表筛选 - 兼容性验证");
  const completedList = await request(
    "GET",
    "/compliance-reports?status=completed&page=1&pageSize=100",
    { token: adminToken }
  );
  assert(completedList.statusCode === 200, "按状态筛选返回 200");
  const allCompletedInList = completedList.body.items.every((r) => r.status === "completed");
  assert(allCompletedInList, "筛选结果全部为 completed 状态");

  const hasHighRiskList = await request(
    "GET",
    "/compliance-reports?hasHighRisk=true&page=1&pageSize=10",
    { token: adminToken }
  );
  assert(hasHighRiskList.statusCode === 200, "按高风险筛选返回 200");
  const highRiskValid = hasHighRiskList.body.items.every((r) => {
    if (r.status !== "completed") return false;
    return (r.result?.summary?.highRiskCount ?? 0) > 0;
  });
  assert(highRiskValid || hasHighRiskList.body.items.length === 0, "高风险筛选结果正确");

  section("测试 10: 钢瓶追溯数据结构验证");
  const cylinders = report.result.cylinders;
  assert(Array.isArray(cylinders) && cylinders.length > 0, "有钢瓶数据可验证");
  if (cylinders.length > 0) {
    const c = cylinders[0];
    assert("cylinderId" in c, "追溯数据包含 cylinderId");
    assert("gasType" in c, "追溯数据包含 gasType");
    assert("capacity" in c, "追溯数据包含 capacity");
    assert("currentStatus" in c, "追溯数据包含 currentStatus");
    assert(Array.isArray(c.statusChanges), "追溯数据包含 statusChanges 数组");
    assert(Array.isArray(c.relatedOrders), "追溯数据包含 relatedOrders 数组");
    assert(Array.isArray(c.inspectionRisks), "追溯数据包含 inspectionRisks 数组");
    assert(Array.isArray(c.inventoryDiscrepancies), "追溯数据包含 inventoryDiscrepancies 数组");
    assert(Array.isArray(c.operators), "追溯数据包含 operators 数组");
    assert(Array.isArray(c.fillsInPeriod), "追溯数据包含 fillsInPeriod 数组");
  }

  section("测试 11: progress 字段格式向后兼容");
  const detailRes = await request("GET", `/compliance-reports/${reportId}`, { token: adminToken });
  const prog = detailRes.body.progress;
  assert(typeof prog === "object" && prog !== null, "progress 是对象");
  assert(typeof prog.step === "number", "progress.step 是数字");
  assert(typeof prog.total === "number", "progress.total 是数字");
  assert(typeof prog.message === "string", "progress.message 是字符串");
  assert(prog.total > 3, "阶段总数 > 3（分阶段扩展）");

  section("测试 12: phases 字段结构");
  const phases = detailRes.body.phases;
  assert(typeof phases === "object" && phases !== null, "phases 是对象");
  const phaseCount = Object.keys(phases).length;
  assert(phaseCount === 7, `共 7 个阶段 (实际: ${phaseCount})`);

  for (const [key, phase] of Object.entries(phases)) {
    assert("status" in phase, `阶段 ${key} 有 status 字段`);
    assert("startedAt" in phase, `阶段 ${key} 有 startedAt 字段`);
    assert("completedAt" in phase, `阶段 ${key} 有 completedAt 字段`);
    assert("itemCount" in phase, `阶段 ${key} 有 itemCount 字段`);
    assert("checksum" in phase, `阶段 ${key} 有 checksum 字段`);
    assert("error" in phase, `阶段 ${key} 有 error 字段`);
  }

  section("测试 13: 列表项包含 phases 预览信息");
  const listItem = completedList.body.items[0];
  assert("phases" in listItem, "列表项包含 phases 字段");

  section("测试 14: 报表数量与分页");
  const allList = await request("GET", "/compliance-reports?pageSize=100", { token: adminToken });
  const totalCount = allList.body.pagination.totalCount;
  assert(totalCount >= concurrentCount + 1, `报表总数 >= ${concurrentCount + 1} (实际: ${totalCount})`);

  section("测试 15: 操作日志联动验证");
  const opLogsRes = await request(
    "GET",
    "/operation-logs?operationType=compliance.report.create&pageSize=10",
    { token: adminToken }
  );
  assert(opLogsRes.statusCode === 200, "查询合规报表创建操作日志返回 200");
  assert(
    opLogsRes.body.items.length > 0,
    `存在 compliance.report.create 类型的操作日志 (数量: ${opLogsRes.body.items.length})`
  );

  if (opLogsRes.body.items.length > 0) {
    const log = opLogsRes.body.items[0];
    assert(log.operationType === "compliance.report.create", "操作类型正确");
    assert(log.targetType === "compliance_report", "目标类型正确");
    assert(!!log.targetId, "有 targetId");
  }

  section("测试 16: 重试失败报表 - 幂等续跑");
  console.log("  (跳过主动失败测试，保留为功能说明)");
  console.log("  重试机制: 失败的报表可通过 POST /compliance-reports/:id/retry 重试");
  console.log("  幂等保证: 已完成阶段(checksum 匹配)直接跳过，不会重复生成");
  console.log("  断点续跑: 从失败阶段重新执行，已完成阶段保留");

  section("测试 17: 大量报表列表查询性能");
  const perfStart = Date.now();
  for (let i = 0; i < 10; i++) {
    await request("GET", "/compliance-reports?page=1&pageSize=20", { token: adminToken });
  }
  const perfElapsed = Date.now() - perfStart;
  const avgPerQuery = perfElapsed / 10;
  console.log(`  10 次列表查询平均耗时: ${avgPerQuery.toFixed(1)}ms`);
  assert(avgPerQuery < 500, `列表查询平均耗时 < 500ms (实际: ${avgPerQuery.toFixed(1)}ms)`);

  section("测试 18: 单报表详情查询性能");
  const detailStart = Date.now();
  for (let i = 0; i < 10; i++) {
    await request("GET", `/compliance-reports/${reportId}`, { token: adminToken });
  }
  const detailElapsed = Date.now() - detailStart;
  const avgDetail = detailElapsed / 10;
  console.log(`  10 次详情查询平均耗时: ${avgDetail.toFixed(1)}ms`);
  assert(avgDetail < 200, `详情查询平均耗时 < 200ms (实际: ${avgDetail.toFixed(1)}ms)`);

  section("测试 19: currentPhase 字段存在性");
  assert("currentPhase" in detailRes.body, "详情包含 currentPhase 字段");
  assert("phaseProgress" in detailRes.body, "详情包含 phaseProgress 字段");
  assert(typeof detailRes.body.phaseProgress?.current === "number", "phaseProgress.current 是数字");
  assert(typeof detailRes.body.phaseProgress?.total === "number", "phaseProgress.total 是数字");

  section("测试 20: 筛选 hasDiscrepancy 兼容性");
  const hasDiscList = await request(
    "GET",
    "/compliance-reports?hasDiscrepancy=true&page=1&pageSize=10",
    { token: adminToken }
  );
  assert(hasDiscList.statusCode === 200, "按盘点差异筛选返回 200");
  const discValid = hasDiscList.body.items.every((r) => {
    if (r.status !== "completed") return false;
    return (r.result?.summary?.discrepancyCount ?? 0) > 0;
  });
  assert(discValid || hasDiscList.body.items.length === 0, "盘点差异筛选结果正确");

  console.log("\n==========================================");
  console.log(`测试结果: ${pass} 通过, ${fail} 失败`);
  console.log("==========================================");

  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("测试执行失败:", err?.stack || err);
  process.exit(1);
});
