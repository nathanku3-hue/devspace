# Chatshare OAuth Callback Rescue

This unpacked Chrome extension has three jobs:

- repair Chatshare OAuth callback routing;
- silently prove that a DevSpace OAuth request is being authorized from the PC currently running DevSpace;
- act as a low-cost recovery sensor for Chatshare conversations that currently hold a DevSpace recovery lease.

## One-Time Setup

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Remove the older unpacked copy if Chrome assigned it a different ID.
4. Choose **Load unpacked** and select this folder, or choose **Reload** after updating it.
   After a rescue-extension update, Reload is required before the next Chatshare connect.
5. Confirm that the extension ID is:

```text
aaoelopmdnhifffjefciagfmhjanbaoc
```

6. Start DevSpace with `setup_devspace.ps1`.
7. Chrome 142 and later may ask for **Local network access** / **Apps on device**.
   Choose **Allow**. If the Connect DevSpace page stays on
   `Checking this enrolled PC…` and never redirects, open the extension
   **Details → Site settings** and set that permission to **Allow**, then
   reload the authorize tab.

After this one-time setup, a valid Chatshare OAuth authorization page obtains a
one-time proof from `127.0.0.1:7677` and submits automatically. There is no
password prompt or approval click while DevSpace is running normally.

Version `1.15.1` recognizes the distinct `Authentication succeeded, action discovery failed`
callback failure. OAuth credentials may have been issued but Chatshare could not
load MCP actions; this is not a login failure. The extension now stops the spent
callback without replay, labels the failure `action-discovery-failed`, and links
to connector settings instead of suggesting login. Diagnose authenticated MCP
`server/discover` (2026-era clients) and/or `initialize` + `tools/list` (legacy
clients), including the upstream error cause. This does not implement the newer
MCP protocol or repair server-side discovery.

Version `1.15.0` adds lease-scoped, event-driven Chatshare recovery sensing.
The content script stays dormant on ordinary or stale conversations. DevSpace arms it
only by placing a controller-owned recovery lease marker on a managed `/c/...` page;
while armed, DOM recovery signals wake the controller immediately and a 45-second idle
timer covers silent tool-tail stalls. DevSpace still owns all resume/reconnect decisions
and keeps a 5-second Playwright fallback, so extension reloads or missed events do not
become a recovery single point of failure. After the extension has observed an active
turn finish, it marks the page settled so the controller can revoke its lease; stale
unleased tabs remain dormant.

Run `npm run test:chatshare-recovery-monitor` from `devspace-src` for the focused
sensor fixture. It proves unleased tabs stay dormant, leased recovery mutations wake the
controller channel, and revoking the lease disables the sensor again.

Version `1.14.0` treats Chatshare's `OAuth link is not owned by the user`
response as a terminal callback-ownership mismatch. The rejected callback is
removed from pending rescue state, marked non-replayable for the current tab
session, and the recovery page links back to connector settings so the user can
start a fresh authorization under the intended Chatshare account.

Version `1.13.0` also closes the logged-out callback edge case. If
Chatshare's own callback API reports `401`, `unauthorized`, or a missing access
token, the rescue keeps the pending callback in session storage and immediately
opens Chatshare's native `/pastel/#/login` UI. After login leaves that route, the
normal document shell resumes the preserved callback instead of retrying the
unauthenticated POST for 15 seconds and failing.

Version `1.12.0` also keeps Chatshare from white-screening with:

```text
Application Error
NotFoundError: Failed to execute 'removeChild' on 'Node':
The node to be removed is not a child of this node.
```

That stack is Chatshare's own React reconciler (`chatgpt-remix.openoai.net`),
not DevSpace. Chrome Translate and other page-mutating extensions wrap text
nodes React still thinks it owns. The content script now marks the document
`translate="no"` and swallows only the mismatched-parent `removeChild` /
`insertBefore` case so Chatshare does not unmount the whole app. Reload the
unpacked extension after this update.

Version `1.11.0` fetches that proof from the authorize tab, not only from the
service worker, so Chrome can show the local-network prompt. Version `1.10.0`
still stays on the ChatGPT document at `/` and, after the callback POST,
client-navigates to `/plugins/plugin_<id>#settings/Plugins/plugin_<id>`. A full
load of that path is HTTP 404; the extension must not `location.replace` it.
`/#settings` is only the generic settings overlay and is not the DevSpace Local
page.

## Security Boundary

The extension contains no reusable device secret. DevSpace creates an in-memory
secret at startup, exposes the signer only on loopback, and accepts proofs only
for server-created one-time challenges bound to the complete OAuth request.
The extension ID and the DevSpace authorization origin are pinned in code.

Copying this extension to another computer is insufficient: that computer does
not possess the in-memory secret of the DevSpace server being authorized.
Local malware running as the same user remains outside this protection model.
