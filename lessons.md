# DevSpace Durable Lessons

## 2026-09-06 — ChatGPT 502 was setup thrash; a healthy origin is sacred

Repeated 502s (Worker probe 530) were public-path outages caused by full setup recycling a live origin. Canonical `scripts/setup-devspace.ps1` used to **stop → `npm run build` (`rmSync dist`) → maybe start**. A failed build after killing Node left the Worker on a dead quick tunnel. Concurrent setups and discovery/inventory teardowns did the same.

**Invariant:** if local `/healthz` is verified JSON `{ok:true,name:"devspace"}`, never stop Node and never mutate live `dist`. Repair a live tunnel with `/set-tunnel` only. A dead quick tunnel may remint a hostname. Extra-check failures preserve the origin. Recycle only when origin is down.

**Operator entrance:** `E:\Code\devspace\setup_devspace.ps1`. Never launch production setup from a Git worktree. Healthy local+Worker `/healthz` makes setup a no-op.

**Fix (closed):** heal ladder, exclusive lock, fail-open, staged `dist-previous` snapshot, JSON healthz, `*.trycloudflare.com` Host allowlist, PowerShell lifecycle tests. Named tunnel remains the structural end state.

---

# Perplexity MCP OAuth Debugging Lessons

Date: 2026-07-16
Project root: `E:\Code\devspace`
Runtime: Windows PowerShell 5.1, Node.js v25.2.1, Cloudflare Worker proxy plus Cloudflare Quick Tunnel

## Outcome

The debugging session found and corrected three independent compatibility problems in sequence:

1. Dynamic client registration rejected Perplexity redirect hosts because DevSpace used an exact hostname allowlist.
2. Perplexity registered redirect URIs across both `perplexity.ai` subdomains and four specific `perplexity.com` hosts that were not initially known.
3. Registration then succeeded, but authorization failed before the owner-password form because Perplexity omitted the optional OAuth `resource` parameter and DevSpace treated omission as an error.

The final implementation was built and restarted. The transcript does not contain a final post-patch successful Perplexity token exchange, so end-to-end success should be confirmed separately rather than assumed.

## Initial symptom

Perplexity dynamic client registration failed with:

```text
[API_CLIENTS_ERROR]
Registration failed: 400
Client redirect_uri is not allowed for this DevSpace server
```

The public MCP endpoint and OAuth discovery documents were otherwise healthy:

- Protected resource metadata resolved through the stable Worker proxy.
- Authorization-server metadata advertised `/authorize`, `/token`, `/revoke`, and `/register`.
- The Worker proxy forwarded to a changing Cloudflare Quick Tunnel URL.

## Architecture facts established during debugging

- The outer launcher is `E:\Code\devspace\setup_devspace.ps1`.
- The application repository is `E:\Code\devspace\devspace-src`.
- The stable public endpoint is `https://devspace-proxy.kitlongku.workers.dev`.
- Every launcher restart creates a new `trycloudflare.com` tunnel and registers it behind the stable Worker proxy.
- OAuth redirect policy is enforced in `devspace-src/src/oauth-store.ts`.
- Launcher-specific redirect hosts are supplied through `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS`.
- OAuth authorization behavior is implemented in `devspace-src/src/oauth-provider.ts`.
- Existing Node processes retain the environment and compiled code loaded at process start. Editing source or the launcher does not alter a running server.

## Debugging chronology

### 1. Locate the actual policy boundary

The initial inspection found:

- Package defaults allowed `chatgpt.com`, `localhost`, and `127.0.0.1`.
- The machine launcher additionally allowed `claude.ai`.
- Redirect validation compared each URI hostname against the allowlist using exact equality.

An early broad package-default change was deliberately reverted. Perplexity support was initially treated as a machine deployment concern rather than silently weakening every DevSpace installation.

Lesson: change the narrowest configuration surface first. Package-wide defaults should not be broadened merely to repair one deployment.

### 2. Add initial Perplexity hosts

The launcher was first changed to include:

```text
perplexity.ai,www.perplexity.ai
```

Focused OAuth tests, typecheck, build, and the full test suite passed.

A live registration probe still showed the old rejection until the server restarted. After restart, direct POST registration for `https://www.perplexity.ai/...` returned HTTP 201.

Lesson: distinguish configuration correctness from process activation. A passing source test does not prove the live process loaded the new environment.

### 3. Prove the failure was not stale runtime

Perplexity still failed after restart. A synthetic registration using:

```text
https://mcp.perplexity.ai/oauth/callback
```

was used as a discriminator.

- HTTP 201 meant the restarted server had loaded wildcard-capable code.
- Therefore the remaining Perplexity callback was outside the known `perplexity.ai` identities.

Lesson: use one diagnostic request that cleanly separates competing hypotheses instead of repeatedly broadening configuration.

### 4. Add strict wildcard-host support

`redirectHostAllowed` was extended to support explicit entries of the form:

```text
*.perplexity.ai
```

The match is a strict DNS-label suffix match:

- Accepts `mcp.perplexity.ai`.
- Does not make the apex implicit, so `perplexity.ai` remains separately listed.
- Rejects `evilperplexity.ai`.
- Rejects `perplexity.ai.evil.example`.
- Exact-host behavior remains unchanged for all non-wildcard entries.

Regression tests were added for accepted root/subdomain cases and malicious look-alikes.

Lesson: wildcard syntax must be explicit and implemented as label-boundary matching, not `includes`, naive suffix matching, or a global domain relaxation.

### 5. Instrument rejected redirect identities safely

Public documentation and Perplexity web assets did not expose the callback set reliably. Rather than logging full redirect URIs, DevSpace was changed to include only a sanitized identity in the OAuth error:

- For HTTP(S), return only the lowercase `host`.
- For custom schemes, return only the scheme.
- Never return path, query, fragment, authorization code, state, or credentials.

Example diagnostic error:

```text
Client redirect_uri is not allowed for this DevSpace server: diagnostic.example
```

A PowerShell-native diagnostic request confirmed that the new bundle was actually loaded.

Lesson: observability should reveal the minimum identity needed to fix policy. Full callback URLs are unnecessary and may expose sensitive state or tenant information.

### 6. Correct PowerShell request construction

An initial `curl.exe --data-binary` command using inline single-quoted JSON produced malformed JSON under Windows PowerShell 5.1:

```text
SyntaxError: Expected property name or '}' in JSON
```

The reliable pattern was:

```powershell
$body = @{
  redirect_uris = @("https://diagnostic.example/oauth/callback")
  client_name   = "diagnostic-probe"
} | ConvertTo-Json -Compress

try {
  Invoke-RestMethod `
    -Method Post `
    -Uri "https://devspace-proxy.kitlongku.workers.dev/register" `
    -ContentType "application/json" `
    -Body $body
} catch {
  $_.ErrorDetails.Message
}
```

Lesson: on Windows PowerShell 5.1, prefer `ConvertTo-Json` plus `Invoke-RestMethod` for JSON diagnostics. Avoid copying Bash-style quoting assumptions into `curl.exe` commands.

