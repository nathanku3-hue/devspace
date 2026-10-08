import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import {
  activateDevSpaceForConversation,
  approveDevSpaceAlwaysPermissionIfPresent,
  chatConversationIdentityFromUrl,
  deleteConversationHistoryFromSidebar,
  detectDevSpaceRecoverySignal,
  chatGptConversationIdentityFromUrl,
  devSpacePluginIdFromUrl,
  ensureChatShareDevSpacePluginConnectedForRecovery,
  ensureDevSpacePluginConnectedForRecovery,
  findExactlyOneComposer,
  hasDeliveryTimeoutMessage,
  hasDevSpaceConversationEvidence,
  hasDevSpaceInterruptionMessage,
  injectAndSubmitConnectedPrompt,
  insertAndVerifyPrompt,
  isDevSpaceSilentStallCandidate,
  resumeDevSpaceConversationIfInterrupted,
  watchForDevSpaceChatShareRecovery,
  isProcessAlive,
  navigateToConnectedDevSpaceSurface,
  prepareChatShareSession,
  refreshDevSpacePluginRegistration,
  readComposerText,
  resolveDevSpacePluginId,
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

test("chat conversation identity accepts bounded ChatGPT and ChatShare routes", () => {
  assert.equal(
    chatConversationIdentityFromUrl("https://chatgpt.com/c/conversation-12345678"),
    "chatgpt.com:c:conversation-12345678",
  );
  assert.equal(
    chatConversationIdentityFromUrl("https://chatshare.xyz/c/conversation-12345678"),
    "chatshare.xyz:c:conversation-12345678",
  );
  assert.equal(
    chatConversationIdentityFromUrl("https://example.com/c/conversation-12345678"),
    undefined,
  );
});

test("DevSpace plugin identity is extracted only from bounded chat surface plugin routes", () => {
  assert.equal(
    devSpacePluginIdFromUrl("https://chatgpt.com/plugins/plugin_asdk_app_fixture123"),
    "asdk_app_fixture123",
  );
  assert.equal(
    devSpacePluginIdFromUrl("https://chatshare.xyz/plugins/plugin_asdk_app_fixture123"),
    "asdk_app_fixture123",
  );
  assert.equal(
    devSpacePluginIdFromUrl(
      "https://chatshare.xyz/#settings/Plugins/plugin_asdk_app_fixture123",
    ),
    "asdk_app_fixture123",
  );
  assert.equal(
    devSpacePluginIdFromUrl(
      "https://chatshare.xyz/plugins/plugin_asdk_app_fixture123#settings/Plugins/plugin_asdk_app_fixture123",
    ),
    "asdk_app_fixture123",
  );
  assert.equal(
    devSpacePluginIdFromUrl("https://example.com/plugins/plugin_asdk_app_fixture123"),
    undefined,
  );
  assert.equal(devSpacePluginIdFromUrl("https://chatgpt.com/plugins"), undefined);
});

test("multiple named DevSpace plugin registrations are rejected as ambiguous", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
<a href="https://chatshare.xyz/plugins/plugin_asdk_app_duplicate11111111">DevSpace Local</a>
<a href="https://chatshare.xyz/plugins/plugin_asdk_app_duplicate22222222">devspace</a>
</body></html>`);

    await assert.rejects(
      resolveDevSpacePluginId(page, 300),
      /found 2 DevSpace plugin registrations.*refusing an ambiguous connector state/i,
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

test("multiple named DevSpace plugin registrations are rejected as ambiguous", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
<a href="https://chatshare.xyz/plugins/plugin_asdk_app_duplicate11111111">DevSpace Local</a>
<a href="https://chatshare.xyz/plugins/plugin_asdk_app_duplicate22222222">devspace</a>
</body></html>`);

    await assert.rejects(
      resolveDevSpacePluginId(page, 300),
      /found 2 DevSpace plugin registrations.*refusing an ambiguous connector state/i,
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

test("process liveness distinguishes the current process from a dead PID", async () => {
  assert.equal(await isProcessAlive(process.pid), true);
  assert.equal(await isProcessAlive(2_147_483_647), false);
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

test("ChatShare uses an isolated dedicated browser profile", async () => {
  const allowedRoot = await mkdtemp(join(tmpdir(), "devspace-chatshare-allowed-"));
  const localAppData = await mkdtemp(join(tmpdir(), "devspace-chatshare-localappdata-"));
  try {
    const profile = await resolveWebLaunchProfilePath(
      [allowedRoot],
      { LOCALAPPDATA: localAppData },
      "chatshare",
    );
    assert.ok(profile.endsWith(join("DevSpace", "browser-profiles", "chatshare-fs0")));
  } finally {
    await rm(allowedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(localAppData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

test("composer adapter accepts ProseMirror NBSP rendering for indented multiline prompts", async () => {
  const browser = await launchInstalledChrome();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox" aria-multiline="true" style="min-height:32px;width:480px"></div>
          <button data-testid="send-button" type="button">Send</button>
        </form>
      </main>
    `);
    const composer = await findExactlyOneComposer(page, 500);
    const prompt = "line1\n\nline3\n  indented\nlast";
    await insertAndVerifyPrompt(composer, prompt);
    assert.equal((await readComposerText(composer)).replace(/\u00a0/g, " "), prompt);
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

test("WEB-LAUNCH-0 deduplicates concurrent retries of the same prompt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-dedupe-"));
  const browser = await launchInstalledChrome();
  let controller: WebLaunchBrowserController | undefined;
  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml });
    });
    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => context,
      now: () => new Date("2026-07-31T15:05:00.000Z"),
    });

    const prompt = "single-flight retry probe";
    const first = controller.launchWebConversation(prompt);
    const second = controller.launchWebConversation(prompt);
    await assert.rejects(
      controller.launchWebConversation("different prompt while busy"),
      /already has a launch in progress/i,
    );

    const [firstAck, secondAck] = await Promise.all([first, second]);
    assert.deepEqual(secondAck, firstAck);

    const conversationPages = context
      .pages()
      .filter((page) => chatGptConversationIdentityFromUrl(page.url()) !== undefined);
    assert.equal(conversationPages.length, 1);
    assert.equal(
      await conversationPages[0]!.evaluate(() => document.body.dataset.submitted),
      prompt,
    );
  } finally {
    await controller?.close();
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ChatShare provider selects an available Pro session and reuses it on the next launch", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-chatshare-"));
  const browser = await launchInstalledChrome();
  let controller: WebLaunchBrowserController | undefined;
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem("crtUse", "pro-preferred"));
    let activeTeamSession = false;
    let loginSessionCalls = 0;
    let postLoginRootVisits = 0;
    await context.route("https://chatshare.xyz/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/pastel/") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><main>car list</main></body></html>",
        });
      }
      if (url.pathname === "/frontend-api/carpage") {
        const headers = route.request().headers();
        assert.equal(headers.themeid, "pastel");
        assert.equal(headers["accept-language"], "zh-CN");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            code: 1,
            data: {
              code: 1,
              data: {
                list: [
                  { carID: "plus-busy", status: 1, clears_in: 0, team_clears_in: 0, count: 5, isPlus: true, isPro: false, isTeam: false },
                  { carID: "pro-free", status: 1, clears_in: 0, team_clears_in: 0, count: 9, isPlus: true, isPro: true, isTeam: false },
                  { carID: "pro-preferred", status: 1, clears_in: 0, team_clears_in: 0, count: 20, isPlus: true, isPro: true, isTeam: false },
                ],
              },
            },
          }),
        });
      }
      if (url.pathname === "/auth/loginSession") {
        assert.equal(url.searchParams.get("carid"), "pro-preferred");
        assert.equal(url.searchParams.get("carType"), "chatgpt");
        loginSessionCalls += 1;
        activeTeamSession = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: "{\"code\":1}" });
      }
      if (url.pathname === "/plugins") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: '<!doctype html><html><body><main><a href="/plugins/plugin_asdk_app_alwayson12345678">devspace</a></main></body></html>',
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_alwayson12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main>
<p>Actions source_resolve_start source_resolve_status source_resolve_submit</p>
<button id="try" type="button">Try in chat</button>
</main>
<script>
  document.querySelector('#try').addEventListener('click', () => {
    history.pushState({}, '', '/?surface=work&hints=plugin%3Aasdk_app_alwayson12345678');
    document.querySelector('main').innerHTML = '<form><div id="prompt-textarea" role="textbox" contenteditable="true"><p><span data-inline-selection-pill="" data-keyword="devspace" contenteditable="false"><span>devspace</span></span></p></div><button data-testid="send-button" type="button">Send</button></form><div id="consent" hidden><p>ChatGPT needs access to devspace to help with this request.</p><button id="connect" type="button">Connect</button></div>';
    const composer = document.querySelector('#prompt-textarea');
    const consent = document.querySelector('#consent');
    document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
      const editableClone = composer.cloneNode(true);
      editableClone.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
      document.body.dataset.submitted = editableClone.textContent;
      history.pushState({}, '', '/c/fixture-conversation-' + crypto.randomUUID().replaceAll('-', ''));
      composer.innerHTML = '';
      consent.hidden = false;
    });
    document.querySelector('#connect').addEventListener('click', () => {
      consent.remove();
    });
  });
</script></body></html>`,
        });
      }
      if (url.pathname === "/") {
        if (!activeTeamSession) {
          return route.fulfill({
            status: 302,
            headers: { location: "https://chatshare.xyz/pastel/#/carlist" },
            body: "",
          });
        }
        postLoginRootVisits += 1;
        if (postLoginRootVisits === 1) {
          return route.fulfill({
            status: 302,
            headers: { location: "https://chatshare.xyz/pastel/#/carlist" },
            body: "",
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main id="app"></main>
<script>
  const app = document.querySelector('#app');
  function renderDetail() {
    app.innerHTML = '<a href="/#settings/Plugins/plugin_asdk_app_alwayson12345678">devspace</a><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button id="try" type="button">Try in chat</button>';
    document.querySelector('#try').addEventListener('click', () => {
      history.pushState({}, '', '/?surface=work&hints=plugin%3Aasdk_app_alwayson12345678');
      app.innerHTML = '<form><div id="prompt-textarea" role="textbox" contenteditable="true"><p><span data-inline-selection-pill="" data-keyword="devspace" contenteditable="false"><span>devspace</span></span></p></div><button data-testid="send-button" type="button">Send</button></form><div id="consent" hidden><p>ChatGPT needs access to devspace to help with this request.</p><button id="connect" type="button">Connect</button></div>';
      const composer = document.querySelector('#prompt-textarea');
      const consent = document.querySelector('#consent');
      document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
        const editableClone = composer.cloneNode(true);
        editableClone.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
        document.body.dataset.submitted = editableClone.textContent;
        history.pushState({}, '', '/c/fixture-conversation-' + crypto.randomUUID().replaceAll('-', ''));
        composer.innerHTML = '';
        consent.hidden = false;
      });
      document.querySelector('#connect').addEventListener('click', () => {
        consent.remove();
      });
    });
  }
  renderDetail();
</script>
</body></html>`,
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });

    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => context,
      sessionProvider: "chatshare",
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });

    const prompt = "ChatShare migration probe";
    const acknowledgement = await controller.launchWebConversation(prompt);
    const secondPrompt = "ChatShare nested reuse probe";
    const secondAcknowledgement = await controller.launchWebConversation(secondPrompt);
    const conversationPages = context
      .pages()
      .filter((page) => chatConversationIdentityFromUrl(page.url()) !== undefined);

    assert.equal(conversationPages.length, 2);
    assert.ok(
      await Promise.all(
        conversationPages.map((page) => page.evaluate(() => document.body.dataset.submitted)),
      ).then((submitted) => submitted.includes(prompt)),
    );
    assert.ok(
      await Promise.all(
        conversationPages.map((page) => page.evaluate(() => document.body.dataset.submitted)),
      ).then((submitted) => submitted.includes(secondPrompt)),
    );
    assert.equal(loginSessionCalls, 1);
    assert.ok(postLoginRootVisits >= 2);
    assert.equal(acknowledgement.launchSuccess, true);
    assert.equal(secondAcknowledgement.launchSuccess, true);
  } finally {
    await controller?.close();
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ChatShare UI registration fallback enables developer settings before Browse plugins without using /plugins", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatshare.xyz/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/") {
        return route.fulfill({ status: 404, body: "direct plugin routes are unavailable" });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><main id="app"></main>
<script>
  const app = document.querySelector('#app');
  let developerMode = false;
  let enforceCsp = false;
  if (
    location.hash.startsWith('#settings') &&
    localStorage.getItem('ui-settings-menu') !== 'true'
  ) {
    localStorage.setItem('direct-settings-attempt', 'true');
  }

  function renderHome() {
    history.replaceState({}, '', '/');
    app.innerHTML =
      '<button data-testid="accounts-profile-button" aria-label="Open profile menu" type="button">Profile</button>' +
      '<div id="profile-menu" hidden><button id="settings-menu" type="button">設定</button></div>';
    document.querySelector('[data-testid="accounts-profile-button"]').addEventListener('click', () => {
      localStorage.setItem('ui-profile-menu', 'true');
      document.querySelector('#profile-menu').hidden = false;
    });
    document.querySelector('#settings-menu').addEventListener('click', () => {
      localStorage.setItem('ui-settings-menu', 'true');
      history.replaceState({}, '', '/#settings');
      app.innerHTML = '';
      setTimeout(renderGeneral, 300);
    });
  }

  function nav() {
    return '<nav>' +
      '<button role="tab" id="general-nav" type="button">General</button>' +
      '<button role="tab" id="security-nav" type="button">Security and login</button>' +
      '<button role="tab" id="plugins-nav" type="button">Plugins</button>' +
      '</nav>';
  }

  function wireNav() {
    document.querySelector('#general-nav')?.addEventListener('click', renderGeneral);
    document.querySelector('#security-nav')?.addEventListener('click', renderSecurity);
    document.querySelector('#plugins-nav')?.addEventListener('click', renderPlugins);
  }

  function renderGeneral() {
    history.replaceState({}, '', '/#settings');
    app.innerHTML = nav() + '<section><h2>General</h2></section>';
    wireNav();
  }

  function renderSecurity() {
    history.replaceState({}, '', '/#settings/Security');
    app.innerHTML = nav() +
      '<section><h2>Security and login</h2>' +
      '<div id="developer-row"><span>Developer mode</span><button id="developer-toggle" role="switch" aria-checked="' + String(developerMode) + '" type="button"></button></div>' +
      '<div id="csp-row"><span>Enforce CSP in developer mode</span><button id="csp-toggle" role="switch" aria-checked="' + String(enforceCsp) + '" type="button"' + (developerMode ? '' : ' disabled') + '></button></div>' +
      '</section>';
    wireNav();
    document.querySelector('#developer-toggle').addEventListener('click', () => {
      developerMode = true;
      localStorage.setItem('ui-developer-mode', 'true');
      renderSecurity();
    });
    document.querySelector('#csp-toggle').addEventListener('click', () => {
      enforceCsp = true;
      localStorage.setItem('ui-enforce-csp', 'true');
      renderSecurity();
    });
  }

  function renderPlugins() {
    history.replaceState({}, '', '/#settings/Plugins');
    app.innerHTML = nav() +
      '<section><h2>Plugins</h2>' +
      '<button id="browse" type="button">Browse plugins</button>' +
      '<div id="browser" hidden><input placeholder="Search plugins" /><button id="add" type="button">+</button></div>' +
      '<div role="dialog" id="new-plugin" hidden><h2>New Plugin</h2>' +
      '<label>Name <input aria-label="Name" /></label>' +
      '<label>Server URL <input aria-label="Server URL" type="url" /></label>' +
      '<div>Authentication <span>OAuth</span></div>' +
      '<label><input aria-label="I understand and want to continue" type="checkbox" /> I understand and want to continue</label>' +
      '<button id="create" type="button">Create</button></div>' +
      '<div role="dialog" id="signin-modal" hidden><h2>Add devspace to ChatGPT</h2><button id="signin" type="button">Sign in with devspace</button></div>' +
      '</section>';
    wireNav();
    document.querySelector('#browse').addEventListener('click', () => {
      if (!developerMode || !enforceCsp) return;
      localStorage.setItem('ui-browse-after-developer-settings', 'true');
      localStorage.setItem('ui-browse-plugins', 'true');
      document.querySelector('#browser').hidden = false;
    });
    document.querySelector('#add').addEventListener('click', () => {
      if (document.querySelector('#browser').hidden) return;
      localStorage.setItem('ui-add-after-browse', 'true');
      localStorage.setItem('ui-add-plugin', 'true');
      document.querySelector('#new-plugin').hidden = false;
    });
    document.querySelector('#create').addEventListener('click', () => {
      localStorage.setItem('refresh-name', document.querySelector('[aria-label="Name"]').value);
      localStorage.setItem('refresh-url', document.querySelector('[aria-label="Server URL"]').value);
      localStorage.setItem('refresh-risk', String(document.querySelector('[type="checkbox"]').checked));
      document.querySelector('#new-plugin').hidden = true;
      document.querySelector('#signin-modal').hidden = false;
    });
    document.querySelector('#signin').addEventListener('click', () => {
      window.open('https://devspace.fixture/authorize', '_blank');
    });
  }

  function renderDetail() {
    history.replaceState({}, '', '/#settings/Plugins/plugin_asdk_app_ui12345678');
    app.innerHTML = '<main><h1>devspace</h1><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button id="try" type="button">Try in chat</button></main>';
  }

  if (location.hash.includes('plugin_asdk_app_ui12345678')) renderDetail();
  else renderHome();
</script>
</body></html>`,
      });
    });

    await context.route("https://devspace.fixture/authorize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body>
<form data-devspace-device-auth="required">
  <input type="hidden" name="device_challenge" value="${"A".repeat(43)}" />
  <input type="hidden" name="device_binding" value="${"B".repeat(43)}" />
  <input type="hidden" name="device_proof" value="" />
</form>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const proof = document.querySelector('[name="device_proof"]').value;
    if (proof !== '${"C".repeat(43)}') throw new Error('unexpected device proof');
    location.href = 'https://chatshare.xyz/#settings/Plugins/plugin_asdk_app_ui12345678';
  });
</script>
</body></html>`,
      }),
    );

    const page = await context.newPage();
    await page.goto("https://chatshare.xyz/");
    const finalPage = await refreshDevSpacePluginRegistration(page, {
      devSpacePublicBaseUrl: "https://devspace.fixture",
      deviceProofProvider: async () => "C".repeat(43),
      timeoutMs: 5_000,
    });

    assert.match(finalPage.url(), /plugin_asdk_app_ui12345678/);
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("direct-settings-attempt")), null);
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("ui-profile-menu")), "true");
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("ui-settings-menu")), "true");
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("ui-developer-mode")), "true");
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("ui-enforce-csp")), "true");
    assert.equal(
      await finalPage.evaluate(() => localStorage.getItem("ui-browse-after-developer-settings")),
      "true",
    );
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("ui-browse-plugins")), "true");
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("ui-add-after-browse")), "true");
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("ui-add-plugin")), "true");
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("refresh-name")), "devspace");
    assert.equal(
      await finalPage.evaluate(() => localStorage.getItem("refresh-url")),
      "https://devspace.fixture/mcp",
    );
    assert.equal(await finalPage.evaluate(() => localStorage.getItem("refresh-risk")), "true");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("ChatShare stale DevSpace plugin preflight refuses to create a duplicate registration", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatshare.xyz/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main id="app"></main>
<script>
  const app = document.querySelector('#app');
  let pluginNavAttempts = 0;
  function renderPluginSettings() {
    history.replaceState({}, '', '/#settings/Plugins');
    app.innerHTML = \`
      <nav><button role="tab" id="general-nav" type="button">General</button><button role="tab" id="security-nav" type="button">Security and login</button><button role="tab" id="plugins-nav" type="button">Plugins</button></nav>
      <section>
        <a href="/#settings/Plugins/plugin_asdk_app_stale12345678">devspace stale</a>
        <a id="browse-plugins" href="/plugins">Browse plugins</a>
        <div role="dialog" id="new-plugin" hidden>
          <h2>New Plugin</h2>
          <label>Name <input aria-label="Name" /></label>
          <label>Server URL <input aria-label="Server URL" type="url" /></label>
          <div>Authentication <span>OAuth</span></div>
          <label><input aria-label="I understand and want to continue" type="checkbox" /> I understand and want to continue</label>
          <button id="create" type="button">Create</button>
        </div>
        <div role="dialog" id="signin-modal" hidden>
          <h2>Add devspace to ChatGPT</h2>
          <button id="signin" type="button">Sign in with devspace ↗</button>
        </div>
      </section>
    \`;
    document.querySelector('#security-nav').addEventListener('click', renderSecurity);
    document.querySelector('#browse-plugins').addEventListener('click', (event) => {
      event.preventDefault();
      location.href = '/plugins';
    });
    document.querySelector('#create').addEventListener('click', () => {
      localStorage.setItem('refresh-name', document.querySelector('[aria-label="Name"]').value);
      localStorage.setItem('refresh-url', document.querySelector('[aria-label="Server URL"]').value);
      localStorage.setItem('refresh-risk', String(document.querySelector('[type="checkbox"]').checked));
      document.querySelector('#new-plugin').hidden = true;
      document.querySelector('#signin-modal').hidden = false;
    });
    document.querySelector('#signin').addEventListener('click', () => {
      window.open('https://devspace.fixture/authorize', '_blank');
    });
  }

  function wireSettingsNav() {
    document.querySelector('#plugins-nav')?.addEventListener('click', () => {
      pluginNavAttempts += 1;
      renderPluginSettings();
      if (pluginNavAttempts === 1) {
        setTimeout(renderGeneral, 100);
      }
    });
    document.querySelector('#security-nav')?.addEventListener('click', renderSecurity);
  }

  function renderGeneral() {
    history.replaceState({}, '', '/#settings');
    app.innerHTML = '<nav><button role="tab" id="general-nav" type="button">General</button><button role="tab" id="security-nav" type="button">Security and login</button><button role="tab" id="plugins-nav" type="button">Plugins</button></nav><section><h2>General</h2></section>';
    wireSettingsNav();
  }

  function renderSecurity() {
    history.replaceState({}, '', '/#settings/Security');
    app.innerHTML = '<nav><button role="tab" id="general-nav" type="button">General</button><button role="tab" id="security-nav" type="button">Security and login</button><button role="tab" id="plugins-nav" type="button">Plugins</button></nav><section><div><span>Developer mode</span><button id="developer-mode" role="switch" aria-checked="false" type="button"></button></div><div><span>Enforce CSP in developer mode</span><button id="developer-csp" role="switch" aria-checked="false" type="button"></button></div></section>';
    document.querySelector('#developer-mode').addEventListener('click', (event) => event.currentTarget.setAttribute('aria-checked', 'true'));
    document.querySelector('#developer-csp').addEventListener('click', (event) => event.currentTarget.setAttribute('aria-checked', 'true'));
    wireSettingsNav();
  }

  function renderPluginDetail(kind) {
    if (kind === 'stale') {
      app.innerHTML = '<main><h1>devspace</h1><p>Actions audit_batch_start</p><button type="button">Try in chat</button></main>';
      return;
    }
    app.innerHTML = '<main><h1>devspace</h1><p>Actions audit_batch_status</p><button type="button" disabled>Try in chat</button><p>Connection Connect</p></main>';
  }

  if (location.hash.includes('plugin_asdk_app_stale12345678')) {
    renderPluginDetail('stale');
  } else if (location.hash.includes('plugin_asdk_app_disabled12345678')) {
    renderPluginDetail('disabled');
  } else {
    renderGeneral();
  }
</script>
</body></html>`,
        });
      }
      if (url.pathname === "/plugins") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body>
<main>
  <a href="/plugins/plugin_asdk_app_stale12345678">devspace stale</a>
  <button id="browse-plugins" type="button">瀏覽插件</button>
  <section id="plugin-browser" hidden>
    <input placeholder="搜索插件" />
    <button id="add-plugin" type="button"><svg aria-hidden="true"></svg></button>
  </section>
  <div role="dialog" id="new-plugin" hidden>
    <h2>New Plugin</h2>
    <label>Name <input aria-label="Name" /></label>
    <label>Server URL <input aria-label="Server URL" type="url" /></label>
    <div>Authentication <span>OAuth</span></div>
    <label><input aria-label="I understand and want to continue" type="checkbox" /> I understand and want to continue</label>
    <button id="create" type="button">Create</button>
  </div>
  <div role="dialog" id="signin-modal" hidden>
    <h2>Add devspace to ChatGPT</h2>
    <button id="signin" type="button">Sign in with devspace ↗</button>
  </div>
</main>
<script>
  const browse = document.querySelector('#browse-plugins');
  const browser = document.querySelector('#plugin-browser');
  const add = document.querySelector('#add-plugin');
  const modal = document.querySelector('#new-plugin');
  const signinModal = document.querySelector('#signin-modal');
  browse.addEventListener('click', () => { browser.hidden = false; });
  add.addEventListener('click', () => { modal.hidden = false; });
  document.querySelector('#create').addEventListener('click', () => {
    localStorage.setItem('refresh-name', document.querySelector('[aria-label="Name"]').value);
    localStorage.setItem('refresh-url', document.querySelector('[aria-label="Server URL"]').value);
    localStorage.setItem('refresh-risk', String(document.querySelector('[type="checkbox"]').checked));
    modal.hidden = true;
    signinModal.hidden = false;
  });
  document.querySelector('#signin').addEventListener('click', () => {
    window.open('https://devspace.fixture/authorize', '_blank');
  });
</script>
</body></html>`,
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_stale12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main><h1>devspace</h1><p>Actions audit_batch_start</p><button type="button">Try in chat</button></main></body></html>`,
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_disabled12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main><h1>devspace</h1><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button type="button" disabled>Try in chat</button><p>Connection Connect</p></main></body></html>`,
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_refreshed12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body>
<main><h1>devspace</h1><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button id="try" type="button">Try in chat</button></main>
<div role="dialog" id="settings"><p>Plugins devspace Connection Actions</p><button aria-label="Close" type="button">X</button></div>
<script>
  document.querySelector('[aria-label="Close"]').addEventListener('click', () => {
    document.querySelector('#settings').hidden = true;
    document.body.dataset.settingsClosed = 'true';
  });
  document.querySelector('#try').addEventListener('click', () => {
    history.pushState({}, '', '/?surface=work&hints=plugin%3Aasdk_app_refreshed12345678');
    document.body.dataset.tryInChatUsed = 'true';
    document.querySelector('main').innerHTML = '<form><div id="prompt-textarea" role="textbox" contenteditable="true"><p><span data-inline-selection-pill="" data-keyword="devspace" contenteditable="false"><span>devspace</span></span></p></div><button data-testid="send-button" type="button">Send</button></form>';
  });
</script>
</body></html>`,
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });
    await context.route("https://devspace.fixture/authorize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body>
<form data-devspace-device-auth="required">
  <input type="hidden" name="device_challenge" value="${"A".repeat(43)}" />
  <input type="hidden" name="device_binding" value="${"B".repeat(43)}" />
  <input type="hidden" name="device_proof" value="" />
</form>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const proof = document.querySelector('[name="device_proof"]').value;
    if (proof !== '${"C".repeat(43)}') throw new Error('unexpected device proof');
    location.href = 'https://chatshare.xyz/plugins/plugin_asdk_app_refreshed12345678#settings/Plugins/plugin_asdk_app_refreshed12345678';
  });
