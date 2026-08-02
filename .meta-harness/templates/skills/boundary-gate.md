---
name: boundary-gate
description: Classify proposed work against current run boundaries before execution.
---

# Boundary Gate

Use this before executing any ambiguous or scope-expanding request.

## Inputs

Read:

- `.meta-harness/status.md`
- `.meta-harness/events.jsonl`
- relevant stream contract or worker report
- project docs that define non-goals or stop criteria

Extract active scope, owned files, open decisions, forbidden actions, and approval gates.

## Classification Contract

Classify each proposed item as one of:

```text
BLOCKED: <item> | Reason: <violates locked boundary or missing required evidence>
EXPLICIT_APPROVAL: <item> | Reason: <safe only after user/source/policy approval>
NOT_RELEVANT: <item> | Reason: <outside active bottleneck or owned file budget>
ALLOWED: <item> | Reason: <inside owned scope and acceptance checks>
```

## Gate Rules

1. `BLOCKED` for actions forbidden by current stop criteria or non-goals.
2. `EXPLICIT_APPROVAL` for production-impacting operations, data generation/intake, external publishing, or policy changes not already approved.
3. `NOT_RELEVANT` for work that is technically possible but does not advance the chosen scope.
4. `ALLOWED` only when owned files, acceptance checks, and rollback/stop conditions are clear.

## Output Rules

1. Lead with the classification.
2. Include the exact source boundary when available.
3. If any item is `BLOCKED`, do not implement it in the same round.
