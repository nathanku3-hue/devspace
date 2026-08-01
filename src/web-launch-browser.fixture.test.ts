import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import {
  chatGptConversationIdentityFromUrl,
  findExactlyOneComposer,
  injectAndSubmitPrompt,
  insertAndVerifyPrompt,
  launchWebLaunchPersistentContext,
  readComposerText,
  resolveWebLaunchProfilePath,
  WebLaunchBrowserController,
  WebLaunchBrowserError,
} from "./web-launch-browser.js";

const execFileAsync = promisify(execFile);

const fixtureHtml = `
<!doctype html>
<html>
  <body>
    <main>
      <textarea aria-label="Prompt"></textarea>
      <button data-testid="send-button" disabled>Send</button>
    </main>
    <script>
      const composer = document.querySelector('textarea');
      const send = document.querySelector('button');
      composer.addEventListener('input', () => {
        setTimeout(() => {
          send.disabled = false;
        }, 50);
      });
      send.addEventListener('click', () => {
        const conversationId = 'fixture-conversation-' + crypto.randomUUID().replaceAll('-', '');
        document.body.dataset.submitCount = String(Number(document.body.dataset.submitCount || '0') + 1);
        document.body.dataset.submitted = composer.value;
        history.pushState({}, '', '/c/' + conversationId);
        composer.value = '';
        send.disabled = true;
      });
    </script>
  </body>
</html>`;

async function launchInstalledChrome(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `test:web-launch-browser prerequisite failed: installed Chrome is required (${reason})`,
    );
  }
}

async function gitStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}

test("conversation identity is accepted only from bounded ChatGPT conversation URLs", () => {
  assert.equal(chatGptConversationIdentityFromUrl("https://chatgpt.com/"), undefined);
  assert.equal(
    chatGptConversationIdentityFromUrl("https://chatgpt.com/c/conversation-12345678"),
    "chatgpt:c:conversation-12345678",
  );
  assert.equal(
    chatGptConversationIdentityFromUrl("https://example.com/c/conversation-12345678"),
    undefined,
  );
});

