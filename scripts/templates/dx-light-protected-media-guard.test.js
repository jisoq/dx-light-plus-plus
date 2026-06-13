import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  detectProtectedMediaOnDisplay,
  mergeWindows,
  parseProcessTitleWindows,
  parseWindows,
  protectedMediaMatchesDisplay,
  protectedMediaTitleMatches,
  windowOverlapsDisplay,
} = require("./dx-light-protected-media-guard.cjs");

const display = { x: 0, y: 0, width: 5120, height: 2160 };
const source = readFileSync(new URL("./dx-light-protected-media-guard.cjs", import.meta.url), "utf8");

describe("dx light protected media guard", () => {
  it("matches Netflix browser windows", () => {
    expect(protectedMediaTitleMatches({
      processName: "msedge",
      title: "Netflix - Microsoft Edge",
    })).toBe(true);
    expect(protectedMediaTitleMatches({
      processName: "msedge",
      title: "Documentation - Microsoft Edge",
    })).toBe(false);
  });

  it("requires overlap with the target display when coordinates are known", () => {
    expect(windowOverlapsDisplay({
      left: 100,
      top: 100,
      right: 1200,
      bottom: 900,
    }, display)).toBe(true);
    expect(windowOverlapsDisplay({
      left: 6000,
      top: 100,
      right: 7200,
      bottom: 900,
    }, display)).toBe(false);
  });

  it("blocks native capture before DXGI starts when Netflix is on the target display", () => {
    expect(protectedMediaMatchesDisplay({
      processName: "msedge",
      title: "Netflix - Microsoft Edge",
      left: 0,
      top: 0,
      right: 5120,
      bottom: 2160,
    }, display)).toBe(true);
  });

  it("does not block when Netflix is only on another display", () => {
    const result = detectProtectedMediaOnDisplay(display, {
      windows: [{
        processName: "msedge",
        title: "Netflix - Microsoft Edge",
        left: 5200,
        top: 0,
        right: 7000,
        bottom: 1200,
      }],
    });

    expect(result.protectedLikely).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("parses PowerShell window JSON output", () => {
    const windows = parseWindows(JSON.stringify({
      processName: "msedge",
      pid: 123,
      title: "Netflix - Microsoft Edge",
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
    }));

    expect(windows).toEqual([{
      processName: "msedge",
      pid: 123,
      title: "Netflix - Microsoft Edge",
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
    }]);
  });

  it("does not treat process-title fallback output as a display-specific match", () => {
    const windows = parseProcessTitleWindows(JSON.stringify({
      ProcessName: "msedge",
      Id: 123,
      MainWindowTitle: "넷플릭스 - 개인 - Microsoft Edge",
    }));

    expect(windows).toEqual([{
      processName: "msedge",
      pid: 123,
      title: "넷플릭스 - 개인 - Microsoft Edge",
    }]);
    expect(protectedMediaMatchesDisplay(windows[0], display)).toBe(false);
  });

  it("merges coordinate and process-title window sources", () => {
    expect(mergeWindows([
      { processName: "Code", pid: 1, title: "editor", left: 0, top: 0, right: 100, bottom: 100 },
    ], [
      { processName: "msedge", pid: 2, title: "넷플릭스 - 개인 - Microsoft Edge" },
    ])).toHaveLength(2);
  });

  it("keeps bounded window data instead of adding a duplicate unbounded fallback", () => {
    const merged = mergeWindows([
      {
        processName: "msedge",
        pid: 2,
        title: "Netflix - Microsoft Edge",
        left: 5200,
        top: 0,
        right: 7000,
        bottom: 1200,
      },
    ], [
      { processName: "msedge", pid: 2, title: "Netflix - Microsoft Edge" },
    ]);

    expect(merged).toEqual([{
      processName: "msedge",
      pid: 2,
      title: "Netflix - Microsoft Edge",
      left: 5200,
      top: 0,
      right: 7000,
      bottom: 1200,
    }]);
    expect(merged.filter((window) => protectedMediaMatchesDisplay(window, display))).toEqual([]);
  });

  it("uses Win32 monitor bounds when display coordinates are DPI-virtualized", () => {
    expect(protectedMediaMatchesDisplay({
      processName: "msedge",
      title: "Netflix - Microsoft Edge",
      left: 4200,
      top: 100,
      right: 5000,
      bottom: 800,
      monitorDevice: "\\\\.\\DISPLAY1",
      monitorLeft: 0,
      monitorTop: 0,
      monitorRight: 5120,
      monitorBottom: 2160,
    }, {
      displayId: "DISPLAY1",
      x: 0,
      y: 0,
      width: 3413,
      height: 1440,
    })).toBe(true);
  });

  it("rejects windows attributed to another Win32 monitor", () => {
    expect(protectedMediaMatchesDisplay({
      processName: "msedge",
      title: "Netflix - Microsoft Edge",
      left: 100,
      top: 100,
      right: 1200,
      bottom: 900,
      monitorDevice: "\\\\.\\DISPLAY2",
      monitorLeft: 0,
      monitorTop: 0,
      monitorRight: 2560,
      monitorBottom: 1600,
    }, {
      displayId: "DISPLAY1",
      x: 0,
      y: 0,
      width: 3413,
      height: 1440,
    })).toBe(false);
  });

  it("uses Unicode Win32 title APIs so localized protected-media titles survive enumeration", () => {
    expect(source).toContain('[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError = true)]');
    expect(source).toContain("public static extern int GetWindowTextLength");
    expect(source).toContain("public static extern int GetWindowText");
  });
});
