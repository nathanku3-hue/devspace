import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ReviewReturnController } from "./review-return.js";

const NO_APP_META = { _meta: {} } as const;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_CHARS = 50_000;

const findingSchema = z
  .object({
    severity: z.enum(["blocking", "material", "advisory"]),
    claim: z.string().min(1).max(2_000),
    evidenceRef: z.string().min(1).max(512),
  })
  .strict();

const callbackSchema = z
  .object({
    challenge: z.string().regex(HEX_64_PATTERN),
    result: z.enum(["pass", "fail", "abstain"]),
    summary: z.string().min(1).max(4_000),
    findings: z.array(findingSchema).max(20),
  })
  .strict();

export function registerReviewReturnTools(input: {
  server: McpServer;
  review: Pick<
    ReviewReturnController,
    "startReview" | "submitReview" | "getReviewStatus"
  >;
}): void {
  const { server, review } = input;

  registerAppTool(
    server,
    "review_start",
    {
      title: "Start PRODUCT review return",
      description:
        "REVIEW-RETURN-2 only. Starts one bounded asynchronous PRODUCT review. Requires exact candidate and evidence manifest bytes plus their SHA-256 digests. The server recomputes digests, owns the PRODUCT role policy, returns a source-visible reviewId, and launches a fixed review packet containing the manifests and a prompt-only one-time challenge. It does not capture assistant output, open a workspace, or accept previous reviewer output.",
      inputSchema: {
        candidateManifest: z
          .string()
          .min(1)
          .max(MAX_MANIFEST_CHARS)
          .describe("Exact candidate manifest text included in the fresh-Web packet."),
        candidateManifestDigest: z
          .string()
          .regex(HEX_64_PATTERN)
          .describe("SHA-256 hex digest of candidateManifest exact UTF-8 bytes."),
        evidenceManifest: z
          .string()
          .min(1)
          .max(MAX_MANIFEST_CHARS)
          .describe("Exact evidence manifest text included in the fresh-Web packet."),
        evidenceManifestDigest: z
          .string()
          .regex(HEX_64_PATTERN)
          .describe("SHA-256 hex digest of evidenceManifest exact UTF-8 bytes."),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      candidateManifest,
      candidateManifestDigest,
      evidenceManifest,
      evidenceManifestDigest,
    }) => {
      const acknowledgement = review.startReview({
        candidateManifest,
        candidateManifestDigest,
        evidenceManifest,
        evidenceManifestDigest,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: "REVIEW-RETURN-2 review started. Use review_status with the returned reviewId.",
          },
        ],
        structuredContent: acknowledgement,
      };
    },
  );

  registerAppTool(
    server,
    "review_submit",
    {
      title: "Submit PRODUCT review result",
      description:
        "REVIEW-RETURN-2 internal bounded callback. Invoke exactly once only when a newly launched ChatGPT conversation contains the prompt-only one-time challenge. Accepts only challenge, result, summary, and findings. The server owns reviewId, role, role policy digest, reviewedAt, and callback timestamps. It does not open a workspace, access files, run commands, or capture assistant transcripts.",
      inputSchema: {
        challenge: callbackSchema.shape.challenge,
        result: callbackSchema.shape.result,
        summary: callbackSchema.shape.summary,
        findings: callbackSchema.shape.findings,
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const payload = callbackSchema.parse(args);
      const acknowledgement = review.submitReview(payload);
      return {
        content: [
          {
            type: "text" as const,
            text: "REVIEW-RETURN-2 callback accepted. Stop without invoking another tool.",
          },
        ],
        structuredContent: acknowledgement,
      };
    },
  );

  registerAppTool(
    server,
    "review_status",
    {
      title: "Read PRODUCT review status",
      description:
        "REVIEW-RETURN-2 only. Retrieves the retained bounded state for one source-visible review ID. Returns pending, succeeded, failed, or expired metadata with server-owned digest bindings. Does not access assistant output, browser content, workspaces, files, commands, or persistent storage.",
      inputSchema: {
        reviewId: z
          .string()
          .regex(HEX_64_PATTERN)
          .describe("Exact REVIEW-RETURN-2 review ID returned by review_start."),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reviewId }) => {
      const acknowledgement = review.getReviewStatus(reviewId);
      return {
        content: [
          {
            type: "text" as const,
            text: `REVIEW-RETURN-2 review status: ${acknowledgement.status}.`,
          },
        ],
        structuredContent: acknowledgement,
      };
    },
  );
}
