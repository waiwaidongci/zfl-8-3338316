import { genId, makeEvent } from "./common.js";

function isEmpty(value) {
  return value === undefined || value === null || value === "";
}

function isValidDate(dateStr) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  return date instanceof Date && !isNaN(date);
}

export function validateCylinderBatch(inputBatch, existingCylinders) {
  const existingIds = new Set(existingCylinders.map((c) => c.id));
  const batchIdCounts = new Map();
  const valid = [];
  const errors = [];

  inputBatch.forEach((item, index) => {
    const itemErrors = [];

    if (isEmpty(item.id)) {
      itemErrors.push("missing_id");
    } else {
      batchIdCounts.set(item.id, (batchIdCounts.get(item.id) || 0) + 1);
    }

    if (isEmpty(item.gasType)) {
      itemErrors.push("missing_gasType");
    }

    if (isEmpty(item.inspectionDue)) {
      itemErrors.push("missing_inspectionDue");
    } else if (!isValidDate(item.inspectionDue)) {
      itemErrors.push("invalid_inspectionDue");
    }

    if (itemErrors.length > 0) {
      errors.push({
        index,
        id: item.id || null,
        errors: itemErrors
      });
    } else {
      valid.push({ index, data: item });
    }
  });

  valid.forEach((item) => {
    const id = item.data.id;
    if (existingIds.has(id)) {
      errors.push({
        index: item.index,
        id,
        errors: ["duplicate_id_in_storage"]
      });
      item.duplicate = true;
    }
    if (batchIdCounts.get(id) > 1) {
      const existingError = errors.find((e) => e.index === item.index);
      if (existingError) {
        if (!existingError.errors.includes("duplicate_id_in_batch")) {
          existingError.errors.push("duplicate_id_in_batch");
        }
      } else {
        errors.push({
          index: item.index,
          id,
          errors: ["duplicate_id_in_batch"]
        });
      }
      item.duplicate = true;
    }
  });

  const validCylinders = valid
    .filter((item) => !item.duplicate)
    .map((item) => buildCylinder(item.data));

  const summary = buildErrorSummary(errors);

  return {
    valid: validCylinders,
    errors,
    summary,
    totalCount: inputBatch.length,
    validCount: validCylinders.length,
    errorCount: errors.length
  };
}

function buildCylinder(data) {
  return {
    id: data.id,
    gasType: data.gasType,
    capacity: data.capacity || "40L",
    inspectionDue: data.inspectionDue,
    location: data.location || "仓库",
    status: "in_stock",
    customer: null,
    depositStatus: "none",
    fills: [],
    events: [makeEvent("create", "批量导入新建钢瓶")]
  };
}

function buildErrorSummary(errors) {
  const summary = {
    missing_id: [],
    missing_gasType: [],
    missing_inspectionDue: [],
    invalid_inspectionDue: [],
    duplicate_id_in_storage: [],
    duplicate_id_in_batch: []
  };

  errors.forEach((e) => {
    e.errors.forEach((errType) => {
      if (summary[errType]) {
        summary[errType].push({ index: e.index, id: e.id });
      }
    });
  });

  return summary;
}
