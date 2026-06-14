import http from "node:http";
import { send } from "./store/common.js";
import { handleAuth } from "./routes/auth.js";
import { handleCylinders } from "./routes/cylinders.js";
import { handleCustomers } from "./routes/customers.js";
import { handleRentalOrders } from "./routes/rentalOrders.js";
import { handleInspectionTasks } from "./routes/inspectionTasks.js";
import { handleEventAudit } from "./routes/eventAudit.js";
import { recoverStaleProcessing } from "./store/idempotency.js";

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
  "GET /inspection-tasks",
  "POST /inspection-tasks/generate",
  "GET /inspection-tasks/:id",
  "POST /inspection-tasks/:id/send",
  "POST /inspection-tasks/:id/inspect",
  "POST /inspection-tasks/:id/restock",
  "GET /events",
  "GET /events/types",
  "GET /operation-logs",
  "GET /operation-logs/types",
  "GET /operation-logs/:id",
  "POST /auth/login",
  "POST /auth/logout",
  "GET /auth/me",
  "GET /auth/roles"
];

const routeHandlers = [
  handleAuth,
  handleCylinders,
  handleCustomers,
  handleRentalOrders,
  handleInspectionTasks,
  handleEventAudit
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, {
        service: "特种气体钢瓶流转API",
        version: "2.0.0",
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

async function bootstrap() {
  try {
    const recovered = await recoverStaleProcessing();
    if (recovered > 0) {
      console.log(`[Idempotency] 服务启动恢复 ${recovered} 个 stale processing 记录`);
    }
  } catch (err) {
    console.warn(`[Idempotency] 恢复 stale 记录失败: ${err.message}`);
  }

  server.listen(port, () => {
    console.log(`Gas cylinder flow API listening on http://localhost:${port}`);
  });
}

bootstrap();
