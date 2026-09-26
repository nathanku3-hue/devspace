# COMPUTER-USE-1: ChatGPT Web → DevSpace local computer control

> Status: architecture frozen and implementation-ready. This document patch is authorized; implementation is not. Do not start implementation until the acceptance gates in this document are explicit and preserved.

## Product principle

**Immediate laptop usability first: one controlled tab in the user's existing browser when supported; structured and event-driven actuation before vision; reuse mature OS automation before writing native code; minimize ChatGPT write calls and model turns; keep isolation available rather than mandatory; pixels last.**

## Product result

COMPUTER-USE-1 gives an ordinary ChatGPT Web conversation bounded control of approved browser and Windows UI surfaces on the same personal Windows laptop through DevSpace MCP.

The first useful experience should require one self-contained user-facing installation artifact, no manual Node/Python/.NET setup, and no second Chrome instance when PERSONAL CHROME is supported. The preferred browser path reuses the user's already-authenticated Chrome session while exposing only one DevSpace-owned tab to the model-facing protocol. ISOLATED CHROME remains an always-available hardened/fallback mode.

The model-facing system is not primarily a screenshot-driven remote mouse. It is an actuation router with progressively weaker fallbacks:

```text
structured page action / WebMCP
        ↓
DOM / Accessibility semantics
        ↓
DOM/AX-derived Set-of-Mark
        ↓
visual coordinates
        ↓
Windows UI Automation
        ↓
window-relative pixels
```

DevSpace policy remains authoritative at every level. Page-provided tools, labels, manifests, content, and accessibility metadata are untrusted input, not policy.

## Frozen dependency graph

```text
INSTALL-0
 └─ embedded HOST-ELIGIBILITY-0
          ↓
 HOST-MCP-LOOP-0
          ↓
 PERSONAL-TRANSPORT-SPIKE-0
          ↓
 SEMANTIC-ACT-0
   ├─ one owned personal-Chrome tab
   ├─ WebMCP when available
   ├─ DOM / AX
   ├─ surfaceRevision
   ├─ TargetDescriptor
   ├─ revision/delta results
   ├─ bounded computer_act batches
   └─ verified postconditions
          ↓
 HOST-VISION-0
   ├─ Set-of-Mark
   └─ visualFrameId / pixels
          ↓
 FILE-BRIDGE-0
          ↓
 WINDOWS-NATIVE-0
   ├─ restricted pinned winapp adapter
   ├─ server-owned app/HWND
   └─ UIA → window-relative fallback

ISOLATED CHROME
   = always-available hardened/fallback browser mode
```

No further architecture research cycle is required before implementation unless measured implementation evidence contradicts an assumption in this document.

## Non-goals

COMPUTER-USE-1 does not create:

- unrestricted desktop control;
- arbitrary process launching or executable-path authority;
- arbitrary CDP commands or JavaScript execution exposed through MCP;
- model-selected Chrome profiles, browser targets, PIDs, HWNDs, or extension IDs;
- access to unrelated personal Chrome tabs, their titles, URLs, DOM, screenshots, or storage;
- automatic control of elevated applications, UAC, the Windows secure desktop, or higher-integrity targets;
- general clipboard access;
- general filesystem-picker or Downloads-folder access;
- automatic credential extraction or password-store access;
- a local vision-model runtime as a baseline dependency;
- AI selector self-healing that silently chooses a different consequential control;
- a browser-provider framework, browser pool, generic remote-desktop protocol, or scheduler;
- WebDriver BiDi implementation in V1;
- a custom Windows UIA helper before measured defects justify one;
- modifications to the existing DevSpace enrolled-PC/OAuth extension to grant computer-control authority;
- a replacement for `WEB-LAUNCH-0`, which remains a separate narrow ChatGPT-conversation transport surface.

## Design principles

1. **Usability is a product requirement, not an afterthought.** The default path should work on a normal personal laptop with minimal setup and reuse existing authenticated browser state when support and consent are present.
2. **Structured control beats pixels.** Use page tools, DOM, accessibility, and UIA before visual grounding or coordinate input.
3. **One model-facing contract, multiple bounded transports.** CDP, Playwright, UIA, winapp, and future transports stay behind internal interfaces.
4. **The server owns authority.** The model never broadens target scope, executable scope, browser-profile scope, origin policy, or native-app policy.
5. **State is versioned.** Semantic actions use optimistic concurrency; pixel actions bind to an exact visual frame.
6. **Closed-loop actions.** An action reports verified effects and the next revision rather than returning only `success=true`.
7. **Short safe batches, not scripts.** Batch a few low-risk primitives to reduce host write calls and model turns, but terminate on explicit barriers.
8. **PERSONAL CHROME is a trust mode, not isolation.** Model-facing scope is one owned tab, while the underlying debugging connection still inherits the trust implications of attaching to the user's authenticated browser.
9. **Isolation remains available.** Users who prefer stronger separation can use a dedicated DevSpace browser profile without changing the MCP contract.
10. **Measure user-perceived performance.** Model turns, confirmations, focus disturbance, Chrome interference, and end-to-end task latency matter more than isolated RPC speed.

