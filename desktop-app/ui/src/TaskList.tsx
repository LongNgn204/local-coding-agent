import type { TaskRow } from "../env";
import { STATUS_FILTERS, roleLabel, fmtTime } from "./roles";

interface Props {
  tasks: TaskRow[];
  filter: string;
  selectedId: string | null;
  onFilter: (f: string) => void;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, filter, selectedId, onFilter, onSelect }: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <div style={{ fontWeight: 600 }}>Tasks</div>
        <div className="filters">
          {STATUS_FILTERS.map((f) => (
            <button key={f} className={"chip" + (filter === f ? " active" : "")} onClick={() => onFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="task-list">
        {tasks.length === 0 && <div className="empty">No tasks{filter !== "all" ? ` (${filter})` : ""} yet.</div>}
        {tasks.map((t) => (
          <div
            key={t.agent_id}
            className={"task-item" + (t.agent_id === selectedId ? " selected" : "")}
            onClick={() => onSelect(t.agent_id)}
          >
            <div className="row1">
              <span className="title">{t.title || roleLabel(t.role)}</span>
              <span className={"badge " + t.status}>{t.status}</span>
            </div>
            <div className="row2">
              <span className="tag">{roleLabel(t.role)}</span>
              <span className="tag">{t.provider || "script_runner"}</span>
              <span>{fmtTime(t.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
