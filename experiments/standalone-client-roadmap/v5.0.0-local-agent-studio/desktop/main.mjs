import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, session } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrivilegedRequest } from "./privileged-actions.mjs";
import { DesktopCredentialStore } from "./credential-store.mjs";
import { resolveNodeRuntime } from "./runtime-resolver.mjs";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(APP_DIR);
const manifest = JSON.parse(await readFile(join(ROOT_DIR, "version-manifest.json"), "utf8"));
const host = "127.0.0.1";
const port = Number(process.env.LCA_STUDIO_PORT || manifest.defaultPort || 5182);
const baseUrl = `http://${host}:${port}`;
let serverProcess = null;
let mainWindow = null;
let studioToken = "";
let nodeRuntimeInfo = null;
let credentialStore = null;
const desktopBridgeToken = randomBytes(32).toString("base64url");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  try {
    hardenSession();
    credentialStore = new DesktopCredentialStore({
      file: join(app.getPath("userData"), "credentials.v1.json"),
      safeStorage
    });
    installIpcHandlers();
    nodeRuntimeInfo = await verifyNodeRuntime();
    serverProcess = startServer(nodeRuntimeInfo.path);
    await waitForHealth();
    studioToken = await readStudioToken();
    await syncDesktopCredentials().catch((error) => {
      console.error(`[credentials] ${error instanceof Error ? error.message : String(error)}`);
    });
    mainWindow = createWindow();
    await mainWindow.loadURL(baseUrl);
  } catch (error) {
    dialog.showErrorBox("Local Agent Studio failed to start", error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  stopServer();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: `${manifest.productName} ${manifest.version}`,
    backgroundColor: "#080a0d",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(APP_DIR, "preload.mjs"),
      devTools: manifest.releaseStage !== "stable"
    }
  });

  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedLocalUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedLocalUrl(url)) event.preventDefault();
  });
  return win;
}

function hardenSession() {
  const current = session.defaultSession;
  current.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  current.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "X-Local-Agent-Studio": ["desktop"]
      }
    });
  });
}

function installIpcHandlers() {
  ipcMain.handle("lca:privileged", async (event, request) => {
    if (!isTrustedLocalUrl(event.senderFrame?.url || "")) {
      return { ok: false, status: 403, error: "Untrusted renderer origin." };
    }
    if (!studioToken) return { ok: false, status: 503, error: "Studio token is not ready." };
    try {
      if (request?.action === "providerKey:set" || request?.action === "providerKey:delete") {
        return await handleDesktopCredentialAction(request);
      }
      const spec = buildPrivilegedRequest(request);
      const response = await fetch(`${baseUrl}${spec.path}`, {
        method: spec.method,
        headers: {
          "content-type": "application/json",
          "x-lca-studio-token": studioToken
        },
        body: JSON.stringify(spec.body || {})
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      return {
        ok: response.ok,
        status: response.status,
        data,
        error: response.ok ? "" : data.error || response.statusText
      };
    } catch (error) {
      return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function startServer(node) {
  const child = spawn(node, ["server.mjs"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      LCA_STUDIO_HOST: host,
      LCA_STUDIO_PORT: String(port),
      LCA_DESKTOP: "1",
      LCA_NODE_RUNTIME_SOURCE: nodeRuntimeInfo?.source || "unknown",
      LCA_NODE_RUNTIME_VERSION: nodeRuntimeInfo?.version || "",
      LCA_DESKTOP_BRIDGE_TOKEN: desktopBridgeToken
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[studio] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[studio] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("studio-server-exit", { code, signal });
    }
  });
  return child;
}

async function handleDesktopCredentialAction(request) {
  if (!credentialStore?.available()) {
    return { ok: false, status: 503, error: "Operating-system credential encryption is unavailable." };
  }
  const provider = String(request.payload?.provider || "");
  if (request.action === "providerKey:set") {
    const metadata = await credentialStore.set(provider, request.payload?.value);
    const data = await syncDesktopSecret(provider, request.payload?.value, request.payload?.label);
    await deleteLegacyVault(provider).catch(() => {});
    return { ok: true, status: 200, data: { ...data, ...metadata } };
  }
  await credentialStore.delete(provider);
  await deleteDesktopSecret(provider);
  await deleteLegacyVault(provider).catch(() => {});
  return { ok: true, status: 200, data: { ok: true, provider } };
}

async function syncDesktopCredentials() {
  if (!credentialStore?.available()) return;
  const credentials = await credentialStore.all();
  for (const [provider, value] of Object.entries(credentials)) {
    await syncDesktopSecret(provider, value, `${provider} OS credential`);
  }
}

async function syncDesktopSecret(provider, value, label = "") {
  return desktopSecretRequest(provider, "POST", {
    value,
    label,
    intent: { action: "provider-key:set", confirm: "provider-key:set" }
  });
}

async function deleteDesktopSecret(provider) {
  return desktopSecretRequest(provider, "DELETE", {
    intent: { action: "provider-key:delete", confirm: "provider-key:delete" }
  });
}

async function desktopSecretRequest(provider, method, body) {
  if (!/^(openai|anthropic)$/.test(provider)) throw new Error("Unsupported credential provider.");
  const response = await fetch(`${baseUrl}/api/desktop-secrets/${encodeURIComponent(provider)}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-lca-studio-token": studioToken,
      "x-lca-desktop-token": desktopBridgeToken
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Desktop secret sync failed (${response.status})`);
  return data;
}

async function deleteLegacyVault(provider) {
  const response = await fetch(`${baseUrl}/api/secrets/${encodeURIComponent(provider)}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-lca-studio-token": studioToken
    },
    body: JSON.stringify({ intent: { action: "provider-key:delete", confirm: "provider-key:delete" } })
  });
  if (!response.ok) throw new Error(`Legacy vault cleanup failed (${response.status})`);
}

async function verifyNodeRuntime() {
  return resolveNodeRuntime({
    env: process.env,
    manifest,
    rootDir: ROOT_DIR,
    resourcesPath: process.resourcesPath,
    nodeVersion
  });
}

function nodeVersion(node) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => reject(new Error(`Unable to run Node.js runtime "${node}": ${error.message}`)));
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Unable to verify Node.js runtime "${node}": ${output.trim()}`));
      else resolve(output.trim().replace(/^v/, ""));
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`Health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error("Local Agent Studio server did not start.");
}

async function readStudioToken() {
  const response = await fetch(`${baseUrl}/`);
  if (!response.ok) throw new Error(`Unable to read Studio session token: ${response.status}`);
  const html = await response.text();
  const token =
    html.match(/<meta name="lca-studio-token" content="([A-Za-z0-9_-]+)" \/>/)?.[1] ||
    html.match(/const STUDIO_TOKEN="([A-Za-z0-9_-]+)"/)?.[1];
  if (!token) throw new Error("Studio session token was not found in same-origin HTML.");
  return token;
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  const pid = serverProcess.pid;
  serverProcess = null;
  if (process.platform === "win32" && pid) {
    spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

function isTrustedLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === host && Number(url.port || 80) === port;
  } catch {
    return false;
  }
}
