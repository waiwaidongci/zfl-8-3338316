import { loadJson, saveJson, genId } from "./common.js";

const FILE = "customers.json";
const SEED = {
  customers: [
    {
      id: "CU-001",
      name: "宁川检测",
      contact: "李明",
      phone: "13800001111",
      address: "宁川市高新区检测路88号",
      createdAt: "2026-05-01T09:00:00.000Z"
    }
  ]
};

export async function loadCustomers() {
  const db = await loadJson(FILE, SEED);
  return db.customers;
}

export async function saveCustomers(customers) {
  await saveJson(FILE, { customers });
}

export function findCustomer(customers, id) {
  return customers.find((c) => c.id === id) || null;
}

export function findCustomerByName(customers, name) {
  return customers.find((c) => c.name === name) || null;
}

export function createCustomer(customers, input) {
  const customer = {
    id: input.id || genId("CU"),
    name: input.name,
    contact: input.contact || "",
    phone: input.phone || "",
    address: input.address || "",
    createdAt: new Date().toISOString()
  };
  customers.push(customer);
  return customer;
}