test("dedicated profile is rejected when it falls inside an allowed root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-profile-"));
  try {
    await assert.rejects(
      resolveWebLaunchProfilePath([parent], { LOCALAPPDATA: parent }),
      /outside every DevSpace allowed root/i,
    );
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("transient fallback textarea yields to the hydrated ProseMirror composer", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <textarea class="wcDTda_fallbackTextarea" aria-label="Chat with ChatGPT"></textarea>
          <div
            id="prompt-textarea"
            class="ProseMirror"
            role="textbox"
            contenteditable="true"
            aria-label="Chat with ChatGPT"
            hidden
          ></div>
        </form>
      </main>
      <script>
        setTimeout(() => {
          document.querySelector('textarea').style.display = 'none';
          document.querySelector('[contenteditable="true"]').hidden = false;
        }, 75);
      </script>
    `);

    const composer = await findExactlyOneComposer(page, 1_000);
    assert.equal(await composer.evaluate((element) => element.tagName.toLowerCase()), "div");
    assert.equal(await composer.getAttribute("id"), "prompt-textarea");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("headed Chrome launch explicitly enables the Chromium sandbox", async () => {
  let capturedProfilePath: string | undefined;
  let capturedOptions:
    | NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>
    | undefined;
  const sentinel = new Error("fixture launcher stop");

  await assert.rejects(
    launchWebLaunchPersistentContext("fixture-profile", async (profilePath, options) => {
      capturedProfilePath = profilePath;
      capturedOptions = options;
      throw sentinel;
    }),
    (error: unknown) => error === sentinel,
  );

  assert.equal(capturedProfilePath, "fixture-profile");
  assert.equal(capturedOptions?.channel, "chrome");
  assert.equal(capturedOptions?.headless, false);
  assert.equal(capturedOptions?.chromiumSandbox, true);
});

test("composer adapter collapses nested layers and uses native insertion without implicit submit", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <div id="outer-editor" role="textbox" contenteditable="true" style="min-height:40px;width:500px">
            <textarea id="prompt-textarea" style="min-height:32px;width:480px"></textarea>
          </div>
          <button data-testid="send-button" type="button">Send</button>
        </form>
      </main>
      <script>
        const editor = document.querySelector('#prompt-textarea');
        const send = document.querySelector('[data-testid="send-button"]');
        let firstInput = true;
        let inputCount = 0;
        let enterCount = 0;
        let submitCount = 0;
        editor.addEventListener('input', () => {
          inputCount += 1;
          if (firstInput) {
            firstInput = false;
            editor.value = '';
          }
          document.body.dataset.inputCount = String(inputCount);
        });
        editor.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') enterCount += 1;
          document.body.dataset.enterCount = String(enterCount);
        });
        send.addEventListener('click', () => {
          submitCount += 1;
          document.body.dataset.submitCount = String(submitCount);
        });
      </script>
    `);

    const composer = await findExactlyOneComposer(page, 1_000);
    assert.equal(await composer.getAttribute("id"), "prompt-textarea");
    const prompt = "  First  line\nUnicode=測試\nLast  ";
    await insertAndVerifyPrompt(composer, prompt);

    assert.equal(await readComposerText(composer), prompt);
    assert.ok(Number(await page.evaluate(() => document.body.dataset.inputCount ?? "0")) >= 2);
    assert.equal(await page.evaluate(() => document.body.dataset.enterCount ?? "0"), "0");
    assert.equal(await page.evaluate(() => document.body.dataset.submitCount ?? "0"), "0");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("live fallback textarea waits for delayed fill read-back without native fallback", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <textarea class="wcDTda_fallbackTextarea">existing draft</textarea>
          <button type="button" aria-label="Send">Send</button>
        </form>
      </main>
      <script>
        const composer = document.querySelector('textarea');
        let delayNextFill = true;
        composer.addEventListener('input', () => {
          if (!delayNextFill) return;
          delayNextFill = false;
          const requested = composer.value;
          composer.value = '';
          setTimeout(() => {
            composer.value = requested;
          }, 125);
        });
        composer.addEventListener('keydown', (event) => {
          if (event.key === 'Backspace') {
            document.body.dataset.nativeBackspaceCount = String(
              Number(document.body.dataset.nativeBackspaceCount || '0') + 1,
            );
          }
        });
      </script>
    `);

    const composer = await findExactlyOneComposer(page, 500);
    const prompt = "DEVSPACE_INSERT_PROBE_20260801\nUnicode=測試\nEND";
    await insertAndVerifyPrompt(composer, prompt);

    assert.equal(await readComposerText(composer), prompt);
    assert.equal(await page.evaluate(() => document.body.dataset.nativeBackspaceCount), undefined);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("send readiness waits for asynchronous enablement before one click", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <textarea id="prompt-textarea"></textarea>
          <button type="button" data-testid="send-button" aria-label="Submit" disabled>→</button>
        </form>
      </main>
      <script>
        const composer = document.querySelector('#prompt-textarea');
        const send = document.querySelector('[data-testid="send-button"]');
        composer.addEventListener('input', () => {
          setTimeout(() => {
            send.disabled = false;
          }, 75);
        });
        send.addEventListener('click', () => {
          document.body.dataset.submitCount = String(Number(document.body.dataset.submitCount || '0') + 1);
          document.body.dataset.submitted = composer.value;
          composer.value = '';
          send.disabled = true;
        });
      </script>
    `);

    await injectAndSubmitPrompt(page, "asynchronous readiness", { sendReadyTimeoutMs: 1_000 });
    assert.equal(await page.evaluate(() => document.body.dataset.submitCount), "1");
    assert.equal(await page.evaluate(() => document.body.dataset.submitted), "asynchronous readiness");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("exact aria-label Send is a supported associated control", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <textarea id="prompt-textarea"></textarea>
          <button type="button" aria-label="Send">→</button>
        </form>
      </main>
      <script>
        const composer = document.querySelector('#prompt-textarea');
        const send = document.querySelector('button');
        send.addEventListener('click', () => {
          document.body.dataset.submitCount = String(Number(document.body.dataset.submitCount || '0') + 1);
          composer.value = '';
          send.disabled = true;
        });
      </script>
    `);

    await injectAndSubmitPrompt(page, "exact send label", { sendReadyTimeoutMs: 250 });
    assert.equal(await page.evaluate(() => document.body.dataset.submitCount), "1");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("form-scoped submit fallback ignores an unrelated page submit button", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="unrelated-form">
        <button id="unrelated-submit" type="submit">Save settings</button>
      </form>
      <main>
        <form id="composer-form">
          <textarea id="prompt-textarea"></textarea>
          <button id="composer-submit" type="submit">Launch</button>
        </form>
      </main>
      <script>
        const composer = document.querySelector('#prompt-textarea');
        const localForm = document.querySelector('#composer-form');
        const localSend = document.querySelector('#composer-submit');
        document.querySelector('#unrelated-form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.body.dataset.unrelatedSubmitCount = String(Number(document.body.dataset.unrelatedSubmitCount || '0') + 1);
        });
        localForm.addEventListener('submit', (event) => event.preventDefault());
        localSend.addEventListener('click', () => {
          document.body.dataset.localSubmitCount = String(Number(document.body.dataset.localSubmitCount || '0') + 1);
          document.body.dataset.submitted = composer.value;
          composer.value = '';
          localSend.disabled = true;
        });
      </script>
    `);

    await injectAndSubmitPrompt(page, "form scoped", { sendReadyTimeoutMs: 250 });
    assert.equal(await page.evaluate(() => document.body.dataset.localSubmitCount), "1");
    assert.equal(await page.evaluate(() => document.body.dataset.unrelatedSubmitCount), undefined);
    assert.equal(await page.evaluate(() => document.body.dataset.submitted), "form scoped");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("send diagnostics distinguish missing, hidden, and disabled controls", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();

    await page.setContent('<main><form><textarea id="prompt-textarea"></textarea></form></main>');
    await assert.rejects(
      injectAndSubmitPrompt(page, "missing", { sendReadyTimeoutMs: 25 }),
      (error: unknown) => {
        assert.ok(error instanceof WebLaunchBrowserError);
        assert.match(error.message, /state=missing/);
        assert.match(error.message, /testid=0/);
        assert.match(error.message, /visible=0 enabled=0/);
        assert.match(error.message, /associatedForm=true/);
        return true;
      },
    );

    await page.setContent(`
      <main><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" aria-label="Submit" style="display:none">→</button></form></main>
    `);
    await assert.rejects(
      injectAndSubmitPrompt(page, "hidden", { sendReadyTimeoutMs: 25 }),
      (error: unknown) => {
        assert.ok(error instanceof WebLaunchBrowserError);
        assert.match(error.message, /state=hidden/);
        assert.match(error.message, /testid=1/);
        assert.match(error.message, /visible=0 enabled=0/);
        return true;
      },
    );

    await page.setContent(`
      <main><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" aria-label="Submit" disabled>→</button></form></main>
    `);
    const sensitivePrompt = "private Unicode 測試";
    await assert.rejects(
      injectAndSubmitPrompt(page, sensitivePrompt, { sendReadyTimeoutMs: 25 }),
      (error: unknown) => {
        assert.ok(error instanceof WebLaunchBrowserError);
        assert.match(error.message, /state=disabled/);
        assert.match(error.message, /testid=1/);
        assert.match(error.message, /visible=1 enabled=0/);
        assert.doesNotMatch(error.message, new RegExp(sensitivePrompt));
        return true;
      },
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

test("two equally credible associated send controls fail closed", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <textarea id="prompt-textarea"></textarea>
          <button type="button" aria-label="Send">one</button>
          <button type="button" aria-label="Send prompt">two</button>
        </form>
      </main>
    `);

    await assert.rejects(
      injectAndSubmitPrompt(page, "ambiguous", { sendReadyTimeoutMs: 25 }),
      (error: unknown) => {
        assert.ok(error instanceof WebLaunchBrowserError);
        assert.match(error.message, /state=ambiguous/);
        assert.match(error.message, /semantic=2/);
        assert.match(error.message, /rank=semantic visible=2 enabled=2/);
        return true;
      },
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

test("disabled application state triggers one native reactivation with exact multiline Unicode", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <textarea id="prompt-textarea"></textarea>
          <button type="button" data-testid="send-button" aria-label="Submit" disabled>→</button>
        </form>
      </main>
      <script>
        const composer = document.querySelector('#prompt-textarea');
        const send = document.querySelector('[data-testid="send-button"]');
        let nativeClearSeen = false;
        composer.addEventListener('keydown', (event) => {
          if (event.key === 'Backspace') {
            nativeClearSeen = true;
            document.body.dataset.reactivationCount = String(Number(document.body.dataset.reactivationCount || '0') + 1);
          }
          if (event.key === 'Enter') {
            document.body.dataset.enterCount = String(Number(document.body.dataset.enterCount || '0') + 1);
          }
        });
        composer.addEventListener('input', () => {
          if (nativeClearSeen && composer.value.length > 0) send.disabled = false;
        });
        send.addEventListener('click', () => {
          document.body.dataset.submitCount = String(Number(document.body.dataset.submitCount || '0') + 1);
          document.body.dataset.submitted = composer.value;
          composer.value = '';
          send.disabled = true;
        });
      </script>
    `);

    const prompt = "  First line\nUnicode=測試🚀\nLast  ";
    await injectAndSubmitPrompt(page, prompt, { sendReadyTimeoutMs: 50 });
    assert.equal(await page.evaluate(() => document.body.dataset.reactivationCount), "1");
    assert.equal(await page.evaluate(() => document.body.dataset.enterCount), undefined);
    assert.equal(await page.evaluate(() => document.body.dataset.submitCount), "1");
    assert.equal(await page.evaluate(() => document.body.dataset.submitted), prompt);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("composer reader reconstructs block-editor line breaks without trimming spaces", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <div id="prompt-textarea" class="ProseMirror" data-lexical-editor="true" contenteditable="true" style="min-height:32px;width:480px"><p><span>first  line</span></p><p><span>Unicode=測試  </span></p></div>
          <button data-testid="send-button" type="button">Send</button>
        </form>
      </main>
    `);
    const composer = await findExactlyOneComposer(page, 500);
    assert.equal(await readComposerText(composer), "first  line\nUnicode=測試  ");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("composer adapter prefers a send-associated editor and fails closed on a true tie", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <aside><div id="decoy" contenteditable="true">decoy</div></aside>
        <form>
          <div id="real" contenteditable="true"></div>
          <button data-testid="send-button" type="button">Send</button>
        </form>
      </main>
    `);
    assert.equal(await (await findExactlyOneComposer(page, 500)).getAttribute("id"), "real");

    await page.setContent(`
      <main>
        <form><div id="first" contenteditable="true"></div><button data-testid="send-button" type="button">Send</button></form>
        <form><div id="second" contenteditable="true"></div><button aria-label="Send prompt" type="button">Send</button></form>
      </main>
    `);
    await assert.rejects(findExactlyOneComposer(page, 100), /equally ranked/i);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("composer insertion failures preserve stage diagnostics without prompt content", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent('<main><button id="not-an-editor">fixed</button></main>');
    const sensitivePrompt = "reviewer packet Unicode=測試";
    await assert.rejects(
      insertAndVerifyPrompt(page.locator("#not-an-editor"), sensitivePrompt),
      (error: unknown) => {
        assert.ok(error instanceof WebLaunchBrowserError);
        assert.match(error.message, /prompt insertion failed:/i);
        assert.match(error.message, /editor=button/);
        assert.match(error.message, /fill=error/);
        assert.match(error.message, /native=(error|readback-mismatch)/);
        assert.match(error.message, /expectedLength=26/);
        assert.match(error.message, /actualLength=5/);
        assert.match(error.message, /expectedNewlines=0/);
        assert.match(error.message, /actualNewlines=0/);
        assert.match(error.message, /detached=false/);
        assert.doesNotMatch(error.message, /reviewer packet/);
        assert.doesNotMatch(error.message, /Unicode=測試/);
        return true;
      },
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

test("WEB-LAUNCH-0 submits one exact prompt and returns acknowledgement only", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-0-"));
  const browser = await launchInstalledChrome();
  const originalStatus = await gitStatus(process.cwd());
  let controller: WebLaunchBrowserController | undefined;
  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml }),
    );
    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => context,
      now: () => new Date("2026-07-31T15:00:00.000Z"),
    });

    const prompt = "  Exact prompt with two spaces  \nUnicode: 測試\nNo continuation.";
    const acknowledgement = await controller.launchWebConversation(prompt);
    const conversationPages = context
      .pages()
      .filter((page) => chatGptConversationIdentityFromUrl(page.url()) !== undefined);

    assert.equal(conversationPages.length, 1);
    assert.equal(await conversationPages[0]!.evaluate(() => document.body.dataset.submitted), prompt);
    assert.deepEqual(acknowledgement, {
      slice: "WEB-LAUNCH-0",
      launchSuccess: true,
      conversationIdentitySha256: acknowledgement.conversationIdentitySha256,
      timestamp: "2026-07-31T15:00:00.000Z",
      assistantOutputCaptured: false,
    });
    assert.match(acknowledgement.conversationIdentitySha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(acknowledgement).sort(), [
      "assistantOutputCaptured",
      "conversationIdentitySha256",
      "launchSuccess",
      "slice",
      "timestamp",
    ]);
    assert.equal("assistantOutput" in acknowledgement, false);
    await assert.rejects(
      controller.launchWebConversation("line one\r\nline two"),
      /rejects carriage returns/i,
    );
    assert.equal(await gitStatus(process.cwd()), originalStatus);
  } finally {
    await controller?.close();
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("closed cached context releases its lease before a fresh context submits once", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-recovery-"));
  const browser = await launchInstalledChrome();
  const contexts: BrowserContext[] = [];
  const releasedLeases: number[] = [];
  let controller: WebLaunchBrowserController | undefined;
  let contextFactoryCalls = 0;
  let leaseFactoryCalls = 0;
  let releaseFirstLease!: () => void;
  let markFirstReleaseStarted!: () => void;
  const firstLeaseGate = new Promise<void>((resolve) => {
    releaseFirstLease = resolve;
  });
  const firstReleaseStarted = new Promise<void>((resolve) => {
    markFirstReleaseStarted = resolve;
  });

  try {
    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => {
        contextFactoryCalls += 1;
        const context = await browser.newContext();
        await context.route("https://chatgpt.com/**", (route) =>
          route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml }),
        );
        contexts.push(context);
        return context;
      },
      profileLeaseFactory: async () => {
        leaseFactoryCalls += 1;
        const leaseNumber = leaseFactoryCalls;
        return {
          release: async () => {
            releasedLeases.push(leaseNumber);
            if (leaseNumber === 1) {
              markFirstReleaseStarted();
              await firstLeaseGate;
            }
          },
        };
      },
    });

    await controller.launchWebConversation("first prompt");
    const firstConversation = contexts[0]!
      .pages()
      .find((page) => chatGptConversationIdentityFromUrl(page.url()) !== undefined);
    assert.ok(firstConversation);
    assert.equal(await firstConversation.evaluate(() => document.body.dataset.submitted), "first prompt");
    assert.equal(await firstConversation.evaluate(() => document.body.dataset.submitCount), "1");

    const closeFirstContext = contexts[0]!.close();
    await Promise.race([
      firstReleaseStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("context close did not start lease release")), 5_000),
      ),
    ]);
    const secondLaunch = controller.launchWebConversation("second prompt");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(contextFactoryCalls, 1);
    assert.deepEqual(releasedLeases, [1]);

    releaseFirstLease();
    await closeFirstContext;
    await secondLaunch;

    assert.equal(contextFactoryCalls, 2);
    assert.equal(leaseFactoryCalls, 2);
    const secondConversation = contexts[1]!
      .pages()
      .find((page) => chatGptConversationIdentityFromUrl(page.url()) !== undefined);
    assert.ok(secondConversation);
    assert.equal(
      await secondConversation.evaluate(() => document.body.dataset.submitted),
      "second prompt",
    );
    assert.equal(await secondConversation.evaluate(() => document.body.dataset.submitCount), "1");
  } finally {
    releaseFirstLease();
    await controller?.close();
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("WEB-LAUNCH-0 rejects concurrent launches before a second page is claimed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-concurrency-"));
  const browser = await launchInstalledChrome();
  let controller: WebLaunchBrowserController | undefined;
  let releaseContext!: () => void;
  let markContextRequested!: () => void;
  const contextGate = new Promise<void>((resolve) => {
    releaseContext = resolve;
  });
  const contextRequested = new Promise<void>((resolve) => {
    markContextRequested = resolve;
  });

  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml }),
    );
    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => {
        markContextRequested();
        await contextGate;
        return context;
      },
    });

    const first = controller.launchWebConversation("first launch");
    await contextRequested;
    await assert.rejects(
      controller.launchWebConversation("second launch"),
      /launch in progress/i,
    );
    releaseContext();
    await first;
    assert.equal(
      context
        .pages()
        .filter((page) => chatGptConversationIdentityFromUrl(page.url()) !== undefined).length,
      1,
    );
  } finally {
    releaseContext();
    await controller?.close();
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
