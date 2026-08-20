import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, MetaInfo, SecretInfo, Status, StatusMessage } from "./types";
import { PathsModal } from "./PathsModal";
import { LogsModal } from "./LogsModal";

const MODES = ["safe", "full"];
const POLICIES = ["strict", "balanced", "full"];

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
  noTunnel: false,
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

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  hint?: string;
  placeholder?: string;
  browse?: () => void;
  type?: string;
  onShowToggle?: () => void;
  showToggle?: boolean;
}

function Field({ label, value, onChange, invalid, hint, placeholder, browse, type = "text", onShowToggle, showToggle }: FieldProps) {
  return (
    <label className={`field${invalid ? " invalid" : ""}`} title={hint}>
      <span className="field-label">{label}</span>
      <span className="field-control">
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {showToggle && (
          <button type="button" className="mini" onClick={onShowToggle} title="Show/hide">
            {type === "password" ? "Show" : "Hide"}
          </button>
        )}
        {browse && (
          <button type="button" className="mini" onClick={browse}>
            Browse
          </button>
        )}
      </span>
    </label>
  );
}

interface CheckProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
  hint?: string;
}

function Check({ label, checked, onChange, danger, hint }: CheckProps) {
  return (
    <label className={`check${danger ? " danger" : ""}`} title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

interface GroupProps {
  title: string;
  children: React.ReactNode;
}

function Group({ title, children }: GroupProps) {
  return (
    <section className="group">
      <h2>{title}</h2>
      <div className="group-body">{children}</div>
    </section>
  );
}

const SERVER_STATE_COLOR: Record<string, string> = {
  online: "state-ok",
  starting: "state-warn",
  stopping: "state-warn",
  error: "state-error",
  offline: "state-off"
};

const TUNNEL_STATE_COLOR: Record<string, string> = {
  connected: "state-ok",
  starting: "state-warn",
  reconnecting: "state-warn",
  error: "state-error",
  stopped: "state-off",
  not_configured: "state-off"
};

export default function App() {
  const [cfg, setCfg] = useState<AppConfig>(EMPTY_CFG);
  const [secrets, setSecrets] = useState<SecretInfo>({ hasRuntimeKey: false, hasAuthToken: false });
  const [meta, setMeta] = useState<MetaInfo | null>(null);
  const [status, setStatus] = useState<Status>(emptyStatus());
  const [message, setMessage] = useState<StatusMessage>({ text: "", kind: "info" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>("");
  const [runtimeKeyInput, setRuntimeKeyInput] = useState("");
  const [authTokenInput, setAuthTokenInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [modal, setModal] = useState<"" | "paths" | "logs">("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const mounted = useRef(true);

  const patch = useCallback((patchObj: Partial<AppConfig>) => {
    setCfg((prev) => ({ ...prev, ...patchObj }));
    setErrors({});
  }, []);

  const setField = (key: keyof AppConfig) => (value: string) => patch({ [key]: value } as Partial<AppConfig>);

  const browseDir = (key: keyof AppConfig) => async () => {
    const picked = await window.lcat.pickDir("Pick folder");
    if (picked) patch({ [key]: picked } as Partial<AppConfig>);
  };

  const browseFile = (key: keyof AppConfig) => async () => {
    const picked = await window.lcat.pickFile("Pick file");
    if (picked) patch({ [key]: picked } as Partial<AppConfig>);
  };

  const say = useCallback((text: string, kind: StatusMessage["kind"] = "info") => {
    setMessage({ text, kind });
  }, []);

  // ---- validation ------------------------------------------------------------

  const validate = useCallback((): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!cfg.node.trim()) errs.node = "Node executable is empty.";
    if (!cfg.mcpAppDir.trim()) errs.mcpAppDir = "MCP app folder is empty.";
    if (!cfg.port || cfg.port < 1 || cfg.port > 65535) errs.port = "Port must be between 1 and 65535.";
    if (!cfg.dashboardPort || cfg.dashboardPort < 1 || cfg.dashboardPort > 65535) errs.dashboardPort = "Dashboard port must be between 1 and 65535.";
    if (cfg.dashboardPort === 8788) errs.dashboardPort = "Port 8788 is reserved for the tunnel client.";
    if (!cfg.workspace.trim()) errs.workspace = "Legacy workspace is empty. Pick a folder the agent may access.";
    if (!cfg.policy) errs.policy = "Policy is required.";
    if (!cfg.mode) errs.mode = "Mode is required.";
    return errs;
  }, [cfg]);

  // ---- actions ---------------------------------------------------------------

  const loadConfig = useCallback(async () => {
    const { config, secrets: sec, meta: m } = await window.lcat.getConfig();
    setCfg({ ...EMPTY_CFG, ...(config as unknown as AppConfig) });
    setSecrets(sec);
    setMeta(m as unknown as MetaInfo);
    setAuthTokenInput("");
    setRuntimeKeyInput("");
  }, []);

  useEffect(() => {
    loadConfig();
    window.lcat.getStatus().then((s) => setStatus(s as unknown as Status));
    const offStatus = window.lcat.onStatus((s) => setStatus(s as unknown as Status));
    const offLog = window.lcat.onLog((line) => setLogLines((prev) => [...prev.slice(-999), line]));
    const offModal = window.lcat.onOpenModal((name) => setModal(name === "logs" ? "logs" : "paths"));
    return () => {
      mounted.current = false;
      offStatus();
      offLog();
      offModal();
    };
  }, [loadConfig]);

  const saveSettings = useCallback(async () => {
    await window.lcat.setConfig(cfg);
    setErrors({});
    say("Configuration saved.", "ok");
  }, [cfg, say]);

  const start = useCallback(async () => {
    const errs = validate();
    if (Object.keys(errs).length) {
      setErrors(errs);
      const first = Object.values(errs)[0];
      say(first, "error");
      return;
    }
    setBusy("start");
    try {
      await window.lcat.setConfig(cfg);
      const tunnelWanted = Boolean(cfg.tunnelId.trim() && cfg.tunnelBin.trim());
      const res = await window.lcat.start({ tunnel: tunnelWanted });
      say(res.message, res.ok ? "ok" : "error");
      if (!res.ok) mapStartError(res.message);
    } finally {
      setBusy("");
    }
  }, [cfg, validate, say]);

  const stop = useCallback(async () => {
    setBusy("stop");
    try {
      const res = await window.lcat.stop();
      say(res.message, res.ok ? "ok" : "error");
    } finally {
      setBusy("");
    }
  }, [say]);

  const reconnectTunnel = useCallback(async () => {
    setBusy("reconnect");
    try {
      const res = await window.lcat.reconnectTunnel();
      say(res.message, res.ok ? "ok" : "error");
      if (!res.ok) mapStartError(res.message);
    } finally {
      setBusy("");
    }
  }, [say]);

  const copyMcpUrl = useCallback(async () => {
    await window.lcat.copyMcpUrl();
    say("Copied.", "ok");
  }, [say]);

  const copyTunnelId = useCallback(async () => {
    const id = await window.lcat.copyTunnelId();
    say(id ? "Copied." : "Tunnel ID is empty.", id ? "ok" : "warn");
  }, [say]);

  const saveTunnel = useCallback(async () => {
    const errs: Record<string, string> = {};
    if (!cfg.tunnelId.trim()) errs.tunnelId = "Tunnel ID is empty. Paste the tunnel_... ID from ChatGPT/OpenAI first.";
    const org = cfg.organizationId.trim();
    if (org && !/^org_/.test(org)) errs.organizationId = "Organization ID looks invalid (expected org_...).";
    if (Object.keys(errs).length) {
      setErrors(errs);
      say(Object.values(errs)[0], "error");
      return;
    }
    await window.lcat.setConfig(cfg);
    setErrors({});
    say("Tunnel saved.", "ok");
  }, [cfg, say]);

  const saveKey = useCallback(async () => {
    if (!runtimeKeyInput.trim()) {
      say("No key saved yet.", "warn");
      return;
    }
    await window.lcat.saveSecret("runtimeKey", runtimeKeyInput);
    setRuntimeKeyInput("");
    setSecrets(await (await window.lcat.getConfig()).secrets);
    say("Runtime API key saved.", "ok");
  }, [runtimeKeyInput, say]);

  const saveAuthToken = useCallback(async () => {
    await window.lcat.saveSecret("authToken", authTokenInput.trim());
    setAuthTokenInput("");
    setSecrets(await (await window.lcat.getConfig()).secrets);
    say(authTokenInput.trim() ? "Auth token saved." : "Auth token cleared.", "ok");
  }, [authTokenInput, say]);

  const openDashboard = useCallback(async () => {
    const url = await window.lcat.openDashboard();
    say(url ? `Dashboard opened: ${url}` : "Dashboard not available.", url ? "info" : "warn");
  }, [say]);

  function mapStartError(m: string) {
    const lower = m.toLowerCase();
    const map: Array<[RegExp, string]> = [
      [/mcp app folder does not exist|server script not found/, "mcpAppDir"],
      [/tunnel executable not found/, "tunnelBin"],
      [/tunnel id is empty/, "tunnelId"],
      [/runtime api key/, "runtimeKey"],
      [/organization/i, "organizationId"],
      [/workspace/, "workspace"],
      [/port/i, "port"]
    ];
    for (const [re, field] of map) {
      if (re.test(lower)) {
        setErrors((prev) => ({ ...prev, [field]: m }));
        return;
      }
    }
  }

  const serverState = status.server.state;
  const tunnelState = status.tunnel.state;
  const serverLabel =
    serverState === "online"
      ? `Server: ONLINE v${status.server.version} (${status.server.permissionProfile || "legacy"}, ${status.server.roots} path(s))`
      : `Server: ${serverState.toUpperCase()}`;
  const tunnelLabel = `Tunnel: ${tunnelState.toUpperCase()}${status.tunnel.reason ? ` — ${status.tunnel.reason}` : ""}`;

  const serverCanStop = useMemo(() => {
    return status.server.state === "online" || status.server.state === "error" || status.server.state === "starting";
  }, [status.server.state]);

  const busyAny = busy !== "";

  return (
    <div className="app">
      <header className="app-header">
        <h1>Local Coding Agent Tray v5.0.1</h1>
        <span className="app-meta">{meta ? meta.configPath : ""}</span>
      </header>

      <main className="app-main">
        <Group title="Paths">
          <Field label="Node executable" value={cfg.node} onChange={setField("node")} invalid={!!errors.node} hint="Executable used to run the MCP Node.js server." placeholder="node" />
          <Field label="MCP app folder" value={cfg.mcpAppDir} onChange={setField("mcpAppDir")} invalid={!!errors.mcpAppDir} hint="Folder containing server.mjs (source/runtime of the MCP server)." browse={browseDir("mcpAppDir")} />
          <Field label="tunnel-client" value={cfg.tunnelBin} onChange={setField("tunnelBin")} invalid={!!errors.tunnelBin} hint="Your copy of the OpenAI tunnel client (platform binary, never shipped in this repo)." browse={browseFile("tunnelBin")} />
          <Field label="Tunnel profile dir" value={cfg.profileDir} onChange={setField("profileDir")} hint="Folder holding tunnel profiles (YAML)." browse={browseDir("profileDir")} />
          <Field label="Tunnel profile name" value={cfg.profile} onChange={setField("profile")} hint="Profile name used by the tunnel client." placeholder="local-coding-agent" />
        </Group>

        <Group title="Agent">
          <Field label="Legacy workspace" value={cfg.workspace} onChange={setField("workspace")} invalid={!!errors.workspace} hint="Root folder the agent may read/write (legacy single-path mode)." browse={browseDir("workspace")} />
          <Field label="Legacy roots (;)" value={cfg.extraRoots} onChange={setField("extraRoots")} hint="Extra authorized roots, semicolon-separated (legacy mode)." placeholder="D:\Projects;D:\OCR" />
          <Field label="Profile store" value={cfg.permissionProfileFile} onChange={setField("permissionProfileFile")} hint="File storing named multi-path permission profiles." browse={browseFile("permissionProfileFile")} />
          <Field label="Active profile" value={cfg.permissionProfileName} onChange={setField("permissionProfileName")} hint="Currently active named permission profile." />
          <div className="manage-row">
            <button type="button" onClick={() => setModal("paths")}>
              Manage authorized paths...
            </button>
            <span className="hint">Named multi-path profiles</span>
          </div>
          <div className="row-2col">
            <label className={`field${errors.mode ? " invalid" : ""}`}>
              <span className="field-label">Mode</span>
              <span className="field-control">
                <select value={cfg.mode} onChange={(e) => patch({ mode: e.target.value as "safe" | "full" })}>
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className={`field${errors.port ? " invalid" : ""}`}>
              <span className="field-label">Port</span>
              <span className="field-control">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={cfg.port}
                  onChange={(e) => patch({ port: parseInt(e.target.value, 10) || 0 })}
                />
              </span>
            </label>
          </div>
          <div className="row-2col">
            <label className={`field${errors.policy ? " invalid" : ""}`}>
              <span className="field-label">Policy</span>
              <span className="field-control">
                <select value={cfg.policy} onChange={(e) => patch({ policy: e.target.value as AppConfig["policy"] })}>
                  {POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className={`field${errors.dashboardPort ? " invalid" : ""}`}>
              <span className="field-label">Dashboard port</span>
              <span className="field-control">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={cfg.dashboardPort}
                  onChange={(e) => patch({ dashboardPort: parseInt(e.target.value, 10) || 0 })}
                />
              </span>
            </label>
          </div>
          <Field
            label="Auth token (opt)"
            value={authTokenInput !== "" ? authTokenInput : secrets.hasAuthToken ? "••••••••" : ""}
            onChange={(v) => setAuthTokenInput(v)}
            type={showAuth ? "text" : "password"}
            showToggle
            onShowToggle={() => setShowAuth((s) => !s)}
            hint="Optional bearer token for the local MCP API. Saved encrypted."
          />
          {authTokenInput !== "" && (
            <div className="inline-actions">
              <button type="button" className="mini" onClick={saveAuthToken}>
                Save auth token
              </button>
            </div>
          )}
        </Group>

        <Group title="Tunnel">
          <Field label="Tunnel ID" value={cfg.tunnelId} onChange={setField("tunnelId")} invalid={!!errors.tunnelId} hint="Tunnel identifier (tunnel_...) from ChatGPT/OpenAI." placeholder="tunnel_..." />
          <div className="inline-actions">
            <Field label="Organization ID" value={cfg.organizationId} onChange={setField("organizationId")} invalid={!!errors.organizationId} hint="Optional OpenAI organization ID (org_...), fixes tunnel_active_organization_required." placeholder="org_..." />
            <button type="button" className="mini" onClick={saveTunnel}>
              Save tunnel
            </button>
          </div>
          <div className="inline-actions">
            <Field
              label="Runtime API key"
              value={runtimeKeyInput}
              onChange={setRuntimeKeyInput}
              type={showKey ? "text" : "password"}
              showToggle
              onShowToggle={() => setShowKey((s) => !s)}
              hint="Platform runtime key (CONTROL_PLANE_API_KEY). Stored encrypted, never in plain text."
              placeholder={secrets.hasRuntimeKey ? "•••••••• (saved)" : "sk-..."}
            />
            <button type="button" className="mini" onClick={saveKey}>
              Save key
            </button>
          </div>
          <div className="key-status">{secrets.hasRuntimeKey ? "Runtime API key saved." : "No key saved yet."}</div>
          <div className="checks">
            <Check label="Open tunnel web UI on start" checked={cfg.openWebUi} onChange={(v) => patch({ openWebUi: v })} hint="Open the tunnel web UI when the tunnel connects." />
            <Check label="Enable v5 features (official)" checked={cfg.v5Preview} onChange={(v) => patch({ v5Preview: v })} hint="Official v5 feature set. Disable only for temporary v4 compatibility." />
            <Check
              label="Allow prompt-requested shutdown (immediate, no approval)"
              checked={cfg.allowSystemShutdown}
              onChange={(v) => patch({ allowSystemShutdown: v })}
              danger
              hint="DANGEROUS: lets the agent shut down the machine on an explicit prompt without dashboard approval. Raw power commands stay blocked."
            />
            <Check
              label="Allow dangerous system commands (AGENT_ALLOW_DANGEROUS)"
              checked={cfg.allowDangerous}
              onChange={(v) => patch({ allowDangerous: v })}
              danger
              hint="DANGEROUS: removes the catastrophic-command blocklist (mkfs, dd to devices, rm -rf /, …). The agent can run ANY command it can construct. Only for trusted workspaces."
            />
          </div>
        </Group>

        <section className="group">
          <h2>Actions</h2>
          <div className="actions">
            <button type="button" className="primary" disabled={busyAny} onClick={start}>
              {busy === "start" ? "Starting…" : "Start"}
            </button>
            <button type="button" disabled={busyAny || !serverCanStop} onClick={stop}>
              {busy === "stop" ? "Stopping…" : "Stop"}
            </button>
            <button type="button" disabled={busyAny} onClick={reconnectTunnel}>
              {busy === "reconnect" ? "Reconnecting…" : "Reconnect tunnel"}
            </button>
            <button type="button" onClick={openDashboard}>
              Open Dashboard
            </button>
          </div>
          <h2>Utilities</h2>
          <div className="actions">
            <button type="button" onClick={saveSettings}>
              Save settings
            </button>
            <button type="button" onClick={copyMcpUrl}>
              Copy local MCP URL
            </button>
            <button type="button" onClick={copyTunnelId}>
              Copy Tunnel ID
            </button>
            <button type="button" onClick={() => setModal("logs")}>
              Logs/Config
            </button>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <div className="status-bar">
          <span className={`status-item ${SERVER_STATE_COLOR[serverState] || "state-off"}`}>{serverLabel}</span>
          <span className={`status-item ${TUNNEL_STATE_COLOR[tunnelState] || "state-off"}`}>{tunnelLabel}</span>
        </div>
        <div className={`status-line ${message.kind === "error" ? "msg-error" : message.kind === "ok" ? "msg-ok" : message.kind === "warn" ? "msg-warn" : ""}`}>
          {message.text || (secrets.hasRuntimeKey ? "" : "Save the Runtime API key before connecting the tunnel.")}
        </div>
      </footer>

      {modal === "paths" && (
        <PathsModal
          onClose={() => setModal("")}
          onSaved={() => {
            loadConfig();
            say("Permission profiles saved.", "ok");
          }}
        />
      )}
      {modal === "logs" && <LogsModal lines={logLines} meta={meta} onClose={() => setModal("")} />}
    </div>
  );
}
