# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/).

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
