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
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";

const CHATGPT_URL = "https://chatgpt.com/";
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
const COMPOSER_SELECTOR = COMPOSER_SELECTORS.join(", ");
const SEND_ACCESSIBLE_NAME = /^Send(?: prompt| message)?$/i;
const SEND_TESTID_SELECTOR = 'button[data-testid="send-button"]';
const SEND_LABEL_SELECTOR = [
  'button[aria-label="Send"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
].join(", ");
const SEND_ASSOCIATION_SELECTOR = [
  SEND_TESTID_SELECTOR,
  SEND_LABEL_SELECTOR,
  'button[type="submit"]',
].join(", ");
const SEND_READY_TIMEOUT_MS = 5_000;
const PROMPT_READBACK_TIMEOUT_MS = 750;
const PROMPT_READBACK_POLL_MS = 50;
const FALLBACK_COMPOSER_GRACE_MS = 3_500;
const STOP_SELECTOR = [
  'button[data-testid="stop-button"]',
  'button[aria-label^="Stop"]',
].join(", ");
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

export interface WebLaunchBrowserOptions {
  contextFactory?: () => Promise<BrowserContext>;
  profileLeaseFactory?: () => Promise<{ release(): Promise<void> }>;
  now?: () => Date;
}

type PersistentContextLauncher = (
  userDataDir: string,
  options: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>,
) => Promise<BrowserContext>;

export async function launchWebLaunchPersistentContext(
  profilePath: string,
  launcher: PersistentContextLauncher = (userDataDir, options) =>
    chromium.launchPersistentContext(userDataDir, options),
): Promise<BrowserContext> {
  return launcher(profilePath, {
    channel: "chrome",
    headless: false,
    chromiumSandbox: true,
    viewport: { width: 1280, height: 900 },
  });
}

export interface InjectAndSubmitPromptOptions {
  sendReadyTimeoutMs?: number;
}

type SendControlRank = "semantic" | "testid" | "label" | "submit" | "none";

interface InspectedSendGroup {
  rank: Exclude<SendControlRank, "none">;
  matched: number;
  visible: Locator[];
  enabled: Locator[];
}

interface SendControlSnapshot {
  associatedForm: boolean;
  semantic: number;
  testid: number;
  label: number;
  submit: number;
  selectedRank: SendControlRank;
  visible: number;
  enabled: number;
  enabledCandidates: Locator[];
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
  readonly #profileLeaseFactory: (() => Promise<BrowserProfileLease>) | undefined;
  readonly #now: () => Date;
  #context: BrowserContext | undefined;
  #lease: BrowserProfileLease | undefined;
  #contextCleanup: Promise<void> | undefined;
  #launchInFlight = false;

  constructor(allowedRoots: string[], options: WebLaunchBrowserOptions = {}) {
    this.#allowedRoots = [...allowedRoots];
    this.#contextFactory = options.contextFactory;
    this.#profileLeaseFactory = options.profileLeaseFactory;
    this.#now = options.now ?? (() => new Date());
  }

  async launchWebConversation(prompt: string): Promise<WebLaunchAcknowledgement> {
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
    if (this.#launchInFlight) {
      throw new WebLaunchBrowserError("WEB-LAUNCH-0 already has a launch in progress");
    }

    this.#launchInFlight = true;
    let page: Page | undefined;
    try {
      const context = await this.#ensureContext();
      const existingIdentities = new Set(
        context
          .pages()
          .map((candidate) => chatGptConversationIdentityFromUrl(candidate.url()))
          .filter((identity): identity is string => identity !== undefined),
      );

      page = await claimLaunchPage(context);
      await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await assertAuthenticated(page);
      if (chatGptConversationIdentityFromUrl(page.url())) {
        throw new WebLaunchBrowserError("WEB-LAUNCH-0 did not open a fresh ChatGPT conversation");
      }

      await page.evaluate((launchId) => {
        window.name = `devspace:web-launch-0:${launchId}`;
      }, randomUUID());
      await injectAndSubmitPrompt(page, prompt);

      const conversationIdentity = await waitForChatGptConversationIdentity(page);
      if (existingIdentities.has(conversationIdentity)) {
        throw new WebLaunchBrowserError(
          "WEB-LAUNCH-0 reused an existing ChatGPT conversation identity",
        );
      }

      await page.bringToFront().catch(() => undefined);
      return {
        slice: "WEB-LAUNCH-0",
        launchSuccess: true,
        conversationIdentitySha256: sha256(conversationIdentity),
        timestamp: this.#now().toISOString(),
        assistantOutputCaptured: false,
      };
    } catch (error) {
      await page?.close().catch(() => undefined);
      throw error;
    } finally {
      this.#launchInFlight = false;
    }
  }

