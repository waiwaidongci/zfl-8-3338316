import { send, body, withMultiJsonTx } from "../store/common.js";
import { SEED as CYLINDERS_SEED } from "../store/cylinders.js";
import { SEED as CHECKS_SEED } from "../store/inventoryChecks.js";
import {
  loadChecks,
  findCheck,
  createCheck,
  applyStart,
  applyScan,
  applyBatchScan,
  applyComplete,
  applyConfirm,
  computeDifferences,
  generateSuggestions,
  getCheckHistory
} from "../store/inventoryChecks.js";
import { loadCylinders, findCylinder } from "../store/cylinders.js";
import { checkQueryAuth, checkActionAuth } from "./auth.js";
import { PERMISSIONS } from "../auth/users.js";
import { executeWithIdempotency } from "../store/idempotencyExecutor.js";
import { OPERATION_TYPES, TARGET_TYPES, snapshotEntity } from "../store/operationLog.js";

const CYLINDERS_FILE = "cylinders.json";
const CHECKS_FILE = "inventoryChecks.json";

export async function handleInventoryChecks(req, res, url) {
  if (req.method === "GET" && url.pathname === "/inventory-checks") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const status = url.searchParams.get("status");
    let checks = await loadChecks();
    if (status) checks = checks.filter((c) => c.status === status);
    return send(res, 200, checks);
  }

  if (req.method === "POST" && url.pathname === "/inventory-checks") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INVENTORY_CREATE);
    if (!auth.authorized) return true;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INVENTORY_CREATE,
      targetType: TARGET_TYPES.INVENTORY_CHECK,
      operation: async (ctx) => {
        const input = await body(req);
        const cylinders = await loadCylinders();
        const check = createCheck(input, cylinders);
        const eventIds = [];
        ctx.captureEventIds(eventIds);
        return withMultiJsonTx(
          [
            { filename: CHECKS_FILE, fallback: CHECKS_SEED }
          ],
          async (dbs) => {
            const checks = dbs[CHECKS_FILE].checks;
            checks.push(check);
            return { statusCode: 201, body: check };
          }
        );
      }
    });
  }

  const detailMatch = url.pathname.match(/^\/inventory-checks\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = detailMatch;
    const checks = await loadChecks();
    const check = findCheck(checks, id);
    if (!check) return send(res, 404, { error: "check_not_found" });
    return send(res, 200, check);
  }

  const startMatch = url.pathname.match(/^\/inventory-checks\/([^/]+)\/start$/);
  if (startMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INVENTORY_SCAN);
    if (!auth.authorized) return true;
    const [, id] = startMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INVENTORY_START,
      targetType: TARGET_TYPES.INVENTORY_CHECK,
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        return withMultiJsonTx(
          [{ filename: CHECKS_FILE, fallback: CHECKS_SEED }],
          async (dbs) => {
            const checks = dbs[CHECKS_FILE].checks;
            const check = findCheck(checks, id);
            if (!check) return { statusCode: 404, body: { error: "check_not_found" } };
            ctx.setBeforeState(snapshotEntity(check));
            try {
              applyStart(check);
            } catch (err) {
              if (err.statusCode) return { statusCode: err.statusCode, body: { error: err.message } };
              throw err;
            }
            return { statusCode: 200, body: check };
          }
        );
      }
    });
  }

  const scanMatch = url.pathname.match(/^\/inventory-checks\/([^/]+)\/scan$/);
  if (scanMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INVENTORY_SCAN);
    if (!auth.authorized) return true;
    const [, id] = scanMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INVENTORY_SCAN,
      targetType: TARGET_TYPES.INVENTORY_CHECK,
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        const input = await body(req);
        if (Array.isArray(input.cylinderIds)) {
          return withMultiJsonTx(
            [{ filename: CHECKS_FILE, fallback: CHECKS_SEED }],
            async (dbs) => {
              const checks = dbs[CHECKS_FILE].checks;
              const check = findCheck(checks, id);
              if (!check) return { statusCode: 404, body: { error: "check_not_found" } };
              ctx.setBeforeState(snapshotEntity(check));
              let entries;
              try {
                entries = applyBatchScan(check, input.cylinderIds, input.operator);
              } catch (err) {
                if (err.statusCode) return { statusCode: err.statusCode, body: { error: err.message } };
                throw err;
              }
              return { statusCode: 200, body: { check, entries } };
            }
          );
        }
        return withMultiJsonTx(
          [{ filename: CHECKS_FILE, fallback: CHECKS_SEED }],
          async (dbs) => {
            const checks = dbs[CHECKS_FILE].checks;
            const check = findCheck(checks, id);
            if (!check) return { statusCode: 404, body: { error: "check_not_found" } };
            ctx.setBeforeState(snapshotEntity(check));
            let entry;
            try {
              entry = applyScan(check, input);
            } catch (err) {
              if (err.statusCode) return { statusCode: err.statusCode, body: { error: err.message } };
              throw err;
            }
            return { statusCode: 200, body: { check, entry } };
          }
        );
      }
    });
  }

  const completeMatch = url.pathname.match(/^\/inventory-checks\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INVENTORY_COMPLETE);
    if (!auth.authorized) return true;
    const [, id] = completeMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INVENTORY_COMPLETE,
      targetType: TARGET_TYPES.INVENTORY_CHECK,
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: CHECKS_FILE, fallback: CHECKS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const checks = dbs[CHECKS_FILE].checks;
            const check = findCheck(checks, id);
            if (!check) return { statusCode: 404, body: { error: "check_not_found" } };
            ctx.setBeforeState(snapshotEntity(check));
            try {
              applyComplete(check, cylinders);
            } catch (err) {
              if (err.statusCode) return { statusCode: err.statusCode, body: { error: err.message } };
              throw err;
            }
            return { statusCode: 200, body: check };
          }
        );
      }
    });
  }

  const diffMatch = url.pathname.match(/^\/inventory-checks\/([^/]+)\/differences$/);
  if (diffMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = diffMatch;
    const checks = await loadChecks();
    const check = findCheck(checks, id);
    if (!check) return send(res, 404, { error: "check_not_found" });

    if (check.differences) {
      return send(res, 200, {
        differences: check.differences,
        suggestions: check.suggestions
      });
    }

    const cylinders = await loadCylinders();
    const differences = computeDifferences(check, cylinders);
    const suggestions = generateSuggestions(differences);
    return send(res, 200, { differences, suggestions });
  }

  const confirmMatch = url.pathname.match(/^\/inventory-checks\/([^/]+)\/confirm$/);
  if (confirmMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INVENTORY_CONFIRM);
    if (!auth.authorized) return true;
    const [, id] = confirmMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INVENTORY_CONFIRM,
      targetType: TARGET_TYPES.INVENTORY_CHECK,
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        const input = await body(req);
        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: CHECKS_FILE, fallback: CHECKS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const checks = dbs[CHECKS_FILE].checks;
            const check = findCheck(checks, id);
            if (!check) return { statusCode: 404, body: { error: "check_not_found" } };
            ctx.setBeforeState({ check: snapshotEntity(check) });
            let affected;
            try {
              affected = applyConfirm(check, cylinders, input.operator || auth.user?.username);
            } catch (err) {
              if (err.statusCode) return { statusCode: err.statusCode, body: { error: err.message } };
              throw err;
            }
            const eventIds = [];
            for (const c of cylinders) {
              const lastEvt = c.events[c.events.length - 1];
              if (lastEvt && lastEvt.type === "inventory_check") {
                eventIds.push(lastEvt.id);
              }
            }
            ctx.captureEventIds(eventIds);
            return { statusCode: 200, body: { check, affectedCylinders: affected } };
          }
        );
      }
    });
  }

  const historyMatch = url.pathname.match(/^\/inventory-checks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = historyMatch;
    const checks = await loadChecks();
    const check = findCheck(checks, id);
    if (!check) return send(res, 404, { error: "check_not_found" });
    const cylinderId = url.searchParams.get("cylinderId");
    if (!cylinderId) {
      return send(res, 400, { error: "cylinderId_query_required" });
    }
    const history = getCheckHistory(checks, cylinderId);
    return send(res, 200, { cylinderId, history });
  }

  const cylinderHistoryMatch = url.pathname.match(/^\/cylinders\/([^/]+)\/inventory-history$/);
  if (cylinderHistoryMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, cylinderId] = cylinderHistoryMatch;
    const checks = await loadChecks();
    const history = getCheckHistory(checks, cylinderId);
    return send(res, 200, { cylinderId, history });
  }

  const reportMatch = url.pathname === "/reports/inventory-summary" && req.method === "GET";
  if (reportMatch) {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const checks = await loadChecks();
    const cylinders = await loadCylinders();
    const completedChecks = checks.filter((c) => c.status === "completed" || c.status === "confirmed");
    const totalChecks = completedChecks.length;
    const confirmedChecks = completedChecks.filter((c) => c.status === "confirmed").length;
    const totalDeficit = completedChecks.reduce((sum, c) => sum + (c.differences?.deficitCount || 0), 0);
    const totalSurplus = completedChecks.reduce((sum, c) => sum + (c.differences?.surplusCount || 0), 0);
    const pendingCheckCylinders = cylinders.filter((c) => c.status === "pending_check").length;
    const recentChecks = completedChecks.slice(-10).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      expectedCount: c.expectedCount,
      deficitCount: c.differences?.deficitCount || 0,
      surplusCount: c.differences?.surplusCount || 0,
      completedAt: c.completedAt,
      confirmedAt: c.confirmedAt
    }));
    return send(res, 200, {
      totalChecks,
      confirmedChecks,
      totalDeficit,
      totalSurplus,
      pendingCheckCylinders,
      recentChecks
    });
  }

  return null;
}
