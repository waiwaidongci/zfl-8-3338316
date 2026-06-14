import { loadJson, saveJson, genId, withJsonTx } from "./common.js";

const FILE = "customers.json";
export const SEED = {
  customers: [
    {
      id: "CUS-001",
      name: "宁川检测",
      contact: "张经理",
      phone: "13800000001",
      address: "宁川市工业园区12号",
      createdAt: "2026-01-15T09:00:00.000Z"
    },
    {
      id: "CUS-002",
      name: "恒远焊接",
      contact: "李主管",
      phone: "13800000002",
      address: "宁川市东路88号",
      createdAt: "2026-02-20T10:00:00.000Z"
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

export async function withCustomersTx(mutator) {
  return withJsonTx(FILE, SEED, async (db) => {
    return mutator(db.customers);
  });
}

export function findCustomer(customers, id) {
  return customers.find((c) => c.id === id) || null;
}

export function findCustomerByName(customers, name) {
  return customers.find((c) => c.name === name) || null;
}

export function createCustomer(input) {
  return {
    id: input.id || genId("CUS"),
    name: input.name,
    contact: input.contact || null,
    phone: input.phone || null,
    address: input.address || null,
    createdAt: new Date().toISOString()
  };
}
