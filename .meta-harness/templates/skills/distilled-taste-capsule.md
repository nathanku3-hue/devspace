---
name: distilled-taste-capsule
description: Capture durable local judgment from prior decisions without automatically mutating skills.
---

# Distilled Taste Capsule

Use this when a repeated expert or user judgment should become durable local harness behavior.

## Principle

Turn repeated decisions into reusable local behavior only after preserving provenance, assumptions, and the condition that would reopen the decision.

## Routing

```text
repeated judgment -> local skill or contract
deterministic invariant -> script/check
domain, taste, or risk judgment -> expert/user
```

## Required Provenance

Every distilled judgment must record:

- source decision id;
- principle;
- target local skill or contract;
- assumptions;
- owner or reviewer;
- reopen condition;
- optional deterministic enforcement check.

## Reuse Rule

Do not re-ask the same decision when the source decision state and assumptions are unchanged. Reopen when assumptions change or the recorded reopen condition becomes true.

## Safety

Use local capsule names only. Do not import remote or public skill instructions. No automatic skill mutation in v0.
