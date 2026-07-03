---
name: release-helper
description: Prepare a safe Local Coding Agent release or preview build, including version checks, tests, and changelog (v5 preview skill).
---

# Release Helper (v5 preview)

Use this to cut a release or an experimental preview build without breaking the
stable version.

## Rules

- Never commit secrets, tokens, logs with sensitive data, or the tunnel client.
- A preview build (for example `5.0.0-preview.1`) must stay clearly experimental
  and must not change stable v4 behavior by default.
- Do not tag or publish without explicit maintainer confirmation.

## Steps

1. Confirm the target version and whether it is stable or preview.
2. Run the checks:
   - `node -v` (>= 18)
   - `npm --prefix server install`
   - `npm --prefix server run test:agent`
   - `npm --prefix server run test:pro`
   - `npm --prefix server run test:security`
   - `node scripts/validate-skills.mjs`
3. Verify version references:
   - Stable version constant in `server/server.mjs` and `server/package.json`.
   - Preview version constant `PREVIEW_VERSION` for preview channels.
   - Tray app version if a Windows build is included.
4. Update `CHANGELOG.md` with a dated, clearly labeled section.
5. For a preview, confirm the feature flag default keeps v4 behavior (for
   example `AGENT_V5_PREVIEW` is off by default).
6. Only after approval: commit, tag, and push.

## Report Back

Return the version, which checks passed or failed, the changelog entry, and any
remaining blocker before publishing.
