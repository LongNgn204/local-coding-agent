// Local Coding Agent Tray — Electron entry.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Creates a hardened BrowserWindow, a system tray / menu bar icon, and wires
// ipcMain to a Supervisor instance. All real work lives in supervisor.mjs and
// config.mjs (testable without Electron).

import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, safeStorage, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync } from "node:fs";
import { ConfigStore } from "./config.mjs";
import { Supervisor } from "./supervisor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5201";
const TRAY_ICON = path.join(__dirname, "..", "assets", "tray.png");

let win = null;
let tray = null;
let config = null;
let supervisor = null;
let quitting = false;
let trayClickBound = null;
let lastTrayStatus = "Server: OFFLINE    Tunnel: STOPPED";

const logRing = [];
function pushLog(line) {
  if (!line) return;
  const stamp = `[${new Date().toISOString()}] ${line}`;
  logRing.push(stamp);
  if (logRing.length > 1000) logRing.splice(0, logRing.length - 1000);
  try {
    appendFileSync(config.logFile, `${stamp}\n`);
  } catch {
    /* ignore */
  }
  if (win && !win.isDestroyed()) win.webContents.send("lcat:log", line);
}

function secretsCodec() {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
      decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, "base64"))
    };
  }
  // Fallback (Linux without a keyring): keep secrets out of config, but note
  // the storage is weaker than the platform store.
  return {
    encrypt: (plain) => Buffer.from(plain, "utf8").toString("base64"),
    decrypt: (b64) => Buffer.from(b64, "base64").toString("utf8")
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 860,
    minWidth: 760,
    minHeight: 640,
    backgroundColor: "#0f1419",
    title: "Local Coding Agent Tray v5.0.1",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "ui", "dist", "index.html"));
  }

  win.on("close", (event) => {
    // Closing the window hides to tray; the agent keeps running.
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function trayIcon() {
  try {
    if (existsSync(TRAY_ICON)) return nativeImage.createFromPath(TRAY_ICON);
  } catch {
    /* fall through */
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><rect width="22" height="22" rx="5" fill="#2f81f7"/><circle cx="11" cy="11" r="5" fill="#0f1419"/></svg>`
  );
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${svg.toString("base64")}`);
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  const status = supervisor ? supervisor.snapshot() : null;
  const serverLine = status
    ? `Server: ${status.server.state.toUpperCase()}${status.server.version ? ` v${status.server.version}` : ""}`
    : "Server: OFFLINE";
  const tunnelLine = status ? `Tunnel: ${status.tunnel.state.toUpperCase()}` : "Tunnel: STOPPED";
  lastTrayStatus = `${serverLine}    ${tunnelLine}`;
  tray.setToolTip(`Local Coding Agent Tray v5.0.1 — ${lastTrayStatus}`);

  const serverState = status?.server.state || "offline";
  const tunnelState = status?.tunnel.state || "stopped";
  const canStop = supervisor ? supervisor.serverChild?.exitCode === null || supervisor.tunnelChild?.exitCode === null : false;

  const template = [
    { label: `Server: ${serverLine}`, enabled: false },
    { label: `Tunnel: ${tunnelState.toUpperCase()}`, enabled: false },
    { type: "separator" },
    {
      label: "Start",
      click: () => {
        ipcCall("lcat:start", { tunnel: true }).catch((e) => pushLog(`[tray] start failed: ${e.message}`));
      }
    },
    { label: "Stop", enabled: canStop, click: () => ipcCall("lcat:stop").catch((e) => pushLog(`[tray] stop failed: ${e.message}`)) },
    { label: "Reconnect Tunnel", click: () => ipcCall("lcat:reconnectTunnel").catch((e) => pushLog(`[tray] reconnect failed: ${e.message}`)) },
    { type: "separator" },
    { label: "Open Dashboard", click: () => ipcCall("lcat:openDashboard") },
    { label: "Open Settings", click: showWindow },
    { label: "Open Logs", click: () => ipcCall("lcat:openLogModal") },
    { type: "separator" },
    { label: "Quit", click: () => quitApp() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  if (process.platform === "darwin") {
    if (!trayClickBound) {
      trayClickBound = () => showWindow();
      tray.on("click", trayClickBound);
    }
  }
}

function quitApp() {
  quitting = true;
  (async () => {
    try {
      if (supervisor) await supervisor.dispose();
    } catch {
      /* ignore */
    }
    app.quit();
  })();
}

function sendStatus() {
  if (win && !win.isDestroyed()) win.webContents.send("lcat:status", supervisor.snapshot());
}

// Invoke a handler by name from tray code (tray has no event sender).
async function ipcCall(channel, ...args) {
  const handler = ipcHandlers[channel];
  if (!handler) return null;
  return handler(null, ...args);
}

const ipcHandlers = {
  "lcat:getConfig": () => ({
    config: config.get(),
    secrets: config.secretSummary(),
    meta: config.meta()
  }),

  "lcat:setConfig": (_e, patch) => config.set(patch || {}),

  "lcat:saveSecret": (_e, name, value) => {
    config.saveSecret(name, value);
    return { ok: true };
  },

  "lcat:clearSecret": (_e, name) => {
    config.saveSecret(name, "");
    return { ok: true };
  },

  "lcat:pickDir": async (_e, title) => {
    const res = await dialog.showOpenDialog(win, {
      title: title || "Pick folder",
      properties: ["openDirectory", "createDirectory"]
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  },

  "lcat:pickFile": async (_e, title) => {
    const res = await dialog.showOpenDialog(win, {
      title: title || "Pick file",
      properties: ["openFile"]
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  },

  "lcat:start": async (_e, opts) => {
    try {
      await supervisor.start({ tunnel: Boolean(opts?.tunnel) });
      return { ok: true, message: "Server started." };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  },

  "lcat:stop": async () => {
    try {
      await supervisor.stop();
      return { ok: true, message: "Stopped." };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  },

  "lcat:reconnectTunnel": async () => {
    try {
      await supervisor.reconnectTunnel();
      return { ok: true, message: "Tunnel reconnected." };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  },

  "lcat:getStatus": () => supervisor.snapshot(),

  "lcat:openDashboard": async () => {
    const url = supervisor.snapshot().dashboardUrl;
    await shell.openExternal(url);
    return url;
  },

  "lcat:copyMcpUrl": () => {
    const url = supervisor.snapshot().mcpUrl;
    clipboard.writeText(url);
    return url;
  },

  "lcat:copyTunnelId": () => {
    const id = String(config.get().tunnelId || "");
    clipboard.writeText(id);
    return id;
  },

  "lcat:getLogs": () => ({
    lines: logRing.slice(-500),
    configDir: config.meta().configDir,
    logFile: config.meta().logFile
  }),

  "lcat:copyLogs": () => {
    clipboard.writeText(logRing.join("\n"));
  },

  "lcat:openLogFolder": async () => {
    await shell.openPath(config.meta().configDir);
  },

  "lcat:openConfigFolder": async () => {
    await shell.openPath(config.meta().configDir);
  },

  "lcat:openLogModal": () => {
    showWindow();
    win.webContents.send("lcat:openModal", "logs");
  },

  "lcat:getProfiles": () => ({ file: config.permissionFile, store: config.getPermissionStore() }),

  "lcat:saveProfiles": (_e, store) => config.setPermissionStore(store || {})
};

function registerIpc() {
  for (const [channel, handler] of Object.entries(ipcHandlers)) {
    ipcMain.handle(channel, handler);
  }
}

app.whenReady().then(() => {
  app.setName("Local Coding Agent");
  config = new ConfigStore({ encrypt: secretsCodec().encrypt, decrypt: secretsCodec().decrypt });
  pushLog("[app] ready");
  supervisor = new Supervisor({
    config,
    secrets: { getSecret: (name) => config.getSecret(name) },
    onLog: pushLog,
    onStatus: (snapshot) => {
      sendStatus();
      updateTray();
    }
  });
  supervisor.startPolling();

  registerIpc();
  createWindow();
  tray = new Tray(trayIcon());
  updateTray();

  if (process.platform === "darwin") {
    app.dock.setIcon(trayIcon());
  }

  app.on("activate", () => showWindow());
});

app.on("window-all-closed", (event) => {
  // Tray app: keep running; the window is hidden, not destroyed, so this
  // only fires if the window was actually closed (blocked by the close
  // handler), but stay safe on macOS where apps keep running anyway.
  if (process.platform === "darwin") return;
});

app.on("before-quit", (event) => {
  if (!quitting) {
    event.preventDefault();
    quitApp();
  }
});