</script>
</body></html>`,
      }),
    );

    const page = await context.newPage();
    await page.goto("https://chatshare.xyz/");
    await assert.rejects(
      navigateToConnectedDevSpaceSurface(page, 3_000, {
        refreshIfStale: true,
        devSpacePublicBaseUrl: "https://devspace.fixture",
        deviceProofProvider: async () => "C".repeat(43),
      }),
      /stale schema.*refusing to create another registration/i,
    );

    assert.equal(page.isClosed(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("refresh-name")), null);
    assert.equal(await page.evaluate(() => localStorage.getItem("refresh-url")), null);
    assert.equal(await page.evaluate(() => localStorage.getItem("refresh-risk")), null);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("ChatShare current disconnected DevSpace button reconnects without duplicate registration", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatshare.xyz/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/") {
        return route.fulfill({ status: 404, body: "unexpected route" });
      }
      if (url.searchParams.get("surface") === "work") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: '<!doctype html><html><body><form><div id="prompt-textarea" role="textbox" contenteditable="true"><p><span data-inline-selection-pill="" data-keyword="devspace" contenteditable="false"><span>devspace</span></span></p></div><button data-testid="send-button" type="button">Send</button></form></body></html>',
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><main id="app"></main>
<script>
  const app = document.querySelector('#app');
  const pluginId = 'asdk_app_current12345678';

  function renderGeneral() {
    history.replaceState({}, '', '/#settings');
    app.innerHTML = '<div role="dialog"><button role="tab">General</button><button role="tab" id="plugins-tab">Plugins</button><section>General</section></div>';
    document.querySelector('#plugins-tab').addEventListener('click', renderPlugins);
  }

  function renderPlugins() {
    history.replaceState({}, '', '/#settings/Plugins');
    app.innerHTML = '<div role="dialog"><button role="tab">General</button><button role="tab">Plugins</button><div role="tabpanel" data-state="active"><h2>Plugins</h2><button id="devspace-card" type="button">DevSpace Local</button></div></div>';
    document.querySelector('#devspace-card').addEventListener('click', () => renderDetail(false));
  }

  function renderDetail(connected) {
    const actuallyConnected = connected || localStorage.getItem('existing-connected') === 'true';
    history.replaceState({}, '', '/#settings/Plugins/plugin_' + pluginId + (connected ? '?connected=1' : ''));
    if (actuallyConnected && !connected) localStorage.setItem('existing-detail-reloaded', 'true');
    if (actuallyConnected) {
      app.innerHTML =
        '<main id="plugin-background"><h2>devspace</h2><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button id="try" type="button">Try in chat</button></main>' +
        '<div id="detail-backdrop" style="position:fixed;inset:0">' +
        '<div role="dialog" id="detail-dialog" style="position:fixed;left:300px;top:100px;width:500px;height:400px;background:white">' +
        '<input placeholder="Search settings" />' +
        '<button role="tab">Plugins</button><h2>devspace</h2><p>Connection Connected</p><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p>' +
        '</div></div>';
      document.querySelector('#detail-backdrop').addEventListener('click', (event) => {
        if (event.target !== document.querySelector('#detail-backdrop')) return;
        document.querySelector('#detail-backdrop').remove();
        localStorage.setItem('existing-detail-dismissed-by-background', 'true');
      });
      document.querySelector('#try').addEventListener('click', () => {
        if (document.querySelector('#detail-backdrop')) {
          localStorage.setItem('existing-try-blocked-by-overlay', 'true');
          return;
        }
        window.open('/?surface=work&hints=plugin%3A' + pluginId, '_blank');
      });
      return;
    }

    app.innerHTML = '<div role="dialog"><button role="tab">General</button><button role="tab">Plugins</button><div role="tabpanel" data-state="active"><h2>DevSpace Local</h2><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p>' +
      '<button id="connection" type="button"><span>Connection</span><span>Connect</span></button><button id="connect-action" type="button" hidden>Connect</button><button id="signin" type="button" hidden>Sign in with devspace</button>' +
      '</div></div>';

    document.querySelector('#connection').addEventListener('click', () => {
      document.querySelector('#connect-action').hidden = false;
    });
    document.querySelector('#connect-action').addEventListener('click', () => {
      localStorage.setItem('existing-reconnect-used', 'true');
      document.querySelector('#signin').hidden = false;
    });
    document.querySelector('#signin').addEventListener('click', () => {
      window.open('https://devspace.fixture/authorize', '_blank');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.data === 'devspace-connected') {
      localStorage.setItem('existing-connected', 'true');
    }
  });

  if (location.hash.includes('plugin_' + pluginId)) {
    renderDetail(location.hash.includes('connected=1'));
  } else if (location.hash.startsWith('#settings/Plugins')) {
    renderPlugins();
  } else {
    renderGeneral();
  }
</script>
</body></html>`,
      });
    });

    await context.route("https://devspace.fixture/authorize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body>
<form data-devspace-device-auth="required">
  <input type="hidden" name="device_challenge" value="${"A".repeat(43)}" />
  <input type="hidden" name="device_binding" value="${"B".repeat(43)}" />
  <input type="hidden" name="device_proof" value="" />
</form>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const proof = document.querySelector('[name="device_proof"]').value;
    if (proof !== '${"C".repeat(43)}') throw new Error('unexpected device proof');
    window.opener?.postMessage('devspace-connected', 'https://chatshare.xyz');
    setTimeout(() => window.close(), 50);
  });