# Installation and host eligibility

## INSTALL-0

INSTALL-0 defines the user experience, not the packaging technology.

The product requirement is one self-contained user-facing installation artifact with:

- no prerequisite Node, Python, PyTorch, or .NET installation exposed to the user;
- per-user installation where practical;
- no administrator requirement unless a measured platform constraint makes it unavoidable;
- idempotent reinstall/repair;
- predictable per-user autostart or an equally obvious lifecycle;
- a `doctor`/health path;
- clean uninstall;
- automatic detection of Chrome support and DevSpace connectivity;
- no requirement to install a separate Windows UI-automation package manually.

The architecture does not prescribe MSIX, Node SEA, an installer framework, or another packaging mechanism until native-addon packaging is proven with the chosen dependencies.

### Chrome version behavior

Chrome version is an eligibility fact, not an installation failure.

- Chrome 144+ may qualify for the supported PERSONAL CHROME attachment path after the user's explicit Chrome permission.
- Chrome <144 makes PERSONAL CHROME unavailable and returns one precise remediation: upgrade Chrome for PERSONAL mode.
- ISOLATED CHROME remains immediately usable when PERSONAL CHROME is unavailable.
- Installation and doctor must not leave the product unusable merely because the preferred browser mode is unavailable.

## HOST-ELIGIBILITY-0

HOST-ELIGIBILITY-0 is embedded into install/doctor. It is not a separate prerequisite the user must discover or run manually.

It answers only:

1. Can this ChatGPT account/workspace invoke the required custom-MCP write actions?
2. Is DevSpace reachable from the intended ChatGPT Web app configuration?
3. Is the expected DevSpace MCP tool/schema snapshot active for the message/tool context?
4. Is the intended browser mode eligible on this machine?

A negative ChatGPT-host eligibility result must not corrupt or roll back a valid local installation. Doctor reports the external blocker and the precise next action.

HOST-ELIGIBILITY-0 does not infer entitlement from plan names alone. It must be verified against the actual host behavior used by the product.

## HOST-MCP-LOOP-0

HOST-MCP-LOOP-0 measures whether ordinary ChatGPT Web can complete a benign multi-action loop without requiring a second conversational user message.

One user prompt, with DevSpace selected once as required by the host, must allow the model to perform:

```text
open session
→ observe
→ benign mutation
→ verify returned postcondition/revision
→ close session
```

Acceptance records:

- number of ChatGPT host confirmation prompts;
- number of model/tool round trips;
- whether app/tool selection remained usable for the complete loop;
- end-to-end time;
- whether any user conversational turn beyond the original request was required.

A host confirmation is not automatically a failure. Confirmation count and placement are product metrics because repeated confirmation for every primitive can make the architecture unusable even when technically correct.

# Public MCP contract

The permanent public COMPUTER-USE-1 surface is intentionally small:

```text
computer_open_session
computer_observe
computer_act
computer_close_session
```

Separate public `click`, `type`, `key`, `scroll`, and `navigate` tools are deliberately avoided. Keeping mutations behind `computer_act` reduces MCP schema surface, write-action confirmations, tool-selection overhead, and host round trips.

## computer_open_session

Conceptual request:

```text
computer_open_session({
  target: "browser" | "native",
  browserMode?: "personal" | "isolated",
  appAlias?: string
})
```

Rules:

- `browserMode` defaults to `personal` when eligible, otherwise `isolated`.
- The model never supplies a Chrome executable, profile path, debugging endpoint, target ID, PID, HWND, or native executable path.
- `appAlias` resolves only through server configuration to an approved native application.
- Native application selection is server-owned and must bind the session to one validated process/window identity.
- Opening a session does not grant authority to switch to another tab, process, or window.

Result contains an opaque `sessionId`, selected trust mode/backend summary, initial `surfaceRevision`, and eligibility/policy metadata safe to expose to the model.

## computer_observe

Conceptual request:

```text
computer_observe({
  sessionId,
  sinceRevision?,
  mode: "semantic" | "visual" | "hybrid"
})
```

