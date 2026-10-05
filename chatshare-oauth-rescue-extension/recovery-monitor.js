(() => {
  "use strict";

  if (window.__devspaceRecoveryMonitorInstalled) return;
  Object.defineProperty(window, "__devspaceRecoveryMonitorInstalled", {
    value: true,
    configurable: true,
  });

  const leaseAttribute = "data-devspace-recovery-lease";
  const stateAttribute = "data-devspace-recovery-state";
  const pendingAttribute = "data-devspace-recovery-pending";
  const wakeEventName = "devspace:recovery-signal";
  const silentIdleMs = 45_000;
  const settleGraceMs = 2_000;
  const wakeDebounceMs = 150;
  const recoveryTextPattern =
    /(?:Stopped talking to (?:DevSpace Local|devspace)|已停止(?:與|和)\s*(?:DevSpace Local|devspace)(?:交談|对话|通信)?|連線中斷|连线中断|連接中斷|连接中断|訊息超時|讯息超时|消息超時|消息超时|message timed out|connection (?:lost|interrupted|disconnected)|\b502\s+Bad Gateway\b|\b504\s+Gateway Time-?out\b|Cloudflare Ray ID|Something went wrong|An error occurred|發生錯誤|发生错误|出了點問題|出了点问题)/i;
  const recoveryControlPattern = /^(?:resume|retry|try again|重試|重试|再試一次|再试一次)$/i;

  let activeLease = "";
  let activityObserver;
  let idleTimer;
  let settleTimer;
  let leaseObserver;
  let sawActiveTurn = false;
  let pendingTurnUntil = 0;
  let lastWakeAt = 0;
  let lastWakeFingerprint = "";

  const isConversation = () =>
    location.hostname === "chatshare.xyz" && /^\/c\/[^/?#]+/.test(location.pathname);

  const currentLease = () =>
    document.documentElement?.getAttribute(leaseAttribute)?.trim() ?? "";

  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const clearSettleTimer = () => {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  };

  const emitWake = (kind, fingerprint = kind) => {
    if (!activeLease || !isConversation()) return;
    const now = Date.now();
    if (
      fingerprint === lastWakeFingerprint &&
      now - lastWakeAt < wakeDebounceMs
    ) {
      return;
    }
    lastWakeFingerprint = fingerprint;
    lastWakeAt = now;
    document.documentElement?.setAttribute(pendingAttribute, "1");
    document.dispatchEvent(new CustomEvent(wakeEventName, { detail: { kind } }));
  };

  const armSilentIdle = () => {
    clearIdleTimer();
    if (!activeLease || !isConversation()) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (activeLease && currentLease() === activeLease && isConversation()) {
        emitWake("silent-idle", "silent-idle:" + location.pathname);
      }
    }, silentIdleMs);
  };

  const textFromMutation = (record) => {
    const chunks = [];
    if (record.type === "characterData") {
      chunks.push(record.target.textContent ?? "");
    }
    for (const node of record.addedNodes ?? []) {
      chunks.push(node.textContent ?? "");
    }
    return chunks.join(" ").replace(/\s+/g, " ").trim().slice(-12_000);
  };

  const mutationLooksActionable = (record) => {
    const text = textFromMutation(record);
    if (text && recoveryTextPattern.test(text)) return true;

    const controls = [];
    const addControls = (node) => {
      const element = node instanceof Element ? node : node?.parentElement;
      if (!element) return;
      if (element.matches?.("button, [role='button']")) controls.push(element);
      const closest = element.closest?.("button, [role='button']");
      if (closest) controls.push(closest);
      for (const nested of element.querySelectorAll?.("button, [role='button']") ?? []) {
        controls.push(nested);
      }
    };
    addControls(record.target);
    for (const node of record.addedNodes ?? []) addControls(node);
    for (const node of record.removedNodes ?? []) addControls(node);

    return controls.some((control) => {
      const testId = control.getAttribute("data-testid") ?? "";
      const ariaLabel = control.getAttribute("aria-label") ?? "";
      const label = [
        ariaLabel,
        control.getAttribute("title") ?? "",
        control.textContent ?? "",
      ]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return (
        /^(?:stop-button|send-button)$/i.test(testId) ||
        /^(?:stop|send)\b/i.test(ariaLabel) ||
        recoveryControlPattern.test(label)
      );
    });
  };

  const hasVisibleStopControl = () =>
    Array.from(
      document.querySelectorAll(
        'button[data-testid="stop-button"], button[aria-label^="Stop"]',
      ),
    ).some((control) => {
      const style = getComputedStyle(control);
      return style.visibility !== "hidden" && style.display !== "none" && control.getClientRects().length > 0;
    });

  const updateTurnState = () => {
    if (!activeLease || currentLease() !== activeLease || !isConversation()) return;
    const root = document.documentElement;
    if (!root) return;

    if (hasVisibleStopControl()) {
      sawActiveTurn = true;
      pendingTurnUntil = 0;
      clearSettleTimer();
      root.setAttribute(stateAttribute, "active");
      return;
    }

    const pendingRemainingMs = pendingTurnUntil - Date.now();
    if (pendingRemainingMs > 0) {
      clearSettleTimer();
      root.setAttribute(stateAttribute, "pending");
      settleTimer = setTimeout(updateTurnState, pendingRemainingMs);
      return;
    }

    if (!sawActiveTurn || root.getAttribute(stateAttribute) === "settled") return;
    clearSettleTimer();

    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (
        !activeLease ||
        currentLease() !== activeLease ||
        !isConversation() ||
        hasVisibleStopControl()
      ) {
        return;
      }
      root.setAttribute(stateAttribute, "settled");
      emitWake("turn-settled", "turn-settled:" + location.pathname);
    }, settleGraceMs);
  };

  const scanCurrentDocument = () => {
    if (!activeLease || !isConversation()) return;
    const bodyText = (document.body?.innerText ?? "").slice(-20_000);
    if (recoveryTextPattern.test(bodyText)) {
      emitWake(
        "recovery-ui",
        "recovery-ui:" + location.pathname + ":" + bodyText.slice(-512),
      );
      return;
    }
    for (const control of document.querySelectorAll("button, [role='button']")) {
      const label = [
        control.getAttribute("aria-label") ?? "",
        control.getAttribute("title") ?? "",
        control.textContent ?? "",
      ]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (recoveryControlPattern.test(label)) {
        emitWake(
          "recovery-control",
          "recovery-control:" + location.pathname + ":" + label,
        );
        return;
      }
    }
  };

  const onActivity = (event) => {
    if (!activeLease) return;
    armSilentIdle();

    const target = event.target instanceof Element ? event.target : null;
    const sendControl = target?.closest?.(
      'button[data-testid="send-button"], button[aria-label^="Send"]',
    );
    if (event.type === "submit" || sendControl) {
      pendingTurnUntil = Date.now() + silentIdleMs;
      clearSettleTimer();
      document.documentElement?.setAttribute(stateAttribute, "pending");
      settleTimer = setTimeout(updateTurnState, silentIdleMs);
    }
  };

  const activate = (lease) => {
    if (!lease || lease === activeLease) return;
    deactivate();
    activeLease = lease;

    activityObserver = new MutationObserver((records) => {
      if (!activeLease || currentLease() !== activeLease) {
        syncLease();
        return;
      }
      armSilentIdle();
      updateTurnState();
      if (records.some(mutationLooksActionable)) {
        emitWake("recovery-mutation", "recovery-mutation:" + location.pathname);
      }
    });
    // Only leased pages install this observer. Watching the document rather
    // than a specific <main> survives React replacing the conversation root.
    activityObserver.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-testid", "disabled"],
    });

    document.addEventListener("input", onActivity, true);
    document.addEventListener("submit", onActivity, true);
    document.addEventListener("click", onActivity, true);
    window.addEventListener("popstate", onNavigation);
    window.addEventListener("hashchange", onNavigation);
    document.addEventListener("visibilitychange", onNavigation);

    armSilentIdle();
    updateTurnState();
    queueMicrotask(scanCurrentDocument);
  };

  function deactivate() {
    clearIdleTimer();
    clearSettleTimer();
    activityObserver?.disconnect();
    activityObserver = undefined;
    document.removeEventListener("input", onActivity, true);
    document.removeEventListener("submit", onActivity, true);
    document.removeEventListener("click", onActivity, true);
    window.removeEventListener("popstate", onNavigation);
    window.removeEventListener("hashchange", onNavigation);
    document.removeEventListener("visibilitychange", onNavigation);
    document.documentElement?.removeAttribute(stateAttribute);
    document.documentElement?.removeAttribute(pendingAttribute);
    activeLease = "";
    sawActiveTurn = false;
    pendingTurnUntil = 0;
    lastWakeFingerprint = "";
    lastWakeAt = 0;
  }

  function onNavigation() {
    if (!activeLease) return;
    armSilentIdle();
    updateTurnState();
    queueMicrotask(scanCurrentDocument);
  }

  function syncLease() {
    const lease = currentLease();
    if (!lease) {
      if (activeLease) deactivate();
      return;
    }
    if (lease !== activeLease) activate(lease);
  }

  const installLeaseObserver = () => {
    if (!document.documentElement) {
      const bootstrapObserver = new MutationObserver(() => {
        if (!document.documentElement) return;
        bootstrapObserver.disconnect();
        installLeaseObserver();
      });
      bootstrapObserver.observe(document, { childList: true });
      return;
    }

    leaseObserver?.disconnect();
    leaseObserver = new MutationObserver(syncLease);
    leaseObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [leaseAttribute],
    });
    syncLease();
  };

  installLeaseObserver();
})();
