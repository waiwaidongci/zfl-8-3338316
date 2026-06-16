import { loadReports, createReportTask, getReport, listReports, PHASES } from "../store/complianceReport.js";

console.log("=== 合规报表基本功能测试 ===\n");

try {
  console.log("1. 测试模块加载...");
  console.log("   PHASES:", PHASES.map(p => p.key).join(", "));
  console.log("   ✅ 模块加载成功\n");

  console.log("2. 测试加载报表列表...");
  const reports = await loadReports();
  console.log(`   当前报表数量: ${reports.length}`);
  console.log("   ✅ 列表加载成功\n");

  console.log("3. 测试创建报表任务...");
  const report = await createReportTask(
    { startAt: "2020-01-01T00:00:00.000Z", endAt: "2030-12-31T23:59:59.999Z" },
    "test-user"
  );
  console.log(`   报表ID: ${report.id}`);
  console.log(`   状态: ${report.status}`);
  console.log(`   阶段数: ${Object.keys(report.phases || {}).length}`);
  console.log(`   progress.total: ${report.progress?.total}`);
  console.log("   ✅ 创建成功\n");

  console.log("4. 等待3秒后查询进度...");
  await new Promise(r => setTimeout(r, 3000));

  const updated = await getReport(report.id);
  console.log(`   状态: ${updated.status}`);
  console.log(`   当前阶段: ${updated.currentPhase || "none"}`);
  console.log(`   进度: ${updated.progress?.step}/${updated.progress?.total} - ${updated.progress?.message}`);

  if (updated.phases) {
    const completedPhases = Object.entries(updated.phases)
      .filter(([_, p]) => p.status === "completed")
      .map(([k]) => k);
    console.log(`   已完成阶段: ${completedPhases.join(", ") || "none"}`);
  }
  console.log("   ✅ 进度查询成功\n");

  console.log("5. 测试列表查询...");
  const listResult = await listReports({ page: "1", pageSize: "10" });
  console.log(`   总数: ${listResult.pagination.totalCount}`);
  console.log(`   本页: ${listResult.items.length}`);
  console.log("   ✅ 列表查询成功\n");

  console.log("=== 基本功能测试完成 ===");
  process.exit(0);
} catch (err) {
  console.error("❌ 测试失败:", err.message);
  console.error(err.stack);
  process.exit(1);
}
