import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { ChatSessionProvider } from "./config.js";

const execFileAsync = promisify(execFile);

const CHATGPT_URL = "https://chatgpt.com/";
const CHATSHARE_URL = "https://chatshare.xyz/";
const CHATSHARE_CARLIST_URL = "https://chatshare.xyz/pastel/#/carlist";
const CHAT_SURFACE_HOSTS = new Set(["chatgpt.com", "chatshare.xyz"]);
const DEVSPACE_PLUGIN_DISPLAY_PATTERN = /(?:DevSpace Local|\bdevspace\b)/i;
const DEVSPACE_SCHEMA_SENTINELS = [
  "source_resolve_start",
  "source_resolve_status",
  "source_resolve_submit",
] as const;
const DEFAULT_DEVICE_AUTH_LOOPBACK_PORT = 7677;
const DEFAULT_DEVICE_AUTH_EXTENSION_ID = "aaoelopmdnhifffjefciagfmhjanbaoc";
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  'main form [role="textbox"][contenteditable="true"]',
  'main form [contenteditable="true"][data-lexical-editor="true"]',
  "main form textarea",
  'main [role="textbox"][contenteditable="true"]',
  'main [contenteditable="true"][data-lexical-editor="true"]',
  "main textarea",
  'main [contenteditable="true"]',
] as const;
const COMPOSER_SELECTOR = COMPOSER_SELECTORS.map((selector) => `${selector}:visible`).join(", ");
const SEND_SELECTOR = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label^="Send"]',
].join(", ");
const STOP_SELECTOR = [
  'button[data-testid="stop-button"]',
  'button[aria-label^="Stop"]',
].join(", ");
const DELIVERY_TIMEOUT_PATTERN =
  /(?:訊息遞送逾時。?請再試一次。?|消息递送超时。?请再试一次。?|message delivery (?:timed out|timeout).*try again)/i;
const DEVSPACE_INTERRUPTED_PATTERN =
  /(?:Stopped talking to (?:DevSpace Local|devspace)|已停止(?:與|和)\s*(?:DevSpace Local|devspace)(?:交談|对话|通信)?|連線中斷|连线中断|連接中斷|连接中断|訊息超時|讯息超时|消息超時|消息超时|message timed out|connection (?:lost|interrupted|disconnected))/i;
const DEVSPACE_TOOL_RESPONSE_PATTERN =
  /(?:Received (?:an )?(?:application|app) response|已接收應用程式回應|已收到應用程式回應|已接收应用程序响应|已收到应用程序响应)/i;
const DEVSPACE_TOOL_RESPONSE_ONLY_PATTERN =
  /^(?:Received (?:an )?(?:application|app) response|已接收應用程式回應|已收到應用程式回應|已接收应用程序响应|已收到应用程序响应)$/i;
const DEVSPACE_TERMINAL_CAPACITY_PATTERN =
  /(?:you(?:'|’)ve reached your usage limit|usage limit|too many requests(?: in \d+ (?:hour|minute)s?)?|rate limit(?:ed| exceeded)?|您已達到使用上限|您已达到使用上限|已達到使用上限|已达到使用上限|請求過多|请求过多|速率限制)/i;
const DEVSPACE_TERMINAL_CONTEXT_PATTERN =
  /(?:this conversation has become too long|conversation (?:is|has become) too long|maximum context length|context length (?:limit|exceeded)|context window (?:limit|exceeded)|對話長度已達上限|对话长度已达上限|上下文長度(?:已)?(?:超出|達到上限)|上下文长度(?:已)?(?:超出|达到上限))/i;
const DEVSPACE_TRANSIENT_GATEWAY_PATTERN =
  /(?:\b502\s+Bad Gateway\b|\b504\s+Gateway Time-?out\b|Cloudflare Ray ID|Bad Gateway|Gateway Time-?out)/i;
const DEVSPACE_GENERIC_ERROR_PATTERN =
  /(?:Something went wrong|An error occurred\.?(?: If this issue persists[^.]*)?|發生錯誤|发生错误|出了點問題|出了点问题)/i;
const DEVSPACE_NATIVE_RECOVERY_BUTTON_PATTERN =
  /^(?:resume|retry|try again|重試|重试|再試一次|再试一次)$/i;
const DEFAULT_CHATSHARE_SILENT_IDLE_MS = 45_000;
const DEFAULT_AUTO_RESUME_COOLDOWN_MS = 60_000;
const ACTIVE_DEVSPACE_RECOVERY_WATCHES = new WeakSet<Page>();
const VERIFIED_DEVSPACE_TRY_IN_CHAT_HANDOFFS = new WeakSet<Page>();
const CHROME_LOCK_NAMES = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];

export interface WebLaunchAcknowledgement extends Record<string, unknown> {
  slice: "WEB-LAUNCH-0";
  launchSuccess: true;
  conversationIdentitySha256: string;
  timestamp: string;
  assistantOutputCaptured: false;
}

interface BrowserProfileLease {
  release(): Promise<void>;
}

export interface DeviceProofRequest {
  challenge: string;
  binding: string;
}

export type DeviceProofProvider = (request: DeviceProofRequest) => Promise<string>;

export interface WebLaunchBrowserOptions {
  contextFactory?: () => Promise<BrowserContext>;
  now?: () => Date;
  deviceProofProvider?: DeviceProofProvider;
  devSpacePublicBaseUrl?: string;
  sessionProvider?: ChatSessionProvider;
}

export interface WebLaunchConversationOptions {
  attachDevSpace?: boolean;
}

export type WebConversationResumeResult =
  | "sent"
  | "busy"
  | "missing"
  | "not_needed"
  | "terminal";

export type DevSpaceRecoverySignal =
  | "none"
  | "retryable_interruption"
  | "terminal_capacity"
  | "terminal_context"
  | "transient_gateway"
  | "generic_error";
export type WebConversationDeleteResult = "deleted" | "busy" | "missing" | "not_found";

export interface WebConversationResumeOptions {
  onlyIfDeliveryTimedOut?: boolean;
  onlyIfInterrupted?: boolean;
}

export interface DevSpaceChatShareRecoveryOptions {
  silentIdleMs?: number;
  resumeCooldownMs?: number;
  maxResumeAttempts?: number;
  pollMs?: number;
  signal?: AbortSignal;
  ensurePluginConnected?: () => Promise<void>;
}

export class WebLaunchBrowserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebLaunchBrowserError";
  }
}

export class WebLaunchBrowserController {
  readonly #allowedRoots: string[];
  readonly #contextFactory: (() => Promise<BrowserContext>) | undefined;
  readonly #now: () => Date;
  readonly #deviceProofProvider: DeviceProofProvider;
  readonly #devSpacePublicBaseUrl: string | undefined;
  readonly #sessionProvider: ChatSessionProvider;
  #context: BrowserContext | undefined;
  #lease: BrowserProfileLease | undefined;
  #launchInFlight: Promise<WebLaunchAcknowledgement> | undefined;
  #launchInFlightKey: string | undefined;
  readonly #recoveryWatchAbortByPage = new WeakMap<Page, AbortController>();
  readonly #recoveryWatchControllers = new Set<AbortController>();
  readonly #recoveryWatchPageByConversationIdentitySha256 = new Map<string, Page>();

  constructor(allowedRoots: string[], options: WebLaunchBrowserOptions = {}) {
    this.#allowedRoots = [...allowedRoots];
    this.#contextFactory = options.contextFactory;
    this.#now = options.now ?? (() => new Date());
    this.#deviceProofProvider = options.deviceProofProvider ?? requestLocalDeviceProof;
    this.#devSpacePublicBaseUrl =
      options.devSpacePublicBaseUrl?.trim() || process.env.DEVSPACE_PUBLIC_BASE_URL?.trim() || undefined;
    this.#sessionProvider = options.sessionProvider ?? "chatgpt";
  }

  async launchWebConversation(
    prompt: string,
    options: WebLaunchConversationOptions = {},
  ): Promise<WebLaunchAcknowledgement> {
    if (prompt.length === 0) {
      throw new WebLaunchBrowserError("WEB-LAUNCH-0 requires a non-empty prompt");
    }
    if (prompt.length > 100_000) {
      throw new WebLaunchBrowserError("WEB-LAUNCH-0 prompt exceeds 100000 characters");
    }
    if (prompt.includes("\r")) {
      throw new WebLaunchBrowserError(
        "WEB-LAUNCH-0 rejects carriage returns because the browser cannot preserve them exactly",
      );
    }

    const launchKey = sha256(
      `${options.attachDevSpace === true ? "devspace" : "plain"}\0${prompt}`,
    );
    if (this.#launchInFlight) {
      if (this.#launchInFlightKey === launchKey) {
        return this.#launchInFlight;
      }
      throw new WebLaunchBrowserError("WEB-LAUNCH-0 already has a launch in progress");
    }

    const launch = this.#launchWebConversationOnce(prompt, options);
    this.#launchInFlight = launch;
    this.#launchInFlightKey = launchKey;
    try {
      return await launch;
    } finally {
      if (this.#launchInFlight === launch) {
        this.#launchInFlight = undefined;
        this.#launchInFlightKey = undefined;
      }
    }
  }

  async #launchWebConversationOnce(
    prompt: string,
    options: WebLaunchConversationOptions,
  ): Promise<WebLaunchAcknowledgement> {
    let page: Page | undefined;
    try {
      const context = await this.#ensureContext();
      const existingIdentities = new Set(
        context
          .pages()
          .map((candidate) => chatConversationIdentityFromUrl(candidate.url()))
          .filter((identity): identity is string => identity !== undefined),
      );

      page = await claimLaunchPage(context);
      if (this.#sessionProvider === "chatshare") {
        await prepareChatShareSession(page);
      } else {
        await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      await assertAuthenticated(page);
      await page.evaluate((launchId) => {
        window.name = `devspace:web-launch-0:${launchId}`;
      }, randomUUID());

      const useDevSpaceSession =
        this.#sessionProvider === "chatshare" || options.attachDevSpace === true;
      if (useDevSpaceSession) {
        page = await navigateToConnectedDevSpaceSurface(page, 20_000, {
          refreshIfStale: this.#sessionProvider === "chatshare",
          devSpacePublicBaseUrl: this.#devSpacePublicBaseUrl,
          deviceProofProvider: this.#deviceProofProvider,
        });
      } else if (chatConversationIdentityFromUrl(page.url())) {
        throw new WebLaunchBrowserError("WEB-LAUNCH-0 did not open a fresh chat conversation");
      }
      if (useDevSpaceSession) {
        await injectAndSubmitConnectedPrompt(page, prompt);
      } else {
        await injectAndSubmitPrompt(page, prompt);
      }
      if (this.#sessionProvider === "chatshare") {
        this.#startChatShareRecoveryWatch(page);
      }
      if (useDevSpaceSession) {
        await activateDevSpaceForConversation(page, 8_000, {
          deviceProofProvider: this.#deviceProofProvider,
          devSpacePublicBaseUrl: this.#devSpacePublicBaseUrl,
        });
      }

      const conversationIdentity = await waitForChatConversationIdentity(page);
      if (existingIdentities.has(conversationIdentity)) {
        throw new WebLaunchBrowserError(
          "WEB-LAUNCH-0 reused an existing ChatGPT conversation identity",
        );
      }

      const conversationIdentitySha256 = sha256(conversationIdentity);
      if (this.#sessionProvider === "chatshare") {
        this.#recoveryWatchPageByConversationIdentitySha256.set(
          conversationIdentitySha256,
          page,
        );
      }

      await page.bringToFront().catch(() => undefined);
      return {
        slice: "WEB-LAUNCH-0",
        launchSuccess: true,
        conversationIdentitySha256,
        timestamp: this.#now().toISOString(),
        assistantOutputCaptured: false,
      };
    } catch (error) {
      await page?.close().catch(() => undefined);
      throw error;
    }
  }

  async resumeWebConversation(
    conversationIdentitySha256: string,
    prompt = "resume",
    options: WebConversationResumeOptions = {},
  ): Promise<WebConversationResumeResult> {
    if (!/^[0-9a-f]{64}$/i.test(conversationIdentitySha256)) {
      throw new WebLaunchBrowserError("resume requires a valid conversation identity hash");
    }
    if (prompt.length === 0 || prompt.length > 100_000 || prompt.includes("\r")) {
      throw new WebLaunchBrowserError("resume prompt is invalid");
    }
    if (this.#launchInFlight) return "busy";

    const context = this.#context;
    const browser = context?.browser();
    if (!context || !browser?.isConnected() || !browser.contexts().includes(context)) {
      return "missing";
    }

    const page = context.pages().find((candidate) => {
      const identity = chatConversationIdentityFromUrl(candidate.url());
      return identity !== undefined && sha256(identity) === conversationIdentitySha256;
    });
    if (!page || page.isClosed()) return "missing";

    const recoverySignal = await detectDevSpaceRecoverySignal(page);
    if (
      recoverySignal === "terminal_capacity" ||
      recoverySignal === "terminal_context"
    ) {
      return "terminal";
    }
    if (
      prompt.trim().toLowerCase() === "resume" &&
      (recoverySignal === "transient_gateway" ||
        recoverySignal === "generic_error")
    ) {
      return "not_needed";
    }

    const interrupted = recoverySignal === "retryable_interruption";
    if ((options.onlyIfInterrupted || options.onlyIfDeliveryTimedOut) && !interrupted) {
      return "not_needed";
    }

    const isResumePrompt = prompt.trim().toLowerCase() === "resume";

    if (interrupted && isResumePrompt) {
      const activeStops = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
        () => [] as Locator[],
      );
      if (activeStops.length > 0) {
        // UI-first rescue for the wedged-turn shape seen in ChatGPT: stop the
        // active turn before doing any connector recovery or navigation.
        const rescued = await resumeInterruptedDevSpaceConversationViaComposer(page, prompt);
        if (rescued) {
          if (this.#sessionProvider === "chatshare") {
            this.#startChatShareRecoveryWatch(page);
            this.#recoveryWatchPageByConversationIdentitySha256.set(
              conversationIdentitySha256,
              page,
            );
          }
          await page.bringToFront().catch(() => undefined);
          return "sent";
        }
      }
    }

    if (this.#sessionProvider === "chatshare" && isResumePrompt) {
      await ensureChatShareDevSpacePluginConnectedForRecovery(page, {
        devSpacePublicBaseUrl: this.#devSpacePublicBaseUrl,
        deviceProofProvider: this.#deviceProofProvider,
      });
    }

    if (interrupted && isResumePrompt) {
      const rescued = await resumeInterruptedDevSpaceConversationViaComposer(page, prompt);
      if (rescued) {
        if (this.#sessionProvider === "chatshare") {
          this.#startChatShareRecoveryWatch(page);
          this.#recoveryWatchPageByConversationIdentitySha256.set(
            conversationIdentitySha256,
            page,
          );
        }
        await page.bringToFront().catch(() => undefined);
        return "sent";
      }
    }

    const stopControls = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
      () => [] as Locator[],
    );
    if (stopControls.length > 0) return "busy";

    const composers = await rankedComposerLocators(page).catch(() => [] as Locator[]);
    if (composers.length !== 1) return "busy";

    await insertAndVerifyPrompt(composers[0]!, prompt);
    await submitPrompt(page, composers[0]!, prompt);
    if (this.#sessionProvider === "chatshare") {
      this.#startChatShareRecoveryWatch(page);
      this.#recoveryWatchPageByConversationIdentitySha256.set(
        conversationIdentitySha256,
        page,
      );
    }
    await page.bringToFront().catch(() => undefined);
    return "sent";
  }

  stopWebConversationRecovery(conversationIdentitySha256: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(conversationIdentitySha256)) {
      throw new WebLaunchBrowserError(
        "stop recovery requires a valid conversation identity hash",
      );
    }

    let page = this.#recoveryWatchPageByConversationIdentitySha256.get(
      conversationIdentitySha256,
    );
    if (!page || page.isClosed()) {
      page = this.#context?.pages().find((candidate) => {
        const identity = chatConversationIdentityFromUrl(candidate.url());
        return identity !== undefined && sha256(identity) === conversationIdentitySha256;
      });
    }

    this.#recoveryWatchPageByConversationIdentitySha256.delete(
      conversationIdentitySha256,
    );
    if (!page || page.isClosed()) return false;

    const abortController = this.#recoveryWatchAbortByPage.get(page);
    if (!abortController || abortController.signal.aborted) return false;
    abortController.abort();
    return true;
  }

  async deleteWebConversation(
    conversationIdentitySha256: string,
  ): Promise<WebConversationDeleteResult> {
    if (!/^[0-9a-f]{64}$/i.test(conversationIdentitySha256)) {
      throw new WebLaunchBrowserError("delete requires a valid conversation identity hash");
    }
    if (this.#launchInFlight) return "busy";

    const context = this.#context;
    const browser = context?.browser();
    if (!context || !browser?.isConnected() || !browser.contexts().includes(context)) {
      return "missing";
    }

    const page = context.pages().find((candidate) => {
      const identity = chatConversationIdentityFromUrl(candidate.url());
      return identity !== undefined && sha256(identity) === conversationIdentitySha256;
    });
    if (!page || page.isClosed()) return "missing";

    const stopControls = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
      () => [] as Locator[],
    );
    if (stopControls.length > 0) return "busy";

    const conversationPath = new URL(page.url()).pathname;
    const deleted = await deleteConversationHistoryFromSidebar(page, conversationPath);
    if (!deleted) return "not_found";

    await page.waitForTimeout(250).catch(() => undefined);
    await page.close().catch(() => undefined);
    return "deleted";
  }

  async close(): Promise<void> {
    const context = this.#context;
    const lease = this.#lease;
    this.#abortAllRecoveryWatches();
    this.#context = undefined;
    this.#lease = undefined;
    if (context) await context.close().catch(() => undefined);
    if (lease) await lease.release().catch(() => undefined);
  }

  #startChatShareRecoveryWatch(page: Page): void {
    const current = this.#recoveryWatchAbortByPage.get(page);
    if (current && !current.signal.aborted) return;

    const abortController = new AbortController();
    this.#recoveryWatchAbortByPage.set(page, abortController);
    this.#recoveryWatchControllers.add(abortController);

    void watchForDevSpaceChatShareRecovery(page, 0, {
      signal: abortController.signal,
      ensurePluginConnected: () =>
        ensureChatShareDevSpacePluginConnectedForRecovery(page, {
          devSpacePublicBaseUrl: this.#devSpacePublicBaseUrl,
          deviceProofProvider: this.#deviceProofProvider,
        }),
    })
      .catch(() => undefined)
      .finally(() => {
        this.#recoveryWatchControllers.delete(abortController);
        const stillOwnsPage =
          this.#recoveryWatchAbortByPage.get(page) === abortController;
        if (!stillOwnsPage) return;

        this.#recoveryWatchAbortByPage.delete(page);
        for (const [identitySha256, watchedPage] of this
          .#recoveryWatchPageByConversationIdentitySha256) {
          if (watchedPage === page) {
            this.#recoveryWatchPageByConversationIdentitySha256.delete(identitySha256);
          }
        }
      });
  }

  #abortAllRecoveryWatches(): void {
    for (const abortController of this.#recoveryWatchControllers) {
      abortController.abort();
    }
    this.#recoveryWatchControllers.clear();
    this.#recoveryWatchPageByConversationIdentitySha256.clear();
  }

  async #ensureContext(): Promise<BrowserContext> {
    if (this.#context) {
      const browser = this.#context.browser();
      if (browser?.isConnected() && browser.contexts().includes(this.#context)) {
        return this.#context;
      }

      const staleContext = this.#context;
      const staleLease = this.#lease;
      this.#abortAllRecoveryWatches();
      this.#context = undefined;
      this.#lease = undefined;
      await staleContext.close().catch(() => undefined);
      if (staleLease) await staleLease.release().catch(() => undefined);
    }

    if (this.#contextFactory) {
      const context = await this.#contextFactory();
      await this.#prepareContext(context);
      this.#bindContext(context);
      return context;
    }

    const profilePath = await resolveWebLaunchProfilePath(
      this.#allowedRoots,
      process.env,
      this.#sessionProvider,
    );
    this.#lease = await acquireProfileLease(profilePath);
    try {
      const context = await chromium.launchPersistentContext(profilePath, {
        channel: "chrome",
        headless: false,
        viewport: { width: 1280, height: 900 },
        ...(this.#sessionProvider === "chatshare"
          ? { ignoreDefaultArgs: ["--disable-extensions"] }
          : {}),
      });
      await this.#prepareContext(context);
      this.#bindContext(context);
      return context;
    } catch (error) {
      await this.#lease.release().catch(() => undefined);
      this.#lease = undefined;
      throw new WebLaunchBrowserError(
        "unable to launch dedicated headed Chrome for ChatGPT automation",
        { cause: error },
      );
    }
  }

  #bindContext(context: BrowserContext): void {
    this.#context = context;
    context.once("close", () => {
      if (this.#context !== context) return;
      this.#abortAllRecoveryWatches();
      this.#context = undefined;
      const lease = this.#lease;
      this.#lease = undefined;
      if (lease) void lease.release().catch(() => undefined);
    });
  }

  async #prepareContext(context: BrowserContext): Promise<void> {
    const pages = context.pages();
    const seed = pages[0] ?? (await context.newPage());
    for (const stale of pages.slice(1)) await stale.close().catch(() => undefined);
    if (!isReusableSeedPage(seed.url())) await seed.goto("about:blank");
  }
}