</script>
</body></html>`,
      }),
    );

    const page = await context.newPage();
    await page.goto("https://chatshare.xyz/");
    const finalPage = await navigateToConnectedDevSpaceSurface(page, 5_000, {
      refreshIfStale: true,
      devSpacePublicBaseUrl: "https://devspace.fixture",
      deviceProofProvider: async () => "C".repeat(43),
    });

    assert.equal(page.isClosed(), true);
    assert.match(finalPage.url(), /surface=work/);
    assert.equal(
      await finalPage.evaluate(() => localStorage.getItem("existing-reconnect-used")),
      "true",
    );
    assert.equal(
      await finalPage.evaluate(() => localStorage.getItem("existing-detail-reloaded")),
      "true",
    );
    assert.equal(
      await finalPage.evaluate(() =>
        localStorage.getItem("existing-detail-dismissed-by-background"),
      ),
      "true",
    );
    assert.equal(
      await finalPage.evaluate(() =>
        localStorage.getItem("existing-try-blocked-by-overlay"),
      ),
      null,
    );
    assert.equal(await findExactlyOneComposer(finalPage, 1_000).then(() => true), true);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("ChatShare connected launch uses the already-connected fresh-chat fast path", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-chatshare-connected-"));
  const browser = await launchInstalledChrome();
  let controller: WebLaunchBrowserController | undefined;
  try {
    const context = await browser.newContext();
    const recoveryMonitorSource = await readFile(
      new URL("../chatshare-oauth-rescue-extension/recovery-monitor.js", import.meta.url),
      "utf8",
    );
    await context.addInitScript(recoveryMonitorSource);
    let pluginPageRequests = 0;
    await context.route("https://chatshare.xyz/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/pastel/") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><main>car list</main></body></html>",
        });
      }
      if (url.pathname === "/frontend-api/carpage") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            code: 1,
            data: {
              list: [
                { carID: "pro-connected", status: 1, clears_in: 0, team_clears_in: 0, count: 1, isPlus: true, isPro: true, isTeam: false },
              ],
            },
          }),
        });
      }
      if (url.pathname === "/auth/loginSession") {
        assert.equal(url.searchParams.get("carid"), "pro-connected");
        return route.fulfill({ status: 200, contentType: "application/json", body: "{\"code\":1}" });
      }
      if (url.pathname === "/c/active-recovery-12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button id="turn-control" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</form>
</main>
<script>
  const control = document.querySelector('#turn-control');
  const composer = document.querySelector('#prompt-textarea');
  control.addEventListener('click', () => {
    if (control.getAttribute('data-testid') === 'stop-button') {
      document.body.dataset.activeStopClicked = 'true';
      control.setAttribute('data-testid', 'send-button');
      control.setAttribute('aria-label', 'Send prompt');
      control.textContent = '↑';
      return;
    }
    document.body.dataset.activeResumeSubmitted = composer.value;
  });
</script>
</body></html>`,
        });
      }
      if (url.pathname === "/c/stale-recovery-12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main>
<p>Connection interrupted</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button data-testid="send-button" aria-label="Send prompt" type="button">↑</button>
</form>
<button id="stale-resume" type="button">resume</button>
</main>
<script>
  document.querySelector('#stale-resume').addEventListener('click', () => {
    document.body.dataset.staleResumeClicked = 'true';
  });
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    document.body.dataset.staleResumeSubmitted = document.querySelector('#prompt-textarea').value;
  });
</script>
</body></html>`,
        });
      }
      if (url.pathname === "/plugins") {
        pluginPageRequests += 1;
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main><a href="/plugins/plugin_asdk_app_chatshare_current123">devspace</a></main></body></html>`,
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_chatshare_current123") {
        pluginPageRequests += 1;
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main>
<p>Actions source_resolve_start source_resolve_status source_resolve_submit</p>
<button id="try" type="button">Try in chat</button>
</main>
<script>
  document.querySelector('#try').addEventListener('click', () => {
    history.pushState({}, '', '/?surface=work&hints=plugin%3Aasdk_app_chatshare_current123');
    document.querySelector('main').innerHTML = '<form><div id="prompt-textarea" role="textbox" contenteditable="true"><p><span data-inline-selection-pill="" data-keyword="devspace" contenteditable="false"><span>devspace</span></span></p></div><button data-testid="send-button" type="button">Send</button></form><div id="consent" hidden><p>ChatGPT needs access to devspace to help with this request.</p><button id="connect" type="button">Connect</button></div>';
    const composer = document.querySelector('#prompt-textarea');
    const consent = document.querySelector('#consent');
    document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
      const editableClone = composer.cloneNode(true);
      editableClone.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
      document.body.dataset.submitted = editableClone.textContent;
      history.pushState({}, '', '/c/chatshare-connected-conversation-12345678');
      composer.innerHTML = '';
      consent.hidden = false;
    });
    document.querySelector('#connect').addEventListener('click', () => {
      document.body.dataset.devspaceConnected = 'true';
      consent.remove();
    });
  });
