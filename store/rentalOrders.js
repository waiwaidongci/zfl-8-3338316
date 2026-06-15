import { loadJson, saveJson, genId, withJsonTx } from "./common.js";
import { addStatusHistory } from "./compatibility.js";

const FILE = "rentalOrders.json";
export const SEED = { orders: [] };

export async function loadOrders() {
  const db = await loadJson(FILE, SEED);
  return db.orders;
}

export async function saveOrders(orders) {
  await saveJson(FILE, { orders });
}

export async function withOrdersTx(mutator) {
  return withJsonTx(FILE, SEED, async (db) => {
    return mutator(db.orders);
  });
}

export function findOrder(orders, id) {
  return orders.find((o) => o.id === id) || null;
}

export function findOrdersByCustomer(orders, customerId) {
  return orders.filter((o) => o.customerId === customerId);
}

export function createOrder({ customer, cylinders, note, operator }) {
  const now = new Date().toISOString();
  const order = {
    id: genId("RO"),
    customerId: customer.id,
    customerName: customer.name,
    cylinderCount: cylinders.length,
    cylinders: cylinders.map((c) => ({
      id: c.id,
      gasType: c.gasType,
      capacity: c.capacity,
      depositStatus: c.depositStatus || "paid",
      returned: false,
      returnedAt: null,
      returnNote: ""
    })),
    note: note || "",
    status: "completed",
    returnedCount: 0,
    returnHistory: [],
    createdAt: now,
    statusHistory: [
      {
        id: `sh-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fromStatus: null,
        toStatus: "completed",
        at: now,
        note: "订单创建" + (note ? `：${note}` : ""),
        operator: operator || null,
        eventId: null,
        extra: null
      }
    ]
  };
  return order;
}

export function calculateOrderStatus(order) {
  if (!order || !Array.isArray(order.cylinders)) return "completed";
  const returnedCount = order.cylinders.filter((c) => c.returned).length;
  if (returnedCount === 0) return "completed";
  if (returnedCount >= order.cylinders.length) return "fully_returned";
  return "partially_returned";
}

export function returnOrderCylinders(order, { cylinderIds, returnLocation, depositRefunded, note, operator }) {
  const returnedAt = new Date().toISOString();
  const returnRecord = {
    id: genId("RR"),
    returnedAt,
    location: returnLocation || "待检区",
    depositRefunded: depositRefunded || false,
    note: note || "",
    cylinders: []
  };

  const fromStatus = order.status;

  for (const cylinderId of cylinderIds) {
    const orderCylinder = order.cylinders.find((c) => c.id === cylinderId);
    if (!orderCylinder) continue;
    if (orderCylinder.returned) continue;
    orderCylinder.returned = true;
    orderCylinder.returnedAt = returnedAt;
    orderCylinder.returnNote = note || "";
    if (depositRefunded) {
      orderCylinder.depositStatus = "refunded";
    } else {
      orderCylinder.depositStatus = orderCylinder.depositStatus || "paid";
    }
    returnRecord.cylinders.push({
      id: orderCylinder.id,
      gasType: orderCylinder.gasType,
      capacity: orderCylinder.capacity,
      depositStatus: orderCylinder.depositStatus
    });
  }

  order.returnedCount = order.cylinders.filter((c) => c.returned).length;
  if (!Array.isArray(order.returnHistory)) {
    order.returnHistory = [];
  }
  order.returnHistory.unshift(returnRecord);
  const newStatus = calculateOrderStatus(order);
  order.status = newStatus;

  addStatusHistory(order, {
    fromStatus,
    toStatus: newStatus,
    at: returnedAt,
    note: `归还钢瓶 ${returnRecord.cylinders.length} 个` + (note ? `：${note}` : ""),
    operator: operator || null,
    eventId: returnRecord.id,
    extra: { returnId: returnRecord.id }
  });

  return returnRecord;
}
