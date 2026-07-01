---
name: release-manager
description: Prepare and publish a Local Coding Agent release with tests, version bump, tag, GitHub Release notes, and optional assets.
---

# Release Manager

Use this when preparing a new Local Coding Agent version.

## Rules

- Do not publish until tests pass or failures are explicitly documented.
- Do not include `tools/`, tunnel clients, API keys, local config, or generated
  profiles in release assets.
- Confirm whether the release should be a tag only, GitHub Release, or Release
  plus binary assets.

## Checklist

1. Confirm version and scope.
2. Update:
   - `server/server.mjs`
   - `server/package.json`
   - `server/package-lock.json`
   - `tray-app/LocalCodingAgentTray.csproj`
   - tests that assert version
   - `CHANGELOG.md`
3. Run:
   - `npm run test:agent`
   - `npm run test:pro`
   - `npm run test:security`
   - `npm run test:hardening`
   - `npm run eval`
   - `dotnet build tray-app/LocalCodingAgentTray.csproj -c Release`
4. Commit, tag, push.
5. Create GitHub Release notes.
6. If publishing Windows tray asset, build self-contained exe and attach checksum.

## Release Notes Shape

- What's new
- Fixed/hardened
- Upgrade notes
- Verification
- Assets