async function claimLaunchPage(context: BrowserContext): Promise<Page> {
  return context.pages().find((page) => isReusableSeedPage(page.url())) ?? context.newPage();
}

export async function injectAndSubmitPrompt(page: Page, prompt: string): Promise<void> {
  const composer = await findExactlyOneComposer(page);
  await insertAndVerifyPrompt(composer, prompt);
  await submitPrompt(page, composer, prompt);
}

export async function injectAndSubmitConnectedPrompt(
  page: Page,
  prompt: string,
): Promise<void> {
  const composer = await findExactlyOneComposer(page);
  const initialSelection = await readDevSpaceSelectionState(composer).catch(
    () => ({ totalCount: 0, inlineCount: 0, labels: [] as string[] }),
  );
  const verifiedTryInChatHandoff =
    initialSelection.totalCount === 0 &&
    VERIFIED_DEVSPACE_TRY_IN_CHAT_HANDOFFS.has(page);

  if (!verifiedTryInChatHandoff) {
    await assertDevSpaceSelection(composer);
  }

  const inlineSelection = await selectEditableTailAfterDevSpacePill(composer);
  if (inlineSelection) {
    await composer.page().keyboard.press("Delete");
    await composer.page().keyboard.insertText(prompt);
  } else {
    // Current ChatShare can render the selected app outside the contenteditable,
    // or omit a stable DOM marker after a verified Try in chat handoff. Normal
    // prompt insertion cannot delete that external app state.
    await insertAndVerifyPrompt(composer, prompt);
  }

  if (!verifiedTryInChatHandoff) {
    await assertDevSpaceSelection(composer);
  } else if (!VERIFIED_DEVSPACE_TRY_IN_CHAT_HANDOFFS.has(page)) {
    throw new WebLaunchBrowserError(
      "verified DevSpace Try in chat handoff was lost before prompt submission",
    );
  }

  const readBack = normalizeText(await readConnectedPromptText(composer));
  if (readBack !== normalizeText(prompt)) {
    throw new WebLaunchBrowserError(
      `connected DevSpace prompt read-back did not match the supplied prompt; actual=${JSON.stringify(readBack)}`,
    );
  }
  await submitPrompt(page, composer, prompt, readConnectedPromptText);
}

export async function waitForChatGptConversationIdentity(
  page: Page,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = chatGptConversationIdentityFromUrl(page.url());
    if (identity) return identity;
    await page.waitForTimeout(100);
  }
  throw new WebLaunchBrowserError(
    "WEB-LAUNCH-0 prompt did not establish a durable ChatGPT conversation identity",
  );
}

export async function waitForChatConversationIdentity(
  page: Page,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = chatConversationIdentityFromUrl(page.url());
    if (identity) return identity;
    await page.waitForTimeout(100);
  }
  throw new WebLaunchBrowserError(
    "WEB-LAUNCH-0 prompt did not establish a durable chat conversation identity",
  );
}

export async function prepareChatShareSession(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.goto(CHATSHARE_CARLIST_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.hostname !== "chatshare.xyz") {
      throw new WebLaunchBrowserError(
        `ChatShare session bootstrap left the expected origin: ${current.origin}`,
      );
    }

    if (/login|signin|signup/i.test(current.hash) || /\/(login|signin|signup)(\/|$)/i.test(current.pathname)) {
      throw new WebLaunchBrowserError(
        "ChatShare authentication is required in the dedicated DevSpace profile",
      );
    }

    const result = await page
      .evaluate(async () => {
        const response = await fetch("/frontend-api/carpage", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ThemeId: "pastel",
            "Accept-Language": localStorage.getItem("language") || "zh-CN",
          },
          credentials: "include",
          body: JSON.stringify({ page: 1, size: 999 }),
        });
        if (!response.ok) {
          return { ok: false as const, status: response.status, cars: [] as unknown[] };
        }
        const raw = (await response.json()) as unknown;
        let cursor: unknown = raw;
        let apiCode: number | undefined;
        let payload: Record<string, unknown> | undefined;

        for (let depth = 0; depth < 5; depth += 1) {
          if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) break;
          const record = cursor as Record<string, unknown>;
          if (apiCode === undefined && "code" in record) {
            const parsedCode = Number(record.code);
            if (Number.isFinite(parsedCode)) apiCode = parsedCode;
          }
          if (Array.isArray(record.list)) {
            payload = record;
            break;
          }
          const nested = record.data;
          if (!nested || typeof nested !== "object" || nested === cursor) break;
          cursor = nested;
        }

        if (!payload) {
          return {
            ok: false as const,
            status: response.status,
            cars: [] as unknown[],
            apiCode,
            reason: "inventory_list_missing",
          };
        }

        return {
          ok: true as const,
          status: response.status,
          cars: payload.list as unknown[],
          preferredCarId: localStorage.getItem("crtUse"),
          apiCode,
        };
      })
      .catch(() => undefined);

    if (result?.ok) {
      const candidates = result.cars
        .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object")
        .filter((car) => typeof car.carID === "string" && car.carID.length > 0)
        .filter((car) => Boolean(car.isPro))
        .filter((car) => Number(car.status ?? 1) !== 0)
        .filter((car) => Number(car.clears_in ?? 0) <= 0 && Number(car.team_clears_in ?? 0) <= 0)
        .sort((left, right) => {
          const leftPreferred = left.carID === result.preferredCarId ? 1 : 0;
          const rightPreferred = right.carID === result.preferredCarId ? 1 : 0;
          if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
          return Number(left.count ?? 0) - Number(right.count ?? 0);
        });

      const carId = candidates[0]?.carID;
      if (typeof carId === "string") {
        if (carId === result.preferredCarId) {
          await page.goto(CHATSHARE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
          const reused = new URL(page.url());
          if (
            reused.hostname === "chatshare.xyz" &&
            !reused.pathname.startsWith("/pastel") &&
            !/\/(login|signin|signup)(\/|$)/i.test(reused.pathname) &&
            !/login|signin|signup/i.test(reused.hash)
          ) {
            return;
          }
        }

        const loginResult = await page.evaluate(async (selectedCarId) => {
          localStorage.setItem("crtUse", selectedCarId);
          const url = `/auth/loginSession?carid=${encodeURIComponent(selectedCarId)}&carType=chatgpt`;
          const response = await fetch(url, { method: "GET", credentials: "include" });
          return { ok: response.ok, status: response.status };
        }, carId);
        if (!loginResult.ok) {
          throw new WebLaunchBrowserError(
            `ChatShare loginSession returned HTTP ${loginResult.status}`,
          );
        }

        const handoffDeadline = Date.now() + Math.min(
          5_000,
          Math.max(500, deadline - Date.now()),
        );
        while (Date.now() < handoffDeadline) {
          await page.goto(CHATSHARE_URL, {
            waitUntil: "domcontentloaded",
            timeout: Math.min(10_000, Math.max(1_000, handoffDeadline - Date.now())),
          });
          const landed = new URL(page.url());
          if (landed.hostname !== "chatshare.xyz") {
            throw new WebLaunchBrowserError(
              `ChatShare loginSession handoff left the expected origin: ${landed.origin}`,
            );
          }
          if (
            /login|signin|signup/i.test(landed.hash) ||
            /\/(login|signin|signup)(\/|$)/i.test(landed.pathname)
          ) {
            throw new WebLaunchBrowserError(
              "ChatShare authentication is required after loginSession handoff",
            );
          }
          if (!landed.pathname.startsWith("/pastel")) return;
          await page.waitForTimeout(250).catch(() => undefined);
        }

        throw new WebLaunchBrowserError(
          "ChatShare loginSession did not enter the proxied chat surface after bounded handoff retries",
        );
      }
    }

    await page.waitForTimeout(300);
  }

  throw new WebLaunchBrowserError(
    "ChatShare did not expose an available ChatGPT Pro session",
  );
}

export async function navigateToConnectedDevSpaceSurface(
  page: Page,
  timeoutMs = 20_000,
  options: {
    refreshIfStale?: boolean;
    devSpacePublicBaseUrl?: string;
    deviceProofProvider?: DeviceProofProvider;
  } = {},
): Promise<Page> {
  const chatBaseUrl = chatSurfaceBaseUrl(page.url());
  const pluginsUrl = chatPluginsSettingsUrl(chatBaseUrl);
  const chatShareAlreadyConnected =
    chatBaseUrl.hostname === "chatshare.xyz" &&
    (await devSpacePluginIsEnabledAndCurrent(page, Math.min(750, timeoutMs)));

  if (chatBaseUrl.hostname === "chatshare.xyz") {
    if (!chatShareAlreadyConnected) {
      await ensureChatSharePluginSettingsSurface(page, timeoutMs);
    }
  } else {
    await page.goto(pluginsUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await assertAuthenticated(page);
  }

  let pluginPage = page;

  if (options.refreshIfStale) {
    let currentPluginFound = chatShareAlreadyConnected;
    const pluginIds = currentPluginFound
      ? []
      : await resolveDevSpacePluginIds(
      page,
      chatBaseUrl.hostname === "chatshare.xyz"
        ? Math.min(5_000, timeoutMs)
        : Math.min(1_500, timeoutMs),
    );
    for (const pluginId of pluginIds) {
      if (chatBaseUrl.hostname === "chatshare.xyz") {
        await openChatSharePluginDetail(page, pluginId, timeoutMs);
      } else {
        const pluginUrl = chatPluginDetailUrl(chatBaseUrl, pluginId);
        await page.goto(pluginUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await assertAuthenticated(page);
      }
      const schemaWaitMs =
        chatBaseUrl.hostname === "chatshare.xyz"
          ? Math.min(5_000, timeoutMs)
          : Math.min(750, timeoutMs);
      if (!(await devSpacePluginHasCurrentSchema(page, schemaWaitMs))) {
        continue;
      }

      if (!(await devSpacePluginIsEnabledAndCurrent(page, Math.min(1_500, timeoutMs)))) {
        pluginPage = await reconnectCurrentDevSpacePlugin(page, {
          devSpacePublicBaseUrl: options.devSpacePublicBaseUrl,
          deviceProofProvider: options.deviceProofProvider ?? requestLocalDeviceProof,
          timeoutMs,
        });
      } else {
        pluginPage = page;
      }

      const connectedAfterReconnect =
        chatBaseUrl.hostname === "chatshare.xyz"
          ? await devSpacePluginHasUsableTryInChat(
              pluginPage,
              Math.min(5_000, timeoutMs),
            )
          : await devSpacePluginIsEnabledAndCurrent(
              pluginPage,
              Math.min(5_000, timeoutMs),
            );
      if (!connectedAfterReconnect) {
        const bodyText = await pluginPage.locator("body").innerText().catch(() => "");
        const pageUrls = pluginPage
          .context()
          .pages()
          .filter((candidate) => !candidate.isClosed())
          .map((candidate) => candidate.url());
        throw new WebLaunchBrowserError(
          `current DevSpace plugin ${pluginId} has the expected schema but remained disconnected after reconnect; refusing duplicate registration; url=${pluginPage.url()}; pages=${JSON.stringify(pageUrls)}; body=${bodyText.slice(0, 1600)}`,
        );
      }

      if (pluginPage !== page && !page.isClosed()) {
        await page.close().catch(() => undefined);
      }

      if (chatBaseUrl.hostname === "chatshare.xyz") {
        await dismissPluginSettingsDialogIfPresent(pluginPage);
      }

      currentPluginFound = true;
      break;
    }

    if (!currentPluginFound) {
      pluginPage = await refreshDevSpacePluginRegistration(page, {
        devSpacePublicBaseUrl: options.devSpacePublicBaseUrl,
        deviceProofProvider: options.deviceProofProvider,
        timeoutMs,
      });
    }
  } else {
    const pluginId = await resolveDevSpacePluginId(page, timeoutMs);
    if (chatBaseUrl.hostname === "chatshare.xyz") {
      await openChatSharePluginDetail(page, pluginId, timeoutMs);
    } else {
      const pluginUrl = chatPluginDetailUrl(chatBaseUrl, pluginId);
      await page.goto(pluginUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await assertAuthenticated(page);
    }
  }

  if (chatBaseUrl.hostname === "chatshare.xyz") {
    await dismissPluginSettingsDialogIfPresent(pluginPage);
  }

  const deadline = Date.now() + timeoutMs;
  let tryInChatButtons: Locator[] = [];
  while (Date.now() < deadline) {
    tryInChatButtons = await credibleLocators(
      pluginPage.getByRole("button", { name: "Try in chat", exact: true }),
      true,
    );
    if (tryInChatButtons.length === 1) break;
    if (tryInChatButtons.length > 1) {
      throw new WebLaunchBrowserError(
        `found ${tryInChatButtons.length} enabled Try in chat buttons; expected exactly one`,
      );
    }
    await pluginPage.waitForTimeout(150);
  }
  if (tryInChatButtons.length !== 1) {
    throw new WebLaunchBrowserError("DevSpace plugin detail page did not expose Try in chat");
  }

  const context = pluginPage.context();
  const pagesBeforeTryInChat = new Set(context.pages());
  const pluginPageUrlBeforeTryInChat = pluginPage.url();
  if (!(await clickLocatorRobustly(tryInChatButtons[0]!, 5_000))) {
    throw new WebLaunchBrowserError("DevSpace Try in chat control could not be activated");
  }

  const handoffDeadline = Date.now() + timeoutMs;
  let lastCandidateUrls: string[] = [];
  let lastSelectionDiagnostics: Array<{
    url: string;
    composerCount: number;
    selection?: DevSpaceSelectionState;
  }> = [];
  while (Date.now() < handoffDeadline) {
    const matched: Array<{
      page: Page;
      composer: Locator;
      isNew: boolean;
      selectionVerified: boolean;
    }> = [];
    lastCandidateUrls = [];
    lastSelectionDiagnostics = [];

    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;

      let candidateUrl: URL;
      try {
        candidateUrl = new URL(candidate.url());
      } catch {
        continue;
      }
      if (!CHAT_SURFACE_HOSTS.has(candidateUrl.hostname)) continue;
      lastCandidateUrls.push(candidate.url());

      await assertAuthenticated(candidate);
      if (chatConversationIdentityFromUrl(candidate.url())) {
        continue;
      }

      const composers = await rankedComposerLocators(candidate).catch(() => [] as Locator[]);
      if (composers.length !== 1) {
        lastSelectionDiagnostics.push({
          url: candidate.url(),
          composerCount: composers.length,
        });
        continue;
      }
      const expectedPluginId = devSpacePluginIdFromUrl(pluginPage.url());
      const selectionState = await readDevSpaceSelectionState(
        composers[0]!,
        expectedPluginId,
      ).catch(() => ({ totalCount: 0, inlineCount: 0, labels: [] as string[] }));
      lastSelectionDiagnostics.push({
        url: candidate.url(),
        composerCount: 1,
        selection: selectionState,
      });

      const selectionVerified = selectionState.totalCount === 1;
      const pluginPageWasWorkSurface = (() => {
        try {
          return new URL(pluginPageUrlBeforeTryInChat).searchParams.get("surface") === "work";
        } catch {
          return false;
        }
      })();
      const causalTryInChatWorkSurface =
        candidateUrl.searchParams.get("surface") === "work" &&
        (!pagesBeforeTryInChat.has(candidate) ||
          (candidate === pluginPage && !pluginPageWasWorkSurface));

      if (!selectionVerified && !causalTryInChatWorkSurface) continue;

      matched.push({
        page: candidate,
        composer: composers[0]!,
        isNew: !pagesBeforeTryInChat.has(candidate),
        selectionVerified,
      });
    }

    const newlyOpened = matched.filter((candidate) => candidate.isNew);
    const pool = newlyOpened.length > 0 ? newlyOpened : matched;
    if (pool.length > 1) {
      throw new WebLaunchBrowserError(
        `DevSpace Try in chat produced ${pool.length} candidate chat surfaces; expected exactly one`,
      );
    }
    if (pool.length === 1) {
      const selected = pool[0]!;
      const finalPage = selected.page;
      if (selected.selectionVerified) {
        await assertDevSpaceSelection(
          selected.composer,
          Math.min(2_000, timeoutMs),
          devSpacePluginIdFromUrl(pluginPage.url()),
        );
      } else {
        // The click itself is the causal proof: this unique fresh composer was
        // reached directly from DevSpace's Try in chat control. Production
        // ChatShare can keep the selected app in UI state without exposing a
        // stable DOM marker inside or near the composer.
        VERIFIED_DEVSPACE_TRY_IN_CHAT_HANDOFFS.add(finalPage);
      }
      await dismissWorkOnboardingIfPresent(finalPage);
      if (finalPage !== pluginPage && !pluginPage.isClosed()) {
        await pluginPage.close().catch(() => undefined);
      }
      return finalPage;
    }

    await pluginPage.waitForTimeout(150).catch(() => undefined);
  }

  const domDiagnostics: Array<{
    url: string;
    composer?: string;
    nearby?: string[];
  }> = [];
  for (const candidate of context.pages()) {
    if (candidate.isClosed()) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate.url());
    } catch {
      continue;
    }
    if (!CHAT_SURFACE_HOSTS.has(parsed.hostname)) continue;

    const composers = await rankedComposerLocators(candidate).catch(() => [] as Locator[]);
    if (composers.length !== 1) {
      domDiagnostics.push({ url: candidate.url() });
      continue;
    }

    const snapshot = await composers[0]!
      .evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          return { composer: "", nearby: [] as string[] };
        }
        const composerHtml = element.outerHTML.slice(0, 3200);
        const rect = element.getBoundingClientRect();
        const nearby = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, [role="button"], [aria-label], [title], [data-testid], [data-state], [aria-pressed], [aria-selected]',
          ),
        )
          .filter((candidate) => {
            if (candidate === element || element.contains(candidate)) return false;
            if (candidate.getClientRects().length === 0) return false;
            const candidateRect = candidate.getBoundingClientRect();
            const centerX = candidateRect.left + candidateRect.width / 2;
            const centerY = candidateRect.top + candidateRect.height / 2;
            const composerCenterX = rect.left + rect.width / 2;
            const composerCenterY = rect.top + rect.height / 2;
            return (
              Math.abs(centerX - composerCenterX) <= 900 &&
              Math.abs(centerY - composerCenterY) <= 700
            );
          })
          .slice(0, 40)
          .map((candidate) =>
            candidate.outerHTML
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 500),
          );
        return { composer: composerHtml, nearby };
      })
      .catch(() => ({ composer: "", nearby: [] as string[] }));

    domDiagnostics.push({
      url: candidate.url(),
      composer: snapshot.composer,
      nearby: snapshot.nearby,
    });
  }

  throw new WebLaunchBrowserError(
    `DevSpace Try in chat did not reach a unique selected composer; pages=${JSON.stringify(lastCandidateUrls)}; selection=${JSON.stringify(lastSelectionDiagnostics)}; dom=${JSON.stringify(domDiagnostics).slice(0, 12000)}`,
  );
}

