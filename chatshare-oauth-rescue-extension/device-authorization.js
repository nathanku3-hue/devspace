(() => {
  "use strict";

  const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
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
    renderStatus("Checking this enrolled PC…", false);

    try {
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

      proofInput.value = proof;
      form.dataset.devspaceDeviceAuthState = "submitting";
      renderStatus("Enrolled PC verified. Connecting…", false);
      form.requestSubmit();
    } catch (error) {
      form.dataset.devspaceDeviceAuthState = "failed";
      setRetryEnabled(true);
      renderStatus(
        `This PC could not be verified: ${safeErrorMessage(error)} Ensure DevSpace is running locally, then retry.`,
        true,
      );
    }
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
