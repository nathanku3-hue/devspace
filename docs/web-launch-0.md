# WEB-LAUNCH-0: One outbound ChatGPT Web launch

> Status: BANKED AND DEPLOYED
> Classification: experimental bounded explicit-invocation feature
> Accepted and deployed SHA: `65781ea82114a0c0e0b42f25ad65ff40b32c8c80`

## Product claim

WEB-LAUNCH-0 proves only this flow:

```text
existing ChatGPT Web conversation
→ user explicitly requests one outbound launch
→ the current conversation calls DevSpace web_launch with one supplied prompt
→ DevSpace opens its dedicated external headed Chrome profile
→ exactly one fresh chatgpt.com conversation receives that prompt
→ DevSpace returns a structured launch acknowledgement
```

## Tool contract

```text
web_launch(prompt)
```

`prompt` is inserted and submitted exactly. Empty prompts, prompts longer than 100,000 characters, and prompts containing carriage returns are rejected. Carriage returns are rejected rather than normalized so DevSpace never silently changes supplied text.

A successful acknowledgement contains only:

```json
{
  "slice": "WEB-LAUNCH-0",
  "launchSuccess": true,
  "conversationIdentitySha256": "<sha256>",
  "timestamp": "<ISO-8601>",
  "assistantOutputCaptured": false
}
```

The raw conversation identity and URL are not returned.

## Browser boundary

WEB-LAUNCH-0 uses:

```text
%LOCALAPPDATA%\DevSpace\browser-profiles\chatgpt-fs0
```

The profile is persistent, headed, outside every DevSpace allowed root and ordinary Chrome profile, protected by an exclusive lease, and rejected if any path component is a symlink or Windows junction.

For each call DevSpace:

1. permits only one launch in flight;
2. opens `https://chatgpt.com/` in the dedicated profile;
3. rejects unauthenticated or already conversation-bound pages;
4. selects one credible composer, inserts the supplied prompt, and verifies exact read-back;
5. activates exactly one enabled send control;
6. waits for a bounded `/c/<conversation-id>` URL;
7. rejects reuse of an existing conversation identity;
8. hashes the bounded identity and returns immediately without reading assistant output.

## Acceptance contract

The live round passes only when:

- the user explicitly triggers `web_launch` from ChatGPT Web;
- DevSpace launches the dedicated external headed Chrome profile;
- exactly one fresh ChatGPT conversation is created;
- the supplied prompt is inserted without modification and submitted;
- submission produces a bounded `chatgpt.com/c/<conversation-id>` URL;
- the original conversation receives launch success, hashed conversation identity, timestamp, and confirmation that no assistant output was captured;
- the source repository remains unchanged by the runtime action;
- no response capture, reviewer binding, connector check, return submission, or automatic continuation occurs.

Mechanical tests prove the public tool shape, exact prompt handoff against a browser fixture, bounded identity hashing, acknowledgement-only output, profile confinement, one-launch concurrency, and repository-state invariance. They do not prove authenticated ChatGPT Web behavior.

## Explicit exclusions

WEB-LAUNCH-0 does not add or require:

- MCP App launch controls;
- generic browser tools;
- response capture;
- extension mode;
- arbitrary CDP support;
- reviewer orchestration;
- connector verification;
- automatic continuation.

## Roadmap status

The established sequence remains:

```text
WEB-LAUNCH-0
→ WEB-CONNECTOR-1
→ REVIEW-RETURN-2
→ THREE-REVIEWER-SAW-3
→ META-HARNESS-INTEGRATION-4
```

WEB-LAUNCH-0 proved the headed-browser execution boundary and is retained as an
experimental explicit-invocation capability. Its implementation does not alter
the roadmap architecture. WEB-CONNECTOR-1 is now the sole active product slice;
its bounded contract is documented in `docs/web-connector-1.md`.
