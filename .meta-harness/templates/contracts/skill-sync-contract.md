# Skill Sync Contract

Status: Template
Purpose: detect drift between meta-harness source templates and installed per-repo template copies.

## Rule

Installed templates under `.meta-harness/templates/` are byte-exact copies of source templates under `templates/`.

## Check Results

```text
PASS
MISSING
DRIFT
```

The sync check reports only. It does not install, overwrite, delete, normalize, or migrate files.
