import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SourceResolveController } from "../src/source-resolve.js";
// @ts-expect-error untyped local mjs module
import { collectJob, custodyPaths, launchBrowserBackend, sha256Json } from "./chatshare-runner.mjs";

async function main() {
  console.log("=== Testing 404-Ticker Canonical Source Resolution & Collection (VICR) ===");

  let capturedPrompt = "";
  const mockBrowser = {
    launchWebConversation: async (prompt: string) => {
      capturedPrompt = prompt;
      return {
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: "vicr-resolve-hash",
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      };
    },
  };

  const resolveController = new SourceResolveController(mockBrowser);

  // 1. source_resolve_start
  const startResult = await resolveController.startResolve({
    ticker: "VICR",
    companyName: "Vicor Corporation",
    asOfDate: "2026-09-28",
  });

  console.log("1. source_resolve_start succeeded:", startResult.resolveId);
  assert.ok(startResult.resolveId.startsWith("resolve-"));
  assert.match(startResult.challenge, /^[0-9a-f]{64}$/i);
  assert.ok(capturedPrompt.includes("VICR (Vicor Corporation)"));

  // 2. Submit canonical sources (prohibiting Google search redirects)
  // Vicor Investor Relations canonical news release URL
  const canonicalUrl =
    "https://vicorcorporation.gcs-web.com/news-releases/news-release-details/vicor-corporation-raises-q3-2026-revenue-guidance";

  const submitResult = resolveController.submitResolve({
    challenge: startResult.challenge,
    ticker: "VICR",
    sources: [
      {
        url: canonicalUrl,
        title: "Vicor Corporation Raises Q3 2026 Revenue Guidance",
        rationale: "Official investor relations press release raising revenue guidance on accelerating high-density power module shipments for AI datacenter customers.",
      },
    ],
  });

  console.log("2. source_resolve_submit succeeded:", submitResult.resolveId);

  // 3. source_resolve_status
  const statusResult = resolveController.getResolveStatus(startResult.resolveId);
  assert.equal(statusResult.status, "succeeded");
  assert.ok(statusResult.retained);
  console.log("3. source_resolve_status retained provenance:", {
    ticker: statusResult.retained.ticker,
    execution_surface: statusResult.retained.execution_surface,
    declared_model: statusResult.retained.declared_model,
    sources_count: statusResult.retained.sources.length,
  });

  // 4. Feed canonical URL into Chromium collector
  const resolvedUrl = statusResult.retained.sources[0].url;
  console.log("4. Collecting resolved canonical URL:", resolvedUrl);

  const custodyRoot = "data/chatshare-agentic";
  const date = new Date().toISOString().slice(0, 10);
  const paths = custodyPaths(custodyRoot, date, "test-vicor-resolve-collect");

  const { browser, metadata: browserMeta } = await launchBrowserBackend();

  try {
    const job = {
      id: "20260928-prospective-VICR-canonical",
      url: resolvedUrl,
      instruction: "Audit 2026-09-28 prospective market evidence for VICR: verify core operational acceleration claims, recent material disclosures, and quoted evidence.",
    };

    const artifact = await collectJob(job, browser, browserMeta, paths, custodyRoot);
    console.log("5. Collection outcome:", artifact.outcome);
    if (artifact.outcome !== "succeeded") {
      console.error("   Collection error:", artifact.error);
      throw new Error(`collection failed: ${JSON.stringify(artifact.error)}`);
    }
    console.log("   HTTP status:", artifact.evidence.http_status);
    console.log("   Title:", artifact.evidence.title);
    console.log("   Evidence SHA256:", artifact.evidence_sha256);
    console.log("   Packet SHA256:", artifact.packet_sha256);

    // Assert that it is NOT a 404
    assert.equal(artifact.outcome, "succeeded");
    assert.equal(artifact.evidence.http_status, 200);
    assert.notEqual(artifact.evidence.title, "Error 404 (Not Found)!!1");
    assert.ok(artifact.evidence.title.length > 0);

    // Verify packet on disk
    const packetContent = JSON.parse(
      await readFile(join(custodyRoot, "packets", `${artifact.packet_sha256}.json`), "utf8"),
    );
    assert.equal(packetContent.evidence.sha256, artifact.evidence_sha256);
    assert.ok(packetContent.evidence.text.length > 50);

    console.log("=== Verification Succeeded: Source Resolution successfully repaired 404 -> 200 with verified text ===");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
