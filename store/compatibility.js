import { detectCurrentVersion, getDataKey } from "./migration.js";

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

export function getSchema(entity) {
  return V2_SCHEMAS[entity] || null;
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

export function normalizeItemForAPI(item, entity) {
  const schema = getSchema(entity);
  if (!schema) return item;
  
  let normalized = applyFieldAliases(item, schema.fieldAliases);
  normalized = applyDefaultFields(normalized, schema.defaultFields);
  normalized = stripReservedFields(normalized, schema.reservedFields);
  
  return normalized;
}

export function normalizeCollectionForAPI(collection, entity) {
  if (!Array.isArray(collection)) return collection;
  return collection.map(item => normalizeItemForAPI(item, entity));
}

export function validateItem(item, entity) {
  const schema = getSchema(entity);
  if (!schema) return { valid: true, errors: [] };
  
  const errors = [];
  
  for (const field of schema.requiredFields) {
    if (item[field] === undefined || item[field] === null) {
      errors.push(`Missing required field: ${field}`);
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
  
  const schema = getSchema(entity);
  if (!schema) return data;
  
  const dataKey = getDataKey(entity);
  const collection = data[dataKey] || data[entity] || [];
  
  return {
    ...data,
    [dataKey]: collection.map(item => normalizeItemForAPI(item, entity))
  };
}

export function transformV1ToV2Item(item, entity) {
  return normalizeItemForAPI(item, entity);
}

export function transformV2ToV1Item(item, entity) {
  const schema = getSchema(entity);
  if (!schema) return item;
  
  const result = { ...item };
  
  for (const [oldField, newField] of Object.entries(schema.fieldAliases)) {
    if (result[newField] !== undefined && result[oldField] === undefined) {
      result[oldField] = result[newField];
    }
  }
  
  return result;
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
