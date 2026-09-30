import { randomBytes, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";

export const HEX_64_PATTERN = /^[0-9a-f]{64}$/i;

const FORBIDDEN_URL_PATTERNS = [
  /vertexaisearch\.cloud\.google\.com/i,
  /google\.[a-z.]+\/search/i,
  /bing\.[a-z.]+\/search/i,
  /duckduckgo\.com/i,
  /search\.yahoo\.com/i,
];

export const resolvedSourceSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(
        (url) => !FORBIDDEN_URL_PATTERNS.some((pattern) => pattern.test(url)),
        "URL must be a direct canonical article/filing URL, not a search redirect or query shell",
      ),
    title: z.string().min(1).max(500),
    rationale: z.string().min(1).max(1_000),
  })
  .strict();

export const sourceResolveSubmitSchema = z
  .object({
    challenge: z.string().regex(HEX_64_PATTERN),
    ticker: z.string().min(1).max(20),
    sources: z.array(resolvedSourceSchema).min(1).max(10),
  })
  .strict();

export interface SourceResolveStartInput {
  ticker: string;
  companyName?: string;
  asOfDate?: string;
}

export interface RetainedResolvedSource {
  resolve_id: string;
  ticker: string;
  status: "succeeded";
  execution_surface: "chatgpt_web" | "chatshare";
  declared_model: "gpt-5.6-sol";
  api_mode: false;
  sources: Array<z.infer<typeof resolvedSourceSchema>>;
  started_at: string;
  completed_at: string;
}

export interface SourceResolveBinding {
  resolveId: string;
  ticker: string;
  companyName?: string;
  asOfDate?: string;
  startedAt: string;
}

export function buildSourceResolvePrompt(input: {
  challenge: string;
  ticker: string;
  companyName?: string;
  asOfDate?: string;
}): string {
  return [
    `You are performing source resolution for ${input.ticker}${input.companyName ? ` (${input.companyName})` : ""} as of prospective date ${input.asOfDate || "2026-09-28"}.`,
    "",
    "TASK:",
    "Search the web to find 2 to 4 canonical, high-substance public sources regarding recent business acceleration, quarterly disclosures, or material catalysts.",
    "",
    "STRICT URL RULES:",
    "1. URLs MUST be direct, canonical publisher or investor-relations URLs (e.g. sec.gov, official company IR page, PR Newswire, Bloomberg, Reuters, etc.).",
    "2. Do NOT provide Google search redirect URLs (e.g. vertexaisearch, google.com/search).",
    "3. Ensure the URLs represent substantive article or filing text, not empty shells or dead links.",
    "",
    "COMPLETION CONTRACT:",
    "1. Do not finish with a prose-only answer or a list of URLs in chat.",
    "2. Once you have 2 to 4 valid canonical sources, stop browsing and invoke DevSpace MCP tool `source_resolve_submit` immediately.",
    "3. `source_resolve_submit` must be your final completion action for this task. The run is not complete until that tool call succeeds.",
    "4. Do not ask the user for confirmation before invoking `source_resolve_submit`.",
    "5. Invoke `source_resolve_submit` exactly once with:",
    JSON.stringify(
      {
        challenge: input.challenge,
        ticker: input.ticker,
        sources: [
          {
            url: "https://example.com/canonical-news-url",
            title: "<article / filing headline>",
            rationale: "<why this is a primary source for material business events>",
          },
        ],
      },
      null,
      2,
    ),
  ].join("\n");
}

