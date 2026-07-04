import { useCallback, useEffect, useState } from "react";
import type { AppConfig, HealthInfo, TaskRow, TaskDetail as Detail } from "../env";
import { TaskList } from "./TaskList";
import { Composer } from "./Composer";
import { TaskDetail } from "./TaskDetail";

const REFRESH_MS = 3000;

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [health, setHealth] = useState<HealthInfo>({ ok: false, reason: "not_started" });
  const [starting, setStarting] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [lastLog, setLastLog] = useState<string>("");

  const engine = config?.engine || "codex_cli";
  const running = health.ok;

  // Load config + attempt auto-start on mount.
  useEffect(() => {
    (async () => {
      const cfg = await window.studio.getConfig();
      setConfig(cfg);
      if (cfg.workspace) {
        await startServer(cfg);
      }
    })();
    const unsub = window.studio.onServerLog((line) => setLastLog(line));
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startServer = useCallback(async (cfg?: AppConfig) => {
    setStarting(true);
    setBanner(null);
    try {
      const h = await window.studio.start({
        workspace: cfg?.workspace,
        mode: cfg?.mode
      });
      setHealth(h);
      if (!h.ok) setBanner(`Server failed to start: ${h.reason || "unknown"}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
      setHealth({ ok: false, reason: "error" });
    } finally {
      setStarting(false);
    }
  }, []);

  // Poll task list + health while running.
  const refresh = useCallback(async () => {
    if (!running) return;
    try {
      const list = await window.studio.listTasks({ status: filter, limit: 100 });
      setTasks(list.tasks || []);
    } catch {
      /* transient */
    }
  }, [running, filter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Poll health separately (cheaper) so the pill stays live.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const h = await window.studio.health();
        setHealth(h);
      } catch {
        /* ignore */
      }
    }, REFRESH_MS * 2);
    return () => clearInterval(t);
  }, []);

  // Load detail for the selected task and keep it fresh.
  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await window.studio.getTask(id);
      setDetail(d);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId);
    const t = setInterval(() => loadDetail(selectedId), REFRESH_MS);
    return () => clearInterval(t);
  }, [selectedId, loadDetail]);

  async function pickWorkspace() {
    const ws = await window.studio.pickWorkspace();
    if (ws && config) {
      const next = { ...config, workspace: ws };
      setConfig(next);
      await startServer(next);
    }
  }

  async function changeMode(mode: "safe" | "full") {
    if (!config) return;
    const next = { ...config, mode };
    await window.studio.setConfig({ mode });
    setConfig(next);
    if (running) await startServer(next);
  }

  async function changeEngine(eng: "codex_cli" | "script_runner") {
    if (!config) return;
    await window.studio.setConfig({ engine: eng });
    setConfig({ ...config, engine: eng });
  }

  async function runTask(args: { role: string; task: string; title?: string }) {
    const res = await window.studio.createTask({ ...args, engine });
    await refresh();
    if (res.task_id) setSelectedId(res.task_id);
  }

  async function cancelTask(id: string) {
    await window.studio.cancelTask(id);
    await refresh();
    await loadDetail(id);
  }

  const pill = starting ? (
    <span className="pill busy">
      <span className="led" /> starting…
    </span>
  ) : running ? (
    <span className="pill ok">
      <span className="led" /> server up
      {health.preview_version ? ` · v${health.preview_version}` : ""}
    </span>
  ) : (
    <span className="pill down">
      <span className="led" /> server down
    </span>
  );

  const wsPath = config?.workspace || "(no workspace)";

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          Local Codex <span className="dot">Studio</span>
        </div>
        <div className="ws" title={wsPath}>
          <code>{wsPath}</code>
        </div>
        <button className="btn small" onClick={pickWorkspace}>
          Change
        </button>

        <div className="field">
          <label>Engine</label>
          <select value={engine} onChange={(e) => changeEngine(e.target.value as "codex_cli" | "script_runner")}>
            <option value="codex_cli">codex_cli</option>
            <option value="script_runner">script_runner</option>
          </select>
        </div>
        <div className="field">
          <label>Mode</label>
          <select value={config?.mode || "safe"} onChange={(e) => changeMode(e.target.value as "safe" | "full")}>
            <option value="safe">safe</option>
            <option value="full">full</option>
          </select>
        </div>

        <div className="spacer" />
        {pill}
        {!running && !starting && (
          <button className="btn primary small" onClick={() => startServer(config || undefined)}>
            Start
          </button>
        )}
        <button className="btn small" onClick={() => window.studio.openDashboard()} disabled={!running}>
          Open dashboard
        </button>
      </div>

      <div className="body">
        <TaskList
          tasks={tasks}
          filter={filter}
          selectedId={selectedId}
          onFilter={setFilter}
          onSelect={setSelectedId}
        />

        <div className="main">
          {banner && <div className="banner">{banner}</div>}
          {!running && !starting && (
            <div className="banner info">
              Server is not running. Pick a workspace and click Start to launch the local MCP server.
            </div>
          )}

          <Composer engine={engine} disabled={!running} onRun={runTask} />

          {detail ? (
            <TaskDetail detail={detail} onCancel={cancelTask} />
          ) : (
            <div className="card">
              <div className="empty">Select a task to see its report and log, or run a new one above.</div>
            </div>
          )}
        </div>
      </div>

      {lastLog && <div className="log-strip" title={lastLog}>{lastLog}</div>}
    </div>
  );
}
