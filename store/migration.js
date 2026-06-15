import { mkdir, readFile, writeFile, copyFile, access, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const dataDir = join(projectRoot, "data");
const backupsDir = join(dataDir, "backups");
const metaFile = join(dataDir, "meta.json");

export const CURRENT_VERSION = 2;

export const ENTITY_FILES = {
  cylinders: "cylinders.json",
  customers: "customers.json",
  rentalOrders: "rentalOrders.json",
  inspectionTasks: "inspectionTasks.json",
  operationLogs: "operationLogs.json",
  inventoryChecks: "inventoryChecks.json",
  idempotency: "idempotency.json",
  users: "users.json",
  tokens: "tokens.json"
};

export const V1_FILES = [
  "cylinders.json",
  "customers.json",
  "rentalOrders.json",
  "inspectionTasks.json",
  "operationLogs.json",
  "inventoryChecks.json",
  "idempotency.json"
];

const MIGRATIONS = [
  {
    version: 2,
    description: "版本化目录结构 - 实体独立存储与Schema版本管理",
    up: migrateV1ToV2,
    down: rollbackV2ToV1
  }
];

function generateBackupName(fromVersion, toVersion) {
  const timestamp = new Date().toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\..*$/, "");
  return `v${fromVersion}-to-v${toVersion}-${timestamp}`;
}

async function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

