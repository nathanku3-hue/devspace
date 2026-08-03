User journey executed: <complete journey actually run>
Observable result produced: <user-visible result>
User accomplished or learned: <practical outcome>
Product blocker: <demonstrated blocker or none>
Next executable product action: <nearest action, USE_PRODUCT, or none>
Outcome: <DONE|PARTIAL_WITH_EXPLICIT_SCOPE|REJECTED>
Round: not recorded
Progress: not recorded
Confidence: not recorded
Worker:
Stream:
Task:
Phase:
Updated:
Ship gate tier: <FAST|REVIEW|SLOW|BLOCK>
Task resolution: <ship|blocked|decision-needed|follow-up-queued>

## What changed

<One paragraph answering what actually changed, what artifact/result was produced, and practical effect.>

## Why it matters

<One short paragraph: current top-level state, unblocked/blocked state, and whether execution-ready, docs-only, design-only, or rejected.>

## What is blocked

<blocker + exact reason, or none>

## What decision is needed

Decision needed from user: <approve|redirect|hold>
Options considered:
Scope limit:
Stop rule:

## Next action

Recommended next action:
Goal:
Allowed scope:
Forbidden scope:

## Validation / evidence

Passed:

Skipped:

Evidence artifacts:

## Accountability

requested_work_type: <docs|code|test|provider_probe|commit|validation|execution|data_output>
actual_work_type_performed: <docs|code|test|provider_probe|commit|validation|execution|data_output|none>
credentials_touched: false
provider_access_touched: false
data_output_created: false
commit_created: false
remaining_blocker:
ship_gate_tier: <FAST|REVIEW|SLOW|BLOCK>
task_resolution: <ship|blocked|decision-needed|follow-up-queued>

Rules:
- The first five non-empty lines must be User journey executed, Observable result produced, User accomplished or learned, Product blocker, and Next executable product action.
- Outcome and internal metadata appear only after those five product fields, with no title before them.
- Ship gate tier and Task resolution must appear immediately after Updated.
- The Ship-Fast Decision Gate concept is visible in top metadata and folded into What decision is needed.
- This template is a WORKER_REPORT evidence surface, not the default final chat answer or an ORCHESTRATOR_HANDOVER.
- Final chat answers must use the shortest adaptive PM_CLOSURE that preserves result, useful reason or nearest evidence, remaining next action, and the highest-priority real user decision. Omit empty or none items; labels are optional.
- The four-item budget applies only to normal human-facing closure. Requested audits, reviews, safety evidence, and orchestrator handover state are separate surfaces and do not convert PM_CLOSURE into an audit packet.
- Decision-needed questions use exactly one owner tag: human: taste/acceptance, expert: domain knowledge, or expert: system methodology.
- Authority, credentials, publishing, provider access, execution permission, protected-boundary access, and commit or rollout permission remain Approval needed or Blocked, not expert-decision tags.
- SLOW and tier metadata may remain in WORKER_REPORT accountability and evidence fields, but do not appear in normal chat or PM_CLOSURE output.
- Hide internal labels, hashes, absolute paths, allowlists, command logs, and accountability booleans from final chat unless the user asks for them.
- If the user asks for approval text, emit only the pasteable approval block and do not add an audit recap.
- Do not use # Worker PM Brief, # Worker Report, numbered reviewer logs, command logs, SAW internals, or ClosurePacket lines as the primary report structure.
- SAW Verdict and ClosurePacket details belong only under Validation / evidence.
- Missing requested_work_type or actual_work_type_performed fails closed.
- PARTIAL_WITH_EXPLICIT_SCOPE and REJECTED require an explicit blocker.
- actual_work_type_performed=none requires PARTIAL_WITH_EXPLICIT_SCOPE or REJECTED and an explicit blocker.
- Silent docs-only fallback from code, test, provider_probe, commit, validation, execution, or data_output work is forbidden.
