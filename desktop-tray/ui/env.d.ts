/// <reference types="vite/client" />

interface Window {
  lcat: {
    getConfig(): Promise<{ config: Record<string, unknown>; secrets: { hasRuntimeKey: boolean; hasAuthToken: boolean }; meta: Record<string, string> }>;
    setConfig(patch: object): Promise<Record<string, unknown>>;
    saveSecret(name: string, value: string): Promise<{ ok: boolean }>;
    clearSecret(name: string): Promise<{ ok: boolean }>;
    pickDir(title: string): Promise<string | null>;
    pickFile(title: string): Promise<string | null>;
    start(opts?: { tunnel?: boolean }): Promise<{ ok: boolean; message: string }>;
    stop(): Promise<{ ok: boolean; message: string }>;
    reconnectTunnel(): Promise<{ ok: boolean; message: string }>;
    getStatus(): Promise<Record<string, unknown>>;
    openDashboard(): Promise<string | null>;
    copyMcpUrl(): Promise<string>;
    copyTunnelId(): Promise<string>;
    getLogs(): Promise<{ lines: string[]; configDir: string; logFile: string }>;
    copyLogs(): Promise<void>;
    openLogFolder(): Promise<void>;
    openConfigFolder(): Promise<void>;
    getProfiles(): Promise<{ file: string; store: Record<string, unknown> }>;
    saveProfiles(store: object): Promise<{ file: string; store: Record<string, unknown> }>;
    onStatus(cb: (status: Record<string, unknown>) => void): () => void;
    onLog(cb: (line: string) => void): () => void;
    onOpenModal(cb: (name: string) => void): () => void;
  };
}