import { loadJson, saveJson, genId, makeEvent, withJsonTx } from "./common.js";

const FILE = "inventoryChecks.json";
export const SEED = { checks: [] };

const VALID_STATUSES = ["draft", "scanning", "completed", "confirmed"];

const ALLOWED_TRANSITIONS = {
  draft: ["scanning"],
  scanning: ["completed"],
  completed: ["confirmed"],
  confirmed: []
};

const PROTECTED_STATUSES = ["rented", "inspection", "scrapped"];

export async function loadChecks() {
  const db = await loadJson(FILE, SEED);
  return db.checks;
}

export async function saveChecks(checks) {
  await saveJson(FILE, { checks });
}

export async function withChecksTx(mutator) {
  return withJsonTx(FILE, SEED, async (db) => {
    return mutator(db.checks);
  });
}

export function filterChecks(checks, query = {}) {
  let result = [...checks];

  if (query.status) {
    result = result.filter((c) => c.status === query.status);
  }
  if (query.createdBy) {
    result = result.filter((c) => c.createdBy === query.createdBy);
  }
  if (query.location) {
    result = result.filter((c) => c.scope && c.scope.location === query.location);
  }
  if (query.gasType) {
    result = result.filter((c) => c.scope && c.scope.gasType === query.gasType);
  }
  if (query.createdFrom) {
    const from = new Date(query.createdFrom).getTime();
    if (!isNaN(from)) {
      result = result.filter((c) => new Date(c.createdAt).getTime() >= from);
    }
  }
  if (query.createdTo) {
    const to = new Date(query.createdTo).getTime();
    if (!isNaN(to)) {
      result = result.filter((c) => new Date(c.createdAt).getTime() <= to);
    }
  }

  result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return result;
}

export function findCheck(checks, id) {
  return checks.find((c) => c.id === id) || null;
}

export function validateTransition(check, nextStatus) {
  if (!VALID_STATUSES.includes(nextStatus)) {
    const err = new Error("invalid_status");
    err.statusCode = 400;
    throw err;
  }
  if (!ALLOWED_TRANSITIONS[check.status].includes(nextStatus)) {
    const err = new Error(`transition_not_allowed:${check.status}->${nextStatus}`);
    err.statusCode = 409;
    throw err;
  }
}

export function createCheck(input, cylinders) {
  const scope = input.scope || {};
  let expected = cylinders;

  if (scope.location) {
    expected = expected.filter((c) => c.location === scope.location);
  }
  if (scope.gasType) {
    expected = expected.filter((c) => c.gasType === scope.gasType);
  }
  if (scope.status) {
    expected = expected.filter((c) => c.status === scope.status);
  }

  const now = new Date().toISOString();
  const check = {
    id: genId("IC"),
    title: input.title || `盘点单-${now.slice(0, 10)}`,
    scope: {
      location: scope.location || null,
      gasType: scope.gasType || null,
      status: scope.status || null
    },
    expectedCount: expected.length,
    expectedCylinderIds: expected.map((c) => c.id),
    expectedCylinderDetails: expected.map((c) => ({
      id: c.id,
      gasType: c.gasType,
      capacity: c.capacity,
      status: c.status,
      location: c.location,
      customer: c.customer || null
    })),
    scannedEntries: [],
    scanIndexCounter: 0,
    differences: null,
    suggestions: null,
    status: "draft",
    createdAt: now,
    scanningStartedAt: null,
    completedAt: null,
    confirmedAt: null,
    confirmedBy: null,
    createdBy: input.operator || null,
    note: input.note || null
  };
  return check;
}

export function applyStart(check) {
  validateTransition(check, "scanning");
  check.status = "scanning";
  check.scanningStartedAt = new Date().toISOString();
}

export function applyScan(check, input) {
  if (check.status !== "scanning") {
    const err = new Error("check_not_in_scanning");
    err.statusCode = 409;
    throw err;
  }
  if (!input.cylinderId) {
    const err = new Error("cylinder_id_required");
    err.statusCode = 400;
    throw err;
  }

  check.scanIndexCounter += 1;
  const entry = {
    cylinderId: input.cylinderId,
    scannedAt: new Date().toISOString(),
    operator: input.operator || null,
    scanIndex: check.scanIndexCounter,
    duplicate: check.scannedEntries.some((e) => e.cylinderId === input.cylinderId)
  };
  check.scannedEntries.push(entry);
  return entry;
}

export function applyBatchScan(check, cylinderIds, operator) {
  if (check.status !== "scanning") {
    const err = new Error("check_not_in_scanning");
    err.statusCode = 409;
    throw err;
  }

  const entries = [];
  for (const cylinderId of cylinderIds) {
    check.scanIndexCounter += 1;
    const entry = {
      cylinderId,
      scannedAt: new Date().toISOString(),
      operator: operator || null,
      scanIndex: check.scanIndexCounter,
      duplicate: check.scannedEntries.some((e) => e.cylinderId === cylinderId) ||
        entries.some((e) => e.cylinderId === cylinderId)
    };
    check.scannedEntries.push(entry);
    entries.push(entry);
  }
  return entries;
}

