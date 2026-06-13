const { parentPort, workerData } = require("worker_threads");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  startCaptureMultiScreens,
  stopCaptureMultiScreens,
} = require("@warren-robobloq/quiklight");
const {
  createFrameCoaster,
  isDuplicationSessionLossReason,
  isFlatBlackFrame,
  isProtectedCaptureReason,
  shouldCoastCaptureFrame,
} = require("./dx-light-frame-coasting.cjs");
const {
  createNativeRecoveryPolicy,
} = require("./dx-light-native-recovery.cjs");
const {
  detectProtectedMediaOnDisplay,
} = require("./dx-light-protected-media-guard.cjs");

const {
  displays = [],
  finalSyncSpeed = 80,
  samplingRate = 80,
  edgeCapture = false,
  edgeNumber = 3,
} = workerData;

let exiting = false;
let timer = null;
let regionIndex = 0;
let nativeProcess = null;
let nativeRestartTimer = null;
let nativeCooldownTimer = null;
let coastingTimer = null;
let nativeRestartAttempts = 0;
let sequentialStarted = false;
let nativeCooldownUntil = 0;
let nativeFlatFrameCount = 0;

const NATIVE_RECOVERY_COOLDOWN_MS = Math.max(1000, Number(process.env.DX_LIGHT_NATIVE_RECOVERY_COOLDOWN_MS || 30000));
const NATIVE_PROTECTED_CONTENT_COOLDOWN_MS = Math.max(
  NATIVE_RECOVERY_COOLDOWN_MS,
  Math.round(clampNumber(Number(process.env.DX_LIGHT_PROTECTED_CONTENT_COOLDOWN_MS || 600000), 1000, 3600000, 600000)),
);
const NATIVE_UNSTABLE_SESSION_COOLDOWN_MS = Math.max(
  NATIVE_RECOVERY_COOLDOWN_MS,
  Math.round(clampNumber(Number(process.env.DX_LIGHT_UNSTABLE_SESSION_COOLDOWN_MS || 120000), 1000, 3600000, 120000)),
);
const NATIVE_SESSION_LOSS_WINDOW_MS = Math.round(
  clampNumber(Number(process.env.DX_LIGHT_SESSION_LOSS_WINDOW_MS || 60000), 1000, 600000, 60000),
);
const NATIVE_SESSION_LOSS_THRESHOLD = Math.round(
  clampNumber(Number(process.env.DX_LIGHT_SESSION_LOSS_THRESHOLD || 3), 1, 20, 3),
);
const PROTECTED_MEDIA_PREFLIGHT_HOLD_MS = Math.max(
  NATIVE_PROTECTED_CONTENT_COOLDOWN_MS,
  Math.round(clampNumber(Number(process.env.DX_LIGHT_PROTECTED_MEDIA_PREFLIGHT_HOLD_MS || 600000), 1000, 3600000, 600000)),
);
const COAST_TICK_MS = Math.max(33, Math.round(finalSyncSpeed || 80));
const DEFAULT_OUTPUT_BRIGHTNESS_GAIN = 1;
const OUTPUT_BRIGHTNESS_GAIN = clampNumber(
  Number(process.env.DX_LIGHT_OUTPUT_BRIGHTNESS_GAIN || DEFAULT_OUTPUT_BRIGHTNESS_GAIN),
  1,
  2,
  DEFAULT_OUTPUT_BRIGHTNESS_GAIN,
);
const nativeRecoveryPolicy = createNativeRecoveryPolicy({
  isDuplicationSessionLossReason,
  isProtectedCaptureReason,
  recoveryCooldownMs: NATIVE_RECOVERY_COOLDOWN_MS,
  protectedContentCooldownMs: NATIVE_PROTECTED_CONTENT_COOLDOWN_MS,
  unstableSessionCooldownMs: NATIVE_UNSTABLE_SESSION_COOLDOWN_MS,
  sessionLossWindowMs: NATIVE_SESSION_LOSS_WINDOW_MS,
  sessionLossThreshold: NATIVE_SESSION_LOSS_THRESHOLD,
});
const coasters = new Map();

function logNativeSampler(message) {
  try {
    const logDir = path.join(process.resourcesPath || path.join(process.cwd(), "resources"), "dxlight-native");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "native-sampler-worker.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never break capture.
  }
}

