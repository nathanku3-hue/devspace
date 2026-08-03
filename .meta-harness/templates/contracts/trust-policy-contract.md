# Trust Policy Contract

Status: Template
Purpose: keep reusable skill references local, reviewed, and inspectable.

## Rule

Skill references must be local capsule names matching:

```text
^[a-z0-9][a-z0-9-]*$
```

Reject URLs, Git remotes, filesystem paths, `.md` filenames, and `skills/...` imports. The trust check reports only and does not fetch, install, rewrite, or sync skills.
