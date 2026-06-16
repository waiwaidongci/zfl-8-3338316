import { makeEvent } from "../common.js";
import { addStatusHistory } from "../compatibility.js";
import { PROTECTED_STATUSES } from "./constants.js";

function isProtectedCylinder(cylinder) {
  return PROTECTED_STATUSES.includes(cylinder.status);
}

function findCylinderById(cylinders, cylinderId) {
  return cylinders.find((c) => c.id === cylinderId) || null;
}

function processDeficitCylinder(cylinder, checkId, operator, now) {
  const fromCylStatus = cylinder.status;
  cylinder.status = "pending_check";
  cylinder.location = cylinder.location || "待核查区";
  const evt = makeEvent("inventory_check", `盘亏标记待核查，盘点单${checkId}`);
  cylinder.events.push(evt);
  addStatusHistory(cylinder, {
    fromStatus: fromCylStatus,
    toStatus: "pending_check",
    at: now,
    note: `盘点盘亏标记待核查，盘点单${checkId}`,
    operator: operator || null,
    eventId: evt.id
  });
  return {
    cylinderId: cylinder.id,
    previousStatus: fromCylStatus,
    newStatus: "pending_check",
    previousLocation: cylinder.location,
    newLocation: cylinder.location
  };
}

export function processDeficitItems(check, cylinders, operator, now) {
  const affected = [];
  for (const item of check.differences.deficit) {
    if (item.protected) continue;
    const cylinder = findCylinderById(cylinders, item.cylinderId);
    if (!cylinder) continue;
    if (isProtectedCylinder(cylinder)) continue;

    const result = processDeficitCylinder(cylinder, check.id, operator, now);
    result.previousLocation = item.location;
    affected.push(result);
  }
  return affected;
}

function processSurplusMigrateCylinder(cylinder, targetLocation, checkId, operator, now) {
  const previousLocation = cylinder.location;
  cylinder.location = targetLocation;
  const evt = makeEvent("inventory_migrate", `盘点盘盈迁移库位：${previousLocation || "未知"} → ${targetLocation}，盘点单${checkId}`);
  cylinder.events.push(evt);
  return {
    cylinderId: cylinder.id,
    previousLocation,
    newLocation: targetLocation,
    previousStatus: cylinder.status
  };
}

export function processSurplusItems(check, cylinders, operator, now, surplusMigrateSet) {
  const affectedMigrated = [];
  const registrationSuggestions = [];
  const targetLocation = check.scope?.location || "盘点库位";

  for (const item of check.differences.surplus) {
    if (item.existsInSystem) {
      if (item.protected) continue;
      if (!surplusMigrateSet.has(item.cylinderId)) continue;

      const cylinder = findCylinderById(cylinders, item.cylinderId);
      if (!cylinder) continue;
      if (isProtectedCylinder(cylinder)) continue;

      const result = processSurplusMigrateCylinder(cylinder, targetLocation, check.id, operator, now);
      affectedMigrated.push(result);
    } else {
      registrationSuggestions.push({
        cylinderId: item.cylinderId,
        suggestedLocation: targetLocation,
        checkId: check.id,
        suggestedAt: new Date().toISOString()
      });
    }
  }

  return {
    surplusMigrated: affectedMigrated,
    surplusRegistrationSuggestions: registrationSuggestions
  };
}

export function applyCylinderUpdates(check, cylinders, operator, options = {}) {
  const surplusMigrateIds = Array.isArray(options.surplusMigrateIds) ? options.surplusMigrateIds : [];
  const surplusMigrateSet = new Set(surplusMigrateIds);
  const now = new Date().toISOString();

  const affectedDeficit = processDeficitItems(check, cylinders, operator, now);
  const { surplusMigrated, surplusRegistrationSuggestions } = processSurplusItems(
    check, cylinders, operator, now, surplusMigrateSet
  );

  return {
    deficit: affectedDeficit,
    surplusMigrated,
    surplusRegistrationSuggestions
  };
}
