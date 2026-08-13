---
name: release-helper
description: Prepare a safe Local Coding Agent release build, including version checks, tests, and changelog.
---

# Release Helper

Use this to cut a release without breaking the stable version.

## Rules

- Never commit secrets, tokens, logs with sensitive data, or the tunnel client.
- Do not tag or publish without explicit maintainer confirmation.

## Steps

1. Confirm the target public version.
2. Run the checks:
   - `node -v` (>= 18)
   - `npm --prefix server install`
   - `npm --prefix server run test:agent`
   - `npm --prefix server run test:pro`
   - `npm --prefix server run test:security`
   - `node scripts/validate-skills.mjs`
3. Verify version references:
   - Version constant in `server/server.mjs` and `server/package.json`.
   - Tray app version if a Windows build is included.
4. Update `CHANGELOG.md` with a dated, clearly labeled section.
5. Confirm public docs do not expose internal-only experiments.
6. Only after approval: commit, tag, and push.

## Report Back

Return the version, which checks passed or failed, the changelog entry, and any
remaining blocker before publishing.
