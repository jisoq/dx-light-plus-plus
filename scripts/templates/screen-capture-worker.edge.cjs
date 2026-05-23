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
let timer = null;
let regionIndex = 0;
let nativeProcess = null;
let sequentialStarted = false;

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
  if (nativeProcess) {
    try {
      nativeProcess.kill();
    } catch {
      // Process shutdown can race with worker shutdown.
    }
    nativeProcess = null;
  }
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
    const output = {};
    output[state.display.displayId] = state.buffer.slice(0);
    parentPort.postMessage(output);
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

function startSequentialEdgeCapture(reason) {
  if (sequentialStarted || exiting) {
    return;
  }
  sequentialStarted = true;
  parentPort.postMessage({
    type: "native-border-status",
    mode: "sequential-edge",
    backend: "quiklight-region-fallback",
    reason: reason || "",
  });
  buildRegions();
  schedule(0);
}

function startNativeBorderSampler() {
  if (process.env.DX_LIGHT_NATIVE_BORDER === "0" || displays.length < 1) {
    logNativeSampler(`native disabled or no displays count=${displays.length}`);
    return false;
  }

  const executable = findNativeSampler();
  if (!executable) {
    logNativeSampler(`native sampler not found candidates=${nativeSamplerCandidates().join("|")}`);
    return false;
  }

  const display = displays[0];
  const edgeThicknessPx = Math.max(1, Number(process.env.DX_LIGHT_NATIVE_EDGE_THICKNESS_PX || samplingRate * 3));
  const args = [
    "--displayId", display.displayId || "DISPLAY1",
    "--x", String(Math.round(display.x || 0)),
    "--y", String(Math.round(display.y || 0)),
    "--width", String(Math.max(1, Math.round(display.width || 1))),
    "--height", String(Math.max(1, Math.round(display.height || 1))),
    "--samplingRate", String(Math.max(20, Math.round(samplingRate))),
    "--edgeThicknessPx", String(edgeThicknessPx),
    "--edgeNumber", String(Number(edgeNumber) === 4 ? 4 : 3),
    "--intervalMs", String(Math.max(8, Math.round(finalSyncSpeed))),
  ];

  let stdout = "";
  let stderr = "";
  let sawFrame = false;
  nativeProcess = spawn(executable, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  logNativeSampler(`spawn ${executable} ${args.join(" ")}`);

  const fallbackTimer = setTimeout(() => {
    if (!sawFrame && !exiting) {
      const reason = stderr.trim() || "native sampler did not produce a frame";
      logNativeSampler(`fallback timeout reason=${reason}`);
      stopNativeSampler();
      startSequentialEdgeCapture(reason);
    }
  }, Math.max(1500, finalSyncSpeed * 10));

  nativeProcess.stdout.on("data", (chunk) => {
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

  nativeProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    logNativeSampler(`stderr ${chunk.toString("utf8").trim()}`);
  });

  nativeProcess.on("exit", (code) => {
    clearTimeout(fallbackTimer);
    nativeProcess = null;
    logNativeSampler(`exit code=${code} sawFrame=${sawFrame} stderr=${stderr.trim()}`);
    if (!exiting) {
      startSequentialEdgeCapture(stderr.trim() || `native sampler exited with code ${code}`);
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
      });
      return;
    }

    if (message.type !== "frame" || !message.colors) {
      return;
    }

    sawFrame = true;
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
    if (!startNativeBorderSampler()) {
      startSequentialEdgeCapture("native sampler unavailable");
    }
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
    if (timer) {
      clearTimeout(timer);
    }
    stopNativeSampler();
    stopNative();
    parentPort.close();
  }
});
