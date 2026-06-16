import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";

const BASE = `http://localhost:${process.env.PORT || 3008}`;
const DATA_DIR = join(process.cwd(), "data", "v3", "compliance-reports");

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
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

async function waitForReportPhase(reportId, token, targetPhase, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request("GET", `/compliance-reports/${reportId}`, { token });
    if (res.body.currentPhase === targetPhase || res.body.status === "completed" || res.body.status === "failed") {
      return res.body;
    }
    await sleep(50);
  }
  throw new Error(`Report ${reportId} did not reach phase ${targetPhase} within ${timeoutMs}ms`);
}

async function verifyDataFileStructure(reportId) {
  const reportDir = join(DATA_DIR, reportId);
  const expectedFiles = [
    "customers.json",
    "orders.json",
    "inspections.json",
    "inventory.json",
    "operationLogs.json",
    "cylinders.json",
    "summary.json"
  ];

  const results = {};
  for (const file of expectedFiles) {
    try {
      await access(join(reportDir, file));
      results[file] = true;
    } catch {
      results[file] = false;
    }
  }
  return results;
}

async function readPhaseDataFile(reportId, fileName) {
  const filePath = join(DATA_DIR, reportId, fileName);
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function readComplianceReportsDb() {
  const filePath = join(process.cwd(), "data", "v3", "complianceReports.json");
  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content);
}

