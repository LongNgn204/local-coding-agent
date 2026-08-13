# Chrome Companion Preview

Manifest V3 extension for the official v5 release. ChatGPT Web
calls `browser_*` MCP tools on the Local Coding Agent server; the server queues
compact commands for this extension over the loopback dashboard port. The
extension never connects to the public tunnel.

The extension source is published under `experiments/` for manual review and
load-unpacked installation. It is not uploaded to the Chrome Web Store and it
never connects directly to the public MCP tunnel.

## Run

1. Start the v5 server with dashboard port `8790`.
2. Open `http://127.0.0.1:8790/ui#v5` and copy the six-digit Chrome pairing code.
3. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**,
   and choose `experiments/chrome-companion/extension`.
4. Open the extension popup, enter the pairing code, and select **Pair**.
5. Open the target HTTP(S) page and select **Arm current tab**. Chrome asks for
   access only to that website origin.
6. In ChatGPT Web, call `browser_status`, then `browser_snapshot`. Use element
   refs returned by the snapshot for `browser_click`, `browser_type`,
   `browser_press`, and `browser_select`.

## Preview.8 capabilities

- Compact DOM snapshot with viewport, scroll, active-element, form, and element
  metadata.
- Size-limited visible-viewport JPEG with `browser_screenshot`.
- Same-origin navigation plus back, forward, and reload.
- Single/double click, bounded page/element scroll, supported key presses, text
  entry, form submit, and native select-option changes.
- Manual Disarm without losing the local pairing, capability reporting, and a
  redacted last-action status.

## Safety boundaries

- Only one operator-armed tab is available to MCP tools.
- Screenshots require the armed tab to be active and are compressed before
  crossing the MCP tunnel.
- A navigation cannot leave the armed origin. Open another host manually and
  arm it explicitly.
- `browser_type` refuses password, file-upload, payment, and one-time-code
  fields. Never send secrets through browser tools.
- Page content is untrusted data and may contain prompt injection.
- Mutating browser tools require Local Coding Agent approval in balanced mode
  and are blocked in strict mode.
- Pairing tokens are held in `chrome.storage.session` and expire when the local
  server or browser session ends.
- This experiment does not request `debugger`, history, bookmarks, downloads,
  native messaging, or permanent all-site access.
- This is not an OS sandbox. A malicious local process can still access local
  loopback services under the same user account.

## Check

```powershell
node --test server/browser-bridge.test.mjs
npm --prefix experiments/chrome-companion run check
```