Normal operation prefers `semantic`.

The result may contain:

- current `surfaceRevision`;
- `changed: false` when no meaningful semantic state changed;
- URL/title/origin or native window identity safe for the bound surface;
- focused-element state;
- actionable targets represented by opaque `targetId` plus bounded semantic metadata;
- semantic delta when `sinceRevision` is compatible;
- current dialogs/modals/permission/file transitions;
- optional structured page actions when WebMCP is available;
- optional image content plus `visualFrameId` when visual mode is requested and HOST-VISION-0 is banked.

It must not expose unrelated personal-Chrome tabs or arbitrary OS windows.

## computer_act

Conceptual request:

```text
computer_act({
  sessionId,
  ifRevision,
  actions: [ Action, ... ] // 1..4
})
```

The action list is a bounded micro-batch, not a script language.

Permitted action classes may include:

- invoke a server-approved structured page action discovered on the bound surface;
- click/invoke an opaque semantic `targetId`;
- type or replace text in an opaque semantic `targetId`;
- send a bounded non-global key/chord to the bound surface;
- semantic scroll;
- bounded navigation to a policy-allowed URL/origin;
- bounded wait for a semantic condition;
- coordinate click only when a matching `visualFrameId` is supplied and visual fallback is permitted.

The public schema never accepts arbitrary JavaScript, CDP method names, raw HWNDs, shell commands, native message payloads, or executable paths.

### Per-action execution loop

For every action inside a batch DevSpace must:

```text
validate session + authority
→ validate ifRevision / frame binding
→ re-resolve semantic target if applicable
→ enforce actionability
→ execute one primitive
→ observe events / transition
→ verify postcondition
→ update semantic revision
→ evaluate batch barriers
→ continue or terminate immediately
```

The result returns:

- actions actually executed;
- actions not executed because a barrier stopped the batch;
- verified postconditions;
- semantic delta;
- `nextSurfaceRevision`;
- optional `visualFrameId` if a fresh visual result is included;
- explicit barrier reason when applicable.

Routine `act → full observe → act` cycles should not be required when the action result already contains enough verified state for the next decision.

### Mandatory batch barriers

`computer_act[1..4]` **must terminate the batch immediately after the current primitive** when any of the following occurs:

1. navigation or top-level document change;
2. origin change;
3. a new dialog or modal appears;
4. a browser/OS permission prompt appears;
5. a file chooser appears;
6. an upload/download state transition begins or completes in a way requiring FILE-BRIDGE policy;
7. bound window identity changes;
8. focus moves to a different window/surface identity;
9. the resolved target is classified sensitive or consequential;
10. semantic actionability validation fails;
11. target re-resolution becomes ambiguous or falls below the deterministic confidence threshold;
12. a visual frame/geometry check fails;
13. a postcondition differs materially from the expected transition for that action;
14. a policy boundary, approval boundary, or origin boundary changes;
15. any unexpected state makes the remaining queued actions no longer obviously valid on the same surface.

These barriers are objective protocol rules, not model discretion. The server returns the barrier reason and the new state/revision so the model can make a fresh decision.

A navigation action may itself execute when authorized, but any resulting navigation/document/origin transition ends the current batch before later queued actions run.

## computer_close_session

Closes only DevSpace authority for the bound surface.

- PERSONAL CHROME: close/detach the one DevSpace-owned tab/session only; never shut down the user's Chrome process.
- ISOLATED CHROME: close the DevSpace-owned session according to isolated-profile lifecycle policy.
- Native: release the app/window binding and any short-lived adapter resources; never terminate the user's application unless a separate explicit product feature later authorizes that behavior.

# Versioned state and targeting

## surfaceRevision

`surfaceRevision` is an opaque optimistic-concurrency token representing the semantic state needed to validate subsequent semantic actions.

Semantic actions provide `ifRevision`.

Before executing, DevSpace:

- verifies the revision is compatible;
- re-resolves the target against current state;
- validates actionability;
- rejects stale or ambiguous actions instead of guessing.

A semantic action does not need an exact screenshot frame when the server can safely re-resolve the target.

## visualFrameId

Pixel/coordinate input has stricter semantics.

A visual observation returns an opaque `visualFrameId` bound to:

- session;
- surface/window identity;
- viewport/window geometry;
- visual capture generation;
- relevant semantic revision.

Coordinate input must cite that exact frame. If geometry, surface identity, or relevant visual state changed, DevSpace rejects the action and requires another observation.

## TargetDescriptor

An internal target is an ensemble, not one XPath or accessibility node.

