# Expert Reconciliation Matrix

Status: Template
Purpose: reconcile expert recommendations into one orchestrator decision.

## Mode And Stale Rules

```text
Mode: <ADVISORY_REVIEW|APPROVAL_GATE|EXECUTION_PACKET|CLOSURE_REPORT>
No artifact may use more than one mode.
StaleReportRule: if an expert report predates current truth, prepend "Superseded on authorization status by <RoundID>; still valid only for guardrails."
OneDecisionRule: reconcile to one next action; downstream architecture belongs in deferred recommendations.
If no single next action can be selected, verdict must be BLOCK with max 3 blockers.
```

## Header

```text
RoundID: <round-id>
ScopeID: <scope-id>
Date: <YYYY-MM-DD>
Orchestrator: <name or role>
PreRoute: <NO_BUILD|USE_EXISTING_REPO_PATTERN|USE_PLATFORM_NATIVE|MINIMAL_PATCH|HUMAN_TASTE|EXPERT_PACKET|AUTHORITY_BLOCK>
Route: <FAST|REVIEW|SLOW|BLOCK>
Outcome: <SHIP|REVIEW|DECISION_NEEDED|BLOCKED|FOLLOW_UP_QUEUED>
DecisionState: <PENDING|APPROVED|BLOCKED|DEFERRED>
```

## Matrix

```text
+--------------+----------------+------+----------------+-----------------+--------------+-----------------------+
| Expert       | Recommendation | Veto | LowConfidence  | OutOfBoundary   | StreamOrder  | OrchestratorDecision  |
+--------------+----------------+------+----------------+-----------------+--------------+-----------------------+
| Product      | <short rec>    | Y/N  | Y/N + reason   | Y/N + boundary  | <1..N/hold>  | <accept/defer/reject> |
| Architecture | <short rec>    | Y/N  | Y/N + reason   | Y/N + boundary  | <1..N/hold>  | <accept/defer/reject> |
| Domain       | <short rec>    | Y/N  | Y/N + reason   | Y/N + boundary  | <1..N/hold>  | <accept/defer/reject> |
| Ops          | <short rec>    | Y/N  | Y/N + reason   | Y/N + boundary  | <1..N/hold>  | <accept/defer/reject> |
+--------------+----------------+------+----------------+-----------------+--------------+-----------------------+
```

## Findings

```text
+------------+----------+-------------------+----------------+--------------+----------+-------------+
| FindingID  | Severity | Impact            | Fix            | Owner        | Status   | Disposition |
+------------+----------+-------------------+----------------+--------------+----------+-------------+
| F-01       | <...>    | <short impact>    | <short fix>    | <owner/role> | <open/fixed/deferred> | <accept/defer/reject> |
| F-02       | <...>    | <short impact>    | <short fix>    | <owner/role> | <open/fixed/deferred> | <accept/defer/reject> |
+------------+----------+-------------------+----------------+--------------+----------+-------------+
```

## Reconciliation Rules

```text
VetoRule: any in-scope veto requires BLOCK or explicit orchestrator override.
LowConfidenceRule: low_confidence requires next verification step before closure.
BoundaryRule: out_of_boundary items move to open risks or future scope.
StreamOrderRule: stream_order defines execution sequence; hold means no execution.
FindingRule: every material finding needs an owner, fix, status, and disposition before reconciliation can close.
BuildVsBorrowRule: if the pre-route is not `EXPERT_PACKET` or `HUMAN_TASTE`, reconcile why expert judgment was still necessary or defer the packet.
AuthorityRule: product, architecture, security, release, provider, and domain-authority changes cannot close with terminal outcome `SHIP`.
```

## Decision

```text
OrchestratorDecision: <one-line final decision>
AcceptedRecommendations:
- <expert>: <item or none>
DeferredRecommendations:
- <expert>: <item or none>
RejectedRecommendations:
- <expert>: <item or none>
OpenRisks:
- <risk or none>
NextAction: <single next action>
```
