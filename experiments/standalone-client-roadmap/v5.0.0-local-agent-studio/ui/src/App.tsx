import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  Download,
  FileText,
  FolderGit2,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  Wrench
} from "lucide-react";

type Role = "user" | "assistant" | "system" | "tool";

type ThreadSummary = {
  id: string;
  title: string;
  provider?: string;
  model?: string;
  updated_at?: string;
};

type ThreadItem = {
  id?: string;
  type?: "message" | "tool";
  role?: Role;
  content?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
};

type ToolSummary = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type TimelineEvent = {
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  ms?: number;
};

type HealthPayload = {
  product?: string;
  version?: string;
  license?: { allowed?: boolean; mode?: string; reason?: string };
  integrity?: { allowed?: boolean; mode?: string; reason?: string };
  security?: Record<string, unknown>;
  features?: string[];
  providers?: ProviderStatus[];
  updates?: UpdateStatus;
  openai_key_present?: boolean;
  anthropic_key_present?: boolean;
};

type UpdateStatus = {
  enabled?: boolean;
  mode?: string;
  currentVersion?: string;
  currentBuild?: number;
  channel?: string;
  highestVerifiedBuild?: number;
  reason?: string;
};

type ProviderStatus = {
  id?: string;
  provider?: string;
  name?: string;
  enabled?: boolean;
  ready?: boolean;
  configured?: boolean;
  source?: string;
  readonly?: boolean;
  updatedAt?: string | null;
};

type ModelPreset = {
  id: string;
  label: string;
  provider: string;
  model: string;
};

const token = document.querySelector<HTMLMetaElement>('meta[name="lca-studio-token"]')?.content || "";
const intent = (action: string) => ({ action, confirm: action });