Conceptual evidence:

```text
TargetDescriptor
  stable ID / data-testid / AutomationId
  role / control type
  accessible name
  nearby anchor / parent context
  element type
  semantic state
  geometry        // weak evidence only
```

Resolution order favors deterministic stable identity, then bounded combinations of semantic attributes. Geometry is never sufficient evidence for a consequential semantic action.

If the candidate is not unique or confidence falls below a deterministic threshold, stop and re-observe.

V1 does not use AI self-healing to silently repair selectors or choose a different control.

## Revision-scoped resolution cache

DevSpace may cache deterministic backend resolution:

```text
(surfaceRevision, TargetDescriptor)
        → resolved backend target
```

Relevant revision changes invalidate the affected cache. Screenshots are not the primary cache optimization.

# Browser architecture

## Browser trust modes

### PERSONAL CHROME — default when eligible

PERSONAL CHROME means **one DevSpace-owned tab inside the user's existing Chrome session**, not access to the user's browser as a whole.

User-facing benefits:

- reuse of existing login state;
- reuse of normal cookies/session state and compatible extensions;
- no second browser process by default;
- lower memory and login friction.

Security/trust statement:

> PERSONAL CHROME is a trust mode, not browser-enforced isolation. The MCP/model-facing contract exposes only the one DevSpace-owned tab, but the underlying debugging connection attaches to the user's authenticated browser and therefore inherits broader backend trust implications. DevSpace software policy must prevent that broader backend capability from becoming model authority.

Default PERSONAL behavior:

1. connect to the eligible running Chrome instance only after the browser's required explicit user permission;
2. create one new DevSpace-owned target/tab;
3. retain its internal target/session identity;
4. attach only to that target for page actuation;
5. never enumerate or expose unrelated tabs to the model;
6. never attach-all or auto-attach to all targets;
7. never wake unrelated discarded/frozen tabs as part of normal operation;
8. never expose other tab titles, URLs, DOM, screenshots, storage, or page contents;
9. never let the model choose an existing tab;
10. on close, close/detach only the owned target and leave Chrome running.

An explicit future “share this existing tab” feature is outside COMPUTER-USE-1 V1.

### ISOLATED CHROME — hardened/fallback

ISOLATED CHROME uses a dedicated DevSpace computer-use profile separate from:

- the user's ordinary Chrome profile;
- the existing `chatgpt-fs0` / WEB-LAUNCH-0 profile;
- any machine-owned ChatShare/browser-transport profile.

It provides stronger cookie/storage/profile isolation at the cost of extra browser memory and separate authentication state.

It must remain available when PERSONAL CHROME is unsupported, unavailable, unhealthy, or intentionally disabled.

## PERSONAL-TRANSPORT-SPIKE-0

Do not choose the PERSONAL backend from architecture preference alone. Run one bounded comparison and select exactly one production PERSONAL transport.

Candidate A:

```text
Playwright connectOverCDP
  isLocal = true
  noDefaults = true
```

Candidate B:

```text
minimal target-scoped direct CDP
  create one target
  attach only to that target
```

Candidate C is a deliberately tiny comparison, not a commitment:

```text
separate extension-lite
  activeTab-style explicit share gesture
  page scripting / semantic observation
  Native Messaging local bridge
```

Computer-control authority must not be merged into the existing DevSpace authorization extension.

Transport acceptance measures:

- whether connection wakes unrelated discarded/frozen tabs;
- Chrome RSS/CPU change before and after connection;
- DevSpace/controller RSS;
- whether another persistent Chrome process appears;
- focus/window disturbance;
- whether ordinary browser behavior changes;
- reconnect latency;
- ability to create/attach only the owned target;
- ability to enforce “no unrelated-tab enumeration” at the DevSpace layer;
- semantic action fidelity;
- whether trusted-user-activation-dependent interactions work when relevant.

If a candidate causes significant unrelated-tab wakeups, focus disturbance, browser instability, or profile-wide resource regression, it fails PERSONAL acceptance even if basic clicking works.

The extension-lite spike ends after a bounded viability comparison. It becomes a production transport only if measured user-boundary or resource advantages clearly justify its extra installation component and it satisfies required interaction semantics.

## BrowserTransport internal boundary

Public MCP must not expose Playwright or CDP semantics.

Conceptual internal interface:

```text
BrowserTransport
  openOwnedTarget
  observe
  resolveTarget
  performAction
  subscribeChanges
  capture
  structuredTools?
  closeOwnedTarget
```

