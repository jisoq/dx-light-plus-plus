const { parentPort, workerData } = require("worker_threads");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  startCaptureMultiScreens,
  stopCaptureMultiScreens,
} = require("@warren-robobloq/quiklight");

const {
  displays = [],
  finalSyncSpeed = 80,
  samplingRate = 80,
  edgeCapture = false,
  edgeNumber = 3,
} = workerData;

let exiting = false;
let nativeProcess = null;
let nativeRestartTimer = null;
let nativeRestartAttempts = 0;

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

const stopNativeSampler = () => {
  if (nativeRestartTimer) {
    clearTimeout(nativeRestartTimer);
    nativeRestartTimer = null;
  }
  if (nativeProcess) {
    try {
      nativeProcess.kill();
    } catch {
      // Process shutdown can race with worker shutdown.
    }
    nativeProcess = null;
  }
};

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
    ...extra,
  });
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

  if (process.env.DX_LIGHT_NATIVE_BORDER === "0" || displays.length < 1) {
    const reason = process.env.DX_LIGHT_NATIVE_BORDER === "0"
      ? "native sampler disabled by DX_LIGHT_NATIVE_BORDER=0"
      : `waiting for active display count=${displays.length}`;
    logNativeSampler(reason);
    postNativeStatus(reason);
    return true;
  }

  const executable = findNativeSampler();
  if (!executable) {
    const reason = `native sampler not found candidates=${nativeSamplerCandidates().join("|")}`;
    logNativeSampler(reason);
    scheduleNativeSamplerRestart(reason, Date.now());
    return true;
  }

  const display = displays[0];
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
    scheduleNativeSamplerRestart(reason, nativeStartedAt);
  };

  const readyTimer = setTimeout(() => {
    if (!sawFrame && !exiting) {
      const reason = stderr.trim() || "native sampler did not produce a frame";
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
    parentPort.postMessage({
      type: "native-border-status",
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
      reason: "",
    });

    const output = {};
    output[message.displayId || display.displayId] = new Uint8Array(Buffer.from(message.colors, "base64"));
    parentPort.postMessage(output);
  }

  return true;
}

try {
  if (edgeCapture) {
    startNativeBorderSampler();
  } else {
    startCaptureMultiScreens((frameMap) => {
      parentPort.postMessage(frameMap);
    }, displays, finalSyncSpeed, samplingRate);
  }
} catch (error) {
  throw new Error(error);
}

parentPort.on("message", (message) => {
  if (message === "exit") {
    exiting = true;
    stopNativeSampler();
    stopNative();
    parentPort.close();
  }
});
