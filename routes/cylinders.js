import { send, body, makeEvent, genId } from "../store/common.js";
import { loadCylinders, saveCylinders, findCylinder } from "../store/cylinders.js";
import { loadCustomers, findCustomer } from "../store/customers.js";
import { validateCylinderBatch } from "../store/bulkImport.js";
import { checkQueryAuth, checkActionAuth } from "./auth.js";
import { PERMISSIONS } from "../auth/users.js";

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
  if (req.method === "POST" && url.pathname === "/cylinders/bulk/preview") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.CYLINDER_BULK);
    if (!auth.authorized) return true;
    const input = await body(req);
    if (!Array.isArray(input)) {
      return send(res, 400, { error: "batch_must_be_array" });
    }
    const existingCylinders = await loadCylinders();
    const result = validateCylinderBatch(input, existingCylinders);
    return send(res, 200, {
      totalCount: result.totalCount,
      validCount: result.validCount,
      errorCount: result.errorCount,
      preview: result.valid,
      errors: result.errors,
      summary: result.summary
    });
  }

  if (req.method === "POST" && url.pathname === "/cylinders/bulk/confirm") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.CYLINDER_BULK);
    if (!auth.authorized) return true;
    const input = await body(req);
    if (!Array.isArray(input)) {
      return send(res, 400, { error: "batch_must_be_array" });
    }
    const existingCylinders = await loadCylinders();
    const result = validateCylinderBatch(input, existingCylinders);
    const updated = [...existingCylinders, ...result.valid];
    if (result.validCount > 0) {
      await saveCylinders(updated);
    }
    const statusCode = result.validCount > 0 ? 201 : 422;
    return send(res, statusCode, {
      totalCount: result.totalCount,
      created: result.validCount,
      rejected: result.errorCount,
      cylinders: result.valid,
      errors: result.errors,
      summary: result.summary
    });
  }

  if (req.method === "GET" && url.pathname === "/cylinders") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const status = url.searchParams.get("status");
    const gasType = url.searchParams.get("gasType");
    let cylinders = await loadCylinders();
    if (status) cylinders = cylinders.filter((c) => c.status === status);
    if (gasType) cylinders = cylinders.filter((c) => c.gasType === gasType);
    return send(res, 200, cylinders);
  }

  if (req.method === "POST" && url.pathname === "/cylinders") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.CYLINDER_CREATE);
    if (!auth.authorized) return true;
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

    if (req.method === "POST" && action === "fills") {
      const auth = await checkActionAuth(req, res, PERMISSIONS.CYLINDER_FILL);
      if (!auth.authorized) return true;
      const cylinders = await loadCylinders();
      const cylinder = findCylinder(cylinders, id);
      if (!cylinder) return send(res, 404, { error: "cylinder_not_found" });
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

    if (req.method === "POST" && action === "actions") {
      const loginAuth = await checkQueryAuth(req, res);
      if (!loginAuth.authorized) return true;
      const input = await body(req);
      const transition = transitions[input.type];
      if (!transition) return send(res, 400, { error: "unknown_action" });
      const permMap = {
        inbound: PERMISSIONS.CYLINDER_INBOUND,
        outbound: PERMISSIONS.CYLINDER_OUTBOUND,
        return: PERMISSIONS.CYLINDER_RETURN,
        inspect: PERMISSIONS.CYLINDER_INSPECT,
        scrap: PERMISSIONS.CYLINDER_SCRAP
      };
      const requiredPerm = permMap[input.type];
      if (requiredPerm) {
        const permAuth = await checkActionAuth(req, res, requiredPerm);
        if (!permAuth.authorized) return true;
      }
      const cylinders = await loadCylinders();
      const cylinder = findCylinder(cylinders, id);
      if (!cylinder) return send(res, 404, { error: "cylinder_not_found" });
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
  }

  return null;
}