async function clickLocatorRobustly(
  control: Locator,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (!(await control.isVisible().catch(() => false))) return false;
  if (!(await control.isEnabled().catch(() => false))) return false;

  try {
    await control.click({ timeout: timeoutMs });
    return true;
  } catch {
    // ChatShare occasionally renders an interactive wrapper whose child intercepts
    // pointer events. Fall through to a bounded force-click, then DOM click.
  }

  try {
    await control.click({ timeout: Math.min(timeoutMs, 2_000), force: true });
    return true;
  } catch {
    // Fall through to HTMLElement.click().
  }

  return control
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })
    .catch(() => false);
}

async function chatShareSettingsSurfaceReady(page: Page): Promise<boolean> {
  const pluginNavPattern = /^(?:Plugins|外掛程式|外挂程序|插件)$/i;
  const generalPattern = /^(?:General|一般|常規|常规)$/i;

  const pluginTabs = await page
    .getByRole("tab", { name: pluginNavPattern })
    .all()
    .catch(() => [] as Locator[]);
  const generalTabs = await page
    .getByRole("tab", { name: generalPattern })
    .all()
    .catch(() => [] as Locator[]);
  if ((await anyLocatorVisible(pluginTabs)) && (await anyLocatorVisible(generalTabs))) {
    return true;
  }

  const pluginLabels = await page
    .getByText(pluginNavPattern, { exact: true })
    .all()
    .catch(() => [] as Locator[]);
  if (!(await anyLocatorVisible(pluginLabels))) return false;

  const generalLabels = await page
    .getByText(generalPattern, { exact: true })
    .all()
    .catch(() => [] as Locator[]);
  return anyLocatorVisible(generalLabels);
}

async function clickableAncestor(candidate: Locator): Promise<Locator> {
  const clickable = candidate.locator(
    'xpath=ancestor-or-self::*[self::button or self::a or @role="button" or @role="menuitem" or @role="tab"][1]',
  );
  if ((await clickable.count().catch(() => 0)) === 1) return clickable;
  return candidate;
}

async function ensureChatShareSettingsSurface(
  page: Page,
  timeoutMs = 5_000,
  options: { uiOnly?: boolean } = {},
): Promise<void> {
  let current: URL;
  try {
    current = new URL(page.url());
  } catch {
    return;
  }
  if (current.hostname !== "chatshare.xyz") return;
  if (await chatShareSettingsSurfaceReady(page)) return;

  const chatBaseUrl = chatSurfaceBaseUrl(page.url());
  if (!options.uiOnly) {
    await page.goto(new URL("/#settings", chatBaseUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await assertAuthenticated(page);

    const directDeadline = Date.now() + Math.min(5_000, timeoutMs);
    while (Date.now() < directDeadline) {
      if (await chatShareSettingsSurfaceReady(page)) return;
      await page.waitForTimeout(100).catch(() => undefined);
    }
  }

  await page.goto(chatBaseUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await assertAuthenticated(page);

  const deadline = Date.now() + Math.min(timeoutMs, 8_000);
  const settingsPattern = /^(?:Settings|設定|设置)$/i;
  let profileClickSucceeded = false;
  let settingsClickSucceeded = false;

  while (Date.now() < deadline) {
    if (await chatShareSettingsSurfaceReady(page)) return;

    // UI navigation can update the hash to #settings before React finishes
    // mounting the Settings shell. Once the UI has causally entered the
    // settings route, wait boundedly for that shell instead of bouncing back
    // to the home/profile menu and misclassifying the transition as a failure.
    try {
      const routed = new URL(page.url());
      if (routed.hash.startsWith("#settings")) {
        const settleDeadline = Date.now() + Math.min(
          5_000,
          Math.max(100, deadline - Date.now()),
        );
        while (Date.now() < settleDeadline) {
          if (await chatShareSettingsSurfaceReady(page)) return;
          await page.waitForTimeout(100).catch(() => undefined);
        }
      }
    } catch {
      // Keep using the UI discovery path below.
    }

    const settingsCandidates = await page
      .getByText(settingsPattern, { exact: true })
      .all()
      .catch(() => [] as Locator[]);
    for (const candidate of settingsCandidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const control = await clickableAncestor(candidate);
      if (!(await clickLocatorRobustly(control, 2_500))) continue;
      settingsClickSucceeded = true;

      const settingsDeadline = Date.now() + Math.min(1_500, Math.max(100, deadline - Date.now()));
      while (Date.now() < settingsDeadline) {
        if (await chatShareSettingsSurfaceReady(page)) return;
        await page.waitForTimeout(100).catch(() => undefined);
      }
    }

    const profileCandidates = await page
      .locator('[data-testid="accounts-profile-button"]')
      .all()
      .catch(() => [] as Locator[]);
    const visibleProfiles: Locator[] = [];
    for (const candidate of profileCandidates) {
      if (await candidate.isVisible().catch(() => false)) visibleProfiles.push(candidate);
    }

    const preferredProfiles: Locator[] = [];
    for (const candidate of visibleProfiles) {
      const aria = await candidate.getAttribute("aria-label").catch(() => null);
      if (aria && /open profile menu/i.test(aria)) preferredProfiles.push(candidate);
    }
    const profilePool = preferredProfiles.length > 0 ? preferredProfiles : visibleProfiles;

    for (const profile of profilePool) {
      if (!(await clickLocatorRobustly(profile, 2_500))) continue;
      profileClickSucceeded = true;
      await page.waitForTimeout(150).catch(() => undefined);

      const reopenedSettingsCandidates: Locator[] = [];
      const roleCandidates = [
        page.getByRole("menuitem", { name: settingsPattern }),
        page.getByRole("button", { name: settingsPattern }),
        page.getByRole("link", { name: settingsPattern }),
      ];
      for (const locator of roleCandidates) {
        for (const candidate of await locator.all().catch(() => [] as Locator[])) {
          if (await candidate.isVisible().catch(() => false)) {
            reopenedSettingsCandidates.push(candidate);
          }
        }
      }
      if (reopenedSettingsCandidates.length === 0) {
        for (const candidate of await page
          .getByText(settingsPattern, { exact: true })
          .all()
          .catch(() => [] as Locator[])) {
          if (await candidate.isVisible().catch(() => false)) {
            reopenedSettingsCandidates.push(await clickableAncestor(candidate));
          }
        }
      }

      for (const settingsControl of reopenedSettingsCandidates) {
        if (!(await clickLocatorRobustly(settingsControl, 2_500))) continue;
        settingsClickSucceeded = true;

        const settingsDeadline = Date.now() + Math.min(
          5_000,
          Math.max(100, deadline - Date.now()),
        );
        while (Date.now() < settingsDeadline) {
          if (await chatShareSettingsSurfaceReady(page)) return;
          await page.waitForTimeout(100).catch(() => undefined);
        }
      }
      break;
    }

    await page.waitForTimeout(100).catch(() => undefined);
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  throw new WebLaunchBrowserError(
    `ChatShare could not open Settings through the profile menu; profileClick=${profileClickSucceeded}; settingsClick=${settingsClickSucceeded}; url=${page.url()}; body=${bodyText.slice(0, 1200)}`,
  );
}

async function ensureChatShareDeveloperModeEnabled(
  page: Page,
  timeoutMs = 5_000,
): Promise<void> {
  await ensureChatShareSettingsSurface(page, timeoutMs, { uiOnly: true });

  const securityNavPattern =
    /^(?:Security and login|Security & login|安全性與登入|安全性和登入|安全性和登录|安全與登入|安全和登录)$/i;
  const developerModePattern =
    /^(?:Developer mode|開發人員模式|开发人员模式|開發者模式|开发者模式)$/i;
  const cspPattern =
    /^(?:Enforce CSP in developer mode|在開發人員模式中強制執行 CSP|在开发人员模式中强制执行 CSP|在開發者模式中強制執行 CSP|在开发者模式中强制执行 CSP)$/i;

  const visibleExactText = async (pattern: RegExp): Promise<Locator[]> => {
    const matches: Locator[] = [];
    for (const candidate of await page
      .getByText(pattern, { exact: true })
      .all()
      .catch(() => [] as Locator[])) {
      if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
    }
    return matches;
  };

  if ((await visibleExactText(developerModePattern)).length === 0) {
    const navCandidates: Locator[] = [];
    for (const control of await page
      .locator('button, a, [role="button"], [role="menuitem"], [role="tab"]')
      .all()
      .catch(() => [] as Locator[])) {
      if (!(await control.isVisible().catch(() => false))) continue;
      if (!(await control.isEnabled().catch(() => false))) continue;
      const label = await control
        .evaluate((element) =>
          [
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("title") ?? "",
            element.textContent ?? "",
          ]
            .map((value) => value.replace(/\s+/g, " ").trim())
            .find((value) => value.length > 0) ?? "",
        )
        .catch(() => "");
      if (securityNavPattern.test(label)) navCandidates.push(control);
    }

    if (navCandidates.length === 0) {
      for (const candidate of await visibleExactText(securityNavPattern)) {
        navCandidates.push(await clickableAncestor(candidate));
      }
    }

    let opened = false;
    for (const candidate of navCandidates) {
      if (!(await clickLocatorRobustly(candidate, 2_500))) continue;
      opened = true;
      const sectionDeadline = Date.now() + Math.min(2_000, timeoutMs);
      while (Date.now() < sectionDeadline) {
        if ((await visibleExactText(developerModePattern)).length > 0) break;
        await page.waitForTimeout(100).catch(() => undefined);
      }
      if ((await visibleExactText(developerModePattern)).length > 0) break;
    }

    if (!opened || (await visibleExactText(developerModePattern)).length === 0) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      throw new WebLaunchBrowserError(
        `ChatShare UI fallback could not open Security and login; url=${page.url()}; body=${bodyText.slice(0, 1200)}`,
      );
    }
  }

  const findSettingSwitch = async (pattern: RegExp): Promise<Locator | undefined> => {
    for (const label of await visibleExactText(pattern)) {
      const row = label.locator(
        'xpath=ancestor::*[.//*[@role="switch"] or .//input[@type="checkbox"]][1]',
      );
      if ((await row.count().catch(() => 0)) !== 1) continue;
      const switches = await row
        .locator('[role="switch"], input[type="checkbox"]')
        .all()
        .catch(() => [] as Locator[]);
      const visibleSwitches: Locator[] = [];
      for (const control of switches) {
        if (await control.isVisible().catch(() => false)) visibleSwitches.push(control);
      }
      if (visibleSwitches.length === 1) return visibleSwitches[0];
    }
    return undefined;
  };

  const switchIsOn = async (control: Locator): Promise<boolean | undefined> => {
    const ariaChecked = await control.getAttribute("aria-checked").catch(() => null);
    if (ariaChecked === "true") return true;
    if (ariaChecked === "false") return false;

    const dataState = await control.getAttribute("data-state").catch(() => null);
    if (dataState === "checked" || dataState === "on") return true;
    if (dataState === "unchecked" || dataState === "off") return false;

    const tagName = await control.evaluate((element) => element.tagName).catch(() => "");
    if (tagName === "INPUT") {
      return control.isChecked().catch(() => undefined);
    }
    return undefined;
  };

  const ensureSwitchOn = async (
    pattern: RegExp,
    settingName: string,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const control = await findSettingSwitch(pattern);
      if (!control) {
        await page.waitForTimeout(100).catch(() => undefined);
        continue;
      }

      const state = await switchIsOn(control);
      if (state === true) return;
      if (state === undefined) {
        throw new WebLaunchBrowserError(
          `ChatShare ${settingName} toggle did not expose an inspectable checked state`,
        );
      }
      if (!(await control.isEnabled().catch(() => false))) {
        await page.waitForTimeout(100).catch(() => undefined);
        continue;
      }
      if (!(await clickLocatorRobustly(control, 2_500))) {
        throw new WebLaunchBrowserError(
          `ChatShare ${settingName} toggle could not be activated`,
        );
      }

      const verifyDeadline = Date.now() + Math.min(2_000, Math.max(250, deadline - Date.now()));
      while (Date.now() < verifyDeadline) {
        if ((await switchIsOn(control)) === true) return;
        await page.waitForTimeout(100).catch(() => undefined);
      }
    }

    throw new WebLaunchBrowserError(
      `ChatShare ${settingName} toggle did not become enabled through the Settings UI`,
    );
  };

  await ensureSwitchOn(developerModePattern, "Developer mode");
  await ensureSwitchOn(cspPattern, "Enforce CSP in developer mode");
}

async function openChatSharePluginDetail(
  page: Page,
  pluginId: string,
  timeoutMs = 5_000,
): Promise<void> {
  if (devSpacePluginIdFromUrl(page.url()) === pluginId) {
    await assertAuthenticated(page);
    return;
  }

  const deadline = Date.now() + Math.min(timeoutMs, 8_000);
  let clicked = false;

  while (Date.now() < deadline) {
    await ensureChatSharePluginSettingsSurface(
      page,
      Math.min(5_000, Math.max(500, deadline - Date.now())),
    );

    const links = await page
      .locator('a[href*="plugin_"]')
      .all()
      .catch(() => [] as Locator[]);
    for (const link of links) {
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = await link.getAttribute("href").catch(() => null);
      if (!href) continue;

      let resolvedId: string | undefined;
      try {
        resolvedId = devSpacePluginIdFromUrl(new URL(href, page.url()).href);
      } catch {
        resolvedId = undefined;
      }
      if (resolvedId !== pluginId) continue;

      if (!(await clickLocatorRobustly(link, 2_500))) continue;
      clicked = true;

      const detailDeadline = Date.now() + Math.min(1_500, Math.max(100, deadline - Date.now()));
      while (Date.now() < detailDeadline) {
        if (devSpacePluginIdFromUrl(page.url()) === pluginId) {
          await assertAuthenticated(page);
          return;
        }
        await page.waitForTimeout(100).catch(() => undefined);
      }
    }

    const cardButtons = await credibleLocators(
      page.getByRole("button", { name: /^(?:DevSpace Local|devspace)$/i }),
      true,
    ).catch(() => [] as Locator[]);
    if (cardButtons.length > 1) {
      throw new WebLaunchBrowserError(
        `ChatShare Plugins exposed ${cardButtons.length} DevSpace cards; expected at most one`,
      );
    }
    if (cardButtons.length === 1) {
      if (await clickLocatorRobustly(cardButtons[0]!, 2_500)) {
        clicked = true;
        const detailDeadline = Date.now() + Math.min(
          1_500,
          Math.max(100, deadline - Date.now()),
        );
        while (Date.now() < detailDeadline) {
          if (devSpacePluginIdFromUrl(page.url()) === pluginId) {
            await assertAuthenticated(page);
            return;
          }
          await page.waitForTimeout(100).catch(() => undefined);
        }
      }
    }

    await page.waitForTimeout(100).catch(() => undefined);
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  throw new WebLaunchBrowserError(
    `ChatShare could not open DevSpace plugin detail through the Plugins UI; pluginId=${pluginId}; clicked=${clicked}; url=${page.url()}; body=${bodyText.slice(0, 1200)}`,
  );
}

async function chatSharePluginSettingsSurfaceReady(page: Page): Promise<boolean> {
  const pluginLinks = await visibleLocators(
    page.locator(
      'a[href*="#settings/Plugins/plugin_"], a[href*="/plugins/plugin_"]',
    ),
  ).catch(() => [] as Locator[]);
  if (pluginLinks.length > 0) return true;

  const cardControls = await credibleLocators(
    page.getByRole("button", { name: /^(?:DevSpace Local|devspace)$/i }),
    true,
  ).catch(() => [] as Locator[]);
  if (cardControls.length > 0) return true;

  const managePluginsHeadings = await page
    .getByText(/^Manage plugins you've installed$/i, { exact: true })
    .all()
    .catch(() => [] as Locator[]);
  if (await anyLocatorVisible(managePluginsHeadings)) return true;

  const browseControls = await visibleLocators(
    page.getByText(
      /^(?:Browse plugins|Explore plugins|Plugin store|瀏覽(?:外掛程式|插件)|浏览(?:插件|插件程序)|外掛程式商店|插件商店)$/i,
      { exact: true },
    ),
  ).catch(() => [] as Locator[]);
  if (browseControls.length > 0) return true;

  const searchControls = await visibleLocators(
    page.locator(
      'input[placeholder*="plugin" i], input[aria-label*="plugin" i], input[placeholder*="插件"], input[aria-label*="插件"], input[placeholder*="外掛"], input[aria-label*="外掛"], input[placeholder*="外挂"], input[aria-label*="外挂"]',
    ),
  ).catch(() => [] as Locator[]);
  return searchControls.length > 0;
}

async function chatSharePluginSettingsSurfaceStable(
  page: Page,
  settleMs = 300,
): Promise<boolean> {
  if (!(await chatSharePluginSettingsSurfaceReady(page))) return false;
  await page.waitForTimeout(settleMs).catch(() => undefined);
  return chatSharePluginSettingsSurfaceReady(page);
}

function isPluginStorePath(page: Page): boolean {
  try {
    return new URL(page.url()).pathname.replace(/\/+$/, "") === "/plugins";
  } catch {
    return false;
  }
}

async function ensureChatSharePluginSettingsSurface(
  page: Page,
  timeoutMs = 5_000,
  options: { uiOnly?: boolean } = {},
): Promise<void> {
  let current: URL;
  try {
    current = new URL(page.url());
  } catch {
    return;
  }
  if (current.hostname !== "chatshare.xyz") return;

  await ensureChatShareSettingsSurface(page, timeoutMs, {
    uiOnly: options.uiOnly,
  });
  if (await chatSharePluginSettingsSurfaceStable(page)) return;

  const pluginNavPattern = /^(?:Plugins|外掛程式|外挂程序|插件)$/i;
  const deadline = Date.now() + Math.min(timeoutMs, 5_000);
  let clickedAny = false;

  while (Date.now() < deadline) {
    const controls: Locator[] = [];
    for (const control of await page
      .locator('button, a, [role="button"], [role="menuitem"], [role="tab"]')
      .all()
      .catch(() => [] as Locator[])) {
      if (!(await control.isVisible().catch(() => false))) continue;
      if (!(await control.isEnabled().catch(() => false))) continue;
      const label = await control
        .evaluate((element) =>
          [
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("title") ?? "",
            element.textContent ?? "",
          ]
            .map((value) => value.replace(/\s+/g, " ").trim())
            .find((value) => value.length > 0) ?? "",
        )
        .catch(() => "");
      if (pluginNavPattern.test(label)) controls.push(control);
    }

    if (controls.length === 0) {
      for (const candidate of await page
        .getByText(pluginNavPattern, { exact: true })
        .all()
        .catch(() => [] as Locator[])) {
        if (!(await candidate.isVisible().catch(() => false))) continue;
        controls.push(candidate);
      }
    }

    if (controls.length > 0) {
      for (const control of controls) {
        if (!(await control.isVisible().catch(() => false))) continue;
        if (!(await control.isEnabled().catch(() => false))) continue;
        if (!(await clickLocatorRobustly(control, 2_500))) continue;
        clickedAny = true;

        const candidateDeadline = Date.now() + Math.min(750, timeoutMs);
        while (Date.now() < candidateDeadline) {
          if (await chatSharePluginSettingsSurfaceStable(page)) return;
          await page.waitForTimeout(100).catch(() => undefined);
        }
      }
    }
    await page.waitForTimeout(100).catch(() => undefined);
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!clickedAny) {
    throw new WebLaunchBrowserError(
      `ChatShare settings did not expose a Plugins navigation control; url=${page.url()}; body=${bodyText.slice(0, 1200)}`,
    );
  }
  throw new WebLaunchBrowserError(
    `ChatShare Plugins navigation controls were clickable but none reached the plugin settings surface; url=${page.url()}; body=${bodyText.slice(0, 1200)}`,
  );
}

async function devSpacePluginHasCurrentSchema(
  page: Page,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (DEVSPACE_SCHEMA_SENTINELS.every((sentinel) => bodyText.includes(sentinel))) {
      return true;
    }
    await page.waitForTimeout(150).catch(() => undefined);
  }
  return false;
}

async function devSpacePluginHasUsableTryInChat(
  page: Page,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tryInChatButtons = await credibleLocators(
      page.getByRole("button", { name: "Try in chat", exact: true }),
      true,
    ).catch(() => [] as Locator[]);
    if (tryInChatButtons.length === 1) return true;
    if (tryInChatButtons.length > 1) {
      throw new WebLaunchBrowserError(
        `found ${tryInChatButtons.length} enabled Try in chat buttons; expected exactly one`,
      );
    }
    await page.waitForTimeout(150).catch(() => undefined);
  }
  return false;
}

async function devSpacePluginIsEnabledAndCurrent(
  page: Page,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await devSpacePluginHasCurrentSchema(page, Math.min(300, timeoutMs))) {
      const tryInChatButtons = await credibleLocators(
        page.getByRole("button", { name: "Try in chat", exact: true }),
        true,
      ).catch(() => [] as Locator[]);
      if (tryInChatButtons.length === 1) return true;
      if (tryInChatButtons.length > 1) {
        throw new WebLaunchBrowserError(
          `found ${tryInChatButtons.length} enabled Try in chat buttons; expected exactly one`,
        );
      }
    }
    await page.waitForTimeout(150).catch(() => undefined);
  }
  return false;
}

