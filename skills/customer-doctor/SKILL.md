---
name: customer-doctor
description: Diagnose a broken customer install and produce a redacted support report the customer can send back.
---

# Customer Doctor

Use this when a customer says "it does not work" and you need a fast, safe
diagnosis. Prefer generating a local report over pasting long logs into chat.

## Rules

- Never ask the customer to paste API keys, tunnel IDs, or auth tokens.
- The support report is redacted automatically; still review it before sending.
- Do not require the proprietary tunnel client to run these checks.

## Steps

1. Version and runtime:
   - `node -v` (must be >= 18)
   - `node scripts/local-coding-agent.mjs status`
2. Network and ports:
   - `node scripts/network-doctor.mjs` (DNS, TLS, ports 8787/8790, tunnel log)
3. Generate a support report:
   - `node scripts/support-report.mjs`
   - It writes `support-report.txt` and prints a compact summary + the path.
4. Read the summary. Common fixes:
   - Health not `ok`: server not started, or wrong workspace path.
   - Port 8787/8790 busy: another instance is running; stop it first.
   - Tunnel client missing: expected in repo tests; customer must supply it.
5. Ask the customer to send back `support-report.txt` (already redacted).

## Report Back

Return the single most likely cause, the exact command to fix it, and the path
to the redacted `support-report.txt`.