export function computeDifferences(check, cylinders) {
  const scannedIds = [...new Set(check.scannedEntries.map((e) => e.cylinderId))];
  const expectedSet = new Set(check.expectedCylinderIds);
  const scannedSet = new Set(scannedIds);

  const matched = scannedIds.filter((id) => expectedSet.has(id));
  const deficit = check.expectedCylinderIds.filter((id) => !scannedSet.has(id));
  const surplus = scannedIds.filter((id) => !expectedSet.has(id));

  const cylinderMap = new Map(cylinders.map((c) => [c.id, c]));

  const deficitDetails = deficit.map((id) => {
    const c = cylinderMap.get(id);
    return {
      cylinderId: id,
      gasType: c?.gasType || null,
      capacity: c?.capacity || null,
      status: c?.status || null,
      location: c?.location || null,
      customer: c?.customer || null,
      protected: c ? PROTECTED_STATUSES.includes(c.status) : false
    };
  });

  const surplusDetails = surplus.map((id) => {
    const c = cylinderMap.get(id);
    return {
      cylinderId: id,
      gasType: c?.gasType || null,
      capacity: c?.capacity || null,
      status: c?.status || null,
      location: c?.location || null
    };
  });

  const matchedDetails = matched.map((id) => {
    const c = cylinderMap.get(id);
    return {
      cylinderId: id,
      gasType: c?.gasType || null,
      capacity: c?.capacity || null,
      status: c?.status || null,
      location: c?.location || null
    };
  });

  const duplicateCount = check.scannedEntries.filter((e) => e.duplicate).length;

  return {
    expectedCount: check.expectedCylinderIds.length,
    uniqueScannedCount: scannedIds.length,
    matchedCount: matched.length,
    deficitCount: deficit.length,
    surplusCount: surplus.length,
    duplicateScanCount: duplicateCount,
    matched: matchedDetails,
    deficit: deficitDetails,
    surplus: surplusDetails
  };
}

export function generateSuggestions(differences) {
  const suggestions = [];

  for (const item of differences.deficit) {
    if (item.protected) {
      suggestions.push({
        cylinderId: item.cylinderId,
        type: "deficit_protected",
        suggestion: `钢瓶${item.cylinderId}当前状态为${item.status}（受保护），盘点未扫到但状态不可变更，建议人工核实`,
        action: "manual_verify",
        priority: "medium"
      });
    } else {
      suggestions.push({
        cylinderId: item.cylinderId,
        type: "deficit_actionable",
        suggestion: `钢瓶${item.cylinderId}盘亏，建议标记为待核查并追踪去向`,
        action: "mark_pending_check",
        priority: "high"
      });
    }
  }

  for (const item of differences.surplus) {
    suggestions.push({
      cylinderId: item.cylinderId,
      type: "surplus",
      suggestion: `钢瓶${item.cylinderId}盘盈（不在预期范围内），建议核实是否为错放或未登记入库`,
      action: "verify_surplus",
      priority: "medium"
    });
  }

  if (differences.duplicateScanCount > 0) {
    suggestions.push({
      cylinderId: null,
      type: "duplicate_scans",
      suggestion: `存在${differences.duplicateScanCount}次重复扫描记录，已自动去重计算，原始扫描记录可追溯`,
      action: "review_duplicates",
      priority: "low"
    });
  }

  return suggestions;
}

export function applyComplete(check, cylinders) {
  validateTransition(check, "completed");

  const differences = computeDifferences(check, cylinders);
  const suggestions = generateSuggestions(differences);

  check.differences = differences;
  check.suggestions = suggestions;
  check.status = "completed";
  check.completedAt = new Date().toISOString();
}

export function applyConfirm(check, cylinders, operator) {
  validateTransition(check, "confirmed");

  if (!check.differences) {
    const err = new Error("differences_not_computed");
    err.statusCode = 400;
    throw err;
  }

  const affectedCylinders = [];

  for (const item of check.differences.deficit) {
    if (item.protected) continue;
    const cylinder = cylinders.find((c) => c.id === item.cylinderId);
    if (!cylinder) continue;
    if (PROTECTED_STATUSES.includes(cylinder.status)) continue;

    cylinder.status = "pending_check";
    cylinder.location = cylinder.location || "待核查区";
    cylinder.events.push(makeEvent("inventory_check", `盘亏标记待核查，盘点单${check.id}`));
    affectedCylinders.push({
      cylinderId: cylinder.id,
      previousStatus: item.status,
      newStatus: "pending_check"
    });
  }

  check.status = "confirmed";
  check.confirmedAt = new Date().toISOString();
  check.confirmedBy = operator || null;

  return affectedCylinders;
}

export function getCheckHistory(checks, cylinderId) {
  const history = [];
  for (const check of checks) {
    if (check.status !== "completed" && check.status !== "confirmed") continue;
    if (!check.expectedCylinderIds.includes(cylinderId) &&
        !check.scannedEntries.some((e) => e.cylinderId === cylinderId)) continue;

    const wasExpected = check.expectedCylinderIds.includes(cylinderId);
    const wasScanned = check.scannedEntries.some((e) => e.cylinderId === cylinderId);
    const duplicateScans = check.scannedEntries.filter((e) => e.cylinderId === cylinderId);

    let result = "not_in_scope";
    if (wasExpected && wasScanned) result = "matched";
    else if (wasExpected && !wasScanned) result = "deficit";
    else if (!wasExpected && wasScanned) result = "surplus";

    history.push({
      checkId: check.id,
      title: check.title,
      status: check.status,
      result,
      wasExpected,
      wasScanned,
      scanCount: duplicateScans.length,
      scanEntries: duplicateScans.map((e) => ({
        scannedAt: e.scannedAt,
        operator: e.operator,
        scanIndex: e.scanIndex,
        duplicate: e.duplicate
      })),
      completedAt: check.completedAt,
      confirmedAt: check.confirmedAt
    });
  }
  return history;
}
