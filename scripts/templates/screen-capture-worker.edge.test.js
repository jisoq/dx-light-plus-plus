import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./screen-capture-worker.edge.cjs", import.meta.url), "utf8");

describe("screen capture worker protected media preflight", () => {
  it("uses a short preflight recheck instead of the long protected-content cooldown", () => {
    expect(source).toContain("DX_LIGHT_PROTECTED_MEDIA_PREFLIGHT_RECHECK_MS");
    expect(source).toContain("protectedMediaRecheckMs: PROTECTED_MEDIA_PREFLIGHT_RECHECK_MS");
    expect(source).toContain("protectedContentCooldown: false");
    expect(source).not.toContain("PROTECTED_MEDIA_PREFLIGHT_HOLD_MS");
  });
});
