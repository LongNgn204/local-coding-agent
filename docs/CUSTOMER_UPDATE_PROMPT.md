# Customer Update Prompt

Give this prompt to a customer's AI coding agent when they already have a local
clone of Local Coding Agent and want to update safely.

```text
Please update my Local Coding Agent installation safely.

Repository:
https://github.com/LongNgn204/local-coding-agent

Goal:
Update my local clone to the latest version, preserve my local config/secrets
and tunnel-client, reinstall dependencies if needed, restart the agent only if
I ask, and verify the result.

Rules:
- Do not delete my workspace.
- Do not delete tools/tunnel-client or any tunnel-client binary.
- Do not commit, print, upload, or expose API keys, Runtime keys, tunnel IDs,
  auth tokens, local config, generated profiles, or support reports.
- Do not run destructive git commands such as reset --hard, git clean, or file
  deletion unless I explicitly approve.
- If the repo has local changes, show me git status and ask before continuing.
- Default to mode=safe and policy=balanced.
- Use the universal CLI first. Use the Windows tray app only if I ask for GUI.

Steps:
1. Find my local local-coding-agent folder.
2. Run:
   git status --short --branch
3. If there are local changes, summarize them and ask me before continuing.
4. Fetch updates:
   git fetch origin main --tags
5. Show incoming changes:
   git log --oneline --decorate --max-count=10 HEAD..origin/main
6. Update safely:
   git pull --ff-only origin main
7. Install/update dependencies:
   - Windows:
     scripts\lca.cmd install
   - macOS/Linux:
     bash scripts/lca install
8. Validate scripts and skills:
   node --check scripts/local-coding-agent.mjs
   node --check scripts/network-doctor.mjs
   node scripts/validate-skills.mjs
9. Run doctor/status:
   - Windows:
     scripts\lca.cmd doctor
     scripts\lca.cmd status
   - macOS/Linux:
     bash scripts/lca doctor
     bash scripts/lca status
10. If I want it restarted:
   - Windows:
     scripts\lca.cmd stop
     scripts\lca.cmd start
   - macOS/Linux:
     bash scripts/lca stop
     bash scripts/lca start
11. Verify:
   - http://127.0.0.1:8787/healthz returns status ok when the server is running
   - http://127.0.0.1:8790/ui opens the dashboard when the dashboard is enabled
12. Report back:
   - current git commit
   - current version
   - MCP URL
   - dashboard URL
   - workspace path
   - mode and policy
   - tunnel status
   - any failed check and the exact next fix
```

## Short Prompt

```text
Update Local Coding Agent for me.

Repo:
https://github.com/LongNgn204/local-coding-agent

Please:
1. Check git status and ask before overwriting local changes.
2. Pull latest main safely with git pull --ff-only.
3. Run the CLI install command.
4. Validate scripts and skills.
5. Run doctor/status.
6. Restart only if I approve.
7. Do not expose or commit secrets, API keys, tunnel IDs, local config, or tunnel profiles.

Use:
- Windows: scripts\lca.cmd install / doctor / status / stop / start
- macOS/Linux: bash scripts/lca install / doctor / status / stop / start

Report the version, MCP URL, dashboard URL, workspace path, mode, policy, and tunnel status.
```
