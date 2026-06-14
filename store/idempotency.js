import { loadJson, saveJson, genId } from "./common.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
const lockDir = join(dataDir, "locks");

const IDEMPOTENCY_FILE = "idempotency.json";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

const SEED = {
  records: {},
  version: 1
};

let cache = null;
let cacheLoaded = false;
const writeQueue = Promise.resolve();
const inFlightLocks = new Map();

function hashRequestBody(body) {
  const str = typeof body === "string" ? body : JSON.stringify(body || {});
  return createHash("sha256").update(str).digest("hex");
}

async function ensureLockDir() {
  try {
    await access(lockDir);
  } catch {
    await mkdir(lockDir, { recursive: true });
  }
}

async function acquireFileLock(key) {
  await ensureLockDir();
  const lockFile = join(lockDir, `idem-${key}.lock`);
  const started = Date.now();
  const timeout = 10000;

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
  throw new Error("lock_timeout");
}

function acquireInMemoryLock(key) {
  if (inFlightLocks.has(key)) {
    return inFlightLocks.get(key).promise;
  }
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  inFlightLocks.set(key, { promise, resolve });
  return null;
}

function releaseInMemoryLock(key) {
  const lock = inFlightLocks.get(key);
  if (lock) {
    inFlightLocks.delete(key);
    lock.resolve();
  }
}

async function loadRecords() {
  if (cacheLoaded && cache) return cache;
  const db = await loadJson(IDEMPOTENCY_FILE, SEED);
  cache = db;
  cacheLoaded = true;
  await cleanupExpired();
  return cache;
}

async function persistRecords() {
  if (!cache) return;
  await saveJson(IDEMPOTENCY_FILE, cache);
}

async function cleanupExpired() {
  if (!cache) return;
  const now = Date.now();
  let changed = false;
  for (const [key, rec] of Object.entries(cache.records)) {
    const age = now - new Date(rec.createdAt).getTime();
    const isStaleProcessing =
      rec.status === "processing" && now - new Date(rec.createdAt).getTime() > PROCESSING_TIMEOUT_MS;
    if (age > IDEMPOTENCY_TTL_MS || isStaleProcessing) {
      delete cache.records[key];
      changed = true;
    }
  }
  if (changed) await persistRecords();
}

export async function recoverStaleProcessing() {
  const db = await loadRecords();
  const now = Date.now();
  const stale = [];
  for (const [key, rec] of Object.entries(db.records)) {
    if (rec.status === "processing" && now - new Date(rec.createdAt).getTime() > PROCESSING_TIMEOUT_MS) {
      stale.push(key);
    }
  }
  for (const key of stale) {
    delete db.records[key];
  }
  if (stale.length > 0) await persistRecords();
  return stale.length;
}

export function extractIdempotencyKey(req) {
  const header = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];
  return typeof header === "string" ? header.trim() : null;
}

export async function findIdempotencyRecord(key) {
  const db = await loadRecords();
  const rec = db.records[key];
  if (!rec) return null;
  const age = Date.now() - new Date(rec.createdAt).getTime();
  if (age > IDEMPOTENCY_TTL_MS) {
    delete db.records[key];
    await persistRecords();
    return null;
  }
  return rec;
}

export async function createIdempotencyRecord(key, { method, path, body, operator }) {
  const waitLock = acquireInMemoryLock(key);
  if (waitLock) {
    await waitLock;
    return findIdempotencyRecord(key);
  }

  const fileLock = await acquireFileLock(key);
  try {
    const existing = await findIdempotencyRecord(key);
    if (existing) {
      releaseInMemoryLock(key);
      return existing;
    }

    const db = await loadRecords();
    const record = {
      key,
      method,
      path,
      bodyHash: hashRequestBody(body),
      operator: operator || null,
      status: "processing",
      response: null,
      operationLogId: null,
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.records[key] = record;
    await persistRecords();
    releaseInMemoryLock(key);
    return record;
  } finally {
    await fileLock();
  }
}

export async function completeIdempotencyRecord(key, { statusCode, response, operationLogId }) {
  const waitLock = acquireInMemoryLock(key);
  if (waitLock) await waitLock;

  const fileLock = await acquireFileLock(key);
  try {
    const db = await loadRecords();
    const rec = db.records[key];
    if (!rec) {
      releaseInMemoryLock(key);
      return null;
    }
    rec.status = "completed";
    rec.response = { statusCode, body: response };
    rec.operationLogId = operationLogId || null;
    rec.completedAt = new Date().toISOString();
    await persistRecords();
    releaseInMemoryLock(key);
    return rec;
  } finally {
    await fileLock();
  }
}

export async function failIdempotencyRecord(key, { error }) {
  const waitLock = acquireInMemoryLock(key);
  if (waitLock) await waitLock;

  const fileLock = await acquireFileLock(key);
  try {
    const db = await loadRecords();
    if (!db.records[key]) {
      releaseInMemoryLock(key);
      return null;
    }
    delete db.records[key];
    await persistRecords();
    releaseInMemoryLock(key);
    return true;
  } finally {
    await fileLock();
  }
}

export function validateRequestMatch(record, { method, path, body }) {
  if (!record) return false;
  if (record.method !== method) return false;
  if (record.path !== path) return false;
  if (body !== undefined && record.bodyHash !== hashRequestBody(body)) return false;
  return true;
}

export function generateAutoKey({ method, path, body, operator, remoteAddress }) {
  const payload = {
    method,
    path,
    bodyHash: hashRequestBody(body),
    operator: operator || "anonymous",
    remoteAddress: remoteAddress || "",
    ts: Math.floor(Date.now() / 1000)
  };
  return `auto-${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32)}`;
}

export const IDEMPOTENCY_CONFIG = {
  TTL_MS: IDEMPOTENCY_TTL_MS,
  PROCESSING_TIMEOUT_MS,
  AUTO_KEY_ENABLED: true,
  REQUIRE_KEY: false
};
