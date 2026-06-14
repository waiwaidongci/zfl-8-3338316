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

export async function handleInspectionTasks(req, res, url) {
  if (req.method === "GET" && url.pathname === "/inspection-tasks") {
    const status = url.searchParams.get("status");
    const cylinderId = url.searchParams.get("cylinderId");
    let tasks = await loadTasks();
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (cylinderId) tasks = tasks.filter((t) => t.cylinderId === cylinderId);
    return send(res, 200, tasks);
  }

  if (req.method === "POST" && url.pathname === "/inspection-tasks/generate") {
    const input = await body(req);
    const cylinders = await loadCylinders();
    const existingTasks = await loadTasks();
    const result = generateTasks(cylinders, existingTasks, {
      thresholdDays: input.thresholdDays
    });
    const allTasks = [...existingTasks, ...result.newTasks];
    await saveTasks(allTasks);
    return send(res, 201, {
      generated: result.generated,
      skipped: result.skipped,
      breakdown: result.breakdown,
      tasks: result.newTasks
    });
  }

  const detailMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const [, id] = detailMatch;
    const tasks = await loadTasks();
    const task = findTask(tasks, id);
    if (!task) return send(res, 404, { error: "task_not_found" });
    return send(res, 200, task);
  }

  const sendMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)\/send$/);
  if (sendMatch && req.method === "POST") {
    const [, id] = sendMatch;
    const input = await body(req);
    const tasks = await loadTasks();
    const task = findTask(tasks, id);
    if (!task) return send(res, 404, { error: "task_not_found" });
    const cylinders = await loadCylinders();
    const cylinder = findCylinder(cylinders, task.cylinderId);
    if (!cylinder) return send(res, 404, { error: "cylinder_not_found" });
    try {
      applySend(task, cylinder, input);
    } catch (err) {
      if (err.statusCode) return send(res, err.statusCode, { error: err.message });
      throw err;
    }
    await saveTasks(tasks);
    await saveCylinders(cylinders);
    return send(res, 200, { task, cylinder });
  }

  const inspectMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)\/inspect$/);
  if (inspectMatch && req.method === "POST") {
    const [, id] = inspectMatch;
    const input = await body(req);
    const tasks = await loadTasks();
    const task = findTask(tasks, id);
    if (!task) return send(res, 404, { error: "task_not_found" });
    const cylinders = await loadCylinders();
    const cylinder = findCylinder(cylinders, task.cylinderId);
    if (!cylinder) return send(res, 404, { error: "cylinder_not_found" });
    try {
      applyInspectResult(task, cylinder, input);
    } catch (err) {
      if (err.statusCode) return send(res, err.statusCode, { error: err.message });
      throw err;
    }
    await saveTasks(tasks);
    await saveCylinders(cylinders);
    return send(res, 200, { task, cylinder });
  }

  const restockMatch = url.pathname.match(/^\/inspection-tasks\/([^/]+)\/restock$/);
  if (restockMatch && req.method === "POST") {
    const [, id] = restockMatch;
    const input = await body(req);
    const tasks = await loadTasks();
    const task = findTask(tasks, id);
    if (!task) return send(res, 404, { error: "task_not_found" });
    const cylinders = await loadCylinders();
    const cylinder = findCylinder(cylinders, task.cylinderId);
    if (!cylinder) return send(res, 404, { error: "cylinder_not_found" });
    try {
      applyRestock(task, cylinder, input);
    } catch (err) {
      if (err.statusCode) return send(res, err.statusCode, { error: err.message });
      throw err;
    }
    await saveTasks(tasks);
    await saveCylinders(cylinders);
    return send(res, 200, { task, cylinder });
  }

  return null;
}
