# Decision Inbox Scan Contract

This contract was introduced in Phase 5C and extended in Phase 6 to require `assumption_hash`. Approved, rejected, and deferred command output remains valid.

The scanner is read-only, deterministic, silent in the core API, and must not shell out or write files.

## Scan Surface

Scan only:

```text
.meta-harness/decision-inbox.json
```

Do not scan backups, templates, installed template copies, nested folders, dirty work files, PM briefs, status files, docs, or any other inbox-shaped files.

If `.meta-harness` exists but is not a real directory, fail without following it. If `decision-inbox.json` exists as a directory, symlink, or other non-regular file, fail without following it.

If `.meta-harness/decision-inbox.json` is missing, pass with `checked=0`.

Malformed JSON fails the scan and must not crash the CLI.

## Required Root Shape

The inbox must be a JSON object with a `decisions` array:

```json
{
  "decisions": []
}
```

An empty `decisions` array is valid and counts as one checked inbox.

## Required Decision Shape

Each decision must be a JSON object with these non-empty string fields:

```json
{
  "id": "D-001",
  "kind": "user_decision",
  "question": "Approve the bounded scope?",
  "recommended": "hold",
  "state_hash": "non-empty",
  "assumption_hash": "non-empty",
  "reask_when": "source state changes",
  "status": "open"
}
```

Allowed `kind` value:

```text
user_decision
```

Allowed `recommended` values:

```text
approve
reject
defer
hold
```

Allowed `status` values:

```text
open
approved
rejected
deferred
```

Reject missing required fields, blank-after-trim required fields, duplicate decision ids, duplicate non-empty `identity_hash` values when present, and enum values outside the allowed sets.

`question` must be one explicit decision question. In this phase, reject multi-line question text, semicolon-separated decision text, and text with multiple question marks. Do not require a literal question mark.

`state_hash` must be non-empty so the decision is bound to a concrete state.

`assumption_hash` must be non-empty so stale assumptions have a concrete fingerprint. Multiple decisions may share the same `state_hash` when one repo state requires several decisions.

`reask_when` must be non-empty so stale decisions have an explicit reopen condition.

`evidence` may be omitted. If present, `evidence` must be an array of non-empty strings.

Extra fields are allowed. This scan validates the required current-contract core and does not freeze optional metadata fields.

## Out Of Scope

Do not change Quant, dirty-doc cleanup, migration behavior, broad workflow framework, `.meta-harness/status.md`, or `.meta-harness/events.jsonl`.
