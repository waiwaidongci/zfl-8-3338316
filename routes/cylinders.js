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
    let cylinders = await loadCylinders();
    if (status) cylinders = cylinders.filter((item) => item.status === status);
    if (gasType) cylinders = cylinders.filter((item) => item.gasType === gasType);
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
