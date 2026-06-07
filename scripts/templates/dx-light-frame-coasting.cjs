const DEFAULT_HISTORY_MS = 2000;
const DEFAULT_COAST_MS = 8000;
const DEFAULT_MIN_BRIGHTNESS_SCALE = 0.22;
const DEFAULT_IDLE_DRIFT_MS_PER_CELL = 3200;
const DEFAULT_ACTIVE_DRIFT_MS_PER_CELL = 700;
const FLAT_BRIGHTNESS_THRESHOLD = 8;
const FLAT_SPREAD_THRESHOLD = 6;

function createFrameCoaster(options = {}) {
  const historyMs = positiveNumber(options.historyMs, DEFAULT_HISTORY_MS);
  const coastMs = positiveNumber(options.coastMs, DEFAULT_COAST_MS);
  const minBrightnessScale = clampNumber(
    Number(options.minBrightnessScale ?? DEFAULT_MIN_BRIGHTNESS_SCALE),
    0,
    1,
    DEFAULT_MIN_BRIGHTNESS_SCALE,
  );
  const activeDriftMsPerCell = positiveNumber(options.activeDriftMsPerCell, DEFAULT_ACTIVE_DRIFT_MS_PER_CELL);
  const idleDriftMsPerCell = positiveNumber(options.idleDriftMsPerCell, DEFAULT_IDLE_DRIFT_MS_PER_CELL);
  const history = [];

  function recordFrame(frame, cols, rows, nowMs = Date.now()) {
    const normalized = normalizeFrame(frame, cols, rows);
    if (!normalized || isFlatBlackFrame(normalized)) {
      return false;
    }

    const safeNow = normalizeTime(nowMs);
    history.push({
      frame: normalized.slice(0),
      cols: Math.max(1, Math.round(cols)),
      rows: Math.max(1, Math.round(rows)),
      nowMs: safeNow,
    });
    pruneHistory(safeNow, true);
    return true;
  }

  function coastFrame(cols, rows, nowMs = Date.now()) {
    const safeCols = Math.max(1, Math.round(cols));
    const safeRows = Math.max(1, Math.round(rows));
    const safeNow = normalizeTime(nowMs);
    pruneHistory(safeNow, true);

    const sameShape = history.filter((entry) => entry.cols === safeCols && entry.rows === safeRows);
    if (sameShape.length === 0) {
      return null;
    }

    const last = sameShape[sameShape.length - 1];
    const previous = sameShape.length > 1 ? sameShape[sameShape.length - 2] : null;
    const ageMs = Math.max(0, safeNow - last.nowMs);
    const decay = ageMs <= coastMs ? 1 - smoothStep(ageMs / coastMs) : 0;
    const brightnessScale = ageMs <= coastMs
      ? minBrightnessScale + (1 - minBrightnessScale) * decay
      : minBrightnessScale;
    const driftMsPerCell = ageMs <= coastMs ? activeDriftMsPerCell : idleDriftMsPerCell;
    const driftCells = ageMs / driftMsPerCell;
    const velocityScale = previous
      ? Math.min(0.45, Math.max(0, ageMs / Math.max(16, last.nowMs - previous.nowMs)) * 0.12) * decay
      : 0;

    return synthesizeCoastingFrame(last.frame, previous?.frame ?? null, safeCols, safeRows, driftCells, brightnessScale, velocityScale);
  }

  function status(nowMs = Date.now()) {
    if (history.length === 0) {
      return {
        hasHistory: false,
        ageMs: null,
        coastRemainingMs: 0,
      };
    }

    const safeNow = normalizeTime(nowMs);
    const last = history[history.length - 1];
    const ageMs = Math.max(0, safeNow - last.nowMs);
    return {
      hasHistory: true,
      ageMs,
      coastRemainingMs: Math.max(0, coastMs - ageMs),
    };
  }

  function reset() {
    history.length = 0;
  }

  function pruneHistory(nowMs, keepLast = false) {
    const cutoff = nowMs - historyMs;
    const minimumLength = keepLast ? 1 : 0;
    while (history.length > minimumLength && history[0].nowMs < cutoff) {
      history.shift();
    }
  }

  return {
    recordFrame,
    coastFrame,
    reset,
    status,
  };
}

function synthesizeCoastingFrame(lastFrame, previousFrame, cols, rows, driftCells, brightnessScale, velocityScale) {
  const pixelCount = Math.max(1, cols * rows);
  const output = new Uint8Array(lastFrame.length);
  const wrappedDrift = positiveModulo(driftCells, pixelCount);
  const driftWhole = Math.floor(wrappedDrift);
  const driftFraction = wrappedDrift - driftWhole;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const sourceA = positiveModulo(pixel - driftWhole, pixelCount);
    const sourceB = positiveModulo(sourceA - 1, pixelCount);

    for (let channel = 0; channel < 3; channel += 1) {
      const targetOffset = pixel * 3 + channel;
      const offsetA = sourceA * 3 + channel;
      const offsetB = sourceB * 3 + channel;
      const drifted = lerp(lastFrame[offsetA] || 0, lastFrame[offsetB] || 0, driftFraction);
      const velocity = previousFrame ? (lastFrame[targetOffset] || 0) - (previousFrame[targetOffset] || 0) : 0;
      output[targetOffset] = clampByte((drifted + velocity * velocityScale) * brightnessScale);
    }
  }

  return output;
}

function isFlatBlackFrame(frame) {
  const bytes = toUint8Array(frame);
  if (!bytes || bytes.length === 0) {
    return true;
  }

  let maxChannel = 0;
  let minChannel = 255;
  let total = 0;
  let count = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = Number(bytes[index] || 0);
    maxChannel = Math.max(maxChannel, value);
    minChannel = Math.min(minChannel, value);
    total += value;
    count += 1;
  }

  const average = count > 0 ? total / count : 0;
  return average <= FLAT_BRIGHTNESS_THRESHOLD &&
    maxChannel <= FLAT_BRIGHTNESS_THRESHOLD &&
    maxChannel - minChannel <= FLAT_SPREAD_THRESHOLD;
}

function isProtectedCaptureReason(reason) {
  return /DXGI_ERROR_ACCESS_LOST|E_ACCESSDENIED|DXGI_ERROR_INVALID_CALL|DuplicateOutput failed|AcquireNextFrame failed/i.test(String(reason || ""));
}

function shouldCoastCaptureFrame(frame, reason, displayActive = true) {
  return displayActive !== false &&
    isFlatBlackFrame(frame) &&
    isProtectedCaptureReason(reason);
}

function normalizeFrame(frame, cols, rows) {
  const bytes = toUint8Array(frame);
  const expectedLength = Math.max(1, Math.round(cols)) * Math.max(1, Math.round(rows)) * 3;
  if (!bytes || bytes.length < expectedLength) {
    return null;
  }
  return bytes.length === expectedLength ? bytes : bytes.slice(0, expectedLength);
}

function toUint8Array(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function smoothStep(value) {
  const clamped = clampNumber(value, 0, 1, 0);
  return clamped * clamped * (3 - 2 * clamped);
}

function positiveModulo(value, divisor) {
  const safeDivisor = Math.max(1, Math.round(divisor));
  return ((value % safeDivisor) + safeDivisor) % safeDivisor;
}

function lerp(left, right, amount) {
  return left + (right - left) * amount;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeTime(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function clampByte(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

module.exports = {
  createFrameCoaster,
  isFlatBlackFrame,
  isProtectedCaptureReason,
  shouldCoastCaptureFrame,
};
