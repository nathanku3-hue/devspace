import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile() && entry.name !== "build-identity.json") files.push(absolute);
  }
}
await walk(dist);
files.sort();
const digest = createHash("sha256");
for (const file of files) {
  digest.update(relative(dist, file).split(sep).join("/"));
  digest.update("\0");
  digest.update(createHash("sha256").update(await readFile(file)).digest());
}
function git(args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
  catch { return null; }
}
const identity = {
  schemaVersion: "devspace-runtime/v1",
  toolSchemaRevision: "repo-custody-1",
  sourceHeadSha: git(["rev-parse", "HEAD"]),
  sourceDirty: (git(["status", "--porcelain", "--untracked-files=all"]) ?? "?") !== "",
  binaryDigestSha256: digest.digest("hex"),
  filesHashed: files.length,
  builtAt: new Date().toISOString(),
};
await writeFile(join(dist, "build-identity.json"), JSON.stringify(identity, null, 2) + "\n");
console.log("DevSpace build identity written: " + identity.binaryDigestSha256);
