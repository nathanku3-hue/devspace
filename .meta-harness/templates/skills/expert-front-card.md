---
name: expert-front-card
description: Build a one-page expert or subagent packet front card with one question, scoped paths, required evidence, and summary-only returns.
---

# Expert Front Card

Use this before expert review or subagent delegation, after the build-vs-borrow router says outside judgment is needed.

## Required Shape

The front card must fit on one page and contain exactly one `Question:` field.

Include:
- current delta;
- build-vs-borrow pre-route decision;
- route and terminal outcome;
- one question;
- product or architecture boundary;
- owned paths;
- forbidden paths;
- required evidence;
- stop rule;
- expected output.

## Exclusions

Do not include raw chat logs, broad expert boards, broad repo dumps, private transcripts, or implementation hints that bias review.

## Stale Evidence

If an expert report predates current harness truth, mark it stale before using it:

```text
# STALE EXPERT REPORT

This report predates current harness truth. Treat it as historical evidence only; reconcile against the front card, status, decision inbox, and dirty evidence before use.
```