### 7. Discover the complete Perplexity redirect set

The sanitized live error revealed four additional redirect identities:

```text
www.perplexity.com
enterprise.perplexity.com
n.perplexity.com
staging.perplexity.com
```

The launcher was updated with those four exact hosts. A wildcard for `*.perplexity.com` was intentionally not added.

Final launcher policy:

```text
chatgpt.com
claude.ai
perplexity.ai
*.perplexity.ai
www.perplexity.com
enterprise.perplexity.com
n.perplexity.com
staging.perplexity.com
localhost
127.0.0.1
```

A focused runtime probe confirmed all four exact `.com` hosts were accepted while an unlisted `.com` subdomain remained rejected.

Lesson: when a client registers a known finite callback set, exact identities are preferable to a broad production-domain wildcard.

### 8. Separate registration failure from authorization failure

After registration began passing, Perplexity displayed:

```text
Authentication Failed
Connection failed. This page will close automatically.
```

This was a different phase and required a new hypothesis set. Relevant server behavior showed:

- Perplexity reached discovery endpoints.
- Perplexity successfully submitted dynamic registration.
- Failure occurred before the DevSpace owner-password form appeared.

The Perplexity client also requested:

```text
/mcp/.well-known/oauth-protected-resource
```

which returned 404, but it then fell back to supported metadata and continued. This 404 was therefore not the blocking cause.

Lesson: do not keep modifying registration after the protocol has advanced to authorization. Classify failures by OAuth phase: discovery, registration, authorization, callback, token exchange, or authenticated MCP request.

### 9. Fix omitted OAuth `resource` compatibility

DevSpace authorization previously required:

```ts
params.resource
```

and rejected a request when it was missing:

```text
Invalid or missing OAuth resource
```

The SDK schema permits `resource` to be omitted. Perplexity omitted it, causing an error redirect to its callback before the owner-password form could render.

The provider was changed so that:

- Omitted `resource` defaults to DevSpace's configured MCP resource URL.
- The normalized resource is carried through the approval form and authorization-code record.
- An explicitly supplied mismatched resource remains rejected.
- Issued tokens remain bound to the configured DevSpace MCP resource.

Regression coverage verifies both omission compatibility and mismatched-resource rejection.

Lesson: optional protocol parameters should not become mandatory through application policy unless the server explicitly advertises and enforces that requirement. A safe default can preserve resource binding without breaking compliant clients.

## Validation performed

The final changes were validated through multiple independent gates:

- Focused OAuth client-store tests.
- Wildcard and malicious-look-alike redirect tests.
- Sanitized rejected-identity tests.
- Authorization test with omitted `resource`.
- Authorization test rejecting a mismatched explicit resource.
- TypeScript typecheck.
- Full Windows test suite.
- Production build through Vite and `tsc -p tsconfig.build.json`.
- Compiled-runtime probes, not only source-level tests.
- PowerShell launcher parser check.
- Live OAuth registration probes through the Worker proxy.
- Live diagnostic error verification after process restart.

The Vite build emitted only the existing large-chunk warning.

## Repository and tooling lessons

### Preserve line endings

Targeted edits through the local tool twice converted complete TypeScript files to CRLF, creating misleading whole-file diffs. The files were rewritten with LF to restore focused semantic diffs.

Lesson: inspect `git diff --stat` immediately after automated edits. A tiny semantic change producing hundreds of changed lines usually indicates line-ending churn.

### Use focused hygiene checks in a pre-dirty repository

The repository already contained broad modified-file and CRLF noise unrelated to this work. A global `git diff --check` therefore failed on pre-existing files.

The appropriate check was scoped to files changed by this debugging session.

Lesson: record pre-existing dirt, do not clean or overwrite unrelated work, and use focused validation when global repository hygiene is already red.

### Do not claim process actions that were not performed

The local shell connector permits tests, builds, inspection, and searches, but not operational process management. Restarts were therefore performed manually through:

```powershell
powershell.exe -ExecutionPolicy Bypass -File E:\code\devspace\setup_devspace.ps1
```

Lesson: distinguish a code fix from activation. Report exactly what was edited, built, probed, and manually restarted.

### Live registration probes have state effects

Successful dynamic registration probes create OAuth client records in the SQLite state store. They are useful but not side-effect-free.

Lesson: use successful registration probes sparingly, give them identifiable client names, and consider later cleanup or expiration policy for diagnostic clients.

## Durable debugging procedure for future MCP OAuth clients

1. Verify the stable public MCP URL and both discovery documents.
2. Determine the failing OAuth phase from status codes, paths, and user-agent logs.
3. For registration failures, expose only sanitized rejected redirect identities.
4. Add exact hosts first; use explicit wildcards only when callback subdomains are genuinely dynamic.
5. Rebuild and restart before judging the live result.
6. Use a synthetic request that distinguishes stale runtime from incorrect policy.
7. For authorization failures, inspect `redirect_uri`, PKCE fields, scope, state, and optional `resource` handling separately.
8. Preserve strict rejection of mismatched redirect URIs and resources while adding compatibility for omission or known variants.
9. Validate source tests, compiled runtime, and the public proxied endpoint.
10. Confirm the final token exchange and authenticated MCP call before declaring end-to-end completion.

## Files changed during this debugging session

Deployment launcher:

- `setup_devspace.ps1`

Application source and tests:

- `devspace-src/src/oauth-store.ts`
- `devspace-src/src/oauth-store.test.ts`
- `devspace-src/src/oauth-provider.ts`

Generated production output was rebuilt under:

- `devspace-src/dist`

## Final verification still required

After the final restart, verify all of the following in one fresh Perplexity connection:

1. Dynamic registration returns success.
2. The browser displays the DevSpace owner-password approval form.
3. Approval redirects to one of the registered Perplexity callbacks.
4. Perplexity exchanges the authorization code successfully at `/token`.
5. The first authenticated `/mcp` request succeeds with the issued bearer token.

Only after step 5 is observed should the integration be considered fully closed.

---

# Chatshare OAuth Callback Rescue Lessons

Date: 2026-07-21
Client: `https://chatshare.xyz`
Server: `https://devspace-proxy.kitlongku.workers.dev`
Final client workaround: `chatshare-oauth-rescue-extension` version `1.2.0`

## Confirmed outcome

The Chatshare integration is now end-to-end functional. After completing OAuth, Chatshare invoked the `DevSpace Local` connector and successfully opened `E:\code` as the active checkout workspace. This is stronger evidence than a successful redirect or token response alone because it proves the complete chain:

```text
OAuth registration
-> owner approval
-> callback handling
-> token exchange
-> authenticated MCP connection
-> tool discovery
-> open_workspace execution
```

The user-supplied success screenshot showed the `DevSpace Local` tool call and the returned workspace card for `E:\code`. No authorization code, state value, access token, refresh token, owner token, or browser credential is recorded in this document.

## Failure chain and root causes

### 1. Registration and authorization used different callback hosts

Chatshare reused an OAuth client registered with:

```text
https://chatgpt.com/connector/oauth/<callback-id>
```

but later authorized with:

