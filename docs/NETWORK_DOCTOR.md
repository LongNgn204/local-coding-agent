# Network Doctor

Use this when Local Coding Agent works on mobile hotspot but fails on an office
or school network. The script checks DNS, TCP 443, TLS, HTTPS reachability,
local MCP endpoints, optional proxy environment variables, and an optional short
`tunnel-client` smoke test.

It writes a redacted report that the customer can send back for diagnosis.

## Quick Local Check

From the cloned `local-coding-agent` folder:

```powershell
# Windows
node scripts\network-doctor.mjs
```

```bash
# macOS / Linux
node scripts/network-doctor.mjs
```

The report is written to:

```text
network-doctor-report.txt
```

## Tunnel Smoke Test

Run this on the network that fails.

Windows PowerShell:

```powershell
$env:CONTROL_PLANE_API_KEY="sk-proj-..."
node scripts\network-doctor.mjs `
  --tunnel-bin "tools\tunnel-client.exe" `
  --tunnel-id "tunnel_..." `
  --organization-id "org_..." `
  --duration 30
```

Windows CMD:

```cmd
set CONTROL_PLANE_API_KEY=sk-proj-...
node scripts\network-doctor.mjs --tunnel-bin "tools\tunnel-client.exe" --tunnel-id "tunnel_..." --organization-id "org_..." --duration 30
```

macOS / Linux:

```bash
CONTROL_PLANE_API_KEY="sk-proj-..." node scripts/network-doctor.mjs \
  --tunnel-bin "tools/tunnel-client" \
  --tunnel-id "tunnel_..." \
  --organization-id "org_..." \
  --duration 30
```

If your tunnel does not require an organization header, omit
`--organization-id`.

## What To Send Back

Send only this file:

```text
network-doctor-report.txt
```

The report redacts common API key and Authorization formats, but still review it
before sharing outside your organization.

## How To Interpret Common Results

- DNS failure: company DNS may block or misresolve the endpoint.
- TCP 443 failure: firewall is blocking outbound HTTPS to that host.
- TLS failure or certificate errors: corporate SSL inspection or custom CA may
  be interfering.
- If Node.js reports `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` but the tunnel status
  is `connected`, the network path works. Node.js and the tunnel client are
  using different CA trust stores. Configure `NODE_EXTRA_CA_CERTS` with the
  approved organization/antivirus CA only when Node-based clients need direct
  HTTPS access. Do not disable TLS verification.
- HTTPS to `api.openai.com` returns `401`: the network path works, but the key
  is missing or invalid.
- HTTPS to `api.openai.com` times out or resets: network/proxy/firewall issue.
- Tunnel log contains `forcibly closed`, `ECONNRESET`, or `poll failed`:
  long-lived tunnel/WebSocket traffic is likely being closed by firewall, proxy,
  TLS inspection, or another network policy.
- `tunnel_active_organization_required`: provide the OpenAI organization ID
  that owns the tunnel.
- `smoke_status: connected`: local MCP initialization, control-plane metadata,
  and at least one polling cycle all succeeded. A non-zero process exit caused
  by the doctor's timed shutdown is expected when `terminated_by_doctor` is
  `true`.

## Proxy Environments

If the customer network requires an HTTP proxy, try setting proxy variables
before starting the tunnel:

```powershell
$env:HTTPS_PROXY="http://proxy.company.com:port"
$env:HTTP_PROXY="http://proxy.company.com:port"
```

```cmd
set HTTPS_PROXY=http://proxy.company.com:port
set HTTP_PROXY=http://proxy.company.com:port
```

```bash
export HTTPS_PROXY=http://proxy.company.com:port
export HTTP_PROXY=http://proxy.company.com:port
```
