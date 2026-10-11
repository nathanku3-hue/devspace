# Test suite execution and evidence

`npm test` runs all of the previously covered tests in **serial, named groups**.
The Node runner lives at `scripts/run-tests.mjs`. It invokes each test in a
separate process, with no automatic retries. It continues recording other cases
after a failure and exits nonzero if any case fails, times out, or cannot start.

Useful commands:

```bash
npm test
node scripts/run-tests.mjs --list
node scripts/run-tests.mjs --group auth-mcp
node scripts/run-tests.mjs --group scope --results-dir ./test-results
npm run test:runner
```

Each invocation creates a distinct ignored directory
`test-results/run-<timestamp>-<id>/`. `summary.json` is atomically updated
after each case, and each group's `group.log` retains stdout, stderr, the
command, and exit outcome. The final summary records aggregate pass/fail/timeout
counts and an explicit `passed`/`failed` status. An interrupted runner can leave
status `running`; that is **not** a pass. Inspect individual groups for the last
completed case.

`DEVSPACE_TEST_CASE_TIMEOUT_MS` controls the per-case deadline (default:
300000 ms). The test runner does not relax assertion failures, retry flaky
cases, or hide a failed exit code. On Windows tests run sequentially to avoid
introducing Git and SQLite fixture contention.

CI runs `npm test` and uploads `test-results/` as a build artifact with
`if: always()`. CI may run longer than a remote MCP shell call's execution
ceiling, so a remote command timeout alone must not be reported as a failed
test assertion or as full-suite success. A complete single-command
`summary.json` with `status: "passed"` is the acceptance evidence.
