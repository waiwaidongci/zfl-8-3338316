import { send, body, getParsedBody } from "../store/common.js";
import { loadCylinders, withCylindersTx, findCylinder, createCylinder, applyAction, addFill, buildAlerts } from "../store/cylinders.js";
import { validateCylinderBatch } from "../store/bulkImport.js";
import { checkQueryAuth, checkActionAuth } from "./auth.js";
import { PERMISSIONS, ROLE_LABELS } from "../auth/users.js";
import { executeWithIdempotency } from "../store/idempotencyExecutor.js";
import { OPERATION_TYPES, TARGET_TYPES, snapshotEntity } from "../store/operationLog.js";
import { getDashboard } from "../store/dashboard.js";

const ACTION_PERMISSION_MAP = {
  inbound: PERMISSIONS.CYLINDER_INBOUND,
  outbound: PERMISSIONS.CYLINDER_OUTBOUND,
  return: PERMISSIONS.CYLINDER_RETURN,
  inspect: PERMISSIONS.CYLINDER_INSPECT,
  scrap: PERMISSIONS.CYLINDER_SCRAP,
  mark_pending_check: PERMISSIONS.CYLINDER_SCRAP,
  clear_pending_check: PERMISSIONS.CYLINDER_INBOUND
};

async function dynamicActionAuth(req, res) {
  const input = getParsedBody(req) || (await body(req));
  const perm = ACTION_PERMISSION_MAP[input.type];
  if (!perm) {
    return { authorized: true, skipCheck: true };
  }
  const result = await checkActionAuth(req, res, perm);
  return result;
}

