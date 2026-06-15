import { send, body, makeEvent, withMultiJsonTx } from "../store/common.js";
import { SEED as CYLINDERS_SEED } from "../store/cylinders.js";
import { SEED as ORDERS_SEED } from "../store/rentalOrders.js";
import { findCylinder, transitions, applyAction } from "../store/cylinders.js";
import { findCustomer } from "../store/customers.js";
import { findOrder, findOrdersByCustomer, createOrder, returnOrderCylinders, calculateOrderStatus } from "../store/rentalOrders.js";
import { checkQueryAuth, checkActionAuth } from "./auth.js";
import { PERMISSIONS } from "../auth/users.js";
import { executeWithIdempotency } from "../store/idempotencyExecutor.js";
import { OPERATION_TYPES, TARGET_TYPES, snapshotEntity } from "../store/operationLog.js";

const CYLINDERS_FILE = "cylinders.json";
const ORDERS_FILE = "rentalOrders.json";

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

function validateReturnOrderInput(input) {
  if (!Array.isArray(input.cylinderIds) || input.cylinderIds.length === 0) {
    return { valid: false, error: "cylinderIds_required", status: 400 };
  }
  const seen = new Set();
  for (const id of input.cylinderIds) {
    if (!id || typeof id !== "string") {
      return { valid: false, error: "cylinder_id_required", status: 400 };
    }
    if (seen.has(id)) {
      return { valid: false, error: `duplicate_cylinder:${id}`, status: 400 };
    }
    seen.add(id);
  }
  if (input.returnLocation !== undefined && typeof input.returnLocation !== "string") {
    return { valid: false, error: "returnLocation_invalid", status: 400 };
  }
  if (input.depositRefunded !== undefined && typeof input.depositRefunded !== "boolean") {
    return { valid: false, error: "depositRefunded_invalid", status: 400 };
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    return { valid: false, error: "note_invalid", status: 400 };
  }
  return { valid: true };
}

