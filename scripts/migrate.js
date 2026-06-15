#!/usr/bin/env node

import { basename } from "node:path";
import { runMigrations, restoreFromBackup, getMigrationStatus, CURRENT_VERSION } from "../store/migration.js";
import { clearDataDirCache } from "../store/common.js";

function printHelp() {
  console.log(`
数据迁移脚本 - 特种气体钢瓶流转API

用法:
  node scripts/migrate.js <command> [options]

命令:
  status              显示当前迁移状态
  up [version]        升级到指定版本（默认最新版本）
  down [version]      回滚到指定版本
  restore <backup>    从指定备份恢复
  list-backups        列出可用备份
  force-up            强制升级（忽略验证错误）
  help                显示此帮助信息

选项:
  --reason <text>     回滚/恢复原因说明
  --force             强制执行操作

示例:
  node scripts/migrate.js status
  node scripts/migrate.js up
  node scripts/migrate.js up 2
  node scripts/migrate.js down 1 --reason "回滚测试"
  node scripts/migrate.js restore v1-to-v2-20260615-005459
  node scripts/migrate.js list-backups
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: null,
    version: null,
    backup: null,
    options: {
      reason: null,
      force: false
    }
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--reason" && i + 1 < args.length) {
      result.options.reason = args[++i];
    } else if (arg === "--force") {
      result.options.force = true;
    } else if (!result.command) {
      result.command = arg;
    } else if (result.command === "restore" && !result.backup) {
      result.backup = arg;
    } else if (["up", "down"].includes(result.command) && !result.version) {
      const v = parseInt(arg, 10);
      if (!isNaN(v)) {
        result.version = v;
      }
    }
  }

  return result;
}

async function handleStatus() {
  const status = await getMigrationStatus();
  console.log("\n=== 数据迁移状态 ===");
  console.log(`当前版本: v${status.currentVersion}`);
  console.log(`目标版本: v${status.targetVersion}`);
  console.log(`需要迁移: ${status.needsMigration ? "是" : "否"}`);
  
  if (status.meta.lastMigration) {
    console.log(`最后迁移: ${status.meta.lastMigration}`);
  }
  if (status.meta.lastRestore) {
    console.log(`最后恢复: ${status.meta.lastRestore}`);
    console.log(`恢复来源: ${status.meta.restoredFrom}`);
    console.log(`恢复原因: ${status.meta.lastRestoreReason}`);
  }
  
  console.log("\n迁移历史:");
  if (status.meta.migrations && status.meta.migrations.length > 0) {
    for (const migration of status.meta.migrations) {
      console.log(`  v${migration.version} - ${migration.description}`);
      console.log(`    执行时间: ${migration.executedAt}`);
      console.log(`    备份名称: ${migration.backupName}`);
    }
  } else {
    console.log("  暂无迁移记录");
  }
  
  console.log("\n可用备份:");
  if (status.availableBackups.length > 0) {
    for (const backup of status.availableBackups) {
      console.log(`  - ${backup}`);
    }
  } else {
    console.log("  暂无备份");
  }
  console.log();
}

async function handleUp(version, options) {
  const targetVersion = version || CURRENT_VERSION;
  console.log(`\n=== 开始升级到 v${targetVersion} ===\n`);
  
  const result = await runMigrations(targetVersion, options);
  
  if (result.success) {
    if (result.skipped) {
      console.log(`✓ ${result.message}`);
    } else {
      console.log("✓ 迁移成功完成!");
      console.log(`  从版本: v${result.fromVersion}`);
      console.log(`  到版本: v${result.toVersion}`);
      console.log(`  备份目录: ${result.backupDir}`);
      console.log(`  迁移文件: ${result.migratedFiles.length} 个`);
      
      if (result.verificationErrors && result.verificationErrors.length > 0) {
        console.log("\n⚠ 验证警告:");
        for (const err of result.verificationErrors) {
          console.log(`  - ${err}`);
        }
      }
    }
    clearDataDirCache();
  } else {
    console.log("✗ 迁移失败!");
    console.log(`  错误: ${result.error}`);
    if (result.backupDir) {
      console.log(`  备份目录: ${result.backupDir}`);
      console.log(`  可使用以下命令恢复:`);
      console.log(`    node scripts/migrate.js restore ${result.backupName || basename(result.backupDir)}`);
    }
    process.exitCode = 1;
  }
  console.log();
}

async function handleDown(version, options) {
  const targetVersion = version || 1;
  console.log(`\n=== 开始回滚到 v${targetVersion} ===\n`);
  
  const result = await runMigrations(targetVersion, options);
  
  if (result.success) {
    if (result.skipped) {
      console.log(`✓ ${result.message}`);
    } else {
      console.log("✓ 回滚成功完成!");
      console.log(`  从版本: v${result.fromVersion}`);
      console.log(`  到版本: v${result.toVersion}`);
      console.log(`  使用备份: ${result.backupDir}`);
      console.log(`  恢复文件: ${result.restoredFiles.length} 个`);
    }
    clearDataDirCache();
  } else {
    console.log("✗ 回滚失败!");
    console.log(`  错误: ${result.error}`);
    process.exitCode = 1;
  }
  console.log();
}

async function handleRestore(backupName, options) {
  if (!backupName) {
    console.log("✗ 请指定要恢复的备份名称");
    console.log("用法: node scripts/migrate.js restore <backup-name>");
    process.exitCode = 1;
    return;
  }
  
  console.log(`\n=== 从备份恢复: ${backupName} ===\n`);
  
  const result = await restoreFromBackup(backupName, options);
  
  if (result.success) {
    console.log("✓ 恢复成功完成!");
    console.log(`  恢复来源: ${result.restoredFrom}`);
    console.log(`  当前版本: v${result.toVersion}`);
    console.log(`  恢复文件: ${result.files.length} 个`);
    clearDataDirCache();
  } else {
    console.log("✗ 恢复失败!");
    console.log(`  错误: ${result.error}`);
    process.exitCode = 1;
  }
  console.log();
}

async function handleListBackups() {
  const status = await getMigrationStatus();
  
  console.log("\n=== 可用备份 ===\n");
  
  if (status.availableBackups.length > 0) {
    for (const backup of status.availableBackups) {
      console.log(`  ${backup}`);
    }
    console.log(`\n共 ${status.availableBackups.length} 个备份\n`);
  } else {
    console.log("  暂无备份\n");
  }
}

async function main() {
  const args = parseArgs(process.argv);
  
  try {
    switch (args.command) {
      case "status":
        await handleStatus();
        break;
        
      case "up":
        await handleUp(args.version, args.options);
        break;
        
      case "force-up":
        args.options.force = true;
        await handleUp(args.version || CURRENT_VERSION, args.options);
        break;
        
      case "down":
        await handleDown(args.version, args.options);
        break;
        
      case "restore":
        await handleRestore(args.backup, args.options);
        break;
        
      case "list-backups":
        await handleListBackups();
        break;
        
      case "help":
      case "--help":
      case "-h":
      default:
        printHelp();
        if (args.command && args.command !== "help") {
          console.log(`未知命令: ${args.command}`);
          process.exitCode = 1;
        }
    }
  } catch (err) {
    console.error(`\n✗ 执行出错: ${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  }
}

main();
