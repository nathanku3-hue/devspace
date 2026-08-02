# Decision Reuse Contract

Status: Template
Purpose: stop re-asking previously distilled decisions unless the recorded assumptions changed.

## Reuse Rule

Do not re-ask a decision when all are unchanged:

- source decision id;
- principle;
- local skill or contract target;
- assumptions;
- reopen condition.

## Reopen Rule

Reopen the decision when assumptions change or the recorded `reopen_when` condition becomes true.

## Routing Rule

```text
repeated judgment -> skill
deterministic invariant -> script/check
domain, taste, or risk judgment -> expert/user
```

## Provenance Rule

Every reusable decision needs local provenance:

- source decision id;
- principle;
- assumptions;
- owner or reviewer;
- reopen condition;
- enforcement check or `human-only`.

## Import Rule

Decision reuse is local-only. Do not import remote or public skill instructions as part of reuse.
