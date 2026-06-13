import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createNativeRecoveryPolicy,
} = require("./dx-light-native-recovery.cjs");

describe("dx light native recovery policy", () => {
  it("sends protected capture failures directly to a long cooldown", () => {
    const policy = createPolicy();

    expect(policy.classifyFailure("DuplicateOutput failed: E_ACCESSDENIED", 0)).toMatchObject({
      action: "cooldown",
      cooldownMs: 600000,
      protectedContent: true,
      sessionLossCount: 0,
    });
  });

  it("restarts isolated duplication session losses", () => {
    const policy = createPolicy();

    expect(policy.classifyFailure("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST", 0)).toMatchObject({
      action: "restart",
      cooldownMs: 0,
      sessionLossCount: 1,
    });
    expect(policy.classifyFailure("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST", 20000)).toMatchObject({
      action: "restart",
      cooldownMs: 0,
      sessionLossCount: 2,
    });
  });

  it("cools down repeated duplication session losses inside the window", () => {
    const policy = createPolicy();

    policy.classifyFailure("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST", 0);
    policy.classifyFailure("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST", 20000);

    expect(policy.classifyFailure("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST", 40000)).toMatchObject({
      action: "cooldown",
      cooldownMs: 120000,
      protectedContent: false,
      sessionLossCount: 3,
    });
  });

  it("does not count old duplication losses outside the window", () => {
    const policy = createPolicy();

    policy.classifyFailure("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST", 0);

    expect(policy.classifyFailure("AcquireNextFrame failed: DXGI_ERROR_ACCESS_LOST", 61000)).toMatchObject({
      action: "restart",
      sessionLossCount: 1,
    });
  });
});

function createPolicy() {
  return createNativeRecoveryPolicy({
    isDuplicationSessionLossReason: (reason) => /DXGI_ERROR_ACCESS_LOST/.test(reason),
    isProtectedCaptureReason: (reason) => /E_ACCESSDENIED/.test(reason),
    recoveryCooldownMs: 30000,
    protectedContentCooldownMs: 600000,
    unstableSessionCooldownMs: 120000,
    sessionLossWindowMs: 60000,
    sessionLossThreshold: 3,
  });
}
