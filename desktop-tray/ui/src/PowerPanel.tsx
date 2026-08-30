import type { AppConfig, Status, StatusMessage } from "./types";
import { serverPresentation, tunnelPresentation } from "./view-model.mjs";

interface Props {
  config: AppConfig;
  status: Status;
  message: StatusMessage;
  busy: string;
  serverCanStop: boolean;
  onStart: () => void;
  onStop: () => void;
  onReconnect: () => void;
  onDashboard: () => void;
  onCopyMcp: () => void;
  onCopyTunnel: () => void;
  onManagePaths: () => void;
  onLogs: () => void;
}

export function PowerPanel({ config, status, message, busy, serverCanStop, onStart, onStop, onReconnect, onDashboard, onCopyMcp, onCopyTunnel, onManagePaths, onLogs }: Props) {
  const server = serverPresentation(status.server as unknown as Record<string, unknown>);
  const tunnel = tunnelPresentation(status.tunnel as unknown as Record<string, unknown>);
  const busyAny = busy !== "";
  const online = status.server.state === "online";

  return (
    <div className="power-panel">
      <section className="hero-panel">
        <div>
          <span className="eyebrow">Local control plane</span>
          <h2>{online ? "Agent ready" : "Agent is not running"}</h2>
          <p>{online ? "Your workspace is available through the local MCP server." : "Review the workspace boundary, then start when you are ready."}</p>
        </div>
        <div className="hero-actions">
          {online || serverCanStop ? (
            <button type="button" className="button danger-outline large" disabled={busyAny} onClick={onStop}>{busy === "stop" ? "Stopping…" : "Stop agent"}</button>
          ) : (
            <button type="button" className="button primary large" disabled={busyAny} onClick={onStart}>{busy === "start" ? "Starting…" : "Start agent"}</button>
          )}
          <button type="button" className="button secondary large" onClick={onDashboard}>Open dashboard</button>
        </div>
      </section>

      {message.text && <div className={`message-banner ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</div>}

      <div className="status-grid">
        <article className={`status-card tone-${server.tone}`}>
          <div className="status-card-heading"><span className="status-icon" aria-hidden="true">{server.tone === "ok" ? "✓" : server.tone === "error" ? "!" : "●"}</span><span>MCP server</span></div>
          <strong>{server.label}</strong>
          <p>{server.detail}</p>
          <div className="card-actions"><button type="button" className="text-action" onClick={onCopyMcp}>Copy MCP URL</button><button type="button" className="text-action" onClick={onLogs}>Inspect logs</button></div>
        </article>

        <article className={`status-card tone-${tunnel.tone}`}>
          <div className="status-card-heading"><span className="status-icon" aria-hidden="true">{tunnel.tone === "ok" ? "✓" : tunnel.tone === "error" ? "!" : "●"}</span><span>Secure tunnel</span></div>
          <strong>{tunnel.label}</strong>
          <p>{tunnel.detail}{status.tunnel.mismatch ? " Tunnel ID does not match the active connector." : ""}</p>
          <div className="card-actions"><button type="button" className="text-action" disabled={busyAny || config.noTunnel} onClick={onReconnect}>{busy === "reconnect" ? "Reconnecting…" : "Reconnect"}</button><button type="button" className="text-action" onClick={onCopyTunnel}>Copy Tunnel ID</button></div>
        </article>
      </div>

      <div className="summary-grid">
        <article className="summary-card">
          <span className="summary-label">Workspace</span>
          <strong>{status.server.permissionProfile || config.permissionProfileName || "Legacy workspace"}</strong>
          <p title={status.server.workspace || config.workspace}>{status.server.workspace || config.workspace || "Not configured"}</p>
          <button type="button" className="text-action" onClick={onManagePaths}>Manage authorized paths</button>
        </article>
        <article className="summary-card">
          <span className="summary-label">Protection</span>
          <strong>{config.mode} · {config.policy}</strong>
          <p>{config.mode === "safe" && config.policy === "balanced" ? "Recommended daily protection is active." : "Review protection before using an untrusted workspace."}</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">Endpoints</span>
          <strong>127.0.0.1 only</strong>
          <p>MCP {config.port} · Dashboard {config.dashboardPort}</p>
          <button type="button" className="text-action" onClick={onDashboard}>Open dashboard</button>
        </article>
      </div>
    </div>
  );
}
