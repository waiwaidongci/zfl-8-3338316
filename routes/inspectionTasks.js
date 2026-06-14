import { send, body } from "../store/common.js";
import { loadCylinders, saveCylinders, findCylinder } from "../store/cylinders.js";
import {
  loadTasks,
  saveTasks,
  findTask,
  generateTasks,
  applySend,
  applyInspectResult,
  applyRestock
} from "../store/inspectionTasks.js";
import { checkQueryAuth, checkActionAuth } from "./auth.js";
import { PERMISSIONS } from "../auth/users.js";
import { executeWithIdempotency } from "../store/idempotencyExecutor.js";
import { OPERATION_TYPES, TARGET_TYPES, snapshotEntity } from "../store/operationLog.js";

export async function handleInspectionTasks(req, res, url) {
  if (req.method === "GET" && url.pathname === "/inspection-tasks") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const status = url.searchParams.get("status");
    const cylinderId = url.searchParams.get("cylinderId");
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
        const cylinders = await loadCylinders();
        const existingTasks = await loadTasks();
        const result = generateTasks(cylinders, existingTasks, {
          thresholdDays: input.thresholdDays
        });
        const allTasks = [...existingTasks, ...result.newTasks];
        await saveTasks(allTasks);
        const response = {
          generated: result.generated,
          skipped: result.skipped,
          breakdown: result.breakdown,
          tasks: result.newTasks
        };
        return { statusCode: 201, body: response };
      }
    });
  }

  const detailMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = detailMatch;
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
        const tasks = await loadTasks();
        const task = findTask(tasks, id);
        if (!task) {
          return { statusCode: 404, body: { error: "task_not_found" } };
        }
        const cylinders = await loadCylinders();
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
        await saveTasks(tasks);
        await saveCylinders(cylinders);
        ctx.captureEventIds(eventIds);
        return { statusCode: 200, body: { task, cylinder } };
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
        const tasks = await loadTasks();
        const task = findTask(tasks, id);
        if (!task) {
          return { statusCode: 404, body: { error: "task_not_found" } };
        }
        const cylinders = await loadCylinders();
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
        await saveTasks(tasks);
        await saveCylinders(cylinders);
        ctx.captureEventIds(eventIds);
        return { statusCode: 200, body: { task, cylinder } };
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
        const tasks = await loadTasks();
        const task = findTask(tasks, id);
        if (!task) {
          return { statusCode: 404, body: { error: "task_not_found" } };
        }
        const cylinders = await loadCylinders();
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
        await saveTasks(tasks);
        await saveCylinders(cylinders);
        ctx.captureEventIds(eventIds);
        return { statusCode: 200, body: { task, cylinder } };
      }
    });
  }

  return null;
}
