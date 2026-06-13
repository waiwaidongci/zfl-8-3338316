import http from "node:http";
import { send } from "./store/common.js";
import { handleCylinders } from "./routes/cylinders.js";
import { handleCustomers } from "./routes/customers.js";
import { handleReports } from "./routes/reports.js";
import { handleRentalOrders } from "./routes/rentalOrders.js";

const port = Number(process.env.PORT || 3008);

const handlers = [handleCustomers, handleCylinders, handleReports, handleRentalOrders];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, {
        service: "特种气体钢瓶流转API",
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
          "GET /rental-orders/:id"
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
