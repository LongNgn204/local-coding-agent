# Desktop Tray UI/UX Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stable tray app's long settings form with a guided first-run wizard and an adaptive-theme daily Power Panel, then ship a verified Windows x64 portable executable.

**Architecture:** Keep all Electron main-process, supervisor, IPC, config, secret-storage, and packaging contracts unchanged. Refactor only the React renderer into focused view components backed by a small pure presentation model, with CSS-token themes and progressive disclosure.

**Tech Stack:** Electron 43, React 18, TypeScript 5.9, Vite 8, Node built-in test runner, electron-builder 26.

**Spec:** `docs/superpowers/specs/2026-08-30-desktop-tray-ui-ux-design.md`

## Global Constraints

- Modify only the stable `desktop-tray`; do not modify or package `desktop-app`.
- Preserve the existing Electron IPC and supervisor interfaces.
- Default agent mode remains `safe`; default policy remains `balanced`.
- Never download, commit, or package `tunnel-client.exe`.
- Never commit secrets, API keys, Tunnel IDs, organization IDs, local config, permission profiles, logs, or generated brainstorm files.
- Add no runtime or UI framework dependency; use the existing React/CSS stack.
- Status UI must use text/icons in addition to color and must represent only real supervisor state.

---

### Task 1: Pure setup and status presentation model

**Files:**
- Create: `desktop-tray/ui/src/view-model.mjs`
- Create: `desktop-tray/ui/src/view-model.d.ts`
- Create: `desktop-tray/test/view-model.test.mjs`

**Interfaces:**
- Produces: `getSetupIssues(config): string[]`
- Produces: `isSetupComplete(config): boolean`
- Produces: `normalizeTheme(value): "system" | "light" | "dark"`
- Produces: `effectiveTheme(preference, prefersDark): "light" | "dark"`
- Produces: `serverPresentation(server): { label, detail, tone }`
- Produces: `tunnelPresentation(tunnel): { label, detail, tone }`

- [ ] **Step 1: Write failing view-model tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveTheme,
  getSetupIssues,
  isSetupComplete,
  normalizeTheme,
  serverPresentation,
  tunnelPresentation
} from "../ui/src/view-model.mjs";

const valid = {
  node: "node",
  mcpAppDir: "C:/runtime/server",
  workspace: "C:/work",
  mode: "safe",
  policy: "balanced",
  port: 8787,
  dashboardPort: 8790
};

test("setup completeness requires runnable safe configuration", () => {
  assert.equal(isSetupComplete(valid), true);
  assert.deepEqual(getSetupIssues({ ...valid, workspace: "" }), ["workspace"]);
  assert.deepEqual(getSetupIssues({ ...valid, dashboardPort: 8788 }), ["dashboardPort"]);
});

test("theme preference is normalized and resolved", () => {
  assert.equal(normalizeTheme("unknown"), "system");
  assert.equal(effectiveTheme("system", true), "dark");
  assert.equal(effectiveTheme("light", true), "light");
});

