import { loadJson, saveJson, genId, withJsonTx, getDataDir } from "./common.js";
import { loadCylinders } from "./cylinders.js";
import { loadCustomers } from "./customers.js";
import { loadOrders } from "./rentalOrders.js";
import { loadTasks } from "./inspectionTasks.js";
import { loadChecks } from "./inventoryChecks.js";
import { queryOperationLogs } from "./operationLog.js";
import { mkdir, readFile, writeFile, unlink, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const FILE = "complianceReports.json";
export const SEED = { reports: [] };

const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RETRY_COUNT = 3;
const PHASE_YIELD_MS = 10;
const CYLINDER_BATCH_SIZE = 100;
const OPLOG_PAGE_SIZE = 500;
const PHASE_INTERNAL_FIELDS = ["_schemaVersion", "_meta", "_migratedFrom"];

const PHASES = [
  { key: "customers", label: "客户数据", depends: [] },
  { key: "orders", label: "租瓶订单", depends: [] },
  { key: "inspections", label: "检验任务", depends: [] },
  { key: "inventory", label: "库存盘点", depends: [] },
  { key: "operationLogs", label: "操作日志", depends: [] },
  { key: "cylinders", label: "钢瓶追溯", depends: ["orders", "inspections", "inventory", "operationLogs"] },
  { key: "finalize", label: "汇总统计", depends: ["customers", "cylinders", "orders", "inspections", "inventory", "operationLogs"] }
];

const PHASE_DATA_FILES = {
  customers: "customers.json",
  orders: "orders.json",
  inspections: "inspections.json",
  inventory: "inventory.json",
  operationLogs: "operationLogs.json",
  cylinders: "cylinders.json",
  finalize: "summary.json"
};

const activeTaskControllers = new Map();

export async function loadReports() {
  const db = await loadJson(FILE, SEED);
  return db.reports;
}

export async function saveReports(reports) {
  await saveJson(FILE, { reports });
}

export async function withReportsTx(mutator) {
  return withJsonTx(FILE, SEED, async (db) => {
    return mutator(db.reports);
  });
}

export function findReport(reports, id) {
  return reports.find((r) => r.id === id) || null;
}

function stripInternalFields(item) {
  if (!item || typeof item !== "object") return item;
  const result = { ...item };
  for (const key of Object.keys(result)) {
    if (key.startsWith("_")) {
      delete result[key];
    }
  }
  if (result._schemaVersion !== undefined) delete result._schemaVersion;
  if (result._meta !== undefined) delete result._meta;
  if (result._migratedFrom !== undefined) delete result._migratedFrom;
  return result;
}

function stripCollectionInternal(collection) {
  if (!Array.isArray(collection)) return collection;
  return collection.map(stripInternalFields);
}

async function getReportDataDir(reportId) {
  const baseDataDir = await getDataDir();
  return join(baseDataDir, "compliance-reports", reportId);
}

async function ensureReportDataDir(reportId) {
  const dir = await getReportDataDir(reportId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writePhaseData(reportId, phaseKey, data) {
  const dir = await ensureReportDataDir(reportId);
  const fileName = PHASE_DATA_FILES[phaseKey];
  const filePath = join(dir, fileName);
  const content = JSON.stringify(data, null, 2);
  await writeFile(filePath, content, "utf-8");
}

async function readPhaseData(reportId, phaseKey) {
  const dir = await getReportDataDir(reportId);
  const fileName = PHASE_DATA_FILES[phaseKey];
  const filePath = join(dir, fileName);
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function phaseDataExists(reportId, phaseKey) {
  const dir = await getReportDataDir(reportId);
  const fileName = PHASE_DATA_FILES[phaseKey];
  const filePath = join(dir, fileName);
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function deletePhaseData(reportId, phaseKey) {
  const dir = await getReportDataDir(reportId);
  const fileName = PHASE_DATA_FILES[phaseKey];
  const filePath = join(dir, fileName);
  try {
    await unlink(filePath);
  } catch {}
}

async function clearAllPhaseData(reportId) {
  const dir = await getReportDataDir(reportId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {}
}

function computePhaseChecksum(phaseKey, params, dataVersion) {
  const input = JSON.stringify({ phaseKey, params, dataVersion });
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function createInitialPhases() {
  const phases = {};
  for (const phase of PHASES) {
    phases[phase.key] = {
      status: "pending",
      startedAt: null,
      completedAt: null,
      itemCount: 0,
      checksum: null,
      error: null
    };
  }
  return phases;
}

async function updateReport(id, updates) {
  return withReportsTx(async (reports) => {
    const report = findReport(reports, id);
    if (!report) return null;
    Object.assign(report, updates);
    return report;
  });
}

async function findReportById(id) {
  const reports = await loadReports();
  return findReport(reports, id);
}

function buildCylinderTraceability(cylinder, ordersMap, tasksMap, checksMap, opLogsByTarget, startAt, endAt) {
  const startTime = startAt ? new Date(startAt).getTime() : 0;
  const endTime = endAt ? new Date(endAt).getTime() : Infinity;

  const statusChanges = (cylinder.events || [])
    .filter((evt) => {
      const t = new Date(evt.at).getTime();
      return t >= startTime && t <= endTime;
    })
    .map((evt) => ({
      type: evt.type,
      at: evt.at,
      note: evt.note || null
    }));

  const relatedOrders = (ordersMap.get(cylinder.id) || [])
    .filter((o) => {
      const t = new Date(o.createdAt).getTime();
      return t >= startTime && t <= endTime;
    })
    .map((o) => ({
      id: o.id,
      customerName: o.customerName,
      cylinderCount: o.cylinderCount,
      createdAt: o.createdAt,
      status: o.status
    }));

  const inspectionRisks = (tasksMap.get(cylinder.id) || [])
    .filter((t) => {
      const timeField = t.inspectedAt || t.createdAt;
      const tVal = new Date(timeField).getTime();
      return tVal >= startTime && tVal <= endTime;
    })
    .map((t) => ({
      id: t.id,
      status: t.status,
      result: t.result,
      inspectedAt: t.inspectedAt,
      risk: t.result && t.result.passed === false ? "high" :
            t.status === "pending" || t.status === "sent" ? "medium" : "low"
    }));

  const inventoryDiscrepancies = [];
  for (const check of checksMap.values()) {
    const timeField = check.completedAt || check.confirmedAt || check.createdAt;
    const tVal = new Date(timeField).getTime();
    if (!(tVal >= startTime && tVal <= endTime)) continue;
    if (check.status !== "completed" && check.status !== "confirmed") continue;
    if (!check.differences) continue;
    const isDeficit = (check.differences.deficit || []).some((d) => d.cylinderId === cylinder.id);
    const isSurplus = (check.differences.surplus || []).some((d) => d.cylinderId === cylinder.id);
    if (isDeficit) {
      inventoryDiscrepancies.push({
        checkId: check.id,
        type: "deficit",
        completedAt: check.completedAt,
        confirmedAt: check.confirmedAt
      });
    }
    if (isSurplus) {
      inventoryDiscrepancies.push({
        checkId: check.id,
        type: "surplus",
        completedAt: check.completedAt,
        confirmedAt: check.confirmedAt
      });
    }
  }

  const relatedOpLogs = (opLogsByTarget.get(cylinder.id) || [])
    .map((l) => ({
      id: l.id,
      operationType: l.operationType,
      operator: l.operator,
      status: l.status,
      createdAt: l.createdAt,
      error: l.error || null
    }));

  const fillsInPeriod = (cylinder.fills || []).filter((f) => {
    if (!f.filledAt) return true;
    const t = new Date(f.filledAt).getTime();
    return t >= startTime && t <= endTime;
  });

  return {
    cylinderId: cylinder.id,
    gasType: cylinder.gasType,
    capacity: cylinder.capacity,
    currentStatus: cylinder.status,
    currentLocation: cylinder.location,
    customer: cylinder.customer || null,
    inspectionDue: cylinder.inspectionDue,
    depositStatus: cylinder.depositStatus,
    statusChanges,
    relatedOrders,
    inspectionRisks,
    inventoryDiscrepancies,
    operators: relatedOpLogs,
    fillsInPeriod: fillsInPeriod.map((f) => ({
      id: f.id,
      filledAt: f.filledAt,
      pressure: f.pressure,
      operator: f.operator
    }))
  };
}

async function executePhaseCustomers(reportId, params) {
  const { startAt, endAt } = params;
  const startTime = startAt ? new Date(startAt).getTime() : 0;
  const endTime = endAt ? new Date(endAt).getTime() : Infinity;

  const customers = stripCollectionInternal(await loadCustomers());
  const customersInPeriod = customers.filter((c) => {
    const t = new Date(c.createdAt).getTime();
    return t >= startTime && t <= endTime;
  });

  await writePhaseData(reportId, "customers", customersInPeriod);
  return { itemCount: customersInPeriod.length };
}

async function executePhaseOrders(reportId, params) {
  const { startAt, endAt } = params;
  const startTime = startAt ? new Date(startAt).getTime() : 0;
  const endTime = endAt ? new Date(endAt).getTime() : Infinity;

  const orders = stripCollectionInternal(await loadOrders());
  const ordersInPeriod = orders.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return t >= startTime && t <= endTime;
  });

  await writePhaseData(reportId, "orders", ordersInPeriod);
  return { itemCount: ordersInPeriod.length };
}

async function executePhaseInspections(reportId, params) {
  const { startAt, endAt } = params;
  const startTime = startAt ? new Date(startAt).getTime() : 0;
  const endTime = endAt ? new Date(endAt).getTime() : Infinity;

  const tasks = stripCollectionInternal(await loadTasks());
  const tasksInPeriod = tasks.filter((t) => {
    const tCreated = new Date(t.createdAt).getTime();
    return tCreated >= startTime && tCreated <= endTime;
  });

  const allInspectionRisks = [];
  for (const t of tasksInPeriod) {
    if (t.result && t.result.passed === false) {
      allInspectionRisks.push({
        taskId: t.id,
        cylinderId: t.cylinderId,
        risk: "high",
        reason: "inspection_failed",
        inspectedAt: t.inspectedAt
      });
    } else if (t.status === "pending" || t.status === "sent") {
      allInspectionRisks.push({
        taskId: t.id,
        cylinderId: t.cylinderId,
        risk: "medium",
        reason: `inspection_${t.status}`,
        createdAt: t.createdAt
      });
    }
  }

  await writePhaseData(reportId, "inspections", {
    tasks: tasksInPeriod,
    risks: allInspectionRisks
  });
  return { itemCount: tasksInPeriod.length };
}

async function executePhaseInventory(reportId, params) {
  const { startAt, endAt } = params;
  const startTime = startAt ? new Date(startAt).getTime() : 0;
  const endTime = endAt ? new Date(endAt).getTime() : Infinity;

  const checks = stripCollectionInternal(await loadChecks());
  const checksInPeriod = checks.filter((c) => {
    const t = new Date(c.createdAt).getTime();
    return t >= startTime && t <= endTime;
  });

  const allDiscrepancies = [];
  for (const check of checksInPeriod) {
    if (!check.differences) continue;
    for (const d of (check.differences.deficit || [])) {
      allDiscrepancies.push({
        checkId: check.id,
        cylinderId: d.cylinderId,
        type: "deficit",
        status: d.status,
        protected: d.protected || false,
        completedAt: check.completedAt
      });
    }
    for (const s of (check.differences.surplus || [])) {
      allDiscrepancies.push({
        checkId: check.id,
        cylinderId: s.cylinderId,
        type: "surplus",
        status: s.status,
        completedAt: check.completedAt
      });
    }
  }

  await writePhaseData(reportId, "inventory", {
    checks: checksInPeriod,
    discrepancies: allDiscrepancies
  });
  return { itemCount: checksInPeriod.length };
}

async function executePhaseOperationLogs(reportId, params) {
  const { startAt, endAt } = params;

  const allLogs = [];
  const operatorSummary = {};
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const opLogResult = await queryOperationLogs({
      startAt: startAt || "",
      endAt: endAt || "",
      page: String(page),
      pageSize: String(OPLOG_PAGE_SIZE)
    });

    const logs = stripCollectionInternal(opLogResult.items || []);
    for (const log of logs) {
      allLogs.push(log);
      const op = log.operator || "unknown";
      if (!operatorSummary[op]) {
        operatorSummary[op] = { operator: op, operationCount: 0, failedCount: 0 };
      }
      operatorSummary[op].operationCount++;
      if (log.status === "failed") operatorSummary[op].failedCount++;
    }

    hasMore = opLogResult.pagination?.hasNext || false;
    page++;

    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, PHASE_YIELD_MS));
    }
  }

  await writePhaseData(reportId, "operationLogs", {
    logs: allLogs,
    operatorSummary: Object.values(operatorSummary)
  });
  return { itemCount: allLogs.length };
}

async function executePhaseCylinders(reportId, params) {
  const { startAt, endAt } = params;

  const cylinders = stripCollectionInternal(await loadCylinders());
  const ordersData = await readPhaseData(reportId, "orders");
  const inspectionsData = await readPhaseData(reportId, "inspections");
  const inventoryData = await readPhaseData(reportId, "inventory");
  const opLogsData = await readPhaseData(reportId, "operationLogs");

  const orders = ordersData || [];
  const tasks = inspectionsData?.tasks || [];
  const checks = inventoryData?.checks || [];
  const opLogs = opLogsData?.logs || [];

  const ordersMap = new Map();
  for (const order of orders) {
    if (order.cylinders) {
      for (const c of order.cylinders) {
        if (!ordersMap.has(c.id)) ordersMap.set(c.id, []);
        ordersMap.get(c.id).push(order);
      }
    }
  }

  const tasksMap = new Map();
  for (const task of tasks) {
    if (!tasksMap.has(task.cylinderId)) tasksMap.set(task.cylinderId, []);
    tasksMap.get(task.cylinderId).push(task);
  }

  const checksMap = new Map();
  for (const check of checks) {
    checksMap.set(check.id, check);
  }

  const opLogsByTarget = new Map();
  for (const log of opLogs) {
    if (log.targetId) {
      if (!opLogsByTarget.has(log.targetId)) opLogsByTarget.set(log.targetId, []);
      opLogsByTarget.get(log.targetId).push(log);
    }
  }

  const cylinderTraceability = [];
  const total = cylinders.length;
  for (let i = 0; i < total; i += CYLINDER_BATCH_SIZE) {
    const batch = cylinders.slice(i, i + CYLINDER_BATCH_SIZE);
    for (const cylinder of batch) {
      cylinderTraceability.push(
        buildCylinderTraceability(cylinder, ordersMap, tasksMap, checksMap, opLogsByTarget, startAt, endAt)
      );
    }

    await withReportsTx(async (reports) => {
      const report = findReport(reports, reportId);
      if (report && report.phases?.cylinders) {
        report.phases.cylinders.itemCount = Math.min(i + batch.length, total);
      }
      if (report) {
        report.progress = {
          step: 6,
          total: PHASES.length,
          message: `处理中: 钢瓶追溯 (${Math.min(i + batch.length, total)}/${total})`
        };
      }
    });

    if (i + CYLINDER_BATCH_SIZE < total) {
      await new Promise((resolve) => setTimeout(resolve, PHASE_YIELD_MS));
    }
  }

  await writePhaseData(reportId, "cylinders", cylinderTraceability);
  return { itemCount: cylinderTraceability.length };
}

async function executePhaseFinalize(reportId, params) {
  const { startAt, endAt } = params;

  const customersData = await readPhaseData(reportId, "customers");
  const cylindersData = await readPhaseData(reportId, "cylinders");
  const ordersData = await readPhaseData(reportId, "orders");
  const inspectionsData = await readPhaseData(reportId, "inspections");
  const inventoryData = await readPhaseData(reportId, "inventory");
  const opLogsData = await readPhaseData(reportId, "operationLogs");

  const customers = customersData || [];
  const cylinders = cylindersData || [];
  const orders = ordersData || [];
  const tasks = inspectionsData?.tasks || [];
  const risks = inspectionsData?.risks || [];
  const checks = inventoryData?.checks || [];
  const discrepancies = inventoryData?.discrepancies || [];
  const opLogs = opLogsData?.logs || [];
  const operatorSummary = opLogsData?.operatorSummary || [];

  const summary = {
    totalCustomers: customers.length,
    totalCylinders: cylinders.length,
    totalOrders: orders.length,
    totalInspectionTasks: tasks.length,
    totalInventoryChecks: checks.length,
    totalOperationLogs: opLogs.length,
    highRiskCount: risks.filter((r) => r.risk === "high").length,
    mediumRiskCount: risks.filter((r) => r.risk === "medium").length,
    discrepancyCount: discrepancies.length
  };

  const result = {
    period: { startAt: startAt || null, endAt: endAt || null },
    generatedAt: new Date().toISOString(),
    summary,
    customers,
    cylinders,
    rentalOrders: orders,
    inspections: tasks,
    inventoryChecks: checks,
    operationLogs: opLogs,
    risks,
    discrepancies,
    operatorSummary
  };

  await writePhaseData(reportId, "finalize", result);
  return { itemCount: 1, summary };
}

async function executePhase(reportId, phaseKey, params, dataVersion) {
  const checksum = computePhaseChecksum(phaseKey, params, dataVersion);

  await updateReport(reportId, {
    currentPhase: phaseKey,
    phaseProgress: {
      current: PHASES.findIndex((p) => p.key === phaseKey) + 1,
      total: PHASES.length
    }
  });

  const phaseDef = PHASES.find((p) => p.key === phaseKey);
  const phaseLabel = phaseDef?.label || phaseKey;

  await withReportsTx(async (reports) => {
    const report = findReport(reports, reportId);
    if (report && report.phases?.[phaseKey]) {
      report.phases[phaseKey].status = "processing";
      report.phases[phaseKey].startedAt = new Date().toISOString();
      report.phases[phaseKey].checksum = checksum;
      report.phases[phaseKey].error = null;
    }
    if (report) {
      report.progress = {
        step: PHASES.findIndex((p) => p.key === phaseKey) + 1,
        total: PHASES.length,
        message: `处理中: ${phaseLabel}`
      };
    }
  });

  let result;
  switch (phaseKey) {
    case "customers":
      result = await executePhaseCustomers(reportId, params);
      break;
    case "orders":
      result = await executePhaseOrders(reportId, params);
      break;
    case "inspections":
      result = await executePhaseInspections(reportId, params);
      break;
    case "inventory":
      result = await executePhaseInventory(reportId, params);
      break;
    case "operationLogs":
      result = await executePhaseOperationLogs(reportId, params);
      break;
    case "cylinders":
      result = await executePhaseCylinders(reportId, params);
      break;
    case "finalize":
      result = await executePhaseFinalize(reportId, params);
      break;
    default:
      throw new Error(`unknown_phase: ${phaseKey}`);
  }

  await withReportsTx(async (reports) => {
    const report = findReport(reports, reportId);
    if (report && report.phases?.[phaseKey]) {
      report.phases[phaseKey].status = "completed";
      report.phases[phaseKey].completedAt = new Date().toISOString();
      report.phases[phaseKey].itemCount = result.itemCount || 0;
    }
    if (report) {
      report.progress = {
        step: PHASES.findIndex((p) => p.key === phaseKey) + 1,
        total: PHASES.length,
        message: `已完成: ${phaseLabel}`
      };
    }
  });

  return result;
}

async function isPhaseCompleted(report, phaseKey) {
  return report.phases?.[phaseKey]?.status === "completed";
}

async function canSkipPhase(report, phaseKey, params, dataVersion) {
  const phaseState = report.phases?.[phaseKey];
  if (!phaseState || phaseState.status !== "completed") return false;

  const expectedChecksum = computePhaseChecksum(phaseKey, params, dataVersion);
  return phaseState.checksum === expectedChecksum;
}

async function executeReportTask(reportId, params, retryCount = 0) {
  const report = await findReportById(reportId);
  if (!report) return;

  if (report.status === "completed") return;

  const controller = { aborted: false };
  activeTaskControllers.set(reportId, controller);

  try {
    const dataVersion = "v3";

    if (report.status !== "processing") {
      await updateReport(reportId, {
        status: "processing",
        startedAt: new Date().toISOString(),
        retryCount
      });
    }

    if (!report.phases) {
      await withReportsTx(async (reports) => {
        const r = findReport(reports, reportId);
        if (r) {
          r.phases = createInitialPhases();
          r.currentPhase = null;
          r.phaseProgress = { current: 0, total: PHASES.length };
        }
      });
    }

    for (const phase of PHASES) {
      if (controller.aborted) {
        await updateReport(reportId, {
          status: "failed",
          error: "task_aborted",
          progress: { step: 0, total: PHASES.length, message: "任务已中止" }
        });
        return;
      }

      const currentReport = await findReportById(reportId);
      const canSkip = await canSkipPhase(currentReport, phase.key, params, dataVersion);

      if (canSkip) {
        continue;
      }

      await executePhase(reportId, phase.key, params, dataVersion);

      await new Promise((resolve) => setTimeout(resolve, PHASE_YIELD_MS));
    }

    const finalData = await readPhaseData(reportId, "finalize");
    await updateReport(reportId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result: finalData,
      progress: { step: PHASES.length, total: PHASES.length, message: "完成" }
    });
  } catch (err) {
    const report = await findReportById(reportId);
    const failedPhase = report?.currentPhase || "unknown";
    const phaseIdx = PHASES.findIndex((p) => p.key === failedPhase);

    await withReportsTx(async (reports) => {
      const r = findReport(reports, reportId);
      if (r && r.phases?.[failedPhase]) {
        r.phases[failedPhase].status = "failed";
        r.phases[failedPhase].error = err.message || "unknown_error";
      }
    });

    await updateReport(reportId, {
      status: "failed",
      error: err.message || "unknown_error",
      failedPhase,
      progress: {
        step: Math.max(0, phaseIdx),
        total: PHASES.length,
        message: `失败 [${failedPhase}]: ${err.message}`
      }
    });
  } finally {
    activeTaskControllers.delete(reportId);
  }
}

