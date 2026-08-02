---
name: context-quality-gate
description: Score whether a phase transition has sufficient context to proceed without guessing.
---

# Context Quality Gate

Run before every phase transition:
- intake -> plan
- plan -> work
- work -> verify
- verify -> synthesize
- synthesize -> handoff
- handoff -> lookback

## Scoring Dimensions (1-10 each)

1. **Product outcome** - Why now? For whom? What feels done?
2. **Scope boundary** - Smallest useful delivery. Explicit out-of-scope. Forbidden scope.
3. **Repo and stack** - Target repo, stack/framework/runtime, branch/package/app surface.
4. **Owned surface** - Files/directories allowed. Files/directories forbidden. Integration points.
5. **Evidence plan** - Test command. Demo path. Acceptance check. Required citations/proof.
6. **Risk and stop rules** - Secrets/data/provider boundaries. Rollback condition. When to pause.
7. **Freshness** - Are docs/API versions current? Is external context stale or missing?
8. **Handoff completeness** - Worker type. Expected output. Required report fields.

## Verdict Logic

- If any `structural_hard_blockers` exist -> `blocked` (no hint can clear)
- If any `unknown_dimensions` remain after applying valid hints -> `blocked`
  (unknown dimensions score as 1 in the scores object, overall_score = 1)
- If any `evidence_gap_dimensions` remain after applying valid hints -> `blocked`
- Else if any dimension < 4 -> `blocked`
- Else if overall < 6 -> `blocked` (planning/context insufficient)
- Else if overall 6-7 -> `narrowed` (continue only with narrowed scope)
- Else if overall 8-9 -> `proceed`
- Else if overall 10 -> `excellent`

Averages hide danger. Do not average away a 2.

### Unknown vs. low score

- `unknown` = gate cannot determine quality from files alone. Dimension
  appears in `unknown_dimensions`, scores as 1, and emits a question.
- Low score (1-3) = gate found evidence but it is weak or incomplete.

File presence proves "has a field" but not "field is semantically adequate."
When deterministic checks cannot distinguish template-complete from
evidence-backed, classify as unknown (not low-score).

### Blocker classification

**Structural hard blockers** (hints cannot clear):
- Missing repo target
- Missing stack/framework identity
- Requires secrets/provider access without permission
- Untrusted issue/PR text copied into worker prompt
- Missing out-of-scope boundary for execution transitions

**Evidence gap dimensions** (valid hints may satisfy):
- Freshness uncertain (hint: "confirmed docs current via Context7")
- Acceptance taste unclear (hint: "confirmed MVP criteria with product owner")
- Proof command unverified (hint: "confirmed test command runs locally")
- Handoff format unspecified (hint: "confirmed report template with reviewer")

## Output

Emit to `.meta-harness/local/context/ROUND-NNN.json` by default (gitignored).
Emit to `.meta-harness/local/context/ROUND-NNN.md` as human-readable summary.
Use `--out <path>` to write elsewhere, or `--commit-artifact` to write to
`.meta-harness/context/` (tracked, for intentional archival only).
Reject `--out` paths under `.meta-harness/context/` unless
`--commit-artifact` is present; tracked context artifacts must pass
committed-artifact redaction before write.
Ask at most 3 blocker-clearing questions.
