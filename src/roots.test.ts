import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, resolveAllowedPath } from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );

  // Test casing mismatch normalization
  assert.equal(
    assertAllowedPath("E:\\code\\meta-harness", ["E:\\Code"]),
    "E:\\code\\meta-harness",
  );

  // Test forward slash normalization
  assert.equal(
    assertAllowedPath("E:/code/meta-harness", ["E:\\Code"]),
    "E:\\code\\meta-harness",
  );

  // Test WSL path translation
  assert.equal(
    assertAllowedPath("/mnt/e/code/meta-harness", ["E:\\Code"]),
    "E:\\code\\meta-harness",
  );

  // Test WSL path translation before cwd resolution
  assert.equal(
    resolveAllowedPath("/mnt/e/code/meta-harness", "E:\\Code\\devspace", ["E:\\Code"]),
    "E:\\code\\meta-harness",
  );
}
