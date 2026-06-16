import { detectCurrentVersion, getDataKey } from "./migration.js";

const STATUS_HISTORY_DEFAULTS = [];

export const STATUS_HISTORY_ENTRY_SCHEMA = {
  requiredFields: ["toStatus", "at"],
  defaultFields: {
    id: null,
    fromStatus: null,
    note: null,
    operator: null,
    eventId: null,
    extra: null
  }
};

export const V2_SCHEMAS = {
  cylinders: {
    schemaVersion: "2.0",
    entity: "cylinders",
    dataKey: "cylinders",
    requiredFields: ["id", "gasType", "capacity", "inspectionDue", "location", "status"],
    defaultFields: {
      customer: null,
      depositStatus: "none",
      fills: [],
      events: []
    },
    fieldAliases: {
      "gas_type": "gasType",
      "inspection_due": "inspectionDue",
      "deposit_status": "depositStatus"
    },
    reservedFields: ["_schemaVersion", "_meta", "_migratedFrom"]
  },
  customers: {
    schemaVersion: "2.0",
    entity: "customers",
    dataKey: "customers",
    requiredFields: ["id", "name"],
    defaultFields: {
      contact: null,
      phone: null,
      address: null,
      createdAt: null
    },
    fieldAliases: {
      "customer_name": "name",
      "contact_person": "contact",
      "phone_number": "phone"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  rentalOrders: {
    schemaVersion: "2.0",
    entity: "rentalOrders",
    dataKey: "orders",
    requiredFields: ["id", "customerId", "customerName", "cylinders"],
    defaultFields: {
      cylinderCount: 0,
      note: "",
      status: "completed",
      createdAt: null
    },
    fieldAliases: {
      "customer_id": "customerId",
      "customer_name": "customerName",
      "cylinder_count": "cylinderCount"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  inspectionTasks: {
    schemaVersion: "2.0",
    entity: "inspectionTasks",
    dataKey: "tasks",
    requiredFields: ["id", "cylinderId", "status"],
    defaultFields: {
      gasType: null,
      capacity: null,
      inspectionDue: null,
      result: null,
      createdAt: null,
      sentAt: null,
      inspectedAt: null,
      restockedAt: null
    },
    fieldAliases: {
      "cylinder_id": "cylinderId",
      "gas_type": "gasType",
      "inspection_due": "inspectionDue",
      "sent_at": "sentAt",
      "inspected_at": "inspectedAt",
      "restocked_at": "restockedAt"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  operationLogs: {
    schemaVersion: "2.0",
    entity: "operationLogs",
    dataKey: "logs",
    requiredFields: ["id", "operationType", "targetType"],
    defaultFields: {
      targetId: null,
      operator: null,
      beforeState: null,
      afterState: null,
      requestBody: null,
      eventIds: [],
      status: "success",
      error: null,
      createdAt: null,
      idempotencyKey: null
    },
    fieldAliases: {
      "operation_type": "operationType",
      "target_type": "targetType",
      "target_id": "targetId",
      "before_state": "beforeState",
      "after_state": "afterState",
      "request_body": "requestBody",
      "event_ids": "eventIds",
      "idempotency_key": "idempotencyKey"
    },
    reservedFields: ["_schemaVersion", "_meta", "version"]
  },
  inventoryChecks: {
    schemaVersion: "2.0",
    entity: "inventoryChecks",
    dataKey: "checks",
    requiredFields: ["id", "status"],
    defaultFields: {
      operator: null,
      scannedItems: [],
      discrepancies: [],
      startedAt: null,
      completedAt: null,
      confirmedAt: null,
      note: null
    },
    fieldAliases: {
      "scanned_items": "scannedItems",
      "started_at": "startedAt",
      "completed_at": "completedAt",
      "confirmed_at": "confirmedAt"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  complianceReports: {
    schemaVersion: "2.0",
    entity: "complianceReports",
    dataKey: "reports",
    requiredFields: ["id", "status"],
    defaultFields: {
      params: null,
      requestedBy: null,
      progress: null,
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      lastRetriedAt: null
    },
    fieldAliases: {
      "requested_by": "requestedBy",
      "started_at": "startedAt",
      "completed_at": "completedAt",
      "retry_count": "retryCount",
      "last_retried_at": "lastRetriedAt"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  idempotency: {
    schemaVersion: "2.0",
    entity: "idempotency",
    dataKey: "records",
    requiredFields: ["key", "status"],
    defaultFields: {
      requestHash: null,
      response: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      lockId: null,
      lockExpiresAt: null
    },
    fieldAliases: {
      "request_hash": "requestHash",
      "created_at": "createdAt",
      "updated_at": "updatedAt",
      "expires_at": "expiresAt",
      "lock_id": "lockId",
      "lock_expires_at": "lockExpiresAt"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  users: {
    schemaVersion: "2.0",
    entity: "users",
    dataKey: "users",
    storageType: "array",
    requiredFields: ["id", "username"],
    defaultFields: {
      role: "user",
      name: null,
      createdAt: null,
      lastLogin: null,
      active: true
    },
    fieldAliases: {},
    reservedFields: ["_schemaVersion", "_meta"]
  },
  tokens: {
    schemaVersion: "2.0",
    entity: "tokens",
    dataKey: "tokens",
    storageType: "array",
    requiredFields: ["token", "userId"],
    defaultFields: {
      createdAt: null,
      expiresAt: null,
      lastUsed: null,
      userAgent: null
    },
    fieldAliases: {
      "user_id": "userId",
      "created_at": "createdAt",
      "expires_at": "expiresAt",
      "last_used": "lastUsed",
      "user_agent": "userAgent"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  }
};

export const V3_SCHEMAS = {
  cylinders: {
    schemaVersion: "3.0",
    entity: "cylinders",
    dataKey: "cylinders",
    requiredFields: ["id", "gasType", "capacity", "inspectionDue", "location", "status"],
    defaultFields: {
      customer: null,
      depositStatus: "none",
      fills: [],
      events: [],
      statusHistory: STATUS_HISTORY_DEFAULTS
    },
    fieldAliases: {
      "gas_type": "gasType",
      "inspection_due": "inspectionDue",
      "deposit_status": "depositStatus",
      "status_history": "statusHistory"
    },
    hasStatusHistory: true,
    reservedFields: ["_schemaVersion", "_meta", "_migratedFrom"]
  },
  customers: {
    schemaVersion: "3.0",
    entity: "customers",
    dataKey: "customers",
    requiredFields: ["id", "name"],
    defaultFields: {
      contact: null,
      phone: null,
      address: null,
      createdAt: null
    },
    fieldAliases: {
      "customer_name": "name",
      "contact_person": "contact",
      "phone_number": "phone"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  rentalOrders: {
    schemaVersion: "3.0",
    entity: "rentalOrders",
    dataKey: "orders",
    requiredFields: ["id", "customerId", "customerName", "cylinders"],
    defaultFields: {
      cylinderCount: 0,
      note: "",
      status: "completed",
      createdAt: null,
      returnedCount: 0,
      returnHistory: [],
      statusHistory: STATUS_HISTORY_DEFAULTS
    },
    fieldAliases: {
      "customer_id": "customerId",
      "customer_name": "customerName",
      "cylinder_count": "cylinderCount",
      "returned_count": "returnedCount",
      "return_history": "returnHistory",
      "status_history": "statusHistory"
    },
    hasStatusHistory: true,
    reservedFields: ["_schemaVersion", "_meta"]
  },
  inspectionTasks: {
    schemaVersion: "3.0",
    entity: "inspectionTasks",
    dataKey: "tasks",
    requiredFields: ["id", "cylinderId", "status"],
    defaultFields: {
      gasType: null,
      capacity: null,
      inspectionDue: null,
      result: null,
      createdAt: null,
      sentAt: null,
      inspectedAt: null,
      restockedAt: null,
      postponements: [],
      statusHistory: STATUS_HISTORY_DEFAULTS
    },
    fieldAliases: {
      "cylinder_id": "cylinderId",
      "gas_type": "gasType",
      "inspection_due": "inspectionDue",
      "sent_at": "sentAt",
      "inspected_at": "inspectedAt",
      "restocked_at": "restockedAt",
      "status_history": "statusHistory"
    },
    hasStatusHistory: true,
    reservedFields: ["_schemaVersion", "_meta"]
  },
  operationLogs: {
    schemaVersion: "3.0",
    entity: "operationLogs",
    dataKey: "logs",
    requiredFields: ["id", "operationType", "targetType"],
    defaultFields: {
      targetId: null,
      operator: null,
      beforeState: null,
      afterState: null,
      requestBody: null,
      eventIds: [],
      status: "success",
      error: null,
      createdAt: null,
      idempotencyKey: null
    },
    fieldAliases: {
      "operation_type": "operationType",
      "target_type": "targetType",
      "target_id": "targetId",
      "before_state": "beforeState",
      "after_state": "afterState",
      "request_body": "requestBody",
      "event_ids": "eventIds",
      "idempotency_key": "idempotencyKey"
    },
    reservedFields: ["_schemaVersion", "_meta", "version"]
  },
  inventoryChecks: {
    schemaVersion: "3.0",
    entity: "inventoryChecks",
    dataKey: "checks",
    requiredFields: ["id", "status"],
    defaultFields: {
      operator: null,
      scannedItems: [],
      discrepancies: [],
      startedAt: null,
      completedAt: null,
      confirmedAt: null,
      note: null,
      scannedEntries: [],
      scanIndexCounter: 0,
      expectedCount: 0,
      expectedCylinderIds: [],
      expectedCylinderDetails: [],
      differences: null,
      suggestions: null,
      statusHistory: STATUS_HISTORY_DEFAULTS
    },
    fieldAliases: {
      "scanned_items": "scannedItems",
      "started_at": "startedAt",
      "completed_at": "completedAt",
      "confirmed_at": "confirmedAt",
      "scanned_entries": "scannedEntries",
      "scan_index_counter": "scanIndexCounter",
      "expected_count": "expectedCount",
      "expected_cylinder_ids": "expectedCylinderIds",
      "expected_cylinder_details": "expectedCylinderDetails",
      "status_history": "statusHistory"
    },
    hasStatusHistory: true,
    reservedFields: ["_schemaVersion", "_meta"]
  },
  complianceReports: {
    schemaVersion: "3.0",
    entity: "complianceReports",
    dataKey: "reports",
    requiredFields: ["id", "status"],
    defaultFields: {
      params: null,
      requestedBy: null,
      progress: null,
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      lastRetriedAt: null
    },
    fieldAliases: {
      "requested_by": "requestedBy",
      "started_at": "startedAt",
      "completed_at": "completedAt",
      "retry_count": "retryCount",
      "last_retried_at": "lastRetriedAt"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  idempotency: {
    schemaVersion: "3.0",
    entity: "idempotency",
    dataKey: "records",
    requiredFields: ["key", "status"],
    defaultFields: {
      requestHash: null,
      response: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      lockId: null,
      lockExpiresAt: null
    },
    fieldAliases: {
      "request_hash": "requestHash",
      "created_at": "createdAt",
      "updated_at": "updatedAt",
      "expires_at": "expiresAt",
      "lock_id": "lockId",
      "lock_expires_at": "lockExpiresAt"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  },
  users: {
    schemaVersion: "3.0",
    entity: "users",
    dataKey: "users",
    storageType: "array",
    requiredFields: ["id", "username"],
    defaultFields: {
      role: "user",
      name: null,
      createdAt: null,
      lastLogin: null,
      active: true
    },
    fieldAliases: {},
    reservedFields: ["_schemaVersion", "_meta"]
  },
  tokens: {
    schemaVersion: "3.0",
    entity: "tokens",
    dataKey: "tokens",
    storageType: "array",
    requiredFields: ["token", "userId"],
    defaultFields: {
      createdAt: null,
      expiresAt: null,
      lastUsed: null,
      userAgent: null
    },
    fieldAliases: {
      "user_id": "userId",
      "created_at": "createdAt",
      "expires_at": "expiresAt",
      "last_used": "lastUsed",
      "user_agent": "userAgent"
    },
    reservedFields: ["_schemaVersion", "_meta"]
  }
};

export function getSchema(entity, version = null) {
  if (version === null || version >= 3) {
    return V3_SCHEMAS[entity] || V2_SCHEMAS[entity] || null;
  }
  return V2_SCHEMAS[entity] || null;
}

export function normalizeStatusHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { defaultFields } = STATUS_HISTORY_ENTRY_SCHEMA;
  const normalized = { ...entry };
  for (const [field, defaultValue] of Object.entries(defaultFields)) {
    if (normalized[field] === undefined) {
      normalized[field] = typeof defaultValue === "object" && defaultValue !== null
        ? JSON.parse(JSON.stringify(defaultValue))
        : defaultValue;
    }
  }
  return normalized;
}

export function normalizeStatusHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map(normalizeStatusHistoryEntry)
    .filter(Boolean)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

export function makeStatusHistoryId() {
  return `sh-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function addStatusHistory(item, { toStatus, fromStatus = null, at = null, note = null, operator = null, eventId = null, extra = null }) {
  if (!item || typeof item !== "object") return item;
  if (!Array.isArray(item.statusHistory)) {
    item.statusHistory = [];
  }
  const entry = normalizeStatusHistoryEntry({
    id: makeStatusHistoryId(),
    fromStatus,
    toStatus,
    at: at || new Date().toISOString(),
    note,
    operator,
    eventId,
    extra
  });
  item.statusHistory.push(entry);
  item.statusHistory = normalizeStatusHistory(item.statusHistory);
  return entry;
}

function applyFieldAliases(item, aliases) {
  if (!item || typeof item !== "object") return item;
  
  const result = { ...item };
  for (const [oldField, newField] of Object.entries(aliases)) {
    if (result[oldField] !== undefined && result[newField] === undefined) {
      result[newField] = result[oldField];
    }
  }
  return result;
}

function applyDefaultFields(item, defaults) {
  if (!item || typeof item !== "object") return item;
  
  const result = { ...item };
  for (const [field, defaultValue] of Object.entries(defaults)) {
    if (result[field] === undefined) {
      result[field] = typeof defaultValue === "object" && defaultValue !== null
        ? JSON.parse(JSON.stringify(defaultValue))
        : defaultValue;
    }
  }
  return result;
}

function stripReservedFields(item, reserved) {
  if (!item || typeof item !== "object") return item;
  
  const result = { ...item };
  for (const field of reserved) {
    delete result[field];
  }
  return result;
}

export function normalizeItemForAPI(item, entity, version = null) {
  const schema = getSchema(entity, version);
  if (!schema) return item;
  
  let normalized = applyFieldAliases(item, schema.fieldAliases);
  normalized = applyDefaultFields(normalized, schema.defaultFields);
  
  if (schema.hasStatusHistory && Array.isArray(normalized.statusHistory)) {
    normalized.statusHistory = normalizeStatusHistory(normalized.statusHistory);
  }
  
  normalized = stripReservedFields(normalized, schema.reservedFields);
  
  return normalized;
}

export function normalizeCollectionForAPI(collection, entity, version = null) {
  if (!Array.isArray(collection)) return collection;
  return collection.map(item => normalizeItemForAPI(item, entity, version));
}

export function validateItem(item, entity, version = null) {
  const schema = getSchema(entity, version);
  if (!schema) return { valid: true, errors: [] };
  
  const errors = [];
  
  for (const field of schema.requiredFields) {
    if (item[field] === undefined || item[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  if (schema.hasStatusHistory && Array.isArray(item.statusHistory)) {
    for (let i = 0; i < item.statusHistory.length; i++) {
      const entry = item.statusHistory[i];
      if (!entry || !entry.toStatus || !entry.at) {
        errors.push(`Invalid statusHistory entry at index ${i}`);
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

export async function ensureV2Compatibility(data, entity) {
  const version = await detectCurrentVersion();
  if (version < 2) return data;
  
  const schema = getSchema(entity, version);
  if (!schema) return data;
  
  const dataKey = getDataKey(entity);
  const collection = data[dataKey] || data[entity] || [];
  
  return {
    ...data,
    [dataKey]: collection.map(item => normalizeItemForAPI(item, entity, version))
  };
}

export async function ensureV3Compatibility(data, entity) {
  const version = await detectCurrentVersion();
  if (version < 3) return ensureV2Compatibility(data, entity);
  return ensureV2Compatibility(data, entity);
}

export function transformV1ToV2Item(item, entity) {
  return normalizeItemForAPI(item, entity, 2);
}

export function transformV2ToV3Item(item, entity) {
  const normalized = normalizeItemForAPI(item, entity, 3);
  const schema = getSchema(entity, 3);
  if (schema?.hasStatusHistory && (!Array.isArray(normalized.statusHistory) || normalized.statusHistory.length === 0)) {
    normalized.statusHistory = buildStatusHistoryFromExistingData(normalized, entity);
  }
  return normalized;
}

export function transformV3ToV2Item(item, entity) {
  const schema = getSchema(entity, 2);
  if (!schema) return item;
  
  const result = { ...item };
  delete result.statusHistory;
  
  for (const [oldField, newField] of Object.entries(schema.fieldAliases)) {
    if (result[newField] !== undefined && result[oldField] === undefined) {
      result[oldField] = result[newField];
    }
  }
  
  return result;
}

export function transformV2ToV1Item(item, entity) {
  const schema = getSchema(entity, 2);
  if (!schema) return item;
  
  const result = { ...item };
  delete result.statusHistory;
  
  for (const [oldField, newField] of Object.entries(schema.fieldAliases)) {
    if (result[newField] !== undefined && result[oldField] === undefined) {
      result[oldField] = result[newField];
    }
  }
  
  return result;
}

const CYLINDER_EVENT_TO_STATUS = {
  create: "in_stock",
  inbound: "in_stock",
  outbound: "rented",
  return: "returned",
  inspect: "inspection",
  inspect_pass: "inspection",
  inspect_fail: "scrapped",
  inspect_postpone: "inspection",
  scrap: "scrapped",
  mark_pending_check: "pending_check",
  clear_pending_check: "in_stock",
  fill: null,
  inventory_check: "pending_check",
  inventory_migrate: null
};

function buildStatusHistoryFromExistingData(item, entity) {
  const history = [];
  const now = new Date().toISOString();

  switch (entity) {
    case "cylinders": {
      if (Array.isArray(item.events) && item.events.length > 0) {
        let prevStatus = null;
        const sortedEvents = [...item.events].sort(
          (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
        );
        for (const evt of sortedEvents) {
          const mappedStatus = CYLINDER_EVENT_TO_STATUS[evt.type];
          const isInfoOnlyEvent = mappedStatus === null || mappedStatus === undefined;
          const isStateChange = mappedStatus && mappedStatus !== prevStatus;
          const isInspectPostpone = evt.type === "inspect_postpone";
          const shouldRecord = isStateChange || isInfoOnlyEvent || isInspectPostpone;
          
          if (shouldRecord) {
            const effectiveToStatus = mappedStatus || prevStatus || item.status || "in_stock";
            const effectiveFromStatus = isInfoOnlyEvent || isInspectPostpone ? effectiveToStatus : prevStatus;
            
            history.push({
              id: makeStatusHistoryId(),
              fromStatus: effectiveFromStatus,
              toStatus: effectiveToStatus,
              at: evt.at || now,
              note: evt.note || evt.type,
              eventId: evt.id || null,
              operator: null,
              extra: { eventType: evt.type }
            });
            if (mappedStatus && mappedStatus !== prevStatus) {
              prevStatus = mappedStatus;
            }
          }
        }
      }
      if (item.status && (history.length === 0 || history[history.length - 1].toStatus !== item.status)) {
        const lastStatus = history.length > 0 ? history[history.length - 1].toStatus : null;
        history.push({
          id: makeStatusHistoryId(),
          fromStatus: lastStatus,
          toStatus: item.status,
          at: now,
          note: "从当前状态回溯生成",
          operator: null,
          eventId: null,
          extra: { backfilled: true }
        });
      }
      break;
    }
    case "rentalOrders": {
      if (item.createdAt || item.status) {
        history.push({
          id: makeStatusHistoryId(),
          fromStatus: null,
          toStatus: item.status || "completed",
          at: item.createdAt || now,
          note: "订单创建",
          operator: null,
          eventId: null,
          extra: { backfilled: true }
        });
      }
      if (Array.isArray(item.returnHistory)) {
        const sortedReturns = [...item.returnHistory].sort(
          (a, b) => new Date(a.returnedAt).getTime() - new Date(b.returnedAt).getTime()
        );
        for (const ret of sortedReturns) {
          const returnStatus = ret.cylinders?.length >= (item.cylinders?.length || 0)
            ? "fully_returned"
            : "partially_returned";
          history.push({
            id: makeStatusHistoryId(),
            fromStatus: history.length > 0 ? history[history.length - 1].toStatus : (item.status || "completed"),
            toStatus: returnStatus,
            at: ret.returnedAt || now,
            note: ret.note || "订单归还",
            operator: null,
            eventId: ret.id || null,
            extra: { returnId: ret.id, backfilled: true }
          });
        }
      }
      if (item.status && (history.length === 0 || history[history.length - 1].toStatus !== item.status)) {
        history.push({
          id: makeStatusHistoryId(),
          fromStatus: history.length > 0 ? history[history.length - 1].toStatus : null,
          toStatus: item.status,
          at: now,
          note: "从当前状态回溯生成",
          operator: null,
          eventId: null,
          extra: { backfilled: true }
        });
      }
      break;
    }
    case "inspectionTasks": {
      const timeline = [];
      if (item.createdAt) timeline.push({ status: "pending", at: item.createdAt, note: "任务创建", type: "state" });
      if (item.sentAt) timeline.push({ status: "sent", at: item.sentAt, note: "任务送检", type: "state" });
      if (item.inspectedAt && item.result?.passed === true) timeline.push({ status: "passed", at: item.inspectedAt, note: "检验合格", type: "state" });
      if (item.inspectedAt && item.result?.passed === false) timeline.push({ status: "failed", at: item.inspectedAt, note: "检验不合格", type: "state" });
      if (item.restockedAt) timeline.push({ status: "restocked", at: item.restockedAt, note: "任务回库", type: "state" });
      
      if (Array.isArray(item.postponements)) {
        for (const p of item.postponements) {
          timeline.push({
            status: item.status || "pending",
            at: p.postponedAt || now,
            note: `延期：${p.reason || ""}（${p.oldInspectionDue}→${p.newInspectionDue}）`,
            type: "info",
            extra: { postponementId: p.id, oldInspectionDue: p.oldInspectionDue, newInspectionDue: p.newInspectionDue }
          });
        }
      }
      
      if (Array.isArray(item.statusHistory) && item.statusHistory.length > 0) {
        for (const entry of item.statusHistory) {
          timeline.push({
            status: entry.toStatus || entry.status,
            prevStatus: entry.fromStatus,
            at: entry.at || now,
            note: entry.note,
            type: entry.fromStatus === entry.toStatus ? "info" : "state",
            fromExisting: true,
            extra: entry.extra
          });
        }
      }

      timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      
      let prevStatus = null;
      for (const t of timeline) {
        const isStateChange = t.type !== "info" && t.status !== prevStatus;
        const isInfoRecord = t.type === "info";
        if (isStateChange || isInfoRecord || t.fromExisting) {
          history.push({
            id: makeStatusHistoryId(),
            fromStatus: t.prevStatus !== undefined ? t.prevStatus : prevStatus,
            toStatus: t.status,
            at: t.at,
            note: t.note || null,
            operator: null,
            eventId: null,
            extra: { ...(t.extra || {}), backfilled: !t.fromExisting }
          });
          if (t.type !== "info") {
            prevStatus = t.status;
          }
        }
      }

      if (item.status && (history.length === 0 || history[history.length - 1].toStatus !== item.status)) {
        history.push({
          id: makeStatusHistoryId(),
          fromStatus: prevStatus,
          toStatus: item.status,
          at: now,
          note: "从当前状态回溯生成",
          operator: null,
          eventId: null,
          extra: { backfilled: true }
        });
      }
      break;
    }
    case "inventoryChecks": {
      const timeline = [];
      if (item.createdAt) timeline.push({ status: "draft", at: item.createdAt, note: "盘点单创建" });
      if (item.scanningStartedAt) timeline.push({ status: "scanning", at: item.scanningStartedAt, note: "开始盘点" });
      if (item.completedAt) timeline.push({ status: "completed", at: item.completedAt, note: "盘点完成" });
      if (item.confirmedAt) timeline.push({ status: "confirmed", at: item.confirmedAt, note: "盘点确认" });
      
      timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      
      let prevStatus = null;
      for (const t of timeline) {
        if (t.status !== prevStatus) {
          history.push({
            id: makeStatusHistoryId(),
            fromStatus: prevStatus,
            toStatus: t.status,
            at: t.at,
            note: t.note || null,
            operator: item.createdBy || item.confirmedBy || null,
            eventId: null,
            extra: { backfilled: true }
          });
          prevStatus = t.status;
        }
      }

      if (item.status && (history.length === 0 || history[history.length - 1].toStatus !== item.status)) {
        history.push({
          id: makeStatusHistoryId(),
          fromStatus: prevStatus,
          toStatus: item.status,
          at: now,
          note: "从当前状态回溯生成",
          operator: null,
          eventId: null,
          extra: { backfilled: true }
        });
      }
      break;
    }
  }

  return normalizeStatusHistory(history);
}

export const DATA_ENTITY_MAP = {
  "cylinders.json": "cylinders",
  "customers.json": "customers",
  "rentalOrders.json": "rentalOrders",
  "inspectionTasks.json": "inspectionTasks",
  "operationLogs.json": "operationLogs",
  "inventoryChecks.json": "inventoryChecks",
  "complianceReports.json": "complianceReports",
  "idempotency.json": "idempotency",
  "users.json": "users",
  "tokens.json": "tokens"
};

export function getEntityFromFilename(filename) {
  return DATA_ENTITY_MAP[filename] || null;
}
