import { send, body } from "../store/common.js";
import { loadCustomers, saveCustomers, findCustomer, createCustomer } from "../store/customers.js";
import { loadCylinders } from "../store/cylinders.js";

export async function handleCustomers(req, res, url) {
  if (req.method === "POST" && url.pathname === "/customers") {
    const input = await body(req);
    if (!input.name) return send(res, 400, { error: "name_required" });
    const customers = await loadCustomers();
    if (customers.some((c) => c.name === input.name)) {
      return send(res, 409, { error: "customer_name_exists" });
    }
    const customer = createCustomer(customers, input);
    await saveCustomers(customers);
    return send(res, 201, customer);
  }

  if (req.method === "GET" && url.pathname === "/customers") {
    const customers = await loadCustomers();
    return send(res, 200, customers);
  }

  const detailMatch = url.pathname.match(/^\/customers\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const [, id] = detailMatch;
    const customers = await loadCustomers();
    const customer = findCustomer(customers, id);
    if (!customer) return send(res, 404, { error: "customer_not_found" });
    return send(res, 200, customer);
  }

  const cylinderMatch = url.pathname.match(/^\/customers\/([^/]+)\/cylinders$/);
  if (cylinderMatch && req.method === "GET") {
    const [, id] = cylinderMatch;
    const customers = await loadCustomers();
    const customer = findCustomer(customers, id);
    if (!customer) return send(res, 404, { error: "customer_not_found" });
    const cylinders = await loadCylinders();
    const rented = cylinders.filter((c) => c.customer === id && c.status === "rented");
    return send(res, 200, rented);
  }

  const depositMatch = url.pathname.match(/^\/customers\/([^/]+)\/deposits$/);
  if (depositMatch && req.method === "GET") {
    const [, id] = depositMatch;
    const customers = await loadCustomers();
    const customer = findCustomer(customers, id);
    if (!customer) return send(res, 404, { error: "customer_not_found" });
    const cylinders = await loadCylinders();
    const rented = cylinders.filter((c) => c.customer === id && c.status === "rented");
    const summary = {
      customerId: customer.id,
      customerName: customer.name,
      totalRented: rented.length,
      deposits: rented.map((c) => ({
        cylinderId: c.id,
        gasType: c.gasType,
        depositStatus: c.depositStatus
      })),
      depositCounts: {
        paid: rented.filter((c) => c.depositStatus === "paid").length,
        unpaid: rented.filter((c) => c.depositStatus === "unpaid").length,
        refundable: rented.filter((c) => c.depositStatus === "refundable").length,
        none: rented.filter((c) => c.depositStatus === "none").length
      }
    };
    return send(res, 200, summary);
  }

  return null;
}