process.on("uncaughtException", (error) => {
  parentPort.postMessage({ type: "error", error: error.stack });
});

process.on("unhandledRejection", (error) => {
  parentPort.postMessage({ type: "unhandled-rejection", reason: error && error.stack ? error.stack : String(error) });
});

const stopNative = () => {
  try {
    stopCaptureMultiScreens();
  } catch {
    // Native stop may race with worker shutdown.
  }
};

const clearNativeRestartTimer = () => {
  if (nativeRestartTimer) {
    clearTimeout(nativeRestartTimer);
    nativeRestartTimer = null;
  }
};

const clearNativeCooldownTimer = () => {
  if (nativeCooldownTimer) {
    clearTimeout(nativeCooldownTimer);
    nativeCooldownTimer = null;
  }
};

const clearCoastingTimer = () => {
  if (coastingTimer) {
    clearTimeout(coastingTimer);
    coastingTimer = null;
  }
};

const killNativeProcess = () => {
  if (nativeProcess) {
    try {
      nativeProcess.kill();
    } catch {
      // Process shutdown can race with worker shutdown.
    }
    nativeProcess = null;
  }
};

const stopNativeSampler = () => {
  clearNativeRestartTimer();
  clearNativeCooldownTimer();
  clearCoastingTimer();
  killNativeProcess();
};

