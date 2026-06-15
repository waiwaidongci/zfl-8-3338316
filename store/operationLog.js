import { loadJson, saveJson, genId } from "./common.js";
import { mkdir, writeFile, unlink, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
const lockDir = join(dataDir, "locks");

const OPLOG_FILE = "operationLogs.json";
export const SEED = {
  logs: [],
  version: 1
};

let cache = null;
let cacheLoaded = false;
const inMemoryLock = { busy: false, queue: [] };

async function ensureLockDir() {
  try {
    await access(lockDir);
  } catch {
    await mkdir(lockDir, { recursive: true });
  }
}

async function acquireGlobalLock() {
  await ensureLockDir();
  const lockFile = join(lockDir, "oplog.global.lock");
  const started = Date.now();
  const timeout = 15000;

  while (Date.now() - started < timeout) {
    try {
      await writeFile(lockFile, String(process.pid), { flag: "wx" });
      return async () => {
        try {
          await unlink(lockFile);
        } catch {}
      };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("oplog_lock_timeout");
}

async function acquireInMemoryLock() {
  if (!inMemoryLock.busy) {
    inMemoryLock.busy = true;
    return;
  }
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  inMemoryLock.queue.push(resolve);
  await promise;
}

function releaseInMemoryLock() {
  if (inMemoryLock.queue.length > 0) {
    const next = inMemoryLock.queue.shift();
    next();
  } else {
    inMemoryLock.busy = false;
  }
}

async function loadLogs() {
  if (cacheLoaded && cache) return cache;
  const db = await loadJson(OPLOG_FILE, SEED);
  cache = db;
  cacheLoaded = true;
  return cache;
}

async function persistLogs() {
  if (!cache) return;
  await saveJson(OPLOG_FILE, cache);
}

export const OPERATION_TYPES = {
  CYLINDER_CREATE: "cylinder.create",
  CYLINDER_BULK_CREATE: "cylinder.bulk_create",
  CYLINDER_ACTION: "cylinder.action",
  CYLINDER_FILL: "cylinder.fill",
  ORDER_CREATE: "order.create",
  INSPECTION_GENERATE: "inspection.generate",
  INSPECTION_SEND: "inspection.send",
  INSPECTION_INSPECT: "inspection.inspect",
  INSPECTION_RESTOCK: "inspection.restock",
  CUSTOMER_CREATE: "customer.create",
  INVENTORY_CREATE: "inventory.create",
  INVENTORY_START: "inventory.start",
  INVENTORY_SCAN: "inventory.scan",
  INVENTORY_COMPLETE: "inventory.complete",
  INVENTORY_CONFIRM: "inventory.confirm"
};

export const TARGET_TYPES = {
  CYLINDER: "cylinder",
  ORDER: "order",
  INSPECTION_TASK: "inspection_task",
  CUSTOMER: "customer",
  INVENTORY_CHECK: "inventory_check"
};

export function snapshotEntity(entity) {
  if (!entity) return null;
  return JSON.parse(JSON.stringify(entity));
}

export async function createOperationLog({
  idempotencyKey,
  operationType,
  targetType,
  targetId,
  operator,
  beforeState,
  afterState,
  requestBody,
  eventIds,
  status,
  error
}) {
  await acquireInMemoryLock();
  const fileLock = await acquireGlobalLock();
  try {
    const db = await loadLogs();
    const log = {
      id: genId("op"),
      idempotencyKey: idempotencyKey || null,
      operationType,
      targetType,
      targetId: targetId || null,
      operator: operator || null,
      beforeState: beforeState ? snapshotEntity(beforeState) : null,
      afterState: afterState ? snapshotEntity(afterState) : null,
      requestBody: requestBody ? snapshotEntity(requestBody) : null,
      eventIds: eventIds || [],
      status: status || "success",
      error: error || null,
      createdAt: new Date().toISOString()
    };
    db.logs.unshift(log);
    if (db.logs.length > 10000) {
      db.logs.length = 10000;
    }
    await persistLogs();
    return log;
  } finally {
    await fileLock();
    releaseInMemoryLock();
  }
}

export async function queryOperationLogs(filters = {}) {
  const db = await loadLogs();
  let result = db.logs;

  if (filters.operationType) {
    result = result.filter((l) => l.operationType === filters.operationType);
  }
  if (filters.targetType) {
    result = result.filter((l) => l.targetType === filters.targetType);
  }
  if (filters.targetId) {
    result = result.filter((l) => l.targetId === filters.targetId);
  }
  if (filters.idempotencyKey) {
    result = result.filter((l) => l.idempotencyKey === filters.idempotencyKey);
  }
  if (filters.operator) {
    result = result.filter((l) => l.operator === filters.operator);
  }
  if (filters.status) {
    result = result.filter((l) => l.status === filters.status);
  }
  if (filters.startAt) {
    const start = new Date(filters.startAt).getTime();
    if (!isNaN(start)) {
      result = result.filter((l) => new Date(l.createdAt).getTime() >= start);
    }
  }
  if (filters.endAt) {
    const end = new Date(filters.endAt).getTime();
    if (!isNaN(end)) {
      result = result.filter((l) => new Date(l.createdAt).getTime() <= end);
    }
  }

  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(filters.pageSize, 10) || 20));
  const totalCount = result.length;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const start = (page - 1) * pageSize;
  const items = result.slice(start, start + pageSize);

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

export async function getOperationLog(id) {
  const db = await loadLogs();
  return db.logs.find((l) => l.id === id) || null;
}

export async function findOperationByIdempotencyKey(idempotencyKey) {
  const db = await loadLogs();
  return db.logs.find((l) => l.idempotencyKey === idempotencyKey) || null;
}