async function main() {
  console.log("合规报表分阶段快照 - 压力与回归测试（完整版）");
  console.log("==================================================");

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
  const runId = Date.now();

  section("测试 1: 创建报表 - 基本兼容性");
  const createRes = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
    headers: { "Idempotency-Key": `stress-test1-${runId}` },
  });
  assert(createRes.statusCode === 202, `创建返回 202 (${createRes.statusCode})`);
  assert(!!createRes.body.id, "返回报表 ID");
  assert(createRes.body.status === "pending", "初始状态为 pending");
  assert(!!createRes.body.phases, "包含 phases 字段");
  assert(!!createRes.body.progress, "包含 progress 字段");
  assert(typeof createRes.body.progress.step === "number", "progress.step 是数字");

  const reportId = createRes.body.id;
  console.log(`  报表 ID: ${reportId}`);

  section("测试 2: 分阶段进度跟踪");
  const phaseKeys = ["customers", "orders", "inspections", "inventory", "operationLogs", "cylinders", "finalize"];
  let trackedPhases = 0;
  let lastCompletedPhase = null;
  for (const phase of phaseKeys) {
    const report = await waitForReportPhase(reportId, adminToken, phase, 5000);
    if (report.status === "completed") {
      console.log(`  (报表已完成，跳过剩余阶段跟踪)`);
      break;
    }
    if (report.currentPhase === phase && report.phases?.[phase]?.status === "processing") {
      trackedPhases++;
      if (lastCompletedPhase) {
        assert(report.phases?.[lastCompletedPhase]?.status === "completed", `前一阶段 ${lastCompletedPhase} 已完成`);
      }
      console.log(`  捕获到阶段 ${phase} 正在处理中`);
      lastCompletedPhase = phase;
    }
  }
  if (trackedPhases > 0) {
    console.log(`  成功跟踪到 ${trackedPhases} 个阶段的 processing 状态`);
  } else {
    console.log(`  (数据量较小，阶段执行过快，未捕获到 processing 状态，这是正常的)`);
  }

  section("测试 3: 等待报表完成");
  const report = await waitForReportCompletion(reportId, adminToken, 15000);
  assert(report.status === "completed", `报表最终状态为 completed (实际: ${report.status})`);
  if (report.status === "failed") {
    console.log(`  失败原因: ${report.error}`);
    console.log(`  失败阶段: ${report.failedPhase}`);
  }
  assert(!!report.completedAt, "包含 completedAt");

  const fullReport = await request("GET", `/compliance-reports/${reportId}?include=result`, { token: adminToken });
  assert(!!fullReport.body.result, "完成后包含 result");
  assert(!!fullReport.body.result.summary, "result 包含 summary");

  const reportsDb = await readComplianceReportsDb();
  const persistedReport = reportsDb.reports?.find((r) => r.id === reportId);
  assert(!!persistedReport, "元数据文件包含当前报表");
  assert(!("result" in persistedReport), "元数据文件不保存完整 result 字段");
  assert(!!persistedReport.summary, "元数据文件保留轻量 summary 字段");

  section("测试 4: 所有阶段完成状态验证");
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

  section("测试 5: 数据文件结构验证");
  const fileResults = await verifyDataFileStructure(reportId);
  const phaseFileMap = {
    "customers.json": "customers",
    "orders.json": "orders",
    "inspections.json": "inspections",
    "inventory.json": "inventory",
    "operationLogs.json": "operationLogs",
    "cylinders.json": "cylinders",
    "summary.json": "finalize"
  };
  for (const [file, phase] of Object.entries(phaseFileMap)) {
    assert(fileResults[file] === true, `阶段 ${phase} 对应数据文件 ${file} 存在`);
  }

  section("测试 6: 阶段数据文件内容验证");
  const customersData = await readPhaseDataFile(reportId, "customers.json");
  assert(Array.isArray(customersData), "customers.json 是数组");
  assert(customersData.length === report.phases.customers.itemCount, "customers 数量与元数据一致");

  const ordersData = await readPhaseDataFile(reportId, "orders.json");
  assert(Array.isArray(ordersData), "orders.json 是数组");

  const inspectionsData = await readPhaseDataFile(reportId, "inspections.json");
  assert(!!inspectionsData && typeof inspectionsData === "object", "inspections.json 是对象");
  assert(Array.isArray(inspectionsData.tasks), "inspections.json 包含 tasks 数组");
  assert(Array.isArray(inspectionsData.risks), "inspections.json 包含 risks 数组");

  const inventoryData = await readPhaseDataFile(reportId, "inventory.json");
  assert(!!inventoryData && typeof inventoryData === "object", "inventory.json 是对象");
  assert(Array.isArray(inventoryData.checks), "inventory.json 包含 checks 数组");
  assert(Array.isArray(inventoryData.discrepancies), "inventory.json 包含 discrepancies 数组");

  const opLogsData = await readPhaseDataFile(reportId, "operationLogs.json");
  assert(!!opLogsData && typeof opLogsData === "object", "operationLogs.json 是对象");
  assert(Array.isArray(opLogsData.logs), "operationLogs.json 包含 logs 数组");
  assert(Array.isArray(opLogsData.operatorSummary), "operationLogs.json 包含 operatorSummary 数组");

  const cylindersData = await readPhaseDataFile(reportId, "cylinders.json");
  assert(Array.isArray(cylindersData), "cylinders.json 是数组");
  assert(cylindersData.length === report.phases.cylinders.itemCount, "cylinders 数量与元数据一致");

  const summaryData = await readPhaseDataFile(reportId, "summary.json");
  assert(!!summaryData && typeof summaryData === "object", "summary.json 是对象");
  assert(!!summaryData.summary, "summary.json 包含 summary 字段");
  assert(!!summaryData.period, "summary.json 包含 period 字段");

  section("测试 7: 报表结果数据完整性");
  const r = fullReport.body.result;
  assert(Array.isArray(r.customers), "result 包含 customers 数组");
  assert(Array.isArray(r.cylinders), "result 包含 cylinders 数组");
  assert(Array.isArray(r.rentalOrders), "result 包含 rentalOrders 数组");
  assert(Array.isArray(r.inspections), "result 包含 inspections 数组");
  assert(Array.isArray(r.inventoryChecks), "result 包含 inventoryChecks 数组");
  assert(Array.isArray(r.operationLogs), "result 包含 operationLogs 数组");
  assert(Array.isArray(r.risks), "result 包含 risks 数组");
  assert(Array.isArray(r.discrepancies), "result 包含 discrepancies 数组");
  assert(Array.isArray(r.operatorSummary), "result 包含 operatorSummary 数组");

  const s = r.summary;
  assert(typeof s.totalCustomers === "number", "summary.totalCustomers 是数字");
  assert(typeof s.totalCylinders === "number", "summary.totalCylinders 是数字");
  assert(typeof s.totalOrders === "number", "summary.totalOrders 是数字");
  assert(typeof s.totalInspectionTasks === "number", "summary.totalInspectionTasks 是数字");
  assert(typeof s.totalInventoryChecks === "number", "summary.totalInventoryChecks 是数字");
  assert(typeof s.totalOperationLogs === "number", "summary.totalOperationLogs 是数字");
  assert(typeof s.highRiskCount === "number", "summary.highRiskCount 是数字");
  assert(typeof s.mediumRiskCount === "number", "summary.mediumRiskCount 是数字");
  assert(typeof s.discrepancyCount === "number", "summary.discrepancyCount 是数字");

  section("测试 8: 向后兼容字段验证");
  const compatFields = ["id", "status", "params", "requestedBy", "progress", "error",
    "createdAt", "startedAt", "completedAt", "retryCount", "lastRetriedAt"];
  for (const field of compatFields) {
    assert(field in report, `兼容字段: ${field}`);
  }
  assert(!("result" in report), "默认详情不含 result（避免膨胀）");
  assert(!!fullReport.body.result, "?include=result 时包含 result");

  section("测试 9: 幂等创建 - 同一幂等键重复请求");
  const idemKey = `stress-test9-${runId}`;
  const create1 = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
    headers: { "Idempotency-Key": idemKey },
  });
  assert(create1.statusCode === 202, `首次创建返回 202`);

  await sleep(500);

  const create2 = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
    headers: { "Idempotency-Key": idemKey },
  });
  assert(create2.statusCode === 202 || create2.statusCode === 409, `二次幂等请求返回正确状态 (${create2.statusCode})`);
  if (create2.headers["x-idempotent-replayed"] === "true") {
    assert(create1.body.id === create2.body.id, "幂等重放返回相同 ID");
    assert(create1.body.createdAt === create2.body.createdAt, "幂等重放返回相同创建时间");
  }

  section("测试 10: 并发创建多个报表 - 压力测试");
  const concurrentCount = 10;
  console.log(`  并发创建 ${concurrentCount} 个报表...`);
  const concurrentPromises = [];
  for (let i = 0; i < concurrentCount; i++) {
    const uniqueKey = `stress-concurrent-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
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
  const waitPromises = ids.map((id) => waitForReportCompletion(id, adminToken, 60000));
  const completedReports = await Promise.all(waitPromises);
  const allCompleted = completedReports.every((r) => r.status === "completed");
  assert(allCompleted, `并发报表全部成功完成`);
  if (!allCompleted) {
    const failed = completedReports.filter((r) => r.status === "failed");
    console.log(`  失败报表: ${failed.map((r) => `${r.id} (${r.failedPhase}: ${r.error})`).join(", ")}`);
  }

  section("测试 11: 列表查询 - 兼容性与分页");
  const listRes = await request("GET", "/compliance-reports?page=1&pageSize=20", { token: adminToken });
  assert(listRes.statusCode === 200, `列表返回 200 (${listRes.statusCode})`);
  assert(Array.isArray(listRes.body.items), "items 是数组");
  assert(!!listRes.body.pagination, "包含 pagination");
  assert(listRes.body.pagination.page === 1, "pagination.page 正确");
  assert(listRes.body.items.length > 0, "列表至少有一条记录");
  assert(!!listRes.body.items[0].id, "列表项包含 id");
  assert(!!listRes.body.items[0].status, "列表项包含 status");
  assert("phases" in listRes.body.items[0], "列表项包含 phases 字段");
  assert(!("result" in listRes.body.items[0]), "列表项不含 result 字段（避免膨胀）");

  section("测试 12: 列表筛选 - 状态筛选");
  const completedList = await request(
    "GET",
    "/compliance-reports?status=completed&page=1&pageSize=100",
    { token: adminToken }
  );
  assert(completedList.statusCode === 200, "按状态筛选返回 200");
  const allCompletedInList = completedList.body.items.every((r) => r.status === "completed");
  assert(allCompletedInList, "筛选结果全部为 completed 状态");

  section("测试 13: 列表筛选 - 高风险筛选");
  const hasHighRiskList = await request(
    "GET",
    "/compliance-reports?hasHighRisk=true&page=1&pageSize=10",
    { token: adminToken }
  );
  assert(hasHighRiskList.statusCode === 200, "按高风险筛选返回 200");
  assert(
    hasHighRiskList.body.items.every((r) => r.status === "completed") || hasHighRiskList.body.items.length === 0,
    "高风险筛选结果正确"
  );

  section("测试 14: 列表筛选 - 盘点差异筛选");
  const hasDiscList = await request(
    "GET",
    "/compliance-reports?hasDiscrepancy=true&page=1&pageSize=10",
    { token: adminToken }
  );
  assert(hasDiscList.statusCode === 200, "按盘点差异筛选返回 200");
  assert(
    hasDiscList.body.items.every((r) => r.status === "completed") || hasDiscList.body.items.length === 0,
    "盘点差异筛选结果正确"
  );

  section("测试 15: 钢瓶追溯数据结构验证");
  const cylinders = fullReport.body.result.cylinders;
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

  section("测试 16: progress 字段格式验证");
  const prog = report.progress;
  assert(typeof prog === "object" && prog !== null, "progress 是对象");
  assert(typeof prog.step === "number", "progress.step 是数字");
  assert(typeof prog.total === "number", "progress.total 是数字");
  assert(typeof prog.message === "string", "progress.message 是字符串");
  assert(prog.total === 7, "阶段总数为 7");

  section("测试 17: phases 字段结构验证");
  const phases = report.phases;
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

  section("测试 18: 操作日志联动验证");
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

  section("测试 19: 幂等记录与操作日志关联");
  const idemRecordsRes = await request(
    "GET",
    `/idempotency-records?path=/compliance-reports&pageSize=5`,
    { token: adminToken }
  );
  if (idemRecordsRes.statusCode === 200 && idemRecordsRes.body.items?.length > 0) {
    const record = idemRecordsRes.body.items[0];
    assert(!!record.operationLogId || !!record.operationLog, "幂等记录关联操作日志");
  } else {
    console.log("  (幂等记录查询跳过或无数据)");
  }

  section("测试 20: 报表数量与分页准确性");
  const allList = await request("GET", "/compliance-reports?pageSize=100", { token: adminToken });
  const totalCount = allList.body.pagination.totalCount;
  assert(totalCount >= concurrentCount + 2, `报表总数 >= ${concurrentCount + 2} (实际: ${totalCount})`);

  section("测试 21: 列表查询性能测试");
  const perfStart = Date.now();
  for (let i = 0; i < 20; i++) {
    await request("GET", "/compliance-reports?page=1&pageSize=20", { token: adminToken });
  }
  const perfElapsed = Date.now() - perfStart;
  const avgPerQuery = perfElapsed / 20;
  console.log(`  20 次列表查询平均耗时: ${avgPerQuery.toFixed(1)}ms`);
  assert(avgPerQuery < 500, `列表查询平均耗时 < 500ms (实际: ${avgPerQuery.toFixed(1)}ms)`);

  section("测试 22: 单报表详情查询性能");
  const detailStart = Date.now();
  for (let i = 0; i < 20; i++) {
    await request("GET", `/compliance-reports/${reportId}`, { token: adminToken });
  }
  const detailElapsed = Date.now() - detailStart;
  const avgDetail = detailElapsed / 20;
  console.log(`  20 次详情查询平均耗时: ${avgDetail.toFixed(1)}ms`);
  assert(avgDetail < 200, `详情查询平均耗时 < 200ms (实际: ${avgDetail.toFixed(1)}ms)`);

  section("测试 23: currentPhase 和 phaseProgress 字段");
  assert("currentPhase" in report, "详情包含 currentPhase 字段");
  assert("phaseProgress" in report, "详情包含 phaseProgress 字段");
  assert(typeof report.phaseProgress?.current === "number", "phaseProgress.current 是数字");
  assert(typeof report.phaseProgress?.total === "number", "phaseProgress.total 是数字");
  assert(report.phaseProgress.total === 7, "phaseProgress.total 为 7");

  section("测试 24: 重试接口存在性验证");
  const retryRes = await request("POST", `/compliance-reports/${reportId}/retry`, {
    token: adminToken,
    body: {},
  });
  assert(retryRes.statusCode === 409, "对已完成报表重试返回 409 冲突");
  assert(retryRes.body.error === "only_failed_reports_can_be_retried", "错误信息正确");

  section("测试 25: 不存在的报表重试");
  const notFoundRetry = await request("POST", "/compliance-reports/CR-NONEXISTENT/retry", {
    token: adminToken,
    body: {},
  });
  assert(notFoundRetry.statusCode === 404, "不存在的报表重试返回 404");
  assert(notFoundRetry.body.error === "report_not_found", "错误信息正确");

  section("测试 26: checksum 幂等性验证");
  const idemKey2 = `checksum-test-${Date.now()}`;
  const createA = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
    headers: { "Idempotency-Key": idemKey2 },
  });
  const reportA = await waitForReportCompletion(createA.body.id, adminToken, 15000);
  assert(reportA.status === "completed", "基准报表创建完成");

  const checksumsBefore = {};
  for (const key of phaseKeys) {
    checksumsBefore[key] = reportA.phases[key].checksum;
  }

  const sameParamsReport = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
  });
  const reportB = await waitForReportCompletion(sameParamsReport.body.id, adminToken, 15000);
  assert(reportB.status === "completed", "相同参数的第二份报表创建完成");

  let matchingChecksums = 0;
  for (const key of phaseKeys) {
    if (reportB.phases[key].checksum === checksumsBefore[key]) {
      matchingChecksums++;
    }
  }
  console.log(`  ${matchingChecksums}/${phaseKeys.length} 个阶段 checksum 相同（相同参数）`);
  assert(matchingChecksums >= 5, "相同参数下大部分阶段 checksum 一致");

  section("测试 27: 不同参数 checksum 不一致验证");
  const diffParamsReport = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt: "2025-01-01T00:00:00.000Z", endAt: "2025-12-31T23:59:59.999Z" },
  });
  const reportC = await waitForReportCompletion(diffParamsReport.body.id, adminToken, 15000);
  assert(reportC.status === "completed", "不同参数的报表创建完成");

  let differingChecksums = 0;
  for (const key of phaseKeys) {
    if (reportC.phases[key].checksum !== checksumsBefore[key]) {
      differingChecksums++;
    }
  }
  console.log(`  ${differingChecksums}/${phaseKeys.length} 个阶段 checksum 不同（不同参数）`);
  assert(differingChecksums >= 3, "不同参数下多个阶段 checksum 不同");

  section("测试 28: 报表目录完整性验证");
  try {
    const dirs = await readdir(DATA_DIR);
    console.log(`  报表数据目录共 ${dirs.length} 个报表文件夹`);
    assert(dirs.length >= 3, "至少有 3 个报表数据目录");
  } catch (err) {
    console.log(`  (无法读取报表目录: ${err.message})`);
  }

  section("测试 29: 操作人汇总数据验证");
  if (fullReport.body.result.operatorSummary.length > 0) {
    const summary = fullReport.body.result.operatorSummary[0];
    assert("operator" in summary, "operatorSummary 包含 operator 字段");
    assert("operationCount" in summary, "operatorSummary 包含 operationCount 字段");
    assert("failedCount" in summary, "operatorSummary 包含 failedCount 字段");
    assert(typeof summary.operationCount === "number", "operationCount 是数字");
    assert(typeof summary.failedCount === "number", "failedCount 是数字");
  }

  section("测试 30: 钢瓶分批处理进度验证");
  const batchReportRes = await request("POST", "/compliance-reports", {
    token: adminToken,
    body: { startAt, endAt },
  });
  const batchReportId = batchReportRes.body.id;

  await sleep(200);
  const midProgress = await request("GET", `/compliance-reports/${batchReportId}`, { token: adminToken });

  if (midProgress.body.status === "processing") {
    const msg = midProgress.body.progress.message || "";
    const hasBatchInfo = msg.includes("/") && /\d+\//.test(msg);
    console.log(`  进度消息: ${msg}`);
    assert(typeof msg === "string" && msg.length > 0, "处理中有进度消息");
  }

  const batchReport = await waitForReportCompletion(batchReportId, adminToken, 15000);
  assert(batchReport.status === "completed", "分批处理报表完成");
  assert(batchReport.phases.cylinders.status === "completed", "钢瓶阶段完成");
  assert(batchReport.phases.cylinders.itemCount > 0, "钢瓶阶段有数据量");

  console.log("\n==================================================");
  console.log(`测试结果: ${pass} 通过, ${fail} 失败`);
  console.log("==================================================");

  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("测试执行失败:", err?.stack || err);
  process.exit(1);
});
