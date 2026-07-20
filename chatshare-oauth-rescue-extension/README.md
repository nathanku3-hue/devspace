# Chatshare OAuth Callback Rescue

A narrowly scoped Chrome Manifest V3 extension for Chatshare deployments that proxy ChatGPT connector OAuth but do not serve the connector callback document or its React Router Single Fetch loader endpoint.

## Problem repaired

Chatshare may receive a valid OAuth callback at:

```text
https://chatshare.xyz/connector/oauth/<callback-id>?code=...&state=...
```

but return `404 Not Found`. Loading the normal Chatshare application shell at that callback path also fails because its route manifest declares `routes/connector.oauth.$callback_id` with `hasLoader: true`, while the corresponding `.data` endpoint is absent.

The extension:

1. Intercepts only top-level Chatshare connector callback navigations before the 404 response.
2. Carries the original same-origin callback path and query in a URL fragment.
3. Boots the normal authenticated Chatshare application.
4. Sets `hasLoader` and `hasClientLoader` to `false` only for `routes/connector.oauth.$callback_id`.
5. Waits for Chatshare's real React Router instance and navigates to the original callback.
6. Leaves the token exchange to Chatshare's original authenticated callback component.

It does not read, log, copy, or persist authorization codes, access tokens, refresh tokens, owner credentials, or Chatshare bearer tokens.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this directory.
5. Confirm version `1.2.0`.
6. Disable older userscripts that rewrite `chatshare.xyz` callbacks to `chatgpt.com`.
7. Start a fresh OAuth authorization; previously issued authorization codes should not be reused.

## Required DevSpace server configuration

The server must allow `chatshare.xyz` and enable the one-way callback alias used by Chatshare's inconsistent registration and authorization hosts:

```text
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS=chatgpt.com,chatshare.xyz,localhost,127.0.0.1
DEVSPACE_OAUTH_REDIRECT_URI_ALIASES=https://chatgpt.com/connector/oauth/=https://chatshare.xyz/connector/oauth/
```

The actual host allowlist may contain additional deployment-specific entries.

## Diagnostics

After a failed rescued callback, inspect:

```javascript
sessionStorage.getItem("chatshare-oauth-callback-rescue-status")
```

Expected progress values include:

```text
installing-manifest-patch
manifest-patched
router-navigation-started
router-navigation-complete
```

A route or asset change on Chatshare may require updating the route ID or navigation logic. Do not broaden the extension's host permissions or redirect patterns without first proving the new callback identity.

## Confirmed result

Version `1.2.0` was verified on 2026-07-21 through an authenticated Chatshare session. After OAuth, Chatshare invoked the DevSpace MCP connector and successfully executed `open_workspace` for `E:\code`.
