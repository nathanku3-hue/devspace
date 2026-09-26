import assert from "node:assert/strict";
import { createGuardedBashOperations } from "./shell-runtime.js";
import { resolveWorkspaceShell } from "./workspace-shell.js";

const operations = createGuardedBashOperations(resolveWorkspaceShell(), 1024);
let forwarded = 0;

await assert.rejects(
  () =>
    operations.exec(
      `node -e "process.stdout.write('x'.repeat(4096))"`,
      process.cwd(),
      {
        onData: (chunk) => {
          forwarded += chunk.length;
        },
        timeout: 10,
        env: { ...process.env },
      },
    ),
  /output safety limit/i,
);
assert.ok(forwarded <= 1024, `forwarded ${forwarded} bytes past the configured limit`);
