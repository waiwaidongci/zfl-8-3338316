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
  const tempRoot = await mkdtemp(join(tmpdir(), "order-return-data-"));
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

async function createCylinder(token, id) {
  return request("POST", "/cylinders", {
    token,
    body: { id, gasType: "高纯氩", capacity: "40L", inspectionDue: "2027-06-01" },
  });
}

async function createOrder(token, { customerId, cylinderIds, note, idemKey }) {
  return request("POST", "/rental-orders", {
    token,
    idemKey,
    body: {
      customerId,
      cylinders: cylinderIds.map((id) => ({ id, depositStatus: "paid" })),
      note: note || "",
    },
  });
}

async function returnOrder(token, orderId, { cylinderIds, returnLocation, depositRefunded, note, idemKey }) {
  return request("POST", `/rental-orders/${orderId}/return`, {
    token,
    idemKey,
    body: { cylinderIds, returnLocation, depositRefunded, note },
  });
}

async function main() {
  const snapshot = await snapshotDataDir();
  try {
  const login = await request("POST", "/auth/login", {
    body: { username: "admin", password: "admin123" },
  });
  const token = login.body.token;
  console.log("✅ 登录成功");

  const TS = Date.now();
  const CUSTOMER_ID = "CUS-001";

  // ============================================================
  //  基础功能测试
  // ============================================================

  console.log("\n=== 测试 1: 创建测试钢瓶 ===");
  const cyl1Id = `CY-RT-${TS}-1`;
  const cyl2Id = `CY-RT-${TS}-2`;
  const cyl3Id = `CY-RT-${TS}-3`;

  for (const id of [cyl1Id, cyl2Id, cyl3Id]) {
    const r = await createCylinder(token, id);
    assert(r.statusCode === 201, `创建钢瓶 ${id} 成功 (${r.statusCode})`);
  }

  console.log("\n=== 测试 2: 创建租瓶订单 ===");
  const createOrderResp = await createOrder(token, {
    customerId: CUSTOMER_ID,
    cylinderIds: [cyl1Id, cyl2Id, cyl3Id],
    note: "订单归还测试",
    idemKey: `order-create-${TS}`,
  });
  assert(createOrderResp.statusCode === 201, `创建订单成功 (${createOrderResp.statusCode})`);
  const orderId = createOrderResp.body.id;
  assert(orderId, "订单 ID 存在");
  assert(createOrderResp.body.status === "completed", "订单初始状态为 completed");
  assert(createOrderResp.body.returnedCount === 0, "初始归还数为 0");
  assert(Array.isArray(createOrderResp.body.returnHistory), "returnHistory 字段存在");

  console.log("\n=== 测试 3: 验证钢瓶状态已更新为 rented ===");
  for (const id of [cyl1Id, cyl2Id, cyl3Id]) {
    const r = await request("GET", `/cylinders/${id}`, { token });
    assert(r.body.status === "rented", `钢瓶 ${id} 状态为 rented`);
  }

  console.log("\n=== 测试 4: 部分归还（归还 2 个钢瓶）===");
  const partialReturnResp = await returnOrder(token, orderId, {
    cylinderIds: [cyl1Id, cyl2Id],
    returnLocation: "待检区",
    depositRefunded: false,
    note: "部分归还测试",
    idemKey: `order-return-${TS}-partial`,
  });
  assert(partialReturnResp.statusCode === 200, `部分归还成功 (${partialReturnResp.statusCode})`);
  assert(partialReturnResp.body.orderStatus === "partially_returned", "订单状态为 partially_returned");
  assert(partialReturnResp.body.returnedCount === 2, "已归还 2 个钢瓶");
  assert(partialReturnResp.body.totalCylinders === 3, "订单总钢瓶数为 3");
  assert(partialReturnResp.body.returnedCylinders.length === 2, "归还明细包含 2 个钢瓶");
  assert(partialReturnResp.body.returnRecord, "存在归还记录");

  console.log("\n=== 测试 5: 验证已归还钢瓶状态 ===");
  const c1 = await request("GET", `/cylinders/${cyl1Id}`, { token });
  assert(c1.body.status === "returned", `钢瓶 ${cyl1Id} 状态为 returned`);
  assert(c1.body.location === "待检区", `钢瓶 ${cyl1Id} 库位为待检区`);
  assert(c1.body.depositStatus === "refundable", `钢瓶 ${cyl1Id} 押金状态为 refundable`);
  assert(c1.body.customer === null, `钢瓶 ${cyl1Id} 客户已清空`);

  const c2 = await request("GET", `/cylinders/${cyl2Id}`, { token });
  assert(c2.body.status === "returned", `钢瓶 ${cyl2Id} 状态为 returned`);

  const c3 = await request("GET", `/cylinders/${cyl3Id}`, { token });
  assert(c3.body.status === "rented", `钢瓶 ${cyl3Id} 仍为 rented`);

  console.log("\n=== 测试 6: 验证订单详情中的归还信息 ===");
  const orderDetail = await request("GET", `/rental-orders/${orderId}`, { token });
  const oc1 = orderDetail.body.cylinders.find((c) => c.id === cyl1Id);
  assert(oc1?.returned === true, `订单中钢瓶 ${cyl1Id} 标记为已归还`);
  assert(oc1?.returnedAt, `订单中钢瓶 ${cyl1Id} 有归还时间`);
  assert(oc1?.returnNote === "部分归还测试", `订单中钢瓶 ${cyl1Id} 有归还备注`);
  const oc3 = orderDetail.body.cylinders.find((c) => c.id === cyl3Id);
  assert(oc3?.returned === false, `订单中钢瓶 ${cyl3Id} 标记为未归还`);
  assert(orderDetail.body.returnHistory.length >= 1, "订单归还历史有记录");

  console.log("\n=== 测试 7: 重复归还同一钢瓶应该失败 ===");
  const dupReturnResp = await returnOrder(token, orderId, {
    cylinderIds: [cyl1Id, cyl3Id],
    idemKey: `order-return-${TS}-dup`,
  });
  assert(dupReturnResp.statusCode === 207, `重复归还部分成功返回 207 (${dupReturnResp.statusCode})`);
  assert(dupReturnResp.body.errors?.length === 1, "有 1 个错误（已归还的钢瓶）");
  assert(dupReturnResp.body.returnedCylinders.length === 1, "成功归还 1 个新钢瓶");
  assert(dupReturnResp.body.returnedCount === 3, "累计已归还 3 个钢瓶");

  console.log("\n=== 测试 8: 全部归还后订单状态 ===");
  const orderDetail2 = await request("GET", `/rental-orders/${orderId}`, { token });
  assert(orderDetail2.body.status === "fully_returned", "订单状态为 fully_returned");
  assert(orderDetail2.body.returnedCount === 3, "全部 3 个钢瓶已归还");

  console.log("\n=== 测试 9: 订单不存在的情况 ===");
  const notFoundResp = await returnOrder(token, "RO-NOTEXIST-123", {
    cylinderIds: [cyl1Id],
    idemKey: `order-return-${TS}-notfound`,
  });
  assert(notFoundResp.statusCode === 404, `订单不存在返回 404 (${notFoundResp.statusCode})`);

  console.log("\n=== 测试 10: 参数校验 - 空 cylinderIds ===");
  const badInputResp = await returnOrder(token, orderId, {
    cylinderIds: [],
    idemKey: `order-return-${TS}-badinput`,
  });
  assert(badInputResp.statusCode === 400, `空 cylinderIds 返回 400 (${badInputResp.statusCode})`);

  console.log("\n=== 测试 11: 非订单内钢瓶 ===");
  const cylForOrder2 = `CY-RT-${TS}-4`;
  await createCylinder(token, cylForOrder2);
  const externalCylResp = await createOrder(token, {
    customerId: CUSTOMER_ID,
    cylinderIds: [cylForOrder2],
    note: "测试订单2",
    idemKey: `order-create-${TS}-2`,
  });
  const order2Id = externalCylResp.body.id;
  const notInOrderResp = await returnOrder(token, order2Id, {
    cylinderIds: ["CY-NOT-IN-ORDER-123"],
    idemKey: `order-return-${TS}-notinorder`,
  });
  assert(notInOrderResp.statusCode === 422, `非订单内钢瓶返回 422 (${notInOrderResp.statusCode})`);

  // ============================================================
  //  幂等性专项测试
  // ============================================================

  console.log("\n" + "=".repeat(50));
  console.log("  幂等性专项测试");
  console.log("=".repeat(50));

  // ---- 12: 首次成功归还 → 重放响应一致性 ----
  console.log("\n=== 测试 12: 首次归还成功 → 显式幂等键重放响应一致 ===");
  const idemCyl1 = `CY-IDEM-${TS}-1`;
  const idemCyl2 = `CY-IDEM-${TS}-2`;
  await createCylinder(token, idemCyl1);
  await createCylinder(token, idemCyl2);
  const idemOrderResp = await createOrder(token, {
    customerId: CUSTOMER_ID,
    cylinderIds: [idemCyl1, idemCyl2],
    note: "幂等专项测试订单",
    idemKey: `idem-order-create-${TS}`,
  });
  const idemOrderId = idemOrderResp.body.id;

  const firstKey = `idem-return-first-${TS}`;
  const firstResp = await returnOrder(token, idemOrderId, {
    cylinderIds: [idemCyl1],
    returnLocation: "核验库位",
    depositRefunded: true,
    note: "成功请求重复核验",
    idemKey: firstKey,
  });
  assert(firstResp.statusCode === 200, `首次归还成功 (${firstResp.statusCode})`);
  assert(!firstResp.body._idempotent, "首次响应不包含 _idempotent 标记");
  assert(firstResp.headers["x-idempotent-replayed"] === undefined, "首次响应无 X-Idempotent-Replayed 头");
  assert(firstResp.headers["x-idempotency-key"] === firstKey, "首次响应包含幂等键头");

  const replayResp = await returnOrder(token, idemOrderId, {
    cylinderIds: [idemCyl1],
    returnLocation: "核验库位",
    depositRefunded: true,
    note: "成功请求重复核验",
    idemKey: firstKey,
  });
  assert(replayResp.statusCode === 200, `重放响应状态码仍为 200 (${replayResp.statusCode})`);
  assert(replayResp.body._idempotent === true, "重放响应包含 _idempotent: true");
  assert(replayResp.headers["x-idempotent-replayed"] === "true", "重放响应包含 X-Idempotent-Replayed: true 头");
  assert(replayResp.body.idempotencyKey === firstKey, "重放响应幂等键一致");
  assert(replayResp.body.orderId === firstResp.body.orderId, "重放响应 orderId 一致");
  assert(replayResp.body.orderStatus === firstResp.body.orderStatus, "重放响应 orderStatus 一致");
  assert(replayResp.body.returnedCount === firstResp.body.returnedCount, "重放响应 returnedCount 一致");

  // ---- 13: 重放后操作日志不重复 ----
  console.log("\n=== 测试 13: 重放后操作日志不重复 ===");
  const logsBefore = await request("GET", `/operation-logs?operationType=order.return&targetId=${idemOrderId}`, { token });
  const logCountBefore = logsBefore.body.items.filter((l) => l.idempotencyKey === firstKey).length;
  assert(logCountBefore === 1, `重放前幂等键 ${firstKey} 对应操作日志仅 1 条 (实际 ${logCountBefore})`);

  // ---- 14: 重放后订单 returnHistory 不增长 ----
  console.log("\n=== 测试 14: 重放后订单 returnHistory 不增长 ===");
  const orderAfterReplay = await request("GET", `/rental-orders/${idemOrderId}`, { token });
  const returnRecordsForCyl1 = orderAfterReplay.body.returnHistory.filter(
    (rh) => rh.cylinders.some((c) => c.id === idemCyl1)
  );
  assert(returnRecordsForCyl1.length === 1, `钢瓶 ${idemCyl1} 在 returnHistory 中仅 1 条归还记录 (实际 ${returnRecordsForCyl1.length})`);

  // ---- 15: 重放后钢瓶事件不重复 ----
  console.log("\n=== 测试 15: 重放后钢瓶事件不重复 ===");
  const cyl1AfterReplay = await request("GET", `/cylinders/${idemCyl1}`, { token });
  const returnEventCount = cyl1AfterReplay.body.events.filter((e) => e.type === "return").length;
  assert(returnEventCount === 1, `钢瓶 ${idemCyl1} return 事件仅 1 条 (实际 ${returnEventCount})`);

  // ---- 16: 422 幂等键冲突（同键不同请求体） ----
  console.log("\n=== 测试 16: 422 幂等键冲突（同键不同请求体）===");
  const conflictKey = `idem-return-conflict-${TS}`;
  const conflictResp1 = await returnOrder(token, idemOrderId, {
    cylinderIds: [idemCyl2],
    returnLocation: "待检区",
    note: "原始请求",
    idemKey: conflictKey,
  });
  assert(conflictResp1.statusCode === 200, `冲突测试首次请求成功 (${conflictResp1.statusCode})`);

  const conflictResp2 = await returnOrder(token, idemOrderId, {
    cylinderIds: [idemCyl2],
    returnLocation: "不同库位",
    note: "不同请求体",
    idemKey: conflictKey,
  });
  assert(conflictResp2.statusCode === 422, `同键不同请求体返回 422 (${conflictResp2.statusCode})`);
  assert(conflictResp2.body.error === "idempotency_key_mismatch", "错误类型为 idempotency_key_mismatch");

  // ---- 17: 自动幂等键（不传 Idempotency-Key 头） ----
  console.log("\n=== 测试 17: 自动幂等键（不传 Idempotency-Key）===");
  const autoCyl1 = `CY-AUTO-${TS}-1`;
  const autoCyl2 = `CY-AUTO-${TS}-2`;
  await createCylinder(token, autoCyl1);
  await createCylinder(token, autoCyl2);
  const autoOrderResp = await createOrder(token, {
    customerId: CUSTOMER_ID,
    cylinderIds: [autoCyl1, autoCyl2],
    note: "自动幂等键测试",
    idemKey: `auto-order-create-${TS}`,
  });
  const autoOrderId = autoOrderResp.body.id;

  const autoFirstResp = await returnOrder(token, autoOrderId, {
    cylinderIds: [autoCyl1],
    returnLocation: "自动键库位",
    note: "自动幂等键归还",
  });
  assert(autoFirstResp.statusCode === 200, `自动键首次归还成功 (${autoFirstResp.statusCode})`);
  assert(autoFirstResp.headers["x-idempotency-key-auto"] === "true", "自动键响应包含 X-Idempotency-Key-Auto: true 头");
  assert(!!autoFirstResp.headers["x-idempotency-key"], "自动键响应包含 X-Idempotency-Key 头");
  const autoKey = autoFirstResp.headers["x-idempotency-key"];

  const autoReplayResp = await returnOrder(token, autoOrderId, {
    cylinderIds: [autoCyl1],
    returnLocation: "自动键库位",
    note: "自动幂等键归还",
  });
  assert(autoReplayResp.statusCode === 200, `自动键重放响应 200 (${autoReplayResp.statusCode})`);
  assert(autoReplayResp.headers["x-idempotent-replayed"] === "true", "自动键重放标记 X-Idempotent-Replayed");
  assert(autoReplayResp.headers["x-idempotency-key"] === autoKey, "自动键重放幂等键与首次一致");
  assert(autoReplayResp.body._idempotent === true, "自动键重放包含 _idempotent: true");

  // ---- 18: 自动幂等键下操作日志仍不重复 ----
  console.log("\n=== 测试 18: 自动幂等键下操作日志不重复 ===");
  const autoLogsResp = await request("GET", `/operation-logs?operationType=order.return&targetId=${autoOrderId}`, { token });
  const autoLogCount = autoLogsResp.body.items.filter((l) => l.idempotencyKey === autoKey).length;
  assert(autoLogCount === 1, `自动键操作日志仅 1 条 (实际 ${autoLogCount})`);

  // ---- 19: 自动幂等键下钢瓶事件不重复 ----
  console.log("\n=== 测试 19: 自动幂等键下钢瓶事件不重复 ===");
  const autoCyl1After = await request("GET", `/cylinders/${autoCyl1}`, { token });
  const autoReturnEvents = autoCyl1After.body.events.filter((e) => e.type === "return").length;
  assert(autoReturnEvents === 1, `自动键钢瓶 ${autoCyl1} return 事件仅 1 条 (实际 ${autoReturnEvents})`);

  // ---- 20: 押金退还标记正确性 ----
  console.log("\n=== 测试 20: depositRefunded=true 时押金状态为 refunded ===");
  const cyl1Detail = await request("GET", `/cylinders/${idemCyl1}`, { token });
  assert(cyl1Detail.body.depositStatus === "refunded", `depositRefunded=true 归还后钢瓶押金状态为 refunded (实际 ${cyl1Detail.body.depositStatus})`);

  const cyl2Detail = await request("GET", `/cylinders/${idemCyl2}`, { token });
  assert(cyl2Detail.body.depositStatus === "refundable", `depositRefunded 未传时钢瓶押金状态为 refundable (实际 ${cyl2Detail.body.depositStatus})`);

  // ---- 21: 操作日志完整性 ----
  console.log("\n=== 测试 21: 操作日志完整性 ===");
  const logsResp = await request("GET", `/operation-logs?operationType=order.return`, { token });
  const relatedLogs = logsResp.body.items.filter((l) => l.targetId === orderId || l.targetId === idemOrderId);
  assert(relatedLogs.length >= 2, `存在至少 2 条 order.return 类型操作日志 (实际 ${relatedLogs.length})`);
  const allHaveCorrectType = relatedLogs.every((l) => l.operationType === "order.return" && l.targetType === "order");
  assert(allHaveCorrectType, "所有日志操作类型和目标类型正确");
  const hasEventIds = relatedLogs.some((l) => Array.isArray(l.eventIds) && l.eventIds.length >= 1);
  assert(hasEventIds, "至少有一条日志关联了钢瓶事件 ID");

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
