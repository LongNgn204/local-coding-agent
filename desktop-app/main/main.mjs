// Local Codex Studio — thin Electron entry.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Creates a hardened BrowserWindow and wires ipcMain to a single StudioBackend
// instance. All real work lives in backend.mjs (testable without Electron).

import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { StudioBackend } from "./backend.mjs";
import { ConfigStore } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Optional file-based debug log (set STUDIO_DEBUG_LOG=<path>) — GUI Electron
// on Windows does not reliably flush console to a redirected stdout.
const DBG = process.env.STUDIO_DEBUG_LOG || "";
function dbg(msg) {
  if (!DBG) return;
  try {
    appendFileSync(DBG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}
const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5199";

let win = null;
let backend = null;
let config = null;
const serverLog = [];

function pushLog(line) {
  if (!line) return;
  serverLog.push(line);
  if (serverLog.length > 500) serverLog.splice(0, serverLog.length - 500);
  if (win && !win.isDestroyed()) win.webContents.send("studio:serverLog", line);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0d1117",
    title: "Local Codex Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  // Block any attempt to open new windows / navigate away from local content.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  win.webContents.on("did-finish-load", () => dbg("renderer did-finish-load"));
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    dbg(`renderer did-fail-load code=${code} desc=${desc} url=${url}`)
  );
  win.webContents.on("console-message", (_e, level, message) =>
    dbg(`renderer console[${level}]: ${message}`)
  );
  win.webContents.on("preload-error", (_e, preloadPath, error) =>
    dbg(`preload-error ${preloadPath}: ${error?.message || error}`)
  );

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    const indexFile = path.join(__dirname, "..", "ui", "dist", "index.html");
    dbg(`loading file ${indexFile}`);
    win.loadFile(indexFile);
  }
}

function registerIpc() {
  ipcMain.handle("studio:getConfig", () => config.get());

  ipcMain.handle("studio:setConfig", (_e, cfg) => config.set(cfg || {}));

  ipcMain.handle("studio:getPermissionProfiles", () => ({ file: config.permissionFile, store: config.getPermissionStore() }));

  ipcMain.handle("studio:setPermissionProfiles", (_e, store) => config.setPermissionStore(store));

  ipcMain.handle("studio:pickPermissionRoot", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Add authorized path",
      properties: ["openDirectory", "createDirectory"]
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  ipcMain.handle("studio:pickWorkspace", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Pick workspace folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (res.canceled || !res.filePaths.length) return null;
    const picked = res.filePaths[0];
    config.set({ workspace: picked });
    const store = config.getPermissionStore();
    const active = store.active_profile || "default";
    const profile = store.profiles[active] || {
      version: 1,
      name: active,
      description: "Private Local Codex Studio profile",
      roots: []
    };
    profile.working_directory = picked;
    const roots = Array.isArray(profile.roots) ? profile.roots : [];
    if (roots.length) roots[0] = { ...roots[0], label: roots[0].label || "Primary workspace", path: picked };
    else roots.push({ label: "Primary workspace", path: picked, preset: "develop" });
    profile.roots = roots;
    store.profiles[active] = profile;
    store.active_profile = active;
    config.setPermissionStore(store);
    return picked;
  });

  ipcMain.handle("studio:start", async (_e, opts = {}) => {
    const cfg = config.get();
    const workspace = opts.workspace || cfg.workspace || undefined;
    const mode = opts.mode || cfg.mode || "safe";
    if (workspace) config.set({ workspace });
    if (mode) config.set({ mode });
    const permission = config.setPermissionStore(config.getPermissionStore());
    const permissionProfileName = opts.permissionProfileName || permission.store.active_profile;

    if (backend && backend.running) {
      // Already running: if mode/workspace changed, restart to apply.
      const h = await backend.health();
      const sameWs = !workspace || h.workspace === path.resolve(workspace);
      const sameMode = h.mode === mode;
      const sameProfile = h.permission_profile === permissionProfileName;
      if (!opts.forceRestart && sameWs && sameMode && sameProfile) return h;
      await backend.stop();
      backend = null;
    }
    if (!backend) {
      backend = new StudioBackend({
        workspace,
        mode,
        dataDir: path.join(app.getPath("userData"), "server-data"),
        permissionProfileFile: permission.file,
        permissionProfileName,
        onLog: pushLog
      });
    }
    console.log(`[studio] starting server: workspace=${workspace || "(none)"} mode=${mode}`);
    dbg(`start invoked workspace=${workspace || "(none)"} mode=${mode}`);
    try {
      const h = await backend.start({ workspace, mode, permissionProfileFile: permission.file, permissionProfileName });
      console.log(`[studio] server ${h.ok ? "up" : "not-ok"} port=${h.port} pid=${h.pid} preview=${h.preview_version}`);
      dbg(`start result ok=${h.ok} port=${h.port} pid=${h.pid} preview=${h.preview_version} reason=${h.reason || ""}`);
      return h;
    } catch (e) {
      console.error(`[studio] server start failed: ${e?.message || e}`);
      dbg(`start FAILED: ${e?.stack || e?.message || e}`);
      throw e;
    }
  });

  ipcMain.handle("studio:stop", async () => {
    if (backend) {
      await backend.stop();
    }
    return { ok: true };
  });

  ipcMain.handle("studio:health", async () => {
    if (!backend) return { ok: false, reason: "not_started" };
    return backend.health();
  });

  ipcMain.handle("studio:createTask", async (_e, args) => {
    ensureBackend();
    return backend.createTask(args || {});
  });

  ipcMain.handle("studio:listTasks", async (_e, args) => {
    if (!backend || !backend.running) return { count: 0, tasks: [] };
    return backend.listTasks(args || {});
  });

  ipcMain.handle("studio:getTask", async (_e, id) => {
    ensureBackend();
    return backend.getTask(id);
  });

  ipcMain.handle("studio:getArtifact", async (_e, id, source, offset, limit) => {
    ensureBackend();
    return backend.getArtifact(id, source, offset, limit);
  });

  ipcMain.handle("studio:cancelTask", async (_e, id) => {
    ensureBackend();
    return backend.cancelTask(id);
  });

  ipcMain.handle("studio:openDashboard", async () => {
    const url = backend?.dashboardUrl();
    if (url) await shell.openExternal(url);
    return url || null;
  });

  ipcMain.handle("studio:getServerLog", () => serverLog.slice(-200));
}

function ensureBackend() {
  if (!backend || !backend.running) {
    throw new Error("Server is not running. Click Start first.");
  }
}

app.whenReady().then(() => {
  config = new ConfigStore(path.join(app.getPath("userData"), "local-codex-studio"));
  dbg(`app ready userData=${app.getPath("userData")} cfg=${JSON.stringify(config.get())}`);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
async function shutdown() {
  if (quitting) return;
  quitting = true;
  try {
    if (backend) await backend.stop();
  } catch {
    /* ignore */
  }
}

app.on("before-quit", async (event) => {
  if (!quitting && backend && backend.running) {
    event.preventDefault();
    await shutdown();
    app.quit();
  }
});

app.on("window-all-closed", async () => {
  await shutdown();
  if (process.platform !== "darwin") app.quit();
});
