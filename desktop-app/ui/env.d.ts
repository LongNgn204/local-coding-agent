/// <reference types="vite/client" />

// Shapes mirror what the server's tools / dashboard endpoints return.
export interface HealthInfo {
  ok: boolean;
  reason?: string;
  status?: string | null;
  version?: string | null;
  preview_version?: string | null;
  preview_enabled?: boolean;
  mode?: string;
  workspace?: string;
  roots?: string[];
  pid?: number | null;
  port?: number | null;
  dashboard_port?: number | null;
  mcp_endpoint?: string;
}

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TaskRow {
  agent_id: string;
  role: string;
  title?: string;
  status: TaskStatus;
  provider?: string;
  created_at: string;
  updated_at?: string;
  summary?: string;
}

export interface TaskList {
  count: number;
  tasks: TaskRow[];
  dashboard_url?: string | null;
}

export interface TaskDetail {
  task_id: string;
  role: string;
  title?: string;
  status: TaskStatus;
  provider?: string;
  created_at?: string;
  updated_at?: string;
  workspace_root?: string;
  mode?: string;
  policy?: string;
  summary?: string;
  has_report?: boolean;
  has_log?: boolean;
  error?: string | null;
}

export interface ArtifactView {
  kind: "report" | "log";
  exists: boolean;
  path: string | null;
  total_lines: number;
  offset: number;
  returned_lines: number;
  has_more: boolean;
  content: string;
}

export interface ArtifactResponse {
  agent_id: string;
  role: string;
  title?: string;
  status: TaskStatus;
  report_path?: string | null;
  log_path?: string | null;
  view: ArtifactView;
}

export interface AppConfig {
  workspace: string;
  mode: "safe" | "full";
  engine: "codex_cli" | "script_runner";
}

export interface CreateTaskArgs {
  role: string;
  task: string;
  engine?: "codex_cli" | "script_runner";
  title?: string;
}

export interface StudioApi {
  pickWorkspace(): Promise<string | null>;
  getConfig(): Promise<AppConfig>;
  setConfig(cfg: Partial<AppConfig>): Promise<AppConfig>;
  start(opts?: { workspace?: string; mode?: string }): Promise<HealthInfo>;
  stop(): Promise<{ ok: boolean }>;
  health(): Promise<HealthInfo>;
  createTask(args: CreateTaskArgs): Promise<{ task_id: string; role: string; status: string; message?: string }>;
  listTasks(args?: { status?: string; limit?: number }): Promise<TaskList>;
  getTask(id: string): Promise<TaskDetail>;
  getArtifact(id: string, source: "report" | "log", offset: number, limit: number): Promise<ArtifactResponse>;
  cancelTask(id: string): Promise<{ task_id: string; status: string; message?: string }>;
  openDashboard(): Promise<string | null>;
  getServerLog(): Promise<string[]>;
  onServerLog(cb: (line: string) => void): () => void;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}
