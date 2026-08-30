# Desktop Tray UI/UX Upgrade Design

## Goal

Turn the stable `desktop-tray` application into a clear daily control panel for Local Coding Agent while preserving its existing supervisor, IPC, security, and packaging behavior. The experimental `desktop-app` is out of scope.

## Design direction

The approved direction combines:

- a guided setup flow for incomplete first-run configuration;
- a compact power panel for normal operation;
- an adaptive theme that follows Windows by default and also supports explicit Light and Dark overrides.

The interface should make the agent's real operating state observable and controllable. It must not invent activity, plans, or progress that the backend does not expose.

## Primary flows

### First run and incomplete configuration

The app opens a four-step wizard when the minimum runnable configuration is incomplete:

1. **Workspace** — choose the primary authorized folder and optionally open the named path-profile manager.
2. **Protection** — confirm mode and policy, defaulting to `safe` and `balanced`, with concise explanations of their effect.
3. **Connection** — use local-only operation by default or configure a user-supplied tunnel client, Tunnel ID, Organization ID, and encrypted runtime key.
4. **Review and launch** — summarize workspace, access mode, policy, ports, and tunnel state before saving and starting.

The wizard never requires a tunnel. It exposes the existing validation errors next to the relevant step and does not store secrets in renderer state longer than the existing implementation requires.

Setup completeness is inferred from the existing required configuration rather than adding a new shared config field. The user can reopen the wizard from Settings.

### Daily operation

After configuration is complete, the app opens the Power Panel:

- a prominent server status card showing state, version, mode, policy, active profile, authorized root count, and workspace;
- a tunnel status card that clearly distinguishes not configured, stopped, connecting, connected, reconnecting, and error;
- primary Start/Stop control based on real supervisor state;
- quick actions for Dashboard, Logs, MCP URL copy, and authorized-path management;
- compact runtime and security summaries;
- clear recovery copy when an action fails.

Configuration is grouped into focused sections instead of one long form: Workspace, Runtime, Connection, Security, and Advanced. Dangerous toggles are isolated in a visually distinct Danger Zone and retain their current semantics.

## Navigation and hierarchy

The application uses a compact top-level navigation appropriate for the existing Electron window:

- **Overview** — Power Panel and quick actions.
- **Workspace** — legacy workspace, named permission profiles, mode, and policy.
- **Connection** — server ports, tunnel binary/profile/IDs, and encrypted runtime key.
- **Security** — auth token, shutdown opt-in, and dangerous-command opt-in.
- **Advanced** — Node executable, MCP runtime folder, profile storage, compatibility controls, and setup restart.

Logs and authorized-path management remain modals, preserving current IPC boundaries.

## Visual system

- CSS custom properties define semantic background, surface, border, text, accent, success, warning, and error tokens.
- The default theme follows `prefers-color-scheme`; System, Light, and Dark can be selected explicitly and saved in `localStorage`.
- Status is communicated with text and icons as well as color.
- Controls have visible keyboard focus, adequate hit targets, and consistent disabled/busy states.
- Motion is limited to meaningful state transitions and respects `prefers-reduced-motion`.
- The layout remains usable at the packaged Electron window's minimum size and collapses multi-column cards when narrow.

## Technical structure

The backend contract remains unchanged. Renderer changes are isolated into focused components:

- `App.tsx` owns config/status loading, IPC actions, and top-level routing.
- `OnboardingWizard.tsx` renders the four setup steps and delegates existing save/start actions.
- `PowerPanel.tsx` renders live status and daily actions.
- `SettingsPanel.tsx` renders the focused configuration sections.
- `ThemeControl.tsx` owns System/Light/Dark selection and document theme application.
- `view-model.mjs` contains pure setup/status presentation helpers that can be tested with Node's built-in test runner.

Existing `PathsModal` and `LogsModal` behavior is preserved and restyled to the same tokens.

## Error handling and trust

- Validation errors stay attached to their field and wizard step.
- Start, stop, reconnect, save, and secret actions expose success, warning, or failure banners with recovery-oriented text.
- The UI never displays a tunnel as connected unless the existing supervisor reports it.
- Secret values remain encrypted through the existing main-process storage and are never logged or bundled.
- `tunnel-client.exe` remains user-supplied and is never downloaded, committed, or packaged.

## Testing and acceptance

Implementation uses tests before behavior changes:

- pure tests for setup-completeness and status presentation;
- existing supervisor tests remain green;
- TypeScript typecheck and Vite production build succeed;
- the Windows x64 portable package is produced;
- the packaged artifact contains the bundled MCP server runtime but no tunnel client;
- a smoke launch confirms the app opens, uses the configured main workspace, retains `safe`/`balanced`, and can reach MCP health and the dashboard after Start.

## Out of scope

- `desktop-app` / Local Codex Studio;
- new backend endpoints or IPC methods;
- chat, task planning, multi-agent, memory, or artifact surfaces not currently provided by the stable tray backend;
- shipping or acquiring the proprietary OpenAI tunnel client;
- changing the defaults away from `safe` and `balanced`.