export class SourceResolveController {
  readonly #browser: Pick<WebLaunchBrowserController, "launchWebConversation"> &
    Partial<
      Pick<
        WebLaunchBrowserController,
        "resumeWebConversation" | "deleteWebConversation" | "stopWebConversationRecovery"
      >
    >;
  readonly #now: () => Date;
  readonly #executionSurface: "chatgpt_web" | "chatshare";
  readonly #resumeGraceMs: number;
  readonly #resumePollMs: number;
  readonly #resumeCooldownMs: number;
  readonly #resumeWatchMs: number;
  readonly #resumeMaxAttempts: number;
  readonly #cleanupSucceededConversations: boolean;
  readonly #cleanupDelayMs: number;
  readonly #cleanupRetryMs: number;
  readonly #cleanupWatchMs: number;
  readonly #conversationIdentityByResolveId = new Map<string, string>();
  readonly #bindingsByResolveId = new Map<string, SourceResolveBinding>();
  readonly #resolveIdByChallenge = new Map<string, string>();
  readonly #challengeByResolveId = new Map<string, string>();
  readonly #retainedByResolveId = new Map<string, RetainedResolvedSource>();
  readonly #failureByResolveId = new Map<
    string,
    { reason: "terminal_chat_state"; failedAt: string }
  >();

  constructor(
    browser: Pick<WebLaunchBrowserController, "launchWebConversation"> &
      Partial<
        Pick<
          WebLaunchBrowserController,
          "resumeWebConversation" | "deleteWebConversation" | "stopWebConversationRecovery"
        >
      >,
    options: {
      now?: () => Date;
      executionSurface?: "chatgpt_web" | "chatshare";
      resumeGraceMs?: number;
      resumePollMs?: number;
      resumeCooldownMs?: number;
      resumeWatchMs?: number;
      resumeMaxAttempts?: number;
      cleanupSucceededConversations?: boolean;
      cleanupDelayMs?: number;
      cleanupRetryMs?: number;
      cleanupWatchMs?: number;
    } = {},
  ) {
    this.#browser = browser;
    this.#now = options.now ?? (() => new Date());
    this.#executionSurface = options.executionSurface ?? "chatgpt_web";
    this.#resumeGraceMs = options.resumeGraceMs ?? 45_000;
    this.#resumePollMs = options.resumePollMs ?? 15_000;
    this.#resumeCooldownMs = options.resumeCooldownMs ?? 60_000;
    // 0 means no wall-clock expiry: the watch is bounded instead by the
    // retained/pending lifecycle, missing conversation, or resume-attempt budget.
    this.#resumeWatchMs = options.resumeWatchMs ?? 0;
    this.#resumeMaxAttempts = options.resumeMaxAttempts ?? 3;
    this.#cleanupSucceededConversations = options.cleanupSucceededConversations ?? false;
    this.#cleanupDelayMs = options.cleanupDelayMs ?? 3_000;
    this.#cleanupRetryMs = options.cleanupRetryMs ?? 2_000;
    this.#cleanupWatchMs = options.cleanupWatchMs ?? 2 * 60_000;
  }