export async function handleCylinders(req, res, url) {
  if (req.method === "GET" && url.pathname === "/cylinders") {
    const status = url.searchParams.get("status");
    const gasType = url.searchParams.get("gasType");
    const location = url.searchParams.get("location");
    const customer = url.searchParams.get("customer");
    const inspectionDueBefore = url.searchParams.get("inspectionDueBefore");
    const keyword = url.searchParams.get("keyword");
    const pagination = url.searchParams.get("pagination");
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const pageSize = parseInt(url.searchParams.get("pageSize") || "20", 10);

    let cylinders = await loadCylinders();

    if (status) cylinders = cylinders.filter((item) => item.status === status);
    if (gasType) cylinders = cylinders.filter((item) => item.gasType === gasType);
    if (location) cylinders = cylinders.filter((item) => item.location === location);
    if (customer !== null && customer !== undefined) {
      if (customer === "") {
        cylinders = cylinders.filter((item) => !item.customer);
      } else {
        cylinders = cylinders.filter((item) => item.customer === customer);
      }
    }
    if (inspectionDueBefore) {
      const cutoffDate = new Date(inspectionDueBefore);
      cylinders = cylinders.filter((item) => {
        if (!item.inspectionDue) return false;
        return new Date(item.inspectionDue) <= cutoffDate;
      });
    }
    if (keyword) {
      const kw = keyword.toLowerCase();
      cylinders = cylinders.filter((item) => {
        const searchableFields = [
          item.id,
          item.gasType,
          item.capacity,
          item.location,
          item.customer
        ].filter(Boolean).map((v) => String(v).toLowerCase());
        return searchableFields.some((field) => field.includes(kw));
      });
    }

    const total = cylinders.length;

    if (pagination) {
      const validPage = Math.max(1, Number.isNaN(page) ? 1 : page);
      const validPageSize = Math.max(1, Math.min(100, Number.isNaN(pageSize) ? 20 : pageSize));
      const totalPages = Math.ceil(total / validPageSize);
      const start = (validPage - 1) * validPageSize;
      const items = cylinders.slice(start, start + validPageSize);
      return send(res, 200, {
        items,
        total,
        page: validPage,
        pageSize: validPageSize,
        totalPages
      });
    }

    return send(res, 200, cylinders);
  }

  if (req.method === "GET" && url.pathname === "/reports/alerts") {
    const inspectionDays = Number(url.searchParams.get("inspectionDays") || 45);
    const longRentDays = Number(url.searchParams.get("longRentDays") || 30);
    const cylinders = await loadCylinders();
    const alerts = buildAlerts(cylinders, { inspectionDays, longRentDays });
    return send(res, 200, alerts);
  }

  if (req.method === "GET" && url.pathname === "/reports/dashboard") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const inspectionDays = Number(url.searchParams.get("inspectionDays") || 45);
    const longRentDays = Number(url.searchParams.get("longRentDays") || 30);
    const dashboard = await getDashboard({ inspectionDays, longRentDays });
    return send(res, 200, dashboard);
  }

  if (req.method === "POST" && url.pathname === "/cylinders") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.CYLINDER_CREATE);
    if (!auth.authorized) return true;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.CYLINDER_CREATE,
      targetType: TARGET_TYPES.CYLINDER,
      operation: async (ctx) => {
        const input = await body(req);
        if (!input.id || !input.gasType) {
          return { statusCode: 400, body: { error: "id_and_gasType_required" } };
        }
        return withCylindersTx(async (cylinders) => {
          const existing = findCylinder(cylinders, input.id);
          if (existing) {
            return { statusCode: 409, body: { error: "cylinder_id_exists" } };
          }
          const cylinder = createCylinder(input);
          const eventIds = cylinder.events.map((e) => e.id);
          ctx.captureEventIds(eventIds);
          cylinders.push(cylinder);
          return { statusCode: 201, body: cylinder };
        });
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/cylinders/bulk") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.CYLINDER_BULK);
    if (!auth.authorized) return true;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.CYLINDER_BULK_CREATE,
      targetType: TARGET_TYPES.CYLINDER,
      operation: async (ctx) => {
        const input = await body(req);
        const inputBatch = Array.isArray(input) ? input : input.items || [];
        return withCylindersTx(async (cylinders) => {
          const result = validateCylinderBatch(inputBatch, cylinders);
          if (result.validCount === 0) {
            return {
              statusCode: 422,
              body: {
                error: "batch_validation_failed",
                totalCount: result.totalCount,
                validCount: 0,
                errors: result.errors,
                summary: result.summary
              }
            };
          }
          const allEventIds = [];
          for (const c of result.valid) {
            c.events.forEach((e) => allEventIds.push(e.id));
            cylinders.push(c);
          }
          ctx.captureEventIds(allEventIds);
          return {
            statusCode: 201,
            body: {
              totalCount: result.totalCount,
              validCount: result.validCount,
              errorCount: result.errorCount,
              inserted: result.validCount,
              cylinders: result.valid,
              errors: result.errors,
              summary: result.summary
            }
          };
        });
      }
    });
  }

  const match = url.pathname.match(/^\/cylinders\/([^/]+)$/);
  if (match && req.method === "GET") {
    const [, id] = match;
    const cylinders = await loadCylinders();
    const cylinder = findCylinder(cylinders, id);
    if (!cylinder) return send(res, 404, { error: "cylinder_not_found" });
    return send(res, 200, cylinder);
  }

  const actionMatch = url.pathname.match(/^\/cylinders\/([^/]+)\/(actions|fills)$/);
  if (actionMatch) {
    const [, id, action] = actionMatch;

    if (req.method === "POST" && action === "actions") {
      await body(req);
      const input = getParsedBody(req) || {};
      const perm = ACTION_PERMISSION_MAP[input.type];
      let auth;
      if (perm) {
        auth = await checkActionAuth(req, res, perm);
        if (!auth.authorized) return true;
      } else {
        auth = await checkActionAuth(req, res, PERMISSIONS.CYLINDER_INBOUND);
        if (!auth.authorized) return true;
      }
      return executeWithIdempotency(req, res, url, {
        auth,
        operationType: OPERATION_TYPES.CYLINDER_ACTION,
        targetType: TARGET_TYPES.CYLINDER,
        targetIdExtractor: () => id,
        operation: async (ctx) => {
          const actionInput = await body(req);
          return withCylindersTx(async (cylinders) => {
            const cylinder = findCylinder(cylinders, id);
            if (!cylinder) {
              return { statusCode: 404, body: { error: "cylinder_not_found" } };
            }
            ctx.setBeforeState(snapshotEntity(cylinder));
            let evt;
            try {
              evt = applyAction(cylinder, actionInput);
            } catch (err) {
              if (err.statusCode) {
                return { statusCode: err.statusCode, body: { error: err.message } };
              }
              throw err;
            }
            ctx.captureEventId(evt.id);
            return { statusCode: 200, body: cylinder };
          });
        }
      });
    }

    if (req.method === "POST" && action === "fills") {
      const auth = await checkActionAuth(req, res, PERMISSIONS.CYLINDER_FILL);
      if (!auth.authorized) return true;
      await body(req);
      return executeWithIdempotency(req, res, url, {
        auth,
        operationType: OPERATION_TYPES.CYLINDER_FILL,
        targetType: TARGET_TYPES.CYLINDER,
        targetIdExtractor: () => id,
        operation: async (ctx) => {
          const input = await body(req);
          return withCylindersTx(async (cylinders) => {
            const cylinder = findCylinder(cylinders, id);
            if (!cylinder) {
              return { statusCode: 404, body: { error: "cylinder_not_found" } };
            }
            ctx.setBeforeState(snapshotEntity(cylinder));
            const { fill, event: evt } = addFill(cylinder, input);
            ctx.captureEventId(evt.id);
            return { statusCode: 201, body: fill };
          });
        }
      });
    }
  }

  return null;
}
