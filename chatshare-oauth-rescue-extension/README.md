# Chatshare OAuth Callback Rescue

This unpacked Chrome extension has two jobs:

- repair Chatshare OAuth callback routing;
- silently prove that a DevSpace OAuth request is being authorized from the PC currently running DevSpace.

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

After this one-time setup, a valid Chatshare OAuth authorization page obtains a
one-time proof from `127.0.0.1:7677` and submits automatically. There is no
password prompt or approval click while DevSpace is running normally.

Version `1.10.0` stays on the ChatGPT document at `/` and, after the
callback POST, client-navigates to
`/plugins/plugin_<id>#settings/Plugins/plugin_<id>`. A full load of that
path is HTTP 404; the extension must not `location.replace` it. `/#settings`
is only the generic settings overlay and is not the DevSpace Local page.

## Security Boundary

The extension contains no reusable device secret. DevSpace creates an in-memory
secret at startup, exposes the signer only on loopback, and accepts proofs only
for server-created one-time challenges bound to the complete OAuth request.
The extension ID and the DevSpace authorization origin are pinned in code.

Copying this extension to another computer is insufficient: that computer does
not possess the in-memory secret of the DevSpace server being authorized.
Local malware running as the same user remains outside this protection model.
