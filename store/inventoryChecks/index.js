import { loadJson, saveJson, genId, withJsonTx } from "../common.js";
import { addStatusHistory } from "../compatibility.js";

import { VALID_STATUSES, ALLOWED_TRANSITIONS, PROTECTED_STATUSES } from "./constants.js";
import {
  validateTransition,
  transitionToScanning,
  transitionToCompleted,
  transitionToConfirmed
} from "./status.js";
import { addSingleScan, addBatchScan } from "./scanning.js";
import { computeDifferences, generateSuggestions } from "./differences.js";
import { applyCylinderUpdates } from "./confirmation.js";

const FILE = "inventoryChecks.json";
export const SEED = { checks: [] };

export {
  VALID_STATUSES,
  ALLOWED_TRANSITIONS,
  PROTECTED_STATUSES,
  validateTransition,
  computeDifferences,
  generateSuggestions
};

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
    note: input.note || null,
    statusHistory: [
      {
        id: `sh-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fromStatus: null,
        toStatus: "draft",
        at: now,
        note: "盘点单创建" + (input.note ? `：${input.note}` : ""),
        operator: input.operator || null,
        eventId: null,
        extra: {
          expectedCount: expected.length,
          scope: {
            location: scope.location || null,
            gasType: scope.gasType || null,
            status: scope.status || null
          }
        }
      }
    ]
  };
  return check;
}

export function applyStart(check, operator) {
  transitionToScanning(check, operator);
}

export function applyScan(check, input) {
  return addSingleScan(check, input);
}

export function applyBatchScan(check, cylinderIds, operator) {
  return addBatchScan(check, cylinderIds, operator);
}

export function applyComplete(check, cylinders, operator) {
  const differences = computeDifferences(check, cylinders);
  const suggestions = generateSuggestions(differences);
  transitionToCompleted(check, differences, operator);
  check.suggestions = suggestions;
}

export function applyConfirm(check, cylinders, operator, options = {}) {
  if (!check.differences) {
    const err = new Error("differences_not_computed");
    err.statusCode = 400;
    throw err;
  }

  const affected = applyCylinderUpdates(check, cylinders, operator, options);
  const surplusMigrateIds = Array.isArray(options.surplusMigrateIds) ? options.surplusMigrateIds : [];

  transitionToConfirmed(check, {
    deficitCount: affected.deficit.length,
    surplusMigratedCount: affected.surplusMigrated.length,
    surplusUnregisteredCount: affected.surplusRegistrationSuggestions.length,
    surplusMigrateIds
  }, operator);

  check.surplusMigrated = affected.surplusMigrated;
  check.surplusRegistrationSuggestions = affected.surplusRegistrationSuggestions;

  return affected;
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
