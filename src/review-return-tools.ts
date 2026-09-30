import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ReviewReturnController } from "./review-return.js";

const NO_APP_META = { _meta: {} } as const;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_CHARS = 50_000;

const reviewRoleSchema = z.enum(["PRODUCT", "SAW_A", "SAW_B", "SAW_C"]);

const manifestInputSchema = {
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
};

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
  controller: Pick<
    ReviewReturnController,
    | "startReview"
    | "startSawReviewSet"
    | "submitReview"
    | "getReviewStatus"
    | "getSawReviewSetStatus"
  >;
}): void {
  const { server, controller } = input;

  registerAppTool(
    server,
    "review_start",
    {
      title: "Start independent review return",
      description:
        "REVIEW-RETURN-2 only. Starts one bounded asynchronous independent review for PRODUCT or one SAW A/B/C role. Requires exact candidate and evidence manifest bytes plus SHA-256 digests. The server owns the selected role policy, returns a source-visible reviewId, and launches a fresh review packet with a prompt-only one-time challenge. It does not capture assistant output or accept previous reviewer output.",
      inputSchema: {
        role: reviewRoleSchema
          .optional()
          .describe("Independent review role. Defaults to PRODUCT."),
        ...manifestInputSchema,
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
      role,
      candidateManifest,
      candidateManifestDigest,
      evidenceManifest,
      evidenceManifestDigest,
    }) => {
      const acknowledgement = controller.startReview({
        role,
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
    "saw_review_start",
    {
      title: "Start SAW A/B/C review set",
      description:
        "REVIEW-RETURN-2 SAW orchestration. Starts three independent post-phase reviewers (SAW_A, SAW_B, SAW_C) over the exact same candidate and evidence manifests. Each review gets a distinct reviewId, one-time challenge, role-policy digest, and fresh conversation identity. Reviewer packets never contain another reviewer's output.",
      inputSchema: manifestInputSchema,
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
      const acknowledgement = controller.startSawReviewSet({
        candidateManifest,
        candidateManifestDigest,
        evidenceManifest,
        evidenceManifestDigest,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: "REVIEW-RETURN-2 SAW A/B/C review set started. Use saw_review_status with the returned batchId.",
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
      title: "Submit independent review result",
      description:
        "REVIEW-RETURN-2 internal bounded callback. Invoke exactly once only when the current newly launched review conversation contains the prompt-only one-time challenge. Accepts only challenge, result, summary, and findings. The server owns reviewId, role, role policy digest, execution surface, reviewedAt, and callback timestamps.",
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
      const acknowledgement = controller.submitReview(payload);
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
      title: "Read independent review status",
      description:
        "REVIEW-RETURN-2 only. Retrieves retained bounded state for one review ID. Returns pending, succeeded, failed, or expired metadata with server-owned role, execution-surface, digest, and conversation-identity bindings.",
      inputSchema: {
        reviewId: z
          .string()
          .regex(HEX_64_PATTERN)
          .describe("Exact REVIEW-RETURN-2 review ID returned by review_start or saw_review_start."),
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
      const acknowledgement = controller.getReviewStatus(reviewId);
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

  registerAppTool(
    server,
    "saw_review_status",
    {
      title: "Read SAW A/B/C review-set status",
      description:
        "REVIEW-RETURN-2 SAW orchestration. Returns the three independent reviewer states for one batch. Batch result is fail if any completed reviewer fails, abstain if none fail and at least one abstains, and pass only when all three pass. Infrastructure failure or expiry is reported separately as failed or expired status.",
      inputSchema: {
        batchId: z
          .string()
          .min(1)
          .describe("SAW batch identifier returned by saw_review_start."),
      },
      ...NO_APP_META,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ batchId }) => {
      const acknowledgement = controller.getSawReviewSetStatus(batchId);
      return {
        content: [
          {
            type: "text" as const,
            text: `REVIEW-RETURN-2 SAW review-set status: ${acknowledgement.status}.`,
          },
        ],
        structuredContent: acknowledgement,
      };
    },
  );
}
