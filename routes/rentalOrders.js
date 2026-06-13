import { send, body, makeEvent } from "../store/common.js";
import { loadCylinders, saveCylinders, findCylinder } from "../store/cylinders.js";
import { loadCustomers, findCustomer } from "../store/customers.js";
import {
  loadOrders,
  saveOrders,
  findOrder,
  findOrdersByCustomer,
  createOrder
} from "../store/rentalOrders.js";

function validateCreateOrderInput(input) {
  if (!input.customerId) {
    return { valid: false, error: "customerId_required", status: 400 };
  }
  if (!Array.isArray(input.cylinders) || input.cylinders.length === 0) {
    return { valid: false, error: "cylinders_required", status: 400 };
  }
  const seen = new Set();
  for (const item of input.cylinders) {
    if (!item || !item.id) {
      return { valid: false, error: "cylinder_id_required", status: 400 };
    }
    if (seen.has(item.id)) {
      return { valid: false, error: `duplicate_cylinder:${item.id}`, status: 400 };
    }
    seen.add(item.id);
  }
  return { valid: true };
}

export async function handleRentalOrders(req, res, url) {
  if (req.method === "POST" && url.pathname === "/rental-orders") {
    const input = await body(req);

    const validation = validateCreateOrderInput(input);
    if (!validation.valid) {
      return send(res, validation.status, { error: validation.error });
    }

    const customers = await loadCustomers();
    const customer = findCustomer(customers, input.customerId);
    if (!customer) {
      return send(res, 404, { error: "customer_not_found" });
    }

    const cylinders = await loadCylinders();
    const errors = [];

    const cylinderInfos = [];
    for (const item of input.cylinders) {
      const cylinder = findCylinder(cylinders, item.id);
      if (!cylinder) {
        errors.push({ cylinderId: item.id, error: "cylinder_not_found" });
        continue;
      }
      if (cylinder.status === "rented") {
        errors.push({ cylinderId: item.id, error: "cylinder_already_rented", currentCustomer: cylinder.customer });
        continue;
      }
      cylinderInfos.push({
        cylinder,
        depositStatus: item.depositStatus || "paid",
        note: item.note || ""
      });
    }

    if (errors.length > 0) {
      return send(res, 422, {
        error: "order_validation_failed",
        message: "部分钢瓶校验失败，订单未创建，所有钢瓶状态保持不变",
        errors
      });
    }

    const orders = await loadOrders();

    for (const info of cylinderInfos) {
      const c = info.cylinder;
      c.status = "rented";
      c.customer = customer.id;
      c.location = customer.name;
      c.depositStatus = info.depositStatus;
      c.events.push(makeEvent("outbound", `订单出库${info.note ? " - " + info.note : ""}`));
    }

    const orderSnapshot = cylinderInfos.map((info) => ({
      id: info.cylinder.id,
      gasType: info.cylinder.gasType,
      capacity: info.cylinder.capacity,
      depositStatus: info.depositStatus
    }));

    const order = createOrder({
      customer,
      cylinders: orderSnapshot,
      note: input.note
    });

    const updatedCylinders = cylinders.map((c) => {
      const matched = cylinderInfos.find((info) => info.cylinder.id === c.id);
      return matched ? matched.cylinder : c;
    });

    orders.push(order);
    await saveCylinders(updatedCylinders);
    await saveOrders(orders);

    return send(res, 201, order);
  }

  const detailMatch = url.pathname.match(/^\/rental-orders\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const [, id] = detailMatch;
    const orders = await loadOrders();
    const order = findOrder(orders, id);
    if (!order) return send(res, 404, { error: "order_not_found" });
    return send(res, 200, order);
  }

  const customerOrdersMatch = url.pathname.match(/^\/customers\/([^/]+)\/orders$/);
  if (customerOrdersMatch && req.method === "GET") {
    const [, customerId] = customerOrdersMatch;
    const customers = await loadCustomers();
    const customer = findCustomer(customers, customerId);
    if (!customer) return send(res, 404, { error: "customer_not_found" });
    const orders = await loadOrders();
    const customerOrders = findOrdersByCustomer(orders, customerId);
    return send(res, 200, customerOrders);
  }

  const listMatch = url.pathname === "/rental-orders";
  if (listMatch && req.method === "GET") {
    const orders = await loadOrders();
    return send(res, 200, orders);
  }

  return null;
}
