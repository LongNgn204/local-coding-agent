// Local Coding Agent Tray — dev launcher.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Starts the Vite dev server for the renderer, waits for its URL to respond,
// then launches Electron pointed at that URL via VITE_DEV_SERVER_URL. Avoids a
// `concurrently` dependency. Ctrl-C tears both down.

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isWin = process.platform === "win32";

const DEV_URL = "http://127.0.0.1:5201";

function log(msg) {
  process.stdout.write(`[dev] ${msg}\n`);
}

function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`timeout waiting for ${url}`));
        else setTimeout(tick, 300);
      });
      req.setTimeout(1500, () => req.destroy());
    };
    tick();
  });
}

const children = [];
function shutdown(code = 0) {
  for (const c of children) {
    try {
      if (isWin && c.pid) spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true });
      else c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  log("starting Vite dev server…");
  const vitePkg = require.resolve("vite/package.json");
  const viteBin = path.join(path.dirname(vitePkg), require(vitePkg).bin.vite);
  const viteProc = spawn(process.execPath, [viteBin], {
    cwd: __dirname,
    stdio: "inherit",
    env: { ...process.env }
  });
  children.push(viteProc);
  viteProc.on("exit", (c) => {
    log(`vite exited (${c})`);
    shutdown(c || 0);
  });

  await waitFor(DEV_URL);
  log(`Vite is up at ${DEV_URL}. Launching Electron…`);

  const electronBin = require("electron");
  const elProc = spawn(electronBin, ["."], {
    cwd: __dirname,
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL }
  });
  children.push(elProc);
  elProc.on("exit", (c) => {
    log(`electron exited (${c})`);
    shutdown(c || 0);
  });
}

main().catch((e) => {
  log(`error: ${e.message}`);
  shutdown(1);
});