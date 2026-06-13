import { loadJson, saveJson, genId } from "./common.js";

const FILE = "rentalOrders.json";
const SEED = { orders: [] };

export async function loadOrders() {
  const db = await loadJson(FILE, SEED);
  return db.orders;
}

export async function saveOrders(orders) {
  await saveJson(FILE, { orders });
}

export function findOrder(orders, id) {
  return orders.find((o) => o.id === id) || null;
}

export function findOrdersByCustomer(orders, customerId) {
  return orders.filter((o) => o.customerId === customerId);
}

export function createOrder({ customer, cylinders, note }) {
  return {
    id: genId("RO"),
    customerId: customer.id,
    customerName: customer.name,
    cylinderCount: cylinders.length,
    cylinders: cylinders.map((c) => ({
      id: c.id,
      gasType: c.gasType,
      capacity: c.capacity,
      depositStatus: c.depositStatus || "paid"
    })),
    note: note || "",
    status: "completed",
    createdAt: new Date().toISOString()
  };
}
