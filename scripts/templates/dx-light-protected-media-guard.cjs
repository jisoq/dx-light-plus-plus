const { spawnSync } = require("child_process");

const DEFAULT_TIMEOUT_MS = 1200;
const TITLE_PATTERN = /netflix|넷플릭스/i;
const PROCESS_PATTERN = /applicationframehost|msedge|chrome|firefox|brave|opera|netflix/i;

function detectProtectedMediaOnDisplay(display, options = {}) {
  if (process.env.DX_LIGHT_PROTECTED_MEDIA_GUARD === "0") {
    return {
      protectedLikely: false,
      source: "disabled",
      reason: "",
      matches: [],
    };
  }

  const windows = Array.isArray(options.windows)
    ? options.windows
    : process.platform === "win32"
      ? readWindows(options.timeoutMs)
      : [];
  const matches = windows.filter((window) => protectedMediaMatchesDisplay(window, display));

  return {
    protectedLikely: matches.length > 0,
    source: Array.isArray(options.windows) ? "provided-window-list" : "win32-window-list",
    reason: matches.length > 0 ? `protected media window on display: ${matches[0].title}` : "",
    matches,
  };
}

function protectedMediaMatchesDisplay(window, display) {
  if (!protectedMediaTitleMatches(window)) {
    return false;
  }
  return windowOverlapsDisplay(window, display);
}

function protectedMediaTitleMatches(window) {
  const title = String(window && window.title || "");
  const processName = String(window && window.processName || "");
  return TITLE_PATTERN.test(title) && (!processName || PROCESS_PATTERN.test(processName));
}

function windowOverlapsDisplay(window, display) {
  const windowRect = normalizeRect(window);
  const displayRect = displayRectForWindow(window, display);
  if (!displayRect || !windowRect) {
    return false;
  }

  const left = Math.max(displayRect.left, windowRect.left);
  const right = Math.min(displayRect.right, windowRect.right);
  const top = Math.max(displayRect.top, windowRect.top);
  const bottom = Math.min(displayRect.bottom, windowRect.bottom);
  return right > left && bottom > top;
}

function displayRectForWindow(window, display) {
  const windowDisplayId = normalizeDisplayId(window && (window.monitorDevice || window.displayId || window.deviceName));
  const displayId = normalizeDisplayId(display && (display.displayId || display.id || display.name));
  if (windowDisplayId && displayId) {
    if (windowDisplayId !== displayId) {
      return null;
    }
    const monitorRect = normalizeRect({
      left: window && (window.monitorLeft ?? window.MonitorLeft),
      top: window && (window.monitorTop ?? window.MonitorTop),
      right: window && (window.monitorRight ?? window.MonitorRight),
      bottom: window && (window.monitorBottom ?? window.MonitorBottom),
    });
    if (monitorRect) {
      return monitorRect;
    }
  }

  return normalizeRect({
    left: display && display.x,
    top: display && display.y,
    right: Number(display && display.x) + Number(display && display.width),
    bottom: Number(display && display.y) + Number(display && display.height),
  });
}

function normalizeDisplayId(value) {
  return String(value || "").trim().toUpperCase().replace(/^\\\\\.\\/, "");
}

function normalizeRect(value) {
  const left = Number(value && (value.left ?? value.Left));
  const top = Number(value && (value.top ?? value.Top));
  const right = Number(value && (value.right ?? value.Right));
  const bottom = Number(value && (value.bottom ?? value.Bottom));
  if (![left, top, right, bottom].every(Number.isFinite)) {
    return null;
  }
  if (right <= left || bottom <= top) {
    return null;
  }
  return { left, top, right, bottom };
}

function readWindows(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    windowsScript(),
  ], {
    encoding: "utf8",
    timeout: Math.max(300, Math.round(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
    windowsHide: true,
  });

  const windows = result.error || result.status !== 0 ? [] : parseWindows(result.stdout);
  return mergeWindows(windows, readProcessTitleWindows(timeoutMs));
}

function readProcessTitleWindows(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$OutputEncoding = [System.Text.UTF8Encoding]::new();",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();",
      "Get-Process -ErrorAction SilentlyContinue |",
      "Where-Object { $_.MainWindowTitle } |",
      "Select-Object ProcessName,Id,MainWindowTitle |",
      "ConvertTo-Json -Compress",
    ].join(" "),
  ], {
    encoding: "utf8",
    timeout: Math.max(300, Math.round(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    return [];
  }
  return parseProcessTitleWindows(result.stdout);
}

function parseWindows(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => normalizeParsedWindow(item))
      .filter((item) => item.title);
  } catch {
    return [];
  }
}

