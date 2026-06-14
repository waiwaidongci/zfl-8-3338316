import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");

const writeLocks = new Map();

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

export async function loadJson(filename, fallback) {
  const filePath = join(dataDir, filename);
  await ensureDir(dirname(filePath));
  if (!existsSync(filePath)) {
    await atomicWriteFile(filePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    const backupPath = filePath + ".bak";
    if (existsSync(backupPath)) {
      try {
        const backupContent = await readFile(backupPath, "utf8");
        const parsed = JSON.parse(backupContent);
        await atomicWriteFile(filePath, backupContent);
        return parsed;
      } catch {}
    }
    await atomicWriteFile(filePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

async function atomicWriteFile(filePath, content) {
  const waitLock = acquireWriteLock(filePath);
  if (waitLock) {
    await waitLock;
    return atomicWriteFile(filePath, content);
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

export async function saveJson(filename, data) {
  const filePath = join(dataDir, filename);
  await ensureDir(dirname(filePath));
  const content = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, content);
}
