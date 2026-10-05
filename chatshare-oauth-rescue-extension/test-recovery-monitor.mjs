import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const monitorSource = await readFile(
  new URL("./recovery-monitor.js", import.meta.url),
  "utf8",
);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(monitorSource);
  await context.route("https://chatshare.xyz/c/recovery-monitor-fixture", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body><main>
<form>
  <textarea id="prompt-textarea"></textarea>
  <button data-testid="send-button" aria-label="Send prompt" type="button">Send</button>
</form>
</main>
<script>
  document.addEventListener("devspace:recovery-signal", (event) => {
    document.body.dataset.wakeCount = String(Number(document.body.dataset.wakeCount || "0") + 1);
    document.body.dataset.lastWakeKind = event.detail?.kind || "";
  });
</script>
</body></html>`,
    }),
  );

  const page = await context.newPage();
  await page.goto("https://chatshare.xyz/c/recovery-monitor-fixture");

  await page.evaluate(() => {
    const interruption = document.createElement("p");
    interruption.textContent = "Stopped talking to devspace";
    document.querySelector("main")?.appendChild(interruption);
  });
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(() => document.body.dataset.wakeCount),
    undefined,
    "unleased Chatshare conversations must stay dormant",
  );
  await page.evaluate(() => {
    for (const paragraph of document.querySelectorAll("p")) paragraph.remove();
  });

  await page.evaluate(() => {
    document.documentElement.setAttribute(
      "data-devspace-recovery-lease",
      "fixture-lease",
    );
  });
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    const stop = document.createElement("button");
    stop.dataset.testid = "stop-button";
    stop.setAttribute("aria-label", "Stop generating");
    stop.textContent = "Stop";
    document.querySelector("main")?.appendChild(stop);
  });
  await page.waitForFunction(
    () => Number(document.body.dataset.wakeCount || "0") >= 1,
    undefined,
    { timeout: 1_500 },
  );

  assert.equal(
    await page.getAttribute("html", "data-devspace-recovery-state"),
    "active",
    "leased active turns should be marked active",
  );

  await page.evaluate(() => {
    for (const paragraph of document.querySelectorAll("p")) paragraph.remove();
    document.querySelector('[data-testid="stop-button"]')?.remove();
  });

  await page.waitForFunction(
    () =>
      document.documentElement.getAttribute("data-devspace-recovery-state") ===
      "settled",
    undefined,
    { timeout: 3_500 },
  );
  assert.equal(
    await page.evaluate(() => document.body.dataset.lastWakeKind),
    "turn-settled",
    "settled turns should wake the controller so it can revoke the lease",
  );

  const wakeCountBeforeRevoke = await page.evaluate(() =>
    Number(document.body.dataset.wakeCount || "0"),
  );
  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-devspace-recovery-lease");
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const interruption = document.createElement("p");
    interruption.textContent = "Connection interrupted";
    document.querySelector("main")?.appendChild(interruption);
  });
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(() => Number(document.body.dataset.wakeCount || "0")),
    wakeCountBeforeRevoke,
    "revoked leases must return the extension sensor to dormant mode",
  );

  await context.close();
  console.log("recovery monitor fixture passed");
} finally {
  await browser.close();
}