</script></body></html>`,
        });
      }
      if (url.pathname === "/") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main id="app"></main>
<script>
  const app = document.querySelector('#app');
  function renderDetail() {
    app.innerHTML = '<a href="/#settings/Plugins/plugin_asdk_app_chatshare_current123">devspace</a><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button id="try" type="button">Try in chat</button>';
    document.querySelector('#try').addEventListener('click', () => {
      history.pushState({}, '', '/?surface=work&hints=plugin%3Aasdk_app_chatshare_current123');
      app.innerHTML = '<form><div id="prompt-textarea" role="textbox" contenteditable="true"><p><span data-inline-selection-pill="" data-keyword="devspace" contenteditable="false"><span>devspace</span></span></p></div><button data-testid="send-button" type="button">Send</button></form><div id="consent" hidden><p>ChatGPT needs access to devspace to help with this request.</p><button id="connect" type="button">Connect</button></div>';
      const composer = document.querySelector('#prompt-textarea');
      const consent = document.querySelector('#consent');
      document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
        const editableClone = composer.cloneNode(true);
        editableClone.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
        document.body.dataset.submitted = editableClone.textContent;
        history.pushState({}, '', '/c/chatshare-connected-conversation-12345678');
        composer.innerHTML = '';
        consent.hidden = false;
      });
      document.querySelector('#connect').addEventListener('click', () => {
        document.body.dataset.devspaceConnected = 'true';
        consent.remove();
      });
    });
  }
  renderDetail();
</script>
</body></html>`,
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });

    const activePage = await context.newPage();
    await activePage.goto("https://chatshare.xyz/c/active-recovery-12345678");
    const stalePage = await context.newPage();
    await stalePage.goto("https://chatshare.xyz/c/stale-recovery-12345678");

    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => context,
      sessionProvider: "chatshare",
    });

    const prompt = "ChatShare connected DevSpace probe";
    const acknowledgement = await controller.launchWebConversation(prompt, { attachDevSpace: true });
    const conversationPage = context
      .pages()
      .find(
        (page) =>
          page !== activePage &&
          page !== stalePage &&
          chatConversationIdentityFromUrl(page.url()) !== undefined,
      );

    assert.ok(conversationPage);
    assert.equal(await conversationPage.evaluate(() => document.body.dataset.devspaceConnected), "true");
    assert.equal(await conversationPage.evaluate(() => document.body.dataset.submitted), prompt);
    assert.equal(acknowledgement.launchSuccess, true);

    await activePage.waitForFunction(
      () => document.body.dataset.activeResumeSubmitted === "resume",
      undefined,
      { timeout: 8_000 },
    );
    assert.equal(
      await activePage.evaluate(() => document.body.dataset.activeStopClicked),
      "true",
    );
    assert.equal(
      await activePage.evaluate(() => document.body.dataset.activeResumeSubmitted),
      "resume",
    );

    await stalePage.waitForTimeout(700);
    assert.equal(
      await stalePage.evaluate(() => document.body.dataset.staleResumeClicked),
      undefined,
    );
    assert.equal(
      await stalePage.evaluate(() => document.body.dataset.staleResumeSubmitted),
      undefined,
    );
    assert.equal(
      await stalePage.getAttribute("html", "data-devspace-recovery-lease"),
      null,
    );

    await conversationPage.waitForFunction(
      (expectedLease) =>
        document.documentElement.getAttribute("data-devspace-recovery-lease") ===
        expectedLease,
      acknowledgement.conversationIdentitySha256,
      { timeout: 1_000 },
    );

    const pluginRequestsBeforeEventRecovery = pluginPageRequests;
    const eventRecoveryStartedAt = Date.now();
    await conversationPage.evaluate(() => {
      const interruption = document.createElement("p");
      interruption.textContent = "Stopped talking to devspace";
      document.querySelector("main")?.appendChild(interruption);

      const stop = document.createElement("button");
      stop.type = "button";
      stop.dataset.testid = "stop-button";
      stop.setAttribute("aria-label", "Stop generating");
      stop.textContent = "■";
      stop.addEventListener("click", () => stop.remove());
      document.querySelector("main")?.appendChild(stop);
    });
    await conversationPage.waitForFunction(
      () => document.body.dataset.submitted === "resume",
      undefined,
      { timeout: 4_000 },
    );
    assert.ok(
      Date.now() - eventRecoveryStartedAt < 4_000,
      "leased ChatShare recovery should be event-driven before the 5s fallback poll",
    );
    assert.equal(pluginPageRequests, pluginRequestsBeforeEventRecovery);
    assert.equal(
      await conversationPage.getAttribute("html", "data-devspace-recovery-pending"),
      null,
      "controller should consume the extension wake latch",
    );

    await conversationPage.evaluate(() => {
      const resumedStop = document.createElement("button");
      resumedStop.id = "resumed-turn-stop";
      resumedStop.type = "button";
      resumedStop.dataset.testid = "stop-button";
      resumedStop.setAttribute("aria-label", "Stop generating");
      resumedStop.textContent = "■";
      document.querySelector("main")?.appendChild(resumedStop);
    });
    await conversationPage.waitForFunction(
      () =>
        document.documentElement.getAttribute("data-devspace-recovery-state") ===
        "active",
      undefined,
      { timeout: 1_000 },
    );
    await conversationPage.evaluate(() => {
      document.querySelector("#resumed-turn-stop")?.remove();
      for (const paragraph of document.querySelectorAll("p")) {
        if (/Stopped talking to devspace/i.test(paragraph.textContent ?? "")) {
          paragraph.remove();
        }
      }
    });
    await conversationPage.waitForFunction(
      () => !document.documentElement.hasAttribute("data-devspace-recovery-lease"),
      undefined,
      { timeout: 4_000 },
    );
    assert.equal(
      controller.stopWebConversationRecovery(
        acknowledgement.conversationIdentitySha256,
      ),
      false,
    );
  } finally {
    await controller?.close();
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ChatShare provider refuses PLUS-only inventory instead of bypassing the Pro requirement", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatshare.xyz/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/pastel/") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><main>car list</main></body></html>",
        });
      }
      if (url.pathname === "/frontend-api/carpage") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            code: 1,
            data: {
              list: [
                { carID: "plus-only", status: 1, clears_in: 0, team_clears_in: 0, count: 1, isTeam: false, isPlus: true, isPro: false },
              ],
            },
          }),
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });
    const page = await context.newPage();
    await assert.rejects(
      prepareChatShareSession(page, 450),
      /available ChatGPT Pro session/i,
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("ChatShare pins the first Pro session and refuses to switch when it disappears", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    let availableIds = ["pro-original"];
    const loginSessionCalls: string[] = [];
    await context.route("https://chatshare.xyz/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/frontend-api/carpage") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            code: 1,
            data: {
              list: availableIds.map((carID) => ({
                carID, isPro: true, status: 1, count: 1, clears_in: 0, team_clears_in: 0,
              })),
            },
          }),
        });
      }
      if (url.pathname === "/auth/loginSession") {
        loginSessionCalls.push(url.searchParams.get("carid") ?? "");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"code":1}',
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body>ChatShare ready</body></html>",
      });
    });

    const page = await context.newPage();
    await prepareChatShareSession(page, 2_000);
    assert.deepEqual(loginSessionCalls, ["pro-original"]);
    assert.deepEqual(await page.evaluate(() => ({
      preferred: localStorage.getItem("crtUse"),
      pinned: localStorage.getItem("devspace:chatshare:pinned-car-id"),
    })), { preferred: "pro-original", pinned: "pro-original" });

    // The other Pro account must not become the new OAuth owner automatically.
    availableIds = ["pro-other"];
    await assert.rejects(
      prepareChatShareSession(page, 1_000),
      /selected ChatShare account is no longer an available ChatGPT Pro session.*refusing automatic account switch/i,
    );
    assert.deepEqual(loginSessionCalls, ["pro-original"]);
    assert.deepEqual(await page.evaluate(() => ({
      preferred: localStorage.getItem("crtUse"),
      pinned: localStorage.getItem("devspace:chatshare:pinned-car-id"),
    })), { preferred: "pro-original", pinned: "pro-original" });

    // Once the original account returns, reuse it without a new loginSession.
    availableIds = ["pro-other", "pro-original"];
    await prepareChatShareSession(page, 2_000);
    assert.deepEqual(loginSessionCalls, ["pro-original"]);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("ChatShare rejects an external account change instead of overwriting the DevSpace pin", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    let loginSessionCalls = 0;
    await context.route("https://chatshare.xyz/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/frontend-api/carpage") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            code: 1,
            data: {
              list: ["pro-original", "pro-other"].map((carID) => ({
                carID, isPro: true, status: 1, count: 1, clears_in: 0, team_clears_in: 0,
              })),
            },
          }),
        });
      }
      if (url.pathname === "/auth/loginSession") {
        loginSessionCalls += 1;
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body>ChatShare ready</body></html>",
      });
    });
    const page = await context.newPage();
    await page.goto("https://chatshare.xyz/");
    await page.evaluate(() => localStorage.setItem("crtUse", "pro-original"));
    // A preexisting, connected preference is reused and pinned without loginSession.
    await prepareChatShareSession(page, 1_000);
    assert.equal(loginSessionCalls, 0);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("devspace:chatshare:pinned-car-id")),
      "pro-original",
    );
    // Another ChatShare tab can change crtUse without changing the outer login.
    await page.evaluate(() => localStorage.setItem("crtUse", "pro-other"));
    await assert.rejects(
      prepareChatShareSession(page, 1_000),
      /different account than the DevSpace-pinned session.*refusing automatic account switch/i,
    );
    assert.equal(loginSessionCalls, 0);
    assert.deepEqual(await page.evaluate(() => ({
      preferred: localStorage.getItem("crtUse"),
      pinned: localStorage.getItem("devspace:chatshare:pinned-car-id"),
    })), { preferred: "pro-other", pinned: "pro-original" });
    await context.close();
  } finally {
    await browser.close();
  }
});

test("connected prompt preserves an explicit external DevSpace app selection chip", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
<div id="composer-toolbar">
  <button type="button" data-testid="selected-app-chip" aria-pressed="true">DevSpace Local</button>
</div>
<form>
  <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
  <button data-testid="send-button" type="button">Send</button>
</form>
<script>
  const composer = document.querySelector('#prompt-textarea');
  const chip = document.querySelector('[data-testid="selected-app-chip"]');
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    document.body.dataset.selectionPreserved = String(chip?.isConnected === true);
    document.body.dataset.submitted = composer.textContent;
    composer.innerHTML = '';
  });
</script>
</body></html>`);

    const prompt = "external DevSpace selection prompt";
    await injectAndSubmitConnectedPrompt(page, prompt);

    assert.equal(await page.evaluate(() => document.body.dataset.selectionPreserved), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.submitted), prompt);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("verified Try in chat work handoff can submit when ChatShare exposes no selection DOM marker", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><main>home</main></body></html>",
        });
      }
      if (url.pathname === "/plugins") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: '<!doctype html><html><body><main><a href="/plugins/plugin_asdk_app_markerless123">DevSpace Local</a></main></body></html>',
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_markerless123") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main><button id="try" type="button">Try in chat</button></main>
<script>
  document.querySelector('#try').addEventListener('click', () => {
    history.pushState({}, '', '/?surface=work');
    document.querySelector('main').innerHTML =
      '<form><div id="prompt-textarea" role="textbox" aria-label="Chat with ChatGPT" contenteditable="true"></div><button data-testid="send-button" type="button">Send</button></form>';
    const composer = document.querySelector('#prompt-textarea');
    document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
      document.body.dataset.submitted = composer.textContent;
      composer.innerHTML = '';
    });
  });
</script></body></html>`,
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });

    const page = await context.newPage();
    await page.goto("https://chatgpt.com/");
    const finalPage = await navigateToConnectedDevSpaceSurface(page, 2_000);
    assert.match(finalPage.url(), /surface=work/);
    assert.equal(
      await finalPage.locator('[data-inline-selection-pill]').count(),
      0,
    );

    const prompt = "markerless verified handoff prompt";
    await injectAndSubmitConnectedPrompt(finalPage, prompt);
    assert.equal(
      await finalPage.evaluate(() => document.body.dataset.submitted),
      prompt,
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("connected launch enters through Try in chat and preserves the DevSpace app selection", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-connected-"));
  const browser = await launchInstalledChrome();
  let controller: WebLaunchBrowserController | undefined;
  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/plugins") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main><a href="/plugins/plugin_asdk_app_fixture123">DevSpace Local</a></main></body></html>`,
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_fixture123") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main><button id="try" type="button">Try in chat</button></main>
<script>
  document.querySelector('#try').addEventListener('click', () => {
    history.pushState({}, '', '/?surface=work&hints=plugin%3Aasdk_app_fixture123');
    document.body.dataset.tryInChatUsed = 'true';
    document.querySelector('main').innerHTML = '<form><div id="prompt-textarea" role="textbox" aria-label="Chat with ChatGPT" contenteditable="true"><p><span data-inline-selection-pill-cursor-target="" aria-hidden="true" contenteditable="false">&#65279;</span><span data-inline-selection-pill="" data-keyword="DevSpace Local" data-system-hint-type="plugin:asdk_app_fixture123" contenteditable="false"><span>DevSpace Local</span></span> DevSpace Local connect devspace </p></div><button data-testid="send-button" type="button">Send</button></form><div data-testid="modal-tpp-upsell-nux" hidden><button aria-label="Close" type="button">Close</button><button type="button">Unlock with Plus</button></div><div id="consent" hidden><p>ChatGPT needs access to DevSpace Local to help with this request.</p><button id="connect" type="button">Connect</button></div>';
    const composer = document.querySelector('#prompt-textarea');
    const onboarding = document.querySelector('[data-testid="modal-tpp-upsell-nux"]');
    const consent = document.querySelector('#consent');
    setTimeout(() => { onboarding.hidden = false; }, 50);
    onboarding.querySelector('[aria-label="Close"]').addEventListener('click', () => {
      document.body.dataset.onboardingClosed = 'true';
      onboarding.remove();
    });
    document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
      document.body.dataset.selectionPreserved = String(composer.querySelectorAll('[data-inline-selection-pill][data-keyword="DevSpace Local"]').length === 1);
      const editableClone = composer.cloneNode(true);
      editableClone.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
      document.body.dataset.submitted = editableClone.textContent;
      history.pushState({}, '', '/c/fixture-connected-conversation-12345678');
      composer.innerHTML = '';
      consent.hidden = false;
    });
    document.querySelector('#connect').addEventListener('click', () => {
      document.body.dataset.devspaceConnected = 'true';
      consent.remove();
    });
  });
</script></body></html>`,
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });
    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => context,
    });

    const prompt = "connected DevSpace prompt";
    const acknowledgement = await controller.launchWebConversation(prompt, { attachDevSpace: true });
    const conversationPage = context
      .pages()
      .find((page) => chatGptConversationIdentityFromUrl(page.url()) !== undefined);

    assert.ok(conversationPage);
    assert.equal(await conversationPage.evaluate(() => document.body.dataset.tryInChatUsed), "true");
    assert.equal(await conversationPage.evaluate(() => document.body.dataset.onboardingClosed), "true");
    assert.equal(await conversationPage.evaluate(() => document.body.dataset.selectionPreserved), "true");
    assert.equal(await conversationPage.evaluate(() => document.body.dataset.devspaceConnected), "true");
    assert.equal(await conversationPage.evaluate(() => document.body.dataset.submitted), prompt);
    assert.equal(acknowledgement.launchSuccess, true);

    // ChatGPT-provider conversations that explicitly attach DevSpace are now
    // managed by the same page-lifecycle recovery supervisor as ChatShare.
    await conversationPage.close();
    const reopenedConversationPage = await context.newPage();
    await reopenedConversationPage.goto(
      "https://chatgpt.com/c/fixture-connected-conversation-12345678",
    );
    await reopenedConversationPage.waitForTimeout(80);
    assert.equal(
      controller.stopWebConversationRecovery(
        acknowledgement.conversationIdentitySha256,
      ),
      true,
    );
  } finally {
    await controller?.close();
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("connected launch activates DevSpace when ChatGPT requests per-conversation access", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-connect-consent-"));
  const browser = await launchInstalledChrome();
  let controller: WebLaunchBrowserController | undefined;
  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/plugins") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main><a href="/plugins/plugin_asdk_app_fixture123">DevSpace Local</a></main></body></html>`,
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_fixture123") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main><button id="try" type="button">Try in chat</button></main>
<script>
  document.querySelector('#try').addEventListener('click', () => {
    history.pushState({}, '', '/?surface=work&hints=plugin%3Aasdk_app_fixture123');
    document.querySelector('main').innerHTML = '<form><div id="prompt-textarea" role="textbox" aria-label="Chat with ChatGPT" contenteditable="true"><p><span data-inline-selection-pill-cursor-target="" aria-hidden="true" contenteditable="false">&#65279;</span><span data-inline-selection-pill="" data-keyword="DevSpace Local" data-system-hint-type="plugin:asdk_app_fixture123" contenteditable="false"><span>DevSpace Local</span></span></p></div><button data-testid="send-button" type="button">Send</button></form><div id="consent" hidden><p>ChatGPT needs access to DevSpace Local to help with this request.</p><button id="connect" type="button">Connect</button></div>';
    const composer = document.querySelector('#prompt-textarea');
    const consent = document.querySelector('#consent');
    document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
      history.pushState({}, '', '/c/fixture-connected-consent-12345678');
      composer.innerHTML = '';
      consent.hidden = false;
    });
    document.querySelector('#connect').addEventListener('click', () => {
      document.body.dataset.devspaceConnected = 'true';
      consent.remove();
    });
  });
