# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/).

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
