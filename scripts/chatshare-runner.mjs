#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { createServer } from "node:http";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { chromium } from "playwright-core";
import { z } from "zod";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ROOT = join(REPO_ROOT, "data", "chatshare-agentic");
const DEFAULT_CONCURRENCY = 3;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 5;
const DEFAULT_MAX_TEXT_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "must be valid 64-character hex SHA-256");

export const modelOutputSchema = z
  .object({
    summary: z.string().min(1),
    findings: z.array(
      z
        .object({
          claim: z.string().min(1),
          evidence_quote: z.string().min(1),
        })
        .strict(),
    ),
    uncertainties: z.array(z.string().min(1)),
  })
  .strict();

export const provenanceSchema = z
  .object({
    execution_surface: z.enum(["chatgpt_web", "chatshare"]),
    declared_model: z.string().min(1),
    api_mode: z.literal(false),
    session_id: z.string().optional(),
    conversation_id: z.string().optional(),
    sealed_at: z.string().optional(),
  })
  .strict();

export const jobSchema = z
  .object({
    id: z.string().trim().min(1),
    url: z.string().url(),
    instruction: z.string().trim().min(1),
  })
  .strict();

export const sealInputSchema = z
  .object({
    job_id: z.string().min(1),
    evidence_sha256: sha256HexSchema,
    packet_sha256: sha256HexSchema,
    collect_manifest: z.string().optional(),
    provenance: provenanceSchema,
    result: modelOutputSchema,
  })
  .strict();

export function utcNow() {
  return new Date().toISOString();
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value) {
  return sha256Bytes(Buffer.from(stableStringify(value), "utf8"));
}

