import type { PermissionStore, RootPreset } from "../env";

const PRESETS: Array<{ value: RootPreset; label: string; hint: string }> = [
  { value: "observe", label: "Observe", hint: "read only" },
  { value: "edit", label: "Edit", hint: "read + write" },
  { value: "develop", label: "Develop", hint: "write + safe commands" },
  { value: "full_control", label: "Full control", hint: "write + full commands" }
];

interface Props {
  file: string;
  store: PermissionStore;
  busy: boolean;
  onSave: (store: PermissionStore, restart?: boolean) => Promise<void>;
  onPickRoot: () => Promise<string | null>;
}

function clone(store: PermissionStore): PermissionStore {
  return JSON.parse(JSON.stringify(store));
}

export function PermissionPanel({ file, store, busy, onSave, onPickRoot }: Props) {
  const names = Object.keys(store.profiles);
  const active = store.profiles[store.active_profile];
  if (!active) return <div className="banner">Active permission profile is missing.</div>;

  async function selectProfile(name: string) {
    const next = clone(store);
    next.active_profile = name;
    await onSave(next, true);
  }

  async function addProfile() {
    const next = clone(store);
    let index = names.length + 1;
    let name = `profile-${index}`;
    while (next.profiles[name]) name = `profile-${++index}`;
    next.profiles[name] = {
      version: 1,
      name,
      description: "Local Coding Agent v5 multi-root profile",
      working_directory: active.working_directory,
      roots: [{ label: "Primary workspace", path: active.working_directory, preset: "develop" }]
    };
    next.active_profile = name;
    await onSave(next, true);
  }

  async function addRoot() {
    const picked = await onPickRoot();
    if (!picked) return;
    const next = clone(store);
    const profile = next.profiles[next.active_profile];
    const existing = profile.roots.find((root) => root.path.toLowerCase() === picked.toLowerCase());
    if (existing) return;
    const segments = picked.split(/[\\/]/).filter(Boolean);
    profile.roots.push({
      label: segments[segments.length - 1] || picked,
      path: picked,
      preset: "develop"
    });
    await onSave(next);
  }

  async function updateRoot(index: number, patch: { preset?: RootPreset; deny?: string[] }) {
    const next = clone(store);
    next.profiles[next.active_profile].roots[index] = {
      ...next.profiles[next.active_profile].roots[index],
      ...patch
    };
    await onSave(next);
  }

  async function setWorkingDirectory(index: number) {
    const next = clone(store);
    next.profiles[next.active_profile].working_directory = next.profiles[next.active_profile].roots[index].path;
    await onSave(next, true);
  }

  async function removeRoot(index: number) {
    if (active.roots.length <= 1) return;
    const root = active.roots[index];
    if (!window.confirm(`Remove access to ${root.path}?`)) return;
    const next = clone(store);
    next.profiles[next.active_profile].roots.splice(index, 1);
    await onSave(next, true);
  }

  return (
    <div className="card permission-card">
      <div className="permission-head">
        <div>
          <h2>Authorized paths</h2>
          <div className="hint" title={file}>Private profile store: {file}</div>
        </div>
        <div className="permission-actions">
          <select value={store.active_profile} onChange={(event) => selectProfile(event.target.value)} disabled={busy}>
            {names.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button className="btn small" onClick={addProfile} disabled={busy}>New profile</button>
          <button className="btn primary small" onClick={addRoot} disabled={busy}>Add path</button>
        </div>
      </div>

      <div className="permission-note">
        Working directory and authorized roots are separate. Deny patterns always win. Full control still blocks catastrophic system commands.
      </div>

      <div className="root-list">
        {active.roots.map((root, index) => {
          const isWorking = root.path.toLowerCase() === active.working_directory.toLowerCase();
          return (
            <div className="root-row" key={`${root.path}-${index}`}>
              <div className="root-path" title={root.path}>
                <strong>{root.label || `Path ${index + 1}`}</strong>
                <code>{root.path}</code>
                {isWorking && <span className="tag">working directory</span>}
              </div>
              <div className="field root-preset">
                <label>Rights</label>
                <select
                  value={root.preset}
                  disabled={busy}
                  onChange={(event) => updateRoot(index, { preset: event.target.value as RootPreset })}
                >
                  {PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>{preset.label} — {preset.hint}</option>
                  ))}
                </select>
              </div>
              <div className="field root-deny">
                <label>Deny globs</label>
                <input
                  type="text"
                  defaultValue={(root.deny || []).join(", ")}
                  placeholder=".env, secrets/**"
                  disabled={busy}
                  onBlur={(event) => updateRoot(index, { deny: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })}
                />
              </div>
              <div className="root-buttons">
                {!isWorking && <button className="btn small" onClick={() => setWorkingDirectory(index)} disabled={busy}>Use as cwd</button>}
                <button className="btn danger small" onClick={() => removeRoot(index)} disabled={busy || active.roots.length <= 1}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
