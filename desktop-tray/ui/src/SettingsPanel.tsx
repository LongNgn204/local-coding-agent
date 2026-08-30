import type { AppConfig, SecretInfo } from "./types";
import { Check, Field, NumberField, Section, SelectField } from "./Controls";

export type SettingsView = "workspace" | "connection" | "security" | "advanced";

const MODES = ["safe", "full"] as const;
const POLICIES = ["strict", "balanced", "full"] as const;

interface Props {
  view: SettingsView;
  config: AppConfig;
  secrets: SecretInfo;
  errors: Record<string, string>;
  runtimeKeyInput: string;
  authTokenInput: string;
  showRuntimeKey: boolean;
  showAuthToken: boolean;
  onPatch: (patch: Partial<AppConfig>) => void;
  onRuntimeKeyInput: (value: string) => void;
  onAuthTokenInput: (value: string) => void;
  onToggleRuntimeKey: () => void;
  onToggleAuthToken: () => void;
  onBrowseDir: (key: keyof AppConfig) => void;
  onBrowseFile: (key: keyof AppConfig) => void;
  onManagePaths: () => void;
  onSaveSettings: () => void;
  onSaveTunnel: () => void;
  onSaveRuntimeKey: () => void;
  onSaveAuthToken: () => void;
  onRunSetup: () => void;
}

