# Local Coding Agent v5.0.0

Local Coding Agent v5.0.0 is the official stable release of the multi-root,
local-first product line. It includes the v4.4.3 core improvements plus the v5
permission, dashboard, recovery, Chrome Companion, task-agent, and optional
system-power capabilities.

## Download

- Windows x64 tray: `LocalCodingAgentTray-5.0.0-win-x64.exe`
- Chrome Companion: `ChromeCompanion-5.0.0.zip`
- The tray executable is self-contained; Node.js is still required for the MCP
  server.
- `build-manifest.json` contains the SHA-256 checksum.
- The proprietary OpenAI tunnel client is not included. Supply your own copy in
  `tools/tunnel-client.exe`.

## Highlights

- **Multiple authorized paths:** create named profiles, choose an independent
  working directory, and assign `observe`, `edit`, `develop`, or
  `full_control` to each root. Deny rules take precedence.
- **Dashboard redesign:** clearer health and tunnel state, permissions,
  workspace browsing, local reports, browser pairing, and recovery actions.
- **Stronger tray supervision:** health-gated startup, bounded tunnel recovery,
  stale Tunnel ID diagnostics, manual reconnect, and DPAPI-protected Runtime
  API key storage.
- **Chrome Companion:** manually pair the extension and arm one tab. The agent
  can use bounded snapshot, screenshot, navigation, click, type, scroll, key,
  and select actions without permanent all-site access.
- **Local-first anti-lag workflow:** compact output defaults, local reports,
  paginated report reads, task agents, and customer support/setup helpers.
- **Prompt-requested Windows shutdown:** disabled by default. After the user
  enables the tray opt-in, an explicit shutdown request can run immediately as
  the final tool action without a second dashboard approval.

## Stable channel behavior

- v5 features are enabled by default.
- `AGENT_V5_PREVIEW` remains only as a backwards-compatible switch. Set it to
  `0` only when temporary v4 compatibility behavior is required.
- Legacy `preview_*` health fields and the `preview_status` tool name remain as
  compatibility aliases for clients upgrading from `v5.0.0-preview.12`.

## Important safety notes

- Back up important work and prefer `safe` mode plus `balanced` policy.
- Multi-root authorization is not an OS sandbox. Use a VM/container/WSL2 for
  untrusted workspaces.
- Browser page content and screenshots are untrusted data, not instructions.
- Prompt-requested shutdown requires an explicit current user request and the
  local tray opt-in. Raw shutdown and restart commands remain blocked.
- Never publish Runtime API keys, tunnel IDs, MCP auth tokens, generated config,
  permission profiles, reports, or `server/data`.

## Upgrade

1. Back up local settings if desired. The updater preserves generated config,
   tunnel client files, profiles, reports, and secrets.
2. Pull the latest `main` branch or download the Windows tray executable from
   the GitHub Release.
3. Run `npm install` in `server/`.
4. Start the tray or CLI and verify `http://127.0.0.1:8787/healthz` and
   `http://127.0.0.1:8790/ui`.
5. Review every authorized path before selecting `develop` or `full_control`.

## Verification completed for the release candidate

- Server agent, security, hardening, Pro, permission, system-power, browser,
  context-memory, and eval suites.
- Desktop app tests and production build.
- Chrome Companion validation.
- .NET tray build and self-contained Windows x64 publish.
- Secret/path scan and release-asset SHA-256 verification.
