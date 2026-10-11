# MCP v2 / Repo Custody release gate

This branch integrates the modern MCP protocol adapter with the existing
legacy sessionful transport and repository custody boundary. It is **not**
production activated merely because it has been pushed or built locally.

## Required gates

1. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`
   from the intended checkout. The test acceptance proof is one complete
   `test-results/run-*/summary.json` with `status: "passed"`, no failed
   or timed-out cases, and all eight groups present.
2. Push `feat/mcp-v2-custody-adapter` to the fork. The dedicated
   `mcp-v2-custody-branch-ci.yml` workflow runs on branch push and checks
   Linux, macOS, and Windows using Node.js 22. Download retained test
   artifacts to confirm all three `summary.json` files passed. A queued
   or missing workflow run is **not** a CI pass.
3. Review the resulting Git commits and any open PR separately from the
   upstream `Waishnav/devspace`; do not merge upstream wholesale or
   overwrite active local workspace changes.
4. After all platform jobs pass, stage the build for the intended
   production checkout and follow its deployment/rollback procedure.
   Never replace the running origin's `dist` in place without a safe
   supervisor-controlled deployment plan and service ownership check.
5. Refresh each MCP host's tool catalog / schema. The source registering
   `commit_and_close`, `detach_workspace`, and
   `devspace_runtime_identity` alone does not prove host visibility.
6. Confirm authenticated discovery and old/new protocol tool calls
   against the actually running origin; call `devspace_runtime_identity`
   and require a verified on-disk build/runtime result (not `UNVERIFIED`
   or `STALE_RUNTIME`). Keep source HEAD, compiled digest, and running
   process identity distinct.
7. Confirm the Meta-Harness receipt consumer treats DevSpace receipts as
   `PHYSICAL_CUSTODY_ONLY`; a Git commit or successful process alone is
   not product acceptance.

## Local pre-push evidence (2026-10-11)

Windows Node.js v25.2.1: `npm ci`, TypeScript typecheck, and production
build passed. A single `npm test` invocation passed 34 test entrances
in 8 groups (0 failures; 0 timeouts). Evidence directory:

`test-results/run-2026-10-11T14-55-02-669Z-9a93fe37/`

This evidence does not replace Node.js 22 / three-platform CI results.
The current worktree's build identity must be regenerated after any Git
commit or deployment change before relying on its source SHA.

## Rollback boundary

Keep the previously running build and its runtime custody data available.
If a host schema mismatch, failing authenticated probe, or runtime identity
mismatch appears, do not claim deployment success; return to the prior
verified origin and recheck the host's published tool schema.