CDP is pragmatic for Chrome V1. WebDriver BiDi may replace or supplement it later without changing COMPUTER-USE-1's MCP schema.

## Browser actuation router

For the bound browser target, prefer:

1. page structured action / WebMCP when available and policy-allowed;
2. DOM/Accessibility semantic action;
3. semantic-derived Set-of-Mark grounding;
4. coordinate input bound to a `visualFrameId`.

WebMCP may use the same browser transport as semantic/visual control. It does not grant additional DevSpace authority.

WebMCP manifests, descriptions, outputs, annotations, and page content are untrusted. Consequential/untrusted annotations feed policy and batch barriers rather than bypassing them.

## Semantic actionability

A semantic click/invoke is not “find rectangle and send coordinates.”

Before actuation the backend must, as applicable:

- resolve exactly one target;
- verify it belongs to the bound surface;
- verify visible/on-screen state where required;
- verify stable geometry/state when physical input is needed;
- verify enabled/actionable state;
- verify it can receive the intended interaction;
- re-resolve immediately before physical input when backend races are possible;
- fail closed on ambiguity or movement rather than clicking stale coordinates.

Every action returns verified postconditions, not only transport success.

Example conceptual result:

```text
executed = true
targetInvoked = true
urlChanged = false
structureChanged = true
newDialog = null
nextSurfaceRevision = opaque-B
```

## Semantic deltas and event-driven state

The first observation may provide a complete bounded semantic state.

Subsequent observations/action results should prefer deltas:

- changed actionable nodes;
- focus changes;
- URL/title/origin changes;
- dialog/modal changes;
- target state changes;
- relevant changed geometry;
- native/window identity changes.

When nothing meaningful changed, return `changed: false` with the compatible revision.

Do not resend a complete AX/DOM snapshot and full screenshot after every primitive unless a measured host limitation requires it.

# Visual fallback

## HOST-VISION-0

HOST-VISION-0 gates only the visual fallback path. It is not a prerequisite for semantic browser control.

Before banking visual coordinate control, live acceptance must prove that ChatGPT Web can actually consume the MCP image result used by `computer_observe(mode="visual"|"hybrid")` and ground a bounded task from it.

The MCP protocol's ability to represent image content is necessary but not sufficient; the actual ChatGPT host path used by the product must be verified.

If HOST-VISION-0 fails, semantic browser/native control remains valid while visual fallback stays disabled.

## Set-of-Mark before local vision models

When semantic information exists but visual disambiguation helps:

```text
DOM / AX / UIA actionable candidates
        ↓
DevSpace draws numbered bounded overlays
        ↓
ChatGPT receives one marked image
        ↓
model chooses an opaque mark/target
```

Do not require OmniParser, PyTorch, local detector weights, or another resident local ML runtime in the baseline.

A local visual-grounding model may be evaluated only after a real inaccessible-surface defect justifies its installation/resource cost.

# FILE-BRIDGE-0

Generic file-picker automation remains outside V1 acceptance, but personal usefulness requires a narrow file bridge early in P1.

## Upload

```text
already-authorized DevSpace workspace file
        ↓
opaque fileRef
        ↓
policy-validated browser upload to the bound target
```

The model never supplies an arbitrary `C:\Users\...` path and never browses the OS picker.

## Download

```text
bound browser download
        ↓
DevSpace quarantine
        ↓
opaque downloadRef
        ↓
explicit export into an allowed DevSpace workspace
```

The model receives metadata needed for the task but does not receive general Downloads-folder authority.

File chooser/download transitions are mandatory `computer_act` batch barriers.

# WINDOWS-NATIVE-0

## V1 backend choice

Do not build a bespoke Windows UIA helper first.

V1 should wrap an exact pinned `@microsoft/winappcli` version behind a restrictive DevSpace `NativeTransport` adapter, because the upstream already provides the useful substrate for semantic Windows automation.

Conceptual allowed subset:

```text
restricted winapp adapter
  inspect bounded app/window
  invoke semantic target
  set value
  focus semantic target
  semantic scroll
  bounded wait-for condition
  window-scoped screenshot
```

DevSpace policy owns the approved app alias, process identity, and HWND/window identity.

The model cannot pass an executable path, PID, raw HWND, transport mode, global-key destination, or arbitrary winapp command.

## Mandatory winapp restrictions

Do not expose winapp wholesale.

At minimum, DevSpace must deny or omit:

- arbitrary process/window discovery exposed to the model;
- arbitrary command dispatch;
- global/system key authority;
- post-message or other modes that bypass the intended Windows integrity boundary;
- arbitrary raw keyboard transport selection;
- higher-integrity/elevated target control;
- UAC/secure-desktop control;
- raw screenshots of unrelated windows/displays;
- arbitrary filesystem/navigation features not explicitly part of COMPUTER-USE-1.

