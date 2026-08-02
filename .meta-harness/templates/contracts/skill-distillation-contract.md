# Skill Distillation Contract

Status: Template
Purpose: capture durable local judgment provenance before any repeated decision becomes reusable harness behavior.

## Registry Shape

```json
{
  "v": 1,
  "distillations": [
    {
      "id": "S-<hash>",
      "source_decision_id": "D-001",
      "principle": "...",
      "skill": "dirty-work-autopilot",
      "assumptions": ["..."],
      "reopen_when": "...",
      "enforcement": "scope_diff_gate",
      "owner": "orchestrator",
      "status": "active"
    }
  ]
}
```

## Required Fields

```text
id
source_decision_id
principle
skill
assumptions
reopen_when
enforcement
owner
status
```

## Allowed Statuses

```text
active | superseded | reopened
```

## ID Contract

Distillation IDs are deterministic:

```text
S-<first12hex(sha256(canonical source_decision_id + principle + skill))>
```

Assumptions and enforcement are provenance and reuse gates, not identity. Changing assumptions or `reopen_when` reopens the existing record instead of creating a duplicate.

## Local-Only Rule

`skill` names must be local capsule names such as `dirty-work-autopilot`. Remote URLs, filesystem paths, public imports, and `.md` filenames are invalid.

## v0 Boundary

This registry records distilled judgment. It does not automatically edit skill files.
