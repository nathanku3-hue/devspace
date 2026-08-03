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
  now?: () => Date;
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
  #context: BrowserContext | undefined;
  #lease: BrowserProfileLease | undefined;
  #launchInFlight = false;

  constructor(allowedRoots: string[], options: WebLaunchBrowserOptions = {}) {
    this.#allowedRoots = [...allowedRoots];
    this.#contextFactory = options.contextFactory;
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
    this.#context = undefined;
    this.#lease = undefined;
    if (context) await context.close().catch(() => undefined);
    if (lease) await lease.release().catch(() => undefined);
  }

  async #ensureContext(): Promise<BrowserContext> {
    if (this.#context) return this.#context;

    if (this.#contextFactory) {
      this.#context = await this.#contextFactory();
      await this.#prepareContext(this.#context);
      return this.#context;
    }

    const profilePath = await resolveWebLaunchProfilePath(this.#allowedRoots);
    this.#lease = await acquireProfileLease(profilePath);
    try {
      this.#context = await chromium.launchPersistentContext(profilePath, {
        channel: "chrome",
        headless: false,
        viewport: { width: 1280, height: 900 },
      });
      await this.#prepareContext(this.#context);
      return this.#context;
    } catch (error) {
      await this.#lease.release().catch(() => undefined);
      this.#lease = undefined;
      throw new WebLaunchBrowserError(
        "unable to launch dedicated headed Chrome for ChatGPT automation",
        { cause: error },
      );
    }
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
    if (normalizeText(await readComposerText(composer)) !== normalizeText(text)) {
      throw new Error("composer read-back did not match the requested prompt");
    }
  } catch (error) {
    throw new WebLaunchBrowserError("unable to insert and verify prompt", { cause: error });
  }
}

async function submitPrompt(page: Page, composer: Locator, expected: string): Promise<void> {
  if (normalizeText(await readComposerText(composer)) !== normalizeText(expected)) {
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
      throw new WebLaunchBrowserError("dedicated ChatGPT browser profile is already in use");
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
