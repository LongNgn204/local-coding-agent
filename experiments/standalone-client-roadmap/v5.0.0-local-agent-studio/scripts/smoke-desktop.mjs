#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const args = parseArgs(process.argv.slice(2));
const artifact = args.artifact ? resolve(ROOT, args.artifact) : "";
if (artifact && !existsSync(artifact)) throw new Error(`Packaged desktop artifact not found: ${artifact}`);

const command = artifact || require("electron");
const commandArgs = artifact ? [] : [ROOT];
const [port, mcpPort, dashboardPort] = await freePorts(3);
const tempDir = await mkdtemp(join(tmpdir(), "lca-desktop-smoke-"));
const resultFile = join(tempDir, "result.json");
const env = {
  ...process.env,
  LCA_DESKTOP_SMOKE_RESULT: resultFile,
  LCA_STUDIO_PORT: String(port),
  LCA_DESKTOP_SMOKE_MCP_PORT: String(mcpPort),
  LCA_DESKTOP_SMOKE_DASHBOARD_PORT: String(dashboardPort),
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: ""
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(command, commandArgs, {
  cwd: ROOT,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
let launchError = null;
child.stdout?.on("data", (chunk) => { output = appendBounded(output, chunk); });
child.stderr?.on("data", (chunk) => { output = appendBounded(output, chunk); });
const exit = new Promise((resolveExit) => {
  child.once("error", (error) => {
    launchError = error;
    resolveExit({ error });
  });
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});

try {
  const result = await waitForResult(resultFile, child, () => output, () => launchError);
  const packageSurface = artifact ? verifyPackageSurface(artifact) : null;
  if (!result.ok) throw new Error(`Desktop smoke failed: ${result.error || "unknown error"}`);
  if (!result.health?.ok) throw new Error("Desktop health endpoint did not report ok.");
  if (result.health.node_runtime?.source !== "electron-embedded") {
    throw new Error(`Unexpected runtime source: ${result.health.node_runtime?.source || "missing"}`);
  }
  if (!result.managedServer?.started || !result.managedServer?.managed || result.managedServer?.health !== "ok") {
    throw new Error("Desktop could not start and verify the managed MCP server with its embedded runtime.");
  }
  if (artifact && (!result.packaged || !result.asar)) {
    throw new Error("Packaged smoke did not run from an ASAR application.");
  }
  const outcome = await Promise.race([exit, delay(10_000).then(() => ({ timeout: true }))]);
  if (outcome.timeout) throw new Error("Desktop did not exit cleanly after smoke verification.");
  if (outcome.error) throw outcome.error;
  if (outcome.code !== 0) throw new Error(`Desktop exited with code ${outcome.code} (${outcome.signal || "no signal"}).`);
  console.log(JSON.stringify({
    ok: true,
    artifact: artifact || "development-electron",
    packaged: result.packaged,
    asar: result.asar,
    runtime: result.health.node_runtime,
    managedServer: result.managedServer,
    packageSurface,
    version: result.health.version
  }, null, 2));
} catch (error) {
  if (child.exitCode == null) child.kill();
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function verifyPackageSurface(executable) {
  const archive = join(dirname(executable), "resources", "app.asar");
  if (!existsSync(archive)) throw new Error(`ASAR archive not found: ${archive}`);
  const { listPackage } = require("@electron/asar");
  const entries = listPackage(archive);
  const forbidden = entries.filter((entry) =>
    /^\\(scripts|runtimes)(\\|$)/i.test(entry) || /^\\server\.mjs$/i.test(entry)
  );
  if (forbidden.length) throw new Error(`Development files leaked into ASAR: ${forbidden.join(", ")}`);
  for (const required of [
    "\\desktop\\main.mjs",
    "\\standalone-app.mjs",
    "\\core\\thread-store.mjs",
    "\\dist\\ui\\index.html"
  ]) {
    if (!entries.includes(required)) throw new Error(`Required packaged file is missing: ${required}`);
  }
  return { asar: archive, entries: entries.length, forbiddenEntries: 0 };
}

async function waitForResult(file, child, getOutput, getLaunchError) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
    if (getLaunchError()) throw getLaunchError();
    if (child.exitCode != null) throw new Error(`Desktop exited before writing smoke result (${child.exitCode}).\n${getOutput()}`);
    await delay(100);
  }
  throw new Error("Timed out waiting for desktop smoke result.");
}

async function freePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });
      servers.push(server);
    }
    return servers.map((server) => {
      const address = server.address();
      return typeof address === "object" && address ? address.port : 0;
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(() => resolveClose()))));
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) continue;
    parsed[values[index].slice(2)] = values[index + 1];
    index += 1;
  }
  return parsed;
}

function appendBounded(current, chunk, limit = 200_000) {
  return (current + String(chunk)).slice(-limit);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