export function relativePosix(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

export async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeImmutableJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

export async function writeGzipIfMissing(path, payload) {
  try {
    await stat(path);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const inputPath = `${tempPath}.json`;
  const handle = await open(inputPath, "wx");
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await pipeline(
      createReadStream(inputPath),
      createGzip({ level: 9 }),
      createWriteStream(tempPath, { flags: "wx" }),
    );
    try {
      await rename(tempPath, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    await Promise.allSettled([
      import("node:fs/promises").then(({ rm }) => rm(inputPath, { force: true })),
      import("node:fs/promises").then(({ rm }) => rm(tempPath, { force: true })),
    ]);
  }
}

export function assertHttpUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("job.url must use http or https");
  }
  return parsed.toString();
}

export function custodyPaths(root, date, runId) {
  return {
    root,
    jobs: join(root, "input", "jobs.jsonl"),
    rawDir: join(root, "raw"),
    packetsDir: join(root, "packets"),
    records: join(root, "records", date, "evidence.jsonl"),
    sealedRecords: join(root, "records", date, "sealed.jsonl"),
    statuses: join(root, "status.jsonl"),
    manifestDir: join(root, "manifests"),
    manifest: join(root, "manifests", `${runId}.json`),
  };
}

export async function launchBrowserBackend({ preferredChannel = null } = {}) {
  const args = ["--disable-gpu", "--disable-dev-shm-usage"];
  if (preferredChannel) {
    const browser = await chromium.launch({ channel: preferredChannel, headless: true, args });
    return {
      browser,
      metadata: {
        browser_engine: "chromium",
        browser_variant: preferredChannel === "chrome" ? "installed_chrome_new_headless" : preferredChannel,
        browser_version: browser.version(),
        fallback_used: false,
        fallback_reason: null,
      },
    };
  }

  try {
    const browser = await chromium.launch({ headless: true, args });
    return {
      browser,
      metadata: {
        browser_engine: "chromium",
        browser_variant: "headless_shell",
        browser_version: browser.version(),
        fallback_used: false,
        fallback_reason: null,
      },
    };
  } catch (err) {
    const fallbackReason = err instanceof Error ? err.message : String(err);
    const browser = await chromium.launch({ channel: "chrome", headless: true, args });
    return {
      browser,
      metadata: {
        browser_engine: "chromium",
        browser_variant: "installed_chrome_new_headless",
        browser_version: browser.version(),
        fallback_used: true,
        fallback_reason: fallbackReason.slice(0, 300),
      },
    };
  }
}

export async function collectEvidenceWithBrowser(
  browser,
  url,
  {
    maxTextChars = DEFAULT_MAX_TEXT_CHARS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const safeUrl = assertHttpUrl(url);
  let context;
  let page;
  try {
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    await context.route("**/*", async (route) => {
      if (["image", "media", "font"].includes(route.request().resourceType())) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    page = await context.newPage();
    const response = await page.goto(safeUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const [title, text, userAgent] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText({ timeout: 10_000 }).catch(() => ""),
      page.evaluate(() => navigator.userAgent).catch(() => ""),
    ]);

    const headers = response ? await response.allHeaders() : {};
    return {
      source_url: safeUrl,
      final_url: page.url(),
      title: title || "",
      text: (text || "").slice(0, maxTextChars),
      retrieved_at: utcNow(),
      http_status: response?.status() ?? null,
      content_type: headers["content-type"] ?? null,
      user_agent: userAgent || "",
    };
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
  }
}

export function buildEvidencePacket(job, evidence, evidenceSha256) {
  return {
    task: job.instruction,
    evidence: {
      title: evidence.title,
      source_url: evidence.source_url,
      final_url: evidence.final_url,
      text: evidence.text,
      sha256: evidenceSha256,
      retrieved_at: evidence.retrieved_at,
    },
  };
}

export async function runWithBoundedConcurrency(items, limit, workerFn) {
  const concurrency = Math.min(Math.max(limit, MIN_CONCURRENCY), MAX_CONCURRENCY);
  const results = new Array(items.length);
  let nextIndex = 0;
  let activeCount = 0;
  let maxActiveObserved = 0;

  return new Promise((resolve) => {
    if (items.length === 0) {
      return resolve({ results: [], maxActiveObserved: 0 });
    }

    function launchNext() {
      if (nextIndex >= items.length && activeCount === 0) {
        return resolve({ results, maxActiveObserved });
      }

      while (activeCount < concurrency && nextIndex < items.length) {
        const currentIndex = nextIndex++;
        activeCount++;
        if (activeCount > maxActiveObserved) {
          maxActiveObserved = activeCount;
        }

        Promise.resolve(workerFn(items[currentIndex], currentIndex))
          .then((val) => {
            results[currentIndex] = { status: "fulfilled", value: val };
          })
          .catch((err) => {
            results[currentIndex] = { status: "rejected", reason: err };
          })
          .finally(() => {
            activeCount--;
            launchNext();
          });
      }
    }

    launchNext();
  });
}

export async function collectJob(job, browser, browserMeta, paths, custodyRoot, options = {}) {
  const runId = randomUUID();
  const startedAt = utcNow();
  const jobSha256 = sha256Json(job);

  await appendJsonl(paths.jobs, {
    run_id: runId,
    accepted_at: startedAt,
    job_sha256: jobSha256,
    job,
  });

  await appendJsonl(paths.statuses, {
    run_id: runId,
    job_id: job.id,
    state: "collecting",
    at: startedAt,
  });

  try {
    const evidence = await collectEvidenceWithBrowser(browser, job.url, {
      maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const evidencePayload = Buffer.from(stableStringify(evidence), "utf8");
    const evidenceSha256 = sha256Bytes(evidencePayload);
    const rawPath = join(paths.rawDir, `${evidenceSha256}.json.gz`);
    const rawRelativePath = relativePosix(custodyRoot, rawPath);
    await writeGzipIfMissing(rawPath, evidencePayload);

    const packet = buildEvidencePacket(job, evidence, evidenceSha256);
    const packetSha256 = sha256Json(packet);
    // Packet filename is strictly determined by packetSha256 to eliminate collisions across different tasks
    const packetPath = join(paths.packetsDir, `${packetSha256}.json`);
    await writeImmutableJson(packetPath, packet);

    const completedAt = utcNow();
    const manifestPath = join(paths.manifestDir, `${runId}.json`);

    const artifact = {
      schema_version: 1,
      run_id: runId,
      job_id: job.id,
      job_sha256: jobSha256,
      evidence_sha256: evidenceSha256,
      packet_sha256: packetSha256,
      browser: browserMeta,
      paths: {
        raw: rawRelativePath,
        packet: relativePosix(custodyRoot, packetPath),
        record: relativePosix(custodyRoot, paths.records),
        status: relativePosix(custodyRoot, paths.statuses),
        manifest: relativePosix(custodyRoot, manifestPath),
      },
      evidence: {
        source_url: evidence.source_url,
        final_url: evidence.final_url,
        title: evidence.title,
        retrieved_at: evidence.retrieved_at,
        http_status: evidence.http_status,
      },
      started_at: startedAt,
      completed_at: completedAt,
      outcome: "succeeded",
    };

    await appendJsonl(paths.records, artifact);
    await writeImmutableJson(manifestPath, artifact);

    await appendJsonl(paths.statuses, {
      run_id: runId,
      job_id: job.id,
      state: "succeeded",
      at: completedAt,
      manifest: relativePosix(custodyRoot, manifestPath),
      evidence_sha256: evidenceSha256,
      packet_sha256: packetSha256,
    });

    return artifact;
  } catch (error) {
    const failedAt = utcNow();
    const manifestPath = join(paths.manifestDir, `${runId}.json`);
    const failureArtifact = {
      schema_version: 1,
      run_id: runId,
      job_id: job.id,
      job_sha256: jobSha256,
      evidence_sha256: null,
      packet_sha256: null,
      browser: browserMeta,
      outcome: "failed",
      stage: "collect",
      paths: {
        record: relativePosix(custodyRoot, paths.records),
        status: relativePosix(custodyRoot, paths.statuses),
        manifest: relativePosix(custodyRoot, manifestPath),
      },
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
      started_at: startedAt,
      completed_at: failedAt,
    };

    await appendJsonl(paths.records, failureArtifact);
    await writeImmutableJson(manifestPath, failureArtifact);

    await appendJsonl(paths.statuses, {
      run_id: runId,
      job_id: job.id,
      state: "failed",
      stage: "collect",
      at: failedAt,
      manifest: relativePosix(custodyRoot, manifestPath),
    });

    return failureArtifact;
  }
}

export async function runBatchCollect(rawJobs, options = {}) {
  const custodyRoot = resolve(options.root || DEFAULT_ROOT);
  const requestedConcurrency = options.concurrency ? Number(options.concurrency) : DEFAULT_CONCURRENCY;
  const concurrency = Math.min(Math.max(requestedConcurrency, MIN_CONCURRENCY), MAX_CONCURRENCY);

  const validatedJobs = rawJobs.map((j) => jobSchema.parse(j));
  const batchId = `batch-${randomUUID()}`;
  const startedAt = utcNow();
  const date = startedAt.slice(0, 10);
  const paths = custodyPaths(custodyRoot, date, batchId);

  const { browser, metadata: browserMeta } = await launchBrowserBackend({
    preferredChannel: options.browserChannel,
  });

  try {
    const { results, maxActiveObserved } = await runWithBoundedConcurrency(
      validatedJobs,
      concurrency,
      async (job) => {
        return await collectJob(job, browser, browserMeta, paths, custodyRoot, options);
      },
    );

    const completedAt = utcNow();
    const jobArtifacts = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        schema_version: 1,
        job_id: validatedJobs[i].id,
        outcome: "failed",
        stage: "pool",
        error: { name: "PoolError", message: String(r.reason) },
        started_at: startedAt,
        completed_at: completedAt,
      };
    });

    const succeededCount = jobArtifacts.filter((a) => a.outcome === "succeeded").length;
    const failedCount = jobArtifacts.filter((a) => a.outcome === "failed").length;

    const sortedSummaries = [...jobArtifacts]
      .sort((a, b) => a.job_id.localeCompare(b.job_id))
      .map((a) => ({
        job_id: a.job_id,
        run_id: a.run_id ?? null,
        outcome: a.outcome,
        job_sha256: a.job_sha256 ?? null,
        evidence_sha256: a.evidence_sha256 ?? null,
        packet_sha256: a.packet_sha256 ?? null,
        manifest: a.paths?.manifest ?? null,
      }));

    const batchAggregateSha256 = sha256Json(sortedSummaries);

    const batchManifest = {
      schema_version: 1,
      batch_id: batchId,
      total_jobs: validatedJobs.length,
      succeeded_jobs: succeededCount,
      failed_jobs: failedCount,
      concurrency,
      max_active_observed: maxActiveObserved,
      browser: browserMeta,
      batch_aggregate_sha256: batchAggregateSha256,
      jobs: sortedSummaries,
      started_at: startedAt,
      completed_at: completedAt,
    };

    const batchManifestPath = join(paths.manifestDir, `${batchId}.json`);
    await writeImmutableJson(batchManifestPath, batchManifest);

    await appendJsonl(paths.statuses, {
      batch_id: batchId,
      state: "batch_completed",
      total: validatedJobs.length,
      succeeded: succeededCount,
      failed: failedCount,
      at: completedAt,
      batch_manifest: relativePosix(custodyRoot, batchManifestPath),
      batch_aggregate_sha256: batchAggregateSha256,
    });

    return {
      batch_id: batchId,
      manifest_path: batchManifestPath,
      manifest: batchManifest,
      artifacts: jobArtifacts,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function sealAuditResult(input, options = {}) {
  const custodyRoot = resolve(options.root || DEFAULT_ROOT);
  const startedAt = utcNow();
  const date = startedAt.slice(0, 10);
  const runId = `seal-${randomUUID()}`;
  const paths = custodyPaths(custodyRoot, date, runId);

  const sealedItem = sealInputSchema.parse(input);

  // Validate collect_manifest linkage if provided
  if (sealedItem.collect_manifest) {
    let manifestData;
    try {
      manifestData = JSON.parse(await readFile(resolve(sealedItem.collect_manifest), "utf8"));
    } catch (err) {
      throw new Error(`cannot read collect_manifest at ${sealedItem.collect_manifest}: ${err.message}`);
    }
    const manifestEvidenceSha = manifestData.hashes?.evidence_sha256 || manifestData.evidence_sha256;
    const manifestPacketSha = manifestData.hashes?.packet_sha256 || manifestData.packet_sha256;
    if (manifestEvidenceSha && manifestEvidenceSha !== sealedItem.evidence_sha256) {
      throw new Error(
        `collect_manifest evidence_sha256 mismatch: manifest has ${manifestEvidenceSha}, seal received ${sealedItem.evidence_sha256}`,
      );
    }
    if (manifestPacketSha && manifestPacketSha !== sealedItem.packet_sha256) {
      throw new Error(
        `collect_manifest packet_sha256 mismatch: manifest has ${manifestPacketSha}, seal received ${sealedItem.packet_sha256}`,
      );
    }
  }

  // Verify local packet file linkage if packet exists on disk
  const localPacketPath = join(paths.packetsDir, `${sealedItem.packet_sha256}.json`);
  try {
    const packetContent = JSON.parse(await readFile(localPacketPath, "utf8"));
    if (packetContent?.evidence?.sha256 && packetContent.evidence.sha256 !== sealedItem.evidence_sha256) {
      throw new Error(
        `local packet evidence_sha256 mismatch: packet has ${packetContent.evidence.sha256}, seal received ${sealedItem.evidence_sha256}`,
      );
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  const resultSha256 = sha256Json(sealedItem.result);
  const provenanceSha256 = sha256Json(sealedItem.provenance);

  const completedAt = utcNow();
  const sealManifestPath = join(paths.manifestDir, `${runId}.json`);

  const sealedArtifact = {
    schema_version: 1,
    seal_id: runId,
    job_id: sealedItem.job_id,
    outcome: "sealed",
    hashes: {
      result_sha256: resultSha256,
      provenance_sha256: provenanceSha256,
      evidence_sha256: sealedItem.evidence_sha256,
      packet_sha256: sealedItem.packet_sha256,
    },
    evidence_link: {
      evidence_sha256: sealedItem.evidence_sha256,
      packet_sha256: sealedItem.packet_sha256,
      collect_manifest: sealedItem.collect_manifest || null,
    },
    provenance: sealedItem.provenance,
    result: sealedItem.result,
    paths: {
      record: relativePosix(custodyRoot, paths.sealedRecords),
      manifest: relativePosix(custodyRoot, sealManifestPath),
      status: relativePosix(custodyRoot, paths.statuses),
    },
    started_at: startedAt,
    completed_at: completedAt,
  };

  await appendJsonl(paths.sealedRecords, sealedArtifact);
  await writeImmutableJson(sealManifestPath, sealedArtifact);

  await appendJsonl(paths.statuses, {
    seal_id: runId,
    job_id: sealedItem.job_id,
    state: "sealed",
    at: completedAt,
    manifest: relativePosix(custodyRoot, sealManifestPath),
    result_sha256: resultSha256,
    evidence_sha256: sealedItem.evidence_sha256,
    packet_sha256: sealedItem.packet_sha256,
  });

  return {
    seal_id: runId,
    manifest_path: sealManifestPath,
    artifact: sealedArtifact,
  };
}

export async function sealAuditBatch(inputs, options = {}) {
  const custodyRoot = resolve(options.root || DEFAULT_ROOT);
  const batchId = `seal-batch-${randomUUID()}`;
  const startedAt = utcNow();
  const date = startedAt.slice(0, 10);
  const paths = custodyPaths(custodyRoot, date, batchId);

  const sealedArtifacts = [];
  for (const item of inputs) {
    const sealed = await sealAuditResult(item, options);
    sealedArtifacts.push(sealed.artifact);
  }

  const completedAt = utcNow();
  const sortedSummaries = [...sealedArtifacts]
    .sort((a, b) => a.job_id.localeCompare(b.job_id))
    .map((a) => ({
      job_id: a.job_id,
      seal_id: a.seal_id,
      result_sha256: a.hashes.result_sha256,
      provenance_sha256: a.hashes.provenance_sha256,
      evidence_sha256: a.hashes.evidence_sha256,
      packet_sha256: a.hashes.packet_sha256,
      manifest: a.paths.manifest,
    }));

  const batchAggregateSha256 = sha256Json(sortedSummaries);

  const batchManifest = {
    schema_version: 1,
    seal_batch_id: batchId,
    total_sealed: sealedArtifacts.length,
    batch_aggregate_sha256: batchAggregateSha256,
    items: sortedSummaries,
    started_at: startedAt,
    completed_at: completedAt,
  };

  const batchManifestPath = join(paths.manifestDir, `${batchId}.json`);
  await writeImmutableJson(batchManifestPath, batchManifest);

  return {
    seal_batch_id: batchId,
    manifest_path: batchManifestPath,
    manifest: batchManifest,
    artifacts: sealedArtifacts,
  };
}

export async function readJsonLines(filePath) {
  const content = await readFile(resolve(filePath), "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export function parseCliArgs(argv) {
  const options = {
    mode: "collect",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (arg === "--smoke") {
      options.smoke = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

export async function runBrowserSmoke(root = join(DEFAULT_ROOT, "smoke-test")) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!DOCTYPE html><html><head><title>Smoke Title</title></head><body><h1>Smoke Heading</h1><p>Smoke text content for runtime browser verification.</p></body></html>",
    );
  });

  const { port, host } = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        return reject(new Error("failed to retrieve ephemeral server address"));
      }
      resolve({ port: addr.port, host: "127.0.0.1" });
    });
  });

  try {
    const smokeJobs = [
      {
        id: "smoke-job-001",
        url: `http://${host}:${port}/smoke`,
        instruction: "Extract smoke heading and content for runtime verification",
      },
    ];

    const batchResult = await runBatchCollect(smokeJobs, {
      root,
      concurrency: 1,
    });

    if (batchResult.manifest.succeeded_jobs !== 1 || batchResult.manifest.failed_jobs !== 0) {
      throw new Error(
        `browser smoke collect did not succeed: ${JSON.stringify(batchResult.manifest)}`,
      );
    }

    const artifact = batchResult.artifacts[0];
    if (artifact.evidence.title !== "Smoke Title") {
      throw new Error(`browser smoke failed: title mismatch, got: ${artifact.evidence.title}`);
    }

    if (!artifact.evidence_sha256 || !artifact.packet_sha256) {
      throw new Error("browser smoke failed: missing evidence_sha256 or packet_sha256");
    }

    // Verify packet was written with packet_sha256 filename and contains extracted text
    const packetFilePath = join(root, "packets", `${artifact.packet_sha256}.json`);
    const packetContent = JSON.parse(await readFile(packetFilePath, "utf8"));
    if (!packetContent.evidence?.text?.includes("Smoke Heading")) {
      throw new Error(`browser smoke failed to extract expected text, got: ${packetContent.evidence?.text}`);
    }

    // Verify raw evidence gzip exists
    const rawFilePath = join(root, "raw", `${artifact.evidence_sha256}.json.gz`);
    await stat(rawFilePath);

    return {
      status: "ok",
      browser: batchResult.manifest.browser,
      artifact,
    };
  } finally {
    await new Promise((r) => server.close(r));
    await import("node:fs/promises")
      .then(({ rm }) => rm(root, { recursive: true, force: true }))
      .catch(() => {});
  }
}

export async function selfTest() {
  // 1. Schema check
  const validOutput = {
    summary: "evidence summary",
    findings: [{ claim: "test claim", evidence_quote: "quote from text" }],
    uncertainties: [],
  };
  modelOutputSchema.parse(validOutput);

  let schemaRejected = false;
  try {
    modelOutputSchema.parse({ summary: "missing findings and uncertainties" });
  } catch {
    schemaRejected = true;
  }
  if (!schemaRejected) throw new Error("self-test expected invalid model output to be rejected");

  // 2. Stable JSON hashing
  const hashA = sha256Json({ b: 2, a: 1 });
  const hashB = sha256Json({ a: 1, b: 2 });
  if (hashA !== hashB) throw new Error("stable JSON hashing is not order-independent");

  // 3. Bounded concurrency
  const mockItems = [10, 10, 10, 10, 10, 10];
  const { results: poolResults, maxActiveObserved } = await runWithBoundedConcurrency(
    mockItems,
    3,
    async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    },
  );
  if (maxActiveObserved > 3) {
    throw new Error(`concurrency exceeded bound: observed ${maxActiveObserved} > 3`);
  }
  if (poolResults.length !== 6 || poolResults.some((r) => r.status !== "fulfilled")) {
    throw new Error("bounded concurrency failed to complete all mock items");
  }

  // 4. Failure isolation
  const mixedItems = ["ok1", "fail", "ok2", "ok3"];
  const { results: mixedResults } = await runWithBoundedConcurrency(
    mixedItems,
    2,
    async (item) => {
      if (item === "fail") throw new Error("simulated item failure");
      return `result-${item}`;
    },
  );
  const fulfilledCount = mixedResults.filter((r) => r.status === "fulfilled").length;
  const rejectedCount = mixedResults.filter((r) => r.status === "rejected").length;
  if (fulfilledCount !== 3 || rejectedCount !== 1) {
    throw new Error(`failure isolation check failed: ${fulfilledCount} fulfilled, ${rejectedCount} rejected`);
  }

  // 5. Deterministic aggregate batch hash
  const summaryOrder1 = [
    { job_id: "JOB-B", evidence_sha256: "b" },
    { job_id: "JOB-A", evidence_sha256: "a" },
  ];
  const summaryOrder2 = [
    { job_id: "JOB-A", evidence_sha256: "a" },
    { job_id: "JOB-B", evidence_sha256: "b" },
  ];
  const sortAndHash = (items) => {
    const sorted = [...items].sort((x, y) => x.job_id.localeCompare(y.job_id));
    return sha256Json(sorted);
  };
  if (sortAndHash(summaryOrder1) !== sortAndHash(summaryOrder2)) {
    throw new Error("aggregate batch hash is not deterministic");
  }

  // 6. Seal schema acceptance & rejection (with cryptographic evidence linkage)
  const dummyHex64A = "a".repeat(64);
  const dummyHex64B = "b".repeat(64);
  const validSeal = {
    job_id: "test-job",
    evidence_sha256: dummyHex64A,
    packet_sha256: dummyHex64B,
    provenance: {
      execution_surface: "chatshare",
      declared_model: "gpt-5.6-sol",
      api_mode: false,
    },
    result: validOutput,
  };
  sealInputSchema.parse(validSeal);
  sealInputSchema.parse({
    ...validSeal,
    provenance: {
      ...validSeal.provenance,
      execution_surface: "chatgpt_web",
    },
  });

  let sealRejectedMissingEvidenceLink = false;
  try {
    sealInputSchema.parse({
      job_id: "test-job",
      // missing evidence_sha256 and packet_sha256
      provenance: {
        execution_surface: "chatshare",
        declared_model: "gpt-5.6-sol",
        api_mode: false,
      },
      result: validOutput,
    });
  } catch {
    sealRejectedMissingEvidenceLink = true;
  }
  if (!sealRejectedMissingEvidenceLink) {
    throw new Error("self-test expected seal input missing evidence linkage to be rejected");
  }

  let sealRejectedInvalidProvenance = false;
  try {
    sealInputSchema.parse({
      job_id: "test-job",
      evidence_sha256: dummyHex64A,
      packet_sha256: dummyHex64B,
      provenance: {
        execution_surface: "other",
        declared_model: "gpt-5.6-sol",
        api_mode: true,
      },
      result: validOutput,
    });
  } catch {
    sealRejectedInvalidProvenance = true;
  }
  if (!sealRejectedInvalidProvenance) {
    throw new Error("self-test expected invalid provenance to be rejected");
  }

  // 7. Runtime browser smoke test (real Chromium launch + context extraction + gzip/packet custody)
  const smokeResult = await runBrowserSmoke();
  if (smokeResult.status !== "ok") {
    throw new Error("self-test browser smoke failed");
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      checks: [
        "schema",
        "stable_hash",
        "bounded_concurrency",
        "failure_isolation",
        "deterministic_batch_hash",
        "seal_schema",
        "browser_smoke",
      ],
      browser_backend: smokeResult.browser,
    })}\n`,
  );
}

export async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.selfTest) {
    await selfTest();
    return;
  }

  if (options.smoke) {
    const smokeResult = await runBrowserSmoke(
      options.root ? join(options.root, "smoke-test") : undefined,
    );
    process.stdout.write(`${JSON.stringify(smokeResult, null, 2)}\n`);
    return;
  }

  const mode = options.mode || "collect";

  if (mode === "collect") {
    let jobs = [];
    if (options.batch) {
      jobs = await readJsonLines(options.batch);
    } else if (options.job) {
      const raw = JSON.parse(await readFile(resolve(options.job), "utf8"));
      jobs = Array.isArray(raw) ? raw : [raw];
    } else if (options.url && options.instruction) {
      jobs = [
        {
          id: options.id || randomUUID(),
          url: options.url,
          instruction: options.instruction,
        },
      ];
    } else {
      throw new Error(
        "collect mode usage:\n" +
          "  node scripts/chatshare-runner.mjs --mode collect --batch <jobs.jsonl> [--concurrency 3] [--root <dir>]\n" +
          "  node scripts/chatshare-runner.mjs --mode collect --url <url> --instruction <text> [--id <id>]\n" +
          "  node scripts/chatshare-runner.mjs --mode collect --job <job.json>",
      );
    }

    const batchResult = await runBatchCollect(jobs, {
      root: options.root || DEFAULT_ROOT,
      concurrency: options.concurrency,
      browserChannel: options["browser-channel"],
      maxTextChars: options["max-text-chars"] ? Number(options["max-text-chars"]) : DEFAULT_MAX_TEXT_CHARS,
    });

    process.stdout.write(`${JSON.stringify(batchResult.manifest, null, 2)}\n`);
    return;
  }

  if (mode === "seal") {
    if (options["batch-results"]) {
      const items = await readJsonLines(options["batch-results"]);
      const sealResult = await sealAuditBatch(items, {
        root: options.root || DEFAULT_ROOT,
      });
      process.stdout.write(`${JSON.stringify(sealResult.manifest, null, 2)}\n`);
      return;
    }

    if (options.result) {
      const raw = JSON.parse(await readFile(resolve(options.result), "utf8"));
      const sealResult = await sealAuditResult(raw, {
        root: options.root || DEFAULT_ROOT,
      });
      process.stdout.write(`${JSON.stringify(sealResult.artifact, null, 2)}\n`);
      return;
    }

    throw new Error(
      "seal mode usage:\n" +
        "  node scripts/chatshare-runner.mjs --mode seal --result <result.json> [--root <dir>]\n" +
        "  node scripts/chatshare-runner.mjs --mode seal --batch-results <results.jsonl> [--root <dir>]",
    );
  }

  throw new Error(`unknown mode: ${mode}`);
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
