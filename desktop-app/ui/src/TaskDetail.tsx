import { useCallback, useEffect, useState } from "react";
import type { TaskDetail as Detail, ArtifactView } from "../env";
import { roleLabel, fmtTime } from "./roles";

const PAGE = 200;

interface Props {
  detail: Detail;
  onCancel: (id: string) => Promise<void>;
}

export function TaskDetail({ detail, onCancel }: Props) {
  const [tab, setTab] = useState<"report" | "log">("report");
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<ArtifactView | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  const id = detail.task_id;
  const isRunning = detail.status === "queued" || detail.status === "running";

  const load = useCallback(
    async (src: "report" | "log", off: number) => {
      setLoading(true);
      setErr(null);
      try {
        const res = await window.studio.getArtifact(id, src, off, PAGE);
        setView(res.view);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setView(null);
      } finally {
        setLoading(false);
      }
    },
    [id]
  );

  // Reset + load when the selected task or tab changes.
  useEffect(() => {
    setOffset(0);
    load(tab, 0);
  }, [id, tab, load, detail.status]);

  function changeTab(next: "report" | "log") {
    if (next === tab) return;
    setTab(next);
    setOffset(0);
  }

  function page(delta: number) {
    const next = Math.max(0, offset + delta * PAGE);
    setOffset(next);
    load(tab, next);
  }

  async function doCancel() {
    setCancelBusy(true);
    try {
      await onCancel(id);
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="detail-head">
        <div>
          <div className="detail-title">{detail.title || roleLabel(detail.role)}</div>
          <div style={{ marginTop: 4 }}>
            <span className={"badge " + detail.status}>{detail.status}</span>
          </div>
        </div>
        {isRunning && (
          <button className="btn danger small" onClick={doCancel} disabled={cancelBusy}>
            {cancelBusy ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>

      {detail.error && <div className="banner">Error: {detail.error}</div>}

      <dl className="kv">
        <dt>Task id</dt>
        <dd>{detail.task_id}</dd>
        <dt>Role</dt>
        <dd>{roleLabel(detail.role)}</dd>
        <dt>Engine</dt>
        <dd>{detail.provider || "script_runner"}</dd>
        <dt>Mode</dt>
        <dd>{detail.mode || "-"}</dd>
        <dt>Created</dt>
        <dd>{fmtTime(detail.created_at)}</dd>
        <dt>Updated</dt>
        <dd>{fmtTime(detail.updated_at)}</dd>
        {detail.workspace_root && (
          <>
            <dt>Workspace</dt>
            <dd>{detail.workspace_root}</dd>
          </>
        )}
      </dl>

      {detail.summary && <div className="summary">{detail.summary}</div>}

      <div className="tabs">
        <button className={"tab" + (tab === "report" ? " active" : "")} onClick={() => changeTab("report")}>
          Report
        </button>
        <button className={"tab" + (tab === "log" ? " active" : "")} onClick={() => changeTab("log")}>
          Log
        </button>
      </div>

      {err && <div className="banner">{err}</div>}

      <pre className="viewer">
        {loading
          ? "Loading…"
          : view && view.exists
            ? view.content || "(empty)"
            : `No ${tab} yet.`}
      </pre>

      {view && view.exists && (
        <div className="pager">
          <button className="btn small" onClick={() => page(-1)} disabled={loading || offset === 0}>
            ◀ Prev
          </button>
          <span>
            lines {view.offset + 1}–{view.offset + view.returned_lines} of {view.total_lines}
          </span>
          <button className="btn small" onClick={() => page(1)} disabled={loading || !view.has_more}>
            Next ▶
          </button>
        </div>
      )}
    </div>
  );
}