export function SettingsPanel(props: Props) {
  const { view, config, errors, secrets, onPatch } = props;

  if (view === "workspace") {
    return (
      <div className="settings-page">
        <Section title="Workspace boundary" description="Choose only folders you trust the agent to read and change.">
          <Field label="Primary workspace" value={config.workspace} onChange={(workspace) => onPatch({ workspace })} browse={() => props.onBrowseDir("workspace")} invalid={Boolean(errors.workspace)} error={errors.workspace} />
          <button type="button" className="button secondary align-start" onClick={props.onManagePaths}>Manage authorized paths</button>
          <div className="form-grid two-column">
            <SelectField label="Mode" value={config.mode} options={MODES} onChange={(mode) => onPatch({ mode: mode as AppConfig["mode"] })} invalid={Boolean(errors.mode)} error={errors.mode} hint="Safe is recommended." />
            <SelectField label="Policy" value={config.policy} options={POLICIES} onChange={(policy) => onPatch({ policy: policy as AppConfig["policy"] })} invalid={Boolean(errors.policy)} error={errors.policy} hint="Balanced is recommended." />
          </div>
          <Field label="Legacy extra roots" value={config.extraRoots} onChange={(extraRoots) => onPatch({ extraRoots })} placeholder="D:\\Projects;D:\\OCR" hint="Prefer named profiles for new configurations." />
        </Section>
        <SettingsActions onSave={props.onSaveSettings} />
      </div>
    );
  }

  if (view === "connection") {
    return (
      <div className="settings-page">
        <Section title="Local endpoints" description="The server stays bound to this PC.">
          <div className="form-grid two-column">
            <NumberField label="MCP port" value={config.port} onChange={(port) => onPatch({ port })} invalid={Boolean(errors.port)} error={errors.port} />
            <NumberField label="Dashboard port" value={config.dashboardPort} onChange={(dashboardPort) => onPatch({ dashboardPort })} invalid={Boolean(errors.dashboardPort)} error={errors.dashboardPort} />
          </div>
          <Check label="Local only — do not start a tunnel" checked={config.noTunnel} onChange={(noTunnel) => onPatch({ noTunnel })} />
        </Section>
        <Section title="Secure tunnel" description="Optional. The proprietary client remains user supplied and is never bundled.">
          <Field label="tunnel-client" value={config.tunnelBin} onChange={(tunnelBin) => onPatch({ tunnelBin })} browse={() => props.onBrowseFile("tunnelBin")} invalid={Boolean(errors.tunnelBin)} error={errors.tunnelBin} />
          <div className="form-grid two-column">
            <Field label="Tunnel ID" value={config.tunnelId} onChange={(tunnelId) => onPatch({ tunnelId })} invalid={Boolean(errors.tunnelId)} error={errors.tunnelId} placeholder="tunnel_..." />
            <Field label="Organization ID" value={config.organizationId} onChange={(organizationId) => onPatch({ organizationId })} invalid={Boolean(errors.organizationId)} error={errors.organizationId} placeholder="org_..." />
          </div>
          <div className="inline-actions">
            <Field label="Runtime API key" value={props.runtimeKeyInput} onChange={props.onRuntimeKeyInput} type={props.showRuntimeKey ? "text" : "password"} showToggle onShowToggle={props.onToggleRuntimeKey} placeholder={secrets.hasRuntimeKey ? "•••••••• (saved)" : "sk-..."} />
            <button type="button" className="button secondary" disabled={!props.runtimeKeyInput.trim()} onClick={props.onSaveRuntimeKey}>Save encrypted key</button>
          </div>
          <div className="inline-actions"><button type="button" className="button secondary" onClick={props.onSaveTunnel}>Save tunnel</button><span className="field-hint">{secrets.hasRuntimeKey ? "Encrypted runtime key is saved." : "No runtime key saved."}</span></div>
          <Check label="Open tunnel web UI on start" checked={config.openWebUi} onChange={(openWebUi) => onPatch({ openWebUi })} />
        </Section>
        <SettingsActions onSave={props.onSaveSettings} />
      </div>
    );
  }

  if (view === "security") {
    return (
      <div className="settings-page">
        <Section title="Local API protection" description="Optional bearer authentication for local MCP requests.">
          <div className="inline-actions">
            <Field label="Auth token" value={props.authTokenInput} onChange={props.onAuthTokenInput} type={props.showAuthToken ? "text" : "password"} showToggle onShowToggle={props.onToggleAuthToken} placeholder={secrets.hasAuthToken ? "•••••••• (saved)" : "Optional"} />
            <button type="button" className="button secondary" onClick={props.onSaveAuthToken}>{props.authTokenInput.trim() ? "Save encrypted token" : "Clear token"}</button>
          </div>
        </Section>
        <Section title="Danger zone" description="These options expand system impact. Leave them off unless the workspace and prompt are fully trusted." className="danger-zone">
          <Check label="Allow prompt-requested shutdown (immediate, no approval)" checked={config.allowSystemShutdown} onChange={(allowSystemShutdown) => onPatch({ allowSystemShutdown })} danger hint="An explicit shutdown prompt can power off this PC through the dedicated tool." />
          <Check label="Allow dangerous system commands (AGENT_ALLOW_DANGEROUS)" checked={config.allowDangerous} onChange={(allowDangerous) => onPatch({ allowDangerous })} danger hint="Removes the catastrophic-command blocklist. The agent can run any command it constructs." />
        </Section>
        <SettingsActions onSave={props.onSaveSettings} />
      </div>
    );
  }

  return (
    <div className="settings-page">
      <Section title="Runtime" description="Packaged releases auto-fill these paths. Change them only for development or recovery.">
        <Field label="Node executable" value={config.node} onChange={(node) => onPatch({ node })} invalid={Boolean(errors.node)} error={errors.node} placeholder="node" />
        <Field label="MCP app folder" value={config.mcpAppDir} onChange={(mcpAppDir) => onPatch({ mcpAppDir })} browse={() => props.onBrowseDir("mcpAppDir")} invalid={Boolean(errors.mcpAppDir)} error={errors.mcpAppDir} />
        <Field label="Server script" value={config.serverScript} onChange={(serverScript) => onPatch({ serverScript })} />
      </Section>
      <Section title="Profiles and compatibility">
        <Field label="Permission profile store" value={config.permissionProfileFile} onChange={(permissionProfileFile) => onPatch({ permissionProfileFile })} browse={() => props.onBrowseFile("permissionProfileFile")} />
        <Field label="Active profile" value={config.permissionProfileName} onChange={(permissionProfileName) => onPatch({ permissionProfileName })} />
        <div className="form-grid two-column">
          <Field label="Tunnel profile directory" value={config.profileDir} onChange={(profileDir) => onPatch({ profileDir })} browse={() => props.onBrowseDir("profileDir")} />
          <Field label="Tunnel profile name" value={config.profile} onChange={(profile) => onPatch({ profile })} />
        </div>
        <Check label="Enable v5 features" checked={config.v5Preview} onChange={(v5Preview) => onPatch({ v5Preview })} />
      </Section>
      <div className="settings-actions split-actions"><button type="button" className="button secondary" onClick={props.onRunSetup}>Run setup again</button><button type="button" className="button primary" onClick={props.onSaveSettings}>Save settings</button></div>
    </div>
  );
}

function SettingsActions({ onSave }: { onSave: () => void }) {
  return <div className="settings-actions"><button type="button" className="button primary" onClick={onSave}>Save settings</button></div>;
}
