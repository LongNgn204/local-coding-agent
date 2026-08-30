export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";
export type PresentationTone = "ok" | "warn" | "error" | "neutral";

export interface SetupConfigShape {
  node?: string;
  mcpAppDir?: string;
  workspace?: string;
  mode?: string;
  policy?: string;
  port?: number;
  dashboardPort?: number;
}

export interface StatusPresentation {
  label: string;
  detail: string;
  tone: PresentationTone;
}

export function getSetupIssues(config: SetupConfigShape): string[];
export function isSetupComplete(config: SetupConfigShape): boolean;
export function normalizeTheme(value: unknown): ThemePreference;
export function effectiveTheme(preference: unknown, prefersDark: boolean): EffectiveTheme;
export function serverPresentation(server: Record<string, unknown>): StatusPresentation;
export function tunnelPresentation(tunnel: Record<string, unknown>): StatusPresentation;
