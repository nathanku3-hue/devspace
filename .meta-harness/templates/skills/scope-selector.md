---
name: scope-selector
description: Select the nearest complete product action from authority-ordered truth.
---

# Outcome-First Scope Selector

## Authority-ordered inputs

1. Locked product intent and owner-signed acceptance.
2. Immutable product, closure, package, proof, and mechanics evidence.
3. Git facts and changed dependency surfaces.
4. Status, roadmaps, reports, and summaries last.

Resolve conflicts in favor of the higher source. Status cannot create work when higher authority says the product is closed.

## Selection

Name:

```text
Product result: <observable user outcome>
Journey state: <not run|partial|complete>
Primary action: <nearest complete action>
Affected evidence: <only gates whose inputs changed>
Demonstrated blockers: <list or none>
```

When the journey has not run, allow at most one audit/repair round and then execute it. Select one functional slice that owns implementation through terminal closure; do not create acceptance-only, integration-only, packaging-only, review-only, documentation-only, or evidence-refresh product slices.

A blocker requires evidence of journey prevention, material conclusion invalidation, credible irreversible loss, or supported-platform unusability. Everything else is non-blocking residue.

Reuse passed evidence when its declared input surface is unchanged. Rerun only the affected gate unless new concrete evidence demonstrates a product-relevant defect.

## Terminal stop

For shipped, value-confirmed, maintenance, or no-active-slice state:

- no warrant or incomplete defect warrant → `NO_BUILD`, `USE_PRODUCT`;
- explicit owner scope change → `OWNER_DECISION_REQUIRED`, `REQUEST_OWNER_AUTHORIZATION`;
- complete observed supported-use defect warrant → `BUILD_RECOMMENDED`, `SELECT_SMALLEST_REPAIR`.

Never claim successor activation after closure. Never queue follow-up work after `NO_BUILD`.
