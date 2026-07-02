import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, session } from "electron";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStudio } from "../standalone-app.mjs";
import { buildPrivilegedRequest } from "./privileged-actions.mjs";
import { DesktopCredentialStore } from "./credential-store.mjs";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(APP_DIR);
const manifest = JSON.parse(await readFile(join(ROOT_DIR, "version-manifest.json"), "utf8"));
const host = "127.0.0.1";
const port = Number(process.env.LCA_STUDIO_PORT || manifest.defaultPort || 5182);
const baseUrl = `http://${host}:${port}`;
let studioInstance = null;
let mainWindow = null;
let studioToken = "";
let credentialStore = null;
let shutdownPromise = null;
let quitAfterShutdown = false;
const desktopBridgeToken = randomBytes(32).toString("base64url");
const smokeResultFile = process.env.LCA_DESKTOP_SMOKE_RESULT || "";

const gotLock = Boolean(smokeResultFile) || app.requestSingleInstanceLock();
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
    studioInstance = startStudio(manifest, {
      host,
      port,
      desktopBridgeToken,
      nodeRuntime: {
        executable: process.execPath,
        source: "electron-embedded",
        version: process.versions.node
      }
    });
    await studioInstance.ready;
    await waitForHealth();
    studioToken = studioInstance.state.security.token;
    await syncDesktopCredentials().catch((error) => {
      console.error(`[credentials] ${error instanceof Error ? error.message : String(error)}`);
    });
    if (smokeResultFile) {
      const managedServer = await runManagedServerSmoke();
      await writeSmokeResult({ ok: true, packaged: app.isPackaged, asar: ROOT_DIR.includes("app.asar"), managedServer });
      app.quit();
      return;
    }
    mainWindow = createWindow();
    await mainWindow.loadURL(baseUrl);
  } catch (error) {
    if (smokeResultFile) {
      await writeSmokeResult({ ok: false, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
      app.quit();
      return;
    }
    dialog.showErrorBox("Local Agent Studio failed to start", error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (quitAfterShutdown || !studioInstance) return;
  event.preventDefault();
  quitAfterShutdown = true;
  void stopStudio().finally(() => app.quit());
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
      if (request?.action === "license:activate" || request?.action === "license:delete") {
        return await handleDesktopLicenseAction(request);
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
    if (provider === "license") await syncDesktopLicense(value);
    else await syncDesktopSecret(provider, value, `${provider} OS credential`);
  }
}

async function handleDesktopLicenseAction(request) {
  if (!credentialStore?.available()) {
    return { ok: false, status: 503, error: "Operating-system credential encryption is unavailable." };
  }
  if (request.action === "license:activate") {
    const token = String(request.payload?.token || "");
    const data = await syncDesktopLicense(token);
    try {
      await credentialStore.set("license", token);
    } catch (error) {
      await deleteDesktopLicense().catch(() => {});
      throw error;
    }
    return { ok: true, status: 200, data };
  }
  await credentialStore.delete("license");
  const data = await deleteDesktopLicense();
  return { ok: true, status: 200, data };
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

async function syncDesktopLicense(token) {
  return desktopLicenseRequest("POST", {
    token,
    intent: { action: "license:activate", confirm: "license:activate" }
  });
}

async function deleteDesktopLicense() {
  return desktopLicenseRequest("DELETE", {
    intent: { action: "license:delete", confirm: "license:delete" }
  });
}

async function desktopLicenseRequest(method, body) {
  const response = await fetch(`${baseUrl}/api/desktop-license`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-lca-studio-token": studioToken,
      "x-lca-desktop-token": desktopBridgeToken
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Desktop license sync failed (${response.status})`);
  return data;
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

async function writeSmokeResult(result) {
  let health = null;
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    health = response.ok ? await response.json() : { ok: false, status: response.status };
  } catch (error) {
    health = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await writeFile(smokeResultFile, JSON.stringify({ ...result, health }, null, 2), "utf8");
}

async function runManagedServerSmoke() {
  const mcpPort = Number(process.env.LCA_DESKTOP_SMOKE_MCP_PORT || 0);
  const dashboardPort = Number(process.env.LCA_DESKTOP_SMOKE_DASHBOARD_PORT || 0);
  if (!mcpPort || !dashboardPort) return null;
  const workspace = studioInstance?.state?.repoRoot;
  if (!workspace) throw new Error("Packaged smoke could not locate the Local Coding Agent repository.");
  const started = await studioJson("/api/server/start", {
    workspace,
    port: mcpPort,
    dashboardPort,
    mode: "safe",
    policy: "balanced",
    intent: { action: "mcp-server:start", confirm: "mcp-server:start" }
  });
  try {
    const response = await fetch(`http://127.0.0.1:${mcpPort}/healthz`);
    if (!response.ok) throw new Error(`Managed MCP health failed (${response.status}).`);
    const health = await response.json();
    return {
      started: Boolean(started.running),
      managed: Boolean(started.managed),
      pid: started.pid || null,
      health: health.status || null
    };
  } finally {
    await studioJson("/api/server/stop", {
      intent: { action: "mcp-server:stop", confirm: "mcp-server:stop" }
    }).catch(() => {});
  }
}

async function studioJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lca-studio-token": studioToken
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Studio request failed (${response.status}).`);
  return data;
}

function stopStudio() {
  if (shutdownPromise) return shutdownPromise;
  const current = studioInstance;
  studioInstance = null;
  studioToken = "";
  shutdownPromise = current?.close?.() || Promise.resolve();
  return shutdownPromise;
}

function isTrustedLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === host && Number(url.port || 80) === port;
  } catch {
    return false;
  }
}
