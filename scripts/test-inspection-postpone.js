import http from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");

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

let pass = 0;
let fail = 0;

async function snapshotDataDir() {
  const tempRoot = await mkdtemp(join(tmpdir(), "inspection-postpone-data-"));
  const snapshotDir = join(tempRoot, "data");
  await cp(dataDir, snapshotDir, { recursive: true, force: true });
  return { tempRoot, snapshotDir };
}

async function restoreDataDir(snapshot) {
  if (!snapshot) return;
  await rm(dataDir, { recursive: true, force: true });
  await cp(snapshot.snapshotDir, dataDir, { recursive: true, force: true });
  await rm(snapshot.tempRoot, { recursive: true, force: true });
}

function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.log(`  ❌ ${msg}`);
  }
}

async function createCylinder(token, id, inspectionDue, idemKey) {
  return request("POST", "/cylinders", {
    token,
    idemKey,
    body: { id, gasType: "高纯氩", capacity: "40L", inspectionDue: inspectionDue || "2026-07-01" },
  });
}

async function generateTasks(token, thresholdDays, idemKey) {
  return request("POST", "/inspection-tasks/generate", {
    token,
    idemKey,
    body: { thresholdDays: thresholdDays ?? 45 },
  });
}

async function postponeTask(token, taskId, { newInspectionDue, reason, operator, idemKey }) {
  return request("POST", `/inspection-tasks/${taskId}/postpone`, {
    token,
    idemKey,
    body: { newInspectionDue, reason, operator },
  });
}

async function sendTask(token, taskId, location, idemKey) {
  return request("POST", `/inspection-tasks/${taskId}/send`, {
    token,
    idemKey,
    body: { location: location || "送检中" },
  });
}

async function inspectTask(token, taskId, passed, idemKey) {
  return request("POST", `/inspection-tasks/${taskId}/inspect`, {
    token,
    idemKey,
    body: { passed, inspector: "测试员", nextInspectionDue: "2027-06-01" },
  });
}

async function restockTask(token, taskId, idemKey) {
  return request("POST", `/inspection-tasks/${taskId}/restock`, {
    token,
    idemKey,
    body: { location: "一号仓" },
  });
}