</script></body></html>`,
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });
    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => context,
    });

    await controller.launchWebConversation("activate connector", { attachDevSpace: true });
    const conversationPage = context
      .pages()
      .find((page) => chatGptConversationIdentityFromUrl(page.url()) !== undefined);

    assert.ok(conversationPage);
    assert.equal(
      await conversationPage.evaluate(() => document.body.dataset.devspaceConnected),
      "true",
    );

    await conversationPage.setContent(`<!doctype html><html><body><main>
<p>連線中斷・正在等待完整回覆</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button id="turn-control" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</form>
</main>
<script>
  const control = document.querySelector('#turn-control');
  const composer = document.querySelector('#prompt-textarea');
  control.addEventListener('click', () => {
    if (control.getAttribute('data-testid') === 'stop-button') {
      document.body.dataset.autoStopClicked = 'true';
      control.setAttribute('data-testid', 'send-button');
      control.setAttribute('aria-label', 'Send prompt');
      control.textContent = '↑';
      return;
    }
    document.body.dataset.autoResumeSubmitted = composer.value;
  });
</script></body></html>`);

    await conversationPage.waitForFunction(
      () => document.body.dataset.autoResumeSubmitted === "resume",
      undefined,
      { timeout: 5_000 },
    );
    assert.equal(
      await conversationPage.evaluate(() => document.body.dataset.autoStopClicked),
      "true",
    );
    assert.equal(
      await conversationPage.evaluate(() => document.body.dataset.autoResumeSubmitted),
      "resume",
    );
  } finally {
    await controller?.close();
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("mid-conversation ChatGPT recovery reconnects DevSpace without navigating the conversation", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/**", (route) => {
      const url = new URL(route.request().url());

      if (url.pathname === "/c/fixture-chatgpt-recovery-12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><main><p id=\"conversation\">Original DevSpace conversation</p></main></body></html>",
        });
      }
      if (url.pathname === "/") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><main>home</main></body></html>",
        });
      }
      if (url.pathname === "/plugins") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: '<!doctype html><html><body><main><a href="/plugins/plugin_asdk_app_recovery123">DevSpace Local</a></main></body></html>',
        });
      }
      if (url.pathname === "/plugins/plugin_asdk_app_recovery123") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><main>
<p>Actions source_resolve_start source_resolve_status source_resolve_submit</p>
<button id="connect" type="button">Connect</button>
</main>
<script>
  document.querySelector('#connect').addEventListener('click', () => {
    document.body.dataset.reconnected = 'true';
    const main = document.querySelector('main');
    main.querySelector('#connect').remove();
    const tryButton = document.createElement('button');
    tryButton.id = 'try';
    tryButton.type = 'button';
    tryButton.textContent = 'Try in chat';
    tryButton.addEventListener('click', () => {
      history.pushState({}, '', '/?surface=work&hints=plugin%3Aasdk_app_recovery123');
      main.innerHTML = '<form><div id="prompt-textarea" role="textbox" aria-label="Chat with ChatGPT" contenteditable="true"></div><button data-testid="send-button" type="button">Send</button></form>';
    });
    main.appendChild(tryButton);
  });
</script></body></html>`,
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });

    const conversationPage = await context.newPage();
    await conversationPage.goto(
      "https://chatgpt.com/c/fixture-chatgpt-recovery-12345678",
    );

    await ensureDevSpacePluginConnectedForRecovery(conversationPage, {
      timeoutMs: 5_000,
    });

    assert.equal(
      conversationPage.url(),
      "https://chatgpt.com/c/fixture-chatgpt-recovery-12345678",
    );
    assert.equal(
      await conversationPage.locator("#conversation").innerText(),
      "Original DevSpace conversation",
    );
    assert.equal(context.pages().length, 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("mid-conversation ChatShare recovery reconnects a reset DevSpace plugin in the background", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatshare.xyz/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/c/recovery-reset-12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body><main><p>Stopped talking to devspace</p><form><textarea id=\"prompt-textarea\"></textarea><button data-testid=\"send-button\" type=\"button\">Send</button></form></main><script>sessionStorage.setItem('recovery-conversation-reloaded','true');sessionStorage.setItem('recovery-load-count',String(Number(sessionStorage.getItem('recovery-load-count')||'0')+1))</script></body></html>",
        });
      }
      if (url.pathname === "/c/recovery-retry-12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<button id="volatile-retry" type="button">Retry</button>
<form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" type="button">Send</button></form>
</main>
<script>
  const loadCount = Number(sessionStorage.getItem('volatile-retry-load-count') || '0') + 1;
  sessionStorage.setItem('volatile-retry-load-count', String(loadCount));
  if (loadCount > 1) document.querySelector('#volatile-retry').remove();
</script></body></html>`,
        });
      }
      if (url.pathname !== "/") {
        return route.fulfill({ status: 404, body: "unexpected route" });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><main id="app"></main>
<script>
  const app = document.querySelector('#app');
  const pluginId = 'asdk_app_recoveryreset12345678';

  function renderPlugins() {
    history.replaceState({}, '', '/#settings/Plugins');
    app.innerHTML = '<button role="tab">General</button><button role="tab">Plugins</button><section><h2>Plugins</h2><button id="devspace-card" type="button">DevSpace Local</button></section>';
    document.querySelector('#devspace-card').addEventListener('click', () => renderDetail(false));
  }

  function renderDetail(connected) {
    history.replaceState({}, '', '/#settings/Plugins/plugin_' + pluginId);
    if (connected) {
      localStorage.setItem('mid-recovery-connected', 'true');
      app.innerHTML = '<main><h2>DevSpace Local</h2><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button type="button">Try in chat</button></main>';
      return;
    }
    app.innerHTML = '<main><h2>DevSpace Local</h2><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button id="connect" type="button">Connect</button><button id="signin" type="button" hidden>Sign in with DevSpace Local</button></main>';
    document.querySelector('#connect').addEventListener('click', () => {
      localStorage.setItem('mid-recovery-connect-clicked', 'true');
      document.querySelector('#signin').hidden = false;
    });
    document.querySelector('#signin').addEventListener('click', () => {
      window.open('https://devspace.fixture/authorize', '_blank');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.data === 'devspace-connected') renderDetail(true);
  });

  renderPlugins();
</script>
</body></html>`,
      });
    });

    await context.route("https://devspace.fixture/authorize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body>
<form data-devspace-device-auth="required">
  <input type="hidden" name="device_challenge" value="${"A".repeat(43)}" />
  <input type="hidden" name="device_binding" value="${"B".repeat(43)}" />
</form>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const proof = document.querySelector('[name="device_proof"]').value;
    if (proof !== '${"C".repeat(43)}') throw new Error('unexpected device proof');
    window.opener?.postMessage('devspace-connected', 'https://chatshare.xyz');
    setTimeout(() => window.close(), 25);
  });
</script>
</body></html>`,
      }),
    );

    const conversationPage = await context.newPage();
    await conversationPage.goto("https://chatshare.xyz/c/recovery-reset-12345678");
    await ensureChatShareDevSpacePluginConnectedForRecovery(conversationPage, {
      devSpacePublicBaseUrl: "https://devspace.fixture",
      deviceProofProvider: async () => "C".repeat(43),
      timeoutMs: 5_000,
    });

    assert.equal(conversationPage.url(), "https://chatshare.xyz/c/recovery-reset-12345678");
    assert.equal(
      await conversationPage.evaluate(() => localStorage.getItem("mid-recovery-connect-clicked")),
      "true",
    );
    assert.equal(
      await conversationPage.evaluate(() => localStorage.getItem("mid-recovery-connected")),
      "true",
    );
    assert.equal(
      await conversationPage.evaluate(() => sessionStorage.getItem("recovery-conversation-reloaded")),
      "true",
    );
    assert.equal(
      await conversationPage.evaluate(() => sessionStorage.getItem("recovery-load-count")),
      "2",
    );
    assert.equal(context.pages().length, 1);

    await conversationPage.close();
    const retryConversationPage = await context.newPage();
    await retryConversationPage.goto(
      "https://chatshare.xyz/c/recovery-retry-12345678",
    );
    await ensureChatShareDevSpacePluginConnectedForRecovery(retryConversationPage, {
      devSpacePublicBaseUrl: "https://devspace.fixture",
      deviceProofProvider: async () => "C".repeat(43),
      timeoutMs: 5_000,
    });

    assert.equal(
      await retryConversationPage.evaluate(() =>
        sessionStorage.getItem("volatile-retry-load-count"),
      ),
      "1",
    );
    assert.equal(await retryConversationPage.locator("#volatile-retry").count(), 1);
    assert.equal(context.pages().length, 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("mid-conversation recovery bootstraps a ChatShare car-list session before plugin settings", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    let sessionSelected = false;

    await context.route("https://chatshare.xyz/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/c/recovery-carlist-12345678") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body><main><form><textarea id=\"prompt-textarea\"></textarea><button data-testid=\"send-button\" type=\"button\">Send</button></form></main></body></html>",
        });
      }
      if (url.pathname === "/frontend-api/carpage") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            code: 1,
            data: {
              list: [
                {
                  carID: "pro-recovery-car",
                  status: 1,
                  clears_in: 0,
                  team_clears_in: 0,
                  count: 1,
                  isPro: true,
                },
              ],
            },
          }),
        });
      }
      if (url.pathname === "/auth/loginSession") {
        sessionSelected = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      if (url.pathname === "/pastel/") {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body><main>car list</main></body></html>",
        });
      }
      if (url.pathname === "/" && !sessionSelected) {
        return route.fulfill({
          status: 302,
          headers: { Location: "https://chatshare.xyz/pastel/#/carlist" },
          body: "",
        });
      }
      if (url.pathname === "/" && sessionSelected) {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main id="app"></main>
<script>
  const app = document.querySelector('#app');
  const pluginId = 'asdk_app_recoverycarlist12345678';
  function renderPlugins() {
    history.replaceState({}, '', '/#settings/Plugins');
    app.innerHTML = '<button role="tab">General</button><button role="tab">Plugins</button><section><h2>Plugins</h2><button id="devspace-card" type="button">DevSpace Local</button></section>';
    document.querySelector('#devspace-card').addEventListener('click', renderDetail);
  }
  function renderDetail() {
    history.replaceState({}, '', '/#settings/Plugins/plugin_' + pluginId);
    app.innerHTML = '<main><h2>DevSpace Local</h2><p>Actions source_resolve_start source_resolve_status source_resolve_submit</p><button type="button">Try in chat</button></main>';
  }
  renderPlugins();
</script>
</body></html>`,
        });
      }
      return route.fulfill({ status: 404, body: "unexpected route" });
    });

    const conversationPage = await context.newPage();
    await conversationPage.goto("https://chatshare.xyz/c/recovery-carlist-12345678");
    await ensureChatShareDevSpacePluginConnectedForRecovery(conversationPage, {
      timeoutMs: 5_000,
    });

    assert.equal(sessionSelected, true);
    assert.equal(conversationPage.url(), "https://chatshare.xyz/c/recovery-carlist-12345678");
    assert.equal(context.pages().length, 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("recovery watcher reconnects before resuming an interrupted conversation", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<section><p>Stopped talking to devspace</p><button id="resume">resume</button></section>
</main>
<script>
  document.querySelector('#resume').addEventListener('click', () => {
    document.body.dataset.resumeSawReconnect = document.body.dataset.reconnected ?? 'false';
  });
</script>
</body></html>`);

    await watchForDevSpaceChatShareRecovery(page, 1_000, {
      resumeCooldownMs: 60,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => {
        await page.evaluate(() => {
          document.body.dataset.reconnected = "true";
        });
      },
    });

    assert.equal(await page.evaluate(() => document.body.dataset.reconnected), "true");
    assert.equal(
      await page.evaluate(() => document.body.dataset.resumeSawReconnect),
      "true",
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("interruption rescue clicks stop, waits for the send arrow, then submits resume", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<section><p>連線中斷・正在等待完整回覆</p></section>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button id="turn-control" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</form>
</main>
<script>
  const control = document.querySelector('#turn-control');
  const composer = document.querySelector('#prompt-textarea');
  control.addEventListener('click', () => {
    if (control.getAttribute('data-testid') === 'stop-button') {
      document.body.dataset.stopClicked = 'true';
      setTimeout(() => {
        control.setAttribute('data-testid', 'send-button');
        control.setAttribute('aria-label', 'Send prompt');
        control.textContent = '↑';
        document.body.dataset.sendReady = 'true';
      }, 1150);
      return;
    }

    document.body.dataset.resumeSubmitted = composer.value;
    composer.value = '';
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
</script>
</body></html>`);

    let reconnectAttempts = 0;
    await watchForDevSpaceChatShareRecovery(page, 1_800, {
      resumeCooldownMs: 60,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => {
        reconnectAttempts += 1;
      },
    });

    assert.equal(reconnectAttempts, 0);
    assert.equal(await page.evaluate(() => document.body.dataset.stopClicked), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.sendReady), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.resumeSubmitted), "resume");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("aborted interruption rescue cannot submit resume after the page switches session", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button id="turn-control" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</form>
</main>
<script>
  document.querySelector('#turn-control').addEventListener('click', () => {
    document.body.dataset.oldSessionStopClicked = 'true';
  });
</script></body></html>`);

    const abortController = new AbortController();
    const watch = watchForDevSpaceChatShareRecovery(page, 2_000, {
      signal: abortController.signal,
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
    });

    await page.waitForFunction(
      () => document.body.dataset.oldSessionStopClicked === "true",
      undefined,
      { timeout: 1_500 },
    );
    abortController.abort();

    await page.setContent(`<!doctype html><html><body><main>
<p>New session</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button data-testid="send-button" aria-label="Send prompt" type="button">↑</button>
</form>
</main>
<script>
  const composer = document.querySelector('#prompt-textarea');
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    document.body.dataset.leakedResume = composer.value;
  });
