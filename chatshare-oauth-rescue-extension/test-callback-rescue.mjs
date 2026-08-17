import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath = String.raw`C:\Users\Lenovo\AppData\Local\ms-playwright\chromium-1208\chrome-win64\chrome.exe`;
const debugPort = 19000 + Math.floor(Math.random() * 1000);
const appPort = 9449;
const profile = await mkdtemp(join(tmpdir(), "chatshare-rescue-test-"));
const bootstrap = await readFile(new URL("./callback-bootstrap.js", import.meta.url), "utf8");
let receivedBody = null;

const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/mock-callback") {
    let body = "";
    for await (const chunk of request) body += chunk;
    receivedBody = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ post_auth_url: "/success" }));
    return;
  }

  if (request.url === "/success") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Success</title><body>CALLBACK_SUCCESS</body>");
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html>
<title>Mock Chatshare app</title>
<body>APP_SHELL</body>
<script>
  const routeId = "routes/connector.oauth.$callback_id";
  window.__reactRouterManifest = {
    routes: {
      [routeId]: {
        id: routeId,
        path: "connector/oauth/:callback_id",
        hasLoader: true,
        hasClientLoader: false
      }
    }
  };

  window.__reactRouterDataRouter = {
    state: { initialized: true },
    async navigate(destination, options) {
      const route = window.__reactRouterManifest.routes[routeId];
      if (route.hasLoader) {
        throw new Error('No result found for routeId "' + routeId + '"');
      }

      history.replaceState(null, "", destination);
      const apiResponse = await fetch('/mock-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_redirect_url: location.href })
      });
      const result = await apiResponse.json();
      location.replace(result.post_auth_url);
    }
  };
</script>`);
});

await new Promise((resolve) => server.listen(appPort, "127.0.0.1", resolve));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--remote-allow-origins=*",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  await waitForDebugger();
  const pageTarget = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?about:blank`,
    { method: "PUT" },
  ).then((response) => response.json());
  if (!pageTarget?.webSocketDebuggerUrl) throw new Error("No Chromium page target found");

  const cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });

  const callback = `/connector/oauth/test-id?code=dummy-code&state=dummy-state`;
  await cdp.call("Page.navigate", {
    url: `http://127.0.0.1:${appPort}/#cs_oauth_callback=${callback}`,
  });

  await waitFor(async () => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: "location.hash.startsWith('#cs_oauth_callback=') === false",
      returnByValue: true,
    });
    return result.result.value === true;
  }, 8000, "rescue hash cleared");

  await waitFor(() => receivedBody !== null, 8000, "callback POST");
  await waitFor(async () => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: "location.pathname === '/success'",
      returnByValue: true,
    });
    return result.result.value === true;
  }, 8000, "success redirect");

  const state = await cdp.call("Runtime.evaluate", {
    expression: "({href: location.href, title: document.title, body: document.body?.innerText})",
    returnByValue: true,
  });

  const expected = `http://127.0.0.1:${appPort}${callback}`;
  if (receivedBody?.full_redirect_url !== expected) {
    throw new Error(`Unexpected callback body: ${JSON.stringify(receivedBody)}`);
  }

  receivedBody = null;
  await cdp.call("Runtime.evaluate", { expression: "sessionStorage.clear()", returnByValue: true });
  const workCallback = `/connector/oauth/test-id?code=dummy-code&state=dummy-work-state`;
  await cdp.call("Page.navigate", {
    url: `http://127.0.0.1:${appPort}/?surface=work#cs_oauth_callback=${workCallback}`,
  });

  await waitFor(async () => {
    const result = await cdp.call("Runtime.evaluate", {
      expression:
        "location.search.includes('surface=work') === false && location.hash.startsWith('#cs_oauth_callback=') === false",
      returnByValue: true,
    });
    return result.result.value === true;
  }, 8000, "work surface left");

  await waitFor(() => receivedBody !== null, 8000, "work-surface callback POST");
  await waitFor(async () => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: "location.pathname === '/success'",
      returnByValue: true,
    });
    return result.result.value === true;
  }, 8000, "work-surface success redirect");

  const workExpected = `http://127.0.0.1:${appPort}${workCallback}`;
  if (receivedBody?.full_redirect_url !== workExpected) {
    throw new Error(`Unexpected work-surface callback body: ${JSON.stringify(receivedBody)}`);
  }

  console.log(JSON.stringify({
    passed: true,
    productionErrorPrevented: true,
    manifestLoaderDisabledBeforeNavigation: true,
    postedFullRedirectUrlMatches: true,
    leftWorkSurfaceBeforeCallback: true,
    finalPage: state.result.value,
  }, null, 2));
  cdp.close();
} finally {
  chrome.kill();
  await Promise.race([
    new Promise((resolve) => chrome.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await new Promise((resolve) => server.close(resolve));
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

async function waitForDebugger() {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }, 10000, "Chromium debugger");
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
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