async function reconnectCurrentDevSpacePlugin(
  page: Page,
  options: {
    devSpacePublicBaseUrl?: string;
    deviceProofProvider: DeviceProofProvider;
    timeoutMs?: number;
  },
): Promise<Page> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  const context = page.context();
  const pluginId = devSpacePluginIdFromUrl(page.url());
  let openedConnection = false;
  let connectionActionClicked = false;

  const findConnectedPluginPage = async (): Promise<Page | undefined> => {
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      if (pluginId && devSpacePluginIdFromUrl(candidate.url()) !== pluginId) continue;
      const tryInChatButtons = await credibleLocators(
        candidate.getByRole("button", { name: "Try in chat", exact: true }),
        true,
      ).catch(() => [] as Locator[]);
      if (tryInChatButtons.length === 1) return candidate;
      if (tryInChatButtons.length > 1) {
        throw new WebLaunchBrowserError(
          `current DevSpace plugin exposed ${tryInChatButtons.length} Try in chat buttons; expected exactly one`,
        );
      }
    }
    return undefined;
  };

  while (Date.now() < deadline) {
    const connectedPage = await findConnectedPluginPage();
    if (connectedPage) return connectedPage;

    const signInButtons = await credibleLocators(
      page.getByRole("button", { name: /^Sign in with (?:DevSpace Local|devspace)$/i }),
      true,
    ).catch(() => [] as Locator[]);
    if (signInButtons.length > 1) {
      throw new WebLaunchBrowserError(
        `current DevSpace plugin exposed ${signInButtons.length} sign-in controls; expected exactly one`,
      );
    }
    if (signInButtons.length === 1) {
      await completeDevSpaceJitAuthorization(page, {
        deviceProofProvider: options.deviceProofProvider,
        devSpacePublicBaseUrl: options.devSpacePublicBaseUrl,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
      });

      const immediatelyConnected = await findConnectedPluginPage();
      if (immediatelyConnected) return immediatelyConnected;

      if (
        !page.isClosed() &&
        pluginId &&
        new URL(page.url()).hostname === "chatshare.xyz"
      ) {
        if (devSpacePluginIdFromUrl(page.url()) === pluginId) {
          await page
            .reload({
              waitUntil: "domcontentloaded",
              timeout: Math.min(10_000, Math.max(1_000, deadline - Date.now())),
            })
            .catch(() => undefined);
          await assertAuthenticated(page);
        }

        const reloadedConnected = await findConnectedPluginPage();
        if (reloadedConnected) return reloadedConnected;

        await ensureChatSharePluginSettingsSurface(
          page,
          Math.min(5_000, Math.max(500, deadline - Date.now())),
          { uiOnly: true },
        );
        await openChatSharePluginDetail(
          page,
          pluginId,
          Math.min(5_000, Math.max(500, deadline - Date.now())),
        );

        const reopenedConnected = await findConnectedPluginPage();
        if (reopenedConnected) return reopenedConnected;
      }

      const connectedDeadline = Date.now() + Math.min(
        5_000,
        Math.max(500, deadline - Date.now()),
      );
      while (Date.now() < connectedDeadline) {
        const finalPage = await findConnectedPluginPage();
        if (finalPage) return finalPage;
        await page.waitForTimeout(150).catch(() => undefined);
      }
    }

    if (!connectionActionClicked) {
      const directConnectButtons = await credibleLocators(
        page.getByRole("button", { name: /^Connect$/i }),
        true,
      ).catch(() => [] as Locator[]);
      if (directConnectButtons.length > 1) {
        throw new WebLaunchBrowserError(
          `current DevSpace plugin exposed ${directConnectButtons.length} standalone Connect controls; expected at most one`,
        );
      }
      if (directConnectButtons.length === 1) {
        if (!(await clickLocatorRobustly(directConnectButtons[0]!, 5_000))) {
          throw new WebLaunchBrowserError(
            "current DevSpace plugin standalone Connect control could not be activated",
          );
        }
        openedConnection = true;
        connectionActionClicked = true;
        await page.waitForTimeout(250).catch(() => undefined);
        continue;
      }
    }

    if (!openedConnection) {
      const connectionControls: Locator[] = [];
      for (const control of await page
        .locator('button, [role="button"]')
        .all()
        .catch(() => [] as Locator[])) {
        if (!(await control.isVisible().catch(() => false))) continue;
        if (!(await control.isEnabled().catch(() => false))) continue;
        const label = await control
          .evaluate((element) =>
            [
              element.getAttribute("aria-label") ?? "",
              element.getAttribute("title") ?? "",
              element.textContent ?? "",
            ]
              .join(" ")
              .replace(/\s+/g, " ")
              .trim(),
          )
          .catch(() => "");
        if (/Connection\s*Connect/i.test(label)) {
          connectionControls.push(control);
        }
      }

      if (connectionControls.length > 1) {
        throw new WebLaunchBrowserError(
          `current DevSpace plugin exposed ${connectionControls.length} Connection/Connect controls; expected at most one`,
        );
      }
      if (connectionControls.length === 1) {
        if (!(await clickLocatorRobustly(connectionControls[0]!, 5_000))) {
          throw new WebLaunchBrowserError(
            "current DevSpace plugin Connection/Connect control could not be activated",
          );
        }
        openedConnection = true;
        await page.waitForTimeout(250).catch(() => undefined);
        continue;
      }
    }

    await page.waitForTimeout(150).catch(() => undefined);
  }

  throw new WebLaunchBrowserError(
    "current DevSpace plugin has the expected schema but did not expose a usable reconnect flow",
  );
}

function isChatShareCarListSurface(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname === "chatshare.xyz" &&
      url.pathname.startsWith("/pastel") &&
      /(?:^|\/)carlist(?:$|[/?])/i.test(url.hash.replace(/^#/, ""))
    );
  } catch {
    return false;
  }
}

async function refreshChatShareConversationAfterPluginRecovery(
  conversationPage: Page,
  expectedConversationIdentity: string,
  timeoutMs: number,
  options: {
    devSpacePublicBaseUrl?: string;
    deviceProofProvider: DeviceProofProvider;
  },
): Promise<void> {
  await conversationPage.reload({
    waitUntil: "domcontentloaded",
    timeout: Math.min(30_000, Math.max(5_000, timeoutMs)),
  });
  await assertAuthenticated(conversationPage);

  const reloadedIdentity = chatConversationIdentityFromUrl(conversationPage.url());
  if (reloadedIdentity !== expectedConversationIdentity) {
    throw new WebLaunchBrowserError(
      "DevSpace recovery reload did not preserve the original conversation identity",
    );
  }

  const composerDeadline = Date.now() + Math.min(8_000, Math.max(1_000, timeoutMs));
  let composers: Locator[] = [];
  while (Date.now() < composerDeadline) {
    composers = await rankedComposerLocators(conversationPage).catch(() => [] as Locator[]);
    if (composers.length === 1) break;
    if (composers.length > 1) {
      throw new WebLaunchBrowserError(
        `DevSpace recovery reload exposed ${composers.length} composers; expected exactly one`,
      );
    }
    await conversationPage.waitForTimeout(100).catch(() => undefined);
  }
  if (composers.length !== 1) {
    throw new WebLaunchBrowserError(
      "DevSpace recovery reload did not restore the original conversation composer",
    );
  }

  const accessPrompts = await conversationPage
    .getByText(/needs access to (?:DevSpace Local|devspace)/i)
    .all()
    .catch(() => [] as Locator[]);
  if (await anyLocatorVisible(accessPrompts)) {
    await activateDevSpaceForConversation(
      conversationPage,
      Math.min(8_000, Math.max(1_000, timeoutMs)),
      {
        deviceProofProvider: options.deviceProofProvider,
        devSpacePublicBaseUrl: options.devSpacePublicBaseUrl,
      },
    );
  }
}