Pin the exact upstream version. Treat Public Preview status as a normal replacement risk behind `NativeTransport`, not as authority to broaden the MCP schema.

Known upstream behavior must be covered by local acceptance tests; do not assume send-key, targeting, or screenshot behavior is correct merely because the upstream API exposes it.

## NativeTransport internal boundary

Conceptual interface:

```text
NativeTransport
  bindApprovedApp
  observe
  resolveTarget
  performAction
  waitForCondition
  captureWindow
  close
```

A custom native helper is allowed only when a measured defect cannot be solved safely through the pinned adapter. Any replacement must preserve the same public MCP contract and server-owned authority.

## Native state efficiency

Prefer bounded semantic control-view inspection, bulk property retrieval/caching where available, and event-driven focus/structure/property changes rather than repeatedly walking a complete UI tree.

Screenshots should target the bound application/window rather than capturing the full display and cropping afterward.

# Policy and security boundaries

## Server-owned configuration

Policy configuration may define:

- whether computer use is enabled;
- PERSONAL/ISOLATED browser availability;
- browser origin allowlist/denylist;
- approved native app aliases and executable identities;
- allowed native action classes;
- file-bridge workspace roots/quarantine policy;
- sensitive/consequential target rules;
- maximum session lifetime;
- maximum batch length, fixed at no more than 4 in COMPUTER-USE-1;
- logging/audit settings that do not reveal content.

The model cannot modify these settings through COMPUTER-USE-1 tools.

## Control-plane separation

Computer-use sessions must not be used to manipulate DevSpace's own authorization/security control plane, browser debugging permissions, or the ChatGPT conversation that is currently granting computer-use authority.

At minimum, policy should fail closed for known DevSpace OAuth/approval surfaces and should prevent self-referential control loops where the controlled surface can alter the authority granting the control.

The existing `WEB-LAUNCH-0` ChatGPT profile remains separate from COMPUTER-USE browser profiles and targets.

## Sensitive/consequential transitions

Sensitive or consequential target classification is a batch barrier even when the individual action is otherwise allowed.

The server must surface enough bounded information for the host/model/user to make the next explicit decision. It must not silently continue later actions in the same batch across a consequential transition.

Page-provided claims that an operation is safe do not override DevSpace policy.

## Clipboard and secrets

Baseline COMPUTER-USE-1 has no general clipboard-read API.

Typed text may be supplied by the user/model to an approved target, but DevSpace must not automatically extract password-store values, browser credentials, or hidden secrets for insertion.

Logging must never record typed secret text.

# MCP annotations and host approvals

Tool annotations must accurately represent side effects.

- `computer_observe` is read-only with respect to the controlled application state.
- `computer_act` is a write/action tool and must be annotated accordingly.
- `computer_open_session` and `computer_close_session` may create/close local browser/native session state and must not be mislabeled as pure reads.

Do not attempt to defeat or bypass ChatGPT host confirmations. Instead, minimize write-tool surface and batch safe primitives so the product remains usable under the host's actual confirmation behavior.

HOST-MCP-LOOP-0 records confirmation count as an acceptance metric.

# Logging and audit

Audit metadata may include:

- timestamp;
- opaque session ID/hash;
- backend/trust mode;
- action class;
- target descriptor hash or opaque target ID;
- origin/app alias classification;
- revision transitions;
- barrier reason;
- success/failure/error code;
- timing/resource metrics.

Do not log by default:

- screenshots;
- complete DOM/AX/UIA trees;
- typed text;
- passwords/tokens;
- cookies/storage;
- clipboard contents;
- unrelated tab/window metadata;
- downloaded/uploaded file contents.

# Stable error contract

Representative stable errors:

```text
COMPUTER_DISABLED
HOST_NOT_ELIGIBLE
PERSONAL_CHROME_UNAVAILABLE
BROWSER_PERMISSION_REQUIRED
SESSION_NOT_FOUND
SESSION_EXPIRED
SURFACE_CHANGED
REVISION_STALE
TARGET_NOT_FOUND
TARGET_AMBIGUOUS
TARGET_NOT_ACTIONABLE
TARGET_MOVED
TARGET_PRIVILEGE_DENIED
ORIGIN_DENIED
POLICY_DENIED
BATCH_BARRIER
VISUAL_NOT_AVAILABLE
VISUAL_FRAME_STALE
FILE_BRIDGE_REQUIRED
FILE_REF_DENIED
DOWNLOAD_QUARANTINED
NATIVE_APP_NOT_ALLOWED
NATIVE_WINDOW_CHANGED
BACKEND_UNAVAILABLE
UPSTREAM_VERSION_UNSUPPORTED
```

