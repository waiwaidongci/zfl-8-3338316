import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");

export function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

export async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function makeEvent(type, note) {
  return { id: genId("evt"), type, at: new Date().toISOString(), note };
}

export async function loadJson(filename, fallback) {
  const filePath = join(dataDir, filename);
  if (!existsSync(filePath)) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(fallback, null, 2));
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function saveJson(filename, data) {
  const filePath = join(dataDir, filename);
  await writeFile(filePath, JSON.stringify(data, null, 2));
}
