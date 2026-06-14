import http from "node:http";
import { send } from "./store/common.js";
import { handleAuth } from "./routes/auth.js";
import { handleCylinders } from "./routes/cylinders.js";
import { handleCustomers } from "./routes/customers.js";
import { handleReports } from "./routes/reports.js";
import { handleRentalOrders } from "./routes/rentalOrders.js";
import { handleInspectionTasks } from "./routes/inspectionTasks.js";

const port = Number(process.env.PORT || 3008);

const handlers = [handleAuth, handleCustomers, handleCylinders, handleReports, handleRentalOrders, handleInspectionTasks];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, {
        service: "特种气体钢瓶流转API",
        auth: {
          endpoints: [
            "POST /auth/login",
            "POST /auth/logout",
            "GET /auth/me",
            "GET /auth/roles"
          ],
          defaultAccounts: [
            { username: "admin", password: "admin123", role: "管理员" },
            { username: "warehouse", password: "warehouse123", role: "仓库" },
            { username: "sales", password: "sales123", role: "销售" },
            { username: "qc", password: "qc123", role: "质检" }
          ]
        },
        endpoints: [
          "GET /cylinders",
          "POST /cylinders",
          "POST /cylinders/bulk/preview",
          "POST /cylinders/bulk/confirm",
          "POST /cylinders/:id/actions",
          "POST /cylinders/:id/fills",
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
          "POST /inspection-tasks/:id/restock"
        ]
      });
    }

    for (const handler of handlers) {
      const result = await handler(req, res, url);
      if (result !== null) return;
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Gas cylinder flow API listening on http://localhost:${port}`);
});
