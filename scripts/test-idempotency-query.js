import http from "node:http";

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

async function main() {
  const adminLogin = await request("POST", "/auth/login", {
    body: { username: "admin", password: "admin123" },
  });
  const adminToken = adminLogin.body.token;
  assert(adminToken, "管理员登录成功");

  const whLogin = await request("POST", "/auth/login", {
    body: { username: "warehouse", password: "warehouse123" },
  });
  const whToken = whLogin.body.token;
  assert(whToken, "仓库登录成功");

  const salesLogin = await request("POST", "/auth/login", {
    body: { username: "sales", password: "sales123" },
  });
  const salesToken = salesLogin.body.token;
  assert(salesToken, "销售登录成功");

  const qcLogin = await request("POST", "/auth/login", {
    body: { username: "qc", password: "qc123" },
  });
  const qcToken = qcLogin.body.token;
  assert(qcToken, "质检登录成功");

  console.log("\n=== 测试 1: 无认证访问返回 401 ===");
  const noAuth = await request("GET", "/idempotency-records");
  assert(noAuth.statusCode === 401, `无Token返回401 (${noAuth.statusCode})`);

  console.log("\n=== 测试 2: 非 admin 角色访问返回 403 ===");
  const whAccess = await request("GET", "/idempotency-records", { token: whToken });
  assert(whAccess.statusCode === 403, `warehouse返回403 (${whAccess.statusCode})`);
  assert(whAccess.body.error === "permission_denied", "错误类型为 permission_denied");

  const salesAccess = await request("GET", "/idempotency-records", { token: salesToken });
  assert(salesAccess.statusCode === 403, `sales返回403 (${salesAccess.statusCode})`);

  const qcAccess = await request("GET", "/idempotency-records", { token: qcToken });
  assert(qcAccess.statusCode === 403, `qc返回403 (${qcAccess.statusCode})`);

  console.log("\n=== 测试 3: admin 可正常访问 ===");
  const adminAccess = await request("GET", "/idempotency-records", { token: adminToken });
  assert(adminAccess.statusCode === 200, `admin返回200 (${adminAccess.statusCode})`);
  assert(Array.isArray(adminAccess.body.items), "items 是数组");
  assert(adminAccess.body.pagination, "包含 pagination 对象");

  console.log("\n=== 测试 4: 先创建一条写操作产生幂等记录 ===");
  const ts = Date.now();
  const cylinderRes = await request("POST", "/cylinders", {
    token: adminToken,
    headers: { "Idempotency-Key": `test-idem-query-${ts}` },
    body: { gasType: "高纯氩", capacity: "40L", location: "一号仓" },
  });
  assert([200, 201, 400].includes(cylinderRes.statusCode), `创建钢瓶请求完成 (${cylinderRes.statusCode})`);
  const idemKey1 = cylinderRes.body.idempotencyKey || `test-idem-query-${ts}`;
  assert(cylinderRes.body.idempotencyKey || cylinderRes.body.error, "响应包含幂等键或错误信息");
  assert(cylinderRes.body.operationLogId, `响应包含 operationLogId: ${cylinderRes.body.operationLogId}`);

  console.log("\n=== 测试 5: 查询幂等记录 - 按 key 精确匹配 ===");
  const queryByKey = await request("GET", `/idempotency-records?key=${idemKey1}`, { token: adminToken });
  assert(queryByKey.statusCode === 200, `按键查询成功 (${queryByKey.statusCode})`);
  assert(queryByKey.body.items.length >= 1, `至少1条记录 (实际 ${queryByKey.body.items.length})`);
  const record = queryByKey.body.items.find((r) => r.key === idemKey1);
  assert(record, "找到对应幂等记录");
  if (record) {
    assert(record.method === "POST", `method 为 POST (${record.method})`);
    assert(record.path === "/cylinders", `path 为 /cylinders (${record.path})`);
    assert(record.status === "completed", `status 为 completed (${record.status})`);
    assert(record.operator === "admin", `operator 为 admin (${record.operator})`);
    assert(record.operationLogId, `包含 operationLogId: ${record.operationLogId}`);
    assert(record.operationLog, "包含关联的 operationLog 对象");
    if (record.operationLog) {
      assert(record.operationLog.operationType === "cylinder.create", `operationType 正确 (${record.operationLog.operationType})`);
      assert(record.operationLog.requestBody !== null, "operationLog 包含 requestBody");
    }
  }

  console.log("\n=== 测试 6: 按 operator 过滤 ===");
  const queryByOp = await request("GET", "/idempotency-records?operator=admin", { token: adminToken });
  assert(queryByOp.statusCode === 200, `按操作人查询成功`);
  const allAdmin = queryByOp.body.items.every((r) => r.operator && r.operator.toLowerCase().includes("admin"));
  assert(allAdmin, "所有记录的 operator 包含 admin");

  console.log("\n=== 测试 7: 按 status 过滤 ===");
  const queryByStatus = await request("GET", "/idempotency-records?status=completed", { token: adminToken });
  assert(queryByStatus.statusCode === 200, `按状态查询成功`);
  const allCompleted = queryByStatus.body.items.every((r) => r.status === "completed");
  assert(allCompleted, "所有记录的 status 为 completed");

  console.log("\n=== 测试 8: 按 path 过滤 ===");
  const queryByPath = await request("GET", "/idempotency-records?path=/cylinders", { token: adminToken });
  assert(queryByPath.statusCode === 200, `按路径查询成功`);
  const allCyl = queryByPath.body.items.every((r) => r.path && r.path.toLowerCase().includes("/cylinders"));
  assert(allCyl, "所有记录的 path 包含 /cylinders");

  console.log("\n=== 测试 9: 无效 status 返回 400 ===");
  const invalidStatus = await request("GET", "/idempotency-records?status=invalid", { token: adminToken });
  assert(invalidStatus.statusCode === 400, `无效状态返回400 (${invalidStatus.statusCode})`);
  assert(invalidStatus.body.error === "invalid_status", "错误类型为 invalid_status");

  console.log("\n=== 测试 10: 分页参数 ===");
  const page1 = await request("GET", "/idempotency-records?page=1&pageSize=1", { token: adminToken });
  assert(page1.statusCode === 200, "分页查询成功");
  assert(page1.body.items.length <= 1, "每页最多1条");
  assert(page1.body.pagination.page === 1, "page 为 1");
  assert(page1.body.pagination.pageSize === 1, "pageSize 为 1");

  console.log("\n=== 测试 11: 时间范围过滤 ===");
  const now = new Date().toISOString();
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const queryFuture = await request("GET", `/idempotency-records?startAt=${farFuture}`, { token: adminToken });
  assert(queryFuture.statusCode === 200, "时间范围查询成功");
  assert(queryFuture.body.items.length === 0, "未来时间范围无记录");

  const queryPast = await request("GET", `/idempotency-records?endAt=${now}`, { token: adminToken });
  assert(queryPast.statusCode === 200, "截止时间查询成功");

  console.log("\n=== 测试 12: 敏感字段脱敏 ===");
  const ts2 = Date.now();
  const sensitiveRes = await request("POST", "/cylinders", {
    token: adminToken,
    headers: { "Idempotency-Key": `test-idem-sensitive-${ts2}` },
    body: { gasType: "混合标准气", capacity: "8L", location: "二号仓", secret: "my-secret-value", password: "should-be-hidden" },
  });
  const idemKey2 = sensitiveRes.body.idempotencyKey || `test-idem-sensitive-${ts2}`;
  assert([200, 201, 400].includes(sensitiveRes.statusCode), "创建含敏感字段钢瓶请求完成");

  const sensitiveQuery = await request("GET", `/idempotency-records?key=${idemKey2}`, { token: adminToken });
  assert(sensitiveQuery.statusCode === 200, "查询含敏感字段的记录成功");
  const sensitiveRecord = sensitiveQuery.body.items.find((r) => r.key === idemKey2);
  assert(sensitiveRecord, "找到含敏感字段的记录");
  if (sensitiveRecord && sensitiveRecord.operationLog && sensitiveRecord.operationLog.requestBody) {
    const reqBody = sensitiveRecord.operationLog.requestBody;
    assert(reqBody.secret === "******", `secret 字段已脱敏 (${reqBody.secret})`);
    assert(reqBody.password === "******", `password 字段已脱敏 (${reqBody.password})`);
    assert(reqBody.gasType !== "******", `gasType 未被脱敏 (${reqBody.gasType})`);
  }

  console.log("\n=== 测试 13: 根端点包含新接口 ===");
  const root = await request("GET", "/");
  assert(root.body.endpoints?.includes("GET /idempotency-records"), "根端点列表包含 GET /idempotency-records");
  assert(root.body.features?.idempotencyRecords?.enabled === true, "features.idempotencyRecords.enabled 为 true");
  assert(root.body.features?.idempotencyRecords?.permission === "idempotency:query", "features.idempotencyRecords.permission 正确");
  assert(Array.isArray(root.body.features?.idempotencyRecords?.roles), "features.idempotencyRecords.roles 是数组");
  assert(root.body.features?.idempotencyRecords?.roles.includes("admin"), "roles 包含 admin");

  console.log("\n=== 测试 14: operationLogId 关联正确 ===");
  const detailQuery = await request("GET", `/idempotency-records?key=${idemKey1}`, { token: adminToken });
  const detailRecord = detailQuery.body.items.find((r) => r.key === idemKey1);
  if (detailRecord && detailRecord.operationLog) {
    assert(detailRecord.operationLogId === detailRecord.operationLog.id, `operationLogId 与 operationLog.id 一致`);
    assert(detailRecord.operationLog.targetType === "cylinder", `targetType 为 cylinder`);
  }

  console.log("\n=== 测试 15: 权限矩阵包含新权限 ===");
  const permMatrix = await request("GET", "/auth/permissions", { token: adminToken });
  assert(permMatrix.statusCode === 200, "权限矩阵查询成功");
  const idemPerm = permMatrix.body.permissions.find((p) => p.key === "idempotency:query");
  assert(idemPerm, "权限矩阵包含 idempotency:query");
  if (idemPerm) {
    assert(idemPerm.label === "查询幂等记录", `label 正确: ${idemPerm.label}`);
    assert(idemPerm.category === "系统管理", `category 正确: ${idemPerm.category}`);
    assert(idemPerm.endpoints.includes("GET /idempotency-records"), "endpoints 包含 GET /idempotency-records");
    assert(idemPerm.roles.length === 1 && idemPerm.roles[0] === "admin", "仅 admin 角色拥有该权限");
  }

  console.log("\n=== 测试 16: 按 admin 角色过滤包含新权限 ===");
  const adminPerms = await request("GET", "/auth/permissions?role=admin", { token: adminToken });
  const adminHasIdem = adminPerms.body.permissions.some((p) => p.key === "idempotency:query");
  assert(adminHasIdem, "admin 角色过滤包含 idempotency:query");

  const whPerms = await request("GET", "/auth/permissions?role=warehouse", { token: adminToken });
  const whHasIdem = whPerms.body.permissions.some((p) => p.key === "idempotency:query");
  assert(!whHasIdem, "warehouse 角色过滤不包含 idempotency:query");

  console.log("\n" + "=".repeat(50));
  console.log(`测试结果: 通过 ${pass} / 失败 ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    throw new Error(`${fail} assertions failed`);
  }
}

main().catch((err) => {
  console.error("测试执行出错:", err);
  process.exit(1);
});