export async function createReportTask(params, requestedBy) {
  const id = genId("CR");
  const report = {
    id,
    status: "pending",
    params: {
      startAt: params.startAt || null,
      endAt: params.endAt || null
    },
    requestedBy: requestedBy || null,
    progress: { step: 0, total: PHASES.length, message: "等待处理" },
    phases: createInitialPhases(),
    currentPhase: null,
    phaseProgress: { current: 0, total: PHASES.length },
    result: null,
    error: null,
    failedPhase: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    retryCount: 0,
    lastRetriedAt: null
  };

  await withReportsTx(async (reports) => {
    reports.push(report);
  });

  setImmediate(() => executeReportTask(id, report.params, 0));

  return report;
}

export async function retryReport(reportId, requestedBy) {
  const report = await findReportById(reportId);
  if (!report) {
    const err = new Error("report_not_found");
    err.statusCode = 404;
    throw err;
  }
  if (report.status !== "failed") {
    const err = new Error("only_failed_reports_can_be_retried");
    err.statusCode = 409;
    throw err;
  }
  if (report.retryCount >= MAX_RETRY_COUNT) {
    const err = new Error("max_retry_count_exceeded");
    err.statusCode = 409;
    throw err;
  }

  const newRetryCount = report.retryCount + 1;
  const failedPhase = report.failedPhase;
  const failedPhaseIdx = PHASES.findIndex((p) => p.key === failedPhase);

  const phasesToReset = [];
  for (let i = Math.max(0, failedPhaseIdx); i < PHASES.length; i++) {
    phasesToReset.push(PHASES[i].key);
  }

  for (const phaseKey of phasesToReset) {
    try {
      await deletePhaseData(reportId, phaseKey);
    } catch {}
  }

  await withReportsTx(async (reports) => {
    const r = findReport(reports, reportId);
    if (r) {
      r.status = "pending";
      r.error = null;
      r.failedPhase = null;
      r.retryCount = newRetryCount;
      r.lastRetriedAt = new Date().toISOString();
      r.progress = { step: 0, total: PHASES.length, message: "等待重试" };
      r.currentPhase = null;
      r.phaseProgress = { current: 0, total: PHASES.length };

      for (const phaseKey of phasesToReset) {
        if (r.phases?.[phaseKey]) {
          r.phases[phaseKey].status = "pending";
          r.phases[phaseKey].startedAt = null;
          r.phases[phaseKey].completedAt = null;
          r.phases[phaseKey].error = null;
          r.phases[phaseKey].checksum = null;
          r.phases[phaseKey].itemCount = 0;
        }
      }
    }
  });

  setImmediate(() => executeReportTask(reportId, report.params, newRetryCount));

  const updated = await findReportById(reportId);
  return updated;
}

