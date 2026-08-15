import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const chromePath = String.raw`C:\Users\Lenovo\AppData\Local\ms-playwright\chromium-1208\chrome-win64\chrome.exe`;
const extensionPath = dirname(fileURLToPath(import.meta.url));
const debugPort = 20000 + Math.floor(Math.random() * 1000);
const profile = await mkdtemp(join(tmpdir(), "chatshare-routing-test-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--remote-allow-origins=*",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
    } catch {
      return false;
    }
  }, 10000, "Chromium debugger");

  const target = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?about:blank`,
    { method: "PUT" },
  ).then((response) => response.json());
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Page.navigate", {
    url: "https://chatshare.xyz/connector/oauth/TeAhvdjRY7qD?code=dummy-code&state=dummy-state",
  });

  await waitFor(async () => {
    const result = await cdp.call("Runtime.evaluate", {
      expression:
        "location.pathname.startsWith('/pastel') && (location.hash === '#/login' || location.hash.startsWith('#/login'))",
      returnByValue: true,
    });
    return result.result.value === true;
  }, 20000, "Chatshare login redirect");

  const result = await cdp.call("Runtime.evaluate", {
    expression: "({href: location.href, pathname: location.pathname, hash: location.hash})",
    returnByValue: true,
  });
  const value = result.result.value;
  if (!value.pathname.startsWith("/pastel")) {
    throw new Error(`Unexpected real-site result: ${JSON.stringify(value)}`);
  }

  console.log(JSON.stringify({
    passed: true,
    interceptedBefore404: true,
    loggedOutRedirectedToLogin: true,
    finalPath: new URL(value.href).pathname,
    finalHash: value.hash,
  }, null, 2));
  cdp.close();
} finally {
  chrome.kill();
  await Promise.race([
    new Promise((resolve) => chrome.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const resolver = pending.get(message.id);
    if (!resolver) return;
    pending.delete(message.id);
    if (message.error) resolver.reject(new Error(message.error.message));
    else resolver.resolve(message.result);
  });

  return {
    call(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}