export async function ensureChatShareDevSpacePluginConnectedForRecovery(
  conversationPage: Page,
  options: {
    devSpacePublicBaseUrl?: string;
    deviceProofProvider?: DeviceProofProvider;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  if (conversationPage.isClosed()) {
    throw new WebLaunchBrowserError(
      "cannot recover DevSpace plugin for a closed conversation",
    );
  }

  let conversationUrl: URL;
  try {
    conversationUrl = new URL(conversationPage.url());
  } catch {
    throw new WebLaunchBrowserError(
      "cannot recover DevSpace plugin from an invalid conversation URL",
    );
  }
  if (conversationUrl.hostname !== "chatshare.xyz") return;
  const conversationIdentity = chatConversationIdentityFromUrl(conversationPage.url());
  if (!conversationIdentity) {
    throw new WebLaunchBrowserError(
      "cannot recover DevSpace plugin without a durable conversation identity",
    );
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const preserveNativeRecoveryIntent =
    await hasDevSpaceNativeRecoveryControl(conversationPage);
  const deviceProofProvider =
    options.deviceProofProvider ?? requestLocalDeviceProof;
  const context = conversationPage.context();
  const pagesBeforeRecovery = new Set(context.pages());
  const recoveryPage = await context.newPage();
  let pluginConnectionChanged = false;

  try {
    await recoveryPage.goto(CHATSHARE_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(30_000, Math.max(5_000, timeoutMs)),
    });
    await assertAuthenticated(recoveryPage);
    if (isChatShareCarListSurface(recoveryPage.url())) {
      await prepareChatShareSession(
        recoveryPage,
        Math.min(8_000, Math.max(1_000, timeoutMs)),
      );
      await assertAuthenticated(recoveryPage);
    }
    await ensureChatSharePluginSettingsSurface(
      recoveryPage,
      Math.min(8_000, timeoutMs),
      { uiOnly: true },
    );

    const pluginIds = await resolveDevSpacePluginIds(
      recoveryPage,
      Math.min(8_000, timeoutMs),
    );
    let currentPluginFound = false;

    for (const pluginId of pluginIds) {
      await openChatSharePluginDetail(
        recoveryPage,
        pluginId,
        Math.min(8_000, timeoutMs),
      );
      if (
        !(await devSpacePluginHasCurrentSchema(
          recoveryPage,
          Math.min(4_000, timeoutMs),
        ))
      ) {
        continue;
      }

      currentPluginFound = true;
      let connectedPage = recoveryPage;
      if (
        !(await devSpacePluginIsEnabledAndCurrent(
          recoveryPage,
          Math.min(2_000, timeoutMs),
        ))
      ) {
        connectedPage = await reconnectCurrentDevSpacePlugin(recoveryPage, {
          devSpacePublicBaseUrl: options.devSpacePublicBaseUrl,
          deviceProofProvider,
          timeoutMs,
        });
        pluginConnectionChanged = true;
      }

      if (
        !(await devSpacePluginIsEnabledAndCurrent(
          connectedPage,
          Math.min(5_000, timeoutMs),
        ))
      ) {
        throw new WebLaunchBrowserError(
          "DevSpace plugin recovery did not restore a connected current plugin",
        );
      }
      await dismissPluginSettingsDialogIfPresent(connectedPage);
      break;
    }

    if (!currentPluginFound) {
      pluginConnectionChanged = true;
      const refreshedPage = await refreshDevSpacePluginRegistration(recoveryPage, {
        devSpacePublicBaseUrl: options.devSpacePublicBaseUrl,
        deviceProofProvider,
        timeoutMs,
      });
      if (
        !(await devSpacePluginIsEnabledAndCurrent(
          refreshedPage,
          Math.min(5_000, timeoutMs),
        ))
      ) {
        throw new WebLaunchBrowserError(
          "DevSpace plugin recovery registration did not reach a connected current plugin",
        );
      }
      await dismissPluginSettingsDialogIfPresent(refreshedPage);
    }

    if (pluginConnectionChanged && !preserveNativeRecoveryIntent) {
      await refreshChatShareConversationAfterPluginRecovery(
        conversationPage,
        conversationIdentity,
        timeoutMs,
        {
          devSpacePublicBaseUrl: options.devSpacePublicBaseUrl,
          deviceProofProvider,
        },
      );
    }
  } finally {
    for (const candidate of context.pages()) {
      if (candidate === conversationPage) continue;
      if (pagesBeforeRecovery.has(candidate)) continue;
      await candidate.close().catch(() => undefined);
    }
    await conversationPage.bringToFront().catch(() => undefined);
  }
}

export async function refreshDevSpacePluginRegistration(
  page: Page,
  options: {
    devSpacePublicBaseUrl?: string;
    deviceProofProvider?: DeviceProofProvider;
    timeoutMs?: number;
  } = {},
): Promise<Page> {
  const publicBaseUrl = options.devSpacePublicBaseUrl?.trim();
  if (!publicBaseUrl) {
    throw new WebLaunchBrowserError(
      "DevSpace plugin refresh requires DEVSPACE_PUBLIC_BASE_URL",
    );
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const mcpUrl = new URL("/mcp", publicBaseUrl).toString();
  const context = page.context();
  const chatBaseUrl = chatSurfaceBaseUrl(page.url());

  if (chatBaseUrl.hostname === "chatshare.xyz") {
    await ensureChatShareDeveloperModeEnabled(page, timeoutMs);
    await ensureChatSharePluginSettingsSurface(page, timeoutMs);
  } else {
    await page.goto(chatPluginsSettingsUrl(chatBaseUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await assertAuthenticated(page);
    await page.waitForTimeout(500).catch(() => undefined);
  }
  if (
    chatBaseUrl.hostname === "chatshare.xyz" &&
    !(await chatSharePluginSettingsSurfaceStable(page))
  ) {
    await ensureChatSharePluginSettingsSurface(page, timeoutMs);
  }

  const controlLabel = async (control: Locator): Promise<string> =>
    control
      .evaluate((element) =>
        [
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("title") ?? "",
          element.getAttribute("data-testid") ?? "",
          element.textContent ?? "",
        ]
          .map((value) => value.replace(/\s+/g, " ").trim())
          .find((value) => value.length > 0) ?? "",
      )
      .catch(() => "");

  const addPluginPattern =
    /^(?:\+|Add (?:a )?plugin|New plugin|Create plugin|新增(?:外掛程式|插件)|添加(?:外掛程式|插件)|新建插件|建立插件|创建插件)$/i;
  const browsePluginsPattern =
    /^(?:Browse plugins|Explore plugins|Plugin store|瀏覽(?:外掛程式|插件)|浏览(?:插件|插件程序)|外掛程式商店|插件商店)$/i;
  const searchPluginsPattern =
    /(?:Search plugins|搜尋(?:外掛程式|插件)|搜索(?:插件|插件程序))/i;

  const findAddPluginControls = async (): Promise<Locator[]> => {
    if (
      chatBaseUrl.hostname === "chatshare.xyz" &&
      !(await chatSharePluginSettingsSurfaceReady(page)) &&
      !isPluginStorePath(page)
    ) {
      return [];
    }

    const addButtons: Locator[] = [];
    for (const control of await page
      .locator('button, a, [role="button"], [role="menuitem"]')
      .all()
      .catch(() => [] as Locator[])) {
      if (!(await control.isVisible().catch(() => false))) continue;
      if (!(await control.isEnabled().catch(() => false))) continue;
      if (addPluginPattern.test(await controlLabel(control))) addButtons.push(control);
    }

    if (addButtons.length === 0) {
      const searchCandidates = await page
        .locator(
          'input[type="search"], [role="searchbox"], input[placeholder*="plugin" i], input[placeholder*="插件"], input[placeholder*="外掛"], input[placeholder*="外挂"]',
        )
        .all()
        .catch(() => [] as Locator[]);
      const searchBoxes: Locator[] = [];
      for (const search of searchCandidates) {
        if (!(await search.isVisible().catch(() => false))) continue;
        if (!(await search.isEnabled().catch(() => false))) continue;
        const descriptor = await search
          .evaluate((element) =>
            [
              element.getAttribute("aria-label") ?? "",
              element.getAttribute("placeholder") ?? "",
              element.getAttribute("title") ?? "",
            ]
              .join(" ")
              .replace(/\s+/g, " ")
              .trim(),
          )
          .catch(() => "");
        if (
          searchPluginsPattern.test(descriptor) ||
          (chatBaseUrl.hostname !== "chatshare.xyz" && searchCandidates.length === 1)
        ) {
          searchBoxes.push(search);
        }
      }

      if (searchBoxes.length === 1) {
        const parent = searchBoxes[0]!.locator("xpath=..");
        const nearbyButtons = await visibleLocators(
          parent.locator('button, [role="button"]'),
          true,
        ).catch(() => [] as Locator[]);
        const unlabeledNearby: Locator[] = [];
        for (const button of nearbyButtons) {
          const label = await controlLabel(button);
          if (addPluginPattern.test(label)) addButtons.push(button);
          else if (label === "" || /^button$/i.test(label)) unlabeledNearby.push(button);
        }
        if (addButtons.length === 0 && unlabeledNearby.length === 1) {
          addButtons.push(unlabeledNearby[0]!);
        }

        if (addButtons.length === 0) {
          const adjacent = searchBoxes[0]!.locator("xpath=following::button[1]");
          if (
            (await adjacent.count()) === 1 &&
            (await adjacent.isVisible().catch(() => false)) &&
            (await adjacent.isEnabled().catch(() => false))
          ) {
            addButtons.push(adjacent);
          }
        }
      }
    }
    return addButtons;
  };

  const findNewPluginDialog = async (): Promise<Locator | undefined> => {
    const dialogs = await visibleLocators(
      page.locator('[role="dialog"], [aria-modal="true"]'),
    ).catch(() => [] as Locator[]);
    for (const dialog of dialogs) {
      const text = await dialog.innerText().catch(() => "");
      if (/(?:\bNew Plugin\b|新增插件|新建插件|建立插件|创建插件)/i.test(text)) {
        return dialog;
      }
    }
    return undefined;
  };

  const waitForNewPluginDialog = async (
    waitMs: number,
  ): Promise<Locator | undefined> => {
    const deadline = Date.now() + Math.max(100, waitMs);
    while (Date.now() < deadline) {
      const dialog = await findNewPluginDialog();
      if (dialog) return dialog;
      await page.waitForTimeout(100).catch(() => undefined);
    }
    return findNewPluginDialog();
  };

  const collectBrowseControls = async (): Promise<Locator[]> => {
    const controls: Locator[] = [];
    for (const control of await page
      .locator('button, a, [role="button"], [role="menuitem"]')
      .all()
      .catch(() => [] as Locator[])) {
      if (!(await control.isVisible().catch(() => false))) continue;
      if (!(await control.isEnabled().catch(() => false))) continue;
      if (browsePluginsPattern.test(await controlLabel(control))) controls.push(control);
    }
    return controls;
  };

  let openedDirectCreateRoute = false;
  let newPluginDialog: Locator | undefined;
  const openDialogDeadline = Date.now() + timeoutMs;

  while (Date.now() < openDialogDeadline && !newPluginDialog) {
    if (chatBaseUrl.hostname === "chatshare.xyz" && !isPluginStorePath(page)) {
      await ensureChatSharePluginSettingsSurface(
        page,
        Math.min(5_000, Math.max(500, openDialogDeadline - Date.now())),
      );
      if (!(await chatSharePluginSettingsSurfaceStable(page))) {
        await page.waitForTimeout(100).catch(() => undefined);
        continue;
      }
    }

    let addButtons = await findAddPluginControls();

    if (addButtons.length === 0) {
      const browseControls = await collectBrowseControls();
      for (const browseControl of browseControls) {
        if (!(await browseControl.isVisible().catch(() => false))) continue;
        if (!(await browseControl.isEnabled().catch(() => false))) continue;
        if (!(await clickLocatorRobustly(browseControl, 2_500))) continue;

        const browseDeadline = Date.now() + Math.min(
          1_500,
          Math.max(100, openDialogDeadline - Date.now()),
        );
        while (Date.now() < browseDeadline) {
          if (
            chatBaseUrl.hostname === "chatshare.xyz" &&
            !(await chatSharePluginSettingsSurfaceReady(page)) &&
            !isPluginStorePath(page)
          ) {
            break;
          }
          addButtons = await findAddPluginControls();
          if (addButtons.length > 0) break;
          await page.waitForTimeout(100).catch(() => undefined);
        }
        if (addButtons.length > 0) break;
      }
    }

    if (addButtons.length > 1) {
      const visibleControls = await page
        .locator('button, a, [role="button"], [role="menuitem"], input')
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0
              );
            })
            .slice(0, 40)
            .map((element) => ({
              tag: element.tagName,
              text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
              aria: element.getAttribute("aria-label"),
              title: element.getAttribute("title"),
              placeholder: element.getAttribute("placeholder"),
              testid: element.getAttribute("data-testid"),
              href: element instanceof HTMLAnchorElement ? element.getAttribute("href") : null,
            })),
        )
        .catch(() => [] as unknown[]);
      throw new WebLaunchBrowserError(
        `DevSpace plugin refresh found ${addButtons.length} add-plugin controls; expected at most one; url=${page.url()}; controls=${JSON.stringify(visibleControls)}`,
      );
    }

    if (addButtons.length === 1) {
      if (!(await clickLocatorRobustly(addButtons[0]!, 2_500))) {
        await page.waitForTimeout(100).catch(() => undefined);
        continue;
      }
      newPluginDialog = await waitForNewPluginDialog(
        Math.min(1_500, Math.max(100, openDialogDeadline - Date.now())),
      );
      if (newPluginDialog) break;

      if (chatBaseUrl.hostname === "chatshare.xyz") {
        await page.waitForTimeout(100).catch(() => undefined);
        continue;
      }
    } else if (chatBaseUrl.hostname !== "chatshare.xyz" && !openedDirectCreateRoute) {
      const createConnectorUrl = chatPluginCreateConnectorUrl(chatBaseUrl);
      await page.goto(createConnectorUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await assertAuthenticated(page);
      openedDirectCreateRoute = true;
      await page.waitForTimeout(500).catch(() => undefined);
      newPluginDialog = await waitForNewPluginDialog(
        Math.min(1_500, Math.max(100, openDialogDeadline - Date.now())),
      );
      if (newPluginDialog) break;
    }

    await page.waitForTimeout(100).catch(() => undefined);
  }

  if (!newPluginDialog) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    throw new WebLaunchBrowserError(
      `DevSpace plugin refresh did not open the New Plugin dialog after retrying the Plugins surface; directCreate=${openedDirectCreateRoute}; url=${page.url()}; body=${bodyText.slice(0, 1200)}`,
    );
  }

  let nameInputs = await visibleLocators(
    newPluginDialog.getByRole("textbox", { name: /^Name$/i }),
    true,
  ).catch(() => [] as Locator[]);
  const textInputs = await visibleLocators(
    newPluginDialog.locator('input:not([type="checkbox"]):not([type="radio"])'),
    true,
  ).catch(() => [] as Locator[]);
  if (nameInputs.length === 0 && textInputs.length >= 1) nameInputs = [textInputs[0]!];
  if (nameInputs.length !== 1) {
    throw new WebLaunchBrowserError(
      `DevSpace plugin refresh found ${nameInputs.length} Name inputs; expected exactly one`,
    );
  }
  await nameInputs[0]!.fill("devspace");

  let serverInputs = await visibleLocators(
    newPluginDialog.getByRole("textbox", { name: /Server URL/i }),
    true,
  ).catch(() => [] as Locator[]);
  if (serverInputs.length === 0) {
    serverInputs = await visibleLocators(
      newPluginDialog.locator('input[type="url"]'),
      true,
    ).catch(() => [] as Locator[]);
  }
  if (serverInputs.length === 0 && textInputs.length >= 2) serverInputs = [textInputs[1]!];
  if (serverInputs.length !== 1) {
    throw new WebLaunchBrowserError(
      `DevSpace plugin refresh found ${serverInputs.length} Server URL inputs; expected exactly one`,
    );
  }
  await serverInputs[0]!.fill(mcpUrl);

  const oauthVisible = await anyLocatorVisible(
    await newPluginDialog.getByText(/^OAuth$/i).all().catch(() => [] as Locator[]),
  );
  if (!oauthVisible) {
    throw new WebLaunchBrowserError("DevSpace plugin refresh expected OAuth authentication");
  }

  const riskCheckboxes = await visibleLocators(
    newPluginDialog.getByRole("checkbox"),
    true,
  ).catch(() => [] as Locator[]);
  if (riskCheckboxes.length !== 1) {
    throw new WebLaunchBrowserError(
      `DevSpace plugin refresh found ${riskCheckboxes.length} risk acknowledgement checkboxes; expected exactly one`,
    );
  }
  if (!(await riskCheckboxes[0]!.isChecked().catch(() => false))) {
    if (!(await clickLocatorRobustly(riskCheckboxes[0]!, 5_000))) {
      throw new WebLaunchBrowserError("DevSpace plugin refresh could not acknowledge connector risk");
    }
  }

  const createButtons = await credibleLocators(
    newPluginDialog.getByRole("button", { name: "Create", exact: true }),
    true,
  ).catch(() => [] as Locator[]);
  if (createButtons.length !== 1) {
    throw new WebLaunchBrowserError(
      `DevSpace plugin refresh found ${createButtons.length} Create buttons; expected exactly one`,
    );
  }
  if (!(await clickLocatorRobustly(createButtons[0]!, 5_000))) {
    throw new WebLaunchBrowserError("DevSpace plugin refresh could not activate Create");
  }

  const signInDeadline = Date.now() + timeoutMs;
  let signInControl: Locator | undefined;
  while (Date.now() < signInDeadline) {
    const buttonCandidates = await credibleLocators(
      page.getByRole("button", { name: /^Sign in with devspace/i }),
      true,
    ).catch(() => [] as Locator[]);
    const linkCandidates = await visibleLocators(
      page.getByRole("link", { name: /^Sign in with devspace/i }),
      true,
    ).catch(() => [] as Locator[]);
    const candidates = [...buttonCandidates, ...linkCandidates];
    if (candidates.length === 1) {
      signInControl = candidates[0];
      break;
    }
    if (candidates.length > 1) {
      throw new WebLaunchBrowserError(
        `DevSpace plugin refresh found ${candidates.length} sign-in controls; expected exactly one`,
      );
    }
    await page.waitForTimeout(100);
  }
  if (!signInControl) {
    throw new WebLaunchBrowserError("DevSpace plugin refresh did not expose Sign in with devspace");
  }

  const pagesBeforeSignIn = new Set(context.pages());
  if (!(await clickLocatorRobustly(signInControl, 5_000))) {
    throw new WebLaunchBrowserError("DevSpace plugin refresh could not activate Sign in with devspace");
  }
  await completeDevSpaceJitAuthorization(page, {
    deviceProofProvider: options.deviceProofProvider ?? requestLocalDeviceProof,
    devSpacePublicBaseUrl: publicBaseUrl,
    signInAlreadyClicked: true,
    timeoutMs,
  });

  const finalDeadline = Date.now() + timeoutMs;
  let finalPluginPage: Page | undefined;
  let finalCandidateUrls: string[] = [];
  while (Date.now() < finalDeadline) {
    finalCandidateUrls = context.pages().map((candidate) => candidate.url());
    const candidates = context.pages().filter((candidate) => {
      if (candidate.isClosed()) return false;
      try {
        const url = new URL(candidate.url());
        return (
          CHAT_SURFACE_HOSTS.has(url.hostname) &&
          devSpacePluginIdFromUrl(url.href) !== undefined
        );
      } catch {
        return false;
      }
    });
    const newlyOpened = candidates.filter((candidate) => !pagesBeforeSignIn.has(candidate));
    const pool = newlyOpened.length > 0 ? newlyOpened : candidates;
    for (const candidate of pool) {
      if (DEVSPACE_PLUGIN_DISPLAY_PATTERN.test(await candidate.locator("body").innerText().catch(() => ""))) {
        finalPluginPage = candidate;
        break;
      }
    }
    if (finalPluginPage) break;
    await page.waitForTimeout(150).catch(() => undefined);
  }
  if (!finalPluginPage) {
    throw new WebLaunchBrowserError(
      `DevSpace plugin refresh did not reach the final plugin detail page; pages=${JSON.stringify(finalCandidateUrls)}`,
    );
  }

  if (finalPluginPage !== page && !page.isClosed()) {
    await page.close().catch(() => undefined);
  }
  await dismissPluginSettingsDialogIfPresent(finalPluginPage);
  return finalPluginPage;
}

async function chatShareSettingsOverlayVisible(page: Page): Promise<boolean> {
  const searches = await visibleLocators(
    page.locator(
      'input[placeholder*="Search settings" i], input[placeholder*="搜尋設定"], input[placeholder*="搜索设置"], input[placeholder*="搜尋設置"], input[placeholder*="搜索設定"]',
    ),
  ).catch(() => [] as Locator[]);
  if (searches.length > 0) return true;

  const dialogs = await visibleLocators(
    page.locator('[role="dialog"], [aria-modal="true"]'),
  ).catch(() => [] as Locator[]);
  for (const dialog of dialogs) {
    const text = await dialog.innerText().catch(() => "");
    if (
      /(?:Plugins|外掛程式|插件)/i.test(text) &&
      /(?:Connection|Actions|連線|连接|動作|操作|devspace)/i.test(text)
    ) {
      return true;
    }
  }
  return false;
}

async function dismissPluginSettingsDialogIfPresent(page: Page): Promise<void> {
  if (!(await chatShareSettingsOverlayVisible(page))) return;

  const safeBackgroundPoint = await page
    .evaluate(() => {
      const margin = 28;
      const points = [
        { x: margin, y: margin },
        { x: window.innerWidth - margin, y: margin },
        { x: margin, y: window.innerHeight - margin },
        { x: window.innerWidth - margin, y: window.innerHeight - margin },
        { x: window.innerWidth / 2, y: margin },
        { x: window.innerWidth / 2, y: window.innerHeight - margin },
      ];
      for (const point of points) {
        const element = document.elementFromPoint(point.x, point.y);
        if (!(element instanceof HTMLElement)) continue;
        if (
          element.closest(
            'button, a, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]',
          )
        ) {
          continue;
        }
        return point;
      }
      return undefined;
    })
    .catch(() => undefined);

  if (safeBackgroundPoint) {
    await page.mouse
      .click(safeBackgroundPoint.x, safeBackgroundPoint.y)
      .catch(() => undefined);
    const backgroundDeadline = Date.now() + 2_000;
    while (Date.now() < backgroundDeadline) {
      if (!(await chatShareSettingsOverlayVisible(page))) return;
      await page.waitForTimeout(100).catch(() => undefined);
    }
  }

  const closeCandidates = await credibleLocators(
    page.getByRole("button", {
      name: /^(?:Close|×|X|關閉|关闭)$/i,
    }),
    true,
  ).catch(() => [] as Locator[]);
  if (closeCandidates.length === 1) {
    await closeCandidates[0]!.click({ timeout: 5_000 }).catch(() => undefined);
    const closeDeadline = Date.now() + 2_000;
    while (Date.now() < closeDeadline) {
      if (!(await chatShareSettingsOverlayVisible(page))) return;
      await page.waitForTimeout(100).catch(() => undefined);
    }
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  throw new WebLaunchBrowserError(
    `ChatShare plugin settings overlay remained visible after UI background dismissal; url=${page.url()}; body=${bodyText.slice(0, 1600)}`,
  );
}

async function dismissWorkOnboardingIfPresent(
  page: Page,
  timeoutMs = 4_000,
): Promise<void> {
  const modal = page.locator('[data-testid="modal-tpp-upsell-nux"]');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await modal.isVisible().catch(() => false)) {
      const closeButtons = await credibleLocators(
        modal.getByRole("button", { name: "Close", exact: true }),
        true,
      );
      if (closeButtons.length !== 1) {
        throw new WebLaunchBrowserError(
          `ChatGPT Work onboarding exposed ${closeButtons.length} enabled Close buttons; expected exactly one`,
        );
      }

      await closeButtons[0]!.click({ timeout: 5_000 });
      const dismissalDeadline = Date.now() + 3_000;
      while (Date.now() < dismissalDeadline) {
        if (!(await modal.isVisible().catch(() => false))) return;
        await page.waitForTimeout(100);
      }
      throw new WebLaunchBrowserError("ChatGPT Work onboarding remained visible after Close");
    }
    await page.waitForTimeout(100);
  }
}

type DevSpaceSelectionState = {
  totalCount: number;
  inlineCount: number;
  labels: string[];
};