  async close(): Promise<void> {
    const context = this.#context;
    const lease = this.#lease;
    const cleanup = this.#contextCleanup;
    this.#context = undefined;
    this.#lease = undefined;
    this.#contextCleanup = undefined;
    if (context) await context.close().catch(() => undefined);
    if (lease) await lease.release().catch(() => undefined);
    if (cleanup) await cleanup.catch(() => undefined);
  }

  async #ensureContext(): Promise<BrowserContext> {
    await this.#contextCleanup;
    if (this.#context) return this.#context;

    if (this.#contextFactory) {
      const lease = await this.#profileLeaseFactory?.();
      let context: BrowserContext | undefined;
      try {
        context = await this.#contextFactory();
        return await this.#adoptContext(context, lease);
      } catch (error) {
        if (!context) await lease?.release().catch(() => undefined);
        throw error;
      }
    }

    const profilePath = await resolveWebLaunchProfilePath(this.#allowedRoots);
    const lease = await acquireProfileLease(profilePath);
    let context: BrowserContext | undefined;
    try {
      context = await launchWebLaunchPersistentContext(profilePath);
      return await this.#adoptContext(context, lease);
    } catch (error) {
      if (!context) await lease.release().catch(() => undefined);
      throw new WebLaunchBrowserError(
        "unable to launch dedicated headed Chrome for ChatGPT automation",
        { cause: error },
      );
    }
  }

  async #adoptContext(
    context: BrowserContext,
    lease: BrowserProfileLease | undefined,
  ): Promise<BrowserContext> {
    this.#context = context;
    this.#lease = lease;
    context.once("close", () => this.#handleContextClose(context, lease));
    try {
      await this.#prepareContext(context);
      return context;
    } catch (error) {
      await this.#discardContext(context, lease);
      throw error;
    }
  }

  #handleContextClose(context: BrowserContext, lease: BrowserProfileLease | undefined): void {
    if (this.#context !== context) return;
    this.#context = undefined;
    if (this.#lease === lease) this.#lease = undefined;
    if (!lease) return;

    const release = lease.release().catch(() => undefined);
    let tracked: Promise<void>;
    tracked = release.finally(() => {
      if (this.#contextCleanup === tracked) this.#contextCleanup = undefined;
    });
    this.#contextCleanup = tracked;
  }

  async #discardContext(
    context: BrowserContext,
    lease: BrowserProfileLease | undefined,
  ): Promise<void> {
    const ownsLease = lease !== undefined && this.#lease === lease;
    if (this.#context === context) this.#context = undefined;
    if (ownsLease) this.#lease = undefined;
    await context.close().catch(() => undefined);
    if (ownsLease) await lease.release().catch(() => undefined);
    await this.#contextCleanup;
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

export async function injectAndSubmitPrompt(
  page: Page,
  prompt: string,
  options: InjectAndSubmitPromptOptions = {},
): Promise<void> {
  const composer = await findExactlyOneComposer(page);
  await insertAndVerifyPrompt(composer, prompt);
  await submitPrompt(
    page,
    composer,
    prompt,
    options.sendReadyTimeoutMs ?? SEND_READY_TIMEOUT_MS,
  );
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

export function chatGptConversationIdentityFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "chatgpt.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      if (parts[index] !== "c") continue;
      const id = parts[index + 1];
      if (id && /^[A-Za-z0-9_-]{8,200}$/.test(id)) return `chatgpt:c:${id}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function findExactlyOneComposer(page: Page, timeoutMs = 20_000): Promise<Locator> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const fallbackDeadline = Math.min(deadline, startedAt + FALLBACK_COMPOSER_GRACE_MS);
  let candidates: Locator[] = [];
  while (true) {
    await assertAuthenticated(page);
    candidates = await rankedComposerLocators(page);
    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      try {
        const isTransientFallback = await candidate.evaluate(
          (element) =>
            element instanceof HTMLTextAreaElement &&
            element.classList.contains("wcDTda_fallbackTextarea"),
        );
        if (!isTransientFallback || Date.now() >= fallbackDeadline) return candidate;
      } catch {
        // The hydration transition replaced this candidate; inspect a fresh DOM snapshot.
      }
    }
    const now = Date.now();
    if (now >= deadline) break;
    await page.waitForTimeout(Math.min(200, Math.max(1, deadline - now)));
  }
  if (candidates.length > 1) {
    throw new WebLaunchBrowserError(
      `found ${candidates.length} equally ranked ChatGPT composers`,
    );
  }
  throw new WebLaunchBrowserError("no credible ChatGPT composer was found");
}

type PromptInsertionStatus = "exact" | "readback-mismatch" | "error" | "detached";

interface PromptReadbackResult {
  actual: string;
  detached: boolean;
  exact: boolean;
}

export async function insertAndVerifyPrompt(composer: Locator, text: string): Promise<void> {
  const expected = normalizeText(text);
  const editor = await composerEditorType(composer);
  let fillFailed = false;
  try {
    await composer.fill(text, { timeout: 10_000 });
  } catch {
    fillFailed = true;
  }

  const fillReadback = await waitForPromptReadback(composer, expected);
  const fillStatus = promptInsertionStatus(fillReadback, fillFailed);
  if (fillReadback.exact) return;

  let nativeFailed = false;
  try {
    await replacePromptWithNativeEvents(composer, text);
  } catch {
    nativeFailed = true;
  }

  const nativeReadback = await waitForPromptReadback(composer, expected);
  const nativeStatus = promptInsertionStatus(nativeReadback, nativeFailed);
  if (nativeReadback.exact) return;

  throw new WebLaunchBrowserError(
    formatPromptInsertionFailure({
      editor,
      fillStatus,
      nativeStatus,
      expected,
      actual: nativeReadback.actual,
      detached: fillReadback.detached || nativeReadback.detached,
    }),
  );
}

async function waitForPromptReadback(
  composer: Locator,
  expected: string,
): Promise<PromptReadbackResult> {
  const deadline = Date.now() + PROMPT_READBACK_TIMEOUT_MS;
  let actual = "";
  while (true) {
    try {
      actual = normalizeText(await readComposerText(composer));
      if (actual === expected) return { actual, detached: false, exact: true };
    } catch {
      return { actual, detached: true, exact: false };
    }
    if (Date.now() >= deadline) return { actual, detached: false, exact: false };
    await composer.page().waitForTimeout(
      Math.min(PROMPT_READBACK_POLL_MS, Math.max(1, deadline - Date.now())),
    );
  }
}

function promptInsertionStatus(
  readback: PromptReadbackResult,
  operationFailed: boolean,
): PromptInsertionStatus {
  if (readback.exact) return "exact";
  if (readback.detached) return "detached";
  return operationFailed ? "error" : "readback-mismatch";
}

async function composerEditorType(composer: Locator): Promise<string> {
  try {
    return await composer.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) return "textarea";
      if (element instanceof HTMLInputElement) return "input";
      if (element instanceof HTMLElement && element.getAttribute("contenteditable") === "true") {
        return "contenteditable";
      }
      return element.tagName.toLowerCase();
    });
  } catch {
    return "detached";
  }
}

function formatPromptInsertionFailure({
  editor,
  fillStatus,
  nativeStatus,
  expected,
  actual,
  detached,
}: {
  editor: string;
  fillStatus: PromptInsertionStatus;
  nativeStatus: PromptInsertionStatus;
  expected: string;
  actual: string;
  detached: boolean;
}): string {
  return [
    "prompt insertion failed:",
    `editor=${editor}`,
    `fill=${fillStatus}`,
    `native=${nativeStatus}`,
    `expectedLength=${expected.length}`,
    `actualLength=${actual.length}`,
    `expectedNewlines=${newlineCount(expected)}`,
    `actualNewlines=${newlineCount(actual)}`,
    `detached=${detached}`,
  ].join("\n");
}

function newlineCount(value: string): number {
  return value.split("\n").length - 1;
}

async function submitPrompt(
  page: Page,
  composer: Locator,
  expected: string,
  sendReadyTimeoutMs: number,
): Promise<void> {
  if (normalizeText(await readComposerText(composer)) !== normalizeText(expected)) {
    throw new WebLaunchBrowserError("prompt changed before submission");
  }

  let readiness = await waitForAssociatedSendControl(page, composer, sendReadyTimeoutMs);
  if (!readiness.send && shouldReactivatePrompt(readiness.snapshot)) {
    try {
      await replacePromptWithNativeEvents(composer, expected);
      if (normalizeText(await readComposerText(composer)) !== normalizeText(expected)) {
        throw new Error("composer read-back did not match after native reactivation");
      }
    } catch (error) {
      throw new WebLaunchBrowserError("unable to reactivate prompt application state", {
        cause: error,
      });
    }
    readiness = await waitForAssociatedSendControl(page, composer, sendReadyTimeoutMs);
  }

  if (!readiness.send) {
    throw new WebLaunchBrowserError(formatSendControlFailure(readiness.snapshot));
  }

  const send = readiness.send;
  const stopWasVisible = (await credibleLocators(page.locator(STOP_SELECTOR))).length > 0;
  await send.click({ timeout: 5_000 });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (normalizeText(await readComposerText(composer)) === "") return;
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

async function replacePromptWithNativeEvents(composer: Locator, text: string): Promise<void> {
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
}

async function waitForAssociatedSendControl(
  page: Page,
  composer: Locator,
  timeoutMs: number,
): Promise<{ send?: Locator; snapshot: SendControlSnapshot }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let snapshot = await inspectAssociatedSendControls(composer);
  while (true) {
    if (
      snapshot.visible === 1 &&
      snapshot.enabled === 1 &&
      snapshot.enabledCandidates.length === 1
    ) {
      return { send: snapshot.enabledCandidates[0], snapshot };
    }
    if (Date.now() >= deadline) return { snapshot };
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    snapshot = await inspectAssociatedSendControls(composer);
  }
}

async function inspectAssociatedSendControls(composer: Locator): Promise<SendControlSnapshot> {
  const { container, associatedForm } = await composerAssociatedContainer(composer);
  const groups: Array<{
    rank: Exclude<SendControlRank, "none">;
    locator: Locator;
  }> = [
    {
      rank: "semantic",
      locator: container.getByRole("button", {
        name: SEND_ACCESSIBLE_NAME,
        includeHidden: true,
      }),
    },
    { rank: "testid", locator: container.locator(SEND_TESTID_SELECTOR) },
    { rank: "label", locator: container.locator(SEND_LABEL_SELECTOR) },
  ];
  if (associatedForm) {
    groups.push({ rank: "submit", locator: container.locator('button[type="submit"]') });
  }

  const inspected = await Promise.all(
    groups.map(async ({ rank, locator }): Promise<InspectedSendGroup> => {
      const candidates = await locator.all();
      const visible: Locator[] = [];
      const enabled: Locator[] = [];
      for (const candidate of candidates) {
        try {
          if (!(await candidate.isVisible())) continue;
          visible.push(candidate);
          if (await candidate.isEnabled()) enabled.push(candidate);
        } catch {
          // Ignore detached controls and inspect a fresh snapshot on the next poll.
        }
      }
      return { rank, matched: candidates.length, visible, enabled };
    }),
  );

  const selected =
    inspected.find((group) => group.visible.length > 0) ??
    inspected.find((group) => group.matched > 0);
  const byRank = new Map(inspected.map((group) => [group.rank, group]));
  return {
    associatedForm,
    semantic: byRank.get("semantic")?.matched ?? 0,
    testid: byRank.get("testid")?.matched ?? 0,
    label: byRank.get("label")?.matched ?? 0,
    submit: byRank.get("submit")?.matched ?? 0,
    selectedRank: selected?.rank ?? "none",
    visible: selected?.visible.length ?? 0,
    enabled: selected?.enabled.length ?? 0,
    enabledCandidates: selected?.enabled ?? [],
  };
}

async function composerAssociatedContainer(
  composer: Locator,
): Promise<{ container: Locator; associatedForm: boolean }> {
  const form = composer.locator("xpath=ancestor::form[1]");
  if ((await form.count()) === 1) return { container: form, associatedForm: true };

  const roleForm = composer.locator("xpath=ancestor::*[@role='form'][1]");
  if ((await roleForm.count()) === 1) return { container: roleForm, associatedForm: false };

  const namedComposer = composer.locator(
    "xpath=ancestor::*[contains(@data-testid, 'composer')][1]",
  );
  if ((await namedComposer.count()) === 1) {
    return { container: namedComposer, associatedForm: false };
  }

  const parent = composer.locator("xpath=parent::*");
  if ((await parent.count()) === 1) return { container: parent, associatedForm: false };
  throw new WebLaunchBrowserError("unable to resolve composer-associated send container");
}

function shouldReactivatePrompt(snapshot: SendControlSnapshot): boolean {
  return snapshot.selectedRank !== "none" && snapshot.visible === 1 && snapshot.enabled === 0;
}

function formatSendControlFailure(snapshot: SendControlSnapshot): string {
  const totalMatched = snapshot.semantic + snapshot.testid + snapshot.label + snapshot.submit;
  const state =
    totalMatched === 0
      ? "missing"
      : snapshot.visible === 0
        ? "hidden"
        : snapshot.visible > 1 || snapshot.enabled > 1
          ? "ambiguous"
          : snapshot.enabled === 0
            ? "disabled"
            : "not-ready";
  return [
    `send control not ready: state=${state}`,
    `semantic=${snapshot.semantic}`,
    `testid=${snapshot.testid}`,
    `label=${snapshot.label}`,
    `submit=${snapshot.submit}`,
    `rank=${snapshot.selectedRank}`,
    `visible=${snapshot.visible}`,
    `enabled=${snapshot.enabled}`,
    `associatedForm=${snapshot.associatedForm}`,
  ].join(" ");
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
    { selectors: [...COMPOSER_SELECTORS], sendSelector: SEND_ASSOCIATION_SELECTOR },
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
    if (url.hostname === "chatgpt.com" && /\/(auth|login|signup)(\/|$)/i.test(url.pathname)) {
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
): Promise<string> {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new WebLaunchBrowserError(
      "LOCALAPPDATA is required for the dedicated DevSpace ChatGPT browser profile",
    );
  }

  const requested = resolve(localAppData, "DevSpace", "browser-profiles", "chatgpt-fs0");
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

export interface ProfileLeaseOptions {
  processExists?: (pid: number) => boolean;
}

export interface ProfileLockRecord {
  pid: number;
  token: string;
  createdAt: string;
}

/**
 * True when the OS reports the PID as present or ownership is ambiguous.
 * ESRCH/missing → false (provably dead). EPERM/other → true (fail closed).
 */
export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return false;
    return true;
  }
}

export function parseProfileLockRecord(raw: string): ProfileLockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as { pid?: unknown; token?: unknown; createdAt?: unknown };
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined;
  if (typeof record.token !== "string" || record.token.length === 0) return undefined;
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0) return undefined;
  return {
    pid: record.pid as number,
    token: record.token,
    createdAt: record.createdAt,
  };
}

export async function acquireProfileLease(
  profilePath: string,
  options: ProfileLeaseOptions = {},
): Promise<BrowserProfileLease> {
  const lockPath = `${profilePath}.devspace.lock`;
  const exists = options.processExists ?? processExists;
  const token = randomUUID();

  const created = await tryCreateProfileLease(lockPath, token);
  if (!created) {
    await reclaimDeadProfileLock(lockPath, exists);
    const retried = await tryCreateProfileLease(lockPath, token);
    if (!retried) {
      throw new WebLaunchBrowserError("dedicated ChatGPT browser profile is already in use");
    }
  }

  const release = async (): Promise<void> => {
    try {
      const current = parseProfileLockRecord(await readFile(lockPath, "utf8"));
      if (current?.token === token) await rm(lockPath, { force: true });
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

async function tryCreateProfileLease(lockPath: string, token: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
    );
    await handle.close();
    return true;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isErrorCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function reclaimDeadProfileLock(
  lockPath: string,
  exists: (pid: number) => boolean,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw new WebLaunchBrowserError(
      "dedicated ChatGPT browser profile lock is unreadable and cannot be reclaimed",
    );
  }

  const record = parseProfileLockRecord(raw);
  if (!record) {
    throw new WebLaunchBrowserError(
      "dedicated ChatGPT browser profile lock is malformed and cannot be reclaimed",
    );
  }
  if (record.pid === process.pid) {
    throw new WebLaunchBrowserError("dedicated ChatGPT browser profile is already in use");
  }
  if (exists(record.pid)) {
    throw new WebLaunchBrowserError("dedicated ChatGPT browser profile is already in use");
  }

  // Re-read immediately before unlink so a live owner that rewrote the lock wins.
  let currentRaw: string;
  try {
    currentRaw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw new WebLaunchBrowserError(
      "dedicated ChatGPT browser profile lock ownership became ambiguous during reclaim",
    );
  }
  const current = parseProfileLockRecord(currentRaw);
  if (!current || current.token !== record.token || current.pid !== record.pid) {
    throw new WebLaunchBrowserError(
      "dedicated ChatGPT browser profile lock ownership became ambiguous during reclaim",
    );
  }
  if (exists(current.pid)) {
    throw new WebLaunchBrowserError("dedicated ChatGPT browser profile is already in use");
  }

  try {
    await rm(lockPath, { force: false });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw new WebLaunchBrowserError(
      "dedicated ChatGPT browser profile lock could not be reclaimed safely",
    );
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
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
