(() => {
  "use strict";

  const DEVSPACE_ORIGIN = "https://devspace-proxy.kitlongku.workers.dev";
  const DEVSPACE_AUTHORIZE_PATH = "/authorize";
  const LOOPBACK_PROOF_URL = "http://127.0.0.1:7677/devspace-device-proof";
  const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
  const PROOF_TIMEOUT_MS = 8000;
  const LOCAL_NETWORK_HELP =
    "If Chrome asks to allow local network or apps on this device, choose Allow. Otherwise open chrome://extensions → Chatshare OAuth Callback Rescue → Details → Site settings and set Local network access (or Apps on device) to Allow, then retry.";

  const form = document.querySelector('form[data-devspace-device-auth="required"]');
  if (!(form instanceof HTMLFormElement)) return;

  const challengeInput = form.elements.namedItem("device_challenge");
  const bindingInput = form.elements.namedItem("device_binding");
  const proofInput = form.elements.namedItem("device_proof");
  const status = document.getElementById("devspace-device-status");
  const retry = document.getElementById("devspace-device-retry");

  if (
    !(challengeInput instanceof HTMLInputElement) ||
    !(bindingInput instanceof HTMLInputElement) ||
    !(proofInput instanceof HTMLInputElement)
  ) {
    renderStatus("The device authorization form is incomplete.", true);
    return;
  }

  retry?.addEventListener("click", () => {
    void authorizeFromThisPc();
  });

  void authorizeFromThisPc();

  async function authorizeFromThisPc() {
    if (form.dataset.devspaceDeviceAuthState === "submitting") return;

    const challenge = challengeInput.value;
    const binding = bindingInput.value;
    if (!BASE64URL_SHA256.test(challenge) || !BASE64URL_SHA256.test(binding)) {
      renderStatus("The device challenge is invalid. Reload this authorization page.", true);
      return;
    }

    form.dataset.devspaceDeviceAuthState = "checking";
    proofInput.value = "";
    setRetryEnabled(false);
    renderStatus(
      "Checking this enrolled PC… If Chrome asks to allow local network or apps on this device, choose Allow.",
      false,
    );

    try {
      const proof = await obtainProof(challenge, binding);
      if (!BASE64URL_SHA256.test(proof)) {
        throw new Error("The enrolled-PC signer returned an invalid proof.");
      }

      proofInput.value = proof;
      form.dataset.devspaceDeviceAuthState = "submitting";
      renderStatus("Enrolled PC verified. Connecting…", false);
      form.requestSubmit();
    } catch (error) {
      form.dataset.devspaceDeviceAuthState = "failed";
      setRetryEnabled(true);
      renderStatus(
        `This PC could not be verified: ${safeErrorMessage(error)} ${LOCAL_NETWORK_HELP} Ensure DevSpace is running locally, then retry.`,
        true,
      );
    }
  }

  async function obtainProof(challenge, binding) {
    assertAuthorizePage();
    try {
      return await withTimeout(fetchLoopbackProof(challenge, binding), PROOF_TIMEOUT_MS);
    } catch (directError) {
      try {
        return await withTimeout(fetchProofViaServiceWorker(challenge, binding), PROOF_TIMEOUT_MS);
      } catch {
        throw annotateNetworkError(directError);
      }
    }
  }

  async function fetchLoopbackProof(challenge, binding) {
    const request = {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "X-DevSpace-Extension-Id": chrome.runtime.id,
      },
      body: JSON.stringify({ challenge, binding }),
    };
    const response = await fetchWithLocalAddressSpace(LOOPBACK_PROOF_URL, request);
    if (!response.ok) {
      throw new Error(`The enrolled-PC signer rejected the request (${response.status}).`);
    }

    const body = await response.json();
    const proof = String(body?.proof ?? "");
    if (!BASE64URL_SHA256.test(proof)) {
      throw new Error("The enrolled-PC signer returned an invalid proof.");
    }
    return proof;
  }

  async function fetchWithLocalAddressSpace(url, request) {
    for (const space of ["loopback", "local"]) {
      try {
        return await fetch(url, { ...request, targetAddressSpace: space });
      } catch (error) {
        if (!isUnknownAddressSpaceError(error)) throw error;
      }
    }
    return await fetch(url, request);
  }

  async function fetchProofViaServiceWorker(challenge, binding) {
    const response = await chrome.runtime.sendMessage({
      type: "devspace-device-proof",
      challenge,
      binding,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The enrolled-PC signer did not respond.");
    }
    const proof = String(response.proof ?? "");
    if (!BASE64URL_SHA256.test(proof)) {
      throw new Error("The enrolled-PC signer returned an invalid proof.");
    }
    return proof;
  }

  function assertAuthorizePage() {
    const pageUrl = new URL(location.href);
    if (pageUrl.origin !== DEVSPACE_ORIGIN || pageUrl.pathname !== DEVSPACE_AUTHORIZE_PATH) {
      throw new Error("Device proof request came from an untrusted page.");
    }
  }

  function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The enrolled-PC signer did not respond in time."));
      }, timeoutMs);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function isUnknownAddressSpaceError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /targetAddressSpace|address space|Failed to construct 'Request'/i.test(message);
  }

  function annotateNetworkError(error) {
    const message = safeErrorMessage(error);
    if (/abort|timeout|did not respond|Failed to fetch|NetworkError|Permission|address space/i.test(message)) {
      return new Error(
        `${message} Chrome may be blocking loopback access from this tab.`,
      );
    }
    return error instanceof Error ? error : new Error(message);
  }

  function setRetryEnabled(enabled) {
    if (retry instanceof HTMLButtonElement) retry.disabled = !enabled;
  }

  function renderStatus(message, failed) {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", failed);
    status.classList.toggle("status", !failed);
  }

  function safeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
})();