test("status presentation remains explicit without relying on color", () => {
  assert.match(serverPresentation({ state: "online", version: "5.0.1", mode: "safe", policy: "balanced", permissionProfile: "default", roots: 1 }).label, /ONLINE/);
  assert.match(tunnelPresentation({ state: "not_configured", reason: "" }).label, /NOT CONFIGURED/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test desktop-tray/test/view-model.test.mjs`

Expected: FAIL because `view-model.mjs` does not exist.

- [ ] **Step 3: Implement the pure model**

Implement exact required-field checks, port validation including reserved dashboard port `8788`, explicit theme normalization, and presentation objects whose `tone` is one of `ok | warn | error | neutral`. Keep the module browser-safe and dependency-free.

- [ ] **Step 4: Add exact TypeScript declarations**

Declare the six exported functions and the minimal structural input/output types in `view-model.d.ts`; do not introduce `any`.

- [ ] **Step 5: Run tests and commit**

Run: `node --test desktop-tray/test/view-model.test.mjs`

Expected: all tests PASS.

```powershell
git add desktop-tray/ui/src/view-model.mjs desktop-tray/ui/src/view-model.d.ts desktop-tray/test/view-model.test.mjs
git commit -m "test: define tray UI presentation model"
```

### Task 2: Shared controls and adaptive theme shell

**Files:**
- Create: `desktop-tray/ui/src/Controls.tsx`
- Create: `desktop-tray/ui/src/ThemeControl.tsx`
- Modify: `desktop-tray/ui/src/App.tsx`
- Modify: `desktop-tray/ui/src/styles.css`
- Test: `desktop-tray/test/view-model.test.mjs`

**Interfaces:**
- Consumes: `normalizeTheme` and `effectiveTheme` from Task 1.
- Produces: reusable `Field`, `Check`, `SelectField`, `NumberField`, and `Section` components.
- Produces: `ThemeControl` with System/Light/Dark preference stored under `lca-theme` in `localStorage`.

- [ ] **Step 1: Extend the theme tests**

Add assertions for uppercase/empty stored values and both system color-scheme branches.

- [ ] **Step 2: Run tests and verify the new assertions fail**

Run: `node --test desktop-tray/test/view-model.test.mjs`

Expected: FAIL until normalization handles case and empty values.

- [ ] **Step 3: Complete theme normalization and implement `ThemeControl`**

`ThemeControl` must subscribe to `matchMedia("(prefers-color-scheme: dark)")`, set `document.documentElement.dataset.theme` to the effective theme, persist only the user preference, and expose three accessible buttons with `aria-pressed`.

- [ ] **Step 4: Extract shared controls from `App.tsx`**

Move existing field/check behavior into `Controls.tsx`, preserving browse buttons, password visibility, invalid state, hints, and numeric/select behavior. Ensure every control has a visible label and a programmatic input association.

- [ ] **Step 5: Replace CSS primitives with semantic tokens**

Define light and dark values for background, elevated surfaces, borders, primary/secondary text, accent, success, warning, error, focus ring, and shadow. Add `:focus-visible` and `prefers-reduced-motion` rules.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
node --test desktop-tray/test/view-model.test.mjs
npm --prefix desktop-tray run build
```

Expected: tests PASS; TypeScript and Vite build exit 0.

```powershell
git add desktop-tray/ui/src/Controls.tsx desktop-tray/ui/src/ThemeControl.tsx desktop-tray/ui/src/App.tsx desktop-tray/ui/src/styles.css desktop-tray/test/view-model.test.mjs desktop-tray/ui/src/view-model.mjs
git commit -m "feat: add adaptive tray design system"
```

### Task 3: Guided first-run wizard

**Files:**
- Create: `desktop-tray/ui/src/OnboardingWizard.tsx`
- Modify: `desktop-tray/ui/src/App.tsx`
- Modify: `desktop-tray/ui/src/styles.css`
- Test: `desktop-tray/test/view-model.test.mjs`

**Interfaces:**
- Consumes: `isSetupComplete(config)` from Task 1 and shared controls from Task 2.
- Produces: `OnboardingWizard` with four steps: Workspace, Protection, Connection, Review.
- App supplies config patching, browse callbacks, encrypted-secret save callback, profile-manager callback, and final save/start callback.

- [ ] **Step 1: Add failing setup-edge tests**

Add cases for missing Node executable, missing MCP directory, invalid mode/policy, invalid port range, and reserved dashboard port. Assert deterministic issue ordering so the wizard can route to the first invalid step.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test desktop-tray/test/view-model.test.mjs`

Expected: at least one new edge case FAILS.

- [ ] **Step 3: Complete setup validation**

Update `getSetupIssues` so its field keys match the existing `App.tsx` validation map exactly: `node`, `mcpAppDir`, `workspace`, `mode`, `policy`, `port`, `dashboardPort`.

- [ ] **Step 4: Implement the wizard**

Render an accessible step list and one step at a time. Local-only must be the default connection path; tunnel fields remain optional and explicitly state that the proprietary binary is user supplied. Review must show workspace, mode, policy, MCP URL, dashboard URL, and tunnel configured/not configured before calling the final action.

- [ ] **Step 5: Integrate setup routing**

After config load, show the wizard only when `isSetupComplete(cfg)` is false. Add `Run setup again` from Advanced settings without adding a shared config field. Preserve field-level error mapping and secret handling.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
node --test desktop-tray/test/view-model.test.mjs
npm --prefix desktop-tray run build
```

Expected: all tests PASS and production renderer build succeeds.

```powershell
git add desktop-tray/ui/src/OnboardingWizard.tsx desktop-tray/ui/src/App.tsx desktop-tray/ui/src/styles.css desktop-tray/ui/src/view-model.mjs desktop-tray/test/view-model.test.mjs
git commit -m "feat: add guided tray setup"
```

### Task 4: Daily Power Panel and progressive settings

**Files:**
- Create: `desktop-tray/ui/src/PowerPanel.tsx`
- Create: `desktop-tray/ui/src/SettingsPanel.tsx`
- Modify: `desktop-tray/ui/src/App.tsx`
- Modify: `desktop-tray/ui/src/PathsModal.tsx`
- Modify: `desktop-tray/ui/src/LogsModal.tsx`
- Modify: `desktop-tray/ui/src/styles.css`
- Test: `desktop-tray/test/view-model.test.mjs`

**Interfaces:**
- Consumes: server/tunnel presentation helpers from Task 1.
- Produces: Overview, Workspace, Connection, Security, and Advanced renderer sections.
- Preserves every existing user action: start, stop, reconnect, dashboard, save settings, MCP URL copy, Tunnel ID copy, path profiles, logs, tunnel save, key save, and auth-token save.

- [ ] **Step 1: Add failing status-state tests**

Cover server states `offline`, `starting`, `online`, `stopping`, `error` and tunnel states `not_configured`, `stopped`, `starting`, `connected`, `reconnecting`, `error`. Assert each presentation has a non-empty explicit label, recovery detail for errors, and a semantic tone.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test desktop-tray/test/view-model.test.mjs`

Expected: FAIL for unimplemented state details.

- [ ] **Step 3: Complete status presentation and build `PowerPanel`**

Render live server/tunnel cards, workspace/security summaries, and primary actions. Busy states must disable conflicting actions. Tunnel mismatch/reason text must remain visible. Do not synthesize progress.

- [ ] **Step 4: Build `SettingsPanel`**

Group all existing fields under Workspace, Connection, Security, and Advanced. Put `allowSystemShutdown` and `allowDangerous` in a Danger Zone with full existing warning text. Keep safe/balanced visually identified as recommended without preventing other valid choices.

- [ ] **Step 5: Integrate navigation and restyle modals**

Use semantic buttons/tabs with `aria-current` or `aria-selected`. Update Paths and Logs modal classes only where required for the new token system; preserve their IPC behavior and data flow.

- [ ] **Step 6: Run the complete desktop-tray verification and commit**

Run:

```powershell
npm --prefix desktop-tray test
npm --prefix desktop-tray run build
```

Expected: all Node tests PASS; TypeScript reports no errors; Vite build succeeds.

```powershell
git add desktop-tray/ui/src desktop-tray/test/view-model.test.mjs
git commit -m "feat: add tray power panel"
```

### Task 5: Package and smoke-test the Windows portable executable

**Files:**
- Verify: `desktop-tray/package.json`
- Generate (untracked build output): `desktop-tray/dist/LocalCodingAgentTray-5.0.1-win-x64.exe`

**Interfaces:**
- Consumes: the completed renderer and existing electron-builder configuration.
- Produces: one Windows x64 portable executable with the MCP server runtime and without any tunnel client.

- [ ] **Step 1: Install repository-local dependencies**

Run:

```powershell
npm --prefix server install
npm --prefix desktop-tray install
```

Expected: both commands exit 0. Do not install another system dependency automatically.

- [ ] **Step 2: Run the full verification suite**

Run:

```powershell
npm --prefix desktop-tray test
npm --prefix desktop-tray run build
npm --prefix server run test:hardening
```

Expected: all desktop-tray tests and hardening tests PASS with zero failures.

- [ ] **Step 3: Produce the unpacked smoke build and portable EXE**

Run:

```powershell
npm --prefix desktop-tray run package:dir
npm --prefix desktop-tray run package
```

Expected: electron-builder exits 0 and creates the versioned Windows x64 portable executable.

- [ ] **Step 4: Verify artifact safety**

Inspect the unpacked resources and packaged file list. Confirm `runtime/server/server.mjs` and server dependencies exist; confirm no file named `tunnel-client` or `tunnel-client.exe` exists in the package; confirm Git status contains no secrets, local config, profiles, or build output staged for commit.

- [ ] **Step 5: Smoke launch with the approved configuration**

Stop the server running from the old clone to prevent port conflicts. Launch the unpacked app first, then the portable EXE. Confirm the window opens, theme follows Windows, configured users land on the Power Panel, workspace is `C:\Users\Long\Documents\GitHub\local-coding-agent`, mode is `safe`, policy is `balanced`, Start produces `/healthz` status `ok`, and Dashboard returns HTTP 200.

- [ ] **Step 6: Final review commit**

Run `git diff --check`, `git status --short`, and `git log --oneline --decorate -5`. Commit only source/test/doc changes if any final adjustment was required; never commit `dist`, `.superpowers`, local config, profiles, logs, or secrets.
