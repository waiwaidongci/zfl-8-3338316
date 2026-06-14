import { send, body } from "../store/common.js";
import { loadCustomers, withCustomersTx, findCustomer, createCustomer } from "../store/customers.js";
import { loadCylinders, findCylinder } from "../store/cylinders.js";
import { checkQueryAuth, checkActionAuth } from "./auth.js";
import { PERMISSIONS } from "../auth/users.js";
import { executeWithIdempotency } from "../store/idempotencyExecutor.js";
import { OPERATION_TYPES, TARGET_TYPES, snapshotEntity } from "../store/operationLog.js";

export async function handleCustomers(req, res, url) {
  if (req.method === "GET" && url.pathname === "/customers") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const customers = await loadCustomers();
    return send(res, 200, customers);
  }

  if (req.method === "POST" && url.pathname === "/customers") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.CUSTOMER_CREATE);
    if (!auth.authorized) return true;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.CUSTOMER_CREATE,
      targetType: TARGET_TYPES.CUSTOMER,
      operation: async (ctx) => {
        const input = await body(req);
        if (!input.name) {
          return { statusCode: 400, body: { error: "name_required" } };
        }
        return withCustomersTx(async (customers) => {
          const byName = customers.find((c) => c.name === input.name);
          if (byName) {
            return { statusCode: 409, body: { error: "customer_name_exists" } };
          }
          if (input.id) {
            const byId = findCustomer(customers, input.id);
            if (byId) {
              return { statusCode: 409, body: { error: "customer_id_exists" } };
            }
          }
          const customer = createCustomer(input);
          customers.push(customer);
          return { statusCode: 201, body: customer };
        });
      }
    });
  }

  const detailMatch = url.pathname.match(/^\/customers\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = detailMatch;
    const customers = await loadCustomers();
    const customer = findCustomer(customers, id);
    if (!customer) return send(res, 404, { error: "customer_not_found" });
    return send(res, 200, customer);
  }

  const cylindersMatch = url.pathname.match(/^\/customers\/([^/]+)\/cylinders$/);
  if (cylindersMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = cylindersMatch;
    const customers = await loadCustomers();
    const customer = findCustomer(customers, id);
    if (!customer) return send(res, 404, { error: "customer_not_found" });
    const cylinders = await loadCylinders();
    const customerCylinders = cylinders.filter(
      (c) => c.customer === customer.id || c.customer === customer.name
    );
    return send(res, 200, { customer, cylinders: customerCylinders });
  }

  const depositsMatch = url.pathname.match(/^\/customers\/([^/]+)\/deposits$/);
  if (depositsMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = depositsMatch;
    const customers = await loadCustomers();
    const customer = findCustomer(customers, id);
    if (!customer) return send(res, 404, { error: "customer_not_found" });
    const cylinders = await loadCylinders();
    const rented = cylinders.filter(
      (c) => (c.customer === customer.id || c.customer === customer.name) && c.status === "rented"
    );
    const totalDeposit = rented.reduce((sum, c) => {
      if (c.depositStatus === "paid") return sum + 1;
      return sum;
    }, 0);
    return send(res, 200, {
      customer,
      rentedCount: rented.length,
      paidDepositCount: totalDeposit,
      pendingDepositCount: rented.length - totalDeposit,
      cylinders: rented.map((c) => ({
        id: c.id,
        gasType: c.gasType,
        capacity: c.capacity,
        depositStatus: c.depositStatus
      }))
    });
  }

  return null;
}
