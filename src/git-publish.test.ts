import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { publishGitChanges } from "./git-publish.js";

const root = await mkdtemp(join(tmpdir(), "devspace-git-publish-test-"));
const repository = join(root, "repository");
const remote = join(root, "remote.git");

try {
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "DevSpace Test"]);
  await git(repository, ["config", "user.email", "devspace-test@example.invalid"]);

  await writeFile(join(repository, "allowed.txt"), "initial\n", "utf8");
  await writeFile(join(repository, "unrelated.txt"), "initial\n", "utf8");
  await git(repository, ["add", "--", "allowed.txt", "unrelated.txt"]);
  await git(repository, ["commit", "-m", "initial"]);

  await git(root, ["init", "--bare", remote]);
  await git(repository, ["remote", "add", "origin", remote]);

  await writeFile(join(repository, "allowed.txt"), "published\n", "utf8");
  await writeFile(join(repository, "unrelated.txt"), "not published\n", "utf8");

  await assert.rejects(
    publishGitChanges({
      cwd: repository,
      workspaceRoot: root,
      paths: ["."],
      message: "must reject directories",
      push: false,
    }),
    /Directories are not accepted/,
  );
  await assert.rejects(
    publishGitChanges({
      cwd: repository,
      workspaceRoot: root,
      paths: ["*.txt"],
      message: "must reject pathspecs",
      push: false,
    }),
    /Git pathspec syntax is not allowed/,
  );

  const published = await publishGitChanges({
    cwd: repository,
    workspaceRoot: root,
    paths: ["allowed.txt"],
    message: "publish allowed file",
  });

  assert.equal(published.branch, "main");
  assert.equal(published.remote, "origin");
  assert.equal(published.pushed, true);
  assert.deepEqual(published.paths, ["allowed.txt"]);
  assert.equal(
    (await git(repository, ["show", "HEAD:allowed.txt"])).stdout,
    "published\n",
  );
  assert.equal(
    (await git(repository, ["show", "HEAD:unrelated.txt"])).stdout,
    "initial\n",
  );
  assert.equal(
    (await git(remote, ["rev-parse", "refs/heads/main"])).stdout.trim(),
    published.commit,
  );
  assert.match(
    (await git(repository, ["status", "--short", "--", "unrelated.txt"])).stdout,
    /^ M unrelated\.txt/m,
  );

  await writeFile(join(repository, "allowed.txt"), "second change\n", "utf8");
  await git(repository, ["add", "--", "unrelated.txt"]);
  await assert.rejects(
    publishGitChanges({
      cwd: repository,
      workspaceRoot: root,
      paths: ["allowed.txt"],
      message: "must not include unrelated staging",
      push: false,
    }),
    /unrelated paths are already staged: unrelated\.txt/,
  );
  await git(repository, ["restore", "--staged", "--", "unrelated.txt"]);

  await writeFile(join(repository, "allowed.txt"), "trailing whitespace  \n", "utf8");
  await assert.rejects(
    publishGitChanges({
      cwd: repository,
      workspaceRoot: root,
      paths: ["allowed.txt"],
      message: "must fail whitespace check",
      push: false,
    }),
  );
  assert.equal(
    (await git(repository, ["rev-parse", "HEAD"])).stdout.trim(),
    published.commit,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
