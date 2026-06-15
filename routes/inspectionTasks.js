import { send, body, withMultiJsonTx } from "../store/common.js";
import { SEED as CYLINDERS_SEED } from "../store/cylinders.js";
import { SEED as TASKS_SEED } from "../store/inspectionTasks.js";
import {
  findTask,
  generateTasks,
  applySend,
  applyInspectResult,
  applyRestock,
  applyPostpone
} from "../store/inspectionTasks.js";
import { findCylinder } from "../store/cylinders.js";
import { checkQueryAuth, checkActionAuth } from "./auth.js";
import { PERMISSIONS } from "../auth/users.js";
import { executeWithIdempotency } from "../store/idempotencyExecutor.js";
import { OPERATION_TYPES, TARGET_TYPES, snapshotEntity } from "../store/operationLog.js";

const CYLINDERS_FILE = "cylinders.json";
const TASKS_FILE = "inspectionTasks.json";

export async function handleInspectionTasks(req, res, url) {
  if (req.method === "GET" && url.pathname === "/inspection-tasks") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const status = url.searchParams.get("status");
    const cylinderId = url.searchParams.get("cylinderId");
    const { loadTasks } = await import("../store/inspectionTasks.js");
    let tasks = await loadTasks();
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (cylinderId) tasks = tasks.filter((t) => t.cylinderId === cylinderId);
    return send(res, 200, tasks);
  }

  if (req.method === "POST" && url.pathname === "/inspection-tasks/generate") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INSPECTION_GENERATE);
    if (!auth.authorized) return true;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INSPECTION_GENERATE,
      targetType: TARGET_TYPES.INSPECTION_TASK,
      operation: async (ctx) => {
        const input = await body(req);
        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: TASKS_FILE, fallback: TASKS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const tasks = dbs[TASKS_FILE].tasks;
            const result = generateTasks(cylinders, tasks, {
              thresholdDays: input.thresholdDays
            });
            for (const t of result.newTasks) tasks.push(t);
            return {
              statusCode: 201,
              body: {
                generated: result.generated,
                skipped: result.skipped,
                breakdown: result.breakdown,
                tasks: result.newTasks
              }
            };
          }
        );
      }
    });
  }

  const detailMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = detailMatch;
    const { loadTasks } = await import("../store/inspectionTasks.js");
    const tasks = await loadTasks();
    const task = findTask(tasks, id);
    if (!task) return send(res, 404, { error: "task_not_found" });
    return send(res, 200, task);
  }

  const sendMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)\/send$/);
  if (sendMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INSPECTION_SEND);
    if (!auth.authorized) return true;
    const [, id] = sendMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INSPECTION_SEND,
      targetType: TARGET_TYPES.INSPECTION_TASK,
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        const input = await body(req);
        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: TASKS_FILE, fallback: TASKS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const tasks = dbs[TASKS_FILE].tasks;
            const task = findTask(tasks, id);
            if (!task) {
              return { statusCode: 404, body: { error: "task_not_found" } };
            }
            const cylinder = findCylinder(cylinders, task.cylinderId);
            if (!cylinder) {
              return { statusCode: 404, body: { error: "cylinder_not_found" } };
            }
            ctx.setBeforeState({ task: snapshotEntity(task), cylinder: snapshotEntity(cylinder) });
            try {
              applySend(task, cylinder, input);
            } catch (err) {
              if (err.statusCode) {
                return { statusCode: err.statusCode, body: { error: err.message } };
              }
              throw err;
            }
            const eventIds = cylinder.events.slice(-1).map((e) => e.id);
            ctx.captureEventIds(eventIds);
            return { statusCode: 200, body: { task, cylinder } };
          }
        );
      }
    });
  }

  const inspectMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)\/inspect$/);
  if (inspectMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INSPECTION_INSPECT);
    if (!auth.authorized) return true;
    const [, id] = inspectMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INSPECTION_INSPECT,
      targetType: TARGET_TYPES.INSPECTION_TASK,
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        const input = await body(req);
        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: TASKS_FILE, fallback: TASKS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const tasks = dbs[TASKS_FILE].tasks;
            const task = findTask(tasks, id);
            if (!task) {
              return { statusCode: 404, body: { error: "task_not_found" } };
            }
            const cylinder = findCylinder(cylinders, task.cylinderId);
            if (!cylinder) {
              return { statusCode: 404, body: { error: "cylinder_not_found" } };
            }
            ctx.setBeforeState({ task: snapshotEntity(task), cylinder: snapshotEntity(cylinder) });
            try {
              applyInspectResult(task, cylinder, input);
            } catch (err) {
              if (err.statusCode) {
                return { statusCode: err.statusCode, body: { error: err.message } };
              }
              throw err;
            }
            const eventIds = cylinder.events.slice(-1).map((e) => e.id);
            ctx.captureEventIds(eventIds);
            return { statusCode: 200, body: { task, cylinder } };
          }
        );
      }
    });
  }

  const restockMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)\/restock$/);
  if (restockMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INSPECTION_RESTOCK);
    if (!auth.authorized) return true;
    const [, id] = restockMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INSPECTION_RESTOCK,
      targetType: TARGET_TYPES.INSPECTION_TASK,
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        const input = await body(req);
        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: TASKS_FILE, fallback: TASKS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const tasks = dbs[TASKS_FILE].tasks;
            const task = findTask(tasks, id);
            if (!task) {
              return { statusCode: 404, body: { error: "task_not_found" } };
            }
            const cylinder = findCylinder(cylinders, task.cylinderId);
            if (!cylinder) {
              return { statusCode: 404, body: { error: "cylinder_not_found" } };
            }
            ctx.setBeforeState({ task: snapshotEntity(task), cylinder: snapshotEntity(cylinder) });
            try {
              applyRestock(task, cylinder, input);
            } catch (err) {
              if (err.statusCode) {
                return { statusCode: err.statusCode, body: { error: err.message } };
              }
              throw err;
            }
            const eventIds = cylinder.events.slice(-1).map((e) => e.id);
            ctx.captureEventIds(eventIds);
            return { statusCode: 200, body: { task, cylinder } };
          }
        );
      }
    });
  }

  const postponeMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)\/postpone$/);
  if (postponeMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.INSPECTION_POSTPONE);
    if (!auth.authorized) return true;
    const [, id] = postponeMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: OPERATION_TYPES.INSPECTION_POSTPONE,
      targetType: TARGET_TYPES.INSPECTION_TASK,
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        const input = await body(req);
        return withMultiJsonTx(
          [
            { filename: CYLINDERS_FILE, fallback: CYLINDERS_SEED },
            { filename: TASKS_FILE, fallback: TASKS_SEED }
          ],
          async (dbs) => {
            const cylinders = dbs[CYLINDERS_FILE].cylinders;
            const tasks = dbs[TASKS_FILE].tasks;
            const task = findTask(tasks, id);
            if (!task) {
              return { statusCode: 404, body: { error: "task_not_found" } };
            }
            const cylinder = findCylinder(cylinders, task.cylinderId);
            if (!cylinder) {
              return { statusCode: 404, body: { error: "cylinder_not_found" } };
            }
            ctx.setBeforeState({ task: snapshotEntity(task), cylinder: snapshotEntity(cylinder) });
            try {
              applyPostpone(task, cylinder, input);
            } catch (err) {
              if (err.statusCode) {
                return { statusCode: err.statusCode, body: { error: err.message } };
              }
              throw err;
            }
            const eventIds = cylinder.events.slice(-1).map((e) => e.id);
            ctx.captureEventIds(eventIds);
            return { statusCode: 200, body: { task, cylinder } };
          }
        );
      }
    });
  }

  return null;
}
