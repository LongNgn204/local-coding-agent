import { useEffect, useState } from "react";
import type { MetaInfo } from "./types";

interface Props {
  lines: string[];
  meta: MetaInfo | null;
  onClose: () => void;
}

export function LogsModal({ lines, meta, onClose }: Props) {
  const [allLines, setAllLines] = useState<string[]>(lines);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      const { lines: l } = await window.lcat.getLogs();
      setAllLines(l);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setAllLines((prev) => {
      const next = [...prev, ...lines.slice(prev.length)];
      return next.length > 600 ? next.slice(next.length - 600) : next;
    });
  }, [lines]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Logs / Config</h3>
          <button type="button" className="mini close" onClick={onClose} title="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="config-paths">
            <div>
              <span className="field-label">Config location</span>
              <code>{meta ? meta.configPath : ""}</code>
            </div>
            <div>
              <span className="field-label">Profile location</span>
              <code>{meta ? meta.permissionStorePath : ""}</code>
            </div>
            <div>
              <span className="field-label">Log file</span>
              <code>{meta ? meta.logFile : ""}</code>
            </div>
          </div>
          <pre className="log-view">{allLines.join("\n") || "(no log output yet)"}</pre>
        </div>

        <footer className="modal-footer">
          <button type="button" onClick={refresh} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" onClick={() => window.lcat.copyLogs()}>
            Copy logs
          </button>
          <button type="button" onClick={() => window.lcat.openLogFolder()}>
            Open log folder
          </button>
          <button type="button" onClick={() => window.lcat.openConfigFolder()}>
            Open config folder
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}