```text
https://chatshare.xyz/connector/oauth/<same-callback-id>
```

The MCP SDK correctly rejected the second URI because OAuth redirect URIs require exact registration matching.

DevSpace added a narrowly scoped, one-way redirect alias:

```text
https://chatgpt.com/connector/oauth/
->
https://chatshare.xyz/connector/oauth/
```

The alias preserves the remaining path, query, and fragment, applies only to HTTPS bases ending in `/`, requires the destination host to remain allowlisted, and does not create a reverse alias or wildcard match.

Lesson: compatibility aliases must be explicit transformations over already registered URIs, not global relaxation of redirect matching.

### 2. Chatshare did not serve its callback route

After authorization succeeded, the browser reached:

```text
https://chatshare.xyz/connector/oauth/<callback-id>?code=...&state=...
```

Chatshare returned HTTP 404 `Not Found`. The DevSpace server had already done its part; the failure was now in the client callback surface.

Lesson: classify callback routing separately from authorization and token issuance. A successful authorization redirect does not prove the client can consume it.

### 3. The old Tampermonkey script was not a reliable solution

The previous userscript attempted to rewrite Chatshare redirect URIs back to `chatgpt.com` and forward callbacks through the Chatshare homepage. It failed for three reasons:

- Rewriting the registration host caused the original exact-match conflict.
- Chatshare returned the missing callback as `text/plain` 404, where userscript injection was not dependable.
- `https://chatshare.xyz/?mcp_callback=...` redirected to `/pastel/` and discarded the callback query parameters.

Lesson: a userscript cannot be considered a routing fix when the server response prevents dependable script execution or strips the handoff parameters before application startup.

### 4. Pre-response interception was required

A Manifest V3 Chrome extension was introduced with `declarativeNetRequest` rules. It intercepts the top-level callback request before the 404 response and redirects it to the normal authenticated Chatshare application shell while preserving the callback path and query inside a same-origin URL fragment.

This solved the server-level 404 but exposed the next client-framework defect.

Lesson: when a third-party server omits a document route, intercept before navigation response rather than trying to repair the resulting error document.

### 5. Restoring the callback URL exposed a broken Remix loader declaration

Chatshare's route manifest contains:

```text
routes/connector.oauth.$callback_id
hasLoader: true
```

However, Chatshare serves neither the callback document route nor the corresponding React Router Single Fetch `.data` route. Early extension versions restored the callback URL and attempted to inject `loaderData: null`, but React Router later issued another data request and raised:

```text
No result found for routeId "routes/connector.oauth.$callback_id"
```

Lesson: patching initial hydration data does not disable later loader execution. The route metadata controlling the request must be corrected instead.

### 6. Final version 1.2 disables only the nonexistent loader

The callback module itself does not consume loader data. Its effect uses Chatshare's already authenticated API client to submit the complete callback URL to:

```text
/aip/connectors/links/oauth/callback
```

Version `1.2.0` therefore performs the minimum client repair:

1. Intercept the missing callback route before 404.
2. Boot Chatshare at its normal authenticated application shell.
3. Patch only `routes/connector.oauth.$callback_id` so `hasLoader` and `hasClientLoader` are false.
4. Wait for Chatshare's real `__reactRouterDataRouter` instance.
5. Navigate through that router to the original callback URL.
6. Let Chatshare's original callback component use its own bearer token, device headers, cookies, state handling, and post-auth navigation.

The extension does not reproduce Chatshare authentication, extract credentials, log authorization codes, or call DevSpace's token endpoint itself.

Lesson: when the original client component is correct but framework metadata is wrong, repair only the metadata and delegate the sensitive operation back to the original authenticated code.

## Verification performed

Server-side validation:

- Exact Chatshare callback registration returned HTTP 201.
- Authorization accepted the exact registered callback.
- A mismatched callback remained rejected.
- Redirect alias parsing rejected insecure or malformed bases.
- Focused OAuth tests passed.
- Full test suite passed.
- TypeScript typecheck passed.
- Production build passed.
- Compiled-runtime alias probe passed for the previously failing client record.

Client-side validation:

- Real Chatshare callback interception occurred before the 404 response.
- Logged-out routing failed explicitly at `/pastel/` instead of silently losing the callback.
- Controlled Chromium tests reproduced the production `No result found for routeId` condition unless the loader flag was disabled.
- Version `1.2.0` disabled the callback loader before router navigation.
- The original full callback URL was preserved through the simulated callback component.
- The callback reached its returned success destination.
- Final authenticated user verification completed an actual DevSpace MCP tool call.

## Durable procedure for proxied OAuth clients

1. Compare the URI used at dynamic registration with the URI sent to `/authorize` byte for byte.
2. Keep exact redirect validation; add only explicit one-way aliases for proven proxy-host substitutions.
3. After authorization, verify whether the callback document route and framework data route both exist.
4. Do not assume a homepage query bridge is consumed; inspect the actual application bundle and network behavior.
5. Prefer pre-response browser interception over error-page injection for server-level 404s.
6. For React Router or Remix errors, distinguish initial hydration from later Single Fetch loader requests.
7. Inspect whether the callback component actually needs loader data before synthesizing or disabling it.
8. Reuse the application's authenticated router and API client rather than copying bearer tokens into extension code.
9. Treat a token response as intermediate evidence; close only after an authenticated MCP tool succeeds.

## Files associated with the Chatshare fix

DevSpace server source and tests:

- `src/config.ts`
- `src/config.test.ts`
- `src/oauth-provider.ts`
- `src/oauth-store.ts`
- `src/oauth-store.test.ts`

Client compatibility extension:

- `chatshare-oauth-rescue-extension/README.md`
- `chatshare-oauth-rescue-extension/manifest.json`
- `chatshare-oauth-rescue-extension/rules.json`
- `chatshare-oauth-rescue-extension/callback-bootstrap.js`

Deployment configuration also sets:

```text
DEVSPACE_OAUTH_REDIRECT_URI_ALIASES=https://chatgpt.com/connector/oauth/=https://chatshare.xyz/connector/oauth/
```

## Final status

Chatshare OAuth and authenticated DevSpace MCP execution are confirmed working as of 2026-07-21. The workaround remains coupled to Chatshare's current route ID and client architecture, so future Chatshare asset or routing changes should be diagnosed from the extension status marker:

```javascript
sessionStorage.getItem("chatshare-oauth-callback-rescue-status")
```

---

# Chatshare.xyz Compatibility Revalidation Lessons

Date: 2026-08-01
Client: `https://chatshare.xyz`
Classification: Chatshare.xyz compatibility stream. This is not `WEB-CONNECTOR-1`.
Live extension: unpacked `chatshare-oauth-rescue-extension` version `1.3.0`

## Confirmed outcome

The compatibility flow was confirmed end to end from Chatshare. The enrolled-PC
authorization completed, Chatshare exchanged the authorization code, DevSpace
persisted device-bound access and refresh tokens, authenticated MCP sessions were
created, and the user successfully invoked `DevSpace Local` to run
`open_workspace` for `E:\code`.