Errors should tell the model what state must be refreshed or what user remediation is required without leaking broader machine state.

# Acceptance gates

Implementation must proceed gate-by-gate. A later gate cannot be banked by assuming an earlier one.

## Gate A — INSTALL-0 + embedded HOST-ELIGIBILITY-0

Pass only when a clean personal Windows installation demonstrates:

- one self-contained user-facing artifact;
- no manual runtime installation;
- idempotent reinstall/repair;
- per-user start/lifecycle works;
- doctor reports DevSpace reachability;
- doctor verifies the actual ChatGPT custom-MCP write path used by the product or reports a precise external blocker;
- Chrome support is detected;
- Chrome <144 does not make installation fail;
- ISOLATED mode remains available when PERSONAL mode is ineligible;
- clean uninstall removes product-owned runtime state according to documented retention policy.

## Gate B — HOST-MCP-LOOP-0

One original user prompt must complete benign open → observe → mutate → verify → close through ChatGPT Web.

Receipt records:

- host confirmations;
- model/tool calls;
- user conversational turns;
- wall-clock duration;
- MCP schema digest;
- DevSpace policy digest.

## Gate C — PERSONAL-TRANSPORT-SPIKE-0

Run the bounded transport comparison and bank exactly one PERSONAL transport.

Pass requires:

- one DevSpace-owned target can be created and controlled;
- no model-visible enumeration of unrelated tabs;
- no attach-all behavior;
- no significant unrelated discarded-tab wakeup;
- no persistent extra Chrome process in PERSONAL mode;
- no material browser focus disturbance;
- no qualitative regression in normal browser behavior;
- Chrome/controller resource effects measured and recorded;
- reconnect behavior measured;
- transport can close/detach the owned target without shutting down Chrome.

Resource budgets are provisional engineering targets, not the sole pass/fail criteria:

- target `<150 MB` extra idle DevSpace/controller RSS;
- target `<250 MB` active controller RSS excluding the controlled tab's renderer.

A transport fails despite meeting those numeric targets if it causes unrelated-tab wakeups, persistent extra browser processes, focus disturbance, browser instability, or significant Chrome RSS growth.

## Gate D — SEMANTIC-ACT-0

Pass requires:

- public surface is the four-tool contract;
- `surfaceRevision` concurrency works;
- `TargetDescriptor` deterministic re-resolution works across bounded benign UI changes;
- ambiguous/stale targets fail closed;
- semantic actionability checks run before action;
- `computer_act` accepts 1..4 actions only;
- every internal primitive is revalidated;
- all mandatory batch barriers are mechanically tested;
- results include executed actions, postconditions, semantic delta, and next revision;
- ordinary tasks avoid unnecessary full observe calls when action results contain sufficient next state;
- WebMCP, when present, remains untrusted and policy-bounded;
- DOM/AX semantic control remains fully usable when WebMCP is absent.

Representative batch-barrier tests must include:

- navigation after first action stops remaining actions;
- origin change stops remaining actions;
- new modal/dialog stops remaining actions;
- permission prompt stops remaining actions;
- file chooser/download transition stops remaining actions;
- focus/window identity change stops remaining actions;
- consequential target stops remaining actions;
- actionability failure stops remaining actions;
- materially unexpected postcondition stops remaining actions.

## Gate E — HOST-VISION-0

Pass only when the actual ChatGPT Web host used by the product can consume a DevSpace MCP image observation and successfully ground a bounded visual task.

Then bank:

- SoM generation from semantic candidates;
- `visualFrameId` binding;
- stale-frame/geometry rejection;
- coordinate fallback restricted to the bound target/window.

If this gate fails, visual fallback remains disabled without invalidating semantic gates.

## Gate F — FILE-BRIDGE-0

Pass requires:

- upload accepts only an opaque fileRef already authorized by DevSpace workspace policy;
- browser upload does not expose arbitrary filesystem paths to the model;
- download lands in DevSpace quarantine;
- model receives only an opaque downloadRef plus bounded metadata;
- export requires an explicit allowed-workspace destination through DevSpace file authority;
- generic picker/Downloads-folder access remains unavailable.

## Gate G — WINDOWS-NATIVE-0

Pass requires an exact pinned `@microsoft/winappcli` adapter with:

