import { useMemo, useState } from "react";
import type { AppConfig, SecretInfo } from "./types";
import { Field, SelectField } from "./Controls";
import { getSetupIssues } from "./view-model.mjs";

const STEPS = ["Workspace", "Protection", "Connection", "Review"] as const;
const MODES = ["safe", "full"] as const;
const POLICIES = ["strict", "balanced", "full"] as const;

interface Props {
  config: AppConfig;
  secrets: SecretInfo;
  errors: Record<string, string>;
  runtimeKeyInput: string;
  showRuntimeKey: boolean;
  onPatch: (patch: Partial<AppConfig>) => void;
  onRuntimeKeyInput: (value: string) => void;
  onToggleRuntimeKey: () => void;
  onBrowseWorkspace: () => void;
  onBrowseTunnel: () => void;
  onManagePaths: () => void;
  onSaveRuntimeKey: () => Promise<void>;
  onComplete: () => Promise<boolean>;
  onClose?: () => void;
}

export function OnboardingWizard({
  config,
  secrets,
  errors,
  runtimeKeyInput,
  showRuntimeKey,
  onPatch,
  onRuntimeKeyInput,
  onToggleRuntimeKey,
  onBrowseWorkspace,
  onBrowseTunnel,
  onManagePaths,
  onSaveRuntimeKey,
  onComplete,
  onClose
}: Props) {
  const [step, setStep] = useState(0);
  const [localError, setLocalError] = useState("");
  const [finishing, setFinishing] = useState(false);
  const setupIssues = useMemo(() => getSetupIssues(config), [config]);

  const next = () => {
    setLocalError("");
    if (step === 0 && !config.workspace.trim()) {
      setLocalError("Choose the workspace the agent is allowed to access.");
      return;
    }
    if (step === 2 && !config.noTunnel && (!config.tunnelBin.trim() || !config.tunnelId.trim())) {
      setLocalError("Choose local-only, or provide both the tunnel-client path and Tunnel ID.");
      return;
    }
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const finish = async () => {
    setFinishing(true);
    setLocalError("");
    try {
      const ok = await onComplete();
      if (!ok) setLocalError("The agent could not start. Review the highlighted settings and try again.");
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="onboarding-shell" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding-card">
        <header className="onboarding-header">
          <div>
            <span className="eyebrow">Guided setup</span>
            <h2 id="onboarding-title">Prepare Local Coding Agent</h2>
            <p>Authorize a workspace, confirm protection, then launch locally.</p>
          </div>
          {onClose && <button type="button" className="button secondary compact" onClick={onClose}>Close</button>}
        </header>

        <ol className="wizard-steps" aria-label="Setup progress">
          {STEPS.map((label, index) => (
            <li key={label} className={index === step ? "active" : index < step ? "complete" : ""} aria-current={index === step ? "step" : undefined}>
              <span>{index < step ? "✓" : index + 1}</span>{label}
            </li>
          ))}
        </ol>

        <div className="wizard-content">
          {step === 0 && (
            <section>
              <span className="eyebrow">Step 1</span>
              <h3>Choose the working boundary</h3>
              <p className="lead">The agent can read and write only inside paths you authorize. Use a trusted repository.</p>
              <Field label="Primary workspace" value={config.workspace} onChange={(workspace) => onPatch({ workspace })} browse={onBrowseWorkspace} invalid={Boolean(errors.workspace)} error={errors.workspace} placeholder="C:\\path\\to\\repository" />
              <button type="button" className="button secondary" onClick={onManagePaths}>Manage multiple authorized paths</button>
            </section>
          )}

          {step === 1 && (
            <section>
              <span className="eyebrow">Step 2</span>
              <h3>Confirm protection</h3>
              <p className="lead">Safe mode with balanced policy is recommended for daily work.</p>
              <div className="form-grid two-column">
                <SelectField label="Mode" value={config.mode} options={MODES} onChange={(mode) => onPatch({ mode: mode as AppConfig["mode"] })} invalid={Boolean(errors.mode)} error={errors.mode} hint="Safe blocks dangerous command patterns." />
                <SelectField label="Policy" value={config.policy} options={POLICIES} onChange={(policy) => onPatch({ policy: policy as AppConfig["policy"] })} invalid={Boolean(errors.policy)} error={errors.policy} hint="Balanced asks for local approval on risky actions." />
              </div>
              <div className="recommendation"><strong>Recommended</strong><span>safe + balanced keeps normal editing fast while gating deletes, installs, network calls, and risky commands.</span></div>
            </section>
          )}

          {step === 2 && (
            <section>
              <span className="eyebrow">Step 3</span>
              <h3>Choose the connection</h3>
              <p className="lead">Local-only works immediately. A secure tunnel is optional and uses only the client you provide.</p>
              <div className="connection-choice" role="radiogroup" aria-label="Connection type">
                <button type="button" role="radio" aria-checked={config.noTunnel} className={config.noTunnel ? "selected" : ""} onClick={() => onPatch({ noTunnel: true })}><strong>Local only</strong><span>MCP and dashboard stay on this PC.</span></button>
                <button type="button" role="radio" aria-checked={!config.noTunnel} className={!config.noTunnel ? "selected" : ""} onClick={() => onPatch({ noTunnel: false })}><strong>Secure tunnel</strong><span>Connect ChatGPT using your tunnel credentials.</span></button>
              </div>
              {!config.noTunnel && (
                <div className="form-stack tunnel-setup">
                  <Field label="tunnel-client" value={config.tunnelBin} onChange={(tunnelBin) => onPatch({ tunnelBin })} browse={onBrowseTunnel} invalid={Boolean(errors.tunnelBin)} error={errors.tunnelBin} hint="User supplied; never bundled or downloaded by this app." />
                  <div className="form-grid two-column">
                    <Field label="Tunnel ID" value={config.tunnelId} onChange={(tunnelId) => onPatch({ tunnelId })} invalid={Boolean(errors.tunnelId)} error={errors.tunnelId} placeholder="tunnel_..." />
                    <Field label="Organization ID" value={config.organizationId} onChange={(organizationId) => onPatch({ organizationId })} invalid={Boolean(errors.organizationId)} error={errors.organizationId} placeholder="org_..." />
                  </div>
                  <div className="inline-actions">
                    <Field label="Runtime API key" value={runtimeKeyInput} onChange={onRuntimeKeyInput} type={showRuntimeKey ? "text" : "password"} showToggle onShowToggle={onToggleRuntimeKey} placeholder={secrets.hasRuntimeKey ? "•••••••• (saved)" : "sk-..."} />
                    <button type="button" className="button secondary" onClick={onSaveRuntimeKey}>Save encrypted key</button>
                  </div>
                </div>
              )}
            </section>
          )}

          {step === 3 && (
            <section>
              <span className="eyebrow">Step 4</span>
              <h3>Review and launch</h3>
              <p className="lead">These are the exact boundaries and endpoints the app will use.</p>
              <dl className="review-list">
                <div><dt>Workspace</dt><dd>{config.workspace || "Not configured"}</dd></div>
                <div><dt>Protection</dt><dd>{config.mode} · {config.policy}</dd></div>
                <div><dt>MCP</dt><dd>http://127.0.0.1:{config.port}/mcp</dd></div>
                <div><dt>Dashboard</dt><dd>http://127.0.0.1:{config.dashboardPort}/ui</dd></div>
                <div><dt>Tunnel</dt><dd>{config.noTunnel ? "Local only" : config.tunnelId || "Not configured"}</dd></div>
              </dl>
              {setupIssues.length > 0 && <div className="message error">Required settings still need attention: {setupIssues.join(", ")}.</div>}
            </section>
          )}
        </div>

        {localError && <div className="message error" role="alert">{localError}</div>}

        <footer className="wizard-footer">
          <button type="button" className="button secondary" disabled={step === 0 || finishing} onClick={() => { setLocalError(""); setStep((current) => Math.max(0, current - 1)); }}>Back</button>
          <span>Step {step + 1} of {STEPS.length}</span>
          {step < STEPS.length - 1 ? (
            <button type="button" className="button primary" onClick={next}>Continue</button>
          ) : (
            <button type="button" className="button primary" disabled={finishing || setupIssues.length > 0} onClick={finish}>{finishing ? "Starting…" : "Save & start"}</button>
          )}
        </footer>
      </div>
    </div>
  );
}
