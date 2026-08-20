export interface AppConfig {
  node: string;
  mcpAppDir: string;
  serverScript: string;
  workspace: string;
  extraRoots: string;
  permissionProfileFile: string;
  permissionProfileName: string;
  mode: "safe" | "full";
  policy: "strict" | "balanced" | "full";
  port: number;
  dashboardPort: number;
  authToken: string;
  tunnelBin: string;
  profile: string;
  profileDir: string;
  tunnelId: string;
  organizationId: string;
  runtimeKeyEnv: string;
  runtimeKey: string;
  tunnelHealthPort: string;
  openWebUi: boolean;
  noTunnel: boolean;
  v5Preview: boolean;
  allowSystemShutdown: boolean;
  allowDangerous: boolean;
}

export interface SecretInfo {
  hasRuntimeKey: boolean;
  hasAuthToken: boolean;
}

export interface MetaInfo {
  configDir: string;
  configPath: string;
  permissionStorePath: string;
  logFile: string;
  repoRoot: string;
}

export interface ServerStatus {
  state: string;
  version: string;
  mode: string;
  policy: string;
  permissionProfile: string;
  workspace: string;
  roots: number;
  pid: number | null;
  v5Enabled: boolean;
}

export interface TunnelStatus {
  state: string;
  reason: string;
  suffix: string;
  mismatch: boolean;
}

export interface Status {
  server: ServerStatus;
  tunnel: TunnelStatus;
  mcpUrl: string;
  dashboardUrl: string;
}

export interface RootEntry {
  label: string;
  path: string;
  preset: string;
  deny?: string[];
}

export interface ProfileEntry {
  version: number;
  name: string;
  description: string;
  working_directory: string;
  roots: RootEntry[];
}

export interface ProfileStore {
  version: number;
  active_profile: string;
  profiles: Record<string, ProfileEntry>;
}

export interface StatusMessage {
  text: string;
  kind: "info" | "ok" | "warn" | "error";
}