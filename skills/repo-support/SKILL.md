---
name: repo-support
description: Help an AI agent understand and work in this repo quickly using the low-round-trip MCP tools and the anti-lag workflow (v5 preview skill).
---

# Repo Support (v5 preview)

Use this to orient a coding agent inside a customer or developer workspace with
the fewest possible tool round-trips, keeping the ChatGPT thread fast.

## Rules

- Start with one wide call, not many tiny ones.
- Do not re-read files you already read; read only the line range you need.
- For long output, store it locally (v5 `save_report`) instead of pasting it.

## Steps

1. Map the repo in one call: `workspace_snapshot` (or `repo_map`).
2. Find code with `search_text` (ripgrep fast path) and `repo_symbols`.
3. Read narrowly with `read_file` line ranges or `read_many`.
4. Edit with `preview_patch` -> `validate_patch` -> `apply_patch`, then
   `run_changed_tests`.
5. Before handoff, call `session_report`. If the thread is long, call
   `checkpoint`, open a NEW ChatGPT chat, and call `resume` first.
6. v5 preview: for large logs/output, call `save_report(title, content)` and
   share the returned id + the dashboard link instead of the raw text.

## Report Back

Return what the repo is, the key files touched, test status, and the report id
or local path for any long output.
