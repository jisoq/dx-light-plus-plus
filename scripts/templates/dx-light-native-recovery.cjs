function createNativeRecoveryPolicy(options = {}) {
  const isDuplicationSessionLossReason = typeof options.isDuplicationSessionLossReason === "function"
    ? options.isDuplicationSessionLossReason
    : () => false;
  const isProtectedCaptureReason = typeof options.isProtectedCaptureReason === "function"
    ? options.isProtectedCaptureReason
    : () => false;
  const recoveryCooldownMs = positiveInteger(options.recoveryCooldownMs, 30000);
  const protectedContentCooldownMs = Math.max(
    recoveryCooldownMs,
    positiveInteger(options.protectedContentCooldownMs, 600000),
  );
  const unstableSessionCooldownMs = Math.max(
    recoveryCooldownMs,
    positiveInteger(options.unstableSessionCooldownMs, 120000),
  );
  const sessionLossWindowMs = positiveInteger(options.sessionLossWindowMs, 60000);
  const sessionLossThreshold = positiveInteger(options.sessionLossThreshold, 3);
  const sessionLossEvents = [];

  function classifyFailure(reason, nowMs = Date.now()) {
    const text = String(reason || "");
    if (isProtectedCaptureReason(text)) {
      resetSessionLosses();
      return {
        action: "cooldown",
        reason: text,
        cooldownMs: protectedContentCooldownMs,
        protectedContent: true,
        sessionLossCount: 0,
      };
    }

    if (!isDuplicationSessionLossReason(text)) {
      return {
        action: "unknown",
        reason: text,
        cooldownMs: 0,
        protectedContent: false,
        sessionLossCount: sessionLossEvents.length,
      };
    }

    const safeNow = normalizeTime(nowMs);
    pruneSessionLosses(safeNow);
    sessionLossEvents.push(safeNow);
    pruneSessionLosses(safeNow);

    if (sessionLossEvents.length >= sessionLossThreshold) {
      const sessionLossCount = sessionLossEvents.length;
      resetSessionLosses();
      return {
        action: "cooldown",
        reason: `unstable DXGI duplication session after ${sessionLossCount} losses: ${text}`,
        cooldownMs: unstableSessionCooldownMs,
        protectedContent: false,
        sessionLossCount,
      };
    }

    return {
      action: "restart",
      reason: text,
      cooldownMs: 0,
      protectedContent: false,
      sessionLossCount: sessionLossEvents.length,
    };
  }

  function resetSessionLosses() {
    sessionLossEvents.length = 0;
  }

  function pruneSessionLosses(nowMs) {
    const cutoff = nowMs - sessionLossWindowMs;
    while (sessionLossEvents.length > 0 && sessionLossEvents[0] < cutoff) {
      sessionLossEvents.shift();
    }
  }

  return {
    classifyFailure,
    resetSessionLosses,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.round(number);
}

function normalizeTime(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

module.exports = {
  createNativeRecoveryPolicy,
};
