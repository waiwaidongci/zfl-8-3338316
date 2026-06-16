import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { detectCurrentVersion, getDataDirForVersion, getDataKey } from "./migration.js";
import { normalizeItemForAPI, getEntityFromFilename, getSchema } from "./compatibility.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const baseDataDir = join(projectRoot, "data");

let currentDataVersion = null;
let cachedDataDir = null;

async function getDataDir() {
  if (cachedDataDir) return cachedDataDir;
  try {
    currentDataVersion = await detectCurrentVersion();
    cachedDataDir = getDataDirForVersion(currentDataVersion);
    return cachedDataDir;
  } catch (err) {
    console.warn(`[common] Failed to detect version, using base data dir: ${err.message}`);
    return baseDataDir;
  }
}

export function clearDataDirCache() {
  cachedDataDir = null;
  currentDataVersion = null;
}

export async function getCurrentDataVersion() {
  if (currentDataVersion === null) {
    currentDataVersion = await detectCurrentVersion();
  }
  return currentDataVersion;
}

const writeLocks = new Map();
const txQueues = new Map();
const jsonCache = new Map();

function acquireWriteLock(filePath) {
  if (writeLocks.has(filePath)) {
    return writeLocks.get(filePath).promise;
  }
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  writeLocks.set(filePath, { promise, resolve });
  return null;
}

function releaseWriteLock(filePath) {
  const lock = writeLocks.get(filePath);
  if (lock) {
    writeLocks.delete(filePath);
    lock.resolve();
  }
}

function acquireTxLock(key) {
  if (!txQueues.has(key)) {
    txQueues.set(key, []);
    return null;
  }
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  txQueues.get(key).push(resolve);
  return promise;
}

function releaseTxLock(key) {
  const queue = txQueues.get(key);
  if (!queue) return;
  if (queue.length === 0) {
    txQueues.delete(key);
    return;
  }
  const next = queue.shift();
  next();
}

function sortFilenames(filenames) {
  return [...filenames].sort();
}

async function acquireSortedTxLocks(filenames) {
  const sorted = sortFilenames(filenames);
  const acquired = [];
  try {
    for (const name of sorted) {
      const wait = acquireTxLock(name);
      if (wait) {
        await wait;
      }
      acquired.push(name);
    }
  } catch (err) {
    for (let i = acquired.length - 1; i >= 0; i--) {
      releaseTxLock(acquired[i]);
    }
    throw err;
  }
  return acquired;
}

function releaseSortedTxLocks(filenames) {
  const sorted = sortFilenames(filenames);
  for (let i = sorted.length - 1; i >= 0; i--) {
    releaseTxLock(sorted[i]);
  }
}

export function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

export async function body(req) {
  if (req._bodyParsed !== undefined) return req._bodyParsed;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  req._rawBody = raw;
  req._bodyParsed = raw.length ? JSON.parse(raw) : {};
  return req._bodyParsed;
}

export function getParsedBody(req) {
  return req._bodyParsed !== undefined ? req._bodyParsed : null;
}

export function getRawBody(req) {
  return req._rawBody !== undefined ? req._rawBody : null;
}

export function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function makeEvent(type, note) {
  return { id: genId("evt"), type, at: new Date().toISOString(), note };
}

async function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

export async function loadJson(filename, fallback, { skipCache = false } = {}) {
  const dynamicDataDir = await getDataDir();
  const filePath = join(dynamicDataDir, filename);
  await ensureDir(dirname(filePath));
  
  if (!skipCache && jsonCache.has(filename)) {
    return jsonCache.get(filename);
  }
  
  if (!existsSync(filePath)) {
    const fallbackClone = JSON.parse(JSON.stringify(fallback));
    const versionedFallback = await addVersionMeta(fallbackClone, filename);
    await atomicWriteFile(filePath, JSON.stringify(versionedFallback, null, 2));
    const normalizedFallback = normalizeForCompatibility(versionedFallback, filename);
    jsonCache.set(filename, normalizedFallback);
    return normalizedFallback;
  }
  
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    const normalized = normalizeForCompatibility(parsed, filename);
    jsonCache.set(filename, normalized);
    return normalized;
  } catch (err) {
    const backupPath = filePath + ".bak";
    if (existsSync(backupPath)) {
      try {
        const backupContent = await readFile(backupPath, "utf8");
        const parsed = JSON.parse(backupContent);
        const normalized = normalizeForCompatibility(parsed, filename);
        await atomicWriteFile(filePath, backupContent);
        jsonCache.set(filename, normalized);
        return normalized;
      } catch {}
    }
    const fallbackClone = JSON.parse(JSON.stringify(fallback));
    const versionedFallback = await addVersionMeta(fallbackClone, filename);
    await atomicWriteFile(filePath, JSON.stringify(versionedFallback, null, 2));
    const normalizedFallback = normalizeForCompatibility(versionedFallback, filename);
    jsonCache.set(filename, normalizedFallback);
    return normalizedFallback;
  }
}

export function invalidateJsonCache(filename) {
  jsonCache.delete(filename);
}

