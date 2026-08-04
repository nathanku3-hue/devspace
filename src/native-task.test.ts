import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeTaskWritePath,
  authorizeNativeTaskPublish,
  bindNativeTask,
  buildNativeTaskEnvironment,
  runNativeTaskValidation,
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
