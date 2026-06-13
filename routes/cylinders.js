import { send, body, makeEvent, genId } from "../store/common.js";
import { loadCylinders, saveCylinders, findCylinder } from "../store/cylinders.js";
import { loadCustomers, findCustomer } from "../store/customers.js";

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
  async outbound(cylinder, input) {
    const customers = await loadCustomers();
    const customer = findCustomer(customers, input.customer);
    if (!customer) {
      const err = new Error("customer_not_found");
      err.statusCode = 422;
      throw err;
    }
    cylinder.status = "rented";
    cylinder.customer = input.customer;
    cylinder.location = customer.name;
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

export async function handleCylinders(req, res, url) {
  if (req.method === "GET" && url.pathname === "/cylinders") {
    const status = url.searchParams.get("status");
    const gasType = url.searchParams.get("gasType");
    let cylinders = await loadCylinders();
    if (status) cylinders = cylinders.filter((c) => c.status === status);
    if (gasType) cylinders = cylinders.filter((c) => c.gasType === gasType);
    return send(res, 200, cylinders);
  }

  if (req.method === "POST" && url.pathname === "/cylinders") {
    const input = await body(req);
    const cylinders = await loadCylinders();
    const cylinder = {
      id: input.id,
      gasType: input.gasType,
      capacity: input.capacity,
      inspectionDue: input.inspectionDue,
      location: input.location || "仓库",
      status: "in_stock",
      customer: null,
      depositStatus: "none",
      fills: [],
      events: [makeEvent("create", "新建钢瓶")]
    };
    if (!cylinder.id || !cylinder.gasType) return send(res, 400, { error: "id_and_gasType_required" });
    cylinders.push(cylinder);
    await saveCylinders(cylinders);
    return send(res, 201, cylinder);
  }

  const match = url.pathname.match(/^\/cylinders\/([^/]+)\/([^/]+)$/);
  if (match) {
    const [, id, action] = match;
    const cylinders = await loadCylinders();
    const cylinder = findCylinder(cylinders, id);
    if (!cylinder) return send(res, 404, { error: "cylinder_not_found" });

    if (req.method === "POST" && action === "actions") {
      const input = await body(req);
      const transition = transitions[input.type];
      if (!transition) return send(res, 400, { error: "unknown_action" });
      try {
        await transition(cylinder, input);
      } catch (err) {
        if (err.statusCode) return send(res, err.statusCode, { error: err.message });
        throw err;
      }
      cylinder.events.push(makeEvent(input.type, input.note || input.type));
      await saveCylinders(cylinders);
      return send(res, 200, cylinder);
    }

    if (req.method === "POST" && action === "fills") {
      const input = await body(req);
      const fill = {
        id: genId("fill"),
        filledAt: input.filledAt || new Date().toISOString().slice(0, 10),
        pressure: input.pressure,
        operator: input.operator
      };
      cylinder.fills.push(fill);
      cylinder.events.push(makeEvent("fill", `充装${input.pressure || ""}`));
      await saveCylinders(cylinders);
      return send(res, 201, fill);
    }
  }

  return null;
}
