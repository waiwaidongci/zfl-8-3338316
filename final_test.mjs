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

async function main() {
  const login = await request("POST", "/auth/login", {
    body: { username: "admin", password: "admin123" },
  });
  const token = login.body.token;
  console.log("✅ 登录成功");

  console.log("\n=== 1. dashboard 接口 ===");
  const dash = await request("GET", "/reports/dashboard", { token });
  console.log("  Status:", dash.statusCode);
  console.log("  字段:", Object.keys(dash.body));
  console.log("  total:", dash.body.total,
    "- byStatus:", JSON.stringify(dash.body.byStatus),
    "- fills.totalFills:", dash.body.fills?.totalFills);

  console.log("\n=== 2. 并发 5 个钢瓶创建（验证不丢写）===");
  const TS = Date.now();
  const N = 5;
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      request("POST", "/cylinders", {
        token,
        idemKey: `create-${TS}-${i}`,
        body: {
          id: `CY-CON-${TS}-${i}`,
          gasType: "并发测试气",
          capacity: "10L",
          inspectionDue: "2027-01-01",
        },
      }).then((r) => ({ i, status: r.statusCode, id: r.body.id, err: r.body.error }))
    )
  );
  const success = results.filter((r) => r.status === 201).length;
  console.log(`  耗时: ${Date.now() - t0}ms`);
  console.log(`  成功: ${success}/${N}` + (success === N ? " ✅ 无丢写" : " ❌ 有丢写"));
  if (success < N) {
    results.filter((r) => r.status !== 201).forEach((r) => console.log("   ", r));
  }

  console.log("\n=== 3. 确认这 10 个钢瓶真的持久化了 ===");
  const list = await request("GET", "/cylinders", { token });
  const found = list.body.filter((c) => c.id.startsWith(`CY-CON-${TS}-`)).length;
  console.log(`  GET /cylinders 中找到 ${found}/${N} 个` + (found === N ? " ✅ 全部持久化" : " ❌ 部分丢失"));

  console.log("\n=== 4. 同一钢瓶 2 次 action + 1 次充装（幂等 + 串行）===");
  const CID = `CY-ACTION-${TS}`;
  await request("POST", "/cylinders", {
    token,
    idemKey: `create-${TS}`,
    body: { id: CID, gasType: "流转测试", capacity: "40L", inspectionDue: "2027-06-01" },
  });
  const actResults = await Promise.all([
    request("POST", `/cylinders/${CID}/actions`, {
      token, idemKey: `out-${TS}`,
      body: { type: "outbound", customer: "CUS-001", note: "出库" },
    }),
    request("POST", `/cylinders/${CID}/actions`, {
      token, idemKey: `out-${TS}`,
      body: { type: "outbound", customer: "CUS-001", note: "出库重复" },
    }),
    request("POST", `/cylinders/${CID}/fills`, {
      token, idemKey: `fill-${TS}`,
      body: { pressure: "13.5MPa", operator: "测试员" },
    }),
  ]);
  actResults.forEach((r, i) => {
    console.log(`  请求${i + 1}: status=${r.statusCode} cylStatus=${r.body.status} replayed=${r.headers["x-idempotent-replayed"] || "-"} events=${r.body.events?.length}`);
  });
  const finalCyl = await request("GET", `/cylinders/${CID}`, { token });
  console.log(`  最终钢瓶: status=${finalCyl.body.status} events=${finalCyl.body.events?.length} fills=${finalCyl.body.fills?.length}`);

  console.log("\n✅ 所有测试完成");
}

main().catch((e) => { console.error("错误:", e); process.exit(1); });
