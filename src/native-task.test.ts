import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeTaskWritePath,
  authorizeNativeTaskPublish,
  bindNativeTask,
  buildNativeTaskEnvironment,
  runNativeTaskValidation,
  validationInvocation,
  type NativeTaskBriefInput,
} from "./native-task.js";

const root = await mkdtemp(join(tmpdir(), "devspace-native-task-test-"));

function brief(overrides: Partial<NativeTaskBriefInput> = {}): NativeTaskBriefInput {
  return {
    productResult: "Deliver one verified native task result.",
    journeyState: "The product result and scope are accepted.",
    doNow: "Create the bounded result.",
    doneWhen: "The result exists and exact external validation passes.",
    stopOnlyIf: ["The accepted path boundary is insufficient."],
    repository: root,
    allowedPaths: ["src"],
    validation: [
      {
        argv: [
          process.execPath,
          "-e",
          "if (process.env.DEVSPACE_TEST_SECRET) process.exit(91)",
        ],
        cwd: ".",
        timeoutSeconds: 30,
      },
    ],
    git: {
      remote: "origin",
      branch: "product/native-task",
      paths: ["src/result.txt"],
      commit: true,
      push: true,
    },
    ...overrides,
  };
}

try {
  await mkdir(join(root, "src"), { recursive: true });

  const task = bindNativeTask(brief(), root, root);
  assert.match(task.taskId, /^task_[0-9a-f-]{36}$/);
  assert.match(task.taskDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(task.outcome, "READY");

  assertNativeTaskWritePath(task, root, join(root, "src", "result.txt"));
  assert.throws(
    () => assertNativeTaskWritePath(task, root, join(root, "README.md")),
    /does not authorize writing README\.md/,
  );
  assert.throws(
    () => bindNativeTask(brief({ repository: join(root, "other") }), root, root),
    /does not match the opened repository/,
  );

  const environment = buildNativeTaskEnvironment({
    PATH: process.env.PATH,
    DEVSPACE_TEST_SECRET: "must-not-cross",
  });
  assert.equal(environment.DEVSPACE_TEST_SECRET, undefined);
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");

  const comSpec = "C:\\Windows\\System32\\cmd.exe";
  const invocationEnvironment = { ComSpec: comSpec };
  const cmdArgs = (argv: string[]) => [
    "/d",
    "/s",
    "/c",
    `"${argv.map((value) => `"${value}"`).join(" ")}"`,
  ];
  const absoluteNpmArgv = ["D:\\nodejs\\npm.cmd", "run", "test:powershell"];
  assert.deepEqual(
    validationInvocation(
      { argv: absoluteNpmArgv, cwd: ".", timeoutSeconds: 30 },
      invocationEnvironment,
      "win32",
    ),
    {
      executable: comSpec,
      args: cmdArgs(absoluteNpmArgv),
      windowsVerbatimArguments: true,
    },
  );

  const spacedNpmArgv = ["C:\\Program Files\\nodejs\\npm.cmd", "run", "build"];
  assert.deepEqual(
    validationInvocation(
      { argv: spacedNpmArgv, cwd: ".", timeoutSeconds: 30 },
      invocationEnvironment,
      "win32",
    ),
    {
      executable: comSpec,
      args: cmdArgs(spacedNpmArgv),
      windowsVerbatimArguments: true,
    },
  );

  for (const executable of ["npm", "npm.cmd"]) {
    assert.deepEqual(
      validationInvocation(
        { argv: [executable, "--version"], cwd: ".", timeoutSeconds: 30 },
        invocationEnvironment,
        "win32",
      ),
      {
        executable: comSpec,
        args: cmdArgs([executable, "--version"]),
        windowsVerbatimArguments: true,
      },
    );
  }

  const directExeArgv = ["C:\\tools\\validator.exe", "--check"];
  assert.deepEqual(
    validationInvocation(
      { argv: directExeArgv, cwd: ".", timeoutSeconds: 30 },
      invocationEnvironment,
      "win32",
    ),
    { executable: directExeArgv[0], args: [directExeArgv[1]] },
  );

  assert.throws(
    () =>
      authorizeNativeTaskPublish(task, root, root, ["src/result.txt"], {
        remote: "origin",
        branch: "product/native-task",
        push: true,
      }),
    /must pass external validation/,
  );

  const validation = runNativeTaskValidation(task, {
    ...process.env,
    DEVSPACE_TEST_SECRET: "must-not-cross",
  });
  assert.equal(validation.outcome, "DONE", validation.blocker);
  assert.equal(validation.validation.length, 1);
  assert.equal(validation.validation[0].passed, true);

  if (process.platform === "win32") {
    const shimDirectory = join(root, "package manager path");
    const shimPath = join(shimDirectory, "npm.cmd");
    await mkdir(shimDirectory, { recursive: true });
    await writeFile(
      shimPath,
      '@echo off\r\nif "%~1"=="fail" exit /b 7\r\necho shim-ok\r\nexit /b 0\r\n',
      "utf8",
    );

    const shimArgv = [shimPath, "pass"];
    const shimTask = bindNativeTask(
      brief({
        validation: [{ argv: shimArgv, cwd: ".", timeoutSeconds: 30 }],
      }),
      root,
      root,
    );
    const shimValidation = runNativeTaskValidation(shimTask, {
      ...process.env,
      ComSpec: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
    });
    assert.equal(shimValidation.outcome, "DONE", shimValidation.blocker);
    assert.deepEqual(shimValidation.validation[0].argv, shimArgv);
    assert.match(shimValidation.validation[0].output, /shim-ok/);

    const failingShimTask = bindNativeTask(
      brief({
        validation: [{ argv: [shimPath, "fail"], cwd: ".", timeoutSeconds: 30 }],
      }),
      root,
      root,
    );
    const failingShimValidation = runNativeTaskValidation(failingShimTask, process.env);
    assert.equal(failingShimValidation.outcome, "BLOCKED");
    assert.equal(failingShimValidation.validation[0].exitCode, 7);
  }

  assert.deepEqual(
    authorizeNativeTaskPublish(task, root, root, ["src/result.txt"], {}),
    { remote: "origin", branch: "product/native-task", push: true },
  );
  assert.throws(
    () => authorizeNativeTaskPublish(task, root, root, ["src/other.txt"], {}),
    /does not authorize Git custody/,
  );
  assert.throws(
    () =>
      authorizeNativeTaskPublish(task, root, root, ["src/result.txt"], {
        remote: "upstream",
      }),
    /authorizes remote origin, not upstream/,
  );

  const unverifiedTask = bindNativeTask(brief({ validation: [] }), root, root);
  assert.equal(runNativeTaskValidation(unverifiedTask).outcome, "UNVERIFIED");

  const blockedTask = bindNativeTask(
    brief({
      validation: [
        {
          argv: [process.execPath, "-e", "process.exit(7)"],
          cwd: ".",
          timeoutSeconds: 30,
        },
      ],
    }),
    root,
    root,
  );
  assert.equal(runNativeTaskValidation(blockedTask).outcome, "BLOCKED");

  const noCommitTask = bindNativeTask(
    brief({
      git: {
        remote: "origin",
        branch: "product/native-task",
        paths: ["src/result.txt"],
        commit: false,
        push: false,
      },
    }),
    root,
    root,
  );
  runNativeTaskValidation(noCommitTask);
  assert.throws(
    () => authorizeNativeTaskPublish(noCommitTask, root, root, ["src/result.txt"], {}),
    /does not authorize a commit/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
