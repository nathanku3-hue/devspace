(() => {
  "use strict";

  const fragmentPrefix = "#cs_oauth_callback=";
  const callbackRouteId = "routes/connector.oauth.$callback_id";
  const rescueStatusKey = "chatshare-oauth-callback-rescue-status";
  const pendingKey = "chatshare-oauth-callback-rescue-pending";
  const loginPath = "/pastel/#/login";
  const appShellPath = "/";

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
  sessionStorage.setItem(pendingKey, `${callbackUrl.pathname}${callbackUrl.search}`);

  // ?surface=work boots the chat UI, not the settings/connector Remix tree.
  // replaceState cannot switch documents, so leave that query with a real load.
  if (isWorkSurface()) {
    sessionStorage.setItem(rescueStatusKey, "leaving-work-surface");
    location.replace(appShellPath);
    return;
  }

  if (location.hash.startsWith(fragmentPrefix)) {
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
  if (sessionStorage.getItem(attemptKey) === "navigated") {
    renderFailure(
      "This OAuth callback has already been processed once. Return to connector settings and start a fresh authorization.",
    );
    return;
  }

  sessionStorage.setItem(attemptKey, "started");
  sessionStorage.setItem(rescueStatusKey, "installing-manifest-patch");

  const manifestPatch = installManifestPatch();
  waitForRouterAndNavigate();

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
        return Boolean(
          assignmentObserved &&
            current?.routes?.[callbackRouteId] &&
            current.routes[callbackRouteId].hasLoader === false,
        );
      },
      release() {
        const current = patchManifest(window.__reactRouterManifest ?? manifestValue);
        Object.defineProperty(window, "__reactRouterManifest", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: current,
        });
      },
    };
  }

  function patchManifest(manifest) {
    if (!manifest || typeof manifest !== "object") return manifest;
    const route = manifest.routes?.[callbackRouteId];
    if (!route || typeof route !== "object") return manifest;

    // Chatshare does not serve the callback document or its React Router
    // Single Fetch `.data` endpoint. The callback component itself consumes no
    // loader data; it only performs the authenticated callback API call in an
    // effect. Disabling this one incorrect loader flag prevents React Router
    // from issuing the broken data request and lets the original component run.
    route.hasLoader = false;
    route.hasClientLoader = false;
    sessionStorage.setItem(rescueStatusKey, "manifest-patched");
    return manifest;
  }

  function waitForRouterAndNavigate() {
    const deadline = Date.now() + 20000;
    const destination = `${callbackUrl.pathname}${callbackUrl.search}`;

    const timer = window.setInterval(() => {
      const router = window.__reactRouterDataRouter;
      const routerReady = Boolean(router && typeof router.navigate === "function");

      if (manifestPatch.isReady() && routerReady) {
        window.clearInterval(timer);
        manifestPatch.release();
        sessionStorage.setItem(rescueStatusKey, "router-navigation-started");

        Promise.resolve(router.navigate(destination, { replace: true }))
          .then(() => {
            sessionStorage.setItem(attemptKey, "navigated");
            sessionStorage.setItem(rescueStatusKey, "router-navigation-complete");
            sessionStorage.removeItem(pendingKey);
          })
          .catch((error) => {
            renderFailure(
              `Chatshare rejected the rescued callback navigation: ${safeErrorMessage(error)}`,
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

      if (isWorkSurface()) {
        window.clearInterval(timer);
        sessionStorage.setItem(rescueStatusKey, "leaving-work-surface");
        location.replace(appShellPath);
        return;
      }

      if (Date.now() >= deadline) {
        window.clearInterval(timer);
        if (location.pathname !== appShellPath || location.search) {
          sessionStorage.setItem(rescueStatusKey, "retrying-app-shell");
          location.replace(appShellPath);
          return;
        }
        sessionStorage.setItem(rescueStatusKey, "redirecting-to-login");
        location.replace(loginPath);
      }
    }, 25);
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

  function nextShellUrl() {
    if (isLoginSurface()) return loginPath;
    return appShellPath;
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
        location.replace(appShellPath);
      }
    }, 200);
  }

  function renderFailure(message) {
    const safeMessage = escapeHtml(message);
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
    <p><a href="/pastel/">Open Chatshare login</a></p>
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
