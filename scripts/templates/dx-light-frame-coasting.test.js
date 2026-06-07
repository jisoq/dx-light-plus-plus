import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createFrameCoaster,
  isDuplicationSessionLossReason,
  isFlatBlackFrame,
  isProtectedCaptureReason,
  shouldCoastCaptureFrame,
} = require("./dx-light-frame-coasting.cjs");

describe("dx light frame coasting", () => {
  it("records normal frames and refuses flat black frames", () => {
    const coaster = createFrameCoaster();

    expect(coaster.recordFrame(bytes([0, 0, 0, 1, 1, 1]), 2, 1, 0)).toBe(false);
    expect(coaster.status(0).hasHistory).toBe(false);

    expect(coaster.recordFrame(bytes([12, 8, 20, 50, 40, 30]), 2, 1, 10)).toBe(true);
    expect(coaster.status(10)).toMatchObject({ hasHistory: true, ageMs: 0 });
  });

  it("coasts from observed history without changing frame shape", () => {
    const coaster = createFrameCoaster({ activeDriftMsPerCell: 1000 });
    coaster.recordFrame(bytes([20, 10, 5, 100, 80, 60, 40, 20, 10]), 3, 1, 0);
    coaster.recordFrame(bytes([24, 12, 7, 110, 82, 61, 48, 24, 12]), 3, 1, 100);

    const coasted = coaster.coastFrame(3, 1, 600);

    expect(coasted).toBeInstanceOf(Uint8Array);
    expect(coasted).toHaveLength(9);
    expect(Math.max(...coasted)).toBeLessThanOrEqual(255);
    expect(Math.min(...coasted)).toBeGreaterThanOrEqual(0);
    expect(Array.from(coasted)).not.toEqual([24, 12, 7, 110, 82, 61, 48, 24, 12]);
  });

  it("applies the configured eight second fade and keeps low drift afterward", () => {
    const coaster = createFrameCoaster({ coastMs: 8000, minBrightnessScale: 0.22 });
    coaster.recordFrame(bytes([120, 90, 60, 80, 50, 20]), 2, 1, 0);

    const mid = coaster.coastFrame(2, 1, 4000);
    const late = coaster.coastFrame(2, 1, 9000);

    expect(average(mid)).toBeGreaterThan(average(late));
    expect(average(late)).toBeGreaterThan(0);
    expect(coaster.status(9000).coastRemainingMs).toBe(0);
  });

  it("keeps the last observed frame available for the full coasting window", () => {
    const coaster = createFrameCoaster({ historyMs: 2000, coastMs: 8000 });
    coaster.recordFrame(bytes([120, 80, 40, 50, 70, 90]), 2, 1, 0);

    expect(coaster.coastFrame(2, 1, 3000)).toBeInstanceOf(Uint8Array);
    expect(coaster.coastFrame(2, 1, 7000)).toBeInstanceOf(Uint8Array);
  });

  it("returns null when no matching history exists", () => {
    const coaster = createFrameCoaster();

    expect(coaster.coastFrame(2, 1, 100)).toBeNull();
    coaster.recordFrame(bytes([20, 10, 5, 100, 80, 60]), 2, 1, 100);
    expect(coaster.coastFrame(3, 1, 200)).toBeNull();
  });

  it("separates protected capture denial from normal DXGI session loss", () => {
    expect(isProtectedCaptureReason("DuplicateOutput failed: E_ACCESSDENIED")).toBe(true);
    expect(isProtectedCaptureReason("DuplicateOutput failed: DXGI_ERROR_INVALID_CALL")).toBe(true);
    expect(isProtectedCaptureReason("DuplicateOutput failed: DXGI_ERROR_NOT_CURRENTLY_AVAILABLE")).toBe(true);
    expect(isProtectedCaptureReason("AcquireNextFrame failed: DXGI_ERROR_INVALID_CALL")).toBe(true);
    expect(isProtectedCaptureReason("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST")).toBe(false);
    expect(isProtectedCaptureReason("DuplicateOutput failed: DXGI_ERROR_ACCESS_LOST")).toBe(false);
    expect(isDuplicationSessionLossReason("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST")).toBe(true);
    expect(isDuplicationSessionLossReason("AcquireNextFrame failed: DXGI_ERROR_DEVICE_REMOVED")).toBe(true);
    expect(isDuplicationSessionLossReason("AcquireNextFrame failed: DXGI_ERROR_DEVICE_RESET")).toBe(true);
    expect(isDuplicationSessionLossReason("DuplicateOutput failed: E_ACCESSDENIED")).toBe(false);
    expect(isProtectedCaptureReason("native sampler not found candidates=a|b")).toBe(false);
    expect(isProtectedCaptureReason("native sampler disabled by DX_LIGHT_NATIVE_BORDER=0")).toBe(false);
  });

  it("detects flat black frames without treating varied dark frames as blocked", () => {
    expect(isFlatBlackFrame(bytes([0, 0, 0, 1, 1, 1, 2, 2, 2]))).toBe(true);
    expect(isFlatBlackFrame(bytes([3, 2, 1, 24, 8, 5, 4, 3, 16]))).toBe(false);
  });

  it("only coasts black frames in protected active-capture context", () => {
    const blackFrame = bytes([0, 0, 0, 1, 1, 1]);

    expect(shouldCoastCaptureFrame(blackFrame, "DuplicateOutput failed: E_ACCESSDENIED", true)).toBe(true);
    expect(shouldCoastCaptureFrame(blackFrame, "DuplicateOutput failed: DXGI_ERROR_INVALID_CALL", true)).toBe(true);
    expect(shouldCoastCaptureFrame(blackFrame, "AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST", true)).toBe(false);
    expect(shouldCoastCaptureFrame(blackFrame, "", true)).toBe(false);
    expect(shouldCoastCaptureFrame(blackFrame, "DuplicateOutput failed: E_ACCESSDENIED", false)).toBe(false);
  });
});

function bytes(values) {
  return Uint8Array.from(values);
}

function average(values) {
  return Array.from(values).reduce((total, value) => total + value, 0) / values.length;
}