async function loadMeta() {
  if (!existsSync(metaFile)) {
    return {
      currentVersion: 1,
      migrations: [],
      createdAt: new Date().toISOString()
    };
  }
  try {
    const content = await readFile(metaFile, "utf8");
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to load meta.json: ${err.message}`);
  }
}

async function saveMeta(meta) {
  await ensureDir(dataDir);
  await writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupFiles(sourceDir, targetDir, files) {
  await ensureDir(targetDir);
  const backedUp = [];
  
  for (const file of files) {
    const sourcePath = join(sourceDir, file);
    const targetPath = join(targetDir, file);
    
    if (await fileExists(sourcePath)) {
      await copyFile(sourcePath, targetPath);
      backedUp.push(file);
    } else {
      console.warn(`[Migration] File not found for backup: ${file}`);
    }
  }
  
  return backedUp;
}

async function createBackupMeta(backupDir, fromVersion, toVersion, files) {
  const meta = {
    backupName: basename(backupDir),
    fromVersion,
    toVersion,
    timestamp: new Date().toISOString(),
    files
  };
  await writeFile(join(backupDir, "backup-meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

async function detectCurrentVersion() {
  const meta = await loadMeta();
  if (meta.currentVersion) {
    return meta.currentVersion;
  }
  
  const hasV1Files = V1_FILES.some(f => existsSync(join(dataDir, f)));
  const hasV2Dir = existsSync(join(dataDir, "v2"));
  
  if (hasV2Dir) return 2;
  if (hasV1Files) return 1;
  return 1;
}

async function validateV1Data() {
  const errors = [];
  for (const file of V1_FILES) {
    const filePath = join(dataDir, file);
    if (await fileExists(filePath)) {
      try {
        const content = await readFile(filePath, "utf8");
        JSON.parse(content);
      } catch (err) {
        errors.push(`Invalid JSON in ${file}: ${err.message}`);
      }
    }
  }
  return errors;
}

async function loadJsonFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function migrateV1ToV2(context) {
  const { backupDir } = context;
  const v2Dir = join(dataDir, "v2");
  await ensureDir(v2Dir);
  
  const migratedFiles = [];
  
  for (const entity of Object.keys(ENTITY_FILES)) {
    const fileName = ENTITY_FILES[entity];
    const v1Path = join(dataDir, fileName);
    
    if (!(await fileExists(v1Path))) {
      console.warn(`[Migration] V1 file not found: ${fileName}, creating empty v2 file`);
      await createEmptyV2Entity(v2Dir, entity, fileName);
      migratedFiles.push(fileName);
      continue;
    }
    
    const v1Data = await loadJsonFile(v1Path);
    const v2Data = transformToV2Schema(v1Data, entity, fileName);
    const v2Path = join(v2Dir, fileName);
    
    await writeFile(v2Path, JSON.stringify(v2Data, null, 2), "utf8");
    migratedFiles.push(fileName);
  }
  
  const readme = createV2Readme();
  await writeFile(join(v2Dir, "README.md"), readme, "utf8");
  
  return {
    migratedFiles,
    targetDir: v2Dir
  };
}

function transformToV2Schema(v1Data, entity, sourceFile) {
  const now = new Date().toISOString();
  const dataKey = getDataKey(entity);
  
  return {
    [dataKey]: v1Data[dataKey] || v1Data[entity] || [],
    _schemaVersion: "2.0",
    _meta: {
      createdAt: now,
      migratedAt: now,
      migratedFrom: "v1",
      entity,
      sourceFile
    }
  };
}

function getDataKey(entity) {
  const keyMap = {
    cylinders: "cylinders",
    customers: "customers",
    rentalOrders: "orders",
    inspectionTasks: "tasks",
    operationLogs: "logs",
    inventoryChecks: "checks",
    idempotency: "records",
    users: "users",
    tokens: "tokens"
  };
  return keyMap[entity] || entity;
}

async function createEmptyV2Entity(v2Dir, entity, fileName) {
  const dataKey = getDataKey(entity);
  const v2Data = {
    [dataKey]: [],
    _schemaVersion: "2.0",
    _meta: {
      createdAt: new Date().toISOString(),
      initialized: true,
      entity,
      sourceFile: fileName
    }
  };
  await writeFile(join(v2Dir, fileName), JSON.stringify(v2Data, null, 2), "utf8");
}

function createV2Readme() {
  return `# v2 数据目录

版本: 2.0
创建时间: ${new Date().toISOString()}

## 概述

v2 数据结构引入了版本化数据目录和每个实体独立的Schema版本管理。

## 实体文件

| 文件 | 实体 | Schema版本 |
|------|------|------------|
| cylinders.json | cylinders | 2.0 |
| customers.json | customers | 2.0 |
| rentalOrders.json | orders | 2.0 |
| inspectionTasks.json | tasks | 2.0 |
| operationLogs.json | logs | 2.0 |
| inventoryChecks.json | checks | 2.0 |
| idempotency.json | records | 2.0 |
| users.json | users | 2.0 |
| tokens.json | tokens | 2.0 |

## 数据结构变更

- 每个数据文件增加 \`_schemaVersion\` 和 \`_meta\` 字段
- 数据文件集中在版本目录下，便于多版本共存
- 支持增量迁移和回滚

## 注意事项

- 请勿直接修改此目录下的文件，除非你清楚自己在做什么
- 数据迁移时会自动创建备份到 \`../backups/\` 目录
`;
}

async function rollbackV2ToV1(context) {
  const { backupDir } = context;
  const backupMetaPath = join(backupDir, "backup-meta.json");
  
  if (!(await fileExists(backupMetaPath))) {
    throw new Error(`Backup meta not found in ${backupDir}`);
  }
  
  const backupMeta = await loadJsonFile(backupMetaPath);
  const restoredFiles = [];
  
  for (const file of backupMeta.files) {
    const backupPath = join(backupDir, file);
    const targetPath = join(dataDir, file);
    
    if (await fileExists(backupPath)) {
      await copyFile(backupPath, targetPath);
      restoredFiles.push(file);
    }
  }
  
  const v2Dir = join(dataDir, "v2");
  if (await fileExists(v2Dir)) {
    await rm(v2Dir, { recursive: true, force: true });
  }
  
  return { restoredFiles };
}

async function verifyMigration(fromVersion, toVersion, result) {
  const errors = [];
  const v2Dir = join(dataDir, "v2");
  
  for (const entity of Object.keys(ENTITY_FILES)) {
    const fileName = ENTITY_FILES[entity];
    const filePath = join(v2Dir, fileName);
    
    if (!(await fileExists(filePath))) {
      errors.push(`Missing v2 file: ${fileName}`);
      continue;
    }
    
    try {
      const data = await loadJsonFile(filePath);
      if (!data._schemaVersion || data._schemaVersion !== "2.0") {
        errors.push(`Invalid schema version in ${fileName}`);
      }
      if (!data._meta) {
        errors.push(`Missing _meta in ${fileName}`);
      }
    } catch (err) {
      errors.push(`Failed to validate ${fileName}: ${err.message}`);
    }
  }
  
  return errors;
}

export async function runMigrations(targetVersion = CURRENT_VERSION, options = {}) {
  const currentVersion = await detectCurrentVersion();
  const meta = await loadMeta();
  
  if (currentVersion === targetVersion) {
    return {
      success: true,
      skipped: true,
      message: `Already at version ${targetVersion}`,
      currentVersion
    };
  }
  
  if (currentVersion > targetVersion) {
    return await runRollback(currentVersion, targetVersion, options);
  }
  
  return await runUpgrade(currentVersion, targetVersion, meta, options);
}

async function runUpgrade(fromVersion, toVersion, meta, options = {}) {
  const backupName = generateBackupName(fromVersion, toVersion);
  const backupDir = join(backupsDir, backupName);
  
  console.log(`[Migration] Starting migration from v${fromVersion} to v${toVersion}`);
  console.log(`[Migration] Backup directory: ${backupDir}`);
  
  try {
    const validationErrors = await validateV1Data();
    if (validationErrors.length > 0) {
      throw new Error(`Data validation failed: ${validationErrors.join(", ")}`);
    }
    console.log(`[Migration] Data validation passed`);
    
    const filesToBackup = [...V1_FILES, "tokens.json.bak"];
    const backedUpFiles = await backupFiles(dataDir, backupDir, filesToBackup);
    await createBackupMeta(backupDir, fromVersion, toVersion, backedUpFiles);
    console.log(`[Migration] Backup created: ${backedUpFiles.length} files`);
    
    const migration = MIGRATIONS.find(m => m.version === toVersion);
    if (!migration) {
      throw new Error(`No migration found for version ${toVersion}`);
    }
    
    const result = await migration.up({ backupDir, options });
    console.log(`[Migration] Migration executed: ${result.migratedFiles.length} files migrated`);
    
    const verifyErrors = await verifyMigration(fromVersion, toVersion, result);
    if (verifyErrors.length > 0 && !options.force) {
      console.error(`[Migration] Verification errors, rolling back...`);
      await migration.down({ backupDir, options });
      throw new Error(`Migration verification failed: ${verifyErrors.join(", ")}`);
    }
    
    meta.currentVersion = toVersion;
    meta.migrations = meta.migrations || [];
    meta.migrations.push({
      version: toVersion,
      description: migration.description,
      executedAt: new Date().toISOString(),
      backupName
    });
    meta.lastMigration = new Date().toISOString();
    await saveMeta(meta);
    
    console.log(`[Migration] Successfully migrated to v${toVersion}`);
    
    return {
      success: true,
      fromVersion,
      toVersion,
      backupDir,
      backupName,
      migratedFiles: result.migratedFiles,
      verificationErrors: verifyErrors
    };
    
  } catch (err) {
    console.error(`[Migration] Migration failed: ${err.message}`);
    
    if (await fileExists(backupDir)) {
      const backupMetaPath = join(backupDir, "backup-meta.json");
      if (await fileExists(backupMetaPath)) {
        try {
          console.log(`[Migration] Attempting automatic rollback...`);
          const migration = MIGRATIONS.find(m => m.version === toVersion);
          if (migration) {
            await migration.down({ backupDir, options });
            console.log(`[Migration] Rollback completed`);
          }
        } catch (rollbackErr) {
          console.error(`[Migration] Rollback failed: ${rollbackErr.message}`);
          console.error(`[Migration] Manual recovery required. Backup: ${backupDir}`);
        }
      }
    }
    
    return {
      success: false,
      fromVersion,
      toVersion,
      backupDir,
      error: err.message,
      stack: err.stack
    };
  }
}

async function runRollback(fromVersion, toVersion, options = {}) {
  const meta = await loadMeta();
  
  if (!meta.migrations || meta.migrations.length === 0) {
    return {
      success: false,
      error: "No migration history found for rollback"
    };
  }
  
  const lastMigration = meta.migrations
    .filter(m => m.version === fromVersion)
    .sort((a, b) => new Date(b.executedAt) - new Date(a.executedAt))[0];
  
  if (!lastMigration) {
    return {
      success: false,
      error: `No migration record found for version ${fromVersion}`
    };
  }
  
  const backupDir = join(backupsDir, lastMigration.backupName);
  
  console.log(`[Migration] Starting rollback from v${fromVersion} to v${toVersion}`);
  console.log(`[Migration] Using backup: ${backupDir}`);
  
  try {
    const migration = MIGRATIONS.find(m => m.version === fromVersion);
    if (!migration) {
      throw new Error(`No migration found for version ${fromVersion}`);
    }
    
    const result = await migration.down({ backupDir, options });
    
    meta.currentVersion = toVersion;
    meta.lastRestore = new Date().toISOString();
    meta.restoredFrom = lastMigration.backupName;
    meta.lastRestoreReason = options.reason || "manual_rollback";
    await saveMeta(meta);
    
    console.log(`[Migration] Successfully rolled back to v${toVersion}`);
    
    return {
      success: true,
      fromVersion,
      toVersion,
      backupDir,
      restoredFiles: result.restoredFiles
    };
    
  } catch (err) {
    console.error(`[Migration] Rollback failed: ${err.message}`);
    
    return {
      success: false,
      fromVersion,
      toVersion,
      backupDir,
      error: err.message,
      stack: err.stack
    };
  }
}

export async function restoreFromBackup(backupName, options = {}) {
  const backupDir = join(backupsDir, backupName);
  const meta = await loadMeta();
  
  if (!(await fileExists(backupDir))) {
    return {
      success: false,
      error: `Backup not found: ${backupName}`
    };
  }
  
  console.log(`[Migration] Restoring from backup: ${backupDir}`);
  
  try {
    const backupMetaPath = join(backupDir, "backup-meta.json");
    const backupMeta = await loadJsonFile(backupMetaPath);
    
    for (const file of backupMeta.files) {
      const backupPath = join(backupDir, file);
      const targetPath = join(dataDir, file);
      
      if (await fileExists(backupPath)) {
        await copyFile(backupPath, targetPath);
      }
    }
    
    const v2Dir = join(dataDir, "v2");
    if (await fileExists(v2Dir)) {
      await rm(v2Dir, { recursive: true, force: true });
    }
    
    meta.currentVersion = backupMeta.fromVersion;
    meta.lastRestore = new Date().toISOString();
    meta.restoredFrom = backupName;
    meta.lastRestoreReason = options.reason || "manual_restore";
    await saveMeta(meta);
    
    return {
      success: true,
      restoredFrom: backupName,
      toVersion: backupMeta.fromVersion,
      files: backupMeta.files
    };
    
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stack: err.stack
    };
  }
}