The authoritative acceptance evidence is the authenticated tool execution and
returned workspace card. A callback page that looks unfinished is not evidence
that OAuth failed.

No authorization code, state value, access token, refresh token, device proof,
or browser credential is recorded here.

## Failure sequence and lessons

### 1. The enrolled-PC check could appear to hang

The authorization page displayed:

```text
Checking this enrolled PC...
```

and the Retry button appeared to do nothing. The live extension disabled Retry
while awaiting `chrome.runtime.sendMessage`, but had no bounded timeout. A stale
content script or sleeping extension service worker could therefore leave the
page indefinitely in the checking state even though the loopback signer at
`127.0.0.1:7677` was healthy.

Reloading the unpacked extension and starting a fresh OAuth attempt restored the
flow. Reusing the old authorization URL was unsafe because its OAuth challenge
was short-lived.

Lesson: every browser-extension relay must have a bounded timeout, explicit
service-worker and loopback failure messages, and guaranteed Retry
re-enablement. A visually enabled-looking button must not actually be disabled
without distinct styling.

### 2. Cloudflare error 1016 was a separate transport failure

After the extension was installed, the browser encountered:

```text
Error 1016: Origin DNS error
```

This did not originate in OAuth or the extension. The stable Worker proxy was
still targeting an expired Quick Tunnel hostname. Creating and registering a
fresh tunnel restored the public `/healthz` path.

Lesson: diagnose the integration by layer. Cloudflare origin routing, OAuth
authorization, callback handling, token exchange, and authenticated MCP are
separate gates. Temporal proximity does not establish causation.

### 3. The callback UI did not reliably show completion

The browser successfully returned through the rescued Chatshare callback route,
but the page did not visibly return to connector settings or show a clear
connected state. Server evidence nevertheless showed successful token exchange,
device-bound token persistence, and subsequent authenticated MCP requests.

The final real user action then succeeded:

```text
Chatshare conversation
-> DevSpace Local
-> open_workspace E:\code
-> workspace card returned
```

Lesson: post-auth navigation and connector UI refresh are presentation concerns,
not the authority for connection state. Treat them as a separate UX defect once
a real authenticated tool call succeeds.

### 4. Use an evidence hierarchy for OAuth closure

The strongest-to-weakest evidence order is:

1. A real authenticated MCP tool invocation succeeds.
2. An authenticated MCP session initializes and discovers tools.
3. The client exchanges the authorization code and receives tokens.
4. The browser reaches the callback route.
5. The UI displays a success message.

Lesson: close compatibility work on the highest available protocol and product
evidence, not on redirect appearance alone. Keep receipts free of authorization
codes, state values, tokens, and device proofs.

### 5. Keep the stream classification exact

This work repairs Chatshare-specific compatibility across redirect aliasing,
missing callback routing, React Router metadata, enrolled-PC authorization, and
post-auth recovery. It does not implement the `WEB-CONNECTOR-1` product slice,
review return, browser response capture, or reviewer orchestration.

Lesson: a successful Chatshare-to-DevSpace connection proves this compatibility
stream. It must not be used to silently advance a separate roadmap slice.

### 6. Live deployment and repository custody were temporarily different

The successful live run used the unpacked extension at:

```text
E:\Code\devspace\chatshare-oauth-rescue-extension
```

with version `1.3.0`, while the repository copy in this checkout still described
version `1.2.0`. The live result is valid product evidence, but the deployment
artifact and tracked source should be reconciled before claiming exact-SHA
reproducibility for version `1.3.0`.

Lesson: functional acceptance and source custody are distinct. Record both
honestly rather than downgrading a real success or overstating reproducibility.

## Final status

Chatshare.xyz compatibility is functionally confirmed as of 2026-08-01 through
a real authenticated `open_workspace E:\code` invocation. The remaining known
issues are non-blocking callback UX ambiguity, missing timeout behavior in the
device-proof relay, and temporary live-source custody divergence. These findings
belong to the Chatshare.xyz compatibility stream, not `WEB-CONNECTOR-1`.

---

# Chatshare Rescue 1.4.0 Hash Collision and Plugin Binding Lessons

Date: 2026-08-16
Client: `https://chatshare.xyz`
Server: `https://devspace-proxy.kitlongku.workers.dev`
Live extension: `E:\Code\devspace\chatshare-oauth-rescue-extension` version `1.4.0`
Confirmed close: authenticated Chatshare chat opened `E:\code\meta-harness` after a new conversation on the connected connector.

No authorization code, state value, access token, refresh token, owner token, or browser credential is recorded in this document.

## Confirmed outcome

The public path was healthy the entire incident. Local `/healthz`, the current quick tunnel, and the Worker proxy all returned DevSpace JSON. Device-proof auto-approval issued 302s. The break was never a 502/530 custody failure.

Version `1.4.0` unblocked callback consumption. After reload, Chatshare exchanged the code, DevSpace issued a device-bound access and refresh token, and `openai-mcp/1.0.0 (ChatGPT)` created authenticated MCP sessions.

End-to-end close required one more Chatshare-side step: start a **new** chat from the connected plugin. An older conversation continued to report the plugin as not installed even after MCP was live.

## Failure chain

### 1. Rescue landed on a hash that Chatshare already uses

The `1.3.0` DNR rule rewrote the missing callback to:

```text
https://chatshare.xyz/#cs_oauth_callback=/connector/oauth/<id>?<query>
```

Chatshare's ChatGPT shell uses `location.hash` for `#settings` and `#settings/Plugins`. Leaving the rescue fragment in the address bar blocked that router. Logged-in users stayed on the hash URL. Logged-out users no longer reached `/pastel/#/login` the way they used to.

`sessionStorage.getItem("chatshare-oauth-callback-rescue-status") === "router-navigation-complete"` only proves the extension navigated. It does not prove Chatshare posted `/aip/connectors/links/oauth/callback` or that DevSpace `/token` ran.

Lesson: do not store a third-party handoff in a fragment the host app already uses for its own client router.

### 2. Console CORS errors were ChatGPT telemetry, not OAuth

Red `chatgpt.com/ces/...` failures from origin `chatshare.xyz` are Statsig analytics blocked by CORS. They are unrelated to DevSpace authorization or MCP.

Lesson: classify connector console noise before treating it as the failure.

### 3. Token absence meant Chatshare never called `/token`

OAuth paths are logged as `/` by the mounted provider. Diagnose token exchange from the OAuth store, not from a `/token` path histogram. A new Chatshare client with zero access and zero refresh tokens means the callback API never reached DevSpace, even if authorize returned 302.

Authorization codes are in-memory. A DevSpace restart invalidates every outstanding code.

Lesson: close OAuth on a persisted token row plus an authenticated `/mcp` session, not on a 302 alone.

### 4. A second connector name is not the same as a connected chat

After reconnect, Chatshare had two plugins: an older dead `DevSpace Local` and a new `DevSpace Local2` that actually held the live token. A conversation that asked for Local2 still reported:

```text
the requested DevSpace Local2 dev plugin is currently reported as not installed,
and no callable DevSpace actions are exposed
```

