---
name: context-packet
description: Assemble a compact context packet for a fresh worker from harness truth files.
---

# Context Packet

## Sources (read in order)

1. `.meta-harness/status.md`
2. `.meta-harness/phase-map.md`
3. `.meta-harness/events.jsonl` (last 5 events)
4. `.meta-harness/local/context/ROUND-NNN.json` (current gate output)
5. Relevant `.meta-harness/workers/*.md`
6. Relevant `.meta-harness/expert-packets/*`
7. `README.md`, `package.json` / `pyproject.toml` (stack detection)
8. Decision log entries relevant to current scope

## Packet Sections

1. **Goal** - one sentence from gate's product_outcome
2. **Scope** - owned files, forbidden files, out-of-scope
3. **Stack** - runtime, framework, test command
4. **Evidence required** - what proves done
5. **Stop rules** - when to pause instead of improvise
6. **Decisions** - relevant prior decisions by ID
7. **Freshness** - any docs/API uncertainty flags

## Rules

- Max 3 pages equivalent
- No raw chat logs
- No stale truth (gate freshness score must be >= 6)
- If gate verdict was "narrowed", packet must state the narrowed scope explicitly
