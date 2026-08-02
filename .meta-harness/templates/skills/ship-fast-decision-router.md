---
name: ship-fast-decision-router
description: Route directly to the nearest user outcome while preserving authority and terminal stop conditions.
---

# Outcome-First Ship-Fast Router

## Route order

1. Reconcile locked intent and explicit owner authority; read status and summaries last because they cannot create work.
2. Determine whether the complete user journey has run.
3. Choose the nearest action that produces the observable result.
4. Retain only demonstrated blockers.
5. Reuse unaffected passed evidence.
6. Stop when the product is shipped or value-confirmed.

## Routes

- `FAST`: execute the complete authorized journey now.
- `REVIEW`: one bounded decision is genuinely needed before the journey can run.
- `BLOCK`: authority or a demonstrated product blocker prevents the journey.
- `NO_BUILD`: the product is already complete or no valid continuation warrant exists; primary action `USE_PRODUCT`.

Allow at most one audit/repair round before execution. Do not convert optional review, cleanup, status repair, packaging, or evidence refresh into a product blocker or successor slice.

## Valid blockers

Only demonstrated journey prevention, material conclusion invalidation, credible irreversible loss, or supported-platform unusability block. State the evidence source and impact. Preferences and speculative risks remain non-blocking.

## Evidence reuse

A passed gate remains passed while its input surface is unchanged. Rerun only the changed gate unless new concrete evidence shows a product defect.

## Continuation

After completion:

- default → `NO_BUILD`, `USE_PRODUCT`;
- owner changes scope → `OWNER_DECISION_REQUIRED`, `REQUEST_OWNER_AUTHORIZATION`;
- complete observed supported-use defect warrant → `BUILD_RECOMMENDED`, `SELECT_SMALLEST_REPAIR`.

Do not emit `FOLLOW_UP_QUEUED` after `NO_BUILD`, claim successor activation, or add review/evidence gates after closure.

## Output

```text
Product result: <observable outcome>
Primary action: <one action>
Blocking findings: <demonstrated findings or none>
Non-blocking residue: <optional findings or none>
Next: <one executable action or USE_PRODUCT>
```