async function readDevSpaceSelectionState(
  composer: Locator,
  expectedPluginId?: string,
): Promise<DevSpaceSelectionState> {
  const explicitSelector = [
    "[data-inline-selection-pill]",
    '[data-system-hint-type^="plugin:"]',
    "[data-plugin-id]",
    "[data-connector-id]",
  ].join(",");
  const selectedSelector = [
    '[aria-pressed="true"]',
    '[aria-selected="true"]',
    '[data-selected="true"]',
    '[data-state="active"]',
    '[data-state="on"]',
    '[data-state="checked"]',
  ].join(",");
  const selector = `${explicitSelector},${selectedSelector}`;

  const inspectCandidate = async (
    candidate: Locator,
  ): Promise<{ matches: boolean; label: string }> =>
    candidate
      .evaluate((element, pluginId) => {
        if (!(element instanceof HTMLElement)) {
          return { matches: false, label: "" };
        }

        const hint = element.getAttribute("data-system-hint-type") ?? "";
        const candidatePluginId =
          element.getAttribute("data-plugin-id") ??
          element.getAttribute("data-connector-id") ??
          "";
        const label = [
          element.getAttribute("data-keyword") ?? "",
          element.getAttribute("aria-label") ?? "",
          hint,
          candidatePluginId,
          element.getAttribute("data-testid") ?? "",
          element.getAttribute("title") ?? "",
          element.textContent ?? "",
        ]
          .join(" | ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        const identityMatch =
          Boolean(pluginId) &&
          (hint === `plugin:${pluginId}` || candidatePluginId === pluginId);
        return {
          matches: identityMatch || /devspace/i.test(label),
          label,
        };
      }, expectedPluginId)
      .catch(() => ({ matches: false, label: "" }));

  const pageMatches: Array<{ locator: Locator; label: string }> = [];
  for (const candidate of await composer
    .page()
    .locator(selector)
    .all()
    .catch(() => [] as Locator[])) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const inspected = await inspectCandidate(candidate);
    if (!inspected.matches) continue;
    pageMatches.push({ locator: candidate, label: inspected.label });
  }

  const inlineCandidates = await composer
    .locator(explicitSelector)
    .all()
    .catch(() => [] as Locator[]);
  let inlineCount = 0;
  for (const candidate of inlineCandidates) {
    const inspected = await inspectCandidate(candidate);
    if (inspected.matches) inlineCount += 1;
  }

  return {
    totalCount: pageMatches.length,
    inlineCount,
    labels: pageMatches.slice(0, 4).map((candidate) => candidate.label),
  };
}

async function assertDevSpaceSelection(
  composer: Locator,
  timeoutMs = 5_000,
  expectedPluginId?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: DevSpaceSelectionState = {
    totalCount: 0,
    inlineCount: 0,
    labels: [],
  };
  while (Date.now() < deadline) {
    lastState = await readDevSpaceSelectionState(composer, expectedPluginId).catch(
      () => ({ totalCount: 0, inlineCount: 0, labels: [] }),
    );
    if (lastState.totalCount === 1) return;
    if (lastState.totalCount > 1) {
      throw new WebLaunchBrowserError(
        `DevSpace composer exposed ${lastState.totalCount} DevSpace selection markers; expected exactly one; labels=${JSON.stringify(lastState.labels)}`,
      );
    }
    await composer.page().waitForTimeout(100).catch(() => undefined);
  }

  const composerHtml = await composer
    .evaluate((element) => element.outerHTML.slice(0, 2400))
    .catch(() => "");
  throw new WebLaunchBrowserError(
    `DevSpace plugin was not selected in the ChatGPT composer after Try in chat; selection=${JSON.stringify(lastState)}; composer=${composerHtml}`,
  );
}

async function selectEditableTailAfterDevSpacePill(composer: Locator): Promise<boolean> {
  return composer.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("connected composer is not an HTMLElement");
    }

    const candidates = Array.from(
      element.querySelectorAll<HTMLElement>(
        [
          "[data-inline-selection-pill]",
          '[data-system-hint-type^="plugin:"]',
          "[data-plugin-id]",
          "[data-connector-id]",
        ].join(","),
      ),
    );
    const pills = candidates.filter((candidate) => {
      const label = [
        candidate.getAttribute("data-keyword") ?? "",
        candidate.getAttribute("aria-label") ?? "",
        candidate.getAttribute("title") ?? "",
        candidate.textContent ?? "",
      ]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return /devspace/i.test(label);
    });

    if (pills.length === 0) return false;
    if (pills.length !== 1) {
      throw new Error(`expected one inline DevSpace selection marker, found ${pills.length}`);
    }

    const pill = pills[0]!;
    const selection = window.getSelection();
    if (!selection) throw new Error("window selection is unavailable");

    const range = document.createRange();
    range.setStartAfter(pill);
    range.setEnd(element, element.childNodes.length);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  });
}

async function readConnectedPromptText(composer: Locator): Promise<string> {
  return composer.evaluate((element) => {
    if (!(element instanceof HTMLElement)) return element.textContent ?? "";

    const clone = element.cloneNode(true) as HTMLElement;
    for (const fixed of clone.querySelectorAll('[contenteditable="false"]')) {
      fixed.remove();
    }
    for (const lineBreak of clone.querySelectorAll("br")) {
      lineBreak.replaceWith(document.createTextNode("\n"));
    }

    const blockTags = new Set([
      "ADDRESS",
      "ARTICLE",
      "BLOCKQUOTE",
      "DIV",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
      "P",
      "PRE",
      "SECTION",
    ]);
    const children = Array.from(clone.childNodes);
    let result = "";
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      const isBlock = child instanceof HTMLElement && blockTags.has(child.tagName);
      if (isBlock && index > 0 && !result.endsWith("\n")) result += "\n";
      result += child.textContent ?? "";
      const next = children[index + 1];
      const nextIsBlock = next instanceof HTMLElement && blockTags.has(next.tagName);
      if (isBlock && next && !nextIsBlock && !result.endsWith("\n")) result += "\n";
    }
    return result;
  });
}

export async function activateDevSpaceForConversation(
  page: Page,
  timeoutMs = 8_000,
  options: {
    deviceProofProvider?: DeviceProofProvider;
    devSpacePublicBaseUrl?: string;
  } = {},
): Promise<void> {
  const accessPrompt = page.getByText(/needs access to (?:DevSpace Local|devspace)/i);
  const accessDeadline = Date.now() + timeoutMs;

  while (Date.now() < accessDeadline) {
    const promptCandidates = await accessPrompt.all().catch(() => [] as Locator[]);
    if (!(await anyLocatorVisible(promptCandidates))) {
      await page.waitForTimeout(150);
      continue;
    }

    const connectButtons = await credibleLocators(
      page.getByRole("button", { name: "Connect", exact: true }),
      true,
    );
    if (connectButtons.length !== 1) {
      throw new WebLaunchBrowserError(
        `DevSpace conversation activation found ${connectButtons.length} enabled Connect buttons; expected exactly one`,
      );
    }

    await connectButtons[0]!.click({ timeout: 5_000 });
    await completeDevSpaceJitAuthorization(page, {
      deviceProofProvider: options.deviceProofProvider ?? requestLocalDeviceProof,
      devSpacePublicBaseUrl: options.devSpacePublicBaseUrl,
    });
    return;
  }

  // Already-authorized conversations never render the access prompt.
}

export async function hasDeliveryTimeoutMessage(page: Page): Promise<boolean> {
  const candidates = await page.getByText(DELIVERY_TIMEOUT_PATTERN).all().catch(() => [] as Locator[]);
  return anyLocatorVisible(candidates);
}

async function hasVisibleTextPattern(page: Page, pattern: RegExp): Promise<boolean> {
  const candidates = await page.getByText(pattern).all().catch(() => [] as Locator[]);
  return anyLocatorVisible(candidates);
}

export async function detectDevSpaceRecoverySignal(
  page: Page,
): Promise<DevSpaceRecoverySignal> {
  if (page.isClosed()) return "none";
  if (await hasVisibleTextPattern(page, DEVSPACE_TERMINAL_CAPACITY_PATTERN)) {
    return "terminal_capacity";
  }
  if (await hasVisibleTextPattern(page, DEVSPACE_TERMINAL_CONTEXT_PATTERN)) {
    return "terminal_context";
  }
  if (await hasDeliveryTimeoutMessage(page)) return "retryable_interruption";
  if (await hasVisibleTextPattern(page, DEVSPACE_INTERRUPTED_PATTERN)) {
    return "retryable_interruption";
  }
  if (await hasVisibleTextPattern(page, DEVSPACE_TRANSIENT_GATEWAY_PATTERN)) {
    return "transient_gateway";
  }
  if (await hasVisibleTextPattern(page, DEVSPACE_GENERIC_ERROR_PATTERN)) {
    return "generic_error";
  }
  return "none";
}

export async function hasDevSpaceInterruptionMessage(page: Page): Promise<boolean> {
  return (await detectDevSpaceRecoverySignal(page)) === "retryable_interruption";
}

export async function isDevSpaceSilentStallCandidate(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  const stopControls = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
    () => [] as Locator[],
  );
  if (stopControls.length > 0) return false;

  const markers = await page.getByText(DEVSPACE_TOOL_RESPONSE_PATTERN).all().catch(() => [] as Locator[]);
  const visibleMarkers: Locator[] = [];
  for (const marker of markers) {
    if (!(await marker.isVisible().catch(() => false))) continue;
    const markerText = (await marker.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (DEVSPACE_TOOL_RESPONSE_ONLY_PATTERN.test(markerText)) {
      visibleMarkers.push(marker);
    }
  }
  if (visibleMarkers.length === 0) return false;

  const marker = visibleMarkers[visibleMarkers.length - 1]!;
  return marker
    .evaluate((element) => {
      const main = element.closest("main") ?? document.body;
      const candidates: Element[] = [];
      const turn = element.closest('[data-testid^="conversation-turn"]');
      if (turn) candidates.push(turn);
      const article = element.closest("article");
      if (article && !candidates.includes(article)) candidates.push(article);
      const authorTurn = element.closest("[data-message-author-role]");
      if (authorTurn && !candidates.includes(authorTurn)) candidates.push(authorTurn);

      let container: Element | undefined;
      for (const candidate of candidates) {
        let siblings: Element[] = [];
        if (candidate.matches('[data-testid^="conversation-turn"]')) {
          siblings = Array.from(main.querySelectorAll('[data-testid^="conversation-turn"]'));
        } else if (candidate.matches("article")) {
          siblings = Array.from(main.querySelectorAll("article"));
        } else if (candidate.matches("[data-message-author-role]")) {
          siblings = Array.from(main.querySelectorAll("[data-message-author-role]"));
        }
        if (siblings.length > 0 && siblings[siblings.length - 1] === candidate) {
          container = candidate;
          break;
        }
      }
      if (!container) return false;

      const range = document.createRange();
      range.setStartAfter(element);
      range.setEnd(container, container.childNodes.length);
      const fragment = range.cloneContents();
      for (const removable of Array.from(
        fragment.querySelectorAll(
          'button, [role="button"], svg, script, style, [aria-hidden="true"]',
        ),
      )) {
        removable.remove();
      }
      const tailText = (fragment.textContent ?? "").replace(/\s+/g, " ").trim();

      // Fail closed: any non-control text after the tool-response marker means
      // the assistant may already have produced a final answer in the same turn.
      return tailText.length === 0;
    })
    .catch(() => false);
}

async function readChatShareActivitySignature(page: Page): Promise<string> {
  const main = page.locator("main");
  const text = await main.innerText().catch(() => "");
  const turnCount = await main
    .locator('[data-testid^="conversation-turn"], article, [data-message-author-role]')
    .count()
    .catch(() => 0);
  return `${turnCount}:${text.slice(-12_000)}`;
}

async function hasDevSpaceNativeRecoveryControl(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  const stopControls = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
    () => [] as Locator[],
  );
  if (stopControls.length > 0) return false;

  const recoveryButtons = await credibleLocators(
    page.getByRole("button", { name: DEVSPACE_NATIVE_RECOVERY_BUTTON_PATTERN }),
    true,
  ).catch(() => [] as Locator[]);
  return recoveryButtons.length > 0;
}

async function resumeInterruptedDevSpaceConversationViaComposer(
  page: Page,
  prompt = "resume",
  transitionTimeoutMs = 120_000,
): Promise<boolean> {
  if (page.isClosed()) return false;

  let stopControls = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
    () => [] as Locator[],
  );
  const stoppedActiveTurn = stopControls.length > 0;
  if (stoppedActiveTurn) {
    // UI-first interruption rescue: stop the wedged turn, then wait for the
    // actual UI transition. This is deliberately state-driven rather than a
    // fixed sleep because ChatGPT can take an unpredictable amount of time to
    // replace the square stop control with an idle/send-capable composer.
    await stopControls[stopControls.length - 1]!.click({ timeout: 5_000 });

    const stopCleared = await page
      .waitForFunction(
        (selector) =>
          !Array.from(document.querySelectorAll(selector)).some((element) => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            return (
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              element.getClientRects().length > 0
            );
          }),
        STOP_SELECTOR,
        { timeout: transitionTimeoutMs },
      )
      .then(() => true)
      .catch(() => false);
    if (!stopCleared || page.isClosed()) return false;
  } else {
    stopControls = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
      () => [] as Locator[],
    );
    if (stopControls.length > 0) return false;
  }

  const recoveryButtons = await credibleLocators(
    page.getByRole("button", { name: DEVSPACE_NATIVE_RECOVERY_BUTTON_PATTERN }),
    true,
  ).catch(() => [] as Locator[]);
  if (recoveryButtons.length > 0) return false;

  let composer: Locator;
  try {
    composer = await findExactlyOneComposer(page, stoppedActiveTurn ? transitionTimeoutMs : 1_000);
  } catch {
    return false;
  }

  await insertAndVerifyPrompt(composer, prompt);

  // Typing may be what causes the send arrow to appear. Wait for exactly one
  // visible, enabled send control, again by observing UI state rather than by
  // assuming any particular render delay.
  const sendReady = await page
    .waitForFunction(
      (selector) => {
        const ready = Array.from(document.querySelectorAll(selector)).filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          if (element.getAttribute("aria-disabled") === "true") return false;
          if (element instanceof HTMLButtonElement && element.disabled) return false;
          const style = getComputedStyle(element);
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            element.getClientRects().length > 0
          );
        });
        return ready.length === 1;
      },
      SEND_SELECTOR,
      { timeout: stoppedActiveTurn ? transitionTimeoutMs : 1_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!sendReady || page.isClosed()) return false;

  const activeStops = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
    () => [] as Locator[],
  );
  if (activeStops.length > 0) return false;

  await submitPrompt(page, composer, prompt);
  return true;
}

async function resumeDevSpaceConversation(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  const stopControls = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
    () => [] as Locator[],
  );
  if (stopControls.length > 0) return false;

  const recoveryButtons = await credibleLocators(
    page.getByRole("button", { name: DEVSPACE_NATIVE_RECOVERY_BUTTON_PATTERN }),
    true,
  ).catch(() => [] as Locator[]);
  if (recoveryButtons.length === 0) return false;

  await recoveryButtons[recoveryButtons.length - 1]!.click({ timeout: 5_000 });
  return true;
}

export async function resumeDevSpaceConversationIfInterrupted(page: Page): Promise<boolean> {
  if ((await detectDevSpaceRecoverySignal(page)) !== "retryable_interruption") return false;
  if (await resumeInterruptedDevSpaceConversationViaComposer(page)) return true;
  return resumeDevSpaceConversation(page);
}

