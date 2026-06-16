import http from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const dataDir = join(projectRoot, "data", "v3");
const dataFilesToRestore = [
  "idempotency.json",
  "operationLogs.json",
  "tokens.json"
];

async function snapshotDataFiles() {
  const snapshot = new Map();
  for (const fileName of dataFilesToRestore) {
    for (const suffix of ["", ".bak"]) {
      const filePath = join(dataDir, `${fileName}${suffix}`);
      try {
        snapshot.set(filePath, await readFile(filePath));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        snapshot.set(filePath, null);
      }
    }
  }
  return snapshot;
}

async function restoreDataFiles(snapshot) {
  for (const [filePath, content] of snapshot.entries()) {
    if (content === null) {
      await rm(filePath, { force: true });
    } else {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
  }
}

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

  console.log("\n=== 测试 12: 敏感字段脱敏 - password & secret ===");
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

  console.log("\n=== 测试 12-1: 敏感字段脱敏 - token & authorization ===");
  const ts3 = Date.now();
  const tokenSensitiveRes = await request("POST", "/cylinders", {
    token: adminToken,
    headers: { "Idempotency-Key": `test-idem-token-${ts3}` },
    body: {
      gasType: "高纯氧",
      capacity: "40L",
      location: "三号仓",
      token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      authorization: "Bearer sk-live-xxxxxxxxxxxx",
      apiKey: "api-key-12345",
      accessToken: "access-token-abc",
      refreshToken: "refresh-token-def",
      creditCard: "4111-1111-1111-1111",
      normalField: "keep-this-value"
    },
  });
  const idemKey3 = tokenSensitiveRes.body.idempotencyKey || `test-idem-token-${ts3}`;
  assert([200, 201, 400].includes(tokenSensitiveRes.statusCode), "创建含token类敏感字段请求完成");

  const tokenQuery = await request("GET", `/idempotency-records?key=${idemKey3}`, { token: adminToken });
  assert(tokenQuery.statusCode === 200, "查询含token类敏感字段记录成功");
  const tokenRecord = tokenQuery.body.items.find((r) => r.key === idemKey3);
  assert(tokenRecord, "找到含token类敏感字段的记录");
  if (tokenRecord && tokenRecord.operationLog && tokenRecord.operationLog.requestBody) {
    const reqBody = tokenRecord.operationLog.requestBody;
    assert(reqBody.token === "******", `token 字段已脱敏 (${reqBody.token})`);
    assert(reqBody.authorization === "******", `authorization 字段已脱敏 (${reqBody.authorization})`);
    assert(reqBody.apiKey === "******", `apiKey 字段已脱敏 (${reqBody.apiKey})`);
    assert(reqBody.accessToken === "******", `accessToken 字段已脱敏 (${reqBody.accessToken})`);
    assert(reqBody.refreshToken === "******", `refreshToken 字段已脱敏 (${reqBody.refreshToken})`);
    assert(reqBody.creditCard === "******", `creditCard 字段已脱敏 (${reqBody.creditCard})`);
    assert(reqBody.normalField === "keep-this-value", `普通字段未被脱敏 (${reqBody.normalField})`);
    assert(reqBody.gasType !== "******", `gasType 未被脱敏 (${reqBody.gasType})`);
  }

  console.log("\n=== 测试 12-2: 敏感字段脱敏 - 嵌套对象中的敏感字段 ===");
  const ts4 = Date.now();
  const nestedSensitiveRes = await request("POST", "/cylinders", {
    token: adminToken,
    headers: { "Idempotency-Key": `test-idem-nested-${ts4}` },
    body: {
      gasType: "高纯氮",
      capacity: "50L",
      location: "四号仓",
      metadata: {
        api_key: "nested-api-key",
        access_token: "nested-access-token",
        refresh_token: "nested-refresh-token",
        credit_card: "5500-0000-0000-0004",
        inner: {
          password: "nested-password",
          secret: "nested-secret"
        }
      },
      config: {
        headers: {
          Authorization: "Bearer nested-auth"
        }
      }
    },
  });
  const idemKey4 = nestedSensitiveRes.body.idempotencyKey || `test-idem-nested-${ts4}`;
  assert([200, 201, 400].includes(nestedSensitiveRes.statusCode), "创建含嵌套敏感字段请求完成");

  const nestedQuery = await request("GET", `/idempotency-records?key=${idemKey4}`, { token: adminToken });
  assert(nestedQuery.statusCode === 200, "查询含嵌套敏感字段记录成功");
  const nestedRecord = nestedQuery.body.items.find((r) => r.key === idemKey4);
  assert(nestedRecord, "找到含嵌套敏感字段的记录");
  if (nestedRecord && nestedRecord.operationLog && nestedRecord.operationLog.requestBody) {
    const reqBody = nestedRecord.operationLog.requestBody;
    assert(reqBody.metadata.api_key === "******", `嵌套 api_key 字段已脱敏`);
    assert(reqBody.metadata.access_token === "******", `嵌套 access_token 字段已脱敏`);
    assert(reqBody.metadata.refresh_token === "******", `嵌套 refresh_token 字段已脱敏`);
    assert(reqBody.metadata.credit_card === "******", `嵌套 credit_card 字段已脱敏`);
    assert(reqBody.metadata.inner.password === "******", `深层嵌套 password 字段已脱敏`);
    assert(reqBody.metadata.inner.secret === "******", `深层嵌套 secret 字段已脱敏`);
    assert(reqBody.config.headers.Authorization === "******", `嵌套 Authorization 字段已脱敏`);
    assert(reqBody.gasType === "高纯氮", `普通嵌套字段 gasType 未被脱敏`);
  }

  console.log("\n=== 测试 12-3: 敏感字段脱敏 - 响应体 response.body ===");
  const ts5 = Date.now();
  const cylinderWithTokenRes = await request("POST", "/cylinders", {
    token: adminToken,
    headers: { "Idempotency-Key": `test-idem-resp-${ts5}` },
    body: {
      gasType: "高纯氦",
      capacity: "10L",
      location: "五号仓",
      token: "request-token-should-be-masked"
    },
  });
  assert([200, 201, 400].includes(cylinderWithTokenRes.statusCode), "创建钢瓶请求完成（用于响应体脱敏测试）");
  const idemKey5 = cylinderWithTokenRes.body.idempotencyKey || `test-idem-resp-${ts5}`;

  const respQuery = await request("GET", `/idempotency-records?key=${idemKey5}`, { token: adminToken });
  assert(respQuery.statusCode === 200, "查询含响应体的幂等记录成功");
  const respRecord = respQuery.body.items.find((r) => r.key === idemKey5);
  assert(respRecord, "找到含响应体的幂等记录");
  if (respRecord && respRecord.response && respRecord.response.body) {
    const respBody = respRecord.response.body;
    const respBodyStr = JSON.stringify(respBody);
    assert(!respBodyStr.includes("request-token-should-be-masked"), "响应体中不包含原始敏感值");
    if (respBody.id) assert(typeof respBody.id === "string", "响应体 id 字段正常返回");
    if (respBody.gasType) assert(respBody.gasType !== "******", "响应体普通字段未被脱敏");
  }

  console.log("\n=== 测试 12-4: 敏感字段脱敏 - 数组中嵌套敏感字段 ===");
  const ts6 = Date.now();
  const arraySensitiveRes = await request("POST", "/cylinders", {
    token: adminToken,
    headers: { "Idempotency-Key": `test-idem-array-${ts6}` },
    body: {
      gasType: "混合气体",
      capacity: "20L",
      location: "六号仓",
      items: [
        { id: 1, password: "array-pwd-1", name: "item1" },
        { id: 2, secret: "array-secret-2", name: "item2" },
        { id: 3, data: { apiKey: "nested-array-key" }, name: "item3" }
      ]
    },
  });
  const idemKey6 = arraySensitiveRes.body.idempotencyKey || `test-idem-array-${ts6}`;
  assert([200, 201, 400].includes(arraySensitiveRes.statusCode), "创建含数组敏感字段请求完成");

  const arrayQuery = await request("GET", `/idempotency-records?key=${idemKey6}`, { token: adminToken });
  assert(arrayQuery.statusCode === 200, "查询含数组敏感字段记录成功");
  const arrayRecord = arrayQuery.body.items.find((r) => r.key === idemKey6);
  assert(arrayRecord, "找到含数组敏感字段的记录");
  if (arrayRecord && arrayRecord.operationLog && arrayRecord.operationLog.requestBody) {
    const reqBody = arrayRecord.operationLog.requestBody;
    assert(Array.isArray(reqBody.items), "items 仍是数组");
    assert(reqBody.items[0].password === "******", "数组第1项 password 已脱敏");
    assert(reqBody.items[0].name === "item1", "数组第1项普通字段未脱敏");
    assert(reqBody.items[1].secret === "******", "数组第2项 secret 已脱敏");
    assert(reqBody.items[2].data.apiKey === "******", "数组嵌套对象 apiKey 已脱敏");
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

const dataSnapshot = await snapshotDataFiles();

try {
  await main();
} catch (err) {
  console.error("测试执行出错:", err);
  process.exitCode = 1;
} finally {
  await restoreDataFiles(dataSnapshot);
}
