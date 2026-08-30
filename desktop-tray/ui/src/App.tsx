import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppConfig, MetaInfo, SecretInfo, Status, StatusMessage } from "./types";
import { PathsModal } from "./PathsModal";
import { LogsModal } from "./LogsModal";
import { ThemeControl } from "./ThemeControl";
import { OnboardingWizard } from "./OnboardingWizard";
import { PowerPanel } from "./PowerPanel";
import { SettingsPanel } from "./SettingsPanel";
import type { SettingsView } from "./SettingsPanel";
import { getSetupIssues, isSetupComplete, serverPresentation, tunnelPresentation } from "./view-model.mjs";

type AppView = "overview" | SettingsView;

const NAV: Array<{ id: AppView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "workspace", label: "Workspace" },
  { id: "connection", label: "Connection" },
  { id: "security", label: "Security" },
  { id: "advanced", label: "Advanced" }
];

const EMPTY_CFG: AppConfig = {
  node: "node",
  mcpAppDir: "",
  serverScript: "server.mjs",
  workspace: "",
  extraRoots: "",
  permissionProfileFile: "",
  permissionProfileName: "",
  mode: "safe",
  policy: "balanced",
  port: 8787,
  dashboardPort: 8790,
  authToken: "",
  tunnelBin: "",
  profile: "local-coding-agent",
  profileDir: "",
  tunnelId: "",
  organizationId: "",
  runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
  runtimeKey: "",
  tunnelHealthPort: "8788",
  openWebUi: true,
  noTunnel: true,
  v5Preview: true,
  allowSystemShutdown: false,
  allowDangerous: false
};

function emptyStatus(): Status {
  return {
    server: { state: "offline", version: "", mode: "", policy: "", permissionProfile: "", workspace: "", roots: 0, pid: null, v5Enabled: false },
    tunnel: { state: "stopped", reason: "", suffix: "not configured", mismatch: false },
    mcpUrl: "http://127.0.0.1:8787/mcp",
    dashboardUrl: "http://127.0.0.1:8790/ui"
  };
}

const ERROR_COPY: Record<string, string> = {
  node: "Node executable is empty.",
  mcpAppDir: "MCP app folder is empty.",
  workspace: "Choose the workspace the agent may access.",
  mode: "Mode must be safe or full.",
  policy: "Policy must be strict, balanced, or full.",
  port: "MCP port must be between 1 and 65535.",
  dashboardPort: "Dashboard port must be between 1 and 65535 and cannot use reserved port 8788."
};

