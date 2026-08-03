---
name: dirty-work-autopilot
description: Classify repo dirt for current scope, suppress or queue inherited/generated/nonblocking residue, and escalate only current-scope, boundary-touching, or decision-relevant dirt.
---

# Dirty Work Autopilot

Use this when repo dirt could distract the PM loop or confuse current-scope closure.

## Principle

Move dirt out of the PM loop unless it is current-scope, boundary-touching, or decision-relevant. Suppress or queue inherited, generated, unchanged, and nonblocking residue.

## Workflow

1. Take before/after snapshots when useful evidence is missing or stale.
2. Classify dirt by origin, scope, boundary, and whether the current task changed it.
3. Suppress or queue inherited outside-scope dirt, generated/cache artifacts, stale warnings, and unchanged nonblocking residue.
4. Escalate only current-scope dirt, boundary-touching dirt, changed inherited dirt, staged/outside-scope dirt, automation failures, or decision-relevant drift.
5. Return route, terminal outcome, visible dirt, evidence, next action, and queued/suppressed counts only.

## Risk Routes

- `FAST`: no visible dirt remains; only suppressed or queued residue exists.
- `REVIEW`: current-scope dirt or shared-surface residue needs reviewer judgment.
- `SLOW`: evidence, scope, residue, or sequencing needs deliberate sorting before closure.
- `BLOCK`: missing authority, access, dependency, evidence, or boundary clearance prevents safe progress.

## Terminal Outcomes

- `SHIP`: work is complete and visible dirt does not block closure.
- `REVIEW`: work is ready for review and is not self-approved as shipped.
- `DECISION_NEEDED`: a PM, owner, or authority holder must decide before progress or approval.
- `BLOCKED`: work cannot proceed without external action, access, dependency, or scope change.
- `FOLLOW_UP_QUEUED`: residue is counted, scoped, and queued outside the current PM loop.

## Escalation Rules

1. Never self-approve authority-changing work; escalate to `REVIEW`, `DECISION_NEEDED`, or `BLOCKED`.
2. Escalate credential, provider, runtime, governed data, broker, scoring, dashboard, release, package, permission, and data-output dirt by path/status metadata.
3. Escalate inherited dirt that the current task removed, cleaned, staged, or changed unless explicitly allowlisted.
4. Do not escalate unchanged inherited outside-scope dirt, generated/cache artifacts, or repeated queued chores with unchanged state hash.
5. Do not show raw dirty-file lists in PM output.

## Optional Evidence Tools

```text
meta-harness dirty snapshot --out .meta-harness/snapshots/before.json
meta-harness dirty snapshot --out .meta-harness/snapshots/after.json
meta-harness dirty classify --before .meta-harness/snapshots/before.json --after .meta-harness/snapshots/after.json --scope .meta-harness/scope.json --out .meta-harness/dirty-work.json
meta-harness gate scope --dirty .meta-harness/dirty-work.json --scope .meta-harness/scope.json
```

## PM Output

```text
Route: <FAST|REVIEW|SLOW|BLOCK>
Outcome: <SHIP|REVIEW|DECISION_NEEDED|BLOCKED|FOLLOW_UP_QUEUED>
Visible dirt: <current blockers/escalations/decisions or none>
Evidence: <snapshot/classification artifact or none>
Next: <one action and owner>
Queued/Suppressed: <counts only>
```

## Safety

Classify secret and provider-output dirt by path/status metadata. Do not read secret or provider-output contents.
