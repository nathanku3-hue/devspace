---
name: build-vs-borrow-router
description: Decide whether any implementation is warranted before opening work.
---

# Outcome-First Build-vs-Borrow Router

Read locked product intent and owner authority before status or plans. Then inspect immutable product evidence and Git facts.

Return exactly one pre-route:

- `NO_BUILD`: the product is shipped/value-confirmed, the request is already satisfied, or no complete observed supported-use defect warrant exists. Primary action: `USE_PRODUCT`.
- `USE_EXISTING_REPO_PATTERN`: an owned existing implementation directly produces the required outcome.
- `USE_PLATFORM_NATIVE`: a supported platform capability directly produces the outcome.
- `MINIMAL_PATCH`: a bounded product gap is demonstrated and the smallest repair is known.
- `HUMAN_TASTE`: only naming, presentation, or acceptance preference remains.
- `EXPERT_PACKET`: one external domain or methodology judgment is necessary to choose the product action.
- `AUTHORITY_BLOCK`: explicit owner authority or protected access is missing.

Do not route optional cleanup, stale status, additional review, or unchanged passed evidence to implementation. A build is warranted after closure only for explicit owner scope change or a complete observed supported-use defect warrant containing observed behavior, supported environment, user impact, retained evidence, and smallest repair.

Output:

```text
Pre-route: <value>
Product result: <observable outcome>
Primary action: <one action>
Demonstrated blocker: <one or none>
Next: <one executable step or USE_PRODUCT>
```