declare global {
  interface Window {
    localAgentStudio?: {
      platform?: string;
      privileged?: (action: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; data?: unknown; error?: string }>;
    };
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-lca-studio-token": token,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function privilegedApi<T>(action: string, payload: Record<string, unknown>, fallback: () => Promise<T>): Promise<T> {
  if (!window.localAgentStudio?.privileged) return fallback();
  const response = await window.localAgentStudio.privileged(action, payload);
  if (!response.ok) throw new Error(response.error || `Privileged action failed (${response.status})`);
  return response.data as T;
}

function itemKey(item: ThreadItem, index: number) {
  return item.id || `${item.role || item.type || "item"}-${index}`;
}

function preview(text: string, limit = 86) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}...` : compact;
}

function formatAge(value?: string) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:8787/mcp");
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [providerKeys, setProviderKeys] = useState<Record<string, ProviderStatus>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready");

  const features = new Set(health?.features || []);

  useEffect(() => {
    void boot();
  }, []);

  async function boot() {
    try {
      const [healthData, presetData, threadData] = await Promise.all([
        api<HealthPayload>("/api/health"),
        api<{ presets: ModelPreset[] }>("/api/model-presets"),
        api<{ threads: ThreadSummary[] }>("/api/threads?limit=80")
      ]);
      setHealth(healthData);
      setProviderKeys(providerStatusMap(healthData.providers || []));
      setPresets(presetData.presets || []);
      setThreads(threadData.threads || []);
      if (healthData.features?.length) setNotice(`${healthData.product || "Studio"} online`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshThreads() {
    const data = await api<{ threads: ThreadSummary[] }>("/api/threads?limit=80");
    setThreads(data.threads || []);
  }

  async function openThread(id: string) {
    const data = await api<{ thread: ThreadSummary; items: ThreadItem[] }>(`/api/threads/${encodeURIComponent(id)}?limit=400`);
    setActiveThreadId(id);
    setItems(data.items || []);
    setTimeline(
      (data.items || [])
        .filter((item) => item.type === "tool")
        .map((item) => ({
          tool: String(item.metadata?.tool || "tool"),
          args: item.metadata?.args as Record<string, unknown>,
          result: item.content || "",
          isError: Boolean(item.metadata?.isError),
          ms: Number(item.metadata?.ms || 0)
        }))
        .reverse()
    );
  }

  function newThread() {
    setActiveThreadId(null);
    setItems([]);
    setTimeline([]);
    setNotice("New thread");
  }

  async function connectTools() {
    setNotice("Connecting MCP...");
    const data = await api<{ endpoint: string; tools: ToolSummary[] }>("/api/connect", {
      method: "POST",
      body: JSON.stringify({ endpoint })
    });
    setEndpoint(data.endpoint);
    setTools(data.tools || []);
    setNotice(`${data.tools?.length || 0} tools connected`);
  }

  async function refreshTools() {
    const data = await api<{ endpoint: string; tools: ToolSummary[] }>("/api/tools");
    setEndpoint(data.endpoint);
    setTools(data.tools || []);
    setNotice(`${data.tools?.length || 0} tools`);
  }

  async function sendMessage() {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setMessage("");
    setItems((current) => [
      ...current,
      { role: "user", type: "message", content: text },
      { role: "assistant", type: "message", content: "Thinking..." }
    ]);
    try {
      const data = await api<{ text?: string; threadId: string; timeline?: TimelineEvent[] }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ threadId: activeThreadId, message: text, provider, model })
      });
      setActiveThreadId(data.threadId);
      setTimeline((current) => [...(data.timeline || []).reverse(), ...current]);
      await refreshThreads();
      await openThread(data.threadId);
      setNotice("Turn complete");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setItems((current) => current.map((item, index) => index === current.length - 1 ? { ...item, content: `Error: ${msg}` } : item));
      setNotice(msg);
    } finally {
      setBusy(false);
    }
  }

  async function startServer() {
    const workspace = window.prompt("Workspace path for MCP server", "");
    const payload = { workspace: workspace || undefined, mode: "safe", policy: "balanced" };
    const data = await privilegedApi<{ endpoint: string }>("mcpServer:start", payload, () => api("/api/server/start", {
      method: "POST",
      body: JSON.stringify({ ...payload, intent: intent("mcp-server:start") })
    }));
    setEndpoint(data.endpoint);
    setNotice(`MCP server running at ${data.endpoint}`);
  }

  async function stopServer() {
    const data = await privilegedApi<{ stopped?: boolean; reason?: string }>("mcpServer:stop", {}, () => api("/api/server/stop", {
      method: "POST",
      body: JSON.stringify({ intent: intent("mcp-server:stop") })
    }));
    setNotice(data.stopped ? "MCP server stopped" : data.reason || "No managed server");
  }

  async function supportBundle() {
    const data = await privilegedApi<{ path: string }>("supportBundle:export", {}, () => api("/api/support-bundle", {
      method: "POST",
      body: JSON.stringify({ intent: intent("support-bundle:export") })
    }));
    setNotice(`Support bundle: ${data.path}`);
  }

  async function activateLicense() {
    const status = await api<{ allowed?: boolean; mode?: string; reason?: string }>("/api/license");
    if (status.allowed && status.mode === "experimental") {
      setNotice("Preview mode: commercial key not required yet");
      return;
    }
    const licenseToken = window.prompt(`${status.reason || "License token required"}\nPaste admin-provided signed license token:`, "");
    if (!licenseToken) return;
    const activated = await privilegedApi<{ edition?: string }>("license:activate", { token: licenseToken }, () => api("/api/license/activate", {
      method: "POST",
      body: JSON.stringify({ token: licenseToken, intent: intent("license:activate") })
    }));
    setNotice(`License activated: ${activated.edition || "ok"}`);
    await boot();
  }

  async function saveProviderKey(providerId: "openai" | "anthropic") {
    const value = window.prompt(`${providerId} API key`, "");
    if (!value) return;
    const payload = { provider: providerId, value, label: `${providerId} key` };
    const status = await privilegedApi<ProviderStatus>("providerKey:set", payload, () => api(`/api/secrets/${providerId}`, {
      method: "POST",
      body: JSON.stringify({ ...payload, intent: intent("provider-key:set") })
    }));
    setProviderKeys((current) => ({ ...current, [providerId]: status }));
    await boot();
    setNotice(`${providerId} key saved`);
  }

  async function deleteProviderKey(providerId: "openai" | "anthropic") {
    if (!window.confirm(`Delete saved ${providerId} key from this device?`)) return;
    const payload = { provider: providerId };
    await privilegedApi<{ ok: boolean }>("providerKey:delete", payload, () => api(`/api/secrets/${providerId}`, {
      method: "DELETE",
      body: JSON.stringify({ intent: intent("provider-key:delete") })
    }));
    const status = await api<ProviderStatus>(`/api/secrets/${providerId}`);
    setProviderKeys((current) => ({ ...current, [providerId]: status }));
    await boot();
    setNotice(`${providerId} key removed`);
  }

  async function verifyReleaseUpdate() {
    const raw = window.prompt("Paste signed update manifest JSON", "");
    if (!raw) return;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      setNotice("Update manifest JSON is invalid");
      return;
    }
    const result = await privilegedApi<{ verified?: boolean; update?: { version?: string; available?: boolean } }>(
      "releaseUpdate:verify",
      { envelope },
      () => api("/api/release-update/verify", {
        method: "POST",
        body: JSON.stringify({ envelope, intent: intent("release-update:verify") })
      })
    );
    setNotice(`Update ${result.update?.version || "manifest"} verified${result.update?.available ? " / available" : ""}`);
    await boot();
  }

  async function stageReleaseUpdate() {
    const raw = window.prompt("Paste signed update manifest JSON to download and stage", "");
    if (!raw) return;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      setNotice("Update manifest JSON is invalid");
      return;
    }
    if (!window.confirm("Download and verify this signed update artifact? It will not be executed.")) return;
    setNotice("Downloading signed update artifact...");
    const result = await privilegedApi<{ path?: string; version?: string; size?: number }>(
      "releaseUpdate:stage",
      { envelope },
      () => api("/api/release-update/stage", {
        method: "POST",
        body: JSON.stringify({ envelope, intent: intent("release-update:stage") })
      })
    );
    setNotice(`Update ${result.version || "artifact"} staged (${result.size || 0} bytes): ${result.path || "verified"}`);
    await boot();
  }

  function applyPreset(id: string) {
    const preset = presets.find((entry) => entry.id === id);
    if (!preset) return;
    setProvider(preset.provider);
    setModel(preset.model);
  }

  const readyLabel = useMemo(() => {
    if (!health) return "offline";
    if (!health.license?.allowed) return "license";
    if (!health.integrity?.allowed) return "integrity";
    return health.openai_key_present || health.anthropic_key_present ? "ready" : "keys";
  }, [health]);

  return (
    <div className="studio-shell">
      <aside className="rail">
        <div className="brand">
          <div className="mark">LA</div>
          <div>
            <strong>{health?.product || "Local Agent Studio"}</strong>
            <span>{health?.version || "v5 preview"}</span>
          </div>
        </div>

        <div className="rail-actions">
          <button title="New thread" onClick={newThread}><Plus size={16} /></button>
          <button title="Refresh threads" onClick={() => void refreshThreads()}><RefreshCw size={16} /></button>
          <button title="License" onClick={() => void activateLicense()}><KeyRound size={16} /></button>
          <button title="Support bundle" onClick={() => void supportBundle()}><Download size={16} /></button>
        </div>

        <div className="status-card">
          <div className={`dot ${readyLabel}`} />
          <div>
            <strong>{readyLabel}</strong>
            <span>{notice}</span>
          </div>
        </div>

        <div className="thread-list">
          {threads.map((thread) => (
            <button
              className={thread.id === activeThreadId ? "thread active" : "thread"}
              key={thread.id}
              onClick={() => void openThread(thread.id)}
            >
              <span>{preview(thread.title || "Untitled", 58)}</span>
              <small>{thread.provider || "agent"} / {thread.model || "model"} {formatAge(thread.updated_at)}</small>
            </button>
          ))}
          {!threads.length && <div className="empty">No threads yet.</div>}
        </div>
      </aside>

      <main className="conversation">
        <header className="topbar">
          <div className="model-row">
            <select value="" onChange={(event) => applyPreset(event.target.value)} aria-label="Preset">
              <option value="">Preset</option>
              {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
            <select value={provider} onChange={(event) => setProvider(event.target.value)} aria-label="Provider">
              {(health?.features ? ["openai", "anthropic", "ollama"] : ["openai"]).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
            <input value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model" />
          </div>
          <div className="top-actions">
            {features.has("serverSupervisor") && <button title="Start MCP" onClick={() => void startServer()}><Play size={16} /></button>}
            {features.has("serverSupervisor") && <button title="Stop MCP" onClick={() => void stopServer()}><Square size={16} /></button>}
            <button title="Refresh health" onClick={() => void boot()}><Activity size={16} /></button>
          </div>
        </header>

        <VirtualMessages items={items} />

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <textarea
            value={message}
            placeholder="Ask the agent to inspect, edit, test, or explain this workspace..."
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void sendMessage();
            }}
          />
          <button className="send" disabled={busy || !message.trim()} title="Send">
            <Send size={18} />
          </button>
        </form>
      </main>

      <aside className="inspector">
        <section>
          <h2><Settings size={16} /> MCP</h2>
          <div className="endpoint-row">
            <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
            <button title="Connect MCP" onClick={() => void connectTools()}><Play size={15} /></button>
            <button title="Refresh tools" onClick={() => void refreshTools()}><RefreshCw size={15} /></button>
          </div>
        </section>

        <section>
          <h2><KeyRound size={16} /> Provider Keys</h2>
          <ProviderKeyRow
            id="openai"
            status={providerKeys.openai}
            onSave={() => void saveProviderKey("openai")}
            onDelete={() => void deleteProviderKey("openai")}
          />
          <ProviderKeyRow
            id="anthropic"
            status={providerKeys.anthropic}
            onSave={() => void saveProviderKey("anthropic")}
            onDelete={() => void deleteProviderKey("anthropic")}
          />
        </section>

        <section>
          <h2><RefreshCw size={16} /> Updates</h2>
          <div className="update-row">
            <div>
              <strong>{health?.updates?.currentVersion || "v5 preview"}</strong>
              <span>{health?.updates?.channel || "local"} / build {health?.updates?.currentBuild || 0}</span>
              <span>verified {health?.updates?.highestVerifiedBuild || health?.updates?.currentBuild || 0}</span>
            </div>
            <button title="Verify signed update manifest" disabled={!health?.updates?.enabled} onClick={() => void verifyReleaseUpdate()}><ShieldCheck size={15} /></button>
            <button title="Download and stage signed update" disabled={!health?.updates?.enabled} onClick={() => void stageReleaseUpdate()}><Download size={15} /></button>
          </div>
        </section>

        <section>
          <h2><Wrench size={16} /> Tools</h2>
          <div className="tool-list">
            {tools.slice(0, 80).map((tool) => (
              <div className="tool-chip" key={tool.name}>
                <strong>{tool.name}</strong>
                <span>{preview(tool.description || "", 96)}</span>
              </div>
            ))}
            {!tools.length && <div className="empty">Connect MCP to list tools.</div>}
          </div>
        </section>

        <section>
          <h2><Terminal size={16} /> Timeline</h2>
          <Timeline events={timeline} />
        </section>

        <section className="mini-grid">
          <button title="Git diff" onClick={() => void quickPanel("/api/dashboard/diff", setNotice)}><FolderGit2 size={16} /></button>
          <button title="Read file" onClick={() => void readFilePanel(setNotice)}><FileText size={16} /></button>
          <button title="Security status" onClick={() => setNotice(health?.integrity?.reason || health?.license?.reason || "Security checks ok")}><ShieldCheck size={16} /></button>
        </section>
      </aside>
    </div>
  );
}

function ProviderKeyRow({ id, status, onSave, onDelete }: { id: "openai" | "anthropic"; status?: ProviderStatus; onSave: () => void; onDelete: () => void }) {
  const ready = Boolean(status?.ready || status?.configured);
  const readonly = Boolean(status?.readonly);
  return (
    <div className="key-row">
      <div>
        <strong>{id}</strong>
        <span>{ready ? `${status?.source || "vault"}${readonly ? " / readonly" : ""}` : "not set"}</span>
      </div>
      <button title={`Save ${id} key`} onClick={onSave}><KeyRound size={14} /></button>
      <button title={`Delete ${id} key`} disabled={!ready || readonly} onClick={onDelete}><Square size={14} /></button>
    </div>
  );
}

function providerStatusMap(providers: ProviderStatus[]) {
  const map: Record<string, ProviderStatus> = {};
  for (const provider of providers) {
    const id = provider.id || provider.provider;
    if (id) map[id] = provider;
  }
  return map;
}

function VirtualMessages({ items }: { items: ThreadItem[] }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 132,
    overscan: 8
  });

  useEffect(() => {
    virtualizer.scrollToIndex(Math.max(0, items.length - 1), { align: "end" });
  }, [items.length, virtualizer]);

  return (
    <div ref={parentRef} className="message-viewport">
      <div className="message-sizer" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          return (
            <article
              className={`message ${item.role || item.type || "system"}`}
              data-index={row.index}
              key={itemKey(item, row.index)}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <div className="message-meta">
                <strong>{item.type === "tool" ? String(item.metadata?.tool || "tool") : item.role || "message"}</strong>
                <span>{formatAge(item.created_at)}</span>
              </div>
              <pre>{item.content || ""}</pre>
            </article>
          );
        })}
      </div>
      {!items.length && <div className="welcome">Start a thread or open an existing one.</div>}
    </div>
  );
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="timeline-list">
      {events.slice(0, 120).map((event, index) => (
        <div className={event.isError ? "timeline-event error" : "timeline-event"} key={`${event.tool}-${index}`}>
          <div>
            <strong>{event.tool || "tool"}</strong>
            <span>{event.ms || 0}ms</span>
          </div>
          <pre>{preview(JSON.stringify(event.args || {}, null, 2), 300)}</pre>
        </div>
      ))}
      {!events.length && <div className="empty">No tool calls yet.</div>}
    </div>
  );
}

async function quickPanel(path: string, setNotice: (value: string) => void) {
  try {
    const data = await api<Record<string, unknown>>(path);
    setNotice(preview(JSON.stringify(data), 180));
  } catch (error) {
    setNotice(error instanceof Error ? error.message : String(error));
  }
}

async function readFilePanel(setNotice: (value: string) => void) {
  const path = window.prompt("Workspace-relative file path", "README.md");
  if (!path) return;
  await quickPanel(`/api/dashboard/file?path=${encodeURIComponent(path)}`, setNotice);
}
