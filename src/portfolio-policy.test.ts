import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { createManagedWorktree, removeManagedWorktree } from "./git-worktrees.js";
import { PortfolioPolicyError } from "./portfolio-policy.js";

const execFileAsync = promisify(execFile);

interface PolicyOverrides {
  permittedPrimaryBranches?: string[];
  maximumActiveWorktrees?: number;
  maximumInactiveWorktrees?: number;
  terminalCustodyMode?: string;
  physicalParityRequired?: boolean;
  primaryCleanRequired?: boolean;
  exceptions?: Array<Record<string, unknown>>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepository(name: string) {
  const root = await mkdtemp(join(tmpdir(), `devspace-policy-${name}-`));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", `${name}@example.invalid`]);
  await git(root, ["config", "user.name", `Policy ${name}`]);
  await writeFile(join(root, "README.md"), `${name}\n`);
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "fixture"]);
  await git(root, ["branch", "-M", "main"]);
  await mkdir(join(root, ".worktrees"), { recursive: true });
  await writeFile(join(root, ".git", "info", "exclude"), "/.worktrees/\n");
  const policyPath = join(root, "portfolio-policy.json");
  const receiptPath = join(root, "terminal-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify({ custodyVerified: true }, null, 2)}\n`);
  return { root, policyPath, receiptPath };
}

async function writePolicy(
  fixture: Awaited<ReturnType<typeof createRepository>>,
  overrides: PolicyOverrides = {},
): Promise<void> {
  const repository = {
    id: "fixture",
    canonicalPath: fixture.root,
    remote: null,
    declaredIntegrationBranch: "main",
    permittedPrimaryBranches: ["main"],
    vendorClassification: "test-fixture",
    maximumActiveWorktrees: 4,
    maximumInactiveWorktrees: 4,
    terminalCustodyMode: "external-receipt",
    externalEvidenceRoot: join(fixture.root, "evidence"),
    externalArchiveRoot: join(fixture.root, "archive"),
    physicalParityRequired: true,
    primaryCleanRequired: false,
    exceptions: [{
      id: "terminal-custody",
      kind: "terminal-custody",
      owner: "test",
      reviewCondition: "while the fixture exists",
      receiptPath: fixture.receiptPath,
    }],
    ...overrides,
  };
  await writeFile(fixture.policyPath, `${JSON.stringify({
    schema: "portfolio-custody-policy/v1",
    repositories: [repository],
  }, null, 2)}\n`);
}

function configFor(fixture: Awaited<ReturnType<typeof createRepository>>, includePolicy = true) {
  return loadConfig({
    DEVSPACE_CONFIG_DIR: join(fixture.root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: fixture.root,
    DEVSPACE_PORTFOLIO_POLICY: includePolicy ? fixture.policyPath : undefined,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
}

async function expectPolicyCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof PortfolioPolicyError && error.code === code,
  );
}

async function cleanupWorktree(fixture: Awaited<ReturnType<typeof createRepository>>, worktreePath: string): Promise<void> {
  await git(fixture.root, ["worktree", "remove", "--force", "--", worktreePath]).catch(() => undefined);
}

{
  const fixture = await createRepository("required");
  try {
    await expectPolicyCode(
      () => createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture, false) }),
      "GIT_WORKTREE_POLICY_REQUIRED",
    );
    await writeFile(fixture.policyPath, `${JSON.stringify({ schema: "portfolio-custody-policy/v1", repositories: [] })}\n`);
    await expectPolicyCode(
      () => createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture) }),
      "GIT_WORKTREE_POLICY_REQUIRED",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = await createRepository("branch");
  try {
    await writePolicy(fixture, { permittedPrimaryBranches: ["integration"] });
    await expectPolicyCode(
      () => createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture) }),
      "GIT_WORKTREE_PRIMARY_BRANCH",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = await createRepository("dirty");
  try {
    await writePolicy(fixture, { primaryCleanRequired: true });
    await writeFile(join(fixture.root, "dirty.txt"), "dirty\n");
    await expectPolicyCode(
      () => createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture) }),
      "GIT_WORKTREE_PRIMARY_DIRTY",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = await createRepository("parity");
  try {
    await writePolicy(fixture);
    await mkdir(join(fixture.root, ".worktrees", "physical-only"));
    await expectPolicyCode(
      () => createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture) }),
      "GIT_WORKTREE_PARITY",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = await createRepository("capacity");
  try {
    await writePolicy(fixture, { maximumActiveWorktrees: 0 });
    await expectPolicyCode(
      () => createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture) }),
      "GIT_WORKTREE_CAPACITY",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = await createRepository("terminal");
  let worktreePath = "";
  try {
    await writePolicy(fixture);
    const worktree = await createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture) });
    worktreePath = worktree.path;
    await writePolicy(fixture, { terminalCustodyMode: "remote", exceptions: [] });
    await expectPolicyCode(
      () => removeManagedWorktree({ sourceRoot: fixture.root, worktreePath, config: configFor(fixture) }),
      "GIT_WORKTREE_TERMINAL_CUSTODY",
    );
  } finally {
    if (worktreePath) await cleanupWorktree(fixture, worktreePath);
    await rm(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = await createRepository("exception");
  let worktreePath = "";
  try {
    await writePolicy(fixture);
    const worktree = await createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture) });
    worktreePath = worktree.path;
    await writePolicy(fixture, {
      exceptions: [
        {
          id: "live-runtime",
          kind: "live-runtime",
          path: worktreePath,
          owner: "test",
          reviewCondition: "until deliberately stopped",
        },
        {
          id: "terminal-custody",
          kind: "terminal-custody",
          owner: "test",
          reviewCondition: "while the fixture exists",
          receiptPath: fixture.receiptPath,
        },
      ],
    });
    await expectPolicyCode(
      () => removeManagedWorktree({ sourceRoot: fixture.root, worktreePath, config: configFor(fixture) }),
      "GIT_WORKTREE_ACTIVE_EXCEPTION",
    );
  } finally {
    if (worktreePath) await cleanupWorktree(fixture, worktreePath);
    await rm(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = await createRepository("process");
  let worktreePath = "";
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await writePolicy(fixture);
    const worktree = await createManagedWorktree({ sourcePath: fixture.root, config: configFor(fixture) });
    worktreePath = worktree.path;
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", worktreePath], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expectPolicyCode(
      () => removeManagedWorktree({ sourceRoot: fixture.root, worktreePath, config: configFor(fixture) }),
      "GIT_WORKTREE_ACTIVE_PROCESS",
    );
  } finally {
    child?.kill();
    if (worktreePath) await cleanupWorktree(fixture, worktreePath);
    await rm(fixture.root, { recursive: true, force: true });
  }
}