async function main() {
  const snapshot = await snapshotDataDir();
  try {
  const login = await request("POST", "/auth/login", {
    body: { username: "admin", password: "admin123" },
  });
  const token = login.body.token;
  console.log("✅ 管理员登录成功");

  const qcLogin = await request("POST", "/auth/login", {
    body: { username: "qc", password: "qc123" },
  });
  const qcToken = qcLogin.body.token;
  console.log("✅ 质检登录成功");

  const salesLogin = await request("POST", "/auth/login", {
    body: { username: "sales", password: "sales123" },
  });
  const salesToken = salesLogin.body.token;
  console.log("✅ 销售登录成功");

  const TS = Date.now();

  // ============================================================
  //  基础功能测试
  // ============================================================

  console.log("\n=== 测试 1: 创建测试钢瓶并生成检验任务 ===");
  const cyl1Id = `CY-PP-${TS}-1`;
  const cyl2Id = `CY-PP-${TS}-2`;
  const cyl3Id = `CY-PP-${TS}-3`;

  const c1 = await createCylinder(token, cyl1Id, "2026-07-01", `cyl-create-${TS}-1`);
  assert(c1.statusCode === 201, `创建钢瓶 ${cyl1Id} 成功`);
  const c2 = await createCylinder(token, cyl2Id, "2026-07-10", `cyl-create-${TS}-2`);
  assert(c2.statusCode === 201, `创建钢瓶 ${cyl2Id} 成功`);
  const c3 = await createCylinder(token, cyl3Id, "2026-08-01", `cyl-create-${TS}-3`);
  assert(c3.statusCode === 201, `创建钢瓶 ${cyl3Id} 成功`);

  const genResp = await generateTasks(token, 60, `gen-tasks-${TS}-1`);
  assert(genResp.statusCode === 201, "生成检验任务成功");
  assert(genResp.body.generated >= 2, `至少生成 2 个检验任务 (实际 ${genResp.body.generated})`);

  const tasks = genResp.body.tasks;
  const pendingTask = tasks.find(t => t.cylinderId === cyl1Id);
  assert(pendingTask, `找到钢瓶 ${cyl1Id} 的检验任务`);
  assert(pendingTask.status === "pending", "任务状态为 pending");

  console.log("\n=== 测试 2: 延期 pending 状态的任务 ===");
  const newDue = "2026-12-31";
  const postponeResp = await postponeTask(qcToken, pendingTask.id, {
    newInspectionDue: newDue,
    reason: "检验机构排期紧张",
    operator: "李质检",
    idemKey: `postpone-${TS}-1`
  });
  assert(postponeResp.statusCode === 200, `延期成功 (${postponeResp.statusCode})`);
  assert(postponeResp.body.task.inspectionDue === newDue, `任务到检日期更新为 ${newDue}`);
  assert(postponeResp.body.cylinder.inspectionDue === newDue, `钢瓶到检日期同步更新为 ${newDue}`);
  assert(Array.isArray(postponeResp.body.task.postponements), "任务有 postponements 字段");
  assert(postponeResp.body.task.postponements.length === 1, "延期历史有 1 条记录");

  const postponeRecord = postponeResp.body.task.postponements[0];
  assert(postponeRecord.oldInspectionDue === pendingTask.inspectionDue, "延期记录包含原日期");
  assert(postponeRecord.newInspectionDue === newDue, "延期记录包含新日期");
  assert(postponeRecord.reason === "检验机构排期紧张", "延期记录包含原因");
  assert(postponeRecord.operator === "李质检", "延期记录包含操作人");
  assert(postponeRecord.postponedAt, "延期记录包含时间");

  console.log("\n=== 测试 3: 验证钢瓶事件记录 ===");
  const cylDetail = await request("GET", `/cylinders/${cyl1Id}`, { token });
  const postponeEvents = cylDetail.body.events.filter(e => e.type === "inspect_postpone");
  assert(postponeEvents.length === 1, `钢瓶有 1 个 inspect_postpone 事件 (实际 ${postponeEvents.length})`);
  assert(postponeEvents[0].note.includes("检验延期"), "事件备注包含检验延期");
  assert(postponeEvents[0].note.includes(newDue), "事件备注包含新到检日期");

  console.log("\n=== 测试 4: 验证状态历史记录 ===");
  const taskDetail = await request("GET", `/inspection-tasks/${pendingTask.id}`, { token });
  assert(Array.isArray(taskDetail.body.statusHistory), "任务有 statusHistory 字段");
  assert(taskDetail.body.statusHistory.length >= 1, "状态历史至少有 1 条记录");
  assert(taskDetail.body.statusHistory[0].status === "pending", "状态历史记录状态正确");
  assert(taskDetail.body.statusHistory[0].note.includes("延期检验"), "状态历史备注包含延期检验");

  console.log("\n=== 测试 5: 验证操作日志 ===");
  const logsResp = await request("GET", `/operation-logs?operationType=inspection.postpone&targetId=${pendingTask.id}`, { token });
  assert(logsResp.body.items.length >= 1, "存在 inspection.postpone 类型操作日志");
  const opLog = logsResp.body.items[0];
  assert(opLog.operationType === "inspection.postpone", "操作类型正确");
  assert(opLog.targetType === "inspection_task", "目标类型正确");
  assert(opLog.targetId === pendingTask.id, "目标ID正确");
  assert(opLog.beforeState && opLog.afterState, "包含前后状态快照");
  assert(Array.isArray(opLog.eventIds) && opLog.eventIds.length >= 1, "关联了钢瓶事件ID");

  console.log("\n=== 测试 6: 多次延期 ===");
  const secondNewDue = "2027-02-28";
  const postpone2Resp = await postponeTask(qcToken, pendingTask.id, {
    newInspectionDue: secondNewDue,
    reason: "再次延期，设备维修",
    idemKey: `postpone-${TS}-2`
  });
  assert(postpone2Resp.statusCode === 200, "第二次延期成功");
  assert(postpone2Resp.body.task.inspectionDue === secondNewDue, "到检日期再次更新");
  assert(postpone2Resp.body.task.postponements.length === 2, "延期历史有 2 条记录");

  console.log("\n=== 测试 7: 延期 sent 状态的任务 ===");
  const sentTask = tasks.find(t => t.cylinderId === cyl2Id);
  assert(sentTask, `找到钢瓶 ${cyl2Id} 的检验任务`);

  const sendResp = await sendTask(qcToken, sentTask.id, "第三方检验机构", `send-${TS}-2`);
  assert(sendResp.statusCode === 200, "送检成功");
  assert(sendResp.body.task.status === "sent", "任务状态为 sent");

  const sentPostponeResp = await postponeTask(qcToken, sentTask.id, {
    newInspectionDue: "2026-11-15",
    reason: "检验进度延后",
    idemKey: `postpone-sent-${TS}`
  });
  assert(sentPostponeResp.statusCode === 200, "sent 状态任务可以延期");
  assert(sentPostponeResp.body.task.status === "sent", "延期后任务状态仍为 sent");
  assert(sentPostponeResp.body.task.inspectionDue === "2026-11-15", "到检日期已更新");

  // ============================================================
  //  校验规则测试
  // ============================================================

  console.log("\n=== 测试 8: 缺少 newInspectionDue 参数 ===");
  const bad1Resp = await postponeTask(qcToken, pendingTask.id, {
    reason: "缺日期测试",
    idemKey: `postpone-bad1-${TS}`
  });
  assert(bad1Resp.statusCode === 400, `缺少 newInspectionDue 返回 400 (实际 ${bad1Resp.statusCode})`);
  assert(bad1Resp.body.error === "newInspectionDue_required", "错误类型正确");

  console.log("\n=== 测试 9: 缺少 reason 参数 ===");
  const bad2Resp = await postponeTask(qcToken, pendingTask.id, {
    newInspectionDue: "2027-01-01",
    idemKey: `postpone-bad2-${TS}`
  });
  assert(bad2Resp.statusCode === 400, `缺少 reason 返回 400 (实际 ${bad2Resp.statusCode})`);
  assert(bad2Resp.body.error === "reason_required", "错误类型正确");

  console.log("\n=== 测试 10: 无效日期格式 ===");
  const bad3Resp = await postponeTask(qcToken, pendingTask.id, {
    newInspectionDue: "not-a-date",
    reason: "无效日期测试",
    idemKey: `postpone-bad3-${TS}`
  });
  assert(bad3Resp.statusCode === 400, `无效日期返回 400 (实际 ${bad3Resp.statusCode})`);
  assert(bad3Resp.body.error === "invalid_newInspectionDue", "错误类型正确");

  console.log("\n=== 测试 11: 空 reason ===");
  const bad4Resp = await postponeTask(qcToken, pendingTask.id, {
    newInspectionDue: "2027-01-01",
    reason: "   ",
    idemKey: `postpone-bad4-${TS}`
  });
  assert(bad4Resp.statusCode === 400, `空 reason 返回 400 (实际 ${bad4Resp.statusCode})`);

  console.log("\n=== 测试 12: 已通过的任务不能延期 ===");
  const passedTask = tasks.find(t => t.cylinderId === cyl3Id) || tasks[0];
  const sendResp2 = await sendTask(qcToken, passedTask.id, undefined, `send-${TS}-3`);
  assert(sendResp2.statusCode === 200, "送检成功");
  const inspectResp = await inspectTask(qcToken, passedTask.id, true, `inspect-${TS}-3`);
  assert(inspectResp.statusCode === 200, "检验合格");
  assert(inspectResp.body.task.status === "passed", "任务状态为 passed");

  const passedPostponeResp = await postponeTask(qcToken, passedTask.id, {
    newInspectionDue: "2027-06-01",
    reason: "测试已通过任务延期",
    idemKey: `postpone-passed-${TS}`
  });
  assert(passedPostponeResp.statusCode === 422, `passed 任务不能延期 (实际 ${passedPostponeResp.statusCode})`);
  assert(passedPostponeResp.body.error === "task_passed_cannot_postpone", "错误类型正确");

  console.log("\n=== 测试 13: 已回库的任务不能延期 ===");
  const restockResp = await restockTask(qcToken, passedTask.id, `restock-${TS}-3`);
  assert(restockResp.statusCode === 200, "回库成功");
  assert(restockResp.body.task.status === "restocked", "任务状态为 restocked");

  const restockPostponeResp = await postponeTask(qcToken, passedTask.id, {
    newInspectionDue: "2027-06-01",
    reason: "测试已回库任务延期",
    idemKey: `postpone-restocked-${TS}`
  });
  assert(restockPostponeResp.statusCode === 422, `restocked 任务不能延期 (实际 ${restockPostponeResp.statusCode})`);
  assert(restockPostponeResp.body.error === "task_restocked_cannot_postpone", "错误类型正确");

  console.log("\n=== 测试 14: 检验不合格（报废）的任务不能延期 ===");
  const cyl4Id = `CY-PP-${TS}-4`;
  await createCylinder(token, cyl4Id, "2026-06-30", `cyl-create-${TS}-4`);
  const gen2Resp = await generateTasks(token, 60, `gen-tasks-${TS}-2`);
  const failTask = gen2Resp.body.tasks.find(t => t.cylinderId === cyl4Id);
  assert(failTask, "找到报废测试任务");

  const sendFailResp = await sendTask(qcToken, failTask.id, undefined, `send-${TS}-4`);
  assert(sendFailResp.statusCode === 200, `报废测试任务送检成功 (实际 ${sendFailResp.statusCode})`);
  if (sendFailResp.statusCode !== 200) {
    console.log("  送检失败详情:", JSON.stringify(sendFailResp.body));
  }

  const failInspectResp = await inspectTask(qcToken, failTask.id, false, `inspect-${TS}-4`);
  assert(failInspectResp.statusCode === 200, `检验不合格成功 (实际 ${failInspectResp.statusCode})`);
  if (failInspectResp.statusCode !== 200) {
    console.log("  检验失败详情:", JSON.stringify(failInspectResp.body));
  }
  assert(failInspectResp.body.task?.status === "failed", "任务状态为 failed");
  assert(failInspectResp.body.cylinder?.status === "scrapped", "钢瓶已报废");

  const failedPostponeResp = await postponeTask(qcToken, failTask.id, {
    newInspectionDue: "2027-01-01",
    reason: "测试报废任务延期",
    idemKey: `postpone-failed-${TS}`
  });
  assert(failedPostponeResp.statusCode === 422, `failed 任务不能延期 (实际 ${failedPostponeResp.statusCode})`);
  assert(failedPostponeResp.body.error === "cylinder_scrapped_cannot_postpone", "报废钢瓶不能延期错误类型正确");

  console.log("\n=== 测试 15: 任务不存在 ===");
  const notFoundResp = await postponeTask(qcToken, "IT-NOTEXIST-12345", {
    newInspectionDue: "2027-01-01",
    reason: "测试不存在任务",
    idemKey: `postpone-notfound-${TS}`
  });
  assert(notFoundResp.statusCode === 404, `任务不存在返回 404 (实际 ${notFoundResp.statusCode})`);

  // ============================================================
  //  权限测试
  // ============================================================

  console.log("\n=== 测试 16: 销售角色无延期权限 ===");
  const salesPostponeResp = await postponeTask(salesToken, pendingTask.id, {
    newInspectionDue: "2027-01-01",
    reason: "销售尝试延期",
    idemKey: `postpone-sales-${TS}`
  });
  assert(salesPostponeResp.statusCode === 403, `销售角色无权限返回 403 (实际 ${salesPostponeResp.statusCode})`);

  // ============================================================
  //  幂等性测试
  // ============================================================

  console.log("\n=== 测试 17: 幂等性 - 重复请求不重复延期 ===");
  const cyl5Id = `CY-PP-${TS}-5`;
  await createCylinder(token, cyl5Id, "2026-07-05", `cyl-create-${TS}-5`);
  const gen3Resp = await generateTasks(token, 60, `gen-tasks-${TS}-3`);
  const idemTask = gen3Resp.body.tasks.find(t => t.cylinderId === cyl5Id);
  assert(idemTask, "找到幂等测试任务");

  const idemKey = `postpone-idem-${TS}`;
  const firstIdemResp = await postponeTask(qcToken, idemTask.id, {
    newInspectionDue: "2026-10-01",
    reason: "幂等测试延期",
    idemKey
  });
  assert(firstIdemResp.statusCode === 200, "首次延期成功");
  assert(!firstIdemResp.body._idempotent, "首次响应不包含 _idempotent 标记");

  const replayIdemResp = await postponeTask(qcToken, idemTask.id, {
    newInspectionDue: "2026-10-01",
    reason: "幂等测试延期",
    idemKey
  });
  assert(replayIdemResp.statusCode === 200, "重放请求状态码仍为 200");
  assert(replayIdemResp.body._idempotent === true, "重放响应包含 _idempotent: true");
  assert(replayIdemResp.headers["x-idempotent-replayed"] === "true", "重放响应包含 X-Idempotent-Replayed 头");

  const taskAfterReplay = await request("GET", `/inspection-tasks/${idemTask.id}`, { token });
  assert(taskAfterReplay.body.postponements.length === 1, `重放后延期历史仍为 1 条 (实际 ${taskAfterReplay.body.postponements.length})`);

  const cylAfterReplay = await request("GET", `/cylinders/${cyl5Id}`, { token });
  const postponeEventCount = cylAfterReplay.body.events.filter(e => e.type === "inspect_postpone").length;
  assert(postponeEventCount === 1, `重放后钢瓶 inspect_postpone 事件仍为 1 条 (实际 ${postponeEventCount})`);

  console.log("\n=== 测试 18: 幂等键冲突（同键不同请求体）===");
  const conflictKey = `postpone-conflict-${TS}`;
  const conflict1Resp = await postponeTask(qcToken, idemTask.id, {
    newInspectionDue: "2026-11-01",
    reason: "原始请求",
    idemKey: conflictKey
  });
  assert(conflict1Resp.statusCode === 200, "冲突测试首次请求成功");

  const conflict2Resp = await postponeTask(qcToken, idemTask.id, {
    newInspectionDue: "2026-12-01",
    reason: "不同请求体",
    idemKey: conflictKey
  });
  assert(conflict2Resp.statusCode === 422, `同键不同请求体返回 422 (实际 ${conflict2Resp.statusCode})`);
  assert(conflict2Resp.body.error === "idempotency_key_mismatch", "错误类型正确");

  // ============================================================
  //  端点列表验证
  // ============================================================

  console.log("\n=== 测试 19: 根端点列表包含延期检验接口 ===");
  const rootResp = await request("GET", "/", { token });
  const hasPostponeEndpoint = rootResp.body.endpoints?.includes("POST /inspection-tasks/:id/postpone");
  assert(hasPostponeEndpoint, "根端点列表包含 POST /inspection-tasks/:id/postpone");

  console.log("\n=== 测试 20: 操作类型列表包含延期检验 ===");
  const opTypesResp = await request("GET", "/operation-logs/types", { token });
  const hasPostponeOpType = opTypesResp.body.operationTypes?.includes("inspection.postpone");
  assert(hasPostponeOpType, "操作类型列表包含 inspection.postpone");

  console.log("\n" + "=".repeat(50));
  console.log(`测试结果: 通过 ${pass} / 失败 ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    throw new Error(`${fail} assertions failed`);
  }
  } finally {
    await restoreDataDir(snapshot);
  }
}

main().catch((err) => {
  console.error("测试执行出错:", err);
  process.exit(1);
});
