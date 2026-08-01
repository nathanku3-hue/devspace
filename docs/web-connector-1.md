# WEB-CONNECTOR-1: Fresh-conversation connector proof

> Status: IMPLEMENTED; LIVE ACCEPTANCE PENDING
> Base SHA: `65781ea82114a0c0e0b42f25ad65ff40b32c8c80`
> Classification: bounded read-only connector-discovery experiment

## Product question

Can a fresh ChatGPT Web conversation created through the WEB-LAUNCH-0 browser boundary independently discover and invoke the connected DevSpace connector through the normal ChatGPT tool interface?

## Product claim

WEB-CONNECTOR-1 proves only this flow:

```text
existing ChatGPT Web conversation
→ user explicitly requests one connector proof
→ the current conversation calls web_connector_proof
→ DevSpace generates one cryptographic challenge
→ WEB-LAUNCH-0 creates one fresh ChatGPT Web conversation with a fixed prompt
→ the fresh conversation discovers the connected DevSpace connector
→ it invokes web_connector_probe exactly once with the challenge
→ DevSpace resolves the originating proof from the server-side invocation
→ the original conversation receives bounded proof metadata
```

The proof does not inspect or capture assistant text. Connector invocation is established by the authenticated MCP request reaching the same live DevSpace runtime from the independently initialized conversation.

## Public tools

In minimal deployed mode, the exact authenticated inventory increases from 10 to 12 tools by adding only `web_connector_proof` and `web_connector_probe`. The setup and launch custody assertions are updated to require that exact inventory.

### Proof trigger

```text
web_connector_proof()
```

This tool has no user-supplied prompt or path. It launches one fixed acceptance prompt and waits up to 120 seconds for the corresponding probe invocation.

A successful acknowledgement contains only:

```json
{
  "slice": "WEB-CONNECTOR-1",
  "connectorDiscovered": true,
  "connectorInvoked": true,
  "probeTool": "web_connector_probe",
  "conversationIdentitySha256": "<sha256>",
  "invocationTimestamp": "<ISO-8601>",
  "assistantOutputCaptured": false
}
```

### Read-only probe

```text
web_connector_probe(challenge)
```

The challenge must be exactly 64 lowercase hexadecimal characters and must match one currently pending proof. It is one-time, memory-only, timeout-bound, and rejected after use, expiry, cancellation, or server shutdown.

The probe:

- does not open a workspace;
- does not read or write files;
- does not run shell commands;
- does not create Git state;
- does not access assistant output;
- changes only ephemeral in-memory proof state.

## Fixed launched prompt

The launched conversation receives only:

```text
WEB-CONNECTOR-1 acceptance probe.
Use the connected DevSpace connector through the normal ChatGPT tool interface.
Invoke the read-only `web_connector_probe` tool exactly once with this exact challenge:
<challenge>
Do not invoke any other connector tool.
After the probe succeeds, stop. Do not ask the user a question.
```

Naming the exact connector and probe reduces model-selection variance. The capability under test is whether a newly created conversation can access and invoke the connector through the normal ChatGPT interface, not whether it can guess an unspecified tool.

## Failure behavior

WEB-CONNECTOR-1 fails closed when:

- another proof is already in flight;
- challenge generation is malformed or duplicated;
- browser launch fails;
- no matching probe arrives before timeout;
- the probe challenge is unknown, expired, cancelled, or already consumed;
- the server closes before proof completion.

No partial success acknowledgement is returned.

## Mechanical evidence

The automated tests prove:

- the acceptance prompt is fixed and bounded;
- the probe is annotated read-only;
- the proof does not resolve before the matching challenge is consumed;
- unknown, expired, and reused challenges are rejected;
- timeout fails closed;
- two independent MCP server sessions can complete the source-proof and spawned-probe halves through shared runtime state;
- the existing WEB-LAUNCH-0 public contract still passes unchanged.

Mechanical tests do not prove current authenticated ChatGPT Web connector visibility. That requires an exact-SHA live acceptance invocation after deployment.

## Explicit exclusions

WEB-CONNECTOR-1 does not add or require:

- assistant-response capture;
- DOM scraping of tool cards or assistant text;
- workspace opening or repository reads;
- arbitrary prompts;
- generic browser automation;
- reviewer binding;
- return submission;
- automatic continuation;
- multiple connector calls.

## Next gate

The slice is not banked until an exact deployed SHA passes one live invocation through the stable Worker:

```text
web_connector_proof
→ one fresh conversation
→ one authenticated web_connector_probe invocation
→ bounded success acknowledgement
```

Only after that proof should WEB-CONNECTOR-1 be classified as banked and the roadmap advance to REVIEW-RETURN-2.