DevSpace never received `open_workspace`. `E:\code\meta-harness` existed and is inside the allowed root `E:\Code`. The model had no tools in that thread.

`/mcp` HTTP 400 `"No valid MCP session"` is ChatGPT probing without a session id, then retrying initialize. It is not a plugin-install failure.

Lesson: account-level OAuth and MCP health do not attach tools to an old Chatshare conversation. Start a new chat from the connected plugin page. Do not create a third connector.

## Version 1.4.0 repair

1. Intercept the 404 callback as before.
2. Land on `/?surface=work#cs_oauth_callback=...` so the authenticated ChatGPT shell boots.
3. Stash the callback path and query in `sessionStorage`.
4. Clear the rescue hash immediately so `#settings` can work.
5. If the document is `/pastel/` or the Vue account shell, redirect to `/pastel/#/login`.
6. If Remix never appears, take the same login redirect instead of leaving the hash URL on screen.
7. When `__reactRouterDataRouter` is ready, navigate to the original callback path and let Chatshare's own callback component POST `full_redirect_url`.

Verified:

- `test-device-authorization.mjs` passed.
- `test-callback-rescue.mjs` passed, including hash-cleared before the callback POST.
- `test-real-routing.mjs` against live Chatshare ended at `/pastel/#/login` when logged out.
- After extension reload, DevSpace stored a live device-bound token pair and accepted `openai-mcp` sessions.
- User-confirmed close: a new Local2 chat opened `E:\code\meta-harness`.

## Durable procedure additions

1. If the address bar is stuck on `#cs_oauth_callback=...`, the rescue hash is colliding with Chatshare's hash router. Reload extension `1.4.0` and start a fresh authorization.
2. Ignore `chatgpt.com/ces/...` CORS lines.
3. After `router-navigation-complete`, check the OAuth store for a new token pair and the serve log for `openai-mcp` `/mcp` 200s.
4. If tokens and MCP are live but the model says the plugin is not installed, do not recycle the tunnel. Open a new chat from the connected plugin. Disable the older dead connector.
5. Treat `open_workspace` on a real allowed path as the close signal.

## Files

- `chatshare-oauth-rescue-extension/callback-bootstrap.js`
- `chatshare-oauth-rescue-extension/rules.json`
- `chatshare-oauth-rescue-extension/manifest.json`
- `chatshare-oauth-rescue-extension/README.md`
- `chatshare-oauth-rescue-extension/test-callback-rescue.mjs`
- `chatshare-oauth-rescue-extension/test-real-routing.mjs`

## Final status

Chatshare OAuth, token exchange, MCP tool discovery, and `open_workspace` on `E:\code\meta-harness` are confirmed working as of 2026-08-16 with rescue extension `1.4.0`. The live unpacked path remains `E:\Code\devspace\chatshare-oauth-rescue-extension`. Diagnose later Chatshare routing changes from:

```javascript
sessionStorage.getItem("chatshare-oauth-callback-rescue-status")
```

---

# Chatshare Rescue 1.5.0 Work-Surface Trap Lessons

Date: 2026-08-17
Client: `https://chatshare.xyz`
Server: `https://devspace-proxy.kitlongku.workers.dev`
Live extension: `E:\Code\devspace\chatshare-oauth-rescue-extension` version `1.5.0`
Confirmed close: user-reported success after reloading `1.5.0` and starting a fresh Chatshare authorization.

No authorization code, state value, access token, refresh token, owner token, or browser credential is recorded in this document.

## Confirmed outcome

Version `1.4.0` unblocked hash-router collision by landing on `/?surface=work`. That query boots the ChatGPT chat shell, not the settings/connector Remix tree. A logged-in reconnect therefore issued a DevSpace authorization code and then stalled: Chatshare never posted `/aip/connectors/links/oauth/callback` and DevSpace never saw `/token`.

Version `1.5.0` leaves `surface=work` with a full navigation to `/` before the original callback component runs. User-confirmed close followed a reload of the unpacked `1.5.0` extension and a fresh connector authorization.

## Failure

A logged-in reconnect at 13:51 landed on `/?surface=work#cs_oauth_callback=...`. The rescue cleared the hash and the ChatGPT work shell booted (document title `ChatGPT`). DevSpace had already issued the authorization code (`POST /` 302). Chatshare never called `/token`. The tab stayed on `https://chatshare.xyz/?surface=work`.

`/?surface=work` is the chat surface (`/c/...`, plugin hints). Connector OAuth lives on the settings Remix tree at `/` and `/plugins` (`#settings/Plugins`). Client-side `router.navigate('/connector/oauth/...')` on the work surface does not mount the callback component, so `/aip/connectors/links/oauth/callback` never runs.

Unauthenticated `/?surface=work` still 302s to `/pastel/`. That is expected and is not this bug.

## Version 1.5.0 repair