const toBytes = (value) => {
  if (!value) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((left, right) => Number(left) - Number(right));
    return Uint8Array.from(keys.map((key) => Number(value[key] || 0)));
  }
  return null;
};

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function clampByte(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

function boostFrameBrightness(frame) {
  if (OUTPUT_BRIGHTNESS_GAIN <= 1) {
    return frame;
  }

  const output = new Uint8Array(frame.length);
  for (let index = 0; index < frame.length; index += 1) {
    output[index] = clampByte(Number(frame[index] || 0) * OUTPUT_BRIGHTNESS_GAIN);
  }
  return output;
}

const stateFor = (display, rate) => {
  const cols = Math.max(1, Math.ceil(display.width / rate));
  const rows = Math.max(1, Math.ceil(display.height / rate));
  return {
    display,
    cols,
    rows,
    buffer: new Uint8Array(3 * cols * rows),
    seen: new Set(),
    required: Number(edgeNumber) === 4 ? 4 : 3,
  };
};

const states = new Map();
const regions = [];

function addRegion(name, source, display, offsetX, offsetY) {
  regions.push({ name, source, display, offsetX, offsetY });
}

function buildRegions() {
  states.clear();
  regions.length = 0;

  for (const display of displays) {
    const state = stateFor(display, samplingRate);
    states.set(display.displayId, state);

    const horizontalThickness = Math.min(display.height, Math.max(samplingRate, 3 * samplingRate));
    const verticalThickness = Math.min(display.width, Math.max(samplingRate, 3 * samplingRate));
    const rightOffset = state.cols - Math.max(1, Math.ceil(verticalThickness / samplingRate));
    const bottomOffset = state.rows - Math.max(1, Math.ceil(horizontalThickness / samplingRate));

    addRegion("top", display, {
      ...display,
      x: display.x,
      y: display.y,
      width: display.width,
      height: horizontalThickness,
    }, 0, 0);

    addRegion("left", display, {
      ...display,
      x: display.x,
      y: display.y,
      width: verticalThickness,
      height: display.height,
    }, 0, 0);

    addRegion("right", display, {
      ...display,
      x: display.x + display.width - verticalThickness,
      y: display.y,
      width: verticalThickness,
      height: display.height,
    }, rightOffset, 0);

    if (Number(edgeNumber) === 4) {
      addRegion("bottom", display, {
        ...display,
        x: display.x,
        y: display.y + display.height - horizontalThickness,
        width: display.width,
        height: horizontalThickness,
      }, 0, bottomOffset);
    }
  }
}

function applyRegion(region, frameMap) {
  const state = states.get(region.source.displayId);
  if (!state) {
    return;
  }

  const bytes = toBytes(frameMap[region.source.displayId]);
  if (!bytes) {
    return;
  }

  const regionCols = Math.max(1, Math.ceil(region.display.width / samplingRate));
  const regionRows = Math.max(1, Math.ceil(region.display.height / samplingRate));
  for (let row = 0; row < regionRows; row += 1) {
    for (let col = 0; col < regionCols; col += 1) {
      const targetCol = region.offsetX + col;
      const targetRow = region.offsetY + row;
      if (targetCol < 0 || targetRow < 0 || targetCol >= state.cols || targetRow >= state.rows) {
        continue;
      }

      const sourceOffset = 3 * (row * regionCols + col);
      const targetOffset = 3 * (targetRow * state.cols + targetCol);
      state.buffer[targetOffset] = bytes[sourceOffset] || 0;
      state.buffer[targetOffset + 1] = bytes[sourceOffset + 1] || 0;
      state.buffer[targetOffset + 2] = bytes[sourceOffset + 2] || 0;
    }
  }

  state.seen.add(region.name);
  if (state.seen.size >= state.required) {
    postFrameForDisplay(state.display.displayId, state.buffer.slice(0), state.cols, state.rows, {
      mode: "sequential-edge",
      backend: "quiklight-region-fallback",
      reason: "",
    });
  }
}

function schedule(delay = 0) {
  if (!exiting) {
    timer = setTimeout(captureNext, delay);
  }
}

function nativeSamplerCandidates() {
  return [
    process.env.DX_LIGHT_NATIVE_SAMPLER_PATH,
    path.join(process.resourcesPath || process.cwd(), "dxlight-native", "DxLightDxgiBorderSampler.exe"),
    path.join(process.cwd(), "resources", "dxlight-native", "DxLightDxgiBorderSampler.exe"),
    path.join(process.cwd(), "native", "bin", "DxLightDxgiBorderSampler.exe"),
  ].filter(Boolean);
}

function findNativeSampler() {
  return nativeSamplerCandidates().find((candidate) => fs.existsSync(candidate));
}

function postNativeStatus(reason, extra = {}) {
  parentPort.postMessage({
    type: "native-border-status",
    mode: "native-border",
    backend: "dxgi-desktop-duplication",
    reason: reason || "",
    brightnessGain: OUTPUT_BRIGHTNESS_GAIN,
    ...extra,
  });
}

function displayKey(displayId) {
  const display = displays[0];
  return displayId || (display && display.displayId) || "DISPLAY1";
}

function gridForDisplay(display, cols, rows) {
  return {
    cols: Math.max(1, Math.round(cols || Math.ceil((display && display.width || 1) / samplingRate))),
    rows: Math.max(1, Math.round(rows || Math.ceil((display && display.height || 1) / samplingRate))),
  };
}

function normalizeFrameBytes(frame, cols, rows) {
  const bytes = toBytes(frame);
  const expectedLength = Math.max(1, cols * rows * 3);
  if (!bytes || bytes.length < expectedLength) {
    return null;
  }
  return bytes.length === expectedLength ? bytes : bytes.slice(0, expectedLength);
}

function nativeCooldownMs(now = Date.now()) {
  return Math.max(0, nativeCooldownUntil - now);
}

function coasterFor(displayId) {
  const key = displayKey(displayId);
  if (!coasters.has(key)) {
    coasters.set(key, createFrameCoaster());
  }
  return coasters.get(key);
}

function postOutputFrame(displayId, frame) {
  const output = {};
  output[displayKey(displayId)] = boostFrameBrightness(frame);
  parentPort.postMessage(output);
}

function clearNativeCooldownState() {
  nativeCooldownUntil = 0;
  nativeFlatFrameCount = 0;
  clearNativeCooldownTimer();
  clearCoastingTimer();
}

function postCoastedFrame(reason, displayId, cols, rows, status = {}) {
  const now = Date.now();
  const coaster = coasterFor(displayId);
  const frame = coaster.coastFrame(cols, rows, now);
  const coastStatus = coaster.status(now);
  const { reason: _ignoredReason, ...statusWithoutReason } = status;
  const displayActive = status.displayActive !== false;

  postNativeStatus(reason, {
    ...statusWithoutReason,
    displayActive,
    captureDegraded: displayActive,
    coastingActive: displayActive && Boolean(frame),
    noCoastingHistory: displayActive && !frame,
    outputSuppressed: displayActive && !frame,
    coastingAgeMs: coastStatus.ageMs,
    coastRemainingMs: coastStatus.coastRemainingMs,
    nativeCooldownMs: nativeCooldownMs(now),
  });

  if (!displayActive || !frame) {
    logNativeSampler(`coasting skipped displayActive=${displayActive} hasHistory=${Boolean(frame)} reason=${reason}`);
    return false;
  }

  postOutputFrame(displayId, frame);
  return true;
}

function postFrameForDisplay(displayId, frame, cols, rows, status = {}) {
  const bytes = normalizeFrameBytes(frame, cols, rows);
  if (!bytes) {
    return false;
  }

  const reason = status.reason || "";
  if (status.displayActive === false) {
    nativeFlatFrameCount = 0;
    postNativeStatus(reason, {
      ...status,
      displayActive: false,
      captureDegraded: false,
      coastingActive: false,
      nativeCooldownMs: 0,
    });
    postOutputFrame(displayId, bytes);
    return true;
  }

  if (shouldCoastCaptureFrame(bytes, reason, status.displayActive)) {
    return postCoastedFrame(reason, displayId, cols, rows, status);
  }

  clearNativeCooldownState();
  if (!isFlatBlackFrame(bytes)) {
    coasterFor(displayId).recordFrame(bytes, cols, rows, Date.now());
  }
  postNativeStatus(reason, {
    ...status,
    displayActive: true,
    captureDegraded: false,
    coastingActive: false,
    nativeCooldownMs: 0,
  });
  postOutputFrame(displayId, bytes);
  return true;
}

function scheduleCoasting(reason, displayId, cols, rows) {
  if (exiting || coastingTimer) {
    return;
  }

  const tick = () => {
    coastingTimer = null;
    if (exiting || nativeCooldownMs() <= 0) {
      return;
    }

    postCoastedFrame(reason, displayId, cols, rows, {
      mode: "native-border",
      backend: "dxgi-desktop-duplication",
    });
    scheduleCoasting(reason, displayId, cols, rows);
  };

  coastingTimer = setTimeout(tick, COAST_TICK_MS);
}

function scheduleNativeCooldownProbe(delay, reason = "") {
  clearNativeCooldownTimer();
  nativeCooldownTimer = setTimeout(() => {
    nativeCooldownTimer = null;
    if (exiting) {
      return;
    }
    nativeCooldownUntil = 0;
    logNativeSampler(`native cooldown elapsed; probing native sampler once reason=${reason}`);
    startNativeBorderSampler();
  }, Math.max(0, delay));
}

function enterNativeCooldown(reason, child, cooldownMs = NATIVE_RECOVERY_COOLDOWN_MS, extraStatus = {}) {
  const display = displays[0];
  const safeCooldownMs = Math.max(1000, Math.round(Number(cooldownMs) || NATIVE_RECOVERY_COOLDOWN_MS));
  if (!display) {
    postNativeStatus(reason, {
      displayActive: true,
      captureDegraded: true,
      coastingActive: false,
      nativeCooldownMs: safeCooldownMs,
      nativeRecoveryCooldownMs: safeCooldownMs,
      ...extraStatus,
    });
    return;
  }

  clearNativeRestartTimer();
  nativeCooldownUntil = Date.now() + safeCooldownMs;
  nativeRestartAttempts = 0;
  nativeFlatFrameCount = 0;

  if (nativeProcess === child) {
    nativeProcess = null;
  }
  if (child) {
    try {
      child.kill();
    } catch {
      // Process may have already exited.
    }
  } else {
    killNativeProcess();
  }

  const grid = gridForDisplay(display);
  logNativeSampler(`native cooldown ${safeCooldownMs}ms reason=${reason}`);
  const postedCoastingFrame = postCoastedFrame(reason, display.displayId, grid.cols, grid.rows, {
    mode: "native-border",
    backend: "dxgi-desktop-duplication",
    nativeRecoveryCooldownMs: safeCooldownMs,
    ...extraStatus,
  });
  if (postedCoastingFrame) {
    scheduleCoasting(reason, display.displayId, grid.cols, grid.rows);
  } else {
    logNativeSampler(`native cooldown has no coasting history; suppressing output reason=${reason}`);
  }
  scheduleNativeCooldownProbe(safeCooldownMs, reason);
}

function isDisplayOffReason(reason) {
  return /display target|display path|display source|selected output/i.test(String(reason || ""));
}

function postBlackFrame(reason, extra = {}) {
  const display = displays[0];
  if (!display) {
    postNativeStatus(reason, {
      displayActive: false,
      captureDegraded: false,
      coastingActive: false,
      nativeCooldownMs: nativeCooldownMs(),
      ...extra,
    });
    return;
  }

  const cols = Math.max(1, Math.ceil(display.width / samplingRate));
  const rows = Math.max(1, Math.ceil(display.height / samplingRate));
  const output = {};
  output[display.displayId || "DISPLAY1"] = new Uint8Array(cols * rows * 3);

  postNativeStatus(reason, {
    displayActive: false,
    captureDegraded: false,
    coastingActive: false,
    nativeCooldownMs: nativeCooldownMs(),
    ...extra,
  });
  parentPort.postMessage(output);
}

function startSequentialEdgeCapture(reason) {
  if (sequentialStarted || exiting) {
    return;
  }

  sequentialStarted = true;
  stopNativeSampler();
  parentPort.postMessage({
    type: "native-border-status",
    mode: "sequential-edge",
    backend: "quiklight-region-fallback",
    reason: reason || "",
    displayActive: true,
    captureDegraded: false,
    coastingActive: false,
    nativeCooldownMs: nativeCooldownMs(),
  });
  buildRegions();
  schedule(0);
}

function scheduleNativeSamplerRestart(reason, nativeStartedAt) {
  if (exiting) {
    return true;
  }

  if (Date.now() - nativeStartedAt > 10000) {
    nativeRestartAttempts = 0;
  }
  nativeRestartAttempts += 1;

  const delay = Math.min(5000, 500 * (2 ** Math.min(nativeRestartAttempts - 1, 4)));
  logNativeSampler(`restart attempt=${nativeRestartAttempts} delayMs=${delay} reason=${reason}`);
  postNativeStatus(`restarting native sampler: ${reason}`, {
    nativeRestartAttempt: nativeRestartAttempts,
    nativeRetryDelayMs: delay,
    displayActive: true,
    captureDegraded: true,
    coastingActive: false,
    nativeCooldownMs: nativeCooldownMs(),
  });

  nativeRestartTimer = setTimeout(() => {
    nativeRestartTimer = null;
    if (!exiting) {
      startNativeBorderSampler();
    }
  }, delay);
  return true;
}

function startNativeBorderSampler() {
  if (nativeProcess) {
    return true;
  }

  const cooldownMs = nativeCooldownMs();
  if (cooldownMs > 0) {
    scheduleNativeCooldownProbe(cooldownMs, "cooldown still active");
    return true;
  }

  if (process.env.DX_LIGHT_NATIVE_BORDER === "0" || displays.length < 1) {
    const reason = process.env.DX_LIGHT_NATIVE_BORDER === "0"
      ? "native sampler disabled by DX_LIGHT_NATIVE_BORDER=0"
      : `waiting for active display count=${displays.length}`;
    logNativeSampler(reason);
    postBlackFrame(reason);
    startSequentialEdgeCapture(reason);
    return true;
  }

  const executable = findNativeSampler();
  if (!executable) {
    const reason = `native sampler not found candidates=${nativeSamplerCandidates().join("|")}`;
    logNativeSampler(reason);
    postBlackFrame(reason);
    startSequentialEdgeCapture(reason);
    return true;
  }

  const display = displays[0];
  const protectedMedia = detectProtectedMediaOnDisplay(display);
  if (protectedMedia.protectedLikely) {
    const reason = protectedMedia.reason || "protected media preflight blocked native sampler";
    logNativeSampler(`protected media preflight blocked native sampler reason=${reason} matches=${protectedMedia.matches.length}`);
    enterNativeCooldown(reason, null, PROTECTED_MEDIA_PREFLIGHT_HOLD_MS, {
      protectedMediaPreflight: true,
      protectedContentCooldown: true,
      protectedContentCooldownMs: PROTECTED_MEDIA_PREFLIGHT_HOLD_MS,
      protectedMediaMatches: protectedMedia.matches.length,
    });
    return true;
  }

  const edgeThicknessPx = Math.max(1, Number(process.env.DX_LIGHT_NATIVE_EDGE_THICKNESS_PX || samplingRate * 3));
  const averageRadiusPx = Math.max(0, Number(process.env.DX_LIGHT_NATIVE_AVERAGE_RADIUS_PX || 12));
  const smoothingAlphaPercent = Math.max(1, Math.min(100, Number(process.env.DX_LIGHT_NATIVE_SMOOTHING_ALPHA_PERCENT || 35)));
  const deadband = Math.max(0, Number(process.env.DX_LIGHT_NATIVE_DEADBAND || 10));
  const args = [
    "--displayId", display.displayId || "DISPLAY1",
    "--x", String(Math.round(display.x || 0)),
    "--y", String(Math.round(display.y || 0)),
    "--width", String(Math.max(1, Math.round(display.width || 1))),
    "--height", String(Math.max(1, Math.round(display.height || 1))),
    "--samplingRate", String(Math.max(20, Math.round(samplingRate))),
    "--edgeThicknessPx", String(edgeThicknessPx),
    "--averageRadiusPx", String(averageRadiusPx),
    "--smoothingAlphaPercent", String(smoothingAlphaPercent),
    "--deadband", String(deadband),
    "--edgeNumber", String(Number(edgeNumber) === 4 ? 4 : 3),
    "--intervalMs", String(Math.max(8, Math.round(finalSyncSpeed))),
  ];

  let stdout = "";
  let stderr = "";
  let sawFrame = false;
  let restartScheduled = false;
  const nativeStartedAt = Date.now();
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  nativeProcess = child;
  logNativeSampler(`spawn ${executable} ${args.join(" ")}`);
  postNativeStatus("starting native sampler");

  const requestRestart = (reason, killProcess) => {
    if (restartScheduled || exiting) {
      return;
    }
    restartScheduled = true;
    clearTimeout(readyTimer);
    if (nativeProcess === child) {
      nativeProcess = null;
    }
    if (killProcess) {
      try {
        child.kill();
      } catch {
        // Process may have already exited.
      }
    }
    if (isDisplayOffReason(reason)) {
      postBlackFrame(reason);
      logNativeSampler(`holding black frame until sync restarts reason=${reason}`);
      return;
    }
    const recoveryDecision = nativeRecoveryPolicy.classifyFailure(reason);
    if (recoveryDecision.action === "cooldown") {
      logNativeSampler(`native recovery cooldown decision=${recoveryDecision.cooldownMs}ms reason=${recoveryDecision.reason}`);
      enterNativeCooldown(recoveryDecision.reason, child, recoveryDecision.cooldownMs, {
        protectedContentCooldown: recoveryDecision.protectedContent,
        protectedContentCooldownMs: recoveryDecision.protectedContent ? recoveryDecision.cooldownMs : 0,
        sessionLossCount: recoveryDecision.sessionLossCount,
      });
      return;
    }
    if (recoveryDecision.action === "restart" || isDuplicationSessionLossReason(reason)) {
      logNativeSampler(`recreating native sampler after duplication session loss reason=${reason}`);
      scheduleNativeSamplerRestart(reason, nativeStartedAt);
      return;
    }
    postBlackFrame(reason);
    if (!sawFrame) {
      startSequentialEdgeCapture(reason);
      return;
    }
    scheduleNativeSamplerRestart(reason, nativeStartedAt);
  };

  const readyTimer = setTimeout(() => {
    if (!sawFrame && !exiting) {
      const reason = stderr.trim()
        ? `native sampler did not produce a frame: ${stderr.trim()}`
        : "native sampler did not produce a frame";
      logNativeSampler(`native ready timeout reason=${reason}`);
      requestRestart(reason, true);
    }
  }, Math.max(1500, finalSyncSpeed * 10));

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        handleNativeLine(line);
      }
      newline = stdout.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    logNativeSampler(`stderr ${chunk.toString("utf8").trim()}`);
  });

  child.on("error", (error) => {
    requestRestart(error && error.message ? error.message : String(error), false);
  });

  child.on("exit", (code) => {
    clearTimeout(readyTimer);
    if (nativeProcess === child) {
      nativeProcess = null;
    }
    const reason = stderr.trim() || `native sampler exited with code ${code}`;
    logNativeSampler(`exit code=${code} sawFrame=${sawFrame} stderr=${stderr.trim()}`);
    if (!exiting) {
      requestRestart(reason, false);
    }
  });

  function handleNativeLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.type === "ready") {
      logNativeSampler(`ready backend=${message.backend || ""} physical=${message.physicalWidth || 0}x${message.physicalHeight || 0}`);
      parentPort.postMessage({
        type: "native-border-status",
        mode: "native-border",
        backend: message.backend || "dxgi-desktop-duplication",
        reason: "",
        averageRadiusPx: message.averageRadiusPx || averageRadiusPx,
        smoothingAlphaPercent: message.smoothingAlphaPercent || smoothingAlphaPercent,
        deadband: message.deadband || deadband,
        displayActive: true,
        captureDegraded: false,
        coastingActive: false,
        nativeCooldownMs: nativeCooldownMs(),
      });
      return;
    }

    if (message.type !== "frame" || !message.colors) {
      return;
    }

    sawFrame = true;
    nativeRestartAttempts = 0;
    if (!startNativeBorderSampler.loggedFirstFrame) {
      startNativeBorderSampler.loggedFirstFrame = true;
      logNativeSampler(`first-frame backend=${message.backend || ""} elapsedMs=${message.elapsedMs || 0}`);
    }
    const cols = Math.max(1, Math.round(message.cols || Math.ceil(display.width / samplingRate)));
    const rows = Math.max(1, Math.round(message.rows || Math.ceil(display.height / samplingRate)));
    const frame = new Uint8Array(Buffer.from(message.colors, "base64"));
    const reason = message.displayStatusReason ||
      (message.protectedContentMaskedOut ? "DXGI protected content masked out" : "");
    const status = {
      mode: "native-border",
      backend: message.backend || "dxgi-desktop-duplication",
      elapsedMs: message.elapsedMs || 0,
      physicalWidth: message.physicalWidth || 0,
      physicalHeight: message.physicalHeight || 0,
      format: message.format || 0,
      averageRadiusPx: message.averageRadiusPx || averageRadiusPx,
      smoothingAlphaPercent: message.smoothingAlphaPercent || smoothingAlphaPercent,
      deadband: message.deadband || deadband,
      contentBoundsActive: Boolean(message.contentBoundsActive),
      contentLeft: message.contentLeft || 0,
      contentRight: message.contentRight || 0,
      protectedContentMaskedOut: Boolean(message.protectedContentMaskedOut),
      displayActive: message.displayActive !== false,
      reason,
    };

    if (shouldCoastCaptureFrame(frame, reason, status.displayActive)) {
      nativeFlatFrameCount += 1;
      const flatReason = reason;
      logNativeSampler(`flat native frame count=${nativeFlatFrameCount} reason=${flatReason}`);
      if (nativeFlatFrameCount >= 2) {
        restartScheduled = true;
        clearTimeout(readyTimer);
        enterNativeCooldown(flatReason, child, NATIVE_PROTECTED_CONTENT_COOLDOWN_MS, {
          protectedContentCooldown: true,
          protectedContentCooldownMs: NATIVE_PROTECTED_CONTENT_COOLDOWN_MS,
        });
        return;
      }
      postCoastedFrame(flatReason, message.displayId || display.displayId, cols, rows, status);
      return;
    }

    nativeFlatFrameCount = 0;
    postFrameForDisplay(message.displayId || display.displayId, frame, cols, rows, status);
  }

  return true;
}

