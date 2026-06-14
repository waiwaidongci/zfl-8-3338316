import { loadJson, saveJson, genId, makeEvent } from "./common.js";

const FILE = "inspectionTasks.json";
const SEED = { tasks: [] };
const MS_PER_DAY = 86400000;

const VALID_STATUSES = ["pending", "sent", "passed", "failed", "restocked"];

const ALLOWED_TRANSITIONS = {
  pending: ["sent"],
  sent: ["passed", "failed"],
  passed: ["restocked"],
  failed: [],
  restocked: []
};

export async function loadTasks() {
  const db = await loadJson(FILE, SEED);
  return db.tasks;
}

export async function saveTasks(tasks) {
  await saveJson(FILE, { tasks });
}

export function findTask(tasks, id) {
  return tasks.find((t) => t.id === id) || null;
}

export function findTaskByCylinderId(tasks, cylinderId) {
  return tasks.filter((t) => t.cylinderId === cylinderId);
}

export function findActiveTaskByCylinderId(tasks, cylinderId) {
  return tasks.find(
    (t) => t.cylinderId === cylinderId && !["failed", "restocked"].includes(t.status)
  ) || null;
}

function daysUntil(dateText) {
  return Math.ceil((new Date(dateText).getTime() - Date.now()) / MS_PER_DAY);
}

export function generateTasks(cylinders, existingTasks, options = {}) {
  const thresholdDays = options.thresholdDays ?? 45;
  const excludedStatuses = ["scrapped", "inspection", "rented"];

  const existingActiveCylinderIds = new Set(
    existingTasks
      .filter((t) => !["failed", "restocked"].includes(t.status))
      .map((t) => t.cylinderId)
  );

  let excludedByStatus = 0;
  let excludedByExistingTask = 0;
  let excludedByDueDate = 0;

  const candidates = cylinders.filter((c) => {
    if (excludedStatuses.includes(c.status)) {
      excludedByStatus++;
      return false;
    }
    if (existingActiveCylinderIds.has(c.id)) {
      excludedByExistingTask++;
      return false;
    }
    if (daysUntil(c.inspectionDue) > thresholdDays) {
      excludedByDueDate++;
      return false;
    }
    return true;
  });

  const now = new Date().toISOString();
  const newTasks = candidates.map((c) => ({
    id: genId("IT"),
    cylinderId: c.id,
    gasType: c.gasType,
    capacity: c.capacity,
    inspectionDue: c.inspectionDue,
    status: "pending",
    result: null,
    createdAt: now,
    sentAt: null,
    inspectedAt: null,
    restockedAt: null
  }));

  return {
    newTasks,
    generated: newTasks.length,
    skipped: excludedByStatus + excludedByExistingTask + excludedByDueDate,
    breakdown: {
      byStatus: excludedByStatus,
      byExistingTask: excludedByExistingTask,
      byDueDate: excludedByDueDate
    }
  };
}

export function validateTransition(task, nextStatus) {
  if (!VALID_STATUSES.includes(nextStatus)) {
    const err = new Error("invalid_status");
    err.statusCode = 400;
    throw err;
  }
  if (!ALLOWED_TRANSITIONS[task.status].includes(nextStatus)) {
    const err = new Error(`transition_not_allowed:${task.status}->${nextStatus}`);
    err.statusCode = 409;
    throw err;
  }
}

export function applySend(task, cylinder, input) {
  validateTransition(task, "sent");
  if (cylinder.status === "scrapped") {
    const err = new Error("cylinder_scrapped");
    err.statusCode = 422;
    throw err;
  }
  if (cylinder.status === "rented") {
    const err = new Error("cylinder_rented");
    err.statusCode = 422;
    throw err;
  }
  task.status = "sent";
  task.sentAt = new Date().toISOString();
  cylinder.status = "inspection";
  cylinder.location = input.location || "送检中";
  cylinder.events.push(makeEvent("inspect", `送检，任务${task.id}`));
}

export function applyInspectResult(task, cylinder, input) {
  if (!input || typeof input.passed !== "boolean") {
    const err = new Error("passed_boolean_required");
    err.statusCode = 400;
    throw err;
  }

  const nextStatus = input.passed ? "passed" : "failed";
  validateTransition(task, nextStatus);

  if (cylinder.status === "scrapped") {
    const err = new Error("cylinder_scrapped");
    err.statusCode = 422;
    throw err;
  }
  if (cylinder.status === "rented") {
    const err = new Error("cylinder_rented");
    err.statusCode = 422;
    throw err;
  }

  const now = new Date().toISOString();
  task.status = nextStatus;
  task.inspectedAt = now;
  task.result = {
    passed: input.passed,
    inspector: input.inspector || null,
    notes: input.notes || null,
    nextInspectionDue: input.passed ? (input.nextInspectionDue || null) : null
  };

  if (input.passed) {
    if (input.nextInspectionDue) {
      cylinder.inspectionDue = input.nextInspectionDue;
    }
    cylinder.events.push(makeEvent("inspect_pass", `检验合格，任务${task.id}${input.inspector ? "，检验员：" + input.inspector : ""}`));
  } else {
    cylinder.status = "scrapped";
    cylinder.location = "报废区";
    cylinder.events.push(makeEvent("inspect_fail", `检验不合格，已报废，任务${task.id}${input.inspector ? "，检验员：" + input.inspector : ""}`));
  }
}

export function applyRestock(task, cylinder, input) {
  validateTransition(task, "restocked");

  if (cylinder.status === "scrapped") {
    const err = new Error("cylinder_scrapped_cannot_restock");
    err.statusCode = 422;
    throw err;
  }
  if (cylinder.status === "rented") {
    const err = new Error("cylinder_rented_cannot_restock");
    err.statusCode = 422;
    throw err;
  }
  if (cylinder.status !== "inspection") {
    const err = new Error("cylinder_not_in_inspection");
    err.statusCode = 409;
    throw err;
  }

  task.status = "restocked";
  task.restockedAt = new Date().toISOString();
  cylinder.status = "in_stock";
  cylinder.location = input.location || "仓库";
  cylinder.customer = null;
  cylinder.depositStatus = "none";
  cylinder.events.push(makeEvent("inbound", `检验完成恢复入库，任务${task.id}`));
}
