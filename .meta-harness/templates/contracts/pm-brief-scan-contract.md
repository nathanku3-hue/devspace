# PM Brief Scan Contract

Phase 5B scans target-form PM briefs only. Existing `brief pm` generator output may fail this stricter target-form scan until a later phase updates that generator. This patch must not change `brief pm` generation.

The scanner is read-only, deterministic, silent in the core API, and must not shell out or write files.

## Scan Surface

Scan only:

```text
.meta-harness/pm-brief.md
.meta-harness/briefs/*.md
```

Do not recurse under `.meta-harness/briefs`. Do not scan `.txt`, `.json`, temp files, nested directories, templates, workers, or docs.

If an expected brief surface exists as a directory, symlink, or other non-regular file, fail without following it. If `.meta-harness/briefs` exists but is not a real directory, fail without following it.

Missing optional brief surfaces pass with `checked=0`.

## Required Shape

The first non-empty line must be exactly:

```text
# PM Brief
```

Strip a UTF-8 BOM from the start of the first line before checking the title.

The required level-2 sections must appear exactly once, in this order:

```text
## Decisions
## Blockers
## Evidence
```

Only one H1 is allowed, and it must be the first non-empty line. Any later H1 fails.

Outside fenced code blocks, every Markdown heading must be one of:

```text
# PM Brief
## Decisions
## Blockers
## Evidence
```

Reject missing required sections, duplicate required sections, required sections out of order, and unexpected heading levels such as `### Raw Logs` or `#### Transcript`.

Reject unexpected setext-style headings too:

````text
Raw Logs
--------
````

## Fence Handling

Detect headings only outside fenced code blocks.

Support backtick and tilde fences:

````text
```
~~~
````

A fence opens or closes only outside another fence, except for the matching close of the current fence. Do not inspect headings while inside a fence.

An unclosed fenced code block is malformed and must fail.

## Out Of Scope

Do not inspect body prose yet. This is a shape-only scan.

Do not change `lib/decisions.js`, Quant, installed templates, migration state, or inherited docs in Phase 5B.