export async function deleteConversationHistoryFromSidebar(
  page: Page,
  conversationPath: string,
): Promise<boolean> {
  if (!/^\/c\/[A-Za-z0-9_-]{8,}$/.test(conversationPath)) {
    throw new WebLaunchBrowserError("delete requires a bounded conversation path");
  }

  const escapedPath = conversationPath.replace(/["\\]/g, "\\$&");
  const links = await visibleLocators(
    page.locator(`a[href="${escapedPath}"], a[href$="${escapedPath}"]`),
  ).catch(() => [] as Locator[]);
  if (links.length === 0) return false;
  if (links.length > 1) {
    throw new WebLaunchBrowserError(
      `found ${links.length} sidebar links for the target conversation; expected exactly one`,
    );
  }

  const row = links[0]!.locator("xpath=ancestor::*[.//button][1]");
  let menuButtons = await credibleLocators(
    row.getByRole("button", { name: /(?:more|options|menu|更多|選項|选项)/i }),
    true,
  ).catch(() => [] as Locator[]);
  if (menuButtons.length === 0) {
    menuButtons = await credibleLocators(row.locator("button"), true).catch(() => [] as Locator[]);
  }
  if (menuButtons.length !== 1) {
    throw new WebLaunchBrowserError(
      `found ${menuButtons.length} menu controls for the target conversation; expected exactly one`,
    );
  }
  await menuButtons[0]!.click({ timeout: 5_000 });
  await page.waitForTimeout(100).catch(() => undefined);

  const deletePattern = /^(?:Delete|刪除|删除)$/i;
  const deleteDeadline = Date.now() + 1_500;
  let deleteActions: Locator[] = [];
  while (Date.now() < deleteDeadline) {
    deleteActions = await visibleLocators(
      page.getByRole("menuitem", { name: deletePattern }),
      true,
    ).catch(() => [] as Locator[]);
    if (deleteActions.length === 0) {
      deleteActions = await visibleLocators(
        page.getByRole("button", { name: deletePattern }),
        true,
      ).catch(() => [] as Locator[]);
    }
    if (deleteActions.length === 0) {
      const textCandidates = await page
        .getByText(deletePattern, { exact: true })
        .all()
        .catch(() => [] as Locator[]);
      for (const candidate of textCandidates) {
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const control = await clickableAncestor(candidate);
        if (!(await control.isVisible().catch(() => false))) continue;
        if (!(await control.isEnabled().catch(() => false))) continue;
        deleteActions.push(control);
      }
    }
    if (deleteActions.length > 0) break;
    await page.waitForTimeout(50).catch(() => undefined);
  }
  if (deleteActions.length !== 1) {
    throw new WebLaunchBrowserError(
      `found ${deleteActions.length} delete actions; expected exactly one`,
    );
  }
  await deleteActions[0]!.click({ timeout: 5_000 });
  await page.waitForTimeout(100).catch(() => undefined);

  const dialogs = await visibleLocators(
    page.locator('[role="dialog"], [aria-modal="true"]'),
  ).catch(() => [] as Locator[]);
  const deleteDialogs: Locator[] = [];
  for (const dialog of dialogs) {
    const text = await dialog.innerText().catch(() => "");
    if (/(?:Delete chat|Delete conversation|刪除聊天|删除聊天)/i.test(text)) {
      deleteDialogs.push(dialog);
    }
  }
  if (deleteDialogs.length !== 1) {
    throw new WebLaunchBrowserError(
      `found ${deleteDialogs.length} delete confirmation dialogs; expected exactly one`,
    );
  }

  const confirmButtons = await credibleLocators(
    deleteDialogs[0]!.getByRole("button", { name: deletePattern }),
    true,
  ).catch(() => [] as Locator[]);
  if (confirmButtons.length !== 1) {
    throw new WebLaunchBrowserError(
      `found ${confirmButtons.length} delete confirmation buttons; expected exactly one`,
    );
  }
  await confirmButtons[0]!.click({ timeout: 5_000 });
  return true;
}

export async function approveDevSpaceAlwaysPermissionIfPresent(
  page: Page,
): Promise<boolean> {
  const allowPattern =
    /^(?:Allow always|Always allow|一律允許|總是允許|始終允許|永遠允許|一律允许|总是允许|始终允许|永远允许)$/i;
  const buttons = await page.locator("button").all().catch(() => [] as Locator[]);

  const scoped: Locator[] = [];
  const permissionPattern =
    /(allow|permission|access|tool|允許|允许|權限|权限|存取|访问|工具)/i;
  for (const button of buttons) {
    if (!(await button.isVisible().catch(() => false))) continue;
    if (!(await button.isEnabled().catch(() => false))) continue;

    const buttonName = await button
      .evaluate((element) =>
        [
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("title") ?? "",
          element.textContent ?? "",
        ]
          .map((value) => value.replace(/\s+/g, " ").trim())
          .find((value) => value.length > 0) ?? "",
      )
      .catch(() => "");
    if (!allowPattern.test(buttonName)) continue;

    const scopeTexts = await button
      .evaluate((element) => {
        const modal = element.closest(
          '[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [data-testid*="dialog"]',
        );
        if (modal) {
          return [
            (((modal as HTMLElement).innerText || modal.textContent || ""))
              .replace(/\s+/g, " ")
              .trim(),
          ];
        }

        const texts: string[] = [];
        let current = element.parentElement;
        for (let depth = 0; current && current !== document.body && depth < 6; depth += 1) {
          texts.push(
            (((current as HTMLElement).innerText || current.textContent || ""))
              .replace(/\s+/g, " ")
              .trim(),
          );
          current = current.parentElement;
        }
        return texts;
      })
      .catch(() => [] as string[]);

    const belongsToDevSpace = scopeTexts.some(
      (text) =>
        text.length <= 4_000 &&
        /(?:DevSpace Local|\bdevspace\b)/i.test(text) &&
        permissionPattern.test(text),
    );
    if (belongsToDevSpace) scoped.push(button);
  }

  if (scoped.length === 0) return false;
  if (scoped.length > 1) {
    throw new WebLaunchBrowserError(
      `found ${scoped.length} DevSpace Allow always controls; expected exactly one`,
    );
  }

  await scoped[0]!.click({ timeout: 5_000 });
  return true;
}

export async function watchForDevSpaceChatShareRecovery(
  page: Page,
  timeoutMs = 0,
  options: DevSpaceChatShareRecoveryOptions = {},
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  if (ACTIVE_DEVSPACE_RECOVERY_WATCHES.has(page)) return false;
  ACTIVE_DEVSPACE_RECOVERY_WATCHES.add(page);

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  const silentIdleMs = options.silentIdleMs ?? DEFAULT_CHATSHARE_SILENT_IDLE_MS;
  const resumeCooldownMs = options.resumeCooldownMs ?? DEFAULT_AUTO_RESUME_COOLDOWN_MS;
  const maxResumeAttempts = options.maxResumeAttempts ?? 3;
  const pollMs = options.pollMs ?? 250;
  let acted = false;
  let nextPermissionCheckAtMs = 0;
  let resumeAttempts = 0;
  let nextResumeAtMs = 0;
  let activitySignature = await readChatShareActivitySignature(page);
  let lastActivityAtMs = Date.now();

  try {
    while (Date.now() < deadline) {
      if (page.isClosed() || options.signal?.aborted) return acted;
      try {
        const nowMs = Date.now();
        const nextSignature = await readChatShareActivitySignature(page);
        if (nextSignature !== activitySignature) {
          activitySignature = nextSignature;
          lastActivityAtMs = nowMs;
          if (nowMs >= nextResumeAtMs) {
            resumeAttempts = 0;
          }
        }

        if (
          Date.now() >= nextPermissionCheckAtMs &&
          (await approveDevSpaceAlwaysPermissionIfPresent(page))
        ) {
          acted = true;
          nextPermissionCheckAtMs = Date.now() + 500;
          activitySignature = await readChatShareActivitySignature(page);
          lastActivityAtMs = Date.now();
        }

        const recoverySignal = await detectDevSpaceRecoverySignal(page);
        if (
          recoverySignal === "terminal_capacity" ||
          recoverySignal === "terminal_context"
        ) {
          return acted;
        }

        if (resumeAttempts < maxResumeAttempts && Date.now() >= nextResumeAtMs) {
          const interrupted = recoverySignal === "retryable_interruption";
          const transientUiError =
            recoverySignal === "transient_gateway" ||
            recoverySignal === "generic_error";
          const silentStall =
            recoverySignal === "none" &&
            silentIdleMs > 0 &&
            Date.now() - lastActivityAtMs >= silentIdleMs &&
            (await isDevSpaceSilentStallCandidate(page));

          if (
            silentStall &&
            !(await hasDevSpaceNativeRecoveryControl(page))
          ) {
            // Silent stalls without a native recovery control are deliberately
            // detect-only. Ordinary conversations must never synthesize a
            // user-level "resume" instruction, and there is no safe browser
            // action to take here.
            return acted;
          }

          let resumed = false;
          if (interrupted || silentStall || transientUiError) {
            // The budget/cooldown applies to the recovery attempt itself, not
            // only to a successful click. This prevents repeated plugin
            // reconnect/retry work when the native control is absent, detached,
            // or not yet actionable.
            resumeAttempts += 1;
            nextResumeAtMs = Date.now() + Math.max(1, resumeCooldownMs);

            if (interrupted) {
              const activeStops = await credibleLocators(page.locator(STOP_SELECTOR)).catch(
                () => [] as Locator[],
              );
              if (activeStops.length > 0) {
                // UI first: when the interrupted turn still owns the square
                // stop control, do not navigate away for connector recovery.
                // Stop it, wait for the composer/send-arrow transition, and
                // submit "resume" in the same conversation.
                resumed = await resumeInterruptedDevSpaceConversationViaComposer(page);
                if (!resumed) resumed = await resumeDevSpaceConversation(page);
              } else {
                await options.ensurePluginConnected?.();
                if (options.signal?.aborted) return acted;
                resumed = await resumeInterruptedDevSpaceConversationViaComposer(page);
                if (!resumed) resumed = await resumeDevSpaceConversation(page);
              }
            } else {
              if (silentStall) {
                await options.ensurePluginConnected?.();
                if (options.signal?.aborted) return acted;
              }
              // Gateway/generic failures and silent stalls are retried only
              // through a native UI control. Never synthesize a user-level
              // "resume" instruction for those states.
              resumed = await resumeDevSpaceConversation(page);
            }
          }
          if (resumed) {
            acted = true;
            activitySignature = await readChatShareActivitySignature(page);
            lastActivityAtMs = Date.now();
          }
        }
      } catch {
        // Navigation and DOM transitions can detach recovery controls; retry from a fresh snapshot.
      }
      await page.waitForTimeout(Math.max(50, pollMs)).catch(() => undefined);
    }
    return acted;
  } finally {
    ACTIVE_DEVSPACE_RECOVERY_WATCHES.delete(page);
  }
}

export async function watchForDevSpaceAlwaysPermission(
  page: Page,
  timeoutMs = 10 * 60_000,
): Promise<boolean> {
  return watchForDevSpaceChatShareRecovery(page, timeoutMs);
}

async function completeDevSpaceJitAuthorization(
  page: Page,
  options: {
    deviceProofProvider: DeviceProofProvider;
    devSpacePublicBaseUrl?: string;
    signInAlreadyClicked?: boolean;
    timeoutMs?: number;
  },
): Promise<void> {
  const context = page.context();
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let signInClicked = options.signInAlreadyClicked ?? false;
  let observedJitSurface = signInClicked;

  while (Date.now() < deadline) {
    const authorizePage = context
      .pages()
      .find((candidate) =>
        candidate !== page &&
        isExpectedDevSpaceAuthorizeUrl(candidate.url(), options.devSpacePublicBaseUrl),
      );
    if (authorizePage) {
      observedJitSurface = true;
      await completeDevSpaceAuthorizePage(authorizePage, options.deviceProofProvider);
      await waitForDevSpaceJitCompletion(page, authorizePage);
      return;
    }

    const onJitSettings = page.url().includes("#settings/Connectors");
    const signInButtons = await credibleLocators(
      page.getByRole("button", { name: /^Sign in with (?:DevSpace Local|devspace)$/i }),
      true,
    ).catch(() => [] as Locator[]);

    if (onJitSettings || signInButtons.length > 0) observedJitSurface = true;

    if (signInButtons.length > 1) {
      throw new WebLaunchBrowserError(
        `DevSpace JIT authorization found ${signInButtons.length} enabled sign-in buttons; expected at most one`,
      );
    }
    if (signInButtons.length === 1 && !signInClicked) {
      signInClicked = true;
      await signInButtons[0]!.click({ timeout: 5_000 });
    }

    const accessPromptVisible = await anyLocatorVisible(
      await page.getByText(/needs access to (?:DevSpace Local|devspace)/i).all().catch(() => [] as Locator[]),
    );
    if (!observedJitSurface && !accessPromptVisible) {
      // A previously connected account can grant the conversation directly
      // without opening the JIT connector settings flow.
      await page.waitForTimeout(1_000);
      const stillNoJit =
        !page.url().includes("#settings/Connectors") &&
        (await credibleLocators(
          page.getByRole("button", { name: /^Sign in with (?:DevSpace Local|devspace)$/i }),
          true,
        ).catch(() => [] as Locator[])).length === 0;
      if (stillNoJit) return;
    }

    await page.waitForTimeout(150);
  }

  throw new WebLaunchBrowserError("DevSpace JIT authorization did not reach the local authorize page");
}

async function completeDevSpaceAuthorizePage(
  authorizePage: Page,
  deviceProofProvider: DeviceProofProvider,
): Promise<void> {
  await authorizePage.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);

  const authorizationAlreadyCompleted = (): boolean => {
    try {
      const current = new URL(authorizePage.url());
      return (
        CHAT_SURFACE_HOSTS.has(current.hostname) &&
        (current.pathname.startsWith("/connector/oauth/") ||
          devSpacePluginIdFromUrl(current.href) !== undefined)
      );
    } catch {
      return false;
    }
  };

  if (authorizationAlreadyCompleted()) return;

  const deadline = Date.now() + 10_000;

  for (let submitAttempt = 0; submitAttempt < 3 && Date.now() < deadline; submitAttempt += 1) {
    let deviceFields:
      | {
          challenge: string;
          binding: string;
          formHtml: string;
        }
      | undefined;

    while (Date.now() < deadline) {
      if (authorizationAlreadyCompleted()) return;

      const snapshot = await authorizePage
        .evaluate(() => {
          const ownerTokenCount = document.querySelectorAll(
            'input[name="owner_token"]',
          ).length;
          const forms = Array.from(document.querySelectorAll<HTMLFormElement>("form"));
          const candidates = forms
            .map((form) => {
              const challenges = form.querySelectorAll<HTMLInputElement>(
                'input[name="device_challenge"]',
              );
              const bindings = form.querySelectorAll<HTMLInputElement>(
                'input[name="device_binding"]',
              );
              const explicitlyDeviceBound =
                form.getAttribute("data-devspace-device-auth") === "required";
              const structurallyDeviceBound =
                challenges.length === 1 && bindings.length === 1;
              return {
                form,
                challenges,
                bindings,
                candidate: explicitlyDeviceBound || structurallyDeviceBound,
              };
            })
            .filter((entry) => entry.candidate);

          return {
            ownerTokenCount,
            candidateCount: candidates.length,
            challengeCount: candidates[0]?.challenges.length ?? 0,
            bindingCount: candidates[0]?.bindings.length ?? 0,
            challenge: candidates[0]?.challenges[0]?.value ?? "",
            binding: candidates[0]?.bindings[0]?.value ?? "",
            formHtml: candidates[0]?.form.outerHTML.slice(0, 2400) ?? "",
          };
        })
        .catch(() => ({
          ownerTokenCount: 0,
          candidateCount: 0,
          challengeCount: 0,
          bindingCount: 0,
          challenge: "",
          binding: "",
          formHtml: "",
        }));

      if (snapshot.ownerTokenCount > 0) {
        throw new WebLaunchBrowserError(
          "DevSpace JIT authorization fell back to owner password; ChatGPT callback is not device-authorized",
        );
      }
      if (snapshot.candidateCount > 1) {
        throw new WebLaunchBrowserError(
          `DevSpace JIT authorization exposed ${snapshot.candidateCount} device-bound forms; expected exactly one`,
        );
      }
      if (
        snapshot.candidateCount === 1 &&
        snapshot.challengeCount === 1 &&
        snapshot.bindingCount === 1
      ) {
        deviceFields = {
          challenge: snapshot.challenge,
          binding: snapshot.binding,
          formHtml: snapshot.formHtml,
        };
        break;
      }

      await authorizePage.waitForTimeout(100).catch(() => undefined);
    }

    if (!deviceFields) {
      const bodyText = await authorizePage.locator("body").innerText().catch(() => "");
      throw new WebLaunchBrowserError(
        `DevSpace JIT authorization did not expose one live device-bound form; url=${authorizePage.url()}; body=${bodyText.slice(0, 1200)}`,
      );
    }

    const { challenge, binding } = deviceFields;
    if (!BASE64URL_SHA256.test(challenge) || !BASE64URL_SHA256.test(binding)) {
      throw new WebLaunchBrowserError(
        `DevSpace JIT authorization supplied an invalid device challenge; form=${deviceFields.formHtml}`,
      );
    }

    const proof = await deviceProofProvider({ challenge, binding });
    if (!BASE64URL_SHA256.test(proof)) {
      throw new WebLaunchBrowserError("DevSpace device-proof provider returned an invalid proof");
    }

    const submitResult = await authorizePage
      .evaluate(
        ({ challenge, binding, proof }) => {
          const matchingForms = Array.from(
            document.querySelectorAll<HTMLFormElement>("form"),
          ).filter((form) => {
            const challengeInputs = form.querySelectorAll<HTMLInputElement>(
              'input[name="device_challenge"]',
            );
            const bindingInputs = form.querySelectorAll<HTMLInputElement>(
              'input[name="device_binding"]',
            );
            return (
              challengeInputs.length === 1 &&
              bindingInputs.length === 1 &&
              challengeInputs[0]?.value === challenge &&
              bindingInputs[0]?.value === binding &&
              form.querySelector('input[name="owner_token"]') === null
            );
          });

          if (matchingForms.length !== 1) {
            return {
              submitted: false,
              matchingFormCount: matchingForms.length,
              proofCount: 0,
            };
          }

          const form = matchingForms[0]!;
          let proofInputs = form.querySelectorAll<HTMLInputElement>(
            'input[name="device_proof"]',
          );
          if (proofInputs.length > 1) {
            return {
              submitted: false,
              matchingFormCount: 1,
              proofCount: proofInputs.length,
            };
          }
          if (proofInputs.length === 0) {
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = "device_proof";
            form.appendChild(input);
            proofInputs = form.querySelectorAll<HTMLInputElement>(
              'input[name="device_proof"]',
            );
          }
          if (proofInputs.length !== 1) {
            return {
              submitted: false,
              matchingFormCount: 1,
              proofCount: proofInputs.length,
            };
          }

          proofInputs[0]!.value = proof;
          form.requestSubmit();
          return {
            submitted: true,
            matchingFormCount: 1,
            proofCount: 1,
          };
        },
        { challenge, binding, proof },
      )
      .catch(() => ({
        submitted: false,
        matchingFormCount: 0,
        proofCount: 0,
      }));

    if (submitResult.submitted) return;
    if (submitResult.matchingFormCount === 1 && submitResult.proofCount > 1) {
      throw new WebLaunchBrowserError(
        `DevSpace JIT authorization exposed ${submitResult.proofCount} device proof fields; expected at most one`,
      );
    }

    // ChatShare may rerender the authorize form between the read and proof
    // request. Reacquire the current form and obtain a fresh proof, boundedly.
    await authorizePage.waitForTimeout(100).catch(() => undefined);
  }

  throw new WebLaunchBrowserError(
    "DevSpace JIT authorization form kept rerendering before proof submission",
  );
}

async function waitForDevSpaceJitCompletion(
  page: Page,
  authorizePage: Page,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (authorizePage.isClosed()) {
      if (!page.url().includes("#settings/Connectors")) return;
    } else {
      const authorizeUrl = authorizePage.url();
      try {
        const parsed = new URL(authorizeUrl);
        if (CHAT_SURFACE_HOSTS.has(parsed.hostname) && parsed.pathname.startsWith("/connector/oauth/")) {
          await authorizePage.close().catch(() => undefined);
          return;
        }
        if (
          CHAT_SURFACE_HOSTS.has(parsed.hostname) &&
          devSpacePluginIdFromUrl(parsed.href) !== undefined
        ) {
          return;
        }
      } catch {
        // Keep waiting for a valid callback or popup closure.
      }
    }

    const current = new URL(page.url());
    if (current.searchParams.get("oauth_success") === "true") return;
    await page.waitForTimeout(150);
  }

  throw new WebLaunchBrowserError("DevSpace JIT authorization did not complete its OAuth callback");
}

function isExpectedDevSpaceAuthorizeUrl(
  value: string,
  publicBaseUrl: string | undefined,
): boolean {
  if (!publicBaseUrl) return false;
  try {
    const candidate = new URL(value);
    const expected = new URL(publicBaseUrl);
    return candidate.origin === expected.origin && candidate.pathname === "/authorize";
  } catch {
    return false;
  }
}

async function hiddenInputValue(page: Page, name: string): Promise<string> {
  const locator = page.locator(`input[name="${name}"]`);
  if ((await locator.count()) !== 1) {
    throw new WebLaunchBrowserError(`DevSpace JIT authorization is missing ${name}`);
  }
  return locator.inputValue();
}

