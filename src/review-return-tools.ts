import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ReviewReturnController } from "./review-return.js";

const NO_APP_META = { _meta: {} } as const;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

const findingSchema = z
  .object({
    severity: z.enum(["blocking", "material", "advisory"]),
    claim: z.string().min(1).max(2_000),
    evidenceRef: z.string().min(1).max(512),
  })
  .strict();

const structuredResultSchema = z
  .object({
    reviewId: z.string().regex(HEX_64_PATTERN),
    role: z.literal("PRODUCT"),
    result: z.enum(["pass", "fail", "abstain"]),
    summary: z.string().min(1).max(4_000),
    findings: z.array(findingSchema).max(20),
    reviewedAt: z.string().min(1).max(64),
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
        "REVIEW-RETURN-2 only. Starts one bounded asynchronous PRODUCT review against immutable candidate, evidence, and role-policy digests. Returns a review ID immediately, then launches one fixed review packet into a fresh ChatGPT Web conversation without waiting for the callback. It does not capture assistant output, open a workspace, read files, or accept previous reviewer output.",
      inputSchema: {
        candidateManifestDigest: z
          .string()
          .regex(HEX_64_PATTERN)
          .describe("SHA-256 hex digest of the immutable candidate manifest."),
        evidenceManifestDigest: z
          .string()
          .regex(HEX_64_PATTERN)
          .describe("SHA-256 hex digest of the immutable evidence manifest."),
        rolePolicyDigest: z
          .string()
          .regex(HEX_64_PATTERN)
          .describe("SHA-256 hex digest of the PRODUCT role policy."),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ candidateManifestDigest, evidenceManifestDigest, rolePolicyDigest }) => {
      const acknowledgement = review.startReview({
        candidateManifestDigest,
        evidenceManifestDigest,
        rolePolicyDigest,
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
        "REVIEW-RETURN-2 internal bounded callback. Invoke exactly once only when a newly launched ChatGPT conversation contains the exact PRODUCT review packet. Accepts only the fixed structured result schema. It does not open a workspace, access files, run commands, capture assistant transcripts, or accept previous reviewer output.",
      inputSchema: {
        reviewId: structuredResultSchema.shape.reviewId,
        role: structuredResultSchema.shape.role,
        result: structuredResultSchema.shape.result,
        summary: structuredResultSchema.shape.summary,
        findings: structuredResultSchema.shape.findings,
        reviewedAt: structuredResultSchema.shape.reviewedAt,
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
      const payload = structuredResultSchema.parse(args);
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
        "REVIEW-RETURN-2 only. Retrieves the retained bounded state for one review ID. Returns pending, succeeded, failed, or expired metadata with immutable digest bindings when available. Does not access assistant output, browser content, workspaces, files, commands, or persistent storage.",
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
