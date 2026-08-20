import { useEffect, useState } from "react";
import type { ProfileStore, RootEntry } from "./types";

const PRESETS = ["observe", "edit", "develop", "full_control"];

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export function PathsModal({ onClose, onSaved }: Props) {
  const [store, setStore] = useState<ProfileStore | null>(null);
  const [file, setFile] = useState("");
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    window.lcat.getProfiles().then(({ file: f, store: s }) => {
      setFile(f);
      setStore(s as unknown as ProfileStore);
    });
  }, []);

  if (!store) return null;

  const activeName = store.active_profile;
  const active = store.profiles[activeName] || null;
  const rootCount = active ? active.roots.length : 0;

  const setActive = (name: string) => {
    setStore({ ...store, active_profile: name });
    setError("");
  };

  const addRoot = async () => {
    if (!active) return;
    const picked = await window.lcat.pickDir("Add authorized path");
    if (!picked) return;
    const label = picked.split(/[\\/]/).filter(Boolean).pop() || picked;
    const roots: RootEntry[] = [...active.roots, { label, path: picked, preset: "develop" }];
    setStore({ ...store, profiles: { ...store.profiles, [activeName]: { ...active, roots } } });
    setError("");
  };

  const removeRoot = (path: string) => {
    if (!active) return;
    const roots = active.roots.filter((r) => r.path !== path);
    if (!roots.length) {
      setError("A profile must keep at least one root.");
      return;
    }
    const stillCovers = roots.some((r) => {
      const wd = active.working_directory.replace(/[\\/]+$/, "");
      const rp = r.path.replace(/[\\/]+$/, "");
      return wd === rp || wd.startsWith(rp + (process.platform === "win32" ? "\\" : "/"));
    });
    if (!stillCovers) {
      setError("Cannot remove the root that contains working_directory until another containing root is configured.");
      return;
    }
    setStore({ ...store, profiles: { ...store.profiles, [activeName]: { ...active, roots } } });
    setError("");
  };

  const setPreset = (path: string, preset: string) => {
    if (!active) return;
    const roots = active.roots.map((r) => (r.path === path ? { ...r, preset } : r));
    setStore({ ...store, profiles: { ...store.profiles, [activeName]: { ...active, roots } } });
  };

  const createProfile = () => {
    const name = newName.trim();
    if (!name) return;
    if (store.profiles[name]) {
      setError(`Profile "${name}" already exists.`);
      return;
    }
    const base = active || { version: 1, name, description: "Local Coding Agent v5 multi-root profile", working_directory: "", roots: [] };
    const profile = {
      version: 1,
      name,
      description: "Local Coding Agent v5 multi-root profile",
      working_directory: base.working_directory || "",
      roots: base.roots.length ? [{ ...base.roots[0] }] : []
    };
    setStore({ ...store, active_profile: name, profiles: { ...store.profiles, [name]: profile } });
    setNewName("");
    setError("");
  };

  const startRename = (name: string) => {
    setRenaming(name);
    setRenameValue(name);
  };

  const renameProfile = () => {
    const name = renaming;
    const to = renameValue.trim();
    if (!to) return;
    if (to !== name && store.profiles[to]) {
      setError(`Profile "${to}" already exists.`);
      return;
    }
    const profiles: Record<string, typeof store.profiles[string]> = {};
    for (const [key, value] of Object.entries(store.profiles)) {
      profiles[key === name ? to : key] = { ...value, name: key === name ? to : value.name };
    }
    const next = { ...store, profiles, active_profile: store.active_profile === name ? to : store.active_profile };
    setStore(next);
    setRenaming("");
    setRenameValue("");
    setError("");
  };

  const save = async () => {
    setError("");
    try {
      await window.lcat.saveProfiles(store);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Manage authorized paths</h3>
          <span className="hint">Named multi-path profiles — {file}</span>
          <button type="button" className="mini close" onClick={onClose} title="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="profile-row">
            <label>
              <span className="field-label">Active profile</span>
              <select value={activeName} onChange={(e) => setActive(e.target.value)}>
                {Object.keys(store.profiles).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint">{rootCount} path(s) authorized</span>
          </div>

          <div className="profile-list">
            {Object.keys(store.profiles).map((name) =>
              renaming === name ? (
                <div key={name} className="rename-row">
                  <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
                  <button type="button" className="mini" onClick={renameProfile}>
                    Rename
                  </button>
                  <button type="button" className="mini" onClick={() => setRenaming("")}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div key={name} className={`profile-chip${name === activeName ? " active" : ""}`}>
                  <span>{name}</span>
                  <button type="button" className="mini" onClick={() => startRename(name)} title="Rename profile">
                    Rename
                  </button>
                  {name !== activeName && (
                    <button type="button" className="mini" onClick={() => setActive(name)} title="Make active">
                      Use
                    </button>
                  )}
                </div>
              )
            )}
          </div>

          <div className="profile-row">
            <input placeholder="New profile name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="button" className="mini" onClick={createProfile}>
              Create
            </button>
          </div>

          {active && (
            <>
              <div className="roots-header">
                <span>
                  Roots of profile <strong>{activeName}</strong>
                </span>
                <button type="button" className="mini" onClick={addRoot}>
                  Add path
                </button>
              </div>
              <ul className="roots-list">
                {active.roots.map((root) => (
                  <li key={root.path} className="root-item">
                    <span className="root-path" title={root.path}>
                      {root.label}
                      <span className="hint">{root.path}</span>
                    </span>
                    <select value={root.preset} onChange={(e) => setPreset(root.path, e.target.value)} title="Rights preset">
                      {PRESETS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="mini" onClick={() => removeRoot(root.path)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {error && <div className="msg-error">{error}</div>}
        </div>

        <footer className="modal-footer">
          <button type="button" className="primary" onClick={save}>
            Save & use
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}