export async function requestLocalDeviceProof(
  request: DeviceProofRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!BASE64URL_SHA256.test(request.challenge) || !BASE64URL_SHA256.test(request.binding)) {
    throw new WebLaunchBrowserError("invalid DevSpace device-proof challenge");
  }

  const portRaw = env.DEVSPACE_DEVICE_AUTH_LOOPBACK_PORT?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_DEVICE_AUTH_LOOPBACK_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new WebLaunchBrowserError("invalid DEVSPACE_DEVICE_AUTH_LOOPBACK_PORT");
  }

  const extensionId =
    env.DEVSPACE_DEVICE_AUTH_EXTENSION_ID?.trim() || DEFAULT_DEVICE_AUTH_EXTENSION_ID;
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new WebLaunchBrowserError("invalid DEVSPACE_DEVICE_AUTH_EXTENSION_ID");
  }

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/devspace-device-proof`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DevSpace-Extension-Id": extensionId,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new WebLaunchBrowserError("unable to obtain local DevSpace device proof", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new WebLaunchBrowserError(
      `local DevSpace device-proof endpoint returned HTTP ${response.status}`,
    );
  }

  const body = (await response.json().catch(() => undefined)) as
    | { proof?: unknown }
    | undefined;
  const proof = typeof body?.proof === "string" ? body.proof : "";
  if (!BASE64URL_SHA256.test(proof)) {
    throw new WebLaunchBrowserError("local DevSpace device-proof endpoint returned an invalid proof");
  }
  return proof;
}

async function anyLocatorVisible(locators: Locator[]): Promise<boolean> {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) return true;
  }
  return false;
}

async function resolveDevSpacePluginIds(
  page: Page,
  timeoutMs = 20_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastCandidates: Array<{ href: string; text: string }> = [];

  while (Date.now() < deadline) {
    await assertAuthenticated(page);
    const candidates = await page
      .locator('a[href*="plugin_"]')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          href: element instanceof HTMLAnchorElement ? element.href : "",
          text: [
            element.textContent ?? "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("title") ?? "",
          ]
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        })),
      )
      .catch(() => [] as Array<{ href: string; text: string }>);

    const byId = new Map<string, { href: string; text: string }>();
    for (const candidate of candidates) {
      const pluginId = devSpacePluginIdFromUrl(candidate.href);
      if (!pluginId) continue;
      const previous = byId.get(pluginId);
      if (!previous || candidate.text.length > previous.text.length) byId.set(pluginId, candidate);
    }
    lastCandidates = [...byId.values()];

    const namedIds = [...byId.entries()]
      .filter(([, candidate]) => DEVSPACE_PLUGIN_DISPLAY_PATTERN.test(candidate.text))
      .map(([pluginId]) => pluginId);
    if (namedIds.length > 0) return [...new Set(namedIds)];
    if (byId.size === 1) return [...byId.keys()];

    if (new URL(page.url()).hostname === "chatshare.xyz") {
      const cardButtons = await credibleLocators(
        page.getByRole("button", { name: /^(?:DevSpace Local|devspace)$/i }),
        true,
      ).catch(() => [] as Locator[]);
      if (cardButtons.length > 1) {
        throw new WebLaunchBrowserError(
          `ChatShare Plugins exposed ${cardButtons.length} DevSpace cards; expected at most one`,
        );
      }
      if (cardButtons.length === 1) {
        if (!(await clickLocatorRobustly(cardButtons[0]!, 2_500))) {
          throw new WebLaunchBrowserError(
            "ChatShare DevSpace plugin card could not be activated",
          );
        }

        const detailDeadline = Date.now() + Math.min(
          1_500,
          Math.max(100, deadline - Date.now()),
        );
        while (Date.now() < detailDeadline) {
          const pluginId = devSpacePluginIdFromUrl(page.url());
          if (pluginId) return [pluginId];
          await page.waitForTimeout(100).catch(() => undefined);
        }
      }
    }

    await page.waitForTimeout(250);
  }

  if (lastCandidates.length === 0) return [];
  return [];
}

export async function resolveDevSpacePluginId(page: Page, timeoutMs = 20_000): Promise<string> {
  const pluginIds = await resolveDevSpacePluginIds(page, timeoutMs);
  if (pluginIds.length === 1) return pluginIds[0]!;
  if (pluginIds.length > 1) {
    throw new WebLaunchBrowserError(
      `found ${pluginIds.length} connected DevSpace plugin identities; expected exactly one`,
    );
  }
  throw new WebLaunchBrowserError(
    "connected DevSpace plugin was not discoverable from ChatGPT plugins page",
  );
}

export function devSpacePluginIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value, CHATGPT_URL);
    if (!CHAT_SURFACE_HOSTS.has(url.hostname)) return undefined;

    const pathMatch = url.pathname.match(/^\/plugins\/plugin_([A-Za-z0-9_:-]+)\/?$/);
    if (pathMatch?.[1]) return pathMatch[1];

    const hashMatch = url.hash.match(
      /^#settings\/Plugins\/plugin_([A-Za-z0-9_:-]+)(?:[/?]|$)/,
    );
    return hashMatch?.[1];
  } catch {
    return undefined;
  }
}

function chatPluginsSettingsUrl(base: URL): URL {
  if (base.hostname === "chatshare.xyz") {
    return new URL("/#settings/Plugins", base);
  }
  return new URL("/plugins?search=devspace", base);
}

function chatPluginDetailUrl(base: URL, pluginId: string): URL {
  if (base.hostname === "chatshare.xyz") {
    return new URL(`/#settings/Plugins/plugin_${pluginId}`, base);
  }
  return new URL(`/plugins/plugin_${pluginId}`, base);
}

function chatPluginCreateConnectorUrl(base: URL): URL {
  if (base.hostname === "chatshare.xyz") {
    return new URL(
      "/#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins",
      base,
    );
  }
  return new URL(
    "/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins",
    base,
  );
}

function chatSurfaceBaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (CHAT_SURFACE_HOSTS.has(url.hostname)) {
      return new URL(`${url.protocol}//${url.host}/`);
    }
  } catch {
    // Fall through to the bounded default below.
  }
  return new URL(CHATGPT_URL);
}

export function chatConversationIdentityFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!CHAT_SURFACE_HOSTS.has(url.hostname)) return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      if (parts[index] !== "c") continue;
      const id = parts[index + 1];
      if (id && /^[A-Za-z0-9_-]{8,200}$/.test(id)) return `${url.hostname}:c:${id}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function chatGptConversationIdentityFromUrl(value: string): string | undefined {
  const identity = chatConversationIdentityFromUrl(value);
  if (!identity?.startsWith("chatgpt.com:c:")) return undefined;
  return identity.replace(/^chatgpt\.com:/, "chatgpt:");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function findExactlyOneComposer(page: Page, timeoutMs = 20_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  let candidates: Locator[] = [];
  while (Date.now() < deadline) {
    await assertAuthenticated(page);
    candidates = await rankedComposerLocators(page);
    if (candidates.length === 1) return candidates[0]!;
    await page.waitForTimeout(200);
  }
  if (candidates.length > 1) {
    throw new WebLaunchBrowserError(
      `found ${candidates.length} equally ranked ChatGPT composers`,
    );
  }
  throw new WebLaunchBrowserError("no credible ChatGPT composer was found");
}

export async function insertAndVerifyPrompt(composer: Locator, text: string): Promise<void> {
  try {
    await composer.fill(text, { timeout: 10_000 });
    if (normalizeText(await readComposerText(composer)) === normalizeText(text)) return;
  } catch {
    // Rich editors can accept fill() without updating their internal document.
  }

  try {
    await composer.click({ timeout: 5_000 });
    const isTextControl = await composer.evaluate(
      (element) => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement,
    );
    if (isTextControl) {
      await composer.press("ControlOrMeta+A");
    } else {
      await composer.evaluate((element) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
    }
    await composer.press("Backspace");
    await composer.page().keyboard.insertText(text);
    const readBack = await readComposerText(composer);
    if (normalizeText(readBack) !== normalizeText(text)) {
      const metadata = await composer
        .evaluate((element) => ({
          tag: element.tagName,
          contenteditable: element.getAttribute("contenteditable"),
          role: element.getAttribute("role"),
          ariaMultiline: element.getAttribute("aria-multiline"),
          dataLexicalEditor: element.getAttribute("data-lexical-editor"),
          className: element instanceof HTMLElement ? element.className : "",
          childElementCount: element.childElementCount,
          textLength: element.textContent?.length ?? 0,
        }))
        .catch(() => undefined);
      throw new Error(
        `composer read-back mismatch expectedLength=${text.length} actualLength=${readBack.length} metadata=${JSON.stringify(metadata)}`,
      );
    }
  } catch (error) {
    const causeMessage = error instanceof Error ? error.message : String(error);
    throw new WebLaunchBrowserError(
      `unable to insert and verify prompt: ${causeMessage}`,
      { cause: error },
    );
  }
}

async function submitPrompt(
  page: Page,
  composer: Locator,
  expected: string,
  readCurrent: (composer: Locator) => Promise<string> = readComposerText,
): Promise<void> {
  if (normalizeText(await readCurrent(composer)) !== normalizeText(expected)) {
    throw new WebLaunchBrowserError("prompt changed before submission");
  }

  const sendControls = await credibleLocators(page.locator(SEND_SELECTOR), true);
  if (sendControls.length !== 1) {
    throw new WebLaunchBrowserError(
      `expected one enabled send control, found ${sendControls.length}`,
    );
  }

  const send = sendControls[0]!;
  const stopWasVisible = (await credibleLocators(page.locator(STOP_SELECTOR))).length > 0;
  await send.click({ timeout: 5_000 });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (normalizeText(await readCurrent(composer)) === "") return;
    } catch {
      return;
    }
    if (!stopWasVisible && (await credibleLocators(page.locator(STOP_SELECTOR))).length > 0) return;
    try {
      if (!(await send.isVisible()) || !(await send.isEnabled())) return;
    } catch {
      return;
    }
    await page.waitForTimeout(100);
  }

  throw new WebLaunchBrowserError("prompt submission was not confirmed");
}

async function rankedComposerLocators(page: Page): Promise<Locator[]> {
  const locator = page.locator(COMPOSER_SELECTOR);
  const metadata = await locator.evaluateAll(
    (elements, { selectors, sendSelector }) => {
      const containers: Element[] = [];
      return elements.map((element, index) => {
        const container = element.closest("form") ?? element.parentElement ?? element.closest("main");
        let containerKey = container ? containers.indexOf(container) : -1;
        if (container && containerKey === -1) {
          containers.push(container);
          containerKey = containers.length - 1;
        }
        const hasEnabledSend = container
          ? Array.from(container.querySelectorAll(sendSelector)).some((control) => {
              if (!(control instanceof HTMLElement)) return false;
              if (control.getAttribute("aria-disabled") === "true") return false;
              if (control instanceof HTMLButtonElement && control.disabled) return false;
              return control.getClientRects().length > 0;
            })
          : false;
        return {
          index,
          selectorRank: selectors.findIndex((selector) => element.matches(selector)),
          sendRank: hasEnabledSend ? 0 : 1,
          containerKey,
          contains: elements.flatMap((other, otherIndex) =>
            other !== element && element.contains(other) ? [otherIndex] : [],
          ),
        };
      });
    },
    { selectors: [...COMPOSER_SELECTORS], sendSelector: SEND_SELECTOR },
  );

  const credibleIndices = new Set<number>();
  const viewport = page.viewportSize();
  for (let index = 0; index < (await locator.count()); index += 1) {
    const candidate = locator.nth(index);
    try {
      if (!(await candidate.isVisible()) || !(await isEditableOrButton(candidate))) continue;
      const box = await candidate.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) continue;
      if (
        viewport &&
        (box.x + box.width <= 0 ||
          box.y + box.height <= 0 ||
          box.x >= viewport.width ||
          box.y >= viewport.height)
      ) {
        continue;
      }
      credibleIndices.add(index);
    } catch {
      // Ignore detached candidates and retry from a new DOM snapshot.
    }
  }

  const credible = metadata.filter((candidate) => credibleIndices.has(candidate.index));
  const innermost = credible.filter(
    (candidate) =>
      !candidate.contains.some((childIndex) => {
        if (!credibleIndices.has(childIndex)) return false;
        const child = metadata[childIndex];
        return child?.containerKey === candidate.containerKey;
      }),
  );
  if (innermost.length === 0) return [];

  const bestSelectorRank = Math.min(...innermost.map((candidate) => candidate.selectorRank));
  const selectorWinners = innermost.filter(
    (candidate) => candidate.selectorRank === bestSelectorRank,
  );
  const bestSendRank = Math.min(...selectorWinners.map((candidate) => candidate.sendRank));
  return selectorWinners
    .filter((candidate) => candidate.sendRank === bestSendRank)
    .map((candidate) => locator.nth(candidate.index));
}

async function visibleLocators(locator: Locator, requireEnabled = false): Promise<Locator[]> {
  const all = await locator.all();
  const result: Locator[] = [];
  for (const candidate of all) {
    try {
      if (!(await candidate.isVisible())) continue;
      if (requireEnabled && !(await candidate.isEnabled())) continue;
      result.push(candidate);
    } catch {
      // Ignore detached candidates and retry from a new DOM snapshot.
    }
  }
  return result;
}

async function credibleLocators(locator: Locator, requireEnabled = false): Promise<Locator[]> {
  const all = await locator.all();
  const result: Locator[] = [];
  for (const candidate of all) {
    try {
      if (!(await candidate.isVisible())) continue;
      if (requireEnabled && !(await candidate.isEnabled())) continue;
      if (!requireEnabled && !(await isEditableOrButton(candidate))) continue;
      result.push(candidate);
    } catch {
      // Ignore detached candidates and retry from a new DOM snapshot.
    }
  }
  return result;
}

async function isEditableOrButton(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    if (element instanceof HTMLButtonElement) return !element.disabled;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return !element.disabled && !element.readOnly;
    }
    return (
      element instanceof HTMLElement &&
      element.getAttribute("contenteditable") === "true" &&
      element.getAttribute("aria-disabled") !== "true"
    );
  });
}

export async function readComposerText(composer: Locator): Promise<string> {
  return composer.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value;
    }
    if (!(element instanceof HTMLElement)) return element.textContent ?? "";

    const clone = element.cloneNode(true) as HTMLElement;
    for (const lineBreak of clone.querySelectorAll("br")) {
      lineBreak.replaceWith(document.createTextNode("\n"));
    }
    const blockTags = new Set([
      "ADDRESS",
      "ARTICLE",
      "BLOCKQUOTE",
      "DIV",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
      "P",
      "PRE",
      "SECTION",
    ]);
    const children = Array.from(clone.childNodes);
    let result = "";
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      const isBlock = child instanceof HTMLElement && blockTags.has(child.tagName);
      if (isBlock && index > 0 && !result.endsWith("\n")) result += "\n";
      result += child.textContent ?? "";
      const next = children[index + 1];
      const nextIsBlock = next instanceof HTMLElement && blockTags.has(next.tagName);
      if (isBlock && next && !nextIsBlock && !result.endsWith("\n")) result += "\n";
    }
    return result;
  });
}

async function assertAuthenticated(page: Page): Promise<void> {
  const current = page.url();
  try {
    const url = new URL(current);
    if (CHAT_SURFACE_HOSTS.has(url.hostname) && /\/(auth|login|signup)(\/|$)/i.test(url.pathname)) {
      throw new WebLaunchBrowserError(
        "ChatGPT authentication is required in the dedicated DevSpace profile",
      );
    }
  } catch (error) {
    if (error instanceof WebLaunchBrowserError) throw error;
  }

  const controls = page.locator(
    'a[href*="/auth/login"], button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign up")',
  );
  for (let index = 0; index < (await controls.count()); index += 1) {
    if (await controls.nth(index).isVisible().catch(() => false)) {
      throw new WebLaunchBrowserError(
        "ChatGPT authentication is required in the dedicated DevSpace profile",
      );
    }
  }
}

export async function resolveWebLaunchProfilePath(
  allowedRoots: string[],
  env: NodeJS.ProcessEnv = process.env,
  sessionProvider: ChatSessionProvider = "chatgpt",
): Promise<string> {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new WebLaunchBrowserError(
      "LOCALAPPDATA is required for the dedicated DevSpace browser profile",
    );
  }

  const profileName = sessionProvider === "chatshare" ? "chatshare-fs0" : "chatgpt-fs0";
  const requested = resolve(localAppData, "DevSpace", "browser-profiles", profileName);
  const canonicalCandidate = await canonicalizePotentialPath(requested);
  const canonicalAllowedRoots = await Promise.all(allowedRoots.map(canonicalizePotentialPath));
  const ordinaryChromeRoots = await Promise.all(
    [
      join(localAppData, "Google", "Chrome", "User Data"),
      join(localAppData, "Google", "Chrome Beta", "User Data"),
      join(localAppData, "Google", "Chrome SxS", "User Data"),
    ].map(canonicalizePotentialPath),
  );

  assertOutsideRoots(canonicalCandidate, canonicalAllowedRoots, "DevSpace allowed root");
  assertOutsideRoots(canonicalCandidate, ordinaryChromeRoots, "ordinary Chrome profile");
  await assertNoLinkedComponents(requested);
  await mkdir(requested, { recursive: true });
  await assertNoLinkedComponents(requested);
  const canonical = await realpath(requested);
  assertOutsideRoots(canonical, canonicalAllowedRoots, "DevSpace allowed root");
  assertOutsideRoots(canonical, ordinaryChromeRoots, "ordinary Chrome profile");
  return canonical;
}

async function acquireProfileLease(profilePath: string): Promise<BrowserProfileLease> {
  const lockPath = `${profilePath}.devspace.lock`;
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
    );
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isErrorCode(error, "EEXIST")) {
      const existingText = await readFile(lockPath, "utf8").catch(() => "");
      let existingPid: number | undefined;
      try {
        const parsed = JSON.parse(existingText) as { pid?: unknown };
        if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
          existingPid = parsed.pid;
        }
      } catch {
        // Fail closed below for unreadable or malformed live-looking locks.
      }

      if (existingPid !== undefined && !(await isProcessAlive(existingPid))) {
        const currentText = await readFile(lockPath, "utf8").catch(() => "");
        if (currentText === existingText) {
          await rm(lockPath, { force: true });
          return acquireProfileLease(profilePath);
        }
      }

      throw new WebLaunchBrowserError("dedicated DevSpace browser profile is already in use");
    }
    throw error;
  }
  await handle.close();

  const release = async (): Promise<void> => {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
      if (current.token === token) await rm(lockPath, { force: true });
    } catch {
      // Never delete a replaced or unreadable lock.
    }
  };

  for (const name of CHROME_LOCK_NAMES) {
    if (await pathExists(join(profilePath, name))) {
      await release();
      throw new WebLaunchBrowserError(`Chrome profile lock is present: ${name}`);
    }
  }
  return { release };
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === "win32") {
    try {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$candidate = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $candidate) { exit 3 } else { exit 0 }`,
        ],
        { windowsHide: true },
      );
      return true;
    } catch (error) {
      const exitCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (exitCode === "3") return false;
      // Fail closed when the OS-native liveness query itself is unavailable.
      return true;
    }
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

async function canonicalizePotentialPath(input: string): Promise<string> {
  const absolute = resolve(input);
  const ancestor = await nearestExistingAncestor(absolute);
  const canonicalAncestor = await realpath(ancestor);
  return resolve(canonicalAncestor, relative(ancestor, absolute));
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await access(current, fsConstants.F_OK);
      return current;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertNoLinkedComponents(candidate: string): Promise<void> {
  const parsed = parse(candidate);
  const parts = relative(parsed.root, candidate).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new WebLaunchBrowserError(
          `DevSpace ChatGPT browser profile contains a symlink or junction: ${current}`,
        );
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

function assertOutsideRoots(candidate: string, roots: string[], label: string): void {
  for (const root of roots) {
    if (isWithin(candidate, root)) {
      throw new WebLaunchBrowserError(
        `DevSpace ChatGPT browser profile must be outside every ${label}: ${root}`,
      );
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  const candidateKey = comparisonKey(candidate);
  const rootKey = comparisonKey(root);
  const rel = relative(rootKey, candidateKey);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function comparisonKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isReusableSeedPage(url: string): boolean {
  return url === "about:blank" || url === "chrome://newtab/" || url === "chrome://new-tab-page/";
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ");
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
