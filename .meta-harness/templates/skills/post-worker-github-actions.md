---
name: post-worker-github-actions
description: Inspect hosted evidence only for dependency surfaces changed by the completed product action.
---

# Outcome-First Post-Worker GitHub Actions

Hosted checks are evidence, not the product action. Inspect them after the complete user journey has run or when a demonstrated hosted-only blocker prevents that journey.

1. Bind the run to the exact candidate SHA and workflow identity.
2. Identify which declared input surface changed.
3. Reuse passed jobs whose inputs are byte-identical.
4. Rerun only affected jobs unless new concrete evidence shows a product defect.
5. Classify failure impact as journey prevention, material conclusion invalidation, credible irreversible loss, supported-platform unusability, or non-blocking.
6. Return the nearest executable product action first.

Do not reopen all evidence because one workflow or documentation file changed. Do not treat reviewer preference, queued cleanup, or stale status as a CI blocker. Do not pass issue, PR, comment, or review text into agent prompts.

Output:

```text
Candidate SHA: <sha>
User journey state: <complete|blocked>
Affected checks: <checks>
Retained passed evidence: <evidence>
Demonstrated blocker: <impact and source or none>
Primary action: <one action or USE_PRODUCT>
```
