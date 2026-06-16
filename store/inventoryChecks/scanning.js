function assertScanningStatus(check) {
  if (check.status !== "scanning") {
    const err = new Error("check_not_in_scanning");
    err.statusCode = 409;
    throw err;
  }
}

function isDuplicate(check, cylinderId, batchEntries = []) {
  return check.scannedEntries.some((e) => e.cylinderId === cylinderId) ||
    batchEntries.some((e) => e.cylinderId === cylinderId);
}

function makeScanEntry(check, cylinderId, operator) {
  check.scanIndexCounter += 1;
  return {
    cylinderId,
    scannedAt: new Date().toISOString(),
    operator: operator || null,
    scanIndex: check.scanIndexCounter,
    duplicate: isDuplicate(check, cylinderId)
  };
}

export function addSingleScan(check, input) {
  assertScanningStatus(check);
  if (!input.cylinderId) {
    const err = new Error("cylinder_id_required");
    err.statusCode = 400;
    throw err;
  }

  const entry = makeScanEntry(check, input.cylinderId, input.operator);
  check.scannedEntries.push(entry);
  return entry;
}

export function addBatchScan(check, cylinderIds, operator) {
  assertScanningStatus(check);

  const entries = [];
  for (const cylinderId of cylinderIds) {
    check.scanIndexCounter += 1;
    const entry = {
      cylinderId,
      scannedAt: new Date().toISOString(),
      operator: operator || null,
      scanIndex: check.scanIndexCounter,
      duplicate: isDuplicate(check, cylinderId, entries)
    };
    check.scannedEntries.push(entry);
    entries.push(entry);
  }
  return entries;
}

export function getUniqueScannedIds(check) {
  return [...new Set(check.scannedEntries.map((e) => e.cylinderId))];
}

export function getDuplicateScanCount(check) {
  return check.scannedEntries.filter((e) => e.duplicate).length;
}
