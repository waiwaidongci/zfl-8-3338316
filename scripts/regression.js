#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const dataDir = join(projectRoot, "data");
const scriptsDir = join(projectRoot, "scripts");
const serverScript = join(projectRoot, "server.js");

const TEST_PORT = Number(process.env.TEST_PORT || 3099);

const TEST_SUITES = [
  { key: "permission-matrix", name: "权限矩阵", script: "test-permission-matrix.js", needsServer: true },
  { key: "idempotency-query", name: "幂等查询", script: "test-idempotency-query.js", needsServer: true },
  { key: "order-return", name: "订单归还", script: "test-order-return.js", needsServer: true },
  { key: "inspection-postpone", name: "检验延期", script: "test-inspection-postpone.js", needsServer: true },
  { key: "inventory-check-filters", name: "盘点筛选", script: "test-inventory-check-filters.js", needsServer: true },
  { key: "inventory-check-surplus", name: "盘盈", script: "test-inventory-check-surplus.js", needsServer: true },
  { key: "compliance-report-phases", name: "合规报表阶段", script: "test-compliance-report-phases.js", needsServer: true },
  { key: "migration-v3", name: "迁移相关", script: "test-migration-v3.js", needsServer: false },
];

let tempDataRoot = null;
let serverProcess = null;
let passedSuites = 0;
let failedSuites = 0;
const results = [];

async function backupDataDir() {
  console.log("[准备] 备份数据目录...");
  tempDataRoot = await mkdtemp(join(tmpdir(), "zfl-regression-data-"));
  const backupDir = join(tempDataRoot, "data-backup");
  await cp(dataDir, backupDir, { recursive: true, force: true });
  console.log(`[准备] 数据已备份至: ${tempDataRoot}`);
  return backupDir;
}

async function restoreDataDir() {
  if (!tempDataRoot) return;
  console.log("[清理] 恢复原始数据目录...");
  try {
    const backupDir = join(tempDataRoot, "data-backup");
    await rm(dataDir, { recursive: true, force: true });
    await cp(backupDir, dataDir, { recursive: true, force: true });
    await rm(tempDataRoot, { recursive: true, force: true });
    console.log("[清理] 原始数据已恢复");
  } catch (err) {
    console.error("[清理] 恢复数据目录失败:", err.message);
  }
}

function waitForPort(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = 200;

    function check() {
      const socket = createConnection({ port }, () => {
        socket.destroy();
        resolve(true);
      });

      socket.on("error", () => {
        if (Date.now() - startTime >= timeoutMs) {
          reject(new Error(`端口 ${port} 在 ${timeoutMs}ms 内未就绪`));
        } else {
          setTimeout(check, interval);
        }
      });
    }

    check();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    console.log(`[服务] 启动测试服务器 (端口 ${TEST_PORT})...`);

    serverProcess = spawn("node", [serverScript], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        NODE_ENV: "test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let serverReady = false;
    let startupOutput = "";

    serverProcess.stdout.on("data", (data) => {
      const text = data.toString();
      startupOutput += text;
      if (text.includes("Gas cylinder flow API listening") && !serverReady) {
        serverReady = true;
      }
    });

    serverProcess.stderr.on("data", (data) => {
      startupOutput += data.toString();
    });

    serverProcess.on("error", (err) => {
      if (!serverReady) {
        reject(new Error(`服务器启动失败: ${err.message}`));
      }
    });

    serverProcess.on("exit", (code) => {
      if (!serverReady) {
        reject(new Error(`服务器意外退出 (code=${code})\n${startupOutput}`));
      }
    });

    waitForPort(TEST_PORT, 15000)
      .then(() => {
        console.log("[服务] 服务器已就绪");
        resolve(serverProcess);
      })
      .catch((err) => {
        console.error("[服务] 服务器启动输出:\n", startupOutput);
        reject(err);
      });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve();
      return;
    }

    console.log("[服务] 关闭测试服务器...");

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        console.warn("[服务] 服务器未正常退出，强制终止");
        serverProcess.kill("SIGKILL");
      }
    }, 5000);

    serverProcess.on("exit", () => {
      resolved = true;
      clearTimeout(timeout);
      console.log("[服务] 服务器已关闭");
      serverProcess = null;
      resolve();
    });

    serverProcess.kill("SIGTERM");
  });
}