function normalizeParsedWindow(item) {
  const window = {
    processName: String(item.processName || item.ProcessName || ""),
    pid: Number(item.pid || item.Pid || 0),
    title: String(item.title || item.Title || ""),
    left: Number(item.left ?? item.Left),
    top: Number(item.top ?? item.Top),
    right: Number(item.right ?? item.Right),
    bottom: Number(item.bottom ?? item.Bottom),
  };
  const monitorDevice = String(item.monitorDevice || item.MonitorDevice || "");
  if (monitorDevice) {
    window.monitorDevice = monitorDevice;
  }
  addFiniteNumber(window, "monitorLeft", item.monitorLeft ?? item.MonitorLeft);
  addFiniteNumber(window, "monitorTop", item.monitorTop ?? item.MonitorTop);
  addFiniteNumber(window, "monitorRight", item.monitorRight ?? item.MonitorRight);
  addFiniteNumber(window, "monitorBottom", item.monitorBottom ?? item.MonitorBottom);
  return window;
}

function addFiniteNumber(target, key, value) {
  if (value === null || value === undefined || value === "") {
    return;
  }
  const number = Number(value);
  if (Number.isFinite(number)) {
    target[key] = number;
  }
}

function parseProcessTitleWindows(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => ({
        processName: String(item.ProcessName || item.processName || ""),
        pid: Number(item.Id || item.id || item.pid || 0),
        title: String(item.MainWindowTitle || item.mainWindowTitle || item.title || ""),
      }))
      .filter((item) => item.title);
  } catch {
    return [];
  }
}

function mergeWindows(left, right) {
  const merged = [...left];
  const seen = new Set();

  for (const window of left) {
    seen.add(windowIdentity(window));
  }

  for (const window of right) {
    const identity = windowIdentity(window);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    merged.push(window);
  }
  return merged;
}

function windowIdentity(window) {
  return `${window && window.pid || 0}:${String(window && window.processName || "").toLowerCase()}:${window && window.title || ""}`;
}

function windowsScript() {
  return `
$OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class DxLightWindowApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  public const uint MONITOR_DEFAULTTONEAREST = 2;

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
  public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public int dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)]
    public string szDevice;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);

  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);
}
"@

$items = New-Object System.Collections.Generic.List[object]
[DxLightWindowApi]::EnumWindows({
  param($hWnd, $lParam)
  if (-not [DxLightWindowApi]::IsWindowVisible($hWnd)) { return $true }
  $length = [DxLightWindowApi]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }
  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][DxLightWindowApi]::GetWindowText($hWnd, $builder, $builder.Capacity)
  $title = $builder.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  [uint32]$windowProcessId = 0
  [void][DxLightWindowApi]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
  $process = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
  $rect = New-Object DxLightWindowApi+RECT
  [void][DxLightWindowApi]::GetWindowRect($hWnd, [ref]$rect)
  $monitorDevice = ""
  $monitorLeft = $null
  $monitorTop = $null
  $monitorRight = $null
  $monitorBottom = $null
  $monitor = [DxLightWindowApi]::MonitorFromWindow($hWnd, [DxLightWindowApi]::MONITOR_DEFAULTTONEAREST)
  if ($monitor -ne [IntPtr]::Zero) {
    $monitorInfo = New-Object DxLightWindowApi+MONITORINFOEX
    $monitorInfo.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][DxLightWindowApi+MONITORINFOEX])
    if ([DxLightWindowApi]::GetMonitorInfo($monitor, [ref]$monitorInfo)) {
      $monitorDevice = $monitorInfo.szDevice
      $monitorLeft = $monitorInfo.rcMonitor.Left
      $monitorTop = $monitorInfo.rcMonitor.Top
      $monitorRight = $monitorInfo.rcMonitor.Right
      $monitorBottom = $monitorInfo.rcMonitor.Bottom
    }
  }
  $items.Add([pscustomobject]@{
    processName = if ($process) { $process.ProcessName } else { "" }
    pid = $windowProcessId
    title = $title
    left = $rect.Left
    top = $rect.Top
    right = $rect.Right
    bottom = $rect.Bottom
    monitorDevice = $monitorDevice
    monitorLeft = $monitorLeft
    monitorTop = $monitorTop
    monitorRight = $monitorRight
    monitorBottom = $monitorBottom
  })
  return $true
}, [IntPtr]::Zero) | Out-Null
$items | ConvertTo-Json -Compress
`;
}

module.exports = {
  detectProtectedMediaOnDisplay,
  mergeWindows,
  parseProcessTitleWindows,
  parseWindows,
  readProcessTitleWindows,
  readWindows,
  protectedMediaMatchesDisplay,
  protectedMediaTitleMatches,
  windowOverlapsDisplay,
};
