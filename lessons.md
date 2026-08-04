# Hung Runtime + Slow MCP Connection Lessons

Date: 2026-08-05
Worktree: `E:\Code\devspace\devspace-src\.worktrees\devspace-4859ae9d61326563`
Branch: `product/native-chatgpt-bridge-1`
Runtime: Windows PowerShell, Node.js v25.2.1, cloudflared Quick Tunnel, Worker proxy

## Outcome

Two coupled failures made DevSpace look "broken after successful setup":

1. Launcher refused cleanup when port `7676` was held but `/healthz` failed, so relaunch deadlocked on a hung listener.
2. `validate_task` used `spawnSync` for external validation (multi-minute `pytest`), which froze the Node event loop so local `/healthz`, tunnel, Worker, and concurrent MCP clients all timed out.

Both were fixed in-tree: cleanup accepts CLI-path identity for hung owners; validation is async via `spawn`.

## Initial symptoms

```text
Port 7676 is owned by PID 22080 but /healthz does not prove it is DevSpace. Refusing cleanup.
```

Later, after a clean setup finished with 17 tools verified:

- Local `http://127.0.0.1:7676/healthz`: TCP connect ~1ms, then curl exit 28 (no body).
- Tunnel/Worker healthz intermittent timeouts.
- Many `CLOSE_WAIT` sockets on 7676.
- cloudflared: `Incoming request ended abruptly: context canceled`.

## Root causes

### 1. Cleanup required `/healthz` even when process identity was known

`Stop-DevSpaceRelatedProcesses` threw whenever the port owner failed the health probe, even if the command line was clearly `dist\cli.js serve` for the expected worktree.

`-Stop` could still kill via `runtime.json` identity, which produced the confusing dual message: setup error, then "Stopped identity-verified runtime PID …".

Lesson: for stop/relaunch safety, **CLI path on the port owner is sufficient identity**. `/healthz` proves liveness, not ownership. A hung DevSpace must still be stoppable.

### 2. `validate_task` blocked the event loop with `spawnSync`

Serve log:

```text
tool=validate_task durationMs=191653 success=false
```

Child process:

```text
python -m pytest tests/test_gv_pit_operated_rotation.py ...
```

While `spawnSync` ran, the process still accepted TCP connections but did not run Express handlers. Queued healthz and MCP traffic completed in milliseconds only after validation returned.

Lesson: long external validation must use **async `spawn`**. Tool duration may still be minutes; the connector must remain responsive for other sessions and health probes.

## Discriminators that worked

1. TCP open + HTTP timeout on loopback → event-loop freeze or request starvation, not DNS/tunnel alone.
2. `Get-CimInstance` child of the serve PID matching the sealed validation argv → identify the blocking tool.
3. Serve log burst of `/healthz` and MCP inits with `durationMs` 0–20 right after a multi-minute `tool_call` → prove request queueing behind a block.
4. Prove async fix with `setInterval` ticks during a 1.5s validation child (ticks must keep advancing).

## Fixes landed

| Area | Change |
|------|--------|
| `scripts/setup-devspace-support.ps1` | Resolve port owner by CLI path without requiring health; `Test-DevSpacePortOwnerStopAllowed` |
| `scripts/setup-devspace.ps1` | Cleanup/stop allow hung CLI-identified owners; loopback HTTP uses `--noproxy` |
| `scripts/setup-devspace.Tests.ps1` | Hung owner + foreign owner cleanup cases |
| `src/native-task.ts` | Async `runValidationProcess` / `runNativeTaskValidation` |
| `src/server.ts` | `await` validation from `validate_task` and edit-time `validateTask` |
| Tests | Await async validation in native-task and workspaces tests |

## Operational notes

- Correct launch from this pin:
  ```powershell
  powershell -ExecutionPolicy Bypass -File "E:\Code\devspace\devspace-src\.worktrees\devspace-4859ae9d61326563\scripts\setup-devspace.ps1"
  ```
- Setup success ("17 tools verified") only proves health at that moment; later multi-minute validation used to freeze the whole server.
- Prefer narrow sealed validation argv so ChatGPT is not blocked for minutes on one tool call even after the async fix.

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