1. DNR lands on `/#cs_oauth_callback=...` again, not `/?surface=work`.
2. If the document still has `surface=work` (old 1.4.0 DNR, or Chatshare's own redirect), stash the callback and `location.replace('/')` so a new document loads.
3. `history.replaceState` is only used to clear the rescue hash. It cannot switch from the work document to the settings document.
4. After `/pastel/#/login`, watch for leaving `#/login` and resume the pending callback on `/`.
5. Treat `attemptKey === "navigated"` as the only replay lock. A `started` attempt may retry on the app shell.

## Durable procedure additions

1. Do not land a Chatshare OAuth rescue on `/?surface=work`. That query is the chat surface. Connector callback lives on `/` and `/plugins`.
2. `history.replaceState` cannot switch from the work document to the settings document. Use `location.replace('/')` when `surface=work` is present.
3. If the address bar is stuck on `/?surface=work` after authorize, the callback was not consumed. Reload `1.5.0` and start a fresh authorization. Do not reopen the spent callback URL.
4. After `router-navigation-complete`, close on a new token pair plus an authenticated plugin chat. Account-level MCP is not enough.

## Files

- `chatshare-oauth-rescue-extension/callback-bootstrap.js`
- `chatshare-oauth-rescue-extension/rules.json`
- `chatshare-oauth-rescue-extension/manifest.json`
- `chatshare-oauth-rescue-extension/README.md`
- `chatshare-oauth-rescue-extension/test-callback-rescue.mjs`

## Final status

Chatshare OAuth callback rescue is confirmed working as of 2026-08-17 with rescue extension `1.5.0`. The live unpacked path remains `E:\Code\devspace\chatshare-oauth-rescue-extension`. Diagnose later Chatshare routing changes from:

```javascript
sessionStorage.getItem("chatshare-oauth-callback-rescue-status")
```

Expected values: `leaving-work-surface` then `router-navigation-complete`, or `redirecting-to-login` then `resuming-after-login` then `router-navigation-complete`.

---

# Chatshare Rescue 1.10.0 Document vs Client-Route Lessons

Date: 2026-08-18
Client: `https://chatshare.xyz`
Server: `https://devspace-proxy.kitlongku.workers.dev`
Live extension: `E:\Code\devspace\chatshare-oauth-rescue-extension` version `1.10.0`
Classification: Chatshare.xyz compatibility stream. This is not `WEB-CONNECTOR-1`.

No authorization code, state value, access token, refresh token, owner token, or browser credential is recorded in this document.

## Confirmed outcome

Authorize still issued 302s. The rescue intercepted the missing callback before the 404. After several reconnects, `openai-mcp/1.0.0 (ChatGPT)` created authenticated MCP sessions. That is stronger evidence than the address bar.

The remaining break was post-auth UI, not DevSpace custody. The user stayed on `https://chatshare.xyz/` or `https://chatshare.xyz/plugins` instead of the DevSpace Local plugin page. A full load of `/plugins/plugin_<id>` returned HTTP 404 `Not Found`. `/#settings/Plugins/plugin_<id>` briefly appeared, then Chatshare cleared the hash back to `/`.

## Failure chain

### 1. Bare `/` is the ChatGPT chat home, not the connector callback tree

Version `1.5.0` landed the rescued callback on `/`. A logged-in reconnect then stayed on `https://chatshare.xyz/` with title `ChatGPT`. `router.navigate('/connector/oauth/...')` did not mount the callback component. Chatshare never posted `/aip/connectors/links/oauth/callback`.

Lesson: visit count and document title identify the surface. `/` with title `ChatGPT` is the chat home. It is not proof that the connector Remix tree is mounted.

### 2. `/plugins` is the plugin catalog, not the settings shell

Version `1.6.0` moved the same document to `/plugins` before hydration. Chatshare's router then resolved `navigate('/connector/oauth/...')` without changing the path. The rescue stopped with:

```text
Chatshare stayed on /plugins instead of the connector callback.
Status: router-navigation-started
```

Authenticated `/plugins` later loaded as `ChatGPT Plugins | Browse and add plugins to ChatGPT`. That is the marketplace catalog. It is a different document from the ChatGPT app on `/`.

Lesson: `/plugins` is not a reliable connector shell. Unauthenticated `/plugins` is HTTP 404. Authenticated `/plugins` can be the catalog.

### 3. Chatshare no longer client-navigates to the missing callback route

The callback document and its `.data` route are still missing. Chatshare's production callback component only POSTs:

```text
POST /aip/connectors/links/oauth/callback
{ "full_redirect_url": <complete callback URL> }
```

then follows `post_auth_url`. If `router.navigate` will not mount that component, the rescue must call Chatshare's own authenticated API client from the page. The extension must not call DevSpace `/token` or copy credentials.

Version `1.7.0` resolves that client from the Remix module graph (`safePost` on the same singleton Chatshare already loaded) and submits the rescued callback URL.

Lesson: when the original component is unreachable, reuse the host app's API client. Do not reconstruct bearer headers in extension code.

### 4. `post_auth_url` can be `/plugins`

After a successful submit, Chatshare's `post_auth_url` can be the catalog. `location.replace(post_auth_url)` then looks like "OAuth did nothing." MCP can already be live.

Lesson: do not treat `/plugins` after authorize as a failed token exchange. Check `openai-mcp` `/mcp` 200s before recycling the tunnel.

### 5. `/plugins/plugin_<id>` is client-only and 404s as a document

The DevSpace Local page is:

```text
/plugins/plugin_<id>#settings/Plugins/plugin_<id>
```

That path only exists after a client navigation inside the ChatGPT app. A new tab, a refresh, or `location.replace` of that URL returns HTTP 404 `Not Found`. Chrome history can still show the URL with title `ChatGPT - DevSpace Local` from an earlier in-app navigation.

Lesson: never `location.replace` a Chatshare path that 404s when fetched without the SPA. Use `router.navigate` on the already-loaded `/` document.

### 6. `/#settings/Plugins/plugin_<id>` is the generic overlay

Version `1.9.0` used `/#settings/Plugins/plugin_<id>` because `/` is a real document. History then showed that hash, immediately followed by `https://chatshare.xyz/` with title `ChatGPT`. Chatshare's hash router accepted the fragment, did not open the DevSpace Local page, and cleared back to `/`.

Lesson: `/#settings` is the generic settings overlay. The plugin page is the client path `/plugins/plugin_<id>`. Those are not interchangeable.

## Version 1.10.0 repair

1. DNR still lands on `/#cs_oauth_callback=...`.
2. Stay on the ChatGPT document at `/`. Leave `/?surface=work` and the `/plugins` catalog with a real load of `/`.
3. Do not `router.navigate` to `/connector/oauth/...`.
4. Resolve Chatshare's API client and POST the rescued callback URL to `/aip/connectors/links/oauth/callback`.
5. Remember the plugin page the user started from, or build it from `link.connector_id`.
6. Client-navigate to `/plugins/plugin_<id>#settings/Plugins/plugin_<id>`. Never `location.replace` that path.
7. Fall back to `history.replaceState` only if the router did not change `location.pathname`.

Verified:

- `test-callback-rescue.mjs` passed, including submit-through-client, work-surface leave, connector-id plugin destination, and saved return URL.
- `test-device-authorization.mjs` passed.
- `test-real-routing.mjs` against live Chatshare still ended at `/pastel/#/login` when logged out.
- `test-production-assets.mjs` still resolved the production `safePost` export.
- Live authorize 302s and later `openai-mcp` sessions were observed. This close does not claim a new `open_workspace` screenshot.

## Durable procedure additions

1. Classify Chatshare URLs by document vs client route before choosing `location.replace` or `router.navigate`.
2. Unauthenticated `/` 302s to `/pastel/`. Unauthenticated `/plugins` and `/plugins/plugin_<id>` are 404. Authenticated `/` is the ChatGPT app.
3. If the tab stays on `/` after authorize, check whether the rescue hash was cleared and whether `/aip/connectors/links/oauth/callback` ran. Do not assume the plugin page will appear from `/#settings`.
4. If the user pastes `/plugins/plugin_<id>` into the address bar and sees `Not Found`, that is the missing document route. Open `https://chatshare.xyz/`, then Settings → Plugins → DevSpace Local, or `/?surface=work&hints=plugin:<id>`.
5. Account-level MCP is not a settings-page redirect. Start a new chat from the connected plugin. Do not create another connector.
6. After a rescue-extension update, Chrome Reload is required before the next Chatshare connect.

## Files

- `chatshare-oauth-rescue-extension/callback-bootstrap.js`
- `chatshare-oauth-rescue-extension/manifest.json`
- `chatshare-oauth-rescue-extension/README.md`
- `chatshare-oauth-rescue-extension/test-callback-rescue.mjs`

## Final status

Chatshare callback rescue as of 2026-08-18 is `1.10.0` at `E:\Code\devspace\chatshare-oauth-rescue-extension`. Diagnose later Chatshare routing changes from:

```javascript
sessionStorage.getItem("chatshare-oauth-callback-rescue-status")
```

Expected values: `submitting-callback` then `router-navigation-complete`. A live `openai-mcp` `/mcp` 200 is the protocol close. The plugin settings page only counts if `location.pathname` is `/plugins/plugin_<id>` after a client navigation, not after a document load.

---

# Chatshare Rescue 1.11.0 Chrome 142 Loopback Hang Lessons

Date: 2026-08-20
Client: `https://chatshare.xyz`
Server: `https://devspace-proxy.kitlongku.workers.dev`
Live extension: `E:\Code\devspace\chatshare-oauth-rescue-extension` version `1.11.0`
Classification: Chatshare.xyz compatibility stream. This is not `WEB-CONNECTOR-1`.

No authorization code, state value, access token, refresh token, owner token, or browser credential is recorded in this document.

## Confirmed outcome

The public path was healthy. `/healthz`, the current quick tunnel, and the Worker proxy all returned DevSpace JSON. The device-proof listener was bound on `127.0.0.1:7677`. Chatshare registered a new OAuth client and opened `/authorize` twice. Both visits returned the enrolled-PC HTML form and never POST-submitted it, so DevSpace never issued a 302 and this client stored zero tokens.

The break was Chrome 142 Local Network Access hanging the extension **service worker** fetch to loopback, not a 502/530 custody failure and not Chatshare callback routing.

Version `1.11.0` fetches the one-time proof from the authorize tab, where Chrome can show the local-network prompt, times out instead of spinning on `Checking this enrolled PC…`, and names that permission in the failure text. Operator close is: Chrome **Reload** so the unpacked copy shows `1.11.0`, allow **Local network access** / **Apps on device**, then start a fresh Chatshare Connect on the same connector. This close does not claim a new `open_workspace` screenshot.

## Failure chain

### 1. "No redirect after `/authorize`" means the form never submitted

A Chatshare Connect that stays on `https://devspace-proxy.kitlongku.workers.dev/authorize?...` is still on the DevSpace owner page. That GET is supposed to be a 200 HTML form. The redirect to Chatshare happens only after POST.

Serve logs for this incident showed two Chrome GETs of `/` (OAuth authorize is mounted there) and no matching POST. Chrome history had `Connect DevSpace` and no `#cs_oauth_callback=` or `/connector/oauth/...?code=`. The new client had zero access and zero refresh rows.

Lesson: classify authorize hangs before blaming Chatshare's missing callback route. No POST means no 302, no rescue hash, and no `/token`.

### 2. Device-auth HTML is a dead end without a completed proof

With `DEVSPACE_DEVICE_AUTH=true`, a Chatshare `redirect_uri` gets the enrolled-PC form: status text plus Retry, no owner-password field, no Authorize button. The rescue content script must obtain a loopback proof and `requestSubmit()`. If that never returns, the tab stays on `Checking this enrolled PC…`. `DEVSPACE_DEVICE_AUTH_REQUIRED=false` does not show a password fallback on that form.

Lesson: a healthy signer on `127.0.0.1:7677` is not proof that the browser completed device authorization.

### 3. Chrome 142 blocks loopback from the service worker without a prompt

The unpacked extension was present, with host permission for `http://127.0.0.1:7677/*`. Chrome still had service worker registration `1.9.0` from 2026-08-18; disk was already `1.10.0` because the later reload never happened.

Device proof was fetched only from `device-proof-background.js`. Chrome 142 Local Network Access gates public-to-loopback fetches. Service workers cannot raise that permission prompt; they require a prior grant. The fetch therefore hung, `chrome.runtime.sendMessage` never completed, and the form never left "Checking this enrolled PC…". Site settings had no `local_network_access` grant for the authorize origin or the extension origin.

Lesson: do not fetch `127.0.0.1` only from an MV3 service worker. The authorize document can show Chrome's prompt. A missing Reload after an unpacked update is a separate, concurrent failure.

## Version 1.11.0 repair

1. The authorize content script fetches `http://127.0.0.1:7677/devspace-device-proof` itself, with `targetAddressSpace: "loopback"` then `"local"`.
2. That fetch is bounded by an 8s timeout so the page cannot spin forever.
3. The service worker remains a timed fallback and uses the same address-space annotation.
4. Failure text tells the operator to Allow **Local network access** / **Apps on device** on the extension's Site settings, then Retry.
5. README records the Chrome 142 permission step.

Verified:

- `test-device-authorization.mjs` passed, including content-script loopback fetch on the happy path.
- `test-callback-rescue.mjs` passed.

## Durable procedure additions

1. If Chatshare Connect stays on `/authorize` with `Checking this enrolled PC…`, DevSpace has not redirected. Do not recycle the tunnel and do not register another connector.
2. Confirm `/healthz` and `127.0.0.1:7677`. Then check Chrome: unpacked ID `aaoelopmdnhifffjefciagfmhjanbaoc`, Reload after any extension edit, version on the card, and Local network access / Apps on device = Allow.
3. After Reload, start a fresh Chatshare Connect, or Retry / refresh the existing authorize tab if Chatshare is still waiting. Do not reuse a spent callback URL.
4. Close this class of hang on a POST `/` 302 plus a later token row, not on the authorize HTML 200.

## Files

- `chatshare-oauth-rescue-extension/device-authorization.js`
- `chatshare-oauth-rescue-extension/device-proof-background.js`
- `chatshare-oauth-rescue-extension/manifest.json`
- `chatshare-oauth-rescue-extension/README.md`
- `chatshare-oauth-rescue-extension/test-device-authorization.mjs`

## Final status

Chatshare device-proof auto-submit as of 2026-08-20 is `1.11.0` at `E:\Code\devspace\chatshare-oauth-rescue-extension`. Chrome Reload is required before the next connect. Diagnose later authorize hangs from the on-page status text and from whether serve logs show a POST after the GET. Callback routing is still diagnosed from:

```javascript
sessionStorage.getItem("chatshare-oauth-callback-rescue-status")
```

---

# Chatshare 1.11.0 Operator Close: Stale Service Worker and Plugin Actions Lessons

Date: 2026-08-25
Client: `https://chatshare.xyz`
Server: `https://devspace-proxy.kitlongku.workers.dev`
Live extension: `E:\Code\devspace\chatshare-oauth-rescue-extension` version `1.11.0`
Classification: Chatshare.xyz compatibility stream. This is not `WEB-CONNECTOR-1`.

No authorization code, state value, access token, refresh token, owner token, device proof, or browser credential is recorded in this document.

## Confirmed outcome

The 2026-08-20 1.11.0 procedure closed on a live Chatshare Connect. Chrome Reload unstuck `/authorize`. DevSpace issued a POST `/` 302, persisted a device-bound token pair, and accepted `openai-mcp/1.0.0 (ChatGPT)` sessions. The connected `DevSpace Local` plugin page still showed no user-callable open-folder action. A new chat from that plugin then opened `E:\code\quant` as a checkout workspace. User-confirmed close. This close does not attach a new screenshot.

## Failure chain

### 1. "No redirect after `/authorize`" was again a missing POST

Chatshare opened:

```text
https://devspace-proxy.kitlongku.workers.dev/authorize?...
```

GET returned the enrolled-PC HTML form (`Connect DevSpace`, `data-devspace-device-auth="required"`). The Worker forwards that public path to origin `/`, so serve logs show GET `/` 200, not GET `/authorize`. The `chatgpt.com` → `chatshare.xyz` redirect alias accepted the callback host. `/healthz` and `127.0.0.1:7677` were healthy.

The new client stored zero tokens until a Chrome POST existed. Two Chatshare GETs of the form produced no POST and no 302. This is the same class as 2026-08-20: classify the hang before blaming Chatshare's missing callback route.

Lesson: an authorize HTML 200 is not a redirect. Close this gate on POST `/` 302 plus a token row.

### 2. Disk `1.11.0` with service worker `1.9.0` is still the 2026-08-20 hang

The unpacked extension path and ID were already correct. Disk manifest was `1.11.0`. Chrome 142 Local Network Access for `devspace-proxy.kitlongku.workers.dev` was already Allow. Chrome's service worker registration was still `1.9.0`.

1.9.0 proves the PC only from the MV3 service worker. That fetch can hang even when the page origin already has Local Network Access. The tab stays on `Checking this enrolled PC…` and never `requestSubmit()`. Reloading the unpacked copy so the card and the service worker both show `1.11.0` unblocked the POST.

Lesson: do not trust the folder on disk or an Allow grant alone. Confirm Chrome Reload and `service_worker_registration_info.version`. Do not recycle the tunnel or register another connector.

### 3. A connected plugin with no open-folder action is not a missing MCP tool

After the 302 and token exchange, ChatGPT created authenticated `/mcp` sessions. DevSpace never received `open_workspace` while the operator stayed on the plugin page.

`open_workspace` is registered with ChatGPT Apps widget metadata `visibility: ["model"]`. The Apps SDK documents that as visible to the model and not callable by the UI. Default visibility is `["model", "app"]`. The plugin card therefore exposes no Open folder / Open project action. The model-facing tool still exists.

This is distinct from the 2026-08-16 class, where an old Chatshare conversation reported the plugin as not installed. Account-level MCP health still does not attach tools to an old thread.

Lesson: do not add a connector, and do not look for a folder picker on the plugin page. Start a new chat from the connected plugin and give an allowed absolute path. Close on a `workspace_sessions` row (this incident: `E:\code\quant` checkout), not on the plugin actions list.

## Durable procedure additions

1. Authorize hang: `/healthz`, `127.0.0.1:7677`, extension ID `aaoelopmdnhifffjefciagfmhjanbaoc`, card version `1.11.0`, service worker version `1.11.0`, Local network access / Apps on device = Allow, then Retry or a fresh Connect on the same connector.
2. Plugin page empty of open-folder actions: expected while `open_workspace` is model-only. Open a new chat from that plugin and ask it to open a path under the allowed roots.
3. Do not treat launcher stdout as the only `open_workspace` proof. This serve log recorded MCP initialize without `tool_call` lines; the workspace store still gained an active checkout session.

## Files

- `chatshare-oauth-rescue-extension/manifest.json`
- `src/server.ts` (`OPEN_WORKSPACE_TOOL_ANNOTATIONS` and `_meta.ui.visibility`)
- `lessons.md`

## Final status

Chatshare device-proof auto-submit remains `1.11.0` at `E:\Code\devspace\chatshare-oauth-rescue-extension`. The 2026-08-25 operator close is: Reload until the service worker is `1.11.0`, complete authorize POST, then open a folder from a new connected-plugin chat. Diagnose later authorize hangs from on-page status plus GET vs POST. Diagnose later empty plugin actions from `visibility: ["model"]` plus whether a new chat actually called `open_workspace`. Callback routing is still diagnosed from:

```javascript
sessionStorage.getItem("chatshare-oauth-callback-rescue-status")
```

---

# Chatshare 2026-08-26 Unloaded Extension Close

Date: 2026-08-26
Client: `https://chatshare.xyz`
Server: `https://devspace-proxy.kitlongku.workers.dev`
Live extension: `E:\Code\devspace\chatshare-oauth-rescue-extension` version `1.11.0`
Classification: Chatshare.xyz compatibility stream. This is not `WEB-CONNECTOR-1`.

No authorization code, state value, access token, refresh token, owner token, device proof, or browser credential is recorded in this document.

## Confirmed outcome

User-confirmed close. A Chatshare Connect showed:

```text
OAuth callback rescue stopped
Chatshare rejected the rescued callback: We couldn't connect your account. Please try again.
Status: submitting-callback
```

The unpacked rescue extension was not loaded. Chrome Reload of `Chatshare OAuth Callback Rescue` (`aaoelopmdnhifffjefciagfmhjanbaoc`, `1.11.0`) unblocked a fresh Connect on the same connector. This is the same class as the 2026-08-20 / 2026-08-25 stale service-worker hangs, not a new Chatshare callback-API class. This close does not attach a new `open_workspace` screenshot.

## Failure chain

### 1. Confirm the extension is loaded before classifying Chatshare's error text

Authorize still issued a POST `/` 302. Token exchange returned 200. Chatshare's API then returned `We couldn't connect your account. Please try again.`, and the rescue page stayed on `submitting-callback`.

That page only exists if some copy of the content script ran. It does not prove the unpacked `1.11.0` service worker and DNR ruleset were the ones Chrome was actually using. The operator close was: the extension was not loaded; Reload; Connect succeeded.

Lesson: before blaming Chatshare's callback API, discovery 404s, or the tunnel, open `chrome://extensions`, confirm unpacked ID `aaoelopmdnhifffjefciagfmhjanbaoc`, card version `1.11.0`, enabled, and Reload so the service worker is running. Do not register another connector.

### 2. Chatshare now probes OIDC discovery; keep the alias, do not treat it as this close

During the failed attempts, Chatshare's Python client requested `/.well-known/openid-configuration` and DevSpace returned 404. That path had not appeared in this serve log before. DevSpace already served RFC 8414 `/.well-known/oauth-authorization-server`.

`createOAuthMetadata` is now also served at `/.well-known/openid-configuration`. Local origin, the Worker proxy, and the current trycloudflare host return 200 JSON. Setup discovery checks include that path.

Lesson: keep the alias. Do not invent `userinfo` or `jwks` unless a later Chatshare request proves they are required. Do not close this incident on that 404; the operator close was the extension Reload.

## Durable procedure additions

1. Rescue page `Chatshare rejected the rescued callback` with status `submitting-callback`: first confirm the unpacked extension is loaded and Reloaded. Then check authorize POST 302, token 200, and `/.well-known/openid-configuration`.
2. Do not create another connector. Start a fresh Connect on the same plugin after Reload. Spent authorization codes cannot be reused.

## Files

- `src/server.ts`
- `src/oauth-discovery.test.ts`
- `docs/configuration.md`
- `scripts/setup-devspace.ps1`
- `lessons.md`

## Final status

Closed 2026-08-26. Chatshare callback rescue remains extension `1.11.0`. Operator close: Reload the unpacked extension, then a fresh Connect on the same connector succeeded. DevSpace also aliases OIDC discovery to OAuth authorization-server metadata. Diagnose later copies of this page from whether the extension is loaded, then from OpenID discovery GET status plus whether token ran.

