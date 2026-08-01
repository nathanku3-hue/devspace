import { randomBytes } from "node:crypto";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";

const DEFAULT_PROBE_TIMEOUT_MS = 120_000;
const CHALLENGE_PATTERN = /^[0-9a-f]{64}$/;

export interface WebConnectorProofAcknowledgement extends Record<string, unknown> {
  slice: "WEB-CONNECTOR-1";
  connectorDiscovered: true;
  connectorInvoked: true;
  probeTool: "web_connector_probe";
  conversationIdentitySha256: string;
  invocationTimestamp: string;
  assistantOutputCaptured: false;
}

export interface WebConnectorProbeAcknowledgement extends Record<string, unknown> {
  slice: "WEB-CONNECTOR-1";
  probeAccepted: true;
  timestamp: string;
}

export interface WebConnectorProofOptions {
  challengeFactory?: () => string;
  now?: () => Date;
  timeoutMs?: number;
}

type ProbeOutcome =
  | { ok: true; timestamp: string }
  | { ok: false; error: WebConnectorProofError };

interface PendingProbe {
  resolve(outcome: ProbeOutcome): void;
  timer: NodeJS.Timeout;
}

export class WebConnectorProofError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebConnectorProofError";
  }
}

export class WebConnectorProofController {
  readonly #browser: Pick<WebLaunchBrowserController, "launchWebConversation">;
  readonly #challengeFactory: () => string;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingProbe>();
  #proofInFlight = false;

  constructor(
    browser: Pick<WebLaunchBrowserController, "launchWebConversation">,
    options: WebConnectorProofOptions = {},
  ) {
    this.#browser = browser;
    this.#challengeFactory =
      options.challengeFactory ?? (() => randomBytes(32).toString("hex"));
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new WebConnectorProofError("WEB-CONNECTOR-1 timeout must be a positive integer");
    }
  }

  async proveConnectorAccess(): Promise<WebConnectorProofAcknowledgement> {
    if (this.#proofInFlight) {
      throw new WebConnectorProofError("WEB-CONNECTOR-1 already has a proof in progress");
    }

    const challenge = this.#challengeFactory();
    assertValidChallenge(challenge);
    if (this.#pending.has(challenge)) {
      throw new WebConnectorProofError("WEB-CONNECTOR-1 generated a duplicate challenge");
    }

    this.#proofInFlight = true;
    const probeOutcome = this.#registerChallenge(challenge);

    try {
      const launch = await this.#browser.launchWebConversation(
        buildWebConnectorProbePrompt(challenge),
      );
      const outcome = await probeOutcome;
      if (!outcome.ok) throw outcome.error;

      return {
        slice: "WEB-CONNECTOR-1",
        connectorDiscovered: true,
        connectorInvoked: true,
        probeTool: "web_connector_probe",
        conversationIdentitySha256: launch.conversationIdentitySha256,
        invocationTimestamp: outcome.timestamp,
        assistantOutputCaptured: false,
      };
    } catch (error) {
      this.#cancelChallenge(
        challenge,
        new WebConnectorProofError("WEB-CONNECTOR-1 proof was cancelled", {
          cause: error,
        }),
      );
      throw error;
    } finally {
      this.#proofInFlight = false;
    }
  }

  acceptProbe(challenge: string): WebConnectorProbeAcknowledgement {
    assertValidChallenge(challenge);
    const pending = this.#pending.get(challenge);
    if (!pending) {
      throw new WebConnectorProofError(
        "WEB-CONNECTOR-1 challenge is unknown, expired, or already consumed",
      );
    }

    this.#pending.delete(challenge);
    clearTimeout(pending.timer);
    const timestamp = this.#now().toISOString();
    pending.resolve({ ok: true, timestamp });

    return {
      slice: "WEB-CONNECTOR-1",
      probeAccepted: true,
      timestamp,
    };
  }

  close(): void {
    for (const challenge of [...this.#pending.keys()]) {
      this.#cancelChallenge(
        challenge,
        new WebConnectorProofError("WEB-CONNECTOR-1 controller closed"),
      );
    }
  }

  #registerChallenge(challenge: string): Promise<ProbeOutcome> {
    return new Promise<ProbeOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(challenge);
        if (!pending) return;
        this.#pending.delete(challenge);
        pending.resolve({
          ok: false,
          error: new WebConnectorProofError(
            "WEB-CONNECTOR-1 timed out waiting for the spawned conversation to invoke DevSpace",
          ),
        });
      }, this.#timeoutMs);
      this.#pending.set(challenge, { resolve, timer });
    });
  }

  #cancelChallenge(challenge: string, error: WebConnectorProofError): void {
    const pending = this.#pending.get(challenge);
    if (!pending) return;
    this.#pending.delete(challenge);
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error });
  }
}

export function buildWebConnectorProbePrompt(challenge: string): string {
  assertValidChallenge(challenge);
  return [
    "WEB-CONNECTOR-1 acceptance probe.",
    "Use the connected DevSpace connector through the normal ChatGPT tool interface.",
    "Invoke the read-only `web_connector_probe` tool exactly once with this exact challenge:",
    challenge,
    "Do not invoke any other connector tool.",
    "After the probe succeeds, stop. Do not ask the user a question.",
  ].join("\n");
}

function assertValidChallenge(challenge: string): void {
  if (!CHALLENGE_PATTERN.test(challenge)) {
    throw new WebConnectorProofError(
      "WEB-CONNECTOR-1 challenge must be exactly 64 lowercase hexadecimal characters",
    );
  }
}
