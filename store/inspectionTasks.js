import { loadJson, saveJson, genId, makeEvent, withJsonTx } from "./common.js";
import { addStatusHistory } from "./compatibility.js";

const FILE = "inspectionTasks.json";
export const SEED = { tasks: [] };
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

export async function withTasksTx(mutator) {
  return withJsonTx(FILE, SEED, async (db) => {
    return mutator(db.tasks);
  });
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
    restockedAt: null,
    postponements: [],
    statusHistory: [
      {
        id: `sh-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fromStatus: null,
        toStatus: "pending",
        at: now,
        note: `检验任务创建，到期日期：${c.inspectionDue}`,
        operator: options.operator || null,
        eventId: null,
        extra: { generated: true, thresholdDays }
      }
    ]
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
  const fromTaskStatus = task.status;
  const fromCylinderStatus = cylinder.status;
  const now = new Date().toISOString();
  task.status = "sent";
  task.sentAt = now;
  cylinder.status = "inspection";
  cylinder.location = input.location || "送检中";
  const evt = makeEvent("inspect", `送检，任务${task.id}`);
  cylinder.events.push(evt);
  addStatusHistory(task, {
    fromStatus: fromTaskStatus,
    toStatus: "sent",
    at: now,
    note: `送检，库位：${input.location || "送检中"}`,
    operator: input.operator || null,
    extra: { cylinderId: cylinder.id }
  });
  addStatusHistory(cylinder, {
    fromStatus: fromCylinderStatus,
    toStatus: "inspection",
    at: now,
    note: `送检，任务${task.id}`,
    operator: input.operator || null,
    eventId: evt.id
  });
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
  const fromTaskStatus = task.status;
  const fromCylinderStatus = cylinder.status;
  task.status = nextStatus;
  task.inspectedAt = now;
  task.result = {
    passed: input.passed,
    inspector: input.inspector || null,
    notes: input.notes || null,
    nextInspectionDue: input.passed ? (input.nextInspectionDue || null) : null
  };

  let cylinderEvt;
  if (input.passed) {
    if (input.nextInspectionDue) {
      cylinder.inspectionDue = input.nextInspectionDue;
    }
    cylinderEvt = makeEvent("inspect_pass", `检验合格，任务${task.id}${input.inspector ? "，检验员：" + input.inspector : ""}`);
    cylinder.events.push(cylinderEvt);
  } else {
    cylinder.status = "scrapped";
    cylinder.location = "报废区";
    cylinderEvt = makeEvent("inspect_fail", `检验不合格，已报废，任务${task.id}${input.inspector ? "，检验员：" + input.inspector : ""}`);
    cylinder.events.push(cylinderEvt);
  }

  addStatusHistory(task, {
    fromStatus: fromTaskStatus,
    toStatus: nextStatus,
    at: now,
    note: input.passed
      ? `检验合格${input.inspector ? "，检验员：" + input.inspector : ""}`
      : `检验不合格，已报废${input.inspector ? "，检验员：" + input.inspector : ""}`,
    operator: input.inspector || null,
    extra: { cylinderId: cylinder.id, passed: input.passed }
  });

  if (!input.passed) {
    addStatusHistory(cylinder, {
      fromStatus: fromCylinderStatus,
      toStatus: "scrapped",
      at: now,
      note: `检验不合格报废，任务${task.id}`,
      operator: input.inspector || null,
      eventId: cylinderEvt.id
    });
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

  const now = new Date().toISOString();
  const fromTaskStatus = task.status;
  const fromCylinderStatus = cylinder.status;
  task.status = "restocked";
  task.restockedAt = now;
  cylinder.status = "in_stock";
  cylinder.location = input.location || "仓库";
  cylinder.customer = null;
  cylinder.depositStatus = "none";
  const evt = makeEvent("inbound", `检验完成恢复入库，任务${task.id}`);
  cylinder.events.push(evt);

  addStatusHistory(task, {
    fromStatus: fromTaskStatus,
    toStatus: "restocked",
    at: now,
    note: `检验完成回库，库位：${input.location || "仓库"}`,
    operator: input.operator || null,
    extra: { cylinderId: cylinder.id }
  });
  addStatusHistory(cylinder, {
    fromStatus: fromCylinderStatus,
    toStatus: "in_stock",
    at: now,
    note: `检验完成恢复入库，任务${task.id}`,
    operator: input.operator || null,
    eventId: evt.id
  });
}

export function canPostpone(task, cylinder) {
  if (cylinder.status === "scrapped") return false;
  if (task.status === "failed" || task.status === "restocked") return false;
  if (task.status === "passed") return false;
  return true;
}

export function applyPostpone(task, cylinder, input) {
  if (!input || !input.newInspectionDue) {
    const err = new Error("newInspectionDue_required");
    err.statusCode = 400;
    throw err;
  }
  if (!input.reason || typeof input.reason !== "string" || input.reason.trim().length === 0) {
    const err = new Error("reason_required");
    err.statusCode = 400;
    throw err;
  }

  const newDueDate = new Date(input.newInspectionDue);
  if (isNaN(newDueDate.getTime())) {
    const err = new Error("invalid_newInspectionDue");
    err.statusCode = 400;
    throw err;
  }

  if (cylinder.status === "scrapped") {
    const err = new Error("cylinder_scrapped_cannot_postpone");
    err.statusCode = 422;
    throw err;
  }
  if (task.status === "failed" || task.status === "restocked") {
    const err = new Error(`task_${task.status}_cannot_postpone`);
    err.statusCode = 422;
    throw err;
  }
  if (task.status === "passed") {
    const err = new Error("task_passed_cannot_postpone");
    err.statusCode = 422;
    throw err;
  }

  const oldInspectionDue = task.inspectionDue;
  const now = new Date().toISOString();
  const newDue = newDueDate.toISOString().slice(0, 10);

  task.inspectionDue = newDue;

  if (!task.postponements) {
    task.postponements = [];
  }
  const postponement = {
    id: genId("P"),
    oldInspectionDue,
    newInspectionDue: newDue,
    reason: input.reason,
    postponedAt: now,
    operator: input.operator || null
  };
  task.postponements.push(postponement);

  addStatusHistory(task, {
    fromStatus: task.status,
    toStatus: task.status,
    at: now,
    note: `延期检验，原因：${input.reason}，新到检日期：${newDue}`,
    operator: input.operator || null,
    extra: { postponementId: postponement.id, oldInspectionDue, newInspectionDue: newDue }
  });

  cylinder.inspectionDue = newDue;
  const evt = makeEvent("inspect_postpone", `检验延期，任务${task.id}，原因：${input.reason}，新到检日期：${newDue}`);
  cylinder.events.push(evt);
}
