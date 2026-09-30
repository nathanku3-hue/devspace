import { readFile } from "node:fs/promises";
import { AuditReturnController } from "../src/audit-return.js";
// @ts-expect-error untyped local mjs module
import { sealAuditResult } from "./chatshare-runner.mjs";

async function main() {
  const packetPath = "data/chatshare-agentic/packets/93985f45d2541a9dcfa83b52ad8b281c7e82542a812b92caafe4082098f85484.json";
  const packetRaw = await readFile(packetPath, "utf8");
  const collectManifestPath = "data/chatshare-agentic/manifests/bf6b8a64-d156-439b-b5a2-4719bcd4ba44.json";

  let launchedPrompt = "";
  const mockBrowser = {
    launchWebConversation: async (prompt: string) => {
      launchedPrompt = prompt;
      return {
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: "a".repeat(64),
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      };
    },
  };

  const controller = new AuditReturnController(mockBrowser);

  // 1. audit_start
  const startRes = await controller.startAudit({
    jobId: "20260928-prospective-NVDA",
    evidencePacket: packetRaw,
    evidenceSha256: "3fa2c15dfd4975b0dde704aca1773ee566d507f0738c8452be323129c88082c1",
    packetSha256: "93985f45d2541a9dcfa83b52ad8b281c7e82542a812b92caafe4082098f85484",
    collectManifest: collectManifestPath,
  });

  console.log("audit_start succeeded:", startRes.auditId);
  console.log("challenge generated:", startRes.challenge);
  console.log("prompt constraints verified:", launchedPrompt.includes("CRITICAL CONSTRAINTS:"));

  // 2. audit_status (pending)
  const status1 = controller.getAuditStatus(startRes.auditId);
  console.log("initial audit_status:", status1.status);

  // 3. audit_submit
  const submitRes = controller.submitAudit({
    challenge: startRes.challenge,
    job_id: "20260928-prospective-NVDA",
    evidence_sha256: "3fa2c15dfd4975b0dde704aca1773ee566d507f0738c8452be323129c88082c1",
    packet_sha256: "93985f45d2541a9dcfa83b52ad8b281c7e82542a812b92caafe4082098f85484",
    result: {
      summary: "Nvidia fundamental valuation audit indicates multiple compression warning signs despite persistent data center demand.",
      findings: [
        {
          claim: "Nvidia stock valuation exhibits warning sign as valuation multiple contracts",
          evidence_quote: "Nvidia’s stock is flashing a warning sign as valuation falls",
        },
      ],
      uncertainties: ["Long-term sustainability of enterprise AI capital expenditures into 2027"],
    },
  });

  console.log("audit_submit succeeded:", submitRes.auditId);

  // 4. verify replay rejection
  let replayBlocked = false;
  try {
    controller.submitAudit({
      challenge: startRes.challenge,
      result: {
        summary: "replay",
        findings: [{ claim: "replay", evidence_quote: "quote" }],
        uncertainties: [],
      },
    });
  } catch {
    replayBlocked = true;
  }
  console.log("replay protection verified:", replayBlocked);

  // 5. audit_status (succeeded with retained result and provenance)
  const status2 = controller.getAuditStatus(startRes.auditId);
  console.log("final audit_status:", status2.status);
  if (!status2.retained) throw new Error("missing retained audit result");

  console.log("server-injected provenance:", {
    execution_surface: status2.retained.execution_surface,
    declared_model: status2.retained.declared_model,
    api_mode: status2.retained.api_mode,
  });

  // 6. seal retained result into data/chatshare-agentic
  const sealOutput = await sealAuditResult(
    {
      job_id: status2.retained.job_id,
      evidence_sha256: status2.retained.evidence_sha256,
      packet_sha256: status2.retained.packet_sha256,
      collect_manifest: status2.retained.collect_manifest,
      provenance: {
        execution_surface: status2.retained.execution_surface,
        declared_model: status2.retained.declared_model,
        api_mode: status2.retained.api_mode,
      },
      result: status2.retained.result,
    },
    { root: "data/chatshare-agentic" },
  );

  console.log("seal completed:", sealOutput.seal_id);
  console.log("seal manifest path:", sealOutput.manifest_path);
  console.log("seal hashes match:", {
    evidence:
      sealOutput.artifact.hashes.evidence_sha256 ===
      "3fa2c15dfd4975b0dde704aca1773ee566d507f0738c8452be323129c88082c1",
    packet:
      sealOutput.artifact.hashes.packet_sha256 ===
      "93985f45d2541a9dcfa83b52ad8b281c7e82542a812b92caafe4082098f85484",
  });
}

main().catch((err) => {
  console.error("E2E failure:", err);
  process.exit(1);
});
