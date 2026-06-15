import http from "node:http";

const BASE = `http://localhost:${process.env.PORT || 3008}`;

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          reject(new Error(`Non-JSON response for ${path}`));
        }
      });
    }).on("error", reject);
  });
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

async function run() {
  console.log("🚀 钢瓶列表筛选回归验证脚本\n");

  console.log("=== 1. 基础列表（无筛选）===");
  const all = await get("/cylinders");
  assert(Array.isArray(all.body), "返回数组");
  assert(all.status === 200, "状态码 200");

  console.log("\n=== 2. 现有筛选参数回归 ===");

  const byStatus = await get("/cylinders?status=in_stock");
  assert(Array.isArray(byStatus.body), "status 筛选返回数组");
  assert(byStatus.body.every((c) => c.status === "in_stock"), "status 筛选结果正确");

  const byGas = await get("/cylinders?gasType=高纯氩");
  assert(Array.isArray(byGas.body), "gasType 筛选返回数组");
  assert(byGas.body.every((c) => c.gasType === "高纯氩"), "gasType 筛选结果正确");

  const byLoc = await get("/cylinders?location=一号仓");
  assert(Array.isArray(byLoc.body), "location 筛选返回数组");
  assert(byLoc.body.every((c) => c.location === "一号仓"), "location 筛选结果正确");

  const byCust = await get("/cylinders?customer=宁川检测");
  assert(Array.isArray(byCust.body), "customer 筛选返回数组");
  assert(byCust.body.every((c) => c.customer === "宁川检测"), "customer 筛选结果正确");

  const noCust = await get("/cylinders?customer=");
  assert(Array.isArray(noCust.body), "customer=空 筛选返回数组");
  assert(noCust.body.every((c) => !c.customer), "customer=空 筛选无客户钢瓶");

  const byInsp = await get("/cylinders?inspectionDueBefore=2026-07-01");
  assert(Array.isArray(byInsp.body), "inspectionDueBefore 筛选返回数组");
  assert(byInsp.body.every((c) => c.inspectionDue && new Date(c.inspectionDue) <= new Date("2026-07-01")), "inspectionDueBefore 筛选结果正确");

  const byKw = await get("/cylinders?keyword=CY-88");
  assert(Array.isArray(byKw.body), "keyword 筛选返回数组");
  assert(byKw.body.every((c) => JSON.stringify(c).toLowerCase().includes("cy-88")), "keyword 筛选结果正确");

  console.log("\n=== 3. 分页回归 ===");

  const paged = await get("/cylinders?pagination=1&page=1&pageSize=1");
  assert(paged.status === 200, "分页状态码 200");
  assert(typeof paged.body.total === "number", "分页返回 total");
  assert(typeof paged.body.page === "number", "分页返回 page");
  assert(typeof paged.body.pageSize === "number", "分页返回 pageSize");
  assert(typeof paged.body.totalPages === "number", "分页返回 totalPages");
  assert(Array.isArray(paged.body.items), "分页返回 items");

  console.log("\n=== 4. 新增 latestEventType 筛选 ===");

  const byLatestType = await get("/cylinders?latestEventType=inbound");
  assert(Array.isArray(byLatestType.body), "latestEventType 筛选返回数组");
  assert(
    byLatestType.body.every((c) => {
      const events = c.events || [];
      if (events.length === 0) return false;
      const latest = [...events].sort((a, b) => new Date(b.at) - new Date(a.at))[0];
      return latest.type === "inbound";
    }),
    "latestEventType=inbound 筛选结果正确"
  );

  const byLatestOut = await get("/cylinders?latestEventType=outbound");
  assert(Array.isArray(byLatestOut.body), "latestEventType=outbound 筛选返回数组");
  assert(
    byLatestOut.body.every((c) => {
      const events = c.events || [];
      if (events.length === 0) return false;
      const latest = [...events].sort((a, b) => new Date(b.at) - new Date(a.at))[0];
      return latest.type === "outbound";
    }),
    "latestEventType=outbound 筛选结果正确"
  );

  console.log("\n=== 5. 新增 latestEventTimeFrom 筛选 ===");

  const fromTime = "2026-06-01T00:00:00.000Z";
  const byTimeFrom = await get(`/cylinders?latestEventTimeFrom=${encodeURIComponent(fromTime)}`);
  assert(Array.isArray(byTimeFrom.body), "latestEventTimeFrom 筛选返回数组");
  assert(
    byTimeFrom.body.every((c) => {
      const events = c.events || [];
      if (events.length === 0) return false;
      const latest = [...events].sort((a, b) => new Date(b.at) - new Date(a.at))[0];
      return new Date(latest.at).getTime() >= new Date(fromTime).getTime();
    }),
    `latestEventTimeFrom=${fromTime} 筛选结果正确`
  );

  console.log("\n=== 6. 新增 latestEventTimeTo 筛选 ===");

  const toTime = "2026-05-31T23:59:59.999Z";
  const byTimeTo = await get(`/cylinders?latestEventTimeTo=${encodeURIComponent(toTime)}`);
  assert(Array.isArray(byTimeTo.body), "latestEventTimeTo 筛选返回数组");
  assert(
    byTimeTo.body.every((c) => {
      const events = c.events || [];
      if (events.length === 0) return false;
      const latest = [...events].sort((a, b) => new Date(b.at) - new Date(a.at))[0];
      return new Date(latest.at).getTime() <= new Date(toTime).getTime();
    }),
    `latestEventTimeTo=${toTime} 筛选结果正确`
  );

  console.log("\n=== 7. 组合筛选：latestEventType + 时间范围 ===");

  const combo = await get(
    `/cylinders?latestEventType=inbound&latestEventTimeFrom=${encodeURIComponent("2026-06-01T00:00:00.000Z")}&latestEventTimeTo=${encodeURIComponent("2026-06-30T23:59:59.999Z")}`
  );
  assert(Array.isArray(combo.body), "组合筛选返回数组");
  assert(
    combo.body.every((c) => {
      const events = c.events || [];
      if (events.length === 0) return false;
      const latest = [...events].sort((a, b) => new Date(b.at) - new Date(a.at))[0];
      const t = new Date(latest.at).getTime();
      return (
        latest.type === "inbound" &&
        t >= new Date("2026-06-01T00:00:00.000Z").getTime() &&
        t <= new Date("2026-06-30T23:59:59.999Z").getTime()
      );
    }),
    "latestEventType + 时间范围组合筛选结果正确"
  );

  console.log("\n=== 8. 新增筛选与分页组合 ===");

  const comboPaged = await get(
    `/cylinders?latestEventType=inbound&pagination=1&page=1&pageSize=10`
  );
  assert(comboPaged.status === 200, "新增筛选+分页状态码 200");
  assert(typeof comboPaged.body.total === "number", "新增筛选+分页返回 total");
  assert(Array.isArray(comboPaged.body.items), "新增筛选+分页返回 items");

  console.log("\n=== 9. 新增筛选与现有筛选组合 ===");

  const comboExisting = await get("/cylinders?status=in_stock&latestEventType=inbound");
  assert(Array.isArray(comboExisting.body), "status+latestEventType 组合返回数组");
  assert(
    comboExisting.body.every((c) => {
      if (c.status !== "in_stock") return false;
      const events = c.events || [];
      if (events.length === 0) return false;
      const latest = [...events].sort((a, b) => new Date(b.at) - new Date(a.at))[0];
      return latest.type === "inbound";
    }),
    "status+latestEventType 组合筛选结果正确"
  );

  console.log("\n=== 10. 无效时间参数安全降级 ===");

  const invalidTime = await get("/cylinders?latestEventTimeFrom=not-a-date");
  assert(Array.isArray(invalidTime.body), "无效时间参数不报错，返回数组");
  assert(invalidTime.status === 200, "无效时间参数状态码 200");

  console.log("\n========================================");
  console.log(`  通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
  console.log("========================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("脚本执行失败:", err.message);
  process.exit(1);
});