export async function getMigrationStatus() {
  const meta = await loadMeta();
  const currentVersion = await detectCurrentVersion();
  
  const backupList = [];
  if (existsSync(backupsDir)) {
    const entries = await readdir(backupsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        backupList.push(entry.name);
      }
    }
  }
  
  return {
    currentVersion,
    targetVersion: CURRENT_VERSION,
    needsMigration: currentVersion < CURRENT_VERSION,
    meta,
    availableBackups: backupList.sort().reverse()
  };
}

export function getDataDirForVersion(version) {
  if (version >= 2) {
    return join(dataDir, "v2");
  }
  return dataDir;
}

export function resolveFilePath(filename, version = null) {
  const v = version || detectCurrentVersion();
  const baseDir = getDataDirForVersion(v);
  return join(baseDir, filename);
}

export async function readEntityData(entity, version = null) {
  const fileName = ENTITY_FILES[entity];
  if (!fileName) {
    throw new Error(`Unknown entity: ${entity}`);
  }
  
  const currentVersion = version || await detectCurrentVersion();
  const filePath = resolveFilePath(fileName, currentVersion);
  
  if (!(await fileExists(filePath))) {
    return null;
  }
  
  return await loadJsonFile(filePath);
}

export async function readEntityCollection(entity, version = null) {
  const data = await readEntityData(entity, version);
  if (!data) return [];
  
  const dataKey = getDataKey(entity);
  const collection = data[dataKey] || data[entity] || [];
  
  if (version === null) {
    const currentVersion = await detectCurrentVersion();
    if (currentVersion >= 2) {
      return collection.map(item => ensureCompatibility(item, entity, currentVersion));
    }
  }
  
  return collection;
}

function ensureCompatibility(item, entity, fromVersion) {
  return item;
}

export {
  loadMeta,
  saveMeta,
  detectCurrentVersion,
  validateV1Data,
  getDataKey
};
