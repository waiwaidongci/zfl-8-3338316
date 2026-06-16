import { addStatusHistory } from "../compatibility.js";
import { VALID_STATUSES, ALLOWED_TRANSITIONS } from "./constants.js";

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

export function transitionToScanning(check, operator) {
  validateTransition(check, "scanning");
  const fromStatus = check.status;
  const now = new Date().toISOString();
  check.status = "scanning";
  check.scanningStartedAt = now;
  addStatusHistory(check, {
    fromStatus,
    toStatus: "scanning",
    at: now,
    note: "开始盘点扫描",
    operator: operator || check.createdBy || null
  });
}

export function transitionToCompleted(check, differences, operator) {
  validateTransition(check, "completed");
  const fromStatus = check.status;
  const now = new Date().toISOString();

  check.differences = differences;
  check.status = "completed";
  check.completedAt = now;
  addStatusHistory(check, {
    fromStatus,
    toStatus: "completed",
    at: now,
    note: `盘点完成，预期${differences.expectedCount}个，实扫${differences.uniqueScannedCount}个，盘亏${differences.deficitCount}个，盘盈${differences.surplusCount}个`,
    operator: operator || check.createdBy || null,
    extra: {
      expectedCount: differences.expectedCount,
      uniqueScannedCount: differences.uniqueScannedCount,
      matchedCount: differences.matchedCount,
      deficitCount: differences.deficitCount,
      surplusCount: differences.surplusCount
    }
  });
}

export function transitionToConfirmed(check, { deficitCount, surplusMigratedCount, surplusUnregisteredCount, surplusMigrateIds }, operator) {
  validateTransition(check, "confirmed");
  const fromStatus = check.status;
  const now = new Date().toISOString();

  check.status = "confirmed";
  check.confirmedAt = now;
  check.confirmedBy = operator || null;

  addStatusHistory(check, {
    fromStatus,
    toStatus: "confirmed",
    at: now,
    note: `盘点确认，盘亏处理${deficitCount}个，盘盈迁移${surplusMigratedCount}个，待登记${surplusUnregisteredCount}个`,
    operator: operator || null,
    extra: {
      deficitCount,
      surplusMigratedCount,
      surplusUnregisteredCount,
      surplusMigrateIds: surplusMigrateIds
    }
  });
}