function stripResult(report) {
  if (!report) return report;
  const { result, ...rest } = report;
  return rest;
}

export async function getReport(reportId, { includeResult = false } = {}) {
  const report = await findReportById(reportId);
  if (!report) return null;

  if (includeResult) {
    if (report.status === "completed" && !report.result) {
      const finalData = await readPhaseData(reportId, "finalize");
      if (finalData) {
        report.result = finalData;
      }
    }
    return report;
  }

  return stripResult(report);
}

export async function listReports(filters = {}) {
  let reports = await loadReports();

  if (filters.status) {
    reports = reports.filter((r) => r.status === filters.status);
  }
  if (filters.requestedBy) {
    reports = reports.filter((r) => r.requestedBy === filters.requestedBy);
  }
  if (filters.periodFrom || filters.periodTo) {
    const periodFrom = filters.periodFrom ? new Date(filters.periodFrom).getTime() : null;
    const periodTo = filters.periodTo ? new Date(filters.periodTo).getTime() : null;
    if (periodFrom !== null && !isNaN(periodFrom)) {
      reports = reports.filter((r) => {
        const endAt = r.params?.endAt ? new Date(r.params.endAt).getTime() : Infinity;
        return endAt >= periodFrom;
      });
    }
    if (periodTo !== null && !isNaN(periodTo)) {
      reports = reports.filter((r) => {
        const startAt = r.params?.startAt ? new Date(r.params.startAt).getTime() : -Infinity;
        return startAt <= periodTo;
      });
    }
  }
  if (filters.hasHighRisk !== undefined && filters.hasHighRisk !== "") {
    const hasHighRisk = filters.hasHighRisk === "true" || filters.hasHighRisk === true;
    reports = reports.filter((r) => {
      if (r.status !== "completed") return false;
      const highRiskCount = r.result?.summary?.highRiskCount ?? 0;
      return hasHighRisk ? highRiskCount > 0 : highRiskCount === 0;
    });
  }
  if (filters.hasDiscrepancy !== undefined && filters.hasDiscrepancy !== "") {
    const hasDiscrepancy = filters.hasDiscrepancy === "true" || filters.hasDiscrepancy === true;
    reports = reports.filter((r) => {
      if (r.status !== "completed") return false;
      const discrepancyCount = r.result?.summary?.discrepancyCount ?? 0;
      return hasDiscrepancy ? discrepancyCount > 0 : discrepancyCount === 0;
    });
  }

  reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(filters.pageSize, 10) || 20));
  const totalCount = reports.length;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const start = (page - 1) * pageSize;
  const items = reports.slice(start, start + pageSize).map(stripResult);

  return {
    items,
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }
  };
}