export async function withJsonTx(filename, fallback, mutator) {
  const acquired = await acquireSortedTxLocks([filename]);
  try {
    const db = await loadJson(filename, fallback, { skipCache: true });
    const result = await mutator(db);
    const cloneForWrite = JSON.parse(JSON.stringify(db));
    await saveJson(filename, cloneForWrite);
    jsonCache.set(filename, db);
    return result;
  } finally {
    releaseSortedTxLocks(acquired);
  }
}

export async function withMultiJsonTx(fileEntries, mutator) {
  const filenames = fileEntries.map((e) => e.filename);
  const acquired = await acquireSortedTxLocks(filenames);
  try {
    const dbs = {};
    for (const { filename, fallback } of fileEntries) {
      dbs[filename] = await loadJson(filename, fallback, { skipCache: true });
    }
    const result = await mutator(dbs);
    for (const { filename } of fileEntries) {
      const cloneForWrite = JSON.parse(JSON.stringify(dbs[filename]));
      await saveJson(filename, cloneForWrite);
      jsonCache.set(filename, dbs[filename]);
    }
    return result;
  } finally {
    releaseSortedTxLocks(acquired);
  }
}

async function atomicWriteFile(filePath, content) {
  const waitLock = acquireWriteLock(filePath);
  if (waitLock) {
    await waitLock;
  }

  const tmpPath = filePath + ".tmp." + createHash("md5").update(String(Date.now() + Math.random())).digest("hex").slice(0, 8);

  try {
    await writeFile(tmpPath, content, { encoding: "utf8" });
    if (existsSync(filePath)) {
      const bakPath = filePath + ".bak";
      try {
        await rename(filePath, bakPath);
      } catch {}
    }
    await rename(tmpPath, filePath);
  } finally {
    try {
      if (existsSync(tmpPath)) {
        await unlink(tmpPath);
      }
    } catch {}
    releaseWriteLock(filePath);
  }
}

async function addVersionMeta(data, filename) {
  const version = await getCurrentDataVersion();
  if (version < 2) {
    return data;
  }
  
  const schemaVersionStr = version >= 3 ? "3.0" : "2.0";
  const entity = getEntityFromFilename(filename);
  const schema = entity ? getSchema(entity, version) : null;
  const isArrayStorage = schema?.storageType === "array";
  
  if (!isArrayStorage && data._schemaVersion) {
    if (version >= 3 && data._schemaVersion !== schemaVersionStr) {
      return { ...data, _schemaVersion: schemaVersionStr };
    }
    return data;
  }
  
  if (isArrayStorage && Array.isArray(data)) {
    return {
      _schemaVersion: schemaVersionStr,
      _meta: {
        createdAt: new Date().toISOString(),
        entity,
        sourceFile: filename,
        storageType: "array"
      },
      [schema.dataKey]: data
    };
  }
  
  return {
    ...data,
    _schemaVersion: schemaVersionStr,
    _meta: {
      createdAt: new Date().toISOString(),
      entity: entity || filename.replace(".json", ""),
      sourceFile: filename
    }
  };
}

function normalizeForCompatibility(data, filename) {
  const entity = getEntityFromFilename(filename);
  const schema = entity ? getSchema(entity) : null;
  const isArrayStorage = schema?.storageType === "array";
  
  if (isArrayStorage && Array.isArray(data)) {
    return data.map(item => normalizeItemForAPI(item, entity));
  }
  
  if (!data._schemaVersion) {
    if (entity && !isArrayStorage) {
      const dataKey = getDataKey(entity);
      const collection = data[dataKey] || data[entity] || [];
      if (Array.isArray(collection)) {
        return {
          ...data,
          [dataKey]: collection.map(item => normalizeItemForAPI(item, entity))
        };
      }
    }
    return data;
  }
  
  const { _schemaVersion, _meta, ...rest } = data;
  
  if (entity && isArrayStorage) {
    const dataKey = getDataKey(entity);
    const collection = rest[dataKey] || rest[entity] || [];
    if (Array.isArray(collection)) {
      return collection.map(item => normalizeItemForAPI(item, entity));
    }
    return [];
  }
  
  if (entity) {
    const dataKey = getDataKey(entity);
    const collection = rest[dataKey] || rest[entity] || [];
    if (Array.isArray(collection)) {
      return {
        ...rest,
        [dataKey]: collection.map(item => normalizeItemForAPI(item, entity))
      };
    }
  }
  
  return rest;
}

function stripVersionMetaForWrite(data) {
  if (!data || !data._schemaVersion) {
    return data;
  }
  
  const result = { ...data };
  return result;
}

export async function saveJson(filename, data) {
  const dynamicDataDir = await getDataDir();
  const filePath = join(dynamicDataDir, filename);
  await ensureDir(dirname(filePath));
  
  const dataToWrite = stripVersionMetaForWrite(data);
  const versionedData = await addVersionMeta(dataToWrite, filename);
  const content = JSON.stringify(versionedData, null, 2);
  await atomicWriteFile(filePath, content);
  jsonCache.set(filename, normalizeForCompatibility(versionedData, filename));
}
