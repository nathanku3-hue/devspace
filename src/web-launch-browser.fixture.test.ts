import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright-core";
import {
  chatGptConversationIdentityFromUrl,
  findExactlyOneComposer,
  insertAndVerifyPrompt,
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
      <button data-testid="send-button">Send</button>
    </main>
    <script>
      const composer = document.querySelector('textarea');
      const send = document.querySelector('button');
      send.addEventListener('click', () => {
        const conversationId = 'fixture-conversation-' + crypto.randomUUID().replaceAll('-', '');
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

test("composer insertion failures use prompt-neutral wording", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent('<main><button id="not-an-editor">fixed</button></main>');
    await assert.rejects(
      insertAndVerifyPrompt(page.locator("#not-an-editor"), "cannot insert"),
      (error: unknown) => {
        assert.ok(error instanceof WebLaunchBrowserError);
        assert.match(error.message, /prompt/i);
        assert.doesNotMatch(error.message, /reviewer packet/i);
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
