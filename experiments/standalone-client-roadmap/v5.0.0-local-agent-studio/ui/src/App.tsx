import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  ArrowUp,
  Check,
  Download,
  FileCode2,
  FileText,
  Folder,
  FolderGit2,
  GitCompareArrows,
  KeyRound,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  Undo2,
  Wrench,
  X
} from "lucide-react";

type Role = "user" | "assistant" | "system" | "tool";
type ToolPolicy = "read-only" | "workspace" | "full";

type ThreadSummary = {
  id: string;
  title: string;
  provider?: string;
  model?: string;
  updatedAt?: string;
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
  blocked?: boolean;
  policy?: string;
  level?: string;
  ms?: number;
};

type TurnEvent = {
  seq?: number;
  type?: string;
  error?: string;
  reason?: string;
  result?: { text?: string; threadId?: string; turnId?: string };
  event?: TimelineEvent;
  tool?: string;
  context?: { estimatedTokens?: number; keptMessages?: number; summarizedMessages?: number };
  estimatedTokens?: number;
  keptMessages?: number;
  summarizedMessages?: number;
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
  agent_tool_policies?: ToolPolicy[];
  active_turns?: unknown[];
  mcp_endpoint?: string;
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

type ReviewMode = "files" | "diff" | "patch" | "approvals";

type WorkspaceEntry = {
  path: string;
  type: "directory" | "file";
};

type TreePayload = {
  root: string;
  truncated: boolean;
  count: number;
  entries: WorkspaceEntry[];
};

type FilePayload = {
  path: string;
  total_lines: number;
  chars: number;
  truncated: boolean;
  content: string;
};

type DiffPayload = {
  root: string;
  is_git_repo: boolean;
  diff: string;
  empty: boolean;
  error?: string;
};

type ApprovalRecord = {
  id: string;
  action?: string;
  actions?: string[];
  reason?: string;
  status?: string;
  created?: string;
  expires_at?: string;
};

type PatchReviewPayload = {
  id: string;
  diffSha256: string;
  bytes: number;
  status: "ready" | "blocked" | "applying" | "applied" | "failed" | "expired";
  createdAt: string;
  expiresAt: string;
  preview?: { ok?: boolean; files?: Array<Record<string, unknown>> };
  validation?: { ok?: boolean; conflicts?: Array<Record<string, unknown>> };
  result?: Record<string, unknown> | null;
  error?: string | null;
};

type ReviewState = {
  open: boolean;
  mode: ReviewMode;
  busy: boolean;
  error: string;
  filter: string;
  tree: TreePayload | null;
  file: FilePayload | null;
  diff: DiffPayload | null;
  approvals: ApprovalRecord[];
  patchDraft: string;
  patchReview: PatchReviewPayload | null;
  patchResult: string;
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

async function readTurnEvents(turnId: string, after: number, signal: AbortSignal, onEvent: (event: TurnEvent) => void | Promise<void>) {
  const response = await fetch(`/api/turns/${encodeURIComponent(turnId)}/events?after=${after}`, {
    headers: { "x-lca-studio-token": token },
    signal
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || response.statusText);
  }
  if (!response.body) throw new Error("Turn event stream is not readable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      await onEvent(JSON.parse(dataLine.slice(5).trim()) as TurnEvent);
    }
    if (done) break;
  }
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
  const [toolPolicy, setToolPolicy] = useState<ToolPolicy>("read-only");
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [providerKeys, setProviderKeys] = useState<Record<string, ProviderStatus>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [notice, setNotice] = useState("Ready");
  const [review, setReview] = useState<ReviewState>({
    open: false,
    mode: "files",
    busy: false,
    error: "",
    filter: "",
    tree: null,
    file: null,
    diff: null,
    approvals: [],
    patchDraft: "",
    patchReview: null,
    patchResult: ""
  });
  const streamAbortRef = useRef<AbortController | null>(null);

  const features = new Set(health?.features || []);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    if (!review.open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReview((current) => ({ ...current, open: false }));
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [review.open]);

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
      if (healthData.mcp_endpoint) setEndpoint(healthData.mcp_endpoint);
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
          blocked: Boolean(item.metadata?.blocked),
          policy: String(item.metadata?.policy || ""),
          level: String(item.metadata?.level || ""),
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

  async function openReview(mode: ReviewMode) {
    setReview((current) => ({ ...current, open: true, mode, error: "" }));
    await refreshReviewMode(mode);
  }

  async function refreshReviewMode(mode: ReviewMode) {
    if (mode === "files") return loadWorkspaceTree(review.tree?.root || ".");
    if (mode === "diff") return loadWorkspaceDiff(review.file?.path);
    if (mode === "patch") return;
    return loadApprovals();
  }

  async function selectReviewMode(mode: ReviewMode) {
    setReview((current) => ({ ...current, mode, error: "" }));
    await refreshReviewMode(mode);
  }

  async function loadWorkspaceTree(path = ".") {
    setReview((current) => ({ ...current, busy: true, error: "", file: path === current.tree?.root ? current.file : null }));
    try {
      const data = await api<TreePayload>(`/api/dashboard/tree?path=${encodeURIComponent(path)}&depth=3&max=1200`);
      setReview((current) => ({ ...current, busy: false, tree: data }));
    } catch (error) {
      setReview((current) => ({ ...current, busy: false, error: errorMessage(error) }));
    }
  }

  async function loadWorkspaceFile(path: string) {
    setReview((current) => ({ ...current, busy: true, error: "" }));
    try {
      const data = await api<FilePayload>(`/api/dashboard/file?path=${encodeURIComponent(path)}`);
      setReview((current) => ({ ...current, busy: false, file: data }));
    } catch (error) {
      setReview((current) => ({ ...current, busy: false, error: errorMessage(error) }));
    }
  }

  async function loadWorkspaceDiff(path?: string, silent = false) {
    if (!silent) setReview((current) => ({ ...current, busy: true, error: "" }));
    try {
      const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
      const data = await api<DiffPayload>(`/api/dashboard/diff${suffix}`);
      setReview((current) => ({ ...current, busy: silent ? current.busy : false, diff: data }));
    } catch (error) {
      if (!silent) setReview((current) => ({ ...current, busy: false, error: errorMessage(error) }));
    }
  }

  async function loadApprovals() {
    setReview((current) => ({ ...current, busy: true, error: "" }));
    try {
      const data = await api<{ pending: ApprovalRecord[] }>("/api/approvals");
      setReview((current) => ({ ...current, busy: false, approvals: data.pending || [] }));
    } catch (error) {
      setReview((current) => ({ ...current, busy: false, error: errorMessage(error) }));
    }
  }

  async function decideApproval(record: ApprovalRecord, decision: "approve" | "deny") {
    const exactActions = approvalActions(record);
    const verb = decision === "approve" ? "Approve" : "Deny";
    if (!window.confirm(`${verb} these exact actions?\n\n${exactActions.join("\n")}`)) return;
    setReview((current) => ({ ...current, busy: true, error: "" }));
    try {
      await privilegedApi<{ ok: boolean; status: string }>(
        "approval:mutate",
        { id: record.id, decision },
        () => api(`/api/approvals/${encodeURIComponent(record.id)}/${decision}`, {
          method: "POST",
          body: JSON.stringify({ intent: intent("approval:mutate") })
        })
      );
      setNotice(`Approval ${decision}d: ${record.id}`);
      await loadApprovals();
    } catch (error) {
      setReview((current) => ({ ...current, busy: false, error: errorMessage(error) }));
    }
  }

  async function previewPatchDraft() {
    const diff = review.patchDraft;
    if (!diff.trim()) {
      setReview((current) => ({ ...current, error: "Unified diff is required." }));
      return;
    }
    setReview((current) => ({ ...current, busy: true, error: "", patchReview: null, patchResult: "" }));
    try {
      const data = await privilegedApi<{ ok: boolean; review: PatchReviewPayload }>(
        "patch:preview",
        { diff },
        () => api("/api/patches/preview", {
          method: "POST",
          body: JSON.stringify({ diff, intent: intent("patch:preview") })
        })
      );
      setReview((current) => ({ ...current, busy: false, patchReview: data.review }));
      setNotice(`Patch preview ${data.review.status}: ${data.review.diffSha256.slice(0, 12)}`);
    } catch (error) {
      setReview((current) => ({ ...current, busy: false, error: errorMessage(error) }));
    }
  }

  async function applyReviewedPatch() {
    const patchReview = review.patchReview;
    if (!patchReview || patchReview.status !== "ready") return;
    const files = patchReview.preview?.files?.length || 0;
    if (!window.confirm(`Apply reviewed patch ${patchReview.diffSha256.slice(0, 12)} to ${files} file(s)?\n\nA workspace backup batch will be created first.`)) return;
    setReview((current) => ({ ...current, busy: true, error: "" }));
    try {
      const data = await privilegedApi<{ ok: boolean; review: PatchReviewPayload; result: Record<string, unknown> }>(
        "patch:apply",
        { reviewId: patchReview.id },
        () => api(`/api/patches/${encodeURIComponent(patchReview.id)}/apply`, {
          method: "POST",
          body: JSON.stringify({ intent: intent("patch:apply") })
        })
      );
      setReview((current) => ({
        ...current,
        busy: false,
        patchReview: data.review,
        patchResult: JSON.stringify(data.result || {}, null, 2)
      }));
      setNotice(`Patch applied: ${data.review.diffSha256.slice(0, 12)}`);
      await loadWorkspaceDiff(undefined, true);
    } catch (error) {
      setReview((current) => ({ ...current, busy: false, error: errorMessage(error) }));
    }
  }

  async function undoReviewedPatch() {
    if (!window.confirm("Undo the most recent workspace backup batch? This affects files from the last mutating MCP operation.")) return;
    setReview((current) => ({ ...current, busy: true, error: "" }));
    try {
      const data = await privilegedApi<{ ok: boolean; result: Record<string, unknown> }>(
        "patch:undo",
        {},
        () => api("/api/patches/undo", {
          method: "POST",
          body: JSON.stringify({ intent: intent("patch:undo") })
        })
      );
      setReview((current) => ({
        ...current,
        busy: false,
        patchReview: null,
        patchResult: JSON.stringify(data.result || {}, null, 2)
      }));
      setNotice("Last workspace backup batch restored");
      await loadWorkspaceDiff(undefined, true);
    } catch (error) {
      setReview((current) => ({ ...current, busy: false, error: errorMessage(error) }));
    }
  }

  async function sendMessage() {
    const text = message.trim();
    if (!text || busy) return;
    if (toolPolicy === "full" && !window.confirm("Full tool mode can run command-like MCP tools for this turn. Continue?")) return;
    setBusy(true);
    setMessage("");
    const localAssistantId = `local-assistant-${Date.now()}`;
    setItems((current) => [
      ...current,
      { role: "user", type: "message", content: text },
      { id: localAssistantId, role: "assistant", type: "message", content: "Starting turn..." }
    ]);
    try {
      const turnIntent = toolPolicy === "workspace" ? intent("agent-turn:workspace") : toolPolicy === "full" ? intent("agent-turn:full") : undefined;
      const started = await api<{ turnId: string; threadId: string; toolPolicy: ToolPolicy }>("/api/turns", {
        method: "POST",
        body: JSON.stringify({ threadId: activeThreadId, message: text, provider, model, toolPolicy, intent: turnIntent })
      });
      setActiveTurnId(started.turnId);
      setActiveThreadId(started.threadId);
      setNotice(`Turn running / ${started.toolPolicy}`);
      await streamTurn(started.turnId, localAssistantId);
      await refreshThreads();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setItems((current) => current.map((item, index) => index === current.length - 1 ? { ...item, content: `Error: ${msg}` } : item));
      setNotice(msg);
    } finally {
      streamAbortRef.current = null;
      setActiveTurnId(null);
      setBusy(false);
    }
  }

  async function streamTurn(turnId: string, assistantItemId: string) {
    const controller = new AbortController();
    streamAbortRef.current = controller;
    let lastSeq = 0;
    await readTurnEvents(turnId, 0, controller.signal, async (event) => {
      lastSeq = Number(event.seq || lastSeq);
      if (event.type === "context.ready") {
        const tokens = Number(event.estimatedTokens || event.context?.estimatedTokens || 0);
        setNotice(tokens ? `Context ready / ~${tokens.toLocaleString()} tokens` : "Context ready");
      } else if (event.type === "tool.started") {
        setNotice(`Running ${event.tool || "tool"}...`);
      } else if (event.type === "tool.blocked") {
        setNotice(event.reason || "Tool blocked by policy");
      } else if (event.type === "tool.completed") {
        if (event.event) setTimeline((current) => [event.event as TimelineEvent, ...current]);
      } else if (event.type === "turn.completed") {
        const text = event.result?.text || "(no text)";
        setItems((current) => current.map((item) => item.id === assistantItemId ? { ...item, content: text } : item));
        setNotice("Turn complete");
        if (event.result?.threadId) await openThread(event.result.threadId);
      } else if (event.type === "turn.failed") {
        setItems((current) => current.map((item) => item.id === assistantItemId ? { ...item, content: `Error: ${event.error || "Turn failed"}` } : item));
        setNotice(event.error || "Turn failed");
      } else if (event.type === "turn.cancel_requested") {
        setItems((current) => current.map((item) => item.id === assistantItemId ? { ...item, content: "Cancelling..." } : item));
        setNotice(event.reason || "Cancelling...");
      } else if (event.type === "turn.cancelled") {
        setItems((current) => current.map((item) => item.id === assistantItemId ? { ...item, content: `Cancelled: ${event.error || "Turn cancelled"}` } : item));
        setNotice("Turn cancelled");
      }
    });
    if (lastSeq === 0) {
      const snapshot = await api<{ turn?: { status?: string; error?: string }; events?: TurnEvent[] }>(`/api/turns/${encodeURIComponent(turnId)}`);
      const terminal = [...(snapshot.events || [])].reverse().find((event) => event.type?.startsWith("turn."));
      if (terminal?.type === "turn.completed") {
        setItems((current) => current.map((item) => item.id === assistantItemId ? { ...item, content: terminal.result?.text || "(no text)" } : item));
      } else if (snapshot.turn?.status === "failed" || snapshot.turn?.status === "cancelled") {
        setItems((current) => current.map((item) => item.id === assistantItemId ? { ...item, content: `${snapshot.turn?.status}: ${snapshot.turn?.error || ""}` } : item));
      }
    }
  }

  async function cancelTurn() {
    if (!activeTurnId) return;
    setNotice("Cancelling turn...");
    await api(`/api/turns/${encodeURIComponent(activeTurnId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ intent: intent("turn:cancel") })
    });
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
    <>
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
              <small>{thread.provider || "agent"} / {thread.model || "model"} {formatAge(thread.updatedAt)}</small>
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
            <select value={toolPolicy} onChange={(event) => setToolPolicy(event.target.value as ToolPolicy)} aria-label="Tool policy">
              {(health?.agent_tool_policies?.length ? health.agent_tool_policies : ["read-only", "workspace", "full"]).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
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
          {busy ? (
            <button type="button" className="send stop" disabled={!activeTurnId} title="Cancel turn" onClick={() => void cancelTurn()}>
              <Square size={18} />
            </button>
          ) : (
            <button className="send" disabled={!message.trim()} title="Send">
              <Send size={18} />
            </button>
          )}
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
          {features.has("fileViewer") && <button title="Workspace files" onClick={() => void openReview("files")}><FolderGit2 size={16} /></button>}
          {features.has("fileViewer") && <button title="Git diff" onClick={() => void openReview("diff")}><GitCompareArrows size={16} /></button>}
          {features.has("fileViewer") && <button title="Patch review" onClick={() => void openReview("patch")}><FileCode2 size={16} /></button>}
          {features.has("approvals") && <button title="Approvals" onClick={() => void openReview("approvals")}><ListChecks size={16} /></button>}
          <button title="Security status" onClick={() => setNotice(health?.integrity?.reason || health?.license?.reason || "Security checks ok")}><ShieldCheck size={16} /></button>
        </section>
      </aside>
      </div>
      {review.open && (
        <WorkspaceReview
          review={review}
          onClose={() => setReview((current) => ({ ...current, open: false }))}
          onMode={(mode) => void selectReviewMode(mode)}
          onRefresh={() => void refreshReviewMode(review.mode)}
          onFilter={(filter) => setReview((current) => ({ ...current, filter }))}
          onTree={(path) => void loadWorkspaceTree(path)}
          onFile={(path) => void loadWorkspaceFile(path)}
          onDiff={(path) => {
            setReview((current) => ({ ...current, mode: "diff", error: "" }));
            void loadWorkspaceDiff(path);
          }}
          onDecision={(record, decision) => void decideApproval(record, decision)}
          onPatchDraft={(patchDraft) => setReview((current) => ({ ...current, patchDraft, patchReview: null, patchResult: "", error: "" }))}
          onPatchPreview={() => void previewPatchDraft()}
          onPatchApply={() => void applyReviewedPatch()}
          onPatchUndo={() => void undoReviewedPatch()}
        />
      )}
    </>
  );
}

function WorkspaceReview({
  review,
  onClose,
  onMode,
  onRefresh,
  onFilter,
  onTree,
  onFile,
  onDiff,
  onDecision,
  onPatchDraft,
  onPatchPreview,
  onPatchApply,
  onPatchUndo
}: {
  review: ReviewState;
  onClose: () => void;
  onMode: (mode: ReviewMode) => void;
  onRefresh: () => void;
  onFilter: (value: string) => void;
  onTree: (path: string) => void;
  onFile: (path: string) => void;
  onDiff: (path?: string) => void;
  onDecision: (record: ApprovalRecord, decision: "approve" | "deny") => void;
  onPatchDraft: (value: string) => void;
  onPatchPreview: () => void;
  onPatchApply: () => void;
  onPatchUndo: () => void;
}) {
  const filter = normalizeWorkspacePath(review.filter).toLowerCase();
  const entries = (review.tree?.entries || []).filter((entry) => !filter || normalizeWorkspacePath(entry.path).toLowerCase().includes(filter));
  const root = review.tree?.root || ".";
  return (
    <div className="review-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="review-modal" role="dialog" aria-modal="true" aria-label="Workspace review">
        <header className="review-header">
          <div>
            <strong>Workspace Review</strong>
            <span>{review.mode === "files" ? root : review.mode === "diff" ? review.diff?.root || "Git working tree" : review.mode === "patch" ? review.patchReview?.diffSha256 || "Two-phase patch review" : `${review.approvals.length} pending`}</span>
          </div>
          <div className="review-header-actions">
            <button title="Refresh review" onClick={onRefresh}><RefreshCw size={16} /></button>
            <button title="Close review" onClick={onClose}><X size={17} /></button>
          </div>
        </header>

        <nav className="review-tabs" aria-label="Review views">
          <button className={review.mode === "files" ? "active" : ""} onClick={() => onMode("files")}><Folder size={15} /> Files</button>
          <button className={review.mode === "diff" ? "active" : ""} onClick={() => onMode("diff")}><GitCompareArrows size={15} /> Diff</button>
          <button className={review.mode === "patch" ? "active" : ""} onClick={() => onMode("patch")}><FileCode2 size={15} /> Patch</button>
          <button className={review.mode === "approvals" ? "active" : ""} onClick={() => onMode("approvals")}><ListChecks size={15} /> Approvals</button>
        </nav>

        <div className="review-status">
          {review.error && <div className="review-error">{review.error}</div>}
          {review.busy && <div className="review-progress">Loading...</div>}
        </div>

        <div className="review-body">
          {review.mode === "files" && (
            <div className="workspace-review-grid">
              <aside className="workspace-tree-pane">
                <div className="tree-toolbar">
                  <button title="Parent folder" disabled={root === "."} onClick={() => onTree(parentWorkspacePath(root))}><ArrowUp size={15} /></button>
                  <label className="tree-search">
                    <Search size={14} />
                    <input value={review.filter} onChange={(event) => onFilter(event.target.value)} aria-label="Filter workspace files" placeholder="Filter" />
                  </label>
                </div>
                <div className="tree-root" title={root}>{root}</div>
                <div className="workspace-tree">
                  {entries.slice(0, 500).map((entry) => (
                    <button
                      className={review.file?.path === entry.path ? "tree-entry active" : "tree-entry"}
                      key={`${entry.type}:${entry.path}`}
                      onClick={() => entry.type === "directory" ? onTree(entry.path) : onFile(entry.path)}
                      style={{ paddingLeft: `${10 + Math.min(5, workspaceDepth(entry.path, root)) * 12}px` }}
                      title={entry.path}
                    >
                      {entry.type === "directory" ? <Folder size={14} /> : <FileText size={14} />}
                      <span>{workspaceName(entry.path)}</span>
                    </button>
                  ))}
                  {!entries.length && <div className="empty">No matching files.</div>}
                  {entries.length > 500 && <div className="empty">Showing the first 500 entries.</div>}
                </div>
              </aside>
              <section className="workspace-preview-pane">
                {review.file ? (
                  <>
                    <header className="preview-header">
                      <div>
                        <strong>{review.file.path}</strong>
                        <span>{review.file.total_lines.toLocaleString()} lines / {review.file.chars.toLocaleString()} chars{review.file.truncated ? " / server truncated" : ""}</span>
                      </div>
                      <button title="Diff this file" onClick={() => onDiff(review.file?.path)}><GitCompareArrows size={15} /></button>
                    </header>
                    <pre className="review-code">{boundedText(review.file.content, 250_000)}</pre>
                  </>
                ) : (
                  <div className="review-empty"><FileCode2 size={24} /><span>No file selected.</span></div>
                )}
              </section>
            </div>
          )}

          {review.mode === "diff" && (
            <section className="diff-pane">
              {review.diff?.error && <div className="review-error">{review.diff.error}</div>}
              {review.diff?.empty ? <div className="review-empty"><Check size={24} /><span>Working tree clean.</span></div> : <DiffView text={review.diff?.diff || ""} />}
            </section>
          )}

          {review.mode === "patch" && (
            <section className="patch-review-pane">
              <div className="patch-draft-pane">
                <header>
                  <strong>Unified Diff</strong>
                  <span>{new TextEncoder().encode(review.patchDraft).length.toLocaleString()} / 500,000 bytes</span>
                </header>
                <textarea
                  aria-label="Unified diff draft"
                  maxLength={500_000}
                  placeholder={"--- a/path/to/file\n+++ b/path/to/file\n@@ ..."}
                  spellCheck={false}
                  value={review.patchDraft}
                  onChange={(event) => onPatchDraft(event.target.value)}
                />
                <div className="patch-actions">
                  <button title="Preview and validate patch" disabled={review.busy || !review.patchDraft.trim()} onClick={onPatchPreview}><ShieldCheck size={15} /> Preview</button>
                  <button className="apply" title="Apply reviewed patch" disabled={review.busy || review.patchReview?.status !== "ready"} onClick={onPatchApply}><Check size={15} /> Apply</button>
                  <button className="undo" title="Undo last workspace backup batch" disabled={review.busy} onClick={onPatchUndo}><Undo2 size={15} /> Undo Last</button>
                </div>
              </div>
              <div className="patch-result-pane">
                {review.patchReview ? (
                  <>
                    <header className={`patch-status ${review.patchReview.status}`}>
                      <div>
                        <strong>{review.patchReview.status}</strong>
                        <span>{review.patchReview.diffSha256} / expires {formatDeadline(review.patchReview.expiresAt)}</span>
                      </div>
                      <span>{review.patchReview.bytes.toLocaleString()} bytes / {review.patchReview.preview?.files?.length || 0} files</span>
                    </header>
                    <pre className="patch-report">{boundedText(JSON.stringify({
                      preview: review.patchReview.preview,
                      validation: review.patchReview.validation,
                      result: review.patchReview.result,
                      error: review.patchReview.error
                    }, null, 2), 120_000)}</pre>
                  </>
                ) : review.patchResult ? (
                  <pre className="patch-report">{boundedText(review.patchResult, 120_000)}</pre>
                ) : (
                  <div className="review-empty"><ShieldCheck size={24} /><span>No reviewed patch.</span></div>
                )}
              </div>
            </section>
          )}

          {review.mode === "approvals" && (
            <section className="approval-list">
              {review.approvals.map((record) => (
                <article className="approval-item" key={record.id}>
                  <header>
                    <strong>{record.action || `${approvalActions(record).length} exact actions`}</strong>
                    <span>expires {formatDeadline(record.expires_at)}</span>
                  </header>
                  {record.reason && <p>{record.reason}</p>}
                  <pre>{approvalActions(record).join("\n")}</pre>
                  <div className="approval-actions">
                    <button className="approve" title="Approve exact actions" onClick={() => onDecision(record, "approve")}><Check size={15} /> Approve</button>
                    <button className="deny" title="Deny exact actions" onClick={() => onDecision(record, "deny")}><X size={15} /> Deny</button>
                  </div>
                </article>
              ))}
              {!review.approvals.length && <div className="review-empty"><ShieldCheck size={24} /><span>No pending approvals.</span></div>}
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

function DiffView({ text }: { text: string }) {
  const bounded = boundedText(text, 300_000);
  return (
    <pre className="review-code diff-code">
      {bounded.split("\n").map((line, index) => (
        <span className={diffLineClass(line)} key={`${index}:${line.slice(0, 40)}`}>{line || " "}{"\n"}</span>
      ))}
    </pre>
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
                <span>{item.type === "tool" ? toolItemLabel(item) : formatAge(item.created_at)}</span>
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
            <span>{timelineLabel(event)}</span>
          </div>
          <pre>{preview(JSON.stringify(event.args || {}, null, 2), 300)}</pre>
          {(event.result || event.blocked) && <pre>{preview(event.result || "Blocked by policy", 700)}</pre>}
        </div>
      ))}
      {!events.length && <div className="empty">No tool calls yet.</div>}
    </div>
  );
}

function toolItemLabel(item: ThreadItem) {
  const parts = [
    item.metadata?.blocked ? "blocked" : item.metadata?.isError ? "error" : "ok",
    item.metadata?.policy ? String(item.metadata.policy) : "",
    item.metadata?.level ? String(item.metadata.level) : "",
    item.metadata?.ms != null ? `${Number(item.metadata.ms || 0)}ms` : "",
    formatAge(item.created_at)
  ].filter(Boolean);
  return parts.join(" / ");
}

function timelineLabel(event: TimelineEvent) {
  return [
    event.blocked ? "blocked" : event.isError ? "error" : "ok",
    event.policy || "",
    event.level || "",
    `${event.ms || 0}ms`
  ].filter(Boolean).join(" / ");
}

function approvalActions(record: ApprovalRecord) {
  if (Array.isArray(record.actions) && record.actions.length) return record.actions.map(String);
  return record.action ? [String(record.action)] : ["Unknown action"];
}

function parentWorkspacePath(value: string) {
  const normalized = String(value || ".").replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return ".";
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

function normalizeWorkspacePath(value: string) {
  return String(value || "").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

function workspaceName(value: string) {
  const parts = String(value || "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || ".";
}

function workspaceDepth(value: string, root: string) {
  const pathParts = String(value || "").split(/[\\/]/).filter(Boolean);
  const rootParts = root === "." ? [] : String(root || "").split(/[\\/]/).filter(Boolean);
  return Math.max(0, pathParts.length - rootParts.length - 1);
}

function boundedText(value: string, limit: number) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[UI PREVIEW TRUNCATED ${text.length - limit} CHARS]`;
}

function diffLineClass(line: string) {
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "diff-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "diff-remove";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  return "";
}

function formatDeadline(value?: string) {
  if (!value) return "unknown";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "unknown";
  const seconds = Math.round((time - Date.now()) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `in ${minutes}m` : `in ${Math.round(minutes / 60)}h`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
