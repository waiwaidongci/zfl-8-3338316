import http from "node:http";

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, "http://localhost:3008");
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
    const bodyData = options.body ? JSON.stringify(options.body) : undefined;
    if (bodyData) headers["Content-Length"] = Buffer.byteLength(bodyData).toString();
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
  const login = await request("POST", "/auth/login", {
    body: { username: "admin", password: "admin123" },
  });
  const adminToken = login.body.token;
  assert(adminToken, "管理员登录成功");

  const qcLogin = await request("POST", "/auth/login", {
    body: { username: "qc", password: "qc123" },
  });
  const qcToken = qcLogin.body.token;
  assert(qcToken, "质检登录成功");

  console.log("\n=== 测试 1: 无认证访问返回 401 ===");
  const noAuth = await request("GET", "/auth/permissions");
  assert(noAuth.statusCode === 401, `无Token返回401 (${noAuth.statusCode})`);

  console.log("\n=== 测试 2: 获取完整权限矩阵 ===");
  const full = await request("GET", "/auth/permissions", { token: adminToken });
  assert(full.statusCode === 200, `请求成功 (${full.statusCode})`);
  assert(Array.isArray(full.body.permissions), "permissions 是数组");
  assert(full.body.permissions.length === 21, `共 21 个权限 (实际 ${full.body.permissions.length})`);
  assert(Array.isArray(full.body.roleInfo), "roleInfo 是数组");
  assert(full.body.roleInfo.length === 4, `共 4 个角色 (实际 ${full.body.roleInfo.length})`);
  assert(typeof full.body.note === "string", "包含 note 字段");

  const first = full.body.permissions[0];
  assert(first.key, "权限项包含 key");
  assert(first.label, "权限项包含 label (中文说明)");
  assert(first.category, "权限项包含 category (分类)");
  assert(Array.isArray(first.endpoints), "权限项包含 endpoints 数组");
  assert(first.endpoints.length > 0, "endpoints 非空");
  assert(Array.isArray(first.roles), "权限项包含 roles 数组");
  assert(first.roles.length > 0, "roles 非空");

  console.log("\n=== 测试 3: 权限矩阵数据完整性 - 所有权限都有元数据 ===");
  const allHaveMeta = full.body.permissions.every((p) => p.label !== p.key);
  assert(allHaveMeta, "所有权限都有中文 label（非 key 回退）");
  const allHaveEndpoints = full.body.permissions.every((p) => p.endpoints.length > 0);
  assert(allHaveEndpoints, "所有权限都至少对应一个接口");

  console.log("\n=== 测试 4: 管理员拥有全部权限 ===");
  const adminPerms = full.body.permissions.filter((p) => p.roles.includes("admin"));
  assert(adminPerms.length === 21, `admin 拥有全部 21 个权限 (实际 ${adminPerms.length})`);

  console.log("\n=== 测试 5: 按角色过滤 - qc ===");
  const qcFilter = await request("GET", "/auth/permissions?role=qc", { token: adminToken });
  assert(qcFilter.statusCode === 200, `过滤请求成功 (${qcFilter.statusCode})`);
  assert(qcFilter.body.permissions.length < full.body.permissions.length, "过滤后权限数少于全量");
  const qcAllMatch = qcFilter.body.permissions.every((p) => p.roles.includes("qc"));
  assert(qcAllMatch, "过滤结果中所有权限都包含 qc 角色");
  const qcPermKeys = qcFilter.body.permissions.map((p) => p.key);
  assert(qcPermKeys.includes("cylinder:inspect"), "qc 包含 cylinder:inspect");
  assert(qcPermKeys.includes("inspection:postpone"), "qc 包含 inspection:postpone");
  assert(!qcPermKeys.includes("cylinder:create"), "qc 不包含 cylinder:create");
  assert(!qcPermKeys.includes("customer:create"), "qc 不包含 customer:create");
  assert(qcFilter.body.roleInfo.length === 1, "过滤后 roleInfo 仅含 qc");
  assert(qcFilter.body.roleInfo[0].role === "qc", "roleInfo 中角色为 qc");

  console.log("\n=== 测试 6: 按角色过滤 - sales ===");
  const salesFilter = await request("GET", "/auth/permissions?role=sales", { token: adminToken });
  assert(salesFilter.statusCode === 200, "过滤请求成功");
  const salesKeys = salesFilter.body.permissions.map((p) => p.key);
  assert(salesKeys.includes("customer:create"), "sales 包含 customer:create");
  assert(salesKeys.includes("order:create"), "sales 包含 order:create");
  assert(salesKeys.includes("order:return"), "sales 包含 order:return");
  assert(salesKeys.includes("cylinder:outbound"), "sales 包含 cylinder:outbound");
  assert(!salesKeys.includes("cylinder:inspect"), "sales 不包含 cylinder:inspect");

  console.log("\n=== 测试 7: 按角色过滤 - warehouse ===");
  const whFilter = await request("GET", "/auth/permissions?role=warehouse", { token: adminToken });
  assert(whFilter.statusCode === 200, "过滤请求成功");
  const whKeys = whFilter.body.permissions.map((p) => p.key);
  assert(whKeys.includes("cylinder:create"), "warehouse 包含 cylinder:create");
  assert(whKeys.includes("cylinder:bulk"), "warehouse 包含 cylinder:bulk");
  assert(whKeys.includes("cylinder:fill"), "warehouse 包含 cylinder:fill");
  assert(!whKeys.includes("inspection:generate"), "warehouse 不包含 inspection:generate");
  assert(!whKeys.includes("inventory:confirm"), "warehouse 不包含 inventory:confirm");

  console.log("\n=== 测试 8: 无效角色返回 400 ===");
  const invalidRole = await request("GET", "/auth/permissions?role=invalid", { token: adminToken });
  assert(invalidRole.statusCode === 400, `无效角色返回400 (${invalidRole.statusCode})`);
  assert(invalidRole.body.error === "invalid_role", "错误类型为 invalid_role");

  console.log("\n=== 测试 9: 非 admin 用户也能访问 ===");
  const qcAccess = await request("GET", "/auth/permissions", { token: qcToken });
  assert(qcAccess.statusCode === 200, "qc 用户可以访问权限矩阵");

  console.log("\n=== 测试 10: 权限分类覆盖检查 ===");
  const categories = [...new Set(full.body.permissions.map((p) => p.category))];
  assert(categories.includes("钢瓶管理"), "包含钢瓶管理分类");
  assert(categories.includes("客户管理"), "包含客户管理分类");
  assert(categories.includes("订单管理"), "包含订单管理分类");
  assert(categories.includes("检验管理"), "包含检验管理分类");
  assert(categories.includes("盘点管理"), "包含盘点管理分类");
  assert(categories.includes("数据查询"), "包含数据查询分类");

  console.log("\n=== 测试 11: 根端点包含新接口 ===");
  const root = await request("GET", "/");
  assert(root.body.endpoints?.includes("GET /auth/permissions"), "根端点列表包含 GET /auth/permissions");
  assert(root.body.features?.permissionMatrix?.enabled === true, "features.permissionMatrix.enabled 为 true");
  assert(root.body.features?.permissionMatrix?.endpoint === "GET /auth/permissions", "features.permissionMatrix.endpoint 正确");

  console.log("\n=== 测试 12: 与 /auth/roles 数据一致性 ===");
  const rolesResp = await request("GET", "/auth/roles", { token: adminToken });
  assert(rolesResp.statusCode === 200, "/auth/roles 请求成功");
  for (const roleEntry of rolesResp.body.roles) {
    const filtered = await request("GET", `/auth/permissions?role=${roleEntry.role}`, { token: adminToken });
    const matrixKeys = filtered.body.permissions.map((p) => p.key).sort();
    const roleKeys = [...roleEntry.permissions].sort();
    assert(
      matrixKeys.length === roleKeys.length && matrixKeys.every((k, i) => k === roleKeys[i]),
      `${roleEntry.role} 角色的权限矩阵与 /auth/roles 返回一致`
    );
  }

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
