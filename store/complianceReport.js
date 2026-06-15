import { loadJson, saveJson, genId, withJsonTx } from "./common.js";
import { loadCylinders } from "./cylinders.js";
import { loadCustomers } from "./customers.js";
import { loadOrders } from "./rentalOrders.js";
import { loadTasks } from "./inspectionTasks.js";
import { loadChecks } from "./inventoryChecks.js";
import { queryOperationLogs } from "./operationLog.js";
import { normalizeItemForAPI } from "./compatibility.js";

const FILE = "complianceReports.json";
export const SEED = { reports: [] };

const TASK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RETRY_COUNT = 3;

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

function buildCylinderTraceability(cylinder, orders, tasks, checks, opLogs, startAt, endAt) {
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

  const relatedOrders = orders.filter((o) => {
    if (!o.cylinders || !o.cylinders.some((c) => c.id === cylinder.id)) return false;
    const t = new Date(o.createdAt).getTime();
    return t >= startTime && t <= endTime;
  }).map((o) => ({
    id: o.id,
    customerName: o.customerName,
    cylinderCount: o.cylinderCount,
    createdAt: o.createdAt,
    status: o.status
  }));

  const inspectionRisks = tasks
    .filter((t) => {
      if (t.cylinderId !== cylinder.id) return false;
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
  for (const check of checks) {
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

  const relatedOpLogs = opLogs.filter((l) => l.targetId === cylinder.id)
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

async function generateComplianceSnapshot(params) {
  const { startAt, endAt } = params;
  const startTime = startAt ? new Date(startAt).getTime() : 0;
  const endTime = endAt ? new Date(endAt).getTime() : Infinity;

  const cylinders = stripCollectionInternal(await loadCylinders());
  const customers = stripCollectionInternal(await loadCustomers());
  const orders = stripCollectionInternal(await loadOrders());
  const tasks = stripCollectionInternal(await loadTasks());
  const checks = stripCollectionInternal(await loadChecks());

  const opLogResult = await queryOperationLogs({
    startAt: startAt || "",
    endAt: endAt || "",
    pageSize: "1000"
  });
  const opLogs = stripCollectionInternal(opLogResult.items || []);

  const customersInPeriod = customers.filter((c) => {
    const t = new Date(c.createdAt).getTime();
    return t >= startTime && t <= endTime;
  });

  const ordersInPeriod = orders.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return t >= startTime && t <= endTime;
  });

  const tasksInPeriod = tasks.filter((t) => {
    const tCreated = new Date(t.createdAt).getTime();
    return tCreated >= startTime && tCreated <= endTime;
  });

  const checksInPeriod = checks.filter((c) => {
    const t = new Date(c.createdAt).getTime();
    return t >= startTime && t <= endTime;
  });

  const cylinderTraceability = cylinders.map((c) =>
    buildCylinderTraceability(c, orders, tasks, checks, opLogs, startAt, endAt)
  );

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

  const operatorSummary = {};
  for (const log of opLogs) {
    const op = log.operator || "unknown";
    if (!operatorSummary[op]) {
      operatorSummary[op] = { operator: op, operationCount: 0, failedCount: 0 };
    }
    operatorSummary[op].operationCount++;
    if (log.status === "failed") operatorSummary[op].failedCount++;
  }

  return {
    period: { startAt: startAt || null, endAt: endAt || null },
    generatedAt: new Date().toISOString(),
    summary: {
      totalCustomers: customersInPeriod.length,
      totalCylinders: cylinders.length,
      totalOrders: ordersInPeriod.length,
      totalInspectionTasks: tasksInPeriod.length,
      totalInventoryChecks: checksInPeriod.length,
      totalOperationLogs: opLogs.length,
      highRiskCount: allInspectionRisks.filter((r) => r.risk === "high").length,
      mediumRiskCount: allInspectionRisks.filter((r) => r.risk === "medium").length,
      discrepancyCount: allDiscrepancies.length
    },
    customers: customersInPeriod,
    cylinders: cylinderTraceability,
    rentalOrders: ordersInPeriod,
    inspections: tasksInPeriod.map((t) => stripInternalFields(t)),
    inventoryChecks: checksInPeriod.map((c) => stripInternalFields(c)),
    operationLogs: opLogs,
    risks: allInspectionRisks,
    discrepancies: allDiscrepancies,
    operatorSummary: Object.values(operatorSummary)
  };
}

const activeTaskControllers = new Map();

async function executeReportTask(reportId, params, retryCount = 0) {
  const report = await findReportById(reportId);
  if (!report) return;

  if (report.status === "completed" || report.status === "processing" || report.status === "failed") {
    return;
  }

  await updateReport(reportId, {
    status: "processing",
    startedAt: new Date().toISOString(),
    progress: { step: 1, total: 3, message: "加载数据中" },
    retryCount
  });

  const controller = { aborted: false };
  activeTaskControllers.set(reportId, controller);

  try {
    await updateReport(reportId, {
      progress: { step: 2, total: 3, message: "生成合规快照" }
    });

    if (controller.aborted) {
      await updateReport(reportId, {
        status: "failed",
        error: "task_aborted",
        progress: { step: 2, total: 3, message: "任务已中止" }
      });
      return;
    }

    const result = await generateComplianceSnapshot(params);

    await updateReport(reportId, {
      progress: { step: 3, total: 3, message: "持久化结果" }
    });

    await updateReport(reportId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result,
      progress: { step: 3, total: 3, message: "完成" }
    });
  } catch (err) {
    await updateReport(reportId, {
      status: "failed",
      error: err.message || "unknown_error",
      progress: { step: 0, total: 3, message: `失败: ${err.message}` }
    });
  } finally {
    activeTaskControllers.delete(reportId);
  }
}

async function findReportById(id) {
  const reports = await loadReports();
  return findReport(reports, id);
}

async function updateReport(id, updates) {
  return withReportsTx(async (reports) => {
    const report = findReport(reports, id);
    if (!report) return null;
    Object.assign(report, updates);
    return report;
  });
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
    progress: { step: 0, total: 3, message: "等待处理" },
    result: null,
    error: null,
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
  await updateReport(reportId, {
    status: "pending",
    error: null,
    retryCount: newRetryCount,
    lastRetriedAt: new Date().toISOString(),
    progress: { step: 0, total: 3, message: "等待重试" }
  });

  setImmediate(() => executeReportTask(reportId, report.params, newRetryCount));

  const updated = await findReportById(reportId);
  return updated;
}

export async function getReport(reportId) {
  return findReportById(reportId);
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
  const items = reports.slice(start, start + pageSize);

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
  let recovered = 0;
  const scheduledIds = new Set();

  for (const report of reports) {
    if (report.status === "processing") {
      const elapsed = now - new Date(report.startedAt || report.createdAt).getTime();
      if (elapsed > TASK_TIMEOUT_MS) {
        report.status = "failed";
        report.error = "task_timeout_on_restart";
        report.progress = { step: 0, total: 3, message: "服务重启后恢复：任务超时" };
        recovered++;
      } else {
        report.status = "pending";
        report.progress = { step: 0, total: 3, message: "服务重启后恢复" };
        scheduledIds.add(report.id);
        recovered++;
      }
    }
  }

  for (const report of reports) {
    if (report.status === "pending" && !scheduledIds.has(report.id) && !activeTaskControllers.has(report.id)) {
      scheduledIds.add(report.id);
      recovered++;
    }
  }

  if (recovered > 0) {
    await saveReports(reports);
  }

  for (const id of scheduledIds) {
    const report = findReport(reports, id);
    if (report) {
      setImmediate(() => executeReportTask(report.id, report.params, report.retryCount));
    }
  }

  return recovered;
}