</script></body></html>`);

    await watch;
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => document.body.dataset.leakedResume), undefined);
    assert.equal(await page.locator("#prompt-textarea").inputValue(), "");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("aborted interruption rescue exits promptly while the stop transition is still stuck", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button id="turn-control" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</form>
</main>
<script>
  document.querySelector('#turn-control').addEventListener('click', () => {
    document.body.dataset.stopClicked = 'true';
  });
</script></body></html>`);

    const abortController = new AbortController();
    const watch = watchForDevSpaceChatShareRecovery(page, 5_000, {
      signal: abortController.signal,
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
    });

    await page.waitForFunction(
      () => document.body.dataset.stopClicked === "true",
      undefined,
      { timeout: 1_500 },
    );
    const abortedAtMs = Date.now();
    abortController.abort();

    const completion = await Promise.race([
      watch.then(() => "completed" as const),
      page.waitForTimeout(1_000).then(() => "timeout" as const),
    ]);
    assert.equal(completion, "completed");
    assert.ok(Date.now() - abortedAtMs < 1_000);
    assert.equal(
      await page.locator('[data-testid="stop-button"]').isVisible(),
      true,
    );

    await context.close();
  } finally {
    await browser.close();
  }
});

test("aborted interruption rescue cancels composer discovery promptly", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<button id="turn-control" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</main>
<script>
  document.querySelector('#turn-control').addEventListener('click', (event) => {
    document.body.dataset.stopClicked = 'true';
    event.currentTarget.remove();
  });
</script></body></html>`);

    const abortController = new AbortController();
    const watch = watchForDevSpaceChatShareRecovery(page, 5_000, {
      signal: abortController.signal,
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
    });

    await page.waitForFunction(
      () =>
        document.body.dataset.stopClicked === "true" &&
        !document.querySelector('[data-testid="stop-button"]'),
      undefined,
      { timeout: 1_500 },
    );
    await page.waitForTimeout(100);
    const abortedAtMs = Date.now();
    abortController.abort();

    const completion = await Promise.race([
      watch.then(() => "completed" as const),
      page.waitForTimeout(1_000).then(() => "timeout" as const),
    ]);
    assert.equal(completion, "completed");
    assert.ok(Date.now() - abortedAtMs < 1_000);

    await context.close();
  } finally {
    await browser.close();
  }
});

test("abort during send transition clears an owned synthetic resume", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button id="turn-control" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</form>
</main>
<script>
  document.querySelector('#turn-control').addEventListener('click', (event) => {
    document.body.dataset.stopClicked = 'true';
    event.currentTarget.remove();
  });
</script></body></html>`);

    const abortController = new AbortController();
    const watch = watchForDevSpaceChatShareRecovery(page, 5_000, {
      signal: abortController.signal,
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
    });

    await page.waitForFunction(
      () =>
        document.body.dataset.stopClicked === "true" &&
        document.querySelector<HTMLTextAreaElement>("#prompt-textarea")?.value === "resume",
      undefined,
      { timeout: 1_500 },
    );
    const abortedAtMs = Date.now();
    abortController.abort();

    const completion = await Promise.race([
      watch.then(() => "completed" as const),
      page.waitForTimeout(1_000).then(() => "timeout" as const),
    ]);
    assert.equal(completion, "completed");
    assert.ok(Date.now() - abortedAtMs < 1_000);
    assert.equal(await page.locator("#prompt-textarea").inputValue(), "");

    await context.close();
  } finally {
    await browser.close();
  }
});

