(() => {
  "use strict";

  // Chatshare's Remix tree throws NotFoundError on Node.removeChild when
  // Chrome Translate or another extension wraps a text node React still
  // owns. That uncaught exception is the white-screen "Application Error".
  installReactDomMismatchGuard();
  disableBrowserTranslate();

  const fragmentPrefix = "#cs_oauth_callback=";
  const callbackRouteId = "routes/connector.oauth.$callback_id";
  const rescueStatusKey = "chatshare-oauth-callback-rescue-status";
  const pendingKey = "chatshare-oauth-callback-rescue-pending";
  const returnKey = "chatshare-oauth-callback-rescue-return";
  const loginPath = "/pastel/#/login";
  const documentShellPath = "/";
  const connectorShellPath = "/plugins";
  const callbackApiPath = "/aip/connectors/links/oauth/callback";

  rememberPluginReturnUrl();

  const callbackUrl = readCallbackUrl();
  if (!callbackUrl) {
    watchLoginThenResume();
    return;
  }

  const validPath =
    callbackUrl.pathname.startsWith("/connector/oauth/") ||
    callbackUrl.pathname === "/connector_platform_oauth_redirect";
  const state = callbackUrl.searchParams.get("state");
  const hasResult = callbackUrl.searchParams.has("code") || callbackUrl.searchParams.has("error");

  if (callbackUrl.origin !== location.origin || !validPath || !state || !hasResult) {
    renderFailure("The rescued OAuth callback is incomplete or outside Chatshare.");
    return;
  }

  // Chatshare's ChatGPT shell uses location.hash for #settings. Leaving the
  // rescue fragment in the address bar blocks that router and also prevents
  // the unauthenticated / -> /pastel/ login bounce from presenting #/login.
  const fullRedirectUrl = callbackUrl.href;
  sessionStorage.setItem(pendingKey, `${callbackUrl.pathname}${callbackUrl.search}`);

  // ?surface=work boots the chat UI, not the settings/connector Remix tree.
  // replaceState cannot switch documents, so leave that query with a real load.
  if (isWorkSurface() || isMarketplaceSurface()) {
    sessionStorage.setItem(
      rescueStatusKey,
      isWorkSurface() ? "leaving-work-surface" : "leaving-marketplace",
    );
    location.replace(documentShellPath);
    return;
  }

  if (location.hash.startsWith(fragmentPrefix) || isMarketplaceSurface()) {
    history.replaceState(null, "", nextShellUrl());
  }

  if (isLoginSurface()) {
    sessionStorage.setItem(rescueStatusKey, "redirecting-to-login");
    if (`${location.pathname}${location.hash}` !== loginPath) {
      location.replace(loginPath);
    }
    watchLoginThenResume();
    return;
  }

  const attemptKey = `chatshare-oauth-callback-rescue:${state}`;
  const previousAttempt = sessionStorage.getItem(attemptKey);
  if (["navigated", "ownership-rejected", "discovery-rejected"].includes(previousAttempt)) {
    sessionStorage.removeItem(pendingKey);
    sessionStorage.removeItem(returnKey);
    renderFailure(
      "This OAuth callback is no longer eligible for rescue. Return to connector settings and start a fresh authorization.",
      {
        actionHref: connectorShellPath,
        actionLabel: "Return to connector settings",
      },
    );
    return;
  }

  sessionStorage.setItem(attemptKey, "started");
  sessionStorage.setItem(rescueStatusKey, "installing-manifest-patch");

  const manifestPatch = installManifestPatch();
  waitForAppAndSubmit();

  function installManifestPatch() {
    let manifestValue = patchManifest(window.__reactRouterManifest);
    let assignmentObserved = Boolean(manifestValue);

    const descriptor = Object.getOwnPropertyDescriptor(window, "__reactRouterManifest");
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(window, "__reactRouterManifest", {
        configurable: true,
        enumerable: true,
        get() {
          return manifestValue;
        },
        set(value) {
          manifestValue = patchManifest(value);
          assignmentObserved = true;
          sessionStorage.setItem(rescueStatusKey, "manifest-patched");
        },
      });
    }

    return {
      isReady() {
        const current = patchManifest(window.__reactRouterManifest ?? manifestValue);
        return Boolean(assignmentObserved && current?.routes);
      },
      manifest() {
        return patchManifest(window.__reactRouterManifest ?? manifestValue);
      },
    };
  }

  function patchManifest(manifest) {
    if (!manifest || typeof manifest !== "object") return manifest;
    const route = manifest.routes?.[callbackRouteId];
    if (!route || typeof route !== "object") return manifest;

    // Chatshare does not serve the callback document or its React Router
    // Single Fetch `.data` endpoint. Keep the flag false in case a later
    // client navigation tries to mount the original route.
    route.hasLoader = false;
    route.hasClientLoader = false;
    sessionStorage.setItem(rescueStatusKey, "manifest-patched");
    return manifest;
  }

  function waitForAppAndSubmit() {
    const deadline = Date.now() + 20000;

    const timer = window.setInterval(() => {
      const router = window.__reactRouterDataRouter;
      const routerReady = Boolean(router && typeof router.navigate === "function");

      if (manifestPatch.isReady() && routerReady) {
        window.clearInterval(timer);
        sessionStorage.setItem(rescueStatusKey, "submitting-callback");
        Promise.resolve()
          .then(() => openConnectorShell(router))
          .then(() => submitRescuedCallback(manifestPatch.manifest()))
          .then((result) => finishWithPostAuth(result))
          .catch((error) => {
            if (isOwnershipError(error)) {
              handleOwnershipMismatch(error);
              return;
            }
            if (isActionDiscoveryError(error)) {
              handleActionDiscoveryFailure(error);
              return;
            }
            renderFailure(
              `Chatshare rejected the rescued callback: ${safeErrorMessage(error)}`,
            );
          });
        return;
      }

      if (isLoginSurface()) {
        window.clearInterval(timer);
        sessionStorage.setItem(rescueStatusKey, "redirecting-to-login");
        location.replace(loginPath);
        return;
      }

      if (isWorkSurface() || isMarketplaceSurface()) {
        window.clearInterval(timer);
        sessionStorage.setItem(
          rescueStatusKey,
          isWorkSurface() ? "leaving-work-surface" : "leaving-marketplace",
        );
        location.replace(documentShellPath);
        return;
      }

      if (Date.now() >= deadline) {
        window.clearInterval(timer);
        if (!isDocumentShell() || location.search) {
          sessionStorage.setItem(rescueStatusKey, "retrying-app-shell");
          location.replace(documentShellPath);
          return;
        }
        sessionStorage.setItem(rescueStatusKey, "redirecting-to-login");
        location.replace(loginPath);
      }
    }, 25);
  }

  function openConnectorShell(router) {
    if (isConnectorShell()) return undefined;
    sessionStorage.setItem(rescueStatusKey, "opening-app-shell");
    return router.navigate(documentShellPath, { replace: true });
  }

  async function submitRescuedCallback(manifest) {
    const client = await resolveChatshareApiClient(manifest);
    if (!client || typeof client.safePost !== "function") {
      throw new Error("Chatshare's connector API client is not available on this page.");
    }

    sessionStorage.setItem(rescueStatusKey, "submitting-callback");
    try {
      const result = await client.safePost(callbackApiPath, {
        requestBody: { full_redirect_url: fullRedirectUrl },
      });
      if (!result || typeof result !== "object") {
        throw new Error("Chatshare returned an empty callback response.");
      }
      return result;
    } catch (error) {
      if (!isMissingAuthError(error)) throw error;
      sessionStorage.setItem(rescueStatusKey, "redirecting-to-login");
      location.replace(loginPath);
      return new Promise(() => {});
    }
  }

  async function resolveChatshareApiClient(manifest) {
    const candidateUrls = [];
    const routeModule = manifest?.routes?.[callbackRouteId]?.module;
    for (const url of expandAssetCandidates(routeModule)) {
      candidateUrls.push(url);
    }
    for (const url of findLoadedRemixModules()) {
      if (!candidateUrls.some((existing) => existing.href === url.href)) {
        candidateUrls.push(url);
      }
    }

    for (const moduleUrl of candidateUrls) {
      const resolved = await resolveClientFromModuleGraph(moduleUrl);
      if (resolved) return resolved;
    }

    return undefined;
  }

  function remixAssetBases() {
    const bases = [location.origin + "/"];
    const pattern = /^(https:\/\/[^/]*openoai\.net\/cdn\/assets\/[^/]+\/)/;
    for (const el of document.querySelectorAll("script[src], link[href]")) {
      const spec = el.getAttribute("src") || el.getAttribute("href") || "";
      const match = spec.match(pattern);
      if (match) bases.push(match[1]);
    }
    for (const entry of performance.getEntriesByType("resource")) {
      const match = String(entry.name).match(pattern);
      if (match) bases.push(match[1]);
    }
    return Array.from(new Set(bases));
  }

  function expandAssetCandidates(spec) {
    if (!spec || typeof spec !== "string") return [];
    const urls = [];
    const seen = new Set();
    const add = (url) => {
      if (!url || seen.has(url.href)) return;
      seen.add(url.href);
      urls.push(url);
    };
    add(resolveAssetUrl(spec));
    if (!/^[a-z]+:/i.test(spec)) {
      for (const base of remixAssetBases()) {
        add(resolveAssetUrl(spec.replace(/^\.\//, ""), base));
        add(resolveAssetUrl(spec.split("/").pop(), base));
      }
    }
    return urls;
  }

  async function resolveClientFromModuleGraph(moduleUrl) {
    let source;
    try {
      source = await fetchText(moduleUrl);
    } catch {
      return undefined;
    }

    if (source.includes(`${callbackApiPath}`) && /\.safePost\(/.test(source)) {
      const binding = findImportedBinding(source, moduleUrl, findSafePostAlias(source));
      if (binding) {
        const apiModule = await import(binding.moduleUrl.href);
        return apiModule[binding.exportName];
      }
    }

    for (const imported of extractImportUrls(source, moduleUrl)) {
      let importedSource;
      try {
        importedSource = await fetchText(imported);
      } catch {
        continue;
      }
      if (!importedSource.includes(callbackApiPath) || !/\.safePost\(/.test(importedSource)) {
        continue;
      }
      const alias = findSafePostAlias(importedSource);
      const binding = findImportedBinding(importedSource, imported, alias);
      if (!binding) continue;
      const apiModule = await import(binding.moduleUrl.href);
      return apiModule[binding.exportName];
    }

    return undefined;
  }

  function findSafePostAlias(source) {
    const match = source.match(
      /([A-Za-z_$][\w$]*)\.safePost\(`\/aip\/connectors\/links\/oauth\/callback`/,
    );
    return match?.[1];
  }

  function extractImportUrls(source, sourceUrl) {
    const urls = [];
    const pattern = /from["']([^"']+\.js)["']/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const resolved = resolveAssetUrl(match[1], sourceUrl);
      if (resolved) urls.push(resolved);
    }
    return urls;
  }

  function findImportedBinding(source, sourceUrl, localAlias) {
    if (!localAlias) return undefined;
    const importPattern = /import\{([^}]*)\}from["']([^"']+)["']/g;
    let match;
    while ((match = importPattern.exec(source)) !== null) {
      for (const binding of match[1].split(",")) {
        const parts = binding.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (parts && parts[2] === localAlias) {
          const moduleUrl = resolveAssetUrl(match[2], sourceUrl);
          if (!moduleUrl) return undefined;
          return { exportName: parts[1], moduleUrl };
        }
      }
    }
    return undefined;
  }

  function findLoadedRemixModules() {
    const urls = [];
    for (const el of document.querySelectorAll("script[src], link[rel='modulepreload'][href]")) {
      const spec = el.getAttribute("src") || el.getAttribute("href");
      if (!spec || !/connector\.oauth|oauth.*callback/i.test(spec)) continue;
      const url = resolveAssetUrl(spec);
      if (url) urls.push(url);
    }
    return urls;
  }

  async function fetchText(url) {
    const response = await fetch(url.href, { credentials: "omit", cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  function resolveAssetUrl(spec, base = location.href) {
    if (!spec || typeof spec !== "string") return undefined;
    try {
      return new URL(spec, base);
    } catch {
      return undefined;
    }
  }

  function rememberPluginReturnUrl() {
    const normalized = pluginClientDestination(`${location.pathname}${location.hash}`);
    if (normalized) sessionStorage.setItem(returnKey, normalized);
  }

  function pluginIdFromConnector(connectorId) {
    if (typeof connectorId !== "string" || !/^[A-Za-z0-9_:-]+$/.test(connectorId)) return undefined;
    return connectorId.startsWith("plugin_") ? connectorId : `plugin_${connectorId}`;
  }

  function pluginClientDestination(value) {
    if (typeof value !== "string" || value.length === 0) return undefined;
    let parsed;
    try {
      parsed = new URL(value, location.origin);
    } catch {
      return undefined;
    }
    if (parsed.origin !== location.origin) return undefined;
    const pathMatch = parsed.pathname.match(/^\/plugins\/(plugin_[A-Za-z0-9_]+)/);
    if (pathMatch) return `/plugins/${pathMatch[1]}#settings/Plugins/${pathMatch[1]}`;
    const hashMatch = parsed.hash.match(/^#settings\/Plugins\/(plugin_[A-Za-z0-9_]+)/);
    if (hashMatch) return `/plugins/${hashMatch[1]}#settings/Plugins/${hashMatch[1]}`;
    return undefined;
  }

  function resolvePostAuthDestination(result) {
    const saved = pluginClientDestination(sessionStorage.getItem(returnKey) ?? "");
    if (saved) return saved;

    const pluginId = pluginIdFromConnector(result?.link?.connector_id);
    if (pluginId) return `/plugins/${pluginId}#settings/Plugins/${pluginId}`;

    const postAuthUrl = result?.post_auth_url;
    if (typeof postAuthUrl !== "string" || postAuthUrl.length === 0) {
      throw new Error("Chatshare did not return a post-auth destination.");
    }
    let next;
    try {
      next = new URL(postAuthUrl, location.origin);
    } catch {
      throw new Error("Chatshare returned an invalid post-auth destination.");
    }
    if (next.origin !== location.origin) {
      throw new Error("Chatshare returned a post-auth destination outside Chatshare.");
    }
    return pluginClientDestination(`${next.pathname}${next.search}${next.hash}`)
      ?? `${next.pathname}${next.search}${next.hash}`;
  }

  function finishWithPostAuth(result) {
    const destination = resolvePostAuthDestination(result);
    sessionStorage.setItem(attemptKey, "navigated");
    sessionStorage.setItem(rescueStatusKey, "router-navigation-complete");
    sessionStorage.removeItem(pendingKey);
    sessionStorage.removeItem(returnKey);

    const pluginDest = pluginClientDestination(destination);
    const router = window.__reactRouterDataRouter;
    if (pluginDest && router && typeof router.navigate === "function") {
      return Promise.resolve(router.navigate(pluginDest, { replace: true })).then(() => {
        if (!location.pathname.startsWith("/plugins/plugin_")) {
          history.replaceState(null, "", pluginDest);
        }
      });
    }
    if (pluginDest) {
      history.replaceState(null, "", pluginDest);
      return undefined;
    }
    location.replace(destination);
    return undefined;
  }

  function isMissingAuthError(error) {
    const message = safeErrorMessage(error).toLowerCase();
    return message.includes("no access token") || message.includes("unauthorized") || message.includes("401");
  }

  function isOwnershipError(error) {
    return /oauth link is not owned by the user/i.test(safeErrorMessage(error));
  }

  function isActionDiscoveryError(error) {
    return /authentication succeeded, action discovery failed/i.test(safeErrorMessage(error));
  }

  function handleActionDiscoveryFailure(error) {
    sessionStorage.setItem(attemptKey, "discovery-rejected");
    sessionStorage.setItem(rescueStatusKey, "action-discovery-failed");
    sessionStorage.removeItem(pendingKey);
    sessionStorage.removeItem(returnKey);
    renderFailure(
      `Chatshare accepted OAuth authentication, but MCP action discovery failed: ${safeErrorMessage(error)}. This callback cannot be replayed. Check the existing connector and refresh its actions from settings; investigate the authenticated MCP discovery response before authorizing again.`,
      {
        actionHref: connectorShellPath,
        actionLabel: "Return to connector settings",
      },
    );
  }

  function handleOwnershipMismatch(error) {
    sessionStorage.setItem(attemptKey, "ownership-rejected");
    sessionStorage.setItem(rescueStatusKey, "ownership-mismatch");
    sessionStorage.removeItem(pendingKey);
    sessionStorage.removeItem(returnKey);
    renderFailure(
      `Chatshare rejected this OAuth link for the current user: ${safeErrorMessage(error)}. The rejected callback will not be replayed. Sign in to the intended Chatshare account, then start a fresh authorization from connector settings.`,
      {
        actionHref: connectorShellPath,
        actionLabel: "Return to connector settings",
      },
    );
  }

  function readCallbackUrl() {
    if (location.hash.startsWith(fragmentPrefix)) {
      try {
        return new URL(location.hash.slice(fragmentPrefix.length), location.origin);
      } catch {
        renderFailure("The rescued OAuth callback URL is invalid.");
        return null;
      }
    }

    const pending = sessionStorage.getItem(pendingKey);
    if (!pending || isLoginSurface()) return null;
    try {
      return new URL(pending, location.origin);
    } catch {
      sessionStorage.removeItem(pendingKey);
      return null;
    }
  }

  function isLoginSurface() {
    return (
      location.pathname.startsWith("/pastel") ||
      Boolean(document.querySelector("script[src*='/pastel/assets/']")) ||
      Boolean(document.querySelector("link[href*='/pastel/assets/']"))
    );
  }

  function isWorkSurface() {
    return new URLSearchParams(location.search).get("surface") === "work";
  }

  function isChatHomeSurface() {
    if (location.search) return false;
    return location.pathname === documentShellPath || location.pathname.startsWith("/c/");
  }

  function isMarketplaceSurface() {
    return location.pathname === connectorShellPath && !location.pathname.startsWith(`${connectorShellPath}/plugin_`);
  }

  function isConnectorShell() {
    return location.pathname === documentShellPath;
  }

  function isDocumentShell() {
    return location.pathname === documentShellPath;
  }

  function nextShellUrl() {
    if (isLoginSurface()) return loginPath;
    return documentShellPath;
  }

  function installReactDomMismatchGuard() {
    if (typeof Node !== "function" || !Node.prototype) return;
    if (Node.prototype.__chatshareRescueDomGuard) return;
    Object.defineProperty(Node.prototype, "__chatshareRescueDomGuard", {
      value: true,
      configurable: true,
    });

    const originalRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function (child) {
      if (child && child.parentNode !== this) return child;
      return originalRemoveChild.apply(this, arguments);
    };

    const originalInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function (newNode, referenceNode) {
      if (referenceNode && referenceNode.parentNode !== this) return newNode;
      return originalInsertBefore.apply(this, arguments);
    };
  }

  function disableBrowserTranslate() {
    const apply = () => {
      const html = document.documentElement;
      if (!html) return false;
      html.setAttribute("translate", "no");
      html.classList.add("notranslate");
      return true;
    };
    if (apply()) return;
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  }

  function watchLoginThenResume() {
    const pending = sessionStorage.getItem(pendingKey);
    if (!pending || !location.pathname.startsWith("/pastel")) return;

    const deadline = Date.now() + 5 * 60 * 1000;
    const timer = window.setInterval(() => {
      if (Date.now() >= deadline) {
        window.clearInterval(timer);
        return;
      }
      if (!location.pathname.startsWith("/pastel")) {
        window.clearInterval(timer);
        return;
      }
      if (location.hash && !location.hash.startsWith("#/login")) {
        window.clearInterval(timer);
        sessionStorage.setItem(rescueStatusKey, "resuming-after-login");
        location.replace(documentShellPath);
      }
    }, 200);
  }

  function renderFailure(message, options = {}) {
    const safeMessage = escapeHtml(message);
    const actionHref = escapeHtml(options.actionHref ?? "/pastel/");
    const actionLabel = escapeHtml(options.actionLabel ?? "Open Chatshare login");
    document.open();
    document.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Chatshare OAuth rescue</title>
  <style>
    body { margin: 0; background: #111827; color: #e5e7eb; font: 16px/1.5 system-ui, sans-serif; }
    main { max-width: 720px; margin: 12vh auto; padding: 28px; background: #1f2937; border: 1px solid #374151; border-radius: 14px; }
    h1 { margin-top: 0; font-size: 24px; }
    p { color: #d1d5db; }
    code { color: #bae6fd; overflow-wrap: anywhere; }
    a { color: #7dd3fc; }
  </style>
</head>
<body>
  <main>
    <h1>OAuth callback rescue stopped</h1>
    <p>${safeMessage}</p>
    <p>Status: <code>${escapeHtml(sessionStorage.getItem(rescueStatusKey) ?? "unknown")}</code></p>
    <p><a href="${actionHref}">${actionLabel}</a></p>
    <p>No authorization code, access token, or refresh token was logged or copied by this extension.</p>
  </main>
</body>
</html>`);
    document.close();
  }

  function safeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