export async function handleRentalOrders(req, res, url) {
  if (req.method === "POST" && url.pathname === "/rental-orders") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.ORDER_CREATE);
    if (!auth.authorized) return true;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.ORDER_CREATE,
      targetType: TARGET_TYPES.ORDER,
      operation: async (ctx) => {
        const input = await body(req);

        const validation = validateCreateOrderInput(input);
        if (!validation.valid) {
          return { statusCode: validation.status, body: { error: validation.error } };
        }

        const customer = await (async () => {
          const { loadCustomers } = await import("../store/customers.js");
          const customers = await loadCustomers();
          return findCustomer(customers, input.customerId);
        })();
        if (!customer) {
          return { statusCode: 404, body: { error: "customer_not_found" } };
        }

        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: ORDERS_FILE, fallback: ORDERS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const orders = dbs[ORDERS_FILE].orders;

            const errors = [];
            const cylinderInfos = [];
            const eventIds = [];
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
              return {
                statusCode: 422,
                body: {
                  error: "order_validation_failed",
                  message: "部分钢瓶校验失败，订单未创建，所有钢瓶状态保持不变",
                  errors
                }
              };
            }

            const cylinderSnapshotsBefore = cylinderInfos.map((info) => snapshotEntity(info.cylinder));
            for (const info of cylinderInfos) {
              const c = info.cylinder;
              const actionInput = {
                type: "outbound",
                customer: customer.id,
                location: customer.name,
                depositStatus: info.depositStatus,
                note: `订单出库${info.note ? " - " + info.note : ""}`,
                operator: auth.user?.username
              };
              const evt = applyAction(c, actionInput);
              eventIds.push(evt.id);
            }

            ctx.setBeforeState({ cylinders: cylinderSnapshotsBefore });
            ctx.captureEventIds(eventIds);

            const orderSnapshot = cylinderInfos.map((info) => ({
              id: info.cylinder.id,
              gasType: info.cylinder.gasType,
              capacity: info.cylinder.capacity,
              depositStatus: info.depositStatus
            }));

            const created = createOrder({
              customer,
              cylinders: orderSnapshot,
              note: input.note,
              operator: auth.user?.username
            });
            orders.push(created);

            return { statusCode: 201, body: created };
          }
        );
      }
    });
  }

  const returnMatch = url.pathname.match(/^\/rental-orders\/([^/]+)\/return$/);
  if (returnMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.ORDER_RETURN);
    if (!auth.authorized) return true;
    const [, orderId] = returnMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.ORDER_RETURN,
      targetType: TARGET_TYPES.ORDER,
      targetIdExtractor: () => orderId,
      operation: async (ctx) => {
        const input = await body(req);

        const validation = validateReturnOrderInput(input);
        if (!validation.valid) {
          return { statusCode: validation.status, body: { error: validation.error } };
        }

        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: ORDERS_FILE, fallback: ORDERS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const orders = dbs[ORDERS_FILE].orders;

            const order = findOrder(orders, orderId);
            if (!order) {
              return { statusCode: 404, body: { error: "order_not_found" } };
            }

            if (!Array.isArray(order.cylinders)) {
              order.cylinders = [];
              order.returnedCount = 0;
            }
            if (!Array.isArray(order.returnHistory)) {
              order.returnHistory = [];
            }

            const errors = [];
            const validCylinders = [];
            const cylinderSnapshotsBefore = [];
            const eventIds = [];

            for (const cylinderId of input.cylinderIds) {
              const orderCylinder = order.cylinders.find((c) => c.id === cylinderId);
              if (!orderCylinder) {
                errors.push({ cylinderId, error: "cylinder_not_in_order" });
                continue;
              }
              if (orderCylinder.returned) {
                errors.push({ cylinderId, error: "cylinder_already_returned", returnedAt: orderCylinder.returnedAt });
                continue;
              }

              const cylinder = findCylinder(cylinders, cylinderId);
              if (!cylinder) {
                errors.push({ cylinderId, error: "cylinder_not_found" });
                continue;
              }
              if (cylinder.status !== "rented") {
                errors.push({ cylinderId, error: "cylinder_not_rented", currentStatus: cylinder.status });
                continue;
              }
              if (cylinder.customer !== order.customerId && cylinder.customer !== order.customerName) {
                errors.push({ cylinderId, error: "cylinder_customer_mismatch", orderCustomer: order.customerName, actualCustomer: cylinder.customer });
                continue;
              }

              cylinderSnapshotsBefore.push(snapshotEntity(cylinder));
              validCylinders.push({ orderCylinder, cylinder });
            }

            if (errors.length > 0 && validCylinders.length === 0) {
              return {
                statusCode: 422,
                body: {
                  error: "return_validation_failed",
                  message: "所有钢瓶校验失败，未执行归还操作",
                  errors
                }
              };
            }

            const validCylinderIds = validCylinders.map((v) => v.orderCylinder.id);

            ctx.setBeforeState({
              order: snapshotEntity(order),
              cylinders: cylinderSnapshotsBefore
            });

            for (const { orderCylinder, cylinder } of validCylinders) {
              const actionInput = {
                type: "return",
                location: input.returnLocation || "待检区",
                depositStatus: input.depositRefunded ? "refunded" : "refundable",
                note: `订单归还${input.note ? " - " + input.note : ""}`,
                operator: auth.user?.username
              };
              const evt = applyAction(cylinder, actionInput);
              eventIds.push(evt.id);
            }

            ctx.captureEventIds(eventIds);

            const returnRecord = returnOrderCylinders(order, {
              cylinderIds: validCylinderIds,
              returnLocation: input.returnLocation || "待检区",
              depositRefunded: input.depositRefunded || false,
              note: input.note || "",
              operator: auth.user?.username
            });

            return {
              statusCode: errors.length > 0 ? 207 : 200,
              body: {
                orderId: order.id,
                orderStatus: order.status,
                returnedCount: order.returnedCount,
                totalCylinders: order.cylinders.length,
                returnRecord,
                returnedCylinders: returnRecord.cylinders,
                errors: errors.length > 0 ? errors : undefined
              }
            };
          }
        );
      }
    });
  }

  const detailMatch = url.pathname.match(/^\/rental-orders\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = detailMatch;
    const { loadOrders } = await import("../store/rentalOrders.js");
    const orders = await loadOrders();
    const order = findOrder(orders, id);
    if (!order) return send(res, 404, { error: "order_not_found" });
    return send(res, 200, order);
  }

  const customerOrdersMatch = url.pathname.match(/^\/customers\/([^/]+)\/orders$/);
  if (customerOrdersMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, customerId] = customerOrdersMatch;
    const { loadCustomers } = await import("../store/customers.js");
    const customers = await loadCustomers();
    const customer = findCustomer(customers, customerId);
    if (!customer) return send(res, 404, { error: "customer_not_found" });
    const { loadOrders } = await import("../store/rentalOrders.js");
    const orders = await loadOrders();
    const customerOrders = findOrdersByCustomer(orders, customerId);
    return send(res, 200, customerOrders);
  }

  const listMatch = url.pathname === "/rental-orders";
  if (listMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const { loadOrders } = await import("../store/rentalOrders.js");
    const orders = await loadOrders();
    return send(res, 200, orders);
  }

  return null;
}