export default function App() {
  const [cfg, setCfg] = useState<AppConfig>(EMPTY_CFG);
  const [secrets, setSecrets] = useState<SecretInfo>({ hasRuntimeKey: false, hasAuthToken: false });
  const [meta, setMeta] = useState<MetaInfo | null>(null);
  const [status, setStatus] = useState<Status>(emptyStatus());
  const [message, setMessage] = useState<StatusMessage>({ text: "", kind: "info" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [runtimeKeyInput, setRuntimeKeyInput] = useState("");
  const [authTokenInput, setAuthTokenInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [modal, setModal] = useState<"" | "paths" | "logs">("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [view, setView] = useState<AppView>("overview");

  const patch = useCallback((patchObj: Partial<AppConfig>) => {
    setCfg((previous) => ({ ...previous, ...patchObj }));
    setErrors({});
  }, []);
  const say = useCallback((text: string, kind: StatusMessage["kind"] = "info") => setMessage({ text, kind }), []);

  const browseDir = useCallback(async (key: keyof AppConfig) => {
    const picked = await window.lcat.pickDir("Pick folder");
    if (picked) patch({ [key]: picked } as Partial<AppConfig>);
  }, [patch]);
  const browseFile = useCallback(async (key: keyof AppConfig) => {
    const picked = await window.lcat.pickFile("Pick file");
    if (picked) patch({ [key]: picked } as Partial<AppConfig>);
  }, [patch]);

  const loadConfig = useCallback(async () => {
    const { config, secrets: secretState, meta: metadata } = await window.lcat.getConfig();
    const next = { ...EMPTY_CFG, ...(config as unknown as AppConfig) };
    setCfg(next);
    setSecrets(secretState);
    setMeta(metadata as unknown as MetaInfo);
    setAuthTokenInput("");
    setRuntimeKeyInput("");
    setLoaded(true);
    if (!isSetupComplete(next)) setShowOnboarding(true);
  }, []);

  useEffect(() => {
    void loadConfig();
    void window.lcat.getStatus().then((next) => setStatus(next as unknown as Status));
    const offStatus = window.lcat.onStatus((next) => setStatus(next as unknown as Status));
    const offLog = window.lcat.onLog((line) => setLogLines((previous) => [...previous.slice(-999), line]));
    const offModal = window.lcat.onOpenModal((name) => setModal(name === "logs" ? "logs" : "paths"));
    return () => { offStatus(); offLog(); offModal(); };
  }, [loadConfig]);

  const validate = useCallback(() => {
    const next = Object.fromEntries(getSetupIssues(cfg).map((key) => [key, ERROR_COPY[key]]));
    setErrors(next);
    return next;
  }, [cfg]);

  const mapStartError = useCallback((text: string) => {
    const lower = text.toLowerCase();
    const map: Array<[RegExp, string]> = [
      [/mcp app folder does not exist|server script not found/, "mcpAppDir"],
      [/tunnel executable not found/, "tunnelBin"], [/tunnel id is empty/, "tunnelId"],
      [/runtime api key/, "runtimeKey"], [/organization/i, "organizationId"],
      [/workspace/, "workspace"], [/port/i, "port"]
    ];
    const match = map.find(([pattern]) => pattern.test(lower));
    if (match) setErrors((previous) => ({ ...previous, [match[1]]: text }));
  }, []);

  const saveSettings = useCallback(async () => {
    const issues = validate();
    if (Object.keys(issues).length) { say(Object.values(issues)[0], "error"); return; }
    await window.lcat.setConfig(cfg);
    say("Configuration saved.", "ok");
  }, [cfg, say, validate]);

  const start = useCallback(async (): Promise<boolean> => {
    const issues = validate();
    if (Object.keys(issues).length) { say(Object.values(issues)[0], "error"); return false; }
    setBusy("start");
    try {
      await window.lcat.setConfig(cfg);
      const tunnelWanted = !cfg.noTunnel && Boolean(cfg.tunnelId.trim() && cfg.tunnelBin.trim());
      const result = await window.lcat.start({ tunnel: tunnelWanted });
      say(result.message, result.ok ? "ok" : "error");
      if (!result.ok) mapStartError(result.message);
      return result.ok;
    } catch (error) {
      say((error as Error).message, "error");
      return false;
    } finally { setBusy(""); }
  }, [cfg, mapStartError, say, validate]);

  const stop = useCallback(async () => {
    setBusy("stop");
    try { const result = await window.lcat.stop(); say(result.message, result.ok ? "ok" : "error"); }
    catch (error) { say((error as Error).message, "error"); }
    finally { setBusy(""); }
  }, [say]);

  const reconnectTunnel = useCallback(async () => {
    setBusy("reconnect");
    try { const result = await window.lcat.reconnectTunnel(); say(result.message, result.ok ? "ok" : "error"); if (!result.ok) mapStartError(result.message); }
    catch (error) { say((error as Error).message, "error"); }
    finally { setBusy(""); }
  }, [mapStartError, say]);

  const saveTunnel = useCallback(async () => {
    const nextErrors: Record<string, string> = {};
    if (!cfg.tunnelId.trim()) nextErrors.tunnelId = "Paste the tunnel_... ID first.";
    if (cfg.organizationId.trim() && !/^org_/.test(cfg.organizationId.trim())) nextErrors.organizationId = "Organization ID must start with org_.";
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); say(Object.values(nextErrors)[0], "error"); return; }
    await window.lcat.setConfig(cfg);
    say("Tunnel configuration saved.", "ok");
  }, [cfg, say]);

  const saveKey = useCallback(async () => {
    if (!runtimeKeyInput.trim()) { say("Enter a runtime API key before saving.", "warn"); return; }
    await window.lcat.saveSecret("runtimeKey", runtimeKeyInput.trim());
    setRuntimeKeyInput("");
    setSecrets((await window.lcat.getConfig()).secrets);
    say("Runtime API key saved encrypted.", "ok");
  }, [runtimeKeyInput, say]);

  const saveAuthToken = useCallback(async () => {
    if (authTokenInput.trim()) await window.lcat.saveSecret("authToken", authTokenInput.trim());
    else await window.lcat.clearSecret("authToken");
    setAuthTokenInput("");
    setSecrets((await window.lcat.getConfig()).secrets);
    say(authTokenInput.trim() ? "Auth token saved encrypted." : "Auth token cleared.", "ok");
  }, [authTokenInput, say]);

  const openDashboard = useCallback(async () => {
    const url = await window.lcat.openDashboard();
    say(url ? `Dashboard opened: ${url}` : "Dashboard is not available yet.", url ? "info" : "warn");
  }, [say]);

  const completeSetup = useCallback(async () => {
    const ok = await start();
    if (ok) { setShowOnboarding(false); setView("overview"); }
    return ok;
  }, [start]);

  const serverCanStop = useMemo(() => ["online", "error", "starting"].includes(status.server.state), [status.server.state]);
  const serverSummary = serverPresentation(status.server as unknown as Record<string, unknown>);
  const tunnelSummary = tunnelPresentation(status.tunnel as unknown as Record<string, unknown>);

  return (
    <div className="app">
      <header className="app-header modern-header">
        <div className="brand-lockup"><div className="brand-mark" aria-hidden="true">L</div><div><h1>Local Coding Agent</h1><span className="app-meta">Tray v5.0.1</span></div></div>
        <nav className="app-nav" aria-label="Main navigation">
          {NAV.map((item) => <button key={item.id} type="button" className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => setView(item.id)}>{item.label}</button>)}
        </nav>
        <ThemeControl />
      </header>

      <main className="app-main modern-main">
        {!loaded ? <div className="loading-state"><span className="status-icon">●</span> Loading local configuration…</div> : view === "overview" ? (
          <PowerPanel config={cfg} status={status} message={message} busy={busy} serverCanStop={serverCanStop}
            onStart={() => { void start(); }} onStop={() => { void stop(); }} onReconnect={() => { void reconnectTunnel(); }} onDashboard={() => { void openDashboard(); }}
            onCopyMcp={() => { void window.lcat.copyMcpUrl().then(() => say("MCP URL copied.", "ok")); }}
            onCopyTunnel={() => { void window.lcat.copyTunnelId().then((id) => say(id ? "Tunnel ID copied." : "Tunnel ID is empty.", id ? "ok" : "warn")); }}
            onManagePaths={() => setModal("paths")} onLogs={() => setModal("logs")} />
        ) : (
          <SettingsPanel view={view} config={cfg} secrets={secrets} errors={errors} runtimeKeyInput={runtimeKeyInput} authTokenInput={authTokenInput}
            showRuntimeKey={showKey} showAuthToken={showAuth} onPatch={patch} onRuntimeKeyInput={setRuntimeKeyInput} onAuthTokenInput={setAuthTokenInput}
            onToggleRuntimeKey={() => setShowKey((current) => !current)} onToggleAuthToken={() => setShowAuth((current) => !current)}
            onBrowseDir={(key) => { void browseDir(key); }} onBrowseFile={(key) => { void browseFile(key); }} onManagePaths={() => setModal("paths")}
            onSaveSettings={() => { void saveSettings(); }} onSaveTunnel={() => { void saveTunnel(); }} onSaveRuntimeKey={() => { void saveKey(); }}
            onSaveAuthToken={() => { void saveAuthToken(); }} onRunSetup={() => setShowOnboarding(true)} />
        )}
      </main>

      <footer className="app-footer modern-footer">
        <div className="footer-status"><span className={`status-dot tone-${serverSummary.tone}`}></span>{serverSummary.label}</div>
        <div className="footer-status"><span className={`status-dot tone-${tunnelSummary.tone}`}></span>{tunnelSummary.label}</div>
        <span className="footer-spacer"></span><span className="footer-path" title={meta?.configPath || ""}>{cfg.workspace || "Workspace not configured"}</span>
      </footer>

      {modal === "paths" && <PathsModal onClose={() => setModal("")} onSaved={() => { void loadConfig(); say("Permission profiles saved.", "ok"); }} />}
      {modal === "logs" && <LogsModal lines={logLines} meta={meta} onClose={() => setModal("")} />}
      {loaded && showOnboarding && <OnboardingWizard config={cfg} secrets={secrets} errors={errors} runtimeKeyInput={runtimeKeyInput} showRuntimeKey={showKey}
        onPatch={patch} onRuntimeKeyInput={setRuntimeKeyInput} onToggleRuntimeKey={() => setShowKey((current) => !current)}
        onBrowseWorkspace={() => { void browseDir("workspace"); }} onBrowseTunnel={() => { void browseFile("tunnelBin"); }} onManagePaths={() => setModal("paths")}
        onSaveRuntimeKey={saveKey} onComplete={completeSetup} onClose={isSetupComplete(cfg) ? () => setShowOnboarding(false) : undefined} />}
    </div>
  );
}
