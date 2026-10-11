import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeIdentity {
  schemaVersion: "devspace-runtime/v1";
  toolSchemaRevision: "repo-custody-1";
  sourceHeadSha: string | null;
  sourceDirty: boolean;
  binaryDigestSha256: string | null;
  filesHashed: number;
  builtAt: string | null;
  runtimeStartedAt: string;
  receiptDigestSha256: string;
  status: "DISK_BUILD_VERIFIED" | "STALE_RUNTIME" | "UNVERIFIED";
}

const runtimeStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

export function hashRuntimeDist(dist: string): string {
  const paths: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name !== "build-identity.json") paths.push(path);
    }
  }
  walk(dist);
  paths.sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(relative(dist, path).split(sep).join("/"));
    digest.update("\0");
    digest.update(createHash("sha256").update(readFileSync(path)).digest());
  }
  return digest.digest("hex");
}

export function getRuntimeIdentity(): RuntimeIdentity {
  return inspectRuntimeIdentity(dirname(fileURLToPath(import.meta.url)), runtimeStartedAt);
}

export function inspectRuntimeIdentity(dist: string, startedAt: string): RuntimeIdentity {
  const base: Omit<RuntimeIdentity, "receiptDigestSha256" | "status"> = {
    schemaVersion: "devspace-runtime/v1",
    toolSchemaRevision: "repo-custody-1",
    sourceHeadSha: null,
    sourceDirty: true,
    binaryDigestSha256: null,
    filesHashed: 0,
    builtAt: null,
    runtimeStartedAt: startedAt,
  };
  let status: RuntimeIdentity["status"] = "UNVERIFIED";
  try {
    const parsed = JSON.parse(readFileSync(join(dist, "build-identity.json"), "utf8")) as Partial<RuntimeIdentity>;
    if (parsed.schemaVersion === base.schemaVersion
        && parsed.toolSchemaRevision === base.toolSchemaRevision
        && typeof parsed.binaryDigestSha256 === "string"
        && /^[a-f0-9]{64}$/.test(parsed.binaryDigestSha256)) {
      if (hashRuntimeDist(dist) === parsed.binaryDigestSha256
          && typeof parsed.builtAt === "string"
          && Number.isFinite(Date.parse(parsed.builtAt))
          && Number.isFinite(Date.parse(startedAt))) {
        Object.assign(base, {
          sourceHeadSha: parsed.sourceHeadSha ?? null,
          sourceDirty: parsed.sourceDirty !== false,
          binaryDigestSha256: parsed.binaryDigestSha256,
          filesHashed: parsed.filesHashed ?? 0,
          builtAt: parsed.builtAt,
        });
        status = Date.parse(parsed.builtAt) > Date.parse(startedAt)
          ? "STALE_RUNTIME" : "DISK_BUILD_VERIFIED";
      }
    }
  } catch {
    // Direct tsx runs and deployments without a matching build manifest fail unverified.
  }
  const receiptDigestSha256 = createHash("sha256").update(JSON.stringify({ ...base, status })).digest("hex");
  return { ...base, receiptDigestSha256, status };
}
