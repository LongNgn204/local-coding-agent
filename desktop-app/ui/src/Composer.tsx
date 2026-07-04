import { useState } from "react";
import { ROLES } from "./roles";

interface Props {
  engine: "codex_cli" | "script_runner";
  disabled: boolean;
  onRun: (args: { role: string; task: string; title?: string }) => Promise<void>;
}

export function Composer({ engine, disabled, onRun }: Props) {
  const [role, setRole] = useState(ROLES[1].id); // bug_fix by default
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!task.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await onRun({ role, task: task.trim(), title: title.trim() || undefined });
      setTask("");
      setTitle("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>New task</h2>
      {err && <div className="banner">{err}</div>}
      <div className="composer-grid">
        <div className="field" style={{ minWidth: 160 }}>
          <label>Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value)} disabled={disabled || busy}>
            {ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label>Title (optional)</label>
          <input
            type="text"
            value={title}
            placeholder="Short title"
            onChange={(e) => setTitle(e.target.value)}
            disabled={disabled || busy}
          />
        </div>
      </div>
      <textarea
        className="task-input"
        value={task}
        placeholder="Describe the coding task. It runs locally through the selected engine."
        onChange={(e) => setTask(e.target.value)}
        disabled={disabled || busy}
      />
      <div className="composer-actions">
        <button className="btn primary" onClick={run} disabled={disabled || busy || !task.trim()}>
          {busy ? "Starting…" : `Run with ${engine}`}
        </button>
        <span className="hint">
          Engine: <strong>{engine}</strong>
          {engine === "codex_cli" ? " — runs the local, ChatGPT-authenticated Codex CLI." : " — local deterministic planner (no quota)."}
        </span>
      </div>
    </div>
  );
}
