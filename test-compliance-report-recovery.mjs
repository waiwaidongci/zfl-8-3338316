import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const dataDir = join(projectRoot, "data", "v2");
const reportsFile = join(dataDir, "complianceReports.json");

const BASE_URL = "http://localhost:3098";
const TEST_PORT = 3098;

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startServer(env = {}) {
  const proc = spawn("node", ["server.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: String(TEST_PORT), ...env }
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Server startup timeout"));
    }, 15000);

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("listening on")) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("[Fatal]") || text.includes("EADDRINUSE")) {
        clearTimeout(timeout);
        reject(new Error(`Server error: ${text}`));
      }
    });
  });
}

function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  proc.kill("SIGTERM");
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5000);
    proc.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function login() {
  const res = await request("POST", "/auth/login", {
    body: { username: "admin", password: "admin123" }
  });
  if (res.statusCode !== 200) {
    throw new Error(`Login failed: ${res.statusCode} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function waitForReportCompletion(token, reportId, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await request("GET", `/compliance-reports/${reportId}`, { token });
    if (res.body.status === "completed" || res.body.status === "failed") {
      return res.body;
    }
    await sleep(500);
  }
  throw new Error(`Report ${reportId} did not complete within ${maxWaitMs}ms`);
}

async function readReportFile() {
  if (!existsSync(reportsFile)) return null;
  const content = await readFile(reportsFile, "utf8");
  return JSON.parse(content);
}

async function writeReportFile(data) {
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true });
  }
  await writeFile(reportsFile, JSON.stringify(data, null, 2), "utf8");
}

async function cleanReportFile() {
  if (existsSync(reportsFile)) {
    try { await unlink(reportsFile); } catch {}
  }
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

async function testCreateReport() {
  console.log("\n📋 测试1: 创建合规追溯报表");
  const token = await login();

  const res = await request("POST", "/compliance-reports", {
    token,
    body: {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-12-31T23:59:59.999Z"
    }
  });

  assert(res.statusCode === 202, `创建报表返回202 (实际: ${res.statusCode})`);
  assert(res.body.id, "返回报表ID");
  assert(res.body.status === "pending" || res.body.status === "processing" || res.body.status === "completed",
    `报表状态合理: ${res.body.status}`);
  assert(res.body.params.startAt === "2026-01-01T00:00:00.000Z", "startAt参数正确");
  assert(res.body.params.endAt === "2026-12-31T23:59:59.999Z", "endAt参数正确");

  const completedReport = await waitForReportCompletion(token, res.body.id);
  assert(completedReport.status === "completed", `报表最终完成 (状态: ${completedReport.status})`);
  assert(completedReport.result !== null, "报表结果不为空");
  assert(completedReport.result.period !== undefined, "结果包含period");
  assert(completedReport.result.summary !== undefined, "结果包含summary");
  assert(completedReport.result.cylinders !== undefined, "结果包含cylinders追溯");
  assert(completedReport.result.risks !== undefined, "结果包含检验风险");
  assert(completedReport.result.discrepancies !== undefined, "结果包含盘点差异");
  assert(completedReport.result.operatorSummary !== undefined, "结果包含操作人汇总");

  return res.body.id;
}

async function testIdempotentCreate(token) {
  console.log("\n📋 测试2: 幂等提交 - 重复Idempotency-Key返回相同结果");
  const idemKey = "test-idem-" + Date.now();

  const res1 = await request("POST", "/compliance-reports", {
    token,
    body: {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-06-30T23:59:59.999Z"
    },
    idemKey
  });

  assert(res1.statusCode === 202, `第一次请求返回202`);

  const res2 = await request("POST", "/compliance-reports", {
    token,
    body: {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-06-30T23:59:59.999Z"
    },
    idemKey
  });

  assert(res2.body.id === res1.body.id, `幂等重复请求返回相同报表ID`);
  assert(res2.headers["x-idempotent-replayed"] === "true", "幂等重复请求标记Replayed");
}

async function testListReports(token) {
  console.log("\n📋 测试3: 查询报表列表");
  const res = await request("GET", "/compliance-reports", { token });
  assert(res.statusCode === 200, `列表返回200`);
  assert(Array.isArray(res.body.items), "items为数组");
  assert(res.body.pagination !== undefined, "包含分页信息");
  assert(res.body.pagination.totalCount > 0, "有报表记录");
}

async function testGetReport(token, reportId) {
  console.log("\n📋 测试4: 查询单个报表");
  const res = await request("GET", `/compliance-reports/${reportId}`, { token });
  assert(res.statusCode === 200, `获取报表返回200`);
  assert(res.body.id === reportId, "报表ID匹配");

  const noExist = await request("GET", "/compliance-reports/CR-NONEXIST", { token });
  assert(noExist.statusCode === 404, "不存在的报表返回404");
}

async function testNoInternalFieldsLeak(token, reportId) {
  console.log("\n📋 测试5: 内部字段不泄露");
  const res = await request("GET", `/compliance-reports/${reportId}`, { token });
  assert(res.statusCode === 200, "获取报表成功");

  const resultStr = JSON.stringify(res.body.result || {});
  assert(!resultStr.includes("_schemaVersion"), "结果中不包含_schemaVersion");
  assert(!resultStr.includes('"_meta"'), "结果中不包含_meta内部字段");

  const bodyStr = JSON.stringify(res.body);
  assert(!bodyStr.includes("_schemaVersion"), "响应中不包含_schemaVersion");
}

async function testRetryFailedReport(currentProc) {
  console.log("\n📋 测试6: 失败重试");

  await stopServer(currentProc);
  await sleep(1000);

  const fileData = await readReportFile();
  const reportsArray = fileData?.reports || [];

  const failedReport = {
    id: "CR-RETRY-TEST",
    status: "failed",
    params: { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-12-31T23:59:59.999Z" },
    requestedBy: "admin",
    progress: { step: 0, total: 3, message: "失败: test_error" },
    result: null,
    error: "test_error",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    retryCount: 0,
    lastRetriedAt: null
  };

  reportsArray.push(failedReport);
  await writeReportFile({ ...fileData, reports: reportsArray });

  const newProc = await startServer();
  await sleep(2000);

  const token = await login();
  const res = await request("POST", `/compliance-reports/CR-RETRY-TEST/retry`, { token });
  assert(res.statusCode === 202, `重试返回202 (实际: ${res.statusCode})`);

  const completedReport = await waitForReportCompletion(token, "CR-RETRY-TEST", 15000);
  assert(completedReport.status === "completed", `重试后报表完成 (状态: ${completedReport.status})`);
  assert(completedReport.retryCount === 1, `重试计数为1 (实际: ${completedReport.retryCount})`);

  const retryCompleted = await request("POST", `/compliance-reports/CR-RETRY-TEST/retry`, { token, idemKey: "retry-completed-" + Date.now() });
  assert(retryCompleted.statusCode === 409, `已完成报表不可重试 (返回${retryCompleted.statusCode}, error=${retryCompleted.body.error || "none"})`);

  return newProc;
}

async function testCylinderTraceability(token, reportId) {
  console.log("\n📋 测试7: 钢瓶追溯数据完整性");
  const res = await request("GET", `/compliance-reports/${reportId}`, { token });
  assert(res.statusCode === 200, "获取报表成功");

  const cylinders = res.body.result.cylinders;
  assert(Array.isArray(cylinders), "cylinders为数组");

  if (cylinders.length > 0) {
    const c = cylinders[0];
    assert(c.cylinderId !== undefined, "包含cylinderId");
    assert(c.currentStatus !== undefined, "包含currentStatus");
    assert(Array.isArray(c.statusChanges), "包含statusChanges数组");
    assert(Array.isArray(c.relatedOrders), "包含relatedOrders数组");
    assert(Array.isArray(c.inspectionRisks), "包含inspectionRisks数组");
    assert(Array.isArray(c.inventoryDiscrepancies), "包含inventoryDiscrepancies数组");
    assert(Array.isArray(c.operators), "包含operators数组");
  }
}

async function testRecoveryAfterRestart() {
  console.log("\n📋 测试8: 重启后任务状态恢复");

  await cleanReportFile();

  const now = Date.now();
  const reportData = {
    _schemaVersion: "2.0",
    _meta: {
      createdAt: new Date().toISOString(),
      entity: "complianceReports",
      sourceFile: "complianceReports.json"
    },
    reports: [
      {
        id: "CR-RECOVERY-TEST",
        status: "processing",
        params: { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-12-31T23:59:59.999Z" },
        requestedBy: "admin",
        progress: { step: 1, total: 3, message: "加载数据中" },
        result: null,
        error: null,
        createdAt: new Date(now - 20 * 60 * 1000).toISOString(),
        startedAt: new Date(now - 20 * 60 * 1000).toISOString(),
        completedAt: null,
        retryCount: 0,
        lastRetriedAt: null
      },
      {
        id: "CR-PENDING-TEST",
        status: "pending",
        params: { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-12-31T23:59:59.999Z" },
        requestedBy: "admin",
        progress: { step: 0, total: 3, message: "等待处理" },
        result: null,
        error: null,
        createdAt: new Date(now - 5 * 60 * 1000).toISOString(),
        startedAt: null,
        completedAt: null,
        retryCount: 0,
        lastRetriedAt: null
      }
    ]
  };

  await writeReportFile(reportData);

  console.log("  启动服务器 (含processing/pending任务)...");
  const proc1 = await startServer();
  await sleep(5000);

  const token = await login();

  const check1 = await request("GET", "/compliance-reports/CR-RECOVERY-TEST", { token });
  console.log(`  首次启动后CR-RECOVERY-TEST: statusCode=${check1.statusCode}, status=${check1.body.status}, error=${check1.body.error || "none"}`);

  const check2 = await request("GET", "/compliance-reports/CR-PENDING-TEST", { token });
  console.log(`  首次启动后CR-PENDING-TEST: statusCode=${check2.statusCode}, status=${check2.body.status}`);

  const validStatuses1 = ["completed", "failed", "processing"];
  const recovered1 = validStatuses1.includes(check1.body.status);
  assert(recovered1, `CR-RECOVERY-TEST被恢复处理 (状态: ${check1.body.status})`);

  const validStatuses2 = ["completed", "processing"];
  const recovered2 = validStatuses2.includes(check2.body.status);
  assert(recovered2, `CR-PENDING-TEST被恢复处理 (状态: ${check2.body.status})`);

  console.log("  停止服务器...");
  await stopServer(proc1);
  await sleep(1500);

  const fileData = await readReportFile();
  assert(fileData !== null, "报表文件持久化存在");
  if (fileData) {
    const reportStates = (fileData.reports || []).map((r) => `${r.id}=${r.status}`).join(", ");
    console.log(`  持久化状态: ${reportStates}`);
  }

  console.log("  再次启动服务器验证状态...");
  const proc2 = await startServer();
  await sleep(5000);

  const token2 = await login();
  const recheck1 = await request("GET", "/compliance-reports/CR-RECOVERY-TEST", { token: token2 });
  console.log(`  二次启动后CR-RECOVERY-TEST: statusCode=${recheck1.statusCode}, status=${recheck1.body.status}, error=${recheck1.body.error || "none"}`);

  const recheck2 = await request("GET", "/compliance-reports/CR-PENDING-TEST", { token: token2 });
  console.log(`  二次启动后CR-PENDING-TEST: statusCode=${recheck2.statusCode}, status=${recheck2.body.status}`);

  const finalValid = ["completed", "failed", "processing"];
  assert(
    finalValid.includes(recheck1.body.status),
    `二次恢复后CR-RECOVERY-TEST状态合理: ${recheck1.body.status}`
  );

  assert(
    recheck2.body.status === "completed",
    `CR-PENDING-TEST最终完成: ${recheck2.body.status}`
  );

  await stopServer(proc2);
}

async function testCreateRequiresParams() {
  console.log("\n📋 测试9: 创建报表参数校验");
  const token = await login();
  const res = await request("POST", "/compliance-reports", {
    token,
    body: {}
  });
  assert(res.statusCode === 400, "缺少startAt/endAt返回400");
}

async function testComplianceReportSnapshot(token) {
  console.log("\n📋 测试10: 合规快照内容校验");
  const res = await request("POST", "/compliance-reports", {
    token,
    body: {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-12-31T23:59:59.999Z"
    }
  });
  assert(res.statusCode === 202, "创建报表成功");

  const completed = await waitForReportCompletion(token, res.body.id, 15000);
  assert(completed.status === "completed", `报表完成`);

  const r = completed.result;
  assert(r.summary.totalCylinders > 0, `汇总包含钢瓶数: ${r.summary.totalCylinders}`);
  assert(r.summary.totalCustomers > 0, `汇总包含客户数: ${r.summary.totalCustomers}`);
  assert(Array.isArray(r.customers), "快照包含customers");
  assert(Array.isArray(r.rentalOrders), "快照包含rentalOrders");
  assert(Array.isArray(r.inspections), "快照包含inspections");
  assert(Array.isArray(r.inventoryChecks), "快照包含inventoryChecks");
  assert(Array.isArray(r.operationLogs), "快照包含operationLogs");

  const customersNoInternal = !JSON.stringify(r.customers).includes("_schemaVersion");
  assert(customersNoInternal, "customers快照无_schemaVersion泄露");
}

async function main() {
  console.log("========================================");
  console.log("  合规追溯报表 - 测试脚本");
  console.log("========================================");

  let serverProc = null;

  try {
    console.log("\n🚀 启动服务器...");
    serverProc = await startServer();
    console.log("  服务器已启动");

    const token = await login();
    console.log("  登录成功");

    const reportId = await testCreateReport();
    await testIdempotentCreate(token);
    await testListReports(token);
    await testGetReport(token, reportId);
    await testNoInternalFieldsLeak(token, reportId);

    serverProc = await testRetryFailedReport(serverProc);

    const newToken = await login();
    await testCylinderTraceability(newToken, reportId);
    await testCreateRequiresParams();
    await testComplianceReportSnapshot(newToken);

  } catch (err) {
    console.error(`\n❌ 测试执行失败: ${err.message}`);
    console.error(err.stack);
    if (serverProc) {
      await stopServer(serverProc);
    }
  } finally {
    if (serverProc) {
      console.log("\n🛑 停止服务器...");
      await stopServer(serverProc);
    }
  }

  try {
    await testRecoveryAfterRestart();
  } catch (err) {
    console.error(`\n❌ 重启恢复测试失败: ${err.message}`);
    console.error(err.stack);
  }

  console.log("\n========================================");
  console.log(`  测试完成: ✅ ${passed} 通过, ❌ ${failed} 失败`);
  console.log("========================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main();
