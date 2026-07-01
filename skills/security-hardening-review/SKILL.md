---
name: security-hardening-review
description: Review Local Coding Agent changes that affect file access, commands, approvals, tokens, tunnel, logs, or customer diagnostics.
---

# Security Hardening Review

Use this before merging changes to security-sensitive surfaces.

## High-Risk Areas

- `resolvePath`, roots, symlink/junction handling
- `run_command`, `run_commands`, process tools, git tools
- approval request/approve/deny/consume flow
- audit logging and redaction
- tunnel headers, API keys, auth tokens, profile generation
- dashboard approval endpoints
- support/network diagnostic reports

## Review Steps

1. Read the diff first.
2. Identify trust boundary changes.
3. Check whether secrets can appear in logs, reports, arguments, URLs, or audit.
4. Check whether one-time approvals can be replayed or raced.
5. Check whether file paths are canonicalized before root validation.
6. Check whether command batching bypasses existing policy.
7. Require tests for any security behavior change.

## Output

Use severity groups:

- Blocking
- Should fix
- Residual risk
- Suggested tests