  async startResolve(input: SourceResolveStartInput): Promise<{
    resolveId: string;
    challenge: string;
    status: "pending";
    startedAt: string;
  }> {
    const ticker = input.ticker.trim().toUpperCase();
    if (ticker.length === 0) {
      throw new Error("ticker must be a non-empty string");
    }

    const resolveId = `resolve-${randomUUID()}`;
    const challenge = randomBytes(32).toString("hex");
    const startedAt = this.#now().toISOString();

    const binding: SourceResolveBinding = {
      resolveId,
      ticker,
      companyName: input.companyName,
      asOfDate: input.asOfDate,
      startedAt,
    };

    this.#bindingsByResolveId.set(resolveId, binding);
    this.#resolveIdByChallenge.set(challenge, resolveId);
    this.#challengeByResolveId.set(resolveId, challenge);

    const prompt = buildSourceResolvePrompt({
      challenge,
      ticker,
      companyName: input.companyName,
      asOfDate: input.asOfDate,
    });

    const acknowledgement = await this.#browser.launchWebConversation(prompt, {
      attachDevSpace: true,
    });
    this.#conversationIdentityByResolveId.set(resolveId, acknowledgement.conversationIdentitySha256);
    this.#startResumeWatch(resolveId, acknowledgement.conversationIdentitySha256);

    return {
      resolveId,
      challenge,
      status: "pending",
      startedAt,
    };
  }

  #startResumeWatch(resolveId: string, conversationIdentitySha256: string): void {
    const resumeWebConversation = this.#browser.resumeWebConversation?.bind(this.#browser);
    if (!resumeWebConversation || this.#resumeMaxAttempts <= 0) {
      return;
    }

    const startedAtMs = Date.now();
    let resumeAttempts = 0;
    let nextResumeAtMs = startedAtMs + Math.max(0, this.#resumeGraceMs);

    const schedule = (delayMs: number): void => {
      const timer = setTimeout(() => {
        void tick();
      }, Math.max(1, delayMs));
      timer.unref?.();
    };

    const tick = async (): Promise<void> => {
      if (this.#retainedByResolveId.has(resolveId)) return;
      if (!this.#bindingsByResolveId.has(resolveId)) return;

      const nowMs = Date.now();
      if (this.#resumeWatchMs > 0 && nowMs - startedAtMs >= this.#resumeWatchMs) return;
      if (resumeAttempts >= this.#resumeMaxAttempts) return;

      if (nowMs < nextResumeAtMs) {
        if (resumeAttempts === 0) {
          try {
            const timeoutResult = await resumeWebConversation(
              conversationIdentitySha256,
              "resume",
              { onlyIfInterrupted: true },
            );
            if (timeoutResult === "missing") return;
            if (timeoutResult === "terminal") {
              this.#failResolve(resolveId, "terminal_chat_state");
              return;
            }
            if (timeoutResult === "sent") {
              resumeAttempts += 1;
              nextResumeAtMs = Date.now() + Math.max(1, this.#resumeCooldownMs);
            }
          } catch {
            // Delivery-timeout UI transitions are retried while still pending.
          }
        }
        schedule(Math.min(this.#resumePollMs, Math.max(1, nextResumeAtMs - nowMs)));
        return;
      }

      try {
        const timeoutResult = await resumeWebConversation(
          conversationIdentitySha256,
          "resume",
          { onlyIfInterrupted: true },
        );
        if (timeoutResult === "missing") return;
        if (timeoutResult === "terminal") {
          this.#failResolve(resolveId, "terminal_chat_state");
          return;
        }

        const result =
          timeoutResult === "sent"
            ? timeoutResult
            : await resumeWebConversation(conversationIdentitySha256, "resume");
        if (result === "missing") return;
        if (result === "terminal") {
          this.#failResolve(resolveId, "terminal_chat_state");
          return;
        }
        if (result === "sent") {
          resumeAttempts += 1;
          nextResumeAtMs = Date.now() + Math.max(1, this.#resumeCooldownMs);
        }
      } catch {
        // Browser/UI transitions are retried while the resolve remains pending.
      }

      if (this.#retainedByResolveId.has(resolveId)) return;
      if (resumeAttempts >= this.#resumeMaxAttempts) return;
      schedule(this.#resumePollMs);
    };

    schedule(Math.min(this.#resumePollMs, Math.max(1, this.#resumeGraceMs)));
  }

  #stopConversationRecovery(resolveId: string): void {
    const conversationIdentitySha256 =
      this.#conversationIdentityByResolveId.get(resolveId);
    if (!conversationIdentitySha256) return;
    try {
      this.#browser.stopWebConversationRecovery?.(conversationIdentitySha256);
    } catch {
      // Business completion must not be rolled back by watcher cleanup failure.
    }
  }

  #failResolve(
    resolveId: string,
    reason: "terminal_chat_state",
  ): void {
    if (this.#retainedByResolveId.has(resolveId)) return;
    const binding = this.#bindingsByResolveId.get(resolveId);
    if (!binding) return;

    const challenge = this.#challengeByResolveId.get(resolveId);
    if (challenge) this.#resolveIdByChallenge.delete(challenge);
    this.#challengeByResolveId.delete(resolveId);
    this.#failureByResolveId.set(resolveId, {
      reason,
      failedAt: this.#now().toISOString(),
    });
    this.#stopConversationRecovery(resolveId);
  }

  #startSucceededConversationCleanup(resolveId: string): void {
    if (!this.#cleanupSucceededConversations) return;
    const deleteWebConversation = this.#browser.deleteWebConversation?.bind(this.#browser);
    const conversationIdentitySha256 = this.#conversationIdentityByResolveId.get(resolveId);
    if (!deleteWebConversation || !conversationIdentitySha256 || this.#cleanupWatchMs <= 0) return;

    const startedAtMs = Date.now();
    const schedule = (delayMs: number): void => {
      const timer = setTimeout(() => {
        void tick();
      }, Math.max(1, delayMs));
      timer.unref?.();
    };
    const tick = async (): Promise<void> => {
      if (!this.#retainedByResolveId.has(resolveId)) return;
      if (Date.now() - startedAtMs >= this.#cleanupWatchMs) return;
      try {
        const result = await deleteWebConversation(conversationIdentitySha256);
        if (result === "deleted") {
          this.#conversationIdentityByResolveId.delete(resolveId);
          return;
        }
      } catch {
        // Sidebar/menu transitions are retried only for this already-succeeded conversation.
      }
      schedule(this.#cleanupRetryMs);
    };
    schedule(this.#cleanupDelayMs);
  }

  submitResolve(input: {
    challenge: string;
    ticker: string;
    sources: Array<z.infer<typeof resolvedSourceSchema>>;
  }): {
    resolveId: string;
    status: "succeeded";
    completedAt: string;
  } {
    const challenge = input.challenge.trim();
    if (!HEX_64_PATTERN.test(challenge)) {
      throw new Error("challenge must be a valid 64-character hex string");
    }

    const resolveId = this.#resolveIdByChallenge.get(challenge);
    if (!resolveId) {
      throw new Error("challenge invalid, expired, or already used (replay rejected)");
    }

    const binding = this.#bindingsByResolveId.get(resolveId);
    if (!binding) {
      throw new Error(`source resolve state missing for ${resolveId}`);
    }

    if (input.ticker.trim().toUpperCase() !== binding.ticker.toUpperCase()) {
      throw new Error(`ticker mismatch: expected ${binding.ticker}, got ${input.ticker}`);
    }

    const validated = sourceResolveSubmitSchema.parse(input);

    // Atomically consume challenge to prevent replay after validation passes
    this.#resolveIdByChallenge.delete(challenge);
    this.#challengeByResolveId.delete(resolveId);

    const completedAt = this.#now().toISOString();

    const retained: RetainedResolvedSource = {
      resolve_id: resolveId,
      ticker: binding.ticker,
      status: "succeeded",
      execution_surface: this.#executionSurface,
      declared_model: "gpt-5.6-sol",
      api_mode: false,
      sources: validated.sources,
      started_at: binding.startedAt,
      completed_at: completedAt,
    };

    this.#retainedByResolveId.set(resolveId, retained);
    this.#stopConversationRecovery(resolveId);
    this.#startSucceededConversationCleanup(resolveId);

    return {
      resolveId,
      status: "succeeded",
      completedAt,
    };
  }

  getResolveStatus(resolveId: string): {
    resolveId: string;
    status: "pending" | "succeeded" | "failed";
    retained?: RetainedResolvedSource;
    startedAt?: string;
    failedAt?: string;
    failureReason?: "terminal_chat_state";
  } {
    const retained = this.#retainedByResolveId.get(resolveId);
    if (retained) {
      return {
        resolveId,
        status: "succeeded",
        retained,
      };
    }

    const failure = this.#failureByResolveId.get(resolveId);
    const binding = this.#bindingsByResolveId.get(resolveId);
    if (failure && binding) {
      return {
        resolveId,
        status: "failed",
        startedAt: binding.startedAt,
        failedAt: failure.failedAt,
        failureReason: failure.reason,
      };
    }


    if (binding) {
      return {
        resolveId,
        status: "pending",
        startedAt: binding.startedAt,
      };
    }

    throw new Error(`source resolve not found: ${resolveId}`);
  }
}
