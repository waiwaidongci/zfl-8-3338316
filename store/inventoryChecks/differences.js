import { PROTECTED_STATUSES } from "./constants.js";
import { getUniqueScannedIds, getDuplicateScanCount } from "./scanning.js";

function buildCylinderMap(cylinders) {
  return new Map(cylinders.map((c) => [c.id, c]));
}

function isProtectedStatus(status) {
  return PROTECTED_STATUSES.includes(status);
}

function buildDeficitDetails(deficitIds, cylinderMap) {
  return deficitIds.map((id) => {
    const c = cylinderMap.get(id);
    return {
      cylinderId: id,
      gasType: c?.gasType || null,
      capacity: c?.capacity || null,
      status: c?.status || null,
      location: c?.location || null,
      customer: c?.customer || null,
      protected: c ? isProtectedStatus(c.status) : false
    };
  });
}

function buildSurplusDetails(surplusIds, cylinderMap) {
  return surplusIds.map((id) => {
    const c = cylinderMap.get(id);
    return {
      cylinderId: id,
      existsInSystem: !!c,
      gasType: c?.gasType || null,
      capacity: c?.capacity || null,
      status: c?.status || null,
      location: c?.location || null,
      protected: c ? isProtectedStatus(c.status) : false
    };
  });
}

function buildMatchedDetails(matchedIds, cylinderMap) {
  return matchedIds.map((id) => {
    const c = cylinderMap.get(id);
    return {
      cylinderId: id,
      gasType: c?.gasType || null,
      capacity: c?.capacity || null,
      status: c?.status || null,
      location: c?.location || null
    };
  });
}

export function computeDifferences(check, cylinders) {
  const scannedIds = getUniqueScannedIds(check);
  const expectedSet = new Set(check.expectedCylinderIds);
  const scannedSet = new Set(scannedIds);

  const matched = scannedIds.filter((id) => expectedSet.has(id));
  const deficit = check.expectedCylinderIds.filter((id) => !scannedSet.has(id));
  const surplus = scannedIds.filter((id) => !expectedSet.has(id));

  const cylinderMap = buildCylinderMap(cylinders);

  return {
    expectedCount: check.expectedCylinderIds.length,
    uniqueScannedCount: scannedIds.length,
    matchedCount: matched.length,
    deficitCount: deficit.length,
    surplusCount: surplus.length,
    duplicateScanCount: getDuplicateScanCount(check),
    matched: buildMatchedDetails(matched, cylinderMap),
    deficit: buildDeficitDetails(deficit, cylinderMap),
    surplus: buildSurplusDetails(surplus, cylinderMap)
  };
}

function buildDeficitSuggestions(deficitItems) {
  const suggestions = [];
  for (const item of deficitItems) {
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
  return suggestions;
}

function buildSurplusSuggestions(surplusItems) {
  const suggestions = [];
  for (const item of surplusItems) {
    if (item.existsInSystem) {
      if (item.protected) {
        suggestions.push({
          cylinderId: item.cylinderId,
          type: "surplus_protected",
          suggestion: `钢瓶${item.cylinderId}盘盈，当前状态为${item.status}（受保护），不可迁移，建议人工核实`,
          action: "manual_verify",
          priority: "medium"
        });
      } else {
        suggestions.push({
          cylinderId: item.cylinderId,
          type: "surplus_migratable",
          suggestion: `钢瓶${item.cylinderId}盘盈（系统已存在），当前库位${item.location || "未知"}，确认时可选择迁移到盘点库位`,
          action: "migrate_location",
          priority: "high"
        });
      }
    } else {
      suggestions.push({
        cylinderId: item.cylinderId,
        type: "surplus_unregistered",
        suggestion: `钢瓶${item.cylinderId}盘盈（系统中不存在），建议核实后登记建档`,
        action: "register_suggestion",
        priority: "high"
      });
    }
  }
  return suggestions;
}

function buildDuplicateScanSuggestion(duplicateCount) {
  if (duplicateCount <= 0) return null;
  return {
    cylinderId: null,
    type: "duplicate_scans",
    suggestion: `存在${duplicateCount}次重复扫描记录，已自动去重计算，原始扫描记录可追溯`,
    action: "review_duplicates",
    priority: "low"
  };
}

export function generateSuggestions(differences) {
  const suggestions = [];

  suggestions.push(...buildDeficitSuggestions(differences.deficit));
  suggestions.push(...buildSurplusSuggestions(differences.surplus));

  const dupSuggestion = buildDuplicateScanSuggestion(differences.duplicateScanCount);
  if (dupSuggestion) {
    suggestions.push(dupSuggestion);
  }

  return suggestions;
}
