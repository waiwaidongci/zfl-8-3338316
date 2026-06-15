import http from "node:http";

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, "http://localhost:3008");
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

function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.log(`  ❌ ${msg}`);
  }
}

async function main() {
  const login = await request("POST", "/auth/login", {
    body: { username: "admin", password: "admin123" },
  });
  const token = login.body.token;
  console.log("✅ 登录成功");

  const TS = Date.now();
  const CUSTOMER_ID = "CUS-001";

  console.log("\n=== 测试 1: 创建测试钢瓶 ===");
  const cyl1Id = `CY-RT-${TS}-1`;
  const cyl2Id = `CY-RT-${TS}-2`;
  const cyl3Id = `CY-RT-${TS}-3`;

  for (const id of [cyl1Id, cyl2Id, cyl3Id]) {
    const r = await request("POST", "/cylinders", {
      token,
      body: { id, gasType: "高纯氩", capacity: "40L", inspectionDue: "2027-06-01" },
    });
    assert(r.statusCode === 201, `创建钢瓶 ${id} 成功 (${r.statusCode})`);
  }

  console.log("\n=== 测试 2: 创建租瓶订单 ===");
  const createOrderResp = await request("POST", "/rental-orders", {
    token,
    idemKey: `order-create-${TS}`,
    body: {
      customerId: CUSTOMER_ID,
      cylinders: [
        { id: cyl1Id, depositStatus: "paid" },
        { id: cyl2Id, depositStatus: "paid" },
        { id: cyl3Id, depositStatus: "paid" },
      ],
      note: "订单归还测试",
    },
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
    assert(r.body.customer === "宁川检测" || r.body.customer === CUSTOMER_ID, `钢瓶 ${id} 客户正确`);
  }

  console.log("\n=== 测试 4: 部分归还（归还 2 个钢瓶）===");
  const partialReturnResp = await request("POST", `/rental-orders/${orderId}/return`, {
    token,
    idemKey: `order-return-${TS}-partial`,
    body: {
      cylinderIds: [cyl1Id, cyl2Id],
      returnLocation: "待检区",
      depositRefunded: false,
      note: "部分归还测试",
    },
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
  const dupReturnResp = await request("POST", `/rental-orders/${orderId}/return`, {
    token,
    idemKey: `order-return-${TS}-dup`,
    body: {
      cylinderIds: [cyl1Id, cyl3Id],
    },
  });
  assert(dupReturnResp.statusCode === 207, `重复归还部分成功返回 207 (${dupReturnResp.statusCode})`);
  assert(dupReturnResp.body.errors?.length === 1, "有 1 个错误（已归还的钢瓶）");
  assert(dupReturnResp.body.returnedCylinders.length === 1, "成功归还 1 个新钢瓶");
  assert(dupReturnResp.body.returnedCount === 3, "累计已归还 3 个钢瓶");

  console.log("\n=== 测试 8: 全部归还后订单状态 ===");
  const orderDetail2 = await request("GET", `/rental-orders/${orderId}`, { token });
  assert(orderDetail2.body.status === "fully_returned", "订单状态为 fully_returned");
  assert(orderDetail2.body.returnedCount === 3, "全部 3 个钢瓶已归还");

  console.log("\n=== 测试 9: 幂等性验证 - 相同 Idempotency-Key 重复请求 ===");
  const idemKey = `order-return-${TS}-idem-test`;
  const idemResp1 = await request("POST", `/rental-orders/${orderId}/return`, {
    token,
    idemKey,
    body: {
      cylinderIds: [cyl3Id],
      note: "幂等测试",
    },
  });
  const idemResp2 = await request("POST", `/rental-orders/${orderId}/return`, {
    token,
    idemKey,
    body: {
      cylinderIds: [cyl3Id],
      note: "幂等测试",
    },
  });
  assert(idemResp2.headers["x-idempotent-replayed"] === "true", "第二次请求标记为重放");
  assert(idemResp2.body._idempotent === true, "响应体包含 _idempotent 标记");
  assert(idemResp2.body.idempotencyKey === idemKey, "幂等键一致");

  console.log("\n=== 测试 10: 验证钢瓶事件数量（幂等不应重复添加事件）===");
  const c3AfterIdem = await request("GET", `/cylinders/${cyl3Id}`, { token });
  const returnEvents = c3AfterIdem.body.events.filter((e) => e.type === "return");
  assert(returnEvents.length === 1, `钢瓶 ${cyl3Id} 只有 1 个 return 事件（幂等生效）`);

  console.log("\n=== 测试 11: 订单不存在的情况 ===");
  const notFoundResp = await request("POST", "/rental-orders/RO-NOTEXIST-123/return", {
    token,
    idemKey: `order-return-${TS}-notfound`,
    body: { cylinderIds: [cyl1Id] },
  });
  assert(notFoundResp.statusCode === 404, `订单不存在返回 404 (${notFoundResp.statusCode})`);

  console.log("\n=== 测试 12: 参数校验 - 空 cylinderIds ===");
  const badInputResp = await request("POST", `/rental-orders/${orderId}/return`, {
    token,
    idemKey: `order-return-${TS}-badinput`,
    body: { cylinderIds: [] },
  });
  assert(badInputResp.statusCode === 400, `空 cylinderIds 返回 400 (${badInputResp.statusCode})`);

  console.log("\n=== 测试 13: 非订单内钢瓶 ===");
  const cylForOrder2 = `CY-RT-${TS}-4`;
  await request("POST", "/cylinders", {
    token,
    body: { id: cylForOrder2, gasType: "高纯氩", capacity: "40L", inspectionDue: "2027-06-01" },
  });
  const externalCylResp = await request("POST", "/rental-orders", {
    token,
    idemKey: `order-create-${TS}-2`,
    body: {
      customerId: CUSTOMER_ID,
      cylinders: [{ id: cylForOrder2 }],
      note: "测试订单2",
    },
  });
  const order2Id = externalCylResp.body.id;
  const notInOrderResp = await request("POST", `/rental-orders/${order2Id}/return`, {
    token,
    idemKey: `order-return-${TS}-notinorder`,
    body: { cylinderIds: ["CY-NOT-IN-ORDER-123"] },
  });
  assert(notInOrderResp.statusCode === 422, `非订单内钢瓶返回 422 (${notInOrderResp.statusCode})`);

  console.log("\n=== 测试 14: 操作日志记录 ===");
  const logsResp = await request("GET", `/operation-logs?operationType=order.return`, { token });
  const relatedLogs = logsResp.body.items.filter((l) => l.targetId === orderId);
  assert(relatedLogs.length >= 1, "存在 order.return 类型操作日志");
  const latestReturnLog = relatedLogs[0];
  assert(latestReturnLog.operationType === "order.return", "操作类型正确");
  assert(latestReturnLog.targetType === "order", "目标类型正确");
  const hasEventIds = relatedLogs.some((l) => Array.isArray(l.eventIds) && l.eventIds.length >= 1);
  assert(hasEventIds, "至少有一条日志关联了钢瓶事件 ID");

  console.log("\n" + "=".repeat(50));
  console.log(`测试结果: 通过 ${pass} / 失败 ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("测试执行出错:", err);
  process.exit(1);
});