test("replacement recovery watcher can take ownership of the same page", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<button id="resume" type="button">resume</button>
</main>
<script>
  document.querySelector('#resume').addEventListener('click', () => {
    document.body.dataset.replacementWatcherResumed = 'true';
  });
</script></body></html>`);

    const firstAbort = new AbortController();
    const firstWatch = watchForDevSpaceChatShareRecovery(page, 1_000, {
      signal: firstAbort.signal,
      pollMs: 20,
      shouldRecover: () => false,
    });
    await page.waitForTimeout(80);

    firstAbort.abort();
    const replacementWatch = watchForDevSpaceChatShareRecovery(page, 300, {
      replaceActiveWatch: true,
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
    });

    await replacementWatch;
    await firstWatch;
    assert.equal(
      await page.evaluate(() => document.body.dataset.replacementWatcherResumed),
      "true",
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("recovery retry budget re-arms when interruption controls become actionable", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
</main></body></html>`);

    const watch = watchForDevSpaceChatShareRecovery(page, 800, {
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => undefined,
    });

    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "late-resume";
      button.type = "button";
      button.textContent = "resume";
      button.addEventListener("click", () => {
        const count = Number(document.body.dataset.lateResumeClicks ?? "0") + 1;
        document.body.dataset.lateResumeClicks = String(count);
      });
      document.querySelector("main")?.appendChild(button);
    });

    await watch;
    assert.equal(await page.evaluate(() => document.body.dataset.lateResumeClicks), "1");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("successful recovery suppresses duplicate resumes while the same interruption persists", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<button id="resume" type="button">resume</button>
</main>
<script>
  document.querySelector('#resume').addEventListener('click', () => {
    const count = Number(document.body.dataset.resumeClicks ?? '0') + 1;
    document.body.dataset.resumeClicks = String(count);
  });
</script></body></html>`);

    await watchForDevSpaceChatShareRecovery(page, 220, {
      resumeCooldownMs: 20,
      retryBudgetRearmMs: 500,
      maxResumeAttempts: 3,
      pollMs: 20,
    });

    assert.equal(await page.evaluate(() => document.body.dataset.resumeClicks), "1");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("successful recovery re-arms if the same interruption never clears", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<button id="resume" type="button">resume</button>
</main>
<script>
  document.querySelector('#resume').addEventListener('click', () => {
    const count = Number(document.body.dataset.resumeClicks ?? '0') + 1;
    document.body.dataset.resumeClicks = String(count);
  });
</script></body></html>`);

    await watchForDevSpaceChatShareRecovery(page, 260, {
      resumeCooldownMs: 20,
      retryBudgetRearmMs: 80,
      maxResumeAttempts: 1,
      pollMs: 20,
    });

    const resumeClicks = Number(
      await page.evaluate(() => document.body.dataset.resumeClicks ?? "0"),
    );
    assert.ok(resumeClicks >= 2);
    assert.ok(resumeClicks <= 4);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("stale global interruption does not re-fire until the interruption marker is freshly rendered", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p id="interruption">Stopped talking to devspace</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button id="send" data-testid="send-button" aria-label="Send prompt" type="button">send</button>
</form>
<button id="resume" type="button">resume</button>
</main>
<script>
  document.querySelector('#resume').addEventListener('click', () => {
    const count = Number(document.body.dataset.resumeClicks ?? '0') + 1;
    document.body.dataset.resumeClicks = String(count);
    if (count >= 2) document.querySelector('#interruption')?.remove();
  });
</script></body></html>`);

    const watch = watchForDevSpaceChatShareRecovery(page, 700, {
      resumeCooldownMs: 20,
      retryBudgetRearmMs: 80,
      maxResumeAttempts: 1,
      pollMs: 20,
    });

    await page.waitForFunction(
      () => document.body.dataset.resumeClicks === "1",
      undefined,
      { timeout: 1_000 },
    );

    // A normal user submission must not make an already-handled global banner
    // look like a fresh interruption and trigger another automatic resume.
    await page.locator("#send").click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.body.dataset.resumeClicks), "1");

    // ChatShare may reuse the same banner element for the next failure.
    // Re-rendering its text subtree, even with identical text, must advance the
    // interruption generation and arm a new recovery episode.
    await page.locator("#interruption").evaluate((element) => {
      element.textContent = element.textContent;
    });
    await page.waitForFunction(
      () => document.body.dataset.resumeClicks === "2",
      undefined,
      { timeout: 1_000 },
    );

    await watch;
    assert.equal(await page.evaluate(() => document.body.dataset.resumeClicks), "2");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("user submission suppresses the same stale interruption after a failed auto-resume", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p id="interruption">Stopped talking to devspace</p>
<button id="send" data-testid="send-button" aria-label="Send prompt" type="button">send</button>
</main></body></html>`);

    let reconnectAttempts = 0;
    const watch = watchForDevSpaceChatShareRecovery(page, 1_600, {
      resumeCooldownMs: 20,
      retryBudgetRearmMs: 80,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => {
        reconnectAttempts += 1;
      },
    });

    const reconnectDeadline = Date.now() + 1_000;
    while (reconnectAttempts < 1 && Date.now() < reconnectDeadline) {
      await page.waitForTimeout(20);
    }
    assert.equal(reconnectAttempts, 1);

    await page.locator("#send").click();
    await watch;

    assert.equal(reconnectAttempts, 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("failed recovery attempts consume the retry budget and cannot thrash plugin reconnect", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<main><p>Stopped talking to devspace</p></main>");

    let reconnectAttempts = 0;
    await watchForDevSpaceChatShareRecovery(page, 1_000, {
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => {
        reconnectAttempts += 1;
      },
    });

    assert.equal(reconnectAttempts, 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("exhausted retry budget re-arms later without requiring UI shape changes", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<main><p>Stopped talking to devspace</p></main>");

    let reconnectAttempts = 0;
    await watchForDevSpaceChatShareRecovery(page, 2_400, {
      resumeCooldownMs: 20,
      retryBudgetRearmMs: 80,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => {
        reconnectAttempts += 1;
      },
    });

    assert.ok(reconnectAttempts >= 2);
    assert.ok(reconnectAttempts <= 3);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("silent detect-only recovery keeps watching for a later actionable interruption", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>Received an application response</p></div>
</main></body></html>`);

    const watch = watchForDevSpaceChatShareRecovery(page, 700, {
      silentIdleMs: 40,
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
      shouldRecoverSilentStall: () => true,
    });

    await page.waitForTimeout(120);
    await page.setContent(`<!doctype html><html><body><main>
<p>Connection interrupted</p>
<button id="resume" type="button">resume</button>
</main>
<script>
  document.querySelector('#resume').addEventListener('click', () => {
    document.body.dataset.resumedAfterSilentStall = 'true';
  });
</script></body></html>`);

    await watch;
    assert.equal(
      await page.evaluate(() => document.body.dataset.resumedAfterSilentStall),
      "true",
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("retry budget remains bounded while the same interruption DOM changes", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<main><p id=\"status\">Stopped talking to devspace</p></main>");

    let reconnectAttempts = 0;
    const watch = watchForDevSpaceChatShareRecovery(page, 260, {
      resumeCooldownMs: 40,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => {
        reconnectAttempts += 1;
      },
    });

    await page.waitForTimeout(100);
    await page.locator("#status").evaluate((element) => {
      element.textContent = "Stopped talking to devspace — still interrupted";
    });
    await watch;

    assert.equal(reconnectAttempts, 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("managed recovery gate fails closed outside a DevSpace-owned conversation", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p>Stopped talking to devspace</p>
<button id="resume" type="button">resume</button>
</main>
<script>
  document.querySelector('#resume').addEventListener('click', () => {
    document.body.dataset.resumed = 'true';
  });
</script></body></html>`);

    let reconnectAttempts = 0;
    await watchForDevSpaceChatShareRecovery(page, 180, {
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
      shouldRecover: () => false,
      ensurePluginConnected: async () => {
        reconnectAttempts += 1;
      },
    });

    assert.equal(reconnectAttempts, 0);
    assert.equal(await page.evaluate(() => document.body.dataset.resumed), undefined);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("manual Stop suppresses auto-resume until the user sends again", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<p id="status">Healthy conversation</p>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button id="turn-control" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</form>
</main>
<script>
  const control = document.querySelector('#turn-control');
  const status = document.querySelector('#status');
  control.addEventListener('click', () => {
    if (control.getAttribute('data-testid') === 'stop-button') {
      document.body.dataset.manualStopClicked = 'true';
      control.setAttribute('data-testid', 'send-button');
      control.setAttribute('aria-label', 'Send prompt');
      control.textContent = '↑';
      status.textContent = 'Stopped talking to devspace';
      const recovery = document.createElement('button');
      recovery.id = 'resume';
      recovery.type = 'button';
      recovery.textContent = 'resume';
      recovery.addEventListener('click', () => {
        document.body.dataset.autoResumed = 'true';
      });
      document.querySelector('main').appendChild(recovery);
      return;
    }
    document.body.dataset.userSentAgain = 'true';
    status.textContent = 'New user turn running';
    document.querySelector('#resume')?.remove();
    setTimeout(() => {
      status.textContent = 'Stopped talking to devspace';
      const recovery = document.createElement('button');
      recovery.id = 'resume';
      recovery.type = 'button';
      recovery.textContent = 'resume';
      recovery.addEventListener('click', () => {
        document.body.dataset.autoResumed = 'true';
      });
      document.querySelector('main').appendChild(recovery);
    }, 80);
  });
</script>
</body></html>`);

    let reconnectAttempts = 0;
    const watch = watchForDevSpaceChatShareRecovery(page, 1_200, {
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => {
        reconnectAttempts += 1;
      },
    });

    await page.waitForFunction(
      () =>
        (
          window as typeof window & {
            __devspaceRecoveryIntentState?: { installed?: boolean };
          }
        ).__devspaceRecoveryIntentState?.installed === true,
      undefined,
      { timeout: 1_000 },
    );
    await page.locator("#turn-control").click();
    await page.waitForTimeout(140);

    assert.equal(await page.evaluate(() => document.body.dataset.manualStopClicked), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.autoResumed), undefined);
    assert.equal(reconnectAttempts, 0);

    await page.locator("#turn-control").click();
    await watch;

    assert.equal(await page.evaluate(() => document.body.dataset.userSentAgain), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.autoResumed), "true");
    assert.equal(reconnectAttempts, 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("delivery-timeout detection recognizes the ChatShare retry message", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<main><p>訊息遞送逾時。請再試一次。</p></main>");
    assert.equal(await hasDeliveryTimeoutMessage(page), true);
    await page.setContent("<main><p>Normal assistant response.</p></main>");
    assert.equal(await hasDeliveryTimeoutMessage(page), false);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("connection interrupted and message timeout are immediate DevSpace resume triggers", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<main><p>連線中斷</p></main>");
    assert.equal(await hasDevSpaceInterruptionMessage(page), true);
    await page.setContent("<main><p>讯息超时</p></main>");
    assert.equal(await hasDevSpaceInterruptionMessage(page), true);
    await page.setContent("<main><p>Normal assistant response.</p></main>");
    assert.equal(await hasDevSpaceInterruptionMessage(page), false);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("ChatShare DevSpace evidence classifier distinguishes owned and unrelated chats", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route(
      "https://chatshare.xyz/c/universal-devspace-evidence-12345678",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body><main><p>Stopped talking to devspace</p></main></body></html>",
        }),
    );
    const page = await context.newPage();
    await page.goto("https://chatshare.xyz/c/universal-devspace-evidence-12345678");

    assert.equal(await hasDevSpaceConversationEvidence(page), true);

    await page.setContent("<!doctype html><html><body><main><p>Connection interrupted</p></main></body></html>");
    assert.equal(await hasDevSpaceConversationEvidence(page), false);

    await page.setContent(`<!doctype html><html><body><main>
<form>
  <div id="prompt-textarea" role="textbox" contenteditable="true">
    <span data-inline-selection-pill="" data-keyword="DevSpace Local" data-system-hint-type="plugin:asdk_app_devspace123">DevSpace Local</span>
  </div>
</form>
<p>Connection interrupted</p>
</main></body></html>`);
    assert.equal(await hasDevSpaceConversationEvidence(page), true);

    await context.close();
  } finally {
    await browser.close();
  }
});

test("stale interruption in an older turn does not stop a newer active turn", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<div data-testid="conversation-turn-1">
  <p>Stopped talking to devspace</p>
  <button id="old-resume" type="button">resume</button>
</div>
<div data-testid="conversation-turn-2">
  <p>User sent a newer message.</p>
  <button id="current-stop" data-testid="stop-button" aria-label="Stop generating" type="button">■</button>
</div>
</main>
<script>
  document.querySelector('#old-resume').addEventListener('click', () => {
    document.body.dataset.oldResumeClicked = 'true';
  });
  document.querySelector('#current-stop').addEventListener('click', () => {
    document.body.dataset.currentStopClicked = 'true';
  });
</script></body></html>`);

    assert.equal(await detectDevSpaceRecoverySignal(page), "none");

    await watchForDevSpaceChatShareRecovery(page, 180, {
      resumeCooldownMs: 20,
      maxResumeAttempts: 1,
      pollMs: 20,
    });

    assert.equal(await page.evaluate(() => document.body.dataset.oldResumeClicked), undefined);
    assert.equal(await page.evaluate(() => document.body.dataset.currentStopClicked), undefined);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("global interruption banners remain actionable beside a current turn", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>Current turn content.</p></div>
<p id="global-interruption">連線中斷</p>
</main></body></html>`);

    assert.equal(
      await detectDevSpaceRecoverySignal(page),
      "retryable_interruption",
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("recovery classification separates retryable, terminal, and transient UI failures", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.setContent("<main><p>Stopped talking to devspace</p></main>");
    assert.equal(await detectDevSpaceRecoverySignal(page), "retryable_interruption");

    await page.setContent("<main><p>You've reached your usage limit for GPT-4o</p></main>");
    assert.equal(await detectDevSpaceRecoverySignal(page), "terminal_capacity");
    assert.equal(await hasDevSpaceInterruptionMessage(page), false);

    await page.setContent("<main><p>This conversation has become too long</p></main>");
    assert.equal(await detectDevSpaceRecoverySignal(page), "terminal_context");
    assert.equal(await hasDevSpaceInterruptionMessage(page), false);

    await page.setContent("<main><p>502 Bad Gateway</p><button>Try again</button></main>");
    assert.equal(await detectDevSpaceRecoverySignal(page), "transient_gateway");

    await page.setContent("<main><p>Something went wrong</p><button>Retry</button></main>");
    assert.equal(await detectDevSpaceRecoverySignal(page), "generic_error");

    await context.close();
  } finally {
    await browser.close();
  }
});

test("silent DevSpace tool tail resumes after idle but completed assistant tail does not", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>User prompt</p></div>
<div data-testid="conversation-turn-2"><p>已接收應用程式回應</p><button id="silent-resume">resume</button></div>
</main>
<script>
  document.querySelector('#silent-resume').addEventListener('click', () => {
    document.body.dataset.silentResumed = 'true';
  });
</script>
</body></html>`);

    assert.equal(await isDevSpaceSilentStallCandidate(page), true);
    await watchForDevSpaceChatShareRecovery(page, 220, {
      silentIdleMs: 60,
      resumeCooldownMs: 60,
      maxResumeAttempts: 1,
      pollMs: 20,
    });
    assert.equal(await page.evaluate(() => document.body.dataset.silentResumed), "true");

    await page.setContent(`<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>User prompt</p></div>
<div data-testid="conversation-turn-2"><p>已接收應用程式回應</p></div>
<div data-testid="conversation-turn-3"><p>Final assistant answer.</p></div>
</main></body></html>`);
    assert.equal(await isDevSpaceSilentStallCandidate(page), false);

    await page.setContent(`<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>User prompt</p></div>
<div data-testid="conversation-turn-2"><p>已接收應用程式回應</p><p>Opened workspace, ready for instructions.</p></div>
</main></body></html>`);
    assert.equal(await isDevSpaceSilentStallCandidate(page), false);

    await page.setContent(`<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>User prompt</p></div>
<div data-testid="conversation-turn-2"><p>已接收應用程式回應</p></div>
<form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" type="button">Send</button></form>
</main>
<script>
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    document.body.dataset.syntheticResumeSubmitted = document.querySelector('#prompt-textarea').value;
  });
</script>
</body></html>`);
    let orphanSilentReconnectAttempts = 0;
    await watchForDevSpaceChatShareRecovery(page, 180, {
      silentIdleMs: 40,
      resumeCooldownMs: 40,
      maxResumeAttempts: 1,
      pollMs: 20,
      ensurePluginConnected: async () => {
        orphanSilentReconnectAttempts += 1;
      },
    });
    assert.equal(orphanSilentReconnectAttempts, 0);
    assert.equal(
      await page.evaluate(() => document.body.dataset.syntheticResumeSubmitted),
      undefined,
    );
    assert.equal(await page.locator("#prompt-textarea").inputValue(), "");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("silent DevSpace tool tail without native recovery submits one bounded same-conversation resume", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route(
      "https://chatshare.xyz/c/silent-fallback-12345678",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>User prompt</p></div>
<div data-testid="conversation-turn-2"><p>Received an application response</p></div>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button data-testid="send-button" type="button">Send</button>
</form>
</main>
<script>
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    const composer = document.querySelector('#prompt-textarea');
    document.body.dataset.resumeCount = String(Number(document.body.dataset.resumeCount || '0') + 1);
    document.body.dataset.resumePrompt = composer.value;
    composer.value = '';
  });
</script>
</body></html>`,
        }),
    );
    const page = await context.newPage();
    await page.goto("https://chatshare.xyz/c/silent-fallback-12345678");

    await watchForDevSpaceChatShareRecovery(page, 320, {
      silentIdleMs: 40,
      resumeCooldownMs: 40,
      retryBudgetRearmMs: 60,
      maxResumeAttempts: 1,
      pollMs: 20,
      shouldRecoverSilentStall: () => true,
    });

    assert.equal(await page.evaluate(() => document.body.dataset.resumeCount), "1");
    assert.equal(await page.evaluate(() => document.body.dataset.resumePrompt), "resume");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("parallel silent-stall recovery is isolated per conversation", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const renderConversation = (label: string) => `<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>User prompt ${label}</p></div>
<div data-testid="conversation-turn-2"><p>Received an application response</p></div>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button data-testid="send-button" type="button">Send</button>
</form>
</main>
<script>
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    const composer = document.querySelector('#prompt-textarea');
    document.body.dataset.resumeCount = String(Number(document.body.dataset.resumeCount || '0') + 1);
    document.body.dataset.resumePrompt = composer.value;
    composer.value = '';
  });
</script>
</body></html>`;

    await context.route(
      "https://chatshare.xyz/c/parallel-silent-a-12345678",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: renderConversation("A"),
        }),
    );
    await context.route(
      "https://chatshare.xyz/c/parallel-silent-b-12345678",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: renderConversation("B"),
        }),
    );

    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await Promise.all([
      pageA.goto("https://chatshare.xyz/c/parallel-silent-a-12345678"),
      pageB.goto("https://chatshare.xyz/c/parallel-silent-b-12345678"),
    ]);

    let reconnectA = 0;
    let reconnectB = 0;
    await Promise.all([
      watchForDevSpaceChatShareRecovery(pageA, 300, {
        silentIdleMs: 40,
        resumeCooldownMs: 40,
        retryBudgetRearmMs: 1_000,
        maxResumeAttempts: 1,
        pollMs: 20,
        shouldRecoverSilentStall: () => true,
        ensurePluginConnected: async () => {
          reconnectA += 1;
          await pageA.waitForTimeout(10);
        },
      }),
      watchForDevSpaceChatShareRecovery(pageB, 300, {
        silentIdleMs: 40,
        resumeCooldownMs: 40,
        retryBudgetRearmMs: 1_000,
        maxResumeAttempts: 1,
        pollMs: 20,
        shouldRecoverSilentStall: () => true,
        ensurePluginConnected: async () => {
          reconnectB += 1;
          await pageB.waitForTimeout(25);
        },
      }),
    ]);

    assert.equal(reconnectA, 1);
    assert.equal(reconnectB, 1);
    assert.equal(await pageA.evaluate(() => document.body.dataset.resumeCount), "1");
    assert.equal(await pageB.evaluate(() => document.body.dataset.resumeCount), "1");
    assert.equal(await pageA.evaluate(() => document.body.dataset.resumePrompt), "resume");
    assert.equal(await pageB.evaluate(() => document.body.dataset.resumePrompt), "resume");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("silent synthetic resume is fenced by conversation identity and new user turns", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const silentBody = `<!doctype html><html><body><main>
<div data-testid="conversation-turn-1"><p>User prompt</p></div>
<div data-testid="conversation-turn-2"><p>Received an application response</p></div>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button data-testid="send-button" type="button">Send</button>
</form>
</main>
<script>
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    const composer = document.querySelector('#prompt-textarea');
    const value = composer.value;
    document.body.dataset.submissionCount = String(Number(document.body.dataset.submissionCount || '0') + 1);
    document.body.dataset.lastSubmission = value;
    composer.value = '';
    if (value !== 'resume') {
      const stop = document.createElement('button');
      stop.id = 'active-stop';
      stop.setAttribute('data-testid', 'stop-button');
      stop.setAttribute('aria-label', 'Stop generating');
      stop.textContent = '■';
      document.querySelector('main').appendChild(stop);
    }
  });