- server-owned app alias and process/HWND binding;
- semantic inspect/invoke/set-value/focus/scroll/wait on approved targets;
- window-scoped capture;
- stale/moved target rejection;
- bounded postconditions and next `surfaceRevision`;
- no raw winapp command surface;
- no global/system keys;
- no post-message/integrity-bypass mode;
- no elevated/UAC/secure-desktop control;
- adapter released when no native session needs it;
- measured acceptance coverage for known upstream send-key/targeting behavior.

A custom Windows helper is not admitted until a retained defect receipt shows the pinned adapter cannot safely satisfy an accepted use case.

# Acceptance receipt and upstream pinning

Every banked acceptance receipt must record enough upstream identity to attribute later regressions.

At minimum record:

```text
DevSpace candidate commit/digest
DevSpace COMPUTER-USE policy digest
MCP public tool-schema digest
ChatGPT host/workspace acceptance context
Chrome exact version + major
PERSONAL transport implementation identity
Playwright exact version when used
@microsoft/winappcli exact version when used
OS version/build
chosen trust mode
resource measurements
confirmation/model-turn measurements
acceptance timestamp
```

If a later Chrome, Playwright, ChatGPT host, MCP schema, or winapp update changes behavior, do not silently treat an old acceptance receipt as evidence for the new upstream combination.

# Resource and usability acceptance

Resource figures remain provisional until PERSONAL-TRANSPORT-SPIKE-0 produces measurements.

The stronger qualitative constraints are frozen now:

- PERSONAL mode must not launch a second persistent Chrome browser instance;
- connecting must not wake unrelated discarded/frozen tabs as normal behavior;
- DevSpace must not enumerate/expose unrelated personal-tab contents;
- no resident local ML runtime in the baseline;
- no persistent native UI helper when unused;
- computer control must not disturb browser focus without an action that actually requires foreground focus;
- Chrome RSS growth and CPU activity caused by attachment must remain low enough that the personal browser remains normally usable;
- backend semantic action latency should remain small compared with ChatGPT/network/model latency;
- user-perceived task latency, confirmations, and model-turn count are first-class acceptance metrics.

# Deferred work

Do not implement as part of COMPUTER-USE-1 unless a retained supported-use defect justifies reopening the design:

- generalized existing-tab sharing;
- browser-wide personal-profile control;
- WebDriver BiDi transport;
- multiple concurrent controlled browser tabs as a product feature;
- local OmniParser/vision-model baseline;
- AI selector self-healing;
- AppContainer experiments for native control;
- UIAccess/elevation bypass;
- custom Windows native helper;
- generic filesystem picker automation;
- unrestricted clipboard control;
- arbitrary remote-desktop semantics;
- browser provider/router framework.

# Implementation order

The implementation order is frozen:

```text
1. INSTALL-0 + embedded HOST-ELIGIBILITY-0
2. HOST-MCP-LOOP-0
3. PERSONAL-TRANSPORT-SPIKE-0
4. SEMANTIC-ACT-0
5. HOST-VISION-0
6. FILE-BRIDGE-0
7. WINDOWS-NATIVE-0
8. custom Windows helper only after a measured retained defect
```

Do not start implementation before the acceptance criteria for the gate being opened are represented in tests/receipts strongly enough to distinguish a real pass from transport acknowledgement.

## Frozen architecture statement

The banked design is:

```text
ChatGPT Web
     │
     │ custom MCP app
     ▼
DevSpace Computer Use
     │
     ├─ installation / host eligibility / doctor
     ├─ policy + capability boundary
     ├─ surface revision + semantic delta engine
     ├─ deterministic target resolver
     ├─ bounded action executor + batch barriers
     ├─ acceptance/audit receipts
     │
     ├─ PERSONAL CHROME
     │    └─ exactly one DevSpace-owned tab in the user's existing browser
     │         ├─ WebMCP when available
     │         ├─ DOM / Accessibility
     │         ├─ Set-of-Mark
     │         └─ frame-bound pixel fallback
     │
     ├─ ISOLATED CHROME
     │    └─ always-available hardened/fallback profile
     │
     ├─ FILE-BRIDGE
     │    └─ opaque authorized file refs + quarantine
     │
     └─ WINDOWS NATIVE
          └─ restricted pinned winapp adapter
               ├─ server-owned app/HWND
               ├─ semantic UIA-first actions
               └─ window-relative visual/input fallback
```

This architecture is implementation-ready. Future changes require implementation evidence, acceptance failures, upstream regressions, or a newly admitted product requirement—not another speculative architecture research cycle.
