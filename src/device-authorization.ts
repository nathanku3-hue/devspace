import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface DeviceAuthorizationConfig {
  enabled: boolean;
  required: boolean;
  loopbackPort: number;
  extensionId: string;
  allowedRedirectPrefixes: string[];
  challengeTtlSeconds: number;
}

interface ChallengeRecord {
  binding: string;
  expiresAtMs: number;
}

const PROOF_PATH = "/devspace-device-proof";
const PROOF_DOMAIN = "devspace-device-proof-v1";
const MAX_BODY_BYTES = 4096;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const CHROME_EXTENSION_ID = /^[a-p]{32}$/;

export class DeviceAuthorization {
  private readonly secret = randomBytes(32);
  private readonly challenges = new Map<string, ChallengeRecord>();
  private listener?: Server;
  private listenerError?: Error;

  constructor(readonly config: DeviceAuthorizationConfig) {
    if (config.enabled && !CHROME_EXTENSION_ID.test(config.extensionId)) {
      throw new Error(`Invalid DEVSPACE_DEVICE_AUTH_EXTENSION_ID: ${config.extensionId}`);
    }
  }

  get loopbackUrl(): string {
    return `http://127.0.0.1:${this.config.loopbackPort}${PROOF_PATH}`;
  }

  get extensionOrigin(): string {
    return `chrome-extension://${this.config.extensionId}`;
  }

  get deviceId(): string {
    return createHash("sha256").update(this.secret).digest("base64url").slice(0, 16);
  }

  isRedirectAllowed(redirectUri: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      return false;
    }

    return this.config.allowedRedirectPrefixes.some((prefix) => {
      const allowed = new URL(prefix);
      if (parsed.origin !== allowed.origin) return false;
      return allowed.pathname.endsWith("/")
        ? parsed.pathname.startsWith(allowed.pathname)
        : parsed.pathname === allowed.pathname;
    });
  }

  createChallenge(binding: string): string {
    if (!this.config.enabled) {
      throw new Error("Device authorization is disabled");
    }
    if (this.listenerError) {
      throw new Error(`Device proof listener is unavailable: ${this.listenerError.message}`);
    }
    if (!BASE64URL_SHA256.test(binding)) {
      throw new Error("Invalid device authorization binding");
    }

    this.deleteExpiredChallenges();
    const challenge = randomBytes(32).toString("base64url");
    this.challenges.set(challenge, {
      binding,
      expiresAtMs: Date.now() + this.config.challengeTtlSeconds * 1000,
    });
    return challenge;
  }

  verifyProof(challenge: string, binding: string, proof: string): boolean {
    this.deleteExpiredChallenges();
    const record = this.challenges.get(challenge);
    if (!record || record.expiresAtMs < Date.now() || record.binding !== binding) return false;
    if (!BASE64URL_SHA256.test(proof)) return false;

    const expected = this.sign(challenge, binding);
    const accepted = safeEquals(proof, expected);
    if (accepted) this.challenges.delete(challenge);
    return accepted;
  }

  start(): void {
    if (!this.config.enabled || this.listener) return;

    const listener = createServer((req, res) => {
      void this.handleLoopbackRequest(req, res);
    });
    listener.on("error", (error) => {
      this.listenerError = error instanceof Error ? error : new Error(String(error));
      console.error(`device proof listener failed: ${this.listenerError.message}`);
    });
    listener.listen(this.config.loopbackPort, "127.0.0.1", () => {
      this.listenerError = undefined;
      console.log(`device proof listener: ${this.loopbackUrl} (${this.deviceId})`);
    });
    this.listener = listener;
  }

  close(): void {
    this.challenges.clear();
    this.listener?.close();
    this.listener = undefined;
  }

  private async handleLoopbackRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setNoStoreHeaders(res);

    const expectedHost = `127.0.0.1:${this.config.loopbackPort}`;
    const origin = req.headers.origin;
    const extensionId = req.headers["x-devspace-extension-id"];
    const extensionOriginAllowed = origin === undefined || origin === this.extensionOrigin;
    if (
      req.headers.host !== expectedHost ||
      extensionId !== this.config.extensionId ||
      !extensionOriginAllowed
    ) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }

    setCorsHeaders(res, origin ?? this.extensionOrigin);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "POST" || req.url !== PROOF_PATH) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readRequestBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }

    const challenge = readStringField(body, "challenge");
    const binding = readStringField(body, "binding");
    if (!BASE64URL_SHA256.test(challenge) || !BASE64URL_SHA256.test(binding)) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }

    sendJson(res, 200, {
      proof: this.sign(challenge, binding),
      deviceId: this.deviceId,
    });
  }

  private sign(challenge: string, binding: string): string {
    return createHmac("sha256", this.secret)
      .update(`${PROOF_DOMAIN}\n${challenge}\n${binding}`)
      .digest("base64url");
  }

  private deleteExpiredChallenges(): void {
    const now = Date.now();
    for (const [challenge, record] of this.challenges) {
      if (record.expiresAtMs < now) this.challenges.delete(challenge);
    }
  }
}

function setNoStoreHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function setCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-DevSpace-Extension-Id");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.end(JSON.stringify(value));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readStringField(value: unknown, field: string): string {
  if (!value || typeof value !== "object") return "";
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : "";
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
