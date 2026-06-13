import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "cylinders.json");
const port = Number(process.env.PORT || 3008);

const seed = {
  cylinders: [
    {
      id: "CY-88001",
      gasType: "高纯氩",
      capacity: "40L",
      inspectionDue: "2026-07-20",
      location: "一号仓",
      status: "in_stock",
      customer: null,
      depositStatus: "none",
      fills: [{ id: "fill-1", filledAt: "2026-06-02", pressure: "13.5MPa", operator: "陈起" }],
      events: [{ id: "evt-1", type: "inbound", at: "2026-06-02T08:20:00.000Z", note: "初始入库" }]
    },
    {
      id: "CY-88002",
      gasType: "混合标准气",
      capacity: "8L",
      inspectionDue: "2026-06-28",
      location: "宁川检测",
      status: "rented",
      customer: "宁川检测",
      depositStatus: "paid",
      fills: [],
      events: [{ id: "evt-2", type: "outbound", at: "2026-05-10T10:00:00.000Z", note: "客户租借" }]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function event(type, note) {
  return { id: `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`, type, at: new Date().toISOString(), note };
}

function daysUntil(dateText) {
  return Math.ceil((new Date(dateText).getTime() - Date.now()) / 86400000);
}

const transitions = {
  inbound(cylinder, input) {
    cylinder.status = "in_stock";
    cylinder.location = input.location || "仓库";
    cylinder.customer = null;
    cylinder.depositStatus = "none";
  },
  outbound(cylinder, input) {
    cylinder.status = "rented";
    cylinder.customer = input.customer;
    cylinder.location = input.customer;
    cylinder.depositStatus = input.depositStatus || "paid";
  },
  return(cylinder, input) {
    cylinder.status = "returned";
    cylinder.location = input.location || "待检区";
    cylinder.customer = null;
    cylinder.depositStatus = input.depositStatus || "refundable";
  },
  inspect(cylinder, input) {
    cylinder.status = "inspection";
    cylinder.location = input.location || "送检中";
    if (input.inspectionDue) cylinder.inspectionDue = input.inspectionDue;
  },
  scrap(cylinder, input) {
    cylinder.status = "scrapped";
    cylinder.location = input.location || "报废区";
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, {
        service: "特种气体钢瓶流转API",
        endpoints: ["GET /cylinders", "POST /cylinders", "POST /cylinders/:id/actions", "POST /cylinders/:id/fills", "GET /reports/alerts"]
      });
    }

    if (req.method === "GET" && url.pathname === "/cylinders") {
      const status = url.searchParams.get("status");
      const gasType = url.searchParams.get("gasType");
      let cylinders = db.cylinders;
      if (status) cylinders = cylinders.filter((item) => item.status === status);
      if (gasType) cylinders = cylinders.filter((item) => item.gasType === gasType);
      return send(res, 200, cylinders);
    }

    if (req.method === "POST" && url.pathname === "/cylinders") {
      const input = await body(req);
      const cylinder = { id: input.id, gasType: input.gasType, capacity: input.capacity, inspectionDue: input.inspectionDue, location: input.location || "仓库", status: "in_stock", customer: null, depositStatus: "none", fills: [], events: [event("create", "新建钢瓶")] };
      if (!cylinder.id || !cylinder.gasType) return send(res, 400, { error: "id_and_gasType_required" });
      db.cylinders.push(cylinder);
      await saveDb(db);
      return send(res, 201, cylinder);
    }

    const match = url.pathname.match(/^\/cylinders\/([^/]+)\/([^/]+)$/);
    if (match) {
      const [, id, action] = match;
      const cylinder = db.cylinders.find((item) => item.id === id);
      if (!cylinder) return send(res, 404, { error: "cylinder_not_found" });
      const input = await body(req);

      if (req.method === "POST" && action === "actions") {
        if (!transitions[input.type]) return send(res, 400, { error: "unknown_action" });
        transitions[input.type](cylinder, input);
        cylinder.events.push(event(input.type, input.note || input.type));
        await saveDb(db);
        return send(res, 200, cylinder);
      }

      if (req.method === "POST" && action === "fills") {
        const fill = { id: `fill-${Date.now()}`, filledAt: input.filledAt || new Date().toISOString().slice(0, 10), pressure: input.pressure, operator: input.operator };
        cylinder.fills.push(fill);
        cylinder.events.push(event("fill", `充装${input.pressure || ""}`));
        await saveDb(db);
        return send(res, 201, fill);
      }
    }

    if (req.method === "GET" && url.pathname === "/reports/alerts") {
      const inspectionDays = Number(url.searchParams.get("inspectionDays") || 45);
      const longRentDays = Number(url.searchParams.get("longRentDays") || 30);
      const alerts = db.cylinders.flatMap((cylinder) => {
        const items = [];
        if (daysUntil(cylinder.inspectionDue) <= inspectionDays) items.push({ type: "inspection_due", cylinderId: cylinder.id, due: cylinder.inspectionDue, daysLeft: daysUntil(cylinder.inspectionDue) });
        const lastOutbound = [...cylinder.events].reverse().find((evt) => evt.type === "outbound");
        if (cylinder.status === "rented" && lastOutbound && (Date.now() - new Date(lastOutbound.at).getTime()) / 86400000 >= longRentDays) {
          items.push({ type: "long_rent", cylinderId: cylinder.id, customer: cylinder.customer, since: lastOutbound.at });
        }
        return items;
      });
      return send(res, 200, alerts);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Gas cylinder flow API listening on http://localhost:${port}`);
});
