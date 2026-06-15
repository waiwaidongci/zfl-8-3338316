import http from "node:http";
import { send, clearDataDirCache } from "./store/common.js";
import { handleAuth } from "./routes/auth.js";
import { handleCylinders } from "./routes/cylinders.js";
import { handleCustomers } from "./routes/customers.js";
import { handleRentalOrders } from "./routes/rentalOrders.js";
import { handleInspectionTasks } from "./routes/inspectionTasks.js";
import { handleEventAudit } from "./routes/eventAudit.js";
import { handleInventoryChecks } from "./routes/inventoryChecks.js";
import { handleComplianceReport } from "./routes/complianceReport.js";
import { recoverStaleProcessing } from "./store/idempotency.js";
import { recoverPendingReports } from "./store/complianceReport.js";
import { runMigrations, getMigrationStatus, CURRENT_VERSION } from "./store/migration.js";

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err?.stack || err);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack || err);
});

const port = Number(process.env.PORT || 3008);

const ROOT_ENDPOINTS = [
  "GET /cylinders",
  "POST /cylinders",
  "POST /cylinders/bulk",
  "GET /cylinders/:id",
  "POST /cylinders/:id/actions",
  "POST /cylinders/:id/fills",
  "GET /cylinders/:id/timeline",
  "GET /reports/alerts",
  "GET /reports/dashboard",
  "GET /customers",
  "POST /customers",
  "GET /customers/:id",
  "GET /customers/:id/cylinders",
  "GET /customers/:id/deposits",
  "GET /customers/:id/orders",
  "GET /rental-orders",
  "POST /rental-orders",
  "GET /rental-orders/:id",
  "POST /rental-orders/:id/return",
  "GET /inspection-tasks",
  "POST /inspection-tasks/generate",
  "GET /inspection-tasks/:id",
  "POST /inspection-tasks/:id/send",
  "POST /inspection-tasks/:id/inspect",
  "POST /inspection-tasks/:id/restock",
  "GET /inventory-checks",
  "POST /inventory-checks",
  "GET /inventory-checks/:id",
  "POST /inventory-checks/:id/start",
  "POST /inventory-checks/:id/scan",
  "POST /inventory-checks/:id/complete",
  "GET /inventory-checks/:id/differences",
  "POST /inventory-checks/:id/confirm",
  "GET /inventory-checks/:id/history",
  "GET /cylinders/:id/inventory-history",
  "GET /reports/inventory-summary",
  "GET /events",
  "GET /events/types",
  "GET /operation-logs",
  "GET /operation-logs/types",
  "GET /operation-logs/:id",
  "POST /auth/login",
  "POST /auth/logout",
  "GET /auth/me",
  "GET /auth/roles",
  "POST /compliance-reports",
  "GET /compliance-reports",
  "GET /compliance-reports/:id",
  "POST /compliance-reports/:id/retry"
];

const routeHandlers = [
  handleAuth,
  handleCylinders,
  handleCustomers,
  handleRentalOrders,
  handleInspectionTasks,
  handleInventoryChecks,
  handleEventAudit,
  handleComplianceReport
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      const migrationStatus = await getMigrationStatus();
      return send(res, 200, {
        service: "特种气体钢瓶流转API",
        version: "2.0.0",
        dataVersion: migrationStatus.currentVersion,
        targetDataVersion: migrationStatus.targetVersion,
        features: {
          idempotency: {
            enabled: true,
            header: "Idempotency-Key",
            autoKeyEnabled: true,
            note: "所有写操作支持 Idempotency-Key；不传时自动生成兼容幂等键"
          },
          operationLogs: {
            enabled: true,
            endpoints: ["/operation-logs", "/operation-logs/types", "/operation-logs/:id"]
          },
          dataMigration: {
            enabled: true,
            currentVersion: migrationStatus.currentVersion,
            needsMigration: migrationStatus.needsMigration,
            availableBackups: migrationStatus.availableBackups.length,
            note: "数据支持版本化迁移和回滚，使用 node scripts/migrate.js 管理"
          }
        },
        endpoints: ROOT_ENDPOINTS
      });
    }

    for (const handler of routeHandlers) {
      const result = await handler(req, res, url);
      if (result === true || result !== null) {
        return;
      }
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message, stack: error.stack });
  }
});

async function runStartupMigration() {
  const status = await getMigrationStatus();
  console.log(`[Migration] 当前数据版本: v${status.currentVersion}, 目标版本: v${status.targetVersion}`);
  
  if (status.needsMigration) {
    console.log(`[Migration] 检测到需要数据迁移，开始自动执行...`);
    
    const result = await runMigrations(CURRENT_VERSION);
    
    if (result.success) {
      if (result.skipped) {
        console.log(`[Migration] ${result.message}`);
      } else {
        console.log(`[Migration] 自动迁移成功完成: v${result.fromVersion} -> v${result.toVersion}`);
        console.log(`[Migration] 备份目录: ${result.backupDir}`);
      }
      clearDataDirCache();
      return { success: true, result };
    } else {
      console.error(`[Migration] 自动迁移失败: ${result.error}`);
      if (result.backupDir) {
        console.error(`[Migration] 备份已保存至: ${result.backupDir}`);
        console.error(`[Migration] 如需手动恢复，请运行: node scripts/migrate.js restore ${result.backupName}`);
      }
      
      if (process.env.ALLOW_START_WITH_MIGRATION_ERROR !== "true") {
        console.error(`[Migration] 服务启动被阻止。如需强制启动，请设置环境变量 ALLOW_START_WITH_MIGRATION_ERROR=true`);
        return { success: false, fatal: true, result };
      }
      
      return { success: false, fatal: false, result };
    }
  } else {
    console.log(`[Migration] 数据版本已是最新，无需迁移`);
    return { success: true, skipped: true };
  }
}

async function bootstrap() {
  console.log("========================================");
  console.log("  特种气体钢瓶流转API - 服务启动");
  console.log("========================================");
  
  const migrationResult = await runStartupMigration();
  if (migrationResult.fatal) {
    console.error("\n[Fatal] 数据迁移失败，服务无法启动");
    process.exit(1);
  }
  
  try {
    const recovered = await recoverStaleProcessing();
    if (recovered > 0) {
      console.log(`[Idempotency] 服务启动恢复 ${recovered} 个 stale processing 记录`);
    }
  } catch (err) {
    console.warn(`[Idempotency] 恢复 stale 记录失败: ${err.message}`);
  }

  try {
    const recoveredReports = await recoverPendingReports();
    if (recoveredReports > 0) {
      console.log(`[ComplianceReport] 服务启动恢复 ${recoveredReports} 个未完成合规报表任务`);
    }
  } catch (err) {
    console.warn(`[ComplianceReport] 恢复报表任务失败: ${err.message}`);
  }

  server.listen(port, () => {
    console.log(`\nGas cylinder flow API listening on http://localhost:${port}`);
    console.log(`数据版本: v${CURRENT_VERSION}`);
    console.log(`服务版本: 2.0.0`);
  });
}

bootstrap();