export async function recoverPendingReports() {
  const reports = await loadReports();
  const now = Date.now();
  let recoveredCount = 0;
  let timeoutCount = 0;
  let resumedCount = 0;
  const scheduledIds = new Set();

  for (const report of reports) {
    if (report.status === "processing") {
      const elapsed = now - new Date(report.startedAt || report.createdAt).getTime();

      if (elapsed > TASK_TIMEOUT_MS) {
        report.status = "failed";
        report.error = "task_timeout_on_restart";
        report.progress = { step: 0, total: PHASES.length, message: "服务重启后恢复：任务超时" };
        if (report.currentPhase && report.phases?.[report.currentPhase]) {
          report.phases[report.currentPhase].status = "failed";
          report.phases[report.currentPhase].error = "task_timeout_on_restart";
        }
        try {
          await deletePhaseData(report.id, report.currentPhase);
        } catch {}
        timeoutCount++;
        recoveredCount++;
      } else {
        report.status = "pending";
        report.progress = { step: 0, total: PHASES.length, message: "服务重启后恢复" };
        if (report.currentPhase && report.phases?.[report.currentPhase]) {
          const phaseState = report.phases[report.currentPhase];
          if (phaseState.status === "processing") {
            phaseState.status = "pending";
            phaseState.startedAt = null;
            phaseState.error = null;
            try {
              await deletePhaseData(report.id, report.currentPhase);
            } catch {}
          }
        }
        scheduledIds.add(report.id);
        resumedCount++;
        recoveredCount++;
      }
    }
  }

  for (const report of reports) {
    if (report.status === "pending" && !scheduledIds.has(report.id) && !activeTaskControllers.has(report.id)) {
      scheduledIds.add(report.id);
      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    await saveReports(reports);
  }

  for (const id of scheduledIds) {
    const report = findReport(reports, id);
    if (report) {
      setImmediate(() => executeReportTask(report.id, report.params, report.retryCount || 0));
    }
  }

  if (recoveredCount > 0) {
    console.log(`[ComplianceReport] 恢复统计: 共 ${recoveredCount} 个 (超时失败: ${timeoutCount}, 断点续跑: ${resumedCount}, 待处理: ${scheduledIds.size - resumedCount})`);
  }

  return recoveredCount;
}

export async function getReportPhaseData(reportId, phaseKey) {
  const report = await findReportById(reportId);
  if (!report) return null;

  if (!report.phases?.[phaseKey]) return null;
  if (report.phases[phaseKey].status !== "completed") return null;

  return readPhaseData(reportId, phaseKey);
}

export { PHASES, PHASE_DATA_FILES };
