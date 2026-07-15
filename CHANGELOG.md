# Changelog

All notable changes to Local Coding Agent are documented here. The project
follows [Semantic Versioning](https://semver.org/).

## [4.4.2-prodev] - 2026-07-15

### Added

- Community Edition ownership and brand boundaries through `NOTICE.md`,
  `TRADEMARKS.md`, and `BRAND-GUIDELINES.md`, without changing the
  AGPL-3.0-or-later rights granted for the public source code.
- A bilingual trademark-registration checklist for ownership details,
  clearance searches, filing records, use evidence, and post-filing controls.
- A CI public-release boundary gate that rejects private experiment trees,
  private desktop trees, private-channel paths, and tracked binary/secret assets.

### Changed

- Public version is now `4.4.2-prodev` across the MCP server, CLI, package lock,
  skill manifests, version assertions, and Windows tray app.
- The public distribution contains only supported Community Edition source;
  future-roadmap experiment directories and their CI job are excluded.

### Fixed

- Windows tray health polling now identifies its internal `/healthz` probe, and
  the MCP server suppresses only that routine request from stdout. Manual health
  checks, failed requests, and MCP traffic remain visible, avoiding one noisy
  log line every three seconds without hiding operational errors.
- Network Doctor now identifies the tunnel's upstream `503`/reset-before-headers
  pattern as a control-plane retry: isolated events are described as transient,
  while repeated events point to an unstable or filtered network path.

## [4.4.1-prodev] - 2026-07-08

### Added

- AI Agent Quick Setup flow near the top of the README, with matching English
  and Vietnamese instructions for customer setup, update, and diagnosis.
- CLI prompt generator for customer-facing AI agents:
  - `node scripts/local-coding-agent.mjs prompt setup`
  - `node scripts/local-coding-agent.mjs prompt update`
  - `node scripts/local-coding-agent.mjs prompt diagnose`
- `node scripts/local-coding-agent.mjs setup-wizard`, a non-destructive customer
  readiness report that checks Node/npm/git, repo layout, server dependencies,
  workspace config, tunnel prerequisites, skill validation, and local `/healthz`,
  then writes `setup-wizard-report.txt`.
- `node scripts/local-coding-agent.mjs skills doctor`, which maps common customer
  symptoms to the best shipped skill and next command.
- Dashboard prompt-copy panel for setup/update/diagnose prompts, independent of
  internal experiments.

### Changed

- Public version is now `4.4.1-prodev` across the MCP server package and Windows
  tray app.
- Chat-facing defaults are tighter to reduce ChatGPT Web lag on large tasks:
  `read_file` default output is 12k chars, `run_command` default output is 8k
  chars, and `read_many` batch output defaults to 120k chars.
- Customer prompts and MCP instructions now explicitly discourage pasting full
  logs, diffs, base64, image/icon inventories, or generated reports into chat.
  Agents should use line ranges, globs, `max_chars`, `max_output_chars`, compact
  summaries, and local support/report files.
- Skill manifests are synchronized to `4.4.1-prodev` for the public customer
  support flow.
- Public README and server README do not advertise internal-only experiments.

### Fixed

- Windows CLI npm execution now routes through `cmd.exe /c`, avoiding `spawn
  EINVAL` on systems where spawning `npm.cmd` directly fails.
- `setup-wizard` now reports missing/offline server health clearly instead of
  crashing when a spawned check fails.
## [4.4.0-pro] - 2026-07-01

### Added

- Official skill pack for customer onboarding, safe updates, tunnel/network
  debugging, customer support, releases, security hardening review, skill
  authoring, and code review.
- `scripts/validate-skills.mjs` validates skill frontmatter, duplicate names,
  path-safe names, suspicious secrets, oversized descriptions, and mojibake.
- Universal CLI now supports `update` for safe customer updates and
  `skills list|validate` for shipped skill visibility.
- `docs/CUSTOMER_UPDATE_PROMPT.md` gives customers a copy-paste prompt for their
  own AI coding agent to update Local Coding Agent safely.

### Changed

- Server, npm package, tray app, and version assertions are now `4.4.0-pro`.
- CI validates the new CLI, network doctor, and skill validator entry points.
- README links the customer update prompt and documents `update` and `skills`
  commands in both English and Vietnamese.

## [4.3.0-pro] - 2026-07-01

### Added

- `run_commands` executes up to 12 bounded commands in one MCP round-trip,
  sequentially by default or with explicit bounded parallelism.
- `request_approval_batch` lets the local operator approve 2-20 exact actions
  in one expiring request. Every action is consumable once; wildcard grants are
  intentionally unsupported.
- `read_many` now accepts targeted line-range requests, bounded concurrency,
  up to 100 files, and a configurable total response cap.
- Health responses expose the server PID, policy, config id, and dashboard port
  so launchers can identify the exact process/configuration they manage.
- `scripts/local-coding-agent.mjs` provides a pure Node.js terminal launcher for
  Windows CMD, PowerShell, macOS, and Linux. It now includes setup, install,
  start, stop, status, doctor, dashboard open, logs, config, key, and tunnel
  profile commands so users can run the full workflow without building the tray
  app.
- `scripts/lca.cmd` and `scripts/lca` are tiny wrappers for easier Windows and
  POSIX terminal usage.
- `docs/AI_AGENT_SETUP_PROMPT.md` and the README now include copy-paste prompts
  plus a setup map so users can ask their own AI coding agent to clone, install,
  configure, start, and verify the project.
- `scripts/network-doctor.mjs` and `docs/NETWORK_DOCTOR.md` help customers
  diagnose office-network blocks by checking DNS, TCP 443, TLS, HTTPS, local MCP
  endpoints, proxy environment variables, and optional tunnel-client logs with
  secret redaction.
- README was rewritten as a mirrored English/Vietnamese onboarding guide so both
  languages have the same AI-assisted setup, CLI, tray app, tunnel, diagnostics,
  safety, troubleshooting, and development flow.

### Fixed

- MCP token approvals now reject invalid IDs, expired requests, and attempts to
  approve or deny a request that is no longer pending.
- Approval check-and-consume is serialized in-process so concurrent MCP calls
  cannot reuse the same one-time grant.
- Audit argument redaction now covers `approval_token` and related explicit
  credential field names.
- macOS root checks now validate canonical paths first, avoiding false denials
  on case-insensitive volumes while preserving symlink escape protection.
- Windows and POSIX launchers restart when startup configuration changes and
  stop only the server PID they verified, replacing broad `server.mjs` kills.
- The POSIX launcher now documents the actual semicolon format for
  `AGENT_EXTRA_ROOTS`; JSON remains preferred for ambiguous paths.
- CI parses PowerShell and Bash launchers in addition to exercising the server
  matrix on Windows, macOS, and Ubuntu.

## [4.2.0-pro] - 2026-06-30

Major Pro workflow upgrade focused on day-to-day work quality, not marketing.
This release adds operational diagnostics, structured verification, and
end-of-session reporting so agents can move faster while leaving stronger
evidence behind.

### Added

- `workspace_doctor`: readiness diagnosis for roots, mode/policy, MCP auth,
  browser-origin posture, ripgrep availability, git state, project profile,
  detected quality commands, README/security docs, score, and recommendations.
- `quality_gate`: structured lint/typecheck/test/build runner with dry-run
  planning, ordered gates, compact pass/fail summaries, stop-on-failure, and
  detected/profile command support.
- `session_report`: end-of-session report with health score, bottlenecks,
  metrics, top tools, git state, doctor summary, recommendations, and recent
  errors.
- Pro regression coverage for `workspace_doctor`, `quality_gate`, and
  `session_report`.

### Changed

- Server, npm package, and tray version are now `4.2.0-pro`.
- MCP instructions now recommend `workspace_doctor` for readiness checks,
  `quality_gate` after edits, and `session_report` before final handoff.
- Dashboard/home tool listing now includes the new Pro workflow tools.

## [4.1.1-pro] - 2026-06-30

Quality-focused Pro update on top of v4.1 hardening. This release focuses on
fewer MCP round-trips, clearer operational health, and a stronger demo story.

### Added

- `workspace_snapshot` Pro tool: one call returns workspace roots, mode/policy,
  safety model, project profile, important files, compact tree, git status,
  detected test/build/lint commands, optional symbol sample, metrics summary,
  health score, bottlenecks, and next-best actions.
- Dashboard Health Score card and Pro speed/safety recommendations.
- `tier: "pro"` metadata in `workspace_info` and `/metrics`.
- `test:pro` regression suite for the Pro snapshot, tier metadata, safety model,
  detected commands, important files, symbol sample, health score, and next
  actions.

### Changed

- Server, npm package, and tray version are now `4.1.1-pro`.
- MCP server instructions now tell clients to start with `workspace_snapshot`
  before deeper repo mapping, reducing tunnel round-trips for most sessions.
- CI now syntax-checks and runs the Pro regression suite alongside agent,
  security, and hardening tests.

## [4.1.0] - 2026-06-30

Version 4.1 hardens the MCP boundary and makes the dashboard more useful for
operator-grade local coding sessions. The main goal is to move from "safe by
convention" to explicit policy enforcement, measurable latency, and
workspace-scoped state.

### Added

- Real `AGENT_POLICY` enforcement:
  - `strict` blocks write/execute/mutation tools.
  - `balanced` allows normal edit/test workflows but requires one-time local
    approval for deletes, risky commands, installs/network calls, mutating git,
    risky background processes, and destructive patch operations.
  - `full` preserves the v4 broad integration behavior for trusted/local test
    runs.
- Local dashboard approval queue with approve-once / deny controls.
- Latency telemetry: success rate, calls/minute, average latency, p50/p95/p99,
  per-tool average and p95 latency, and recent-call duration.
- Workspace-scoped data directories under `server/data/workspaces/<id>/` for
  notes, checkpoints, index, patch history, backups, and approval records.
- `test:hardening` regression suite covering browser-origin rejection, bearer
  token handling, chunked body limits, policy approval replay prevention,
  dashboard CSRF-style origin rejection, undo correctness, and workspace-state
  isolation.

### Changed

- Server and tray versions are now `4.1.0`.
- `/mcp` no longer accepts bearer tokens in the query string; use
  `Authorization: Bearer <token>`.
- Browser-origin MCP calls are rejected by default. Use `MCP_ALLOWED_ORIGINS`
  only for explicitly trusted browser origins.
- Request body limiting now counts streamed bytes, so chunked payloads cannot
  bypass `MAX_BODY_BYTES`.
- Profile settings are now applied at startup for mode, policy, extra roots,
  ignored directories, and custom test/build/lint commands.
- Undo now records created files, directory moves, rename destinations, and
  workspace-local history so one workspace cannot undo another workspace's
  changes.
- CI keeps legacy broad tool/runtime tests in `AGENT_POLICY=full` and runs the
  new hardening suite separately.

### Upgrade notes

- Default policy is now `AGENT_POLICY=balanced`. Keep it for day-to-day use;
  use `strict` for read-only audits and `full` only for trusted automation.
- `safe` mode is still a command guardrail, not an operating-system sandbox.
  For true isolation, run the server in a VM, container, or WSL2 instance.
- If you previously used `?token=...` in an MCP URL, switch to bearer headers.

## [4.0.0] - 2026-06-29

Version 4 is the cross-platform and security-focused release. It promotes the
Windows-first 2.x runtime into a consistent Windows, macOS, and Linux package,
while retaining the MCP coding tools, local dashboard, skill support, and
Windows tray workflow.

### Added

- Cross-platform shell selection: `cmd` and PowerShell on Windows, plus
  `bash`, `sh`, and `zsh` support on macOS/Linux.
- Cross-platform process-tree supervision. Windows child processes are stopped
  with `taskkill`; POSIX children run in their own process group and are
  terminated as a group.
- `AGENT_EXTRA_ROOTS_JSON` for unambiguous multi-root configuration when paths
  contain `:` or `;`.
- Structured `git_status` and `git_diff` MCP tools.
- Skill authoring tools: `create_skill` and `delete_skill`.
- Dashboard mini-IDE endpoints and UI for browsing the workspace, previewing
  files, viewing Git diffs, and clearing local metrics.
- A security regression suite covering symlink/junction escape attempts,
  unsafe raw-Git flags, non-repository behavior, and recursive audit redaction.
- GitHub Actions CI on Windows, macOS, and Ubuntu, plus a Windows tray publish
  gate.

### Changed

- Server and tray versions are now `4.0.0`.
- The Windows tray app now defaults to `safe` mode, including migration of
  empty legacy settings to the safer default.
- The tray app targets `.NET 10` and publishes a self-contained Windows x64
  executable.
- Root confinement now canonicalizes existing path segments before access,
  blocking symlink and junction escapes while preserving new-file workflows.
- Windows path comparisons are case-insensitive; POSIX comparisons remain
  case-sensitive.
- Command execution and output capture share platform-aware spawn and cleanup
  behavior, reducing orphaned background processes.
- Audit logging recursively redacts commands, patches, file contents, tokens,
  passwords, authorization headers, and nested secret-like fields.
- Package-lock and CI installs are deterministic through `npm ci`.

### Included from the v3 tool expansion

- Repository intelligence: `project_profile`, `important_files`, `repo_map`,
  `repo_symbols`, and index status/cache reporting.
- Safer editing: patch preview and validation, automatic write backups, and
  `undo_last_patch`.
- Smart test/build/lint runners, including changed-test targeting.
- Review helpers for diff findings, secret scanning, TODO scanning, and change
  summaries.
- Persistent task plans, decision logs, policy/approval controls, and workspace
  profiles.
- A 20-scenario eval suite covering editing, undo, tests, path confinement,
  audit redaction, Git safety, repository mapping, checkpoints, planning,
  policies, and patch previews.

### Tunnel authentication

- When `MCP_AUTH_TOKEN` is configured, the Windows tray app and both launcher
  scripts pass `Authorization: Bearer <token>` to the tunnel through
  `MCP_EXTRA_HEADERS`.
- Secrets are passed through environment variables rather than command-line
  arguments and are cleared by launcher cleanup paths.

### Upgrade notes

- Building the tray app now requires the .NET 10 SDK. Users of the published
  self-contained executable do not need to install the .NET runtime.
- Existing installations should keep `AGENT_MODE=safe` unless unrestricted
  command execution inside configured roots is explicitly required.
- If `MCP_AUTH_TOKEN` is enabled, restart both the MCP server and tunnel so the
  new forwarded authorization header takes effect.
- Dashboard port `8788` remains reserved by the tunnel client; use the default
  dashboard port `8790`.

[4.4.2-prodev]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.4.2-prodev
[4.4.1-prodev]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.4.1-prodev
[4.4.0-pro]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.4.0-pro
[4.3.0-pro]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.3.0-pro
[4.2.0-pro]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.2.0-pro
[4.1.1-pro]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.1.1-pro
[4.1.0]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.1.0
[4.0.0]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.0.0

## [3.0.0] - 2026-06-29

Major feature release: repo intelligence, patch engine + undo, test/build runner,
review mode, planner/thread memory, policy layer, workspace profiles, and eval suite.

### Added — v2.1 Repo Intelligence

- **`project_profile`** — detects languages, frameworks, package managers, and
  scripts by reading root manifests (package.json, pubspec.yaml, go.mod, Cargo.toml,
  pyproject.toml, requirements.txt, pom.xml, build.gradle, *.csproj). Results cached 5 min.
- **`important_files`** — lists key project files (README, tsconfig, .env.example,
  .github/workflows/, Dockerfile, etc.) with sizes.
- **`repo_map`** — one call returning tree + manifests + package scripts +
  project_profile summary. Use this first to understand a repo.
- **`repo_symbols`** — regex scan for function/class/route/const definitions in
  JS/TS/Python files. Returns [{path, line, kind, name}].
- **`index_status`** — returns current cache age and freshness.

### Added — v2.2 Patch Engine + Undo

- **`preview_patch`** — DRY RUN for diff/operations; never writes to disk.
- **`validate_patch`** — returns ok + list of conflicts (unmatched old_text/hunks).
- **`undo_last_patch`** — restores files from the most recent backup batch.
- All write tools (write_file, replace_in_file, apply_patch, delete_path,
  move_path) now create a backup batch before mutating files so undo always works.

### Added — v2.3 Smart Test/Build Runner

- **`detect_test_commands`** — detects test/build/lint/dev commands from manifests.
- **`run_tests`** — runs detected or provided test command; returns {ok, exit_code,
  summary, failures} with heuristic failure parsing.
- **`run_build`** — same as run_tests but for build.
- **`run_lint`** — same for lint.
- **`run_changed_tests`** — maps changed files to test files and runs targeted tests;
  falls back to full suite.

### Added — v2.4 Review Mode

- **`review_diff`** — heuristic code review on git diff; returns P1/P2/P3 findings
  and a PASS/WARN/BLOCK verdict. Checks: eval, innerHTML, dangerouslySetInnerHTML,
  console.log, debugger, TODO/FIXME, large added blocks, missing test coverage.
- **`security_scan`** — scans files for AWS keys, private keys, API tokens, Slack/
  GitHub tokens, and generic secret patterns. Reports file:line without echoing values.
- **`todo_scan`** — finds TODO/FIXME/HACK/XXX comments across the workspace.
- **`change_summary`** — summarizes git diff --stat + changed file list.

### Added — v2.5 Planner / Thread Memory

- **`task_plan`** — create a task plan (goal + steps) in .agent/state/current-task.json.
- **`task_state`** — read or update the plan (mark steps done, add steps, set status).
- **`decision_log`** — append decision + reasoning to .agent/state/decisions.md.
- `checkpoint` now also snapshots current-task.json for cross-chat continuity.

### Added — v2.6 Policy Layer

- **`AGENT_POLICY`** env (strict|balanced|full, default balanced).
  - strict: read/analyze only.
  - balanced: read + edit + test/build; delete/install/network need approval.
  - full: same as before (catastrophic still blocked).
- **`policy_status`** — returns current policy and what's allowed/blocked.
- **`explain_risk`** — classifies a proposed action and gives risk level + decision.
- **`request_approval`** — writes a pending approval to data/approvals/<id>.json.
- **`approve_request`** / **`deny_request`** — approve or deny a pending request.

### Added — v2.8 Workspace Profiles

- On startup, loads `<PRIMARY_ROOT>/.agent/profile.json` if present.
- Profile can set: mode, policy, extraRoots, testCommands, ignoredDirs, conventions.
- **`profile_status`** — returns the loaded profile and schema documentation.
- **`reload_profile`** — reloads the profile from disk without restarting.

### Added — v2.9 Evals

- `evals/run.mjs` — eval runner that spins a temp server and asserts behavior.
- 20 eval scenarios covering: edit-single-file, edit-multi-file, undo restore,
  run failing test, path escape, audit redaction, git safety, repo_map, checkpoint/
  resume, task_plan, policy_status, and preview_patch dry-run.
- `npm run eval` from server/; passes 100% (≥90% required).

### Changed — v3.0

- SERVER_INSTRUCTIONS updated with new workflow (repo_map first, preview/validate
  before apply, run_tests after edits, review_diff before done, task_plan/decision_log).
- VERSION bumped to 3.0.0 in server.mjs and package.json.
- Home page tool list updated to show all tools grouped by version.
- `createMcpServer()` registers all new tool groups.

### Internal

- Added `copyFile` import for backup operations.
- New data paths: index.json, patch-history.json, backups/, approvals/, .agent/state/.
- `recordTestRun()` helper stores last 20 test runs in metrics.


## [2.0.0] - 2026-06-29

The "mini-IDE" release: richer git tooling, in-dashboard file browsing, skill
authoring, and CI.

### Added

- **Structured git tools** (`git_status`, `git_diff`). `git_status` parses
  `git status --porcelain` into a per-file list (branch, index/worktree codes,
  rename `from -> to`, staged/untracked flags). `git_diff` returns `git diff`
  text with an optional `path` filter and a `staged` flag. Both are confined to
  the configured roots like the existing `git` tool.
- **Skill authoring tools** (`create_skill`, `delete_skill`). `create_skill`
  writes `<skillsdir>/<name>/SKILL.md` with YAML frontmatter (name, description)
  plus your body; the default skills dir is `<PRIMARY_ROOT>/.claude/skills`, and
  `list_skills` picks the new skill up immediately. `delete_skill` removes a
  skill folder. Both are confined to recognised skills directories and reject
  path-traversal names.
- **Mini-IDE in the local dashboard.** The dashboard server (port `8790`,
  loopback-only, never tunneled) gains three read-only JSON endpoints:
  - `GET /api/tree?path=` — workspace directory tree (respects `SKIP_DIRS`,
    capped entry count).
  - `GET /api/file?path=` — file content (root-confined, char-capped; returns
    `path`, `total_lines`, `chars`, `content`, `truncated`).
  - `GET /api/diff?path=` — `git diff` of the primary root.

  The `/ui` page adds a **Files** section: a left file-tree pane, a read-only
  viewer pane, and a **Diff** toggle that renders a syntax-colored `git diff`.
- **Clear metrics.** A `POST /api/clear-metrics` endpoint resets the in-memory
  metrics and rewrites `data/metrics.json`, surfaced as a **Clear metrics**
  button on the dashboard.
- **Continuous integration** (`.github/workflows/ci.yml`). On push/PR: checkout,
  Node 20, `npm install` in `server/`, start the server on a temp workspace,
  wait for `/healthz`, run `npm run test:agent`, then stop the server. Includes
  a guard step that fails the build if `server.mjs` contains a NUL byte.

### Changed

- Home page and README now list the four new tools and describe the Files
  mini-IDE.
- Server `VERSION` and `server/package.json` bumped to `2.0.0`.

## [1.6.0]

- **Skills** (Claude-style on-demand playbooks): drop reusable playbooks in
  `skills/` or a workspace's `.claude/skills/`; the agent discovers them and
  loads instructions on demand via `list_skills` / `read_skill`.

## [1.5.0]

- macOS and Linux support alongside Windows.

## [1.4.1]

- Apply path/root changes on Start (restart if already running); show the active
  workspace and roots on the dashboard.

## [1.4.0]

- `checkpoint` / `resume` tools for handing off context to a fresh chat without
  losing progress.

## [1.3.0]

- Fewer round-trips and smaller payloads: trimmed default read/command output
  sizes, ripgrep fast-path search with context + glob, `find_files`, and steering
  the model toward dedicated tools instead of `run_command`.

[2.0.0]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v2.0.0
[1.6.0]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v1.6.0
[1.5.0]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v1.5.0
[1.4.1]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v1.4.1
[1.4.0]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v1.4.0
[1.3.0]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v1.3.0

## v2.0.1 — security hardening (from code review)

- Root confinement now resolves symlinks/junctions (realpath) so a link planted in the workspace cannot redirect file tools/run_command outside the roots.
- `git` raw tool in safe mode is now read-only (allowlist); mutating git (restore/checkout --/rm/branch -D/push --force/reset/clean) requires AGENT_MODE=full.
- `git_status`/`git_diff` (and dashboard /api/diff) return `is_git_repo:false` + a short error on non-git folders instead of faking "clean" or dumping git help.
- Audit log redacts sensitive arg fields (content/command/token/key/secret/password/authorization/…) so data/audit.log never stores secrets or file contents.

## v2.0.2 — security hardening v2 (raw-git lockdown + recursive redaction)

- Raw `git` tool: blocks flags that can write files, run external programs, or escape the repo (`--output`, `--no-index`, `--ext-diff`, `--git-dir`, `--work-tree`, `-c`, `-C`, `--exec-path`, `--upload-pack`, `--receive-pack`) in every mode; safe mode stays read-only-allowlist (use `git_status`/`git_diff`).
- Audit log redaction is now recursive (nested objects/arrays), so secrets/content in e.g. `apply_patch.operations[].content` / `.edits[].new_text` are never written to `data/audit.log`.
- Added a security regression suite (`npm run test:security`) + a CI `security` job: path traversal, `git --output`/`-c` blocked, mutating git blocked in safe mode, non-git handling, and no-secret-in-audit. 6/6 passing.