function captureNext() {
  if (exiting) {
    return;
  }
  if (!regions.length) {
    schedule(100);
    return;
  }

  const region = regions[regionIndex++ % regions.length];
  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    stopNative();
    schedule(0);
  };

  try {
    startCaptureMultiScreens((frameMap) => {
      if (finished || exiting) {
        return;
      }
      finished = true;
      stopNative();
      applyRegion(region, frameMap);
      schedule(0);
    }, [region.display], finalSyncSpeed, samplingRate);
  } catch (error) {
    parentPort.postMessage({ type: "error", error: error && error.stack ? error.stack : String(error) });
    finish();
  }

  setTimeout(finish, Math.max(500, 4 * finalSyncSpeed));
}

try {
  if (edgeCapture) {
    startNativeBorderSampler();
  } else {
    startCaptureMultiScreens((frameMap) => {
      for (const display of displays) {
        const grid = gridForDisplay(display);
        const frame = frameMap && frameMap[display.displayId];
        postFrameForDisplay(display.displayId, frame, grid.cols, grid.rows, {
          mode: "full-frame",
          backend: "quiklight-full-frame",
          reason: "",
        });
      }
    }, displays, finalSyncSpeed, samplingRate);
  }
} catch (error) {
  throw new Error(error);
}

parentPort.on("message", (message) => {
  if (message === "exit") {
    exiting = true;
    if (timer) {
      clearTimeout(timer);
    }
    stopNativeSampler();
    stopNative();
    parentPort.close();
  }
});
