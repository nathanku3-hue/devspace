# Dirty Work Contract

Status: Template
Purpose: classify dirty repo state without turning mechanical residue into PM-visible noise.

## Classifications

```text
inherited_dirty_outside_scope -> QUEUE and suppress
inherited_dirty_inside_scope -> DECISION
inherited_dirty_removed_or_cleaned -> BLOCK unless explicitly allowlisted
agent_created_outside_scope -> BLOCK
staged_outside_scope -> BLOCK
credential_provider_runtime_dirt -> ESCALATE
generated_cache_artifact -> QUEUE and suppress
clean_owned_path_edit -> PASS
```

## Scope JSON

```json
{
  "owned_paths": ["src/owned-file.js"],
  "generated_paths": ["dist/"],
  "ignored_paths": [],
  "allow_clean_inherited_paths": [],
  "queue_path": ".meta-harness/dirty-work-queue.json",
  "decision_inbox_path": ".meta-harness/decision-inbox.json"
}
```

## PM Visibility

Show only:
- blockers;
- escalations;
- current-scope decisions;
- evidence artifacts;
- next action.

Suppress:
- inherited nonblocking dirt;
- generated/cache artifacts;
- repeated queued chores with unchanged state hash;
- raw dirty-file lists.

## Safety

Credential, provider, runtime, governed data, broker, scoring, dashboard, and data-output dirt must be classified by path/status metadata. Do not read secret or provider-output contents to classify it.