</script>
</body></html>`;

    await context.route(
      "https://chatshare.xyz/c/silent-fence-user-12345678",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: silentBody,
        }),
    );
    await context.route(
      "https://chatshare.xyz/c/silent-fence-input-12345678",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: silentBody,
        }),
    );
    await context.route(
      "https://chatshare.xyz/c/silent-fence-identity-12345678",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: silentBody,
        }),
    );
    await context.route(
      "https://chatshare.xyz/c/silent-fence-switched-12345678",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body><main><p>Healthy switched conversation</p></main></body></html>",
        }),
    );

    const userPage = await context.newPage();
    await userPage.goto("https://chatshare.xyz/c/silent-fence-user-12345678");
    let releaseUserRecovery!: () => void;
    const userRecoveryGate = new Promise<void>((resolve) => {
      releaseUserRecovery = resolve;
    });
    let userRecoveryStarted = false;
    const userWatch = watchForDevSpaceChatShareRecovery(userPage, 320, {
      silentIdleMs: 40,
      resumeCooldownMs: 40,
      retryBudgetRearmMs: 1_000,
      maxResumeAttempts: 1,
      pollMs: 20,
      shouldRecoverSilentStall: () => true,
      ensurePluginConnected: async () => {
        userRecoveryStarted = true;
        await userRecoveryGate;
      },
    });

    const userDeadline = Date.now() + 1_000;
    while (!userRecoveryStarted && Date.now() < userDeadline) {
      await userPage.waitForTimeout(20);
    }
    assert.equal(userRecoveryStarted, true);
    await userPage.locator("#prompt-textarea").fill("new user turn");
    await userPage.locator('[data-testid="send-button"]').click();
    releaseUserRecovery();
    await userWatch;

    assert.equal(await userPage.evaluate(() => document.body.dataset.submissionCount), "1");
    assert.equal(await userPage.evaluate(() => document.body.dataset.lastSubmission), "new user turn");

    const inputPage = await context.newPage();
    await inputPage.goto("https://chatshare.xyz/c/silent-fence-input-12345678");
    let releaseInputRecovery!: () => void;
    const inputRecoveryGate = new Promise<void>((resolve) => {
      releaseInputRecovery = resolve;
    });
    let inputRecoveryStarted = false;
    const inputWatch = watchForDevSpaceChatShareRecovery(inputPage, 320, {
      silentIdleMs: 40,
      resumeCooldownMs: 40,
      retryBudgetRearmMs: 1_000,
      maxResumeAttempts: 1,
      pollMs: 20,
      shouldRecoverSilentStall: () => true,
      ensurePluginConnected: async () => {
        inputRecoveryStarted = true;
        await inputRecoveryGate;
      },
    });

    const inputDeadline = Date.now() + 1_000;
    while (!inputRecoveryStarted && Date.now() < inputDeadline) {
      await inputPage.waitForTimeout(20);
    }
    assert.equal(inputRecoveryStarted, true);
    await inputPage.locator("#prompt-textarea").fill("draft user text");
    releaseInputRecovery();
    await inputWatch;

    assert.equal(
      await inputPage.evaluate(() => document.body.dataset.submissionCount),
      undefined,
    );
    assert.equal(
      await inputPage.locator("#prompt-textarea").inputValue(),
      "draft user text",
    );

    const identityPage = await context.newPage();
    await identityPage.goto("https://chatshare.xyz/c/silent-fence-identity-12345678");
    let identityRecoveryStarted = false;
    const identityWatch = watchForDevSpaceChatShareRecovery(identityPage, 320, {
      silentIdleMs: 40,
      resumeCooldownMs: 40,
      retryBudgetRearmMs: 1_000,
      maxResumeAttempts: 1,
      pollMs: 20,
      shouldRecoverSilentStall: () => true,
      ensurePluginConnected: async () => {
        identityRecoveryStarted = true;
        await identityPage.goto("https://chatshare.xyz/c/silent-fence-switched-12345678");
      },
    });
    await identityWatch;

    assert.equal(identityRecoveryStarted, true);
    assert.equal(
      await identityPage.evaluate(() => document.body.dataset.submissionCount),
      undefined,
    );
    assert.match(identityPage.url(), /silent-fence-switched-12345678$/);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("Stopped talking to devspace is an immediate same-conversation resume trigger", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
<main>
  <section><p>Stopped talking to devspace</p><button id="old-resume">resume</button></section>
  <section><p>Stopped talking to devspace</p><button id="latest-resume">resume</button></section>
</main>
<script>
  document.querySelector('#old-resume').addEventListener('click', () => {
    document.body.dataset.oldResume = 'true';
  });
  document.querySelector('#latest-resume').addEventListener('click', () => {
    document.body.dataset.latestResume = 'true';
  });
</script>
</body></html>`);

    assert.equal(await hasDevSpaceInterruptionMessage(page), true);
    assert.equal(await resumeDevSpaceConversationIfInterrupted(page), true);
    assert.equal(await page.evaluate(() => document.body.dataset.latestResume), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.oldResume), undefined);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("ChatShare history cleanup requires menu delete then confirmation delete for the exact conversation", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatshare.xyz/c/delete-fixture-12345678", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
<nav>
  <div id="target-row"><a href="/c/delete-fixture-12345678">Target chat</a><button aria-label="Chat options">...</button></div>
  <div id="other-row"><a href="/c/other-fixture-12345678">Other chat</a><button aria-label="Chat options">...</button></div>
</nav>
<div id="menu" hidden><button role="menuitem" id="menu-delete">刪除</button></div>
<div role="dialog" id="confirm" hidden><p>刪除聊天？</p><button id="confirm-delete">刪除</button></div>
<script>
  document.querySelector('#target-row button').addEventListener('click', () => {
    document.body.dataset.menuOpened = 'true';
    document.querySelector('#menu').hidden = false;
  });
  document.querySelector('#other-row button').addEventListener('click', () => {
    document.body.dataset.wrongMenuOpened = 'true';
  });
  document.querySelector('#menu-delete').addEventListener('click', () => {
    document.body.dataset.firstDelete = 'true';
    document.querySelector('#confirm').hidden = false;
  });
  document.querySelector('#confirm-delete').addEventListener('click', () => {
    document.body.dataset.confirmDelete = 'true';
    document.querySelector('#target-row').remove();
    document.querySelector('#confirm').remove();
  });
</script>
</body></html>`,
      }),
    );
    const page = await context.newPage();
    await page.goto("https://chatshare.xyz/c/delete-fixture-12345678");

    assert.equal(
      await deleteConversationHistoryFromSidebar(page, "/c/delete-fixture-12345678"),
      true,
    );
    assert.equal(await page.evaluate(() => document.body.dataset.menuOpened), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.firstDelete), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.confirmDelete), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.wrongMenuOpened), undefined);
    assert.equal(await page.locator('a[href="/c/delete-fixture-12345678"]').count(), 0);
    assert.equal(await page.locator('a[href="/c/other-fixture-12345678"]').count(), 1);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("DevSpace permission automation chooses Allow always only for DevSpace Local", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
<div role="dialog" id="other">
  <p>Other Plugin wants tool permission.</p>
  <button id="other-always">Allow always</button>
</div>
<div role="dialog" id="devspace">
  <p>DevSpace Local 要求工具權限。</p>
  <button>僅允許一次</button>
  <button id="devspace-always">一律允許</button>
</div>
<script>
  document.querySelector('#other-always').addEventListener('click', () => {
    document.body.dataset.otherApproved = 'true';
  });
  document.querySelector('#devspace-always').addEventListener('click', () => {
    document.body.dataset.devspaceApproved = 'true';
  });
</script>
</body></html>`);

    assert.equal(await approveDevSpaceAlwaysPermissionIfPresent(page), true);
    assert.equal(await page.evaluate(() => document.body.dataset.devspaceApproved), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.otherApproved), undefined);

    await page.setContent(`<!doctype html><html><body>
<div role="dialog" id="devspace-en">
  <p>devspace Primary. Allow ChatGPT to use devspace? Tool permission.</p>
  <button>Allow once</button>
  <button id="devspace-always-en">Always allow</button>
</div>
<script>
  document.querySelector('#devspace-always-en').addEventListener('click', () => {
    document.body.dataset.devspaceApprovedEn = 'true';
  });
</script>
</body></html>`);
    assert.equal(await approveDevSpaceAlwaysPermissionIfPresent(page), true);
    assert.equal(await page.evaluate(() => document.body.dataset.devspaceApprovedEn), "true");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("recovery watcher handles repeated DevSpace permission prompts", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><main><p>Tool run</p></main>
<div role="dialog" id="permission-1">
  <p>DevSpace Local tool permission.</p>
  <button id="allow-1">Allow always</button>
</div>
<script>
  document.querySelector('#allow-1').addEventListener('click', () => {
    document.body.dataset.permissionOne = 'true';
    document.querySelector('#permission-1').remove();
    setTimeout(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.id = 'permission-2';
      dialog.innerHTML = '<p>DevSpace Local second tool permission.</p><button id="allow-2">Allow always</button>';
      document.body.appendChild(dialog);
      document.querySelector('main p').textContent = 'Second tool run';
      document.querySelector('#allow-2').addEventListener('click', () => {
        document.body.dataset.permissionTwo = 'true';
        dialog.remove();
      });
    }, 550);
  });
</script>
</body></html>`);

    await watchForDevSpaceChatShareRecovery(page, 1_300, {
      maxResumeAttempts: 0,
      pollMs: 20,
    });

    assert.equal(await page.evaluate(() => document.body.dataset.permissionOne), "true");
    assert.equal(await page.evaluate(() => document.body.dataset.permissionTwo), "true");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("zero-timeout recovery watcher follows the page lifecycle instead of expiring", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<main><p>Healthy conversation</p></main>");

    const watch = watchForDevSpaceChatShareRecovery(page, 0, {
      maxResumeAttempts: 0,
      pollMs: 20,
    });
    await page.waitForTimeout(80);
    await page.close();

    assert.equal(await watch, false);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("zero-timeout recovery watcher can be aborted without closing the conversation", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<main><p>Healthy conversation</p></main>");
    const abortController = new AbortController();

    const watch = watchForDevSpaceChatShareRecovery(page, 0, {
      signal: abortController.signal,
      maxResumeAttempts: 0,
      pollMs: 20,
    });
    await page.waitForTimeout(60);
    abortController.abort();

    assert.equal(await watch, false);
    assert.equal(page.isClosed(), false);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("conversation history cleanup performs menu delete then confirmation delete", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatshare.xyz/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
<nav>
  <div id="target-row">
    <a href="/c/fixture-delete-conversation-12345678">Run Fixture</a>
    <button id="row-menu" aria-label="Open conversation menu">...</button>
  </div>
</nav>
<div id="menu" role="menu" hidden><button id="delete-action" role="menuitem">刪除</button></div>
<div id="confirm-dialog" role="dialog" hidden>
  <h2>刪除聊天？</h2>
  <p>這將刪除聊天。</p>
  <button>取消</button><button id="confirm-delete">刪除</button>
</div>
<script>
  document.querySelector('#row-menu').addEventListener('click', () => {
    document.querySelector('#menu').hidden = false;
  });
  document.querySelector('#delete-action').addEventListener('click', () => {
    document.querySelector('#menu').hidden = true;
    document.querySelector('#confirm-dialog').hidden = false;
  });
  document.querySelector('#confirm-delete').addEventListener('click', () => {
    document.body.dataset.deleted = 'true';
    document.querySelector('#confirm-dialog').hidden = true;
  });
</script>
</body></html>`,
      }),
    );
    const page = await context.newPage();
    await page.goto("https://chatshare.xyz/c/fixture-delete-conversation-12345678");

    assert.equal(
      await deleteConversationHistoryFromSidebar(
        page,
        "/c/fixture-delete-conversation-12345678",
      ),
      true,
    );
    assert.equal(await page.evaluate(() => document.body.dataset.deleted), "true");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("DevSpace JIT authorization tolerates stripped metadata, missing proof, and form rerender", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/c/fixture-jit-12345678", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body>
<main>
  <p>ChatGPT needs access to DevSpace Local to help with this request.</p>
  <button id="connect" type="button">Connect</button>
</main>
<script>
  document.querySelector('#connect').addEventListener('click', () => {
    location.hash = 'settings/Connectors?add-connector-link=true';
    const signIn = document.createElement('button');
    signIn.id = 'sign-in';
    signIn.type = 'button';
    signIn.textContent = 'Sign in with DevSpace Local';
    signIn.addEventListener('click', () => {
      window.open('https://devspace.fixture/authorize', '_blank');
    });
    document.querySelector('main').appendChild(signIn);
  });
</script>
</body></html>`,
      }),
    );
    await context.route("https://devspace.fixture/authorize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body>
<form>
  <input type="hidden" name="device_challenge" value="${"A".repeat(43)}" />
  <input type="hidden" name="device_binding" value="${"B".repeat(43)}" />
</form>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const proof = document.querySelector('[name="device_proof"]').value;
    if (proof !== '${"C".repeat(43)}') throw new Error('unexpected device proof');
    location.href = 'https://chatgpt.com/connector/oauth/fixture-callback';
  });
</script>
</body></html>`,
      }),
    );
    await context.route("https://chatgpt.com/connector/oauth/fixture-callback", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>ok</body></html>" }),
    );

    const page = await context.newPage();
    await page.goto("https://chatgpt.com/c/fixture-jit-12345678");

    let proofRequest: { challenge: string; binding: string } | undefined;
    await activateDevSpaceForConversation(page, 2_000, {
      devSpacePublicBaseUrl: "https://devspace.fixture",
      deviceProofProvider: async (request) => {
        proofRequest = request;
        const authorizePage = context
          .pages()
          .find((candidate) => candidate.url().startsWith("https://devspace.fixture/authorize"));
        assert.ok(authorizePage);
        await authorizePage.evaluate((expectedProof) => {
          const currentForm = document.querySelector("form");
          if (!(currentForm instanceof HTMLFormElement)) {
            throw new Error("missing device form before rerender");
          }
          const replacement = currentForm.cloneNode(true) as HTMLFormElement;
          replacement.addEventListener("submit", (event) => {
            event.preventDefault();
            const proof = replacement.querySelector<HTMLInputElement>(
              '[name="device_proof"]',
            )?.value;
            if (proof !== expectedProof) throw new Error("unexpected device proof after rerender");
            location.href = "https://chatgpt.com/connector/oauth/fixture-callback";
          });
          currentForm.replaceWith(replacement);
        }, "C".repeat(43));
        return "C".repeat(43);
      },
    });

    assert.deepEqual(proofRequest, {
      challenge: "A".repeat(43),
      binding: "B".repeat(43),
    });
    assert.equal(
      context.pages().some((candidate) => candidate.url().startsWith("https://devspace.fixture/authorize")),
      false,
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("DevSpace JIT authorization refuses owner-password fallback", async () => {
  const browser = await launchInstalledChrome();
  try {
    const context = await browser.newContext();
    await context.route("https://chatgpt.com/c/fixture-jit-owner-12345678", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body>
<main>
  <p>ChatGPT needs access to DevSpace Local to help with this request.</p>
  <button id="connect" type="button">Connect</button>
</main>
<script>
  document.querySelector('#connect').addEventListener('click', () => {
    location.hash = 'settings/Connectors?add-connector-link=true';
    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.textContent = 'Sign in with DevSpace Local';
    signIn.addEventListener('click', () => window.open('https://devspace.fixture/authorize', '_blank'));
    document.querySelector('main').appendChild(signIn);
  });
</script>
</body></html>`,
      }),
    );
    await context.route("https://devspace.fixture/authorize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<html><body><form><input name="owner_token" type="password" /><button type="submit">Authorize DevSpace</button></form></body></html>',
      }),
    );

    const page = await context.newPage();
    await page.goto("https://chatgpt.com/c/fixture-jit-owner-12345678");
    await assert.rejects(
      activateDevSpaceForConversation(page, 2_000, {
        devSpacePublicBaseUrl: "https://devspace.fixture",
        deviceProofProvider: async () => "C".repeat(43),
      }),
      /fell back to owner password/i,
    );
    await context.close();
  } finally {
    await browser.close();
  }
});

test("WEB-LAUNCH-0 recreates its cached browser context after external closure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-launch-recreate-"));
  const browser = await launchInstalledChrome();
  const contexts: BrowserContext[] = [];
  let controller: WebLaunchBrowserController | undefined;

  try {
    controller = new WebLaunchBrowserController([parent], {
      contextFactory: async () => {
        const context = await browser.newContext();
        await context.route("https://chatgpt.com/**", (route) =>
          route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml }),
        );
        contexts.push(context);
        return context;
      },
    });

    await controller.launchWebConversation("first launch before external close");
    assert.equal(contexts.length, 1);

    await contexts[0]!.close();

    const acknowledgement = await controller.launchWebConversation("second launch after external close");
    assert.equal(contexts.length, 2);
    assert.equal(acknowledgement.launchSuccess, true);
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
