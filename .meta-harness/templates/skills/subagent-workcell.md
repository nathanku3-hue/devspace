---
name: subagent-workcell
description: Delegate bounded read-heavy or evidence-heavy work to scoped subagents with fanout limits and PM-facing return packets.
---

# Subagent Workcell

Use this when noisy work can leave the main PM loop, but only with explicit owned paths, forbidden paths, evidence requirements, stop rules, and a small fanout budget.

## Workflow

1. Write a subagent packet before delegation.
2. Include one goal, owned paths, forbidden paths, required evidence, stop rule, and return schema.
3. Keep fanout to 2 subagents by default.
4. Use 3 subagents only when the user explicitly asks.
5. Prefer subagents for read-heavy exploration, tests, logs, triage, and evidence collection.
6. Avoid parallel write-heavy work unless owned paths are disjoint.
7. Merge returns into the orchestrator front card, latest status, decision inbox, dirty queue, and evidence references.

## Packet Requirements

Every subagent receives:
- goal;
- owned paths;
- forbidden paths;
- required evidence;
- stop rule;
- return schema.

## Return Requirements

Subagents return:
- PM brief;
- artifact paths;
- hashes;
- decision inbox entries;
- one recommended next action.

Subagents do not return:
- raw chat logs;
- raw private transcripts;
- broad repo dumps;
- repeated context handovers;
- unbounded command logs.

## Stop Rules

Stop if outside-scope work appears, credentials/provider/runtime dirt appears, governed data appears, or the subagent cannot answer without widening scope.
