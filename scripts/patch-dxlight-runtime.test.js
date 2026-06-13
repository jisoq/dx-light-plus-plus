import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./patch-dxlight-runtime.cjs", import.meta.url), "utf8");

describe("dx light runtime patch verification markers", () => {
  it("tracks the protected-media preflight recheck marker", () => {
    expect(source).toContain("DX_LIGHT_PROTECTED_MEDIA_PREFLIGHT_RECHECK_MS");
    expect(source).not.toContain("DX_LIGHT_PROTECTED_MEDIA_PREFLIGHT_HOLD_MS");
  });
});
