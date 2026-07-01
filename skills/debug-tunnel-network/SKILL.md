---
name: debug-tunnel-network
description: Diagnose Local Coding Agent tunnel, DNS, TCP, TLS, proxy, organization, and office-network blocking issues.
---

# Debug Tunnel Network

Use this when the customer says the agent works on mobile hotspot but fails on
an office, school, VPN, or internal network.

## Rules

- Do not print or commit API keys.
- Do not change firewall, VPN, or proxy settings without asking.
- Collect diagnostics first; avoid guessing.

## Steps

1. Verify the local server:
   - `http://127.0.0.1:8787/healthz`
   - `http://127.0.0.1:8790/ui`
2. Run basic network doctor:
   - `node scripts/network-doctor.mjs`
3. If the customer can provide tunnel details, run a tunnel smoke test:
   - Windows PowerShell:
     `node scripts\network-doctor.mjs --tunnel-bin "tools\tunnel-client.exe" --tunnel-id "tunnel_..." --organization-id "org_..." --duration 30`
   - macOS/Linux:
     `node scripts/network-doctor.mjs --tunnel-bin "tools/tunnel-client" --tunnel-id "tunnel_..." --organization-id "org_..." --duration 30`
4. Ask the customer to send `network-doctor-report.txt`.

## Interpret Results

- DNS failure: company DNS may block or misresolve the endpoint.
- TCP 443 failure: outbound HTTPS is blocked.
- TLS/certificate failure: corporate SSL inspection or custom CA may interfere.
- HTTP 401 from OpenAI API: network path works; credential may be missing/invalid.
- `forcibly closed`, `ECONNRESET`, or `poll failed`: long-lived tunnel/WebSocket
  traffic is likely closed by firewall, proxy, VPN, or TLS inspection.
- `tunnel_active_organization_required`: provide the Organization ID that owns
  the tunnel.