function runTestScript(scriptName) {
  return new Promise((resolve) => {
    const scriptPath = join(scriptsDir, scriptName);

    const child = spawn("node", [scriptPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        NODE_ENV: "test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";

    child.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on("exit", (code) => {
      resolve({
        exitCode: code,
        success: code === 0,
        output,
      });
    });
  });
}

function printHeader(title) {
  const line = "=".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function printSummary() {
  printHeader("回归测试总结");

  console.log("");
  for (const result of results) {
    const status = result.success ? "✅ 通过" : "❌ 失败";
    console.log(`  ${status}  ${result.name} (${result.key})`);
  }

  console.log(`\n  总计: ${results.length} 个测试套件`);
  console.log(`  通过: ${passedSuites}`);
  console.log(`  失败: ${failedSuites}`);

  const total = passedSuites + failedSuites;
  const rate = total > 0 ? ((passedSuites / total) * 100).toFixed(1) : "0";
  console.log(`  通过率: ${rate}%`);

  console.log("\n" + "=".repeat(60));
}

function listTestSuites() {
  console.log("可用测试套件:\n");
  console.log("  key                        名称            需要服务  脚本");
  console.log("  " + "-".repeat(70));
  for (const t of TEST_SUITES) {
    const needsServer = t.needsServer ? "是" : "否";
    console.log(`  ${t.key.padEnd(26)} ${t.name.padEnd(14)} ${needsServer.padEnd(8)} ${t.script}`);
  }
  console.log("");
}

async function main() {
  const onlyKey = process.argv[2];

  if (onlyKey === "--list" || onlyKey === "-l") {
    listTestSuites();
    process.exit(0);
  }

  printHeader("特种气体钢瓶流转API - 本地回归测试");
  console.log(`  测试端口: ${TEST_PORT}`);
  console.log(`  测试套件数: ${TEST_SUITES.length}`);
  console.log("=".repeat(60));

  let suitesToRun = TEST_SUITES;

  if (onlyKey && onlyKey !== "--all") {
    suitesToRun = TEST_SUITES.filter((t) => t.key === onlyKey || t.script === onlyKey);
    if (suitesToRun.length === 0) {
      console.error(`\n❌ 未找到匹配的测试套件: ${onlyKey}`);
      console.log("");
      listTestSuites();
      process.exit(1);
    }
    console.log(`\n  只运行: ${suitesToRun.map((t) => t.name).join(", ")}`);
  }

  let dataBackedUp = false;

  try {
    await backupDataDir();
    dataBackedUp = true;

    const needsServer = suitesToRun.some((t) => t.needsServer);
    if (needsServer) {
      await startServer();
    }

    for (const suite of suitesToRun) {
      console.log(`\n`);
      printHeader(`运行测试: ${suite.name}`);

      const result = await runTestScript(suite.script);

      results.push({
        key: suite.key,
        name: suite.name,
        script: suite.script,
        success: result.success,
        exitCode: result.exitCode,
      });

      if (result.success) {
        passedSuites++;
        console.log(`\n✅ ${suite.name} - 通过`);
      } else {
        failedSuites++;
        console.log(`\n❌ ${suite.name} - 失败 (exit code: ${result.exitCode})`);
      }
    }
  } catch (err) {
    console.error("\n[致命错误] 回归测试执行失败:", err.message);
    console.error(err.stack);
    failedSuites++;
  } finally {
    try {
      await stopServer();
    } catch (err) {
      console.error("[清理] 关闭服务器失败:", err.message);
    }

    if (dataBackedUp) {
      await restoreDataDir();
    }

    printSummary();
  }

  const exitCode = failedSuites > 0 ? 1 : 0;
  process.exit(exitCode);
}

process.on("SIGINT", async () => {
  console.log("\n\n[中断] 收到 SIGINT，正在清理...");
  try {
    await stopServer();
    if (tempDataRoot) {
      await restoreDataDir();
    }
  } catch (err) {
    console.error("[中断清理] 错误:", err.message);
  }
  process.exit(1);
});

main();
