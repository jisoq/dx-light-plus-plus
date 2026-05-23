# Native Capture Redesign Notes

## Current Findings

- DX Light uses `@warren-robobloq/quiklight` through a bundled binary addon:
  `startCaptureMultiScreens(callback, displays, finalSyncSpeed, samplingRate)`.
- `getMonitors()` reports DPI-virtualized logical coordinates. On the local test setup:
  - `DISPLAY1`: logical `3413x1440`, physical mode `5120x2160@120`.
  - `DISPLAY2`: logical `1707x1067`, physical mode `2560x1600@120`.
- The running app now filters capture input to the display selected by the sync device
  instead of passing every monitor to the capture worker.
- The running app suppresses duplicate LED writes when the sampled frame signature has
  not changed.
- The latest runtime patch separates temporal capture interval from spatial sampling:
  - `dxLightCaptureInterval` default: `50ms`.
  - `dxLightSamplingRate` default: `80` logical pixels.
  - The screen worker now uses sequential border capture for `top`, `left`, and `right`
    on the selected display, then hands a synthetic full sampled grid back to the
    existing LED reducer. This keeps the rest of the app's protocol path intact while
    avoiding full-display capture on every tick.
  - The main capture process is set to `BelowNormal` priority so foreground input keeps
    scheduling priority when capture is expensive.

## Measured Behavior

Measurements were taken against the bundled `quiklight.node` module on `DISPLAY1`.

| Capture input | Returned bytes | RGB cells | First frame |
| --- | ---: | ---: | ---: |
| Full logical display, `3413x1440`, sampling `50` | `6003` | `2001` | `~67ms` |
| Top band, `3413x200`, sampling `50` | `828` | `276` | `~9ms` |
| Side band, `250x1440`, sampling `50` | `435` | `145` | `~9ms` |

Runtime CPU measurements with DX Light running:

| Runtime patch | CPU, one logical CPU basis | CPU, 12-thread system basis | GPU engine |
| --- | ---: | ---: | ---: |
| spatial `80`, original `t + 20ms` capture interval | `42-49%` | `3.5-4.1%` | `0%` |
| spatial `80`, `66ms` capture interval | `32-36%` | `2.7-3.0%` | `0%` |
| spatial `80`, `80ms` capture interval | `29-36%` | `2.45-2.98%` | `0%` |
| sequential border capture, spatial `80`, interval `80ms` | `3.9-9.3%` | `0.26-0.78%` | `0%` |
| sequential border capture plus Korean sync dashboard visible, spatial `80`, interval `80ms` | `5.4-12.4%` | `0.45-1.04%` | `0.02%` |
| DXGI native border sampler, spatial `80`, interval `80ms` | `1.6-5.4%` | `0.13-0.45%` | sampler `0.05%`, renderer `0.02%` |
| DXGI native border sampler, spatial `80`, interval `50ms` | `1.6-7.0%` | `0.13-0.58%` | sampler `0.08%`, renderer `0.02%` |

The final applied default is `50ms` because the native border path measured low enough
CPU/GPU overhead to keep the highest-response mode as the single user-facing mode.

The sequential border worker is also currently applied. A standalone harness measured
the old full continuous path at `875ms` Node CPU over 5 seconds, while the sequential
edge path used `188-203ms` over a similar window. The first synthetic frame appears
after all required edges have been captured once, measured around `429ms`; after warmup,
synthetic frames continued at roughly the same visible cadence as the full path.

This confirms that the native module already honors `x`, `y`, `width`, and `height`
for a single rectangular capture region. Capturing only LED-border regions can reduce
native readback work by an order of magnitude on a 5K2K display.

The implemented native sidecar is `DxLightDxgiBorderSampler.exe`. It uses DXGI Desktop
Duplication, copies one horizontal line and two vertical lines from the selected output,
avoids black 21:9 pillarbox bars when 16:9 content bounds are detected, retains the last
LED color frame on static screens, and returns the same RGB grid shape the original
worker already hands to the LED reducer.
The running Electron worker starts this sidecar first and falls back to the sequential
`quiklight` region worker if the sidecar is unavailable or fails to produce a frame.
Standalone native sampling at `33ms` interval measured `0.566ms` average capture time
and `0.756ms` p95 over 180 frames.

Observed limits of the current API:

- Passing the same `displayId` multiple times with different rectangles collapses to
  one result key, so it cannot return top/left/right/bottom in one call.
- Faking unique IDs such as `DISPLAY1#top` returns black data, so the real display ID
  appears to be required by the native backend.
- A same-process multi-worker edge-capture experiment did not produce stable multi-edge
  frames. Treat this as inconclusive until retested in an isolated harness; do not ship
  concurrent capture workers as the primary path without more validation.
- Sequential single-worker edge capture is viable with the current binary API and is
  now the live fallback when the DXGI native sidecar cannot start.
- A GDI `StretchBlt` sidecar was tested as a build-tool-free fallback, but averaged
  roughly `29-33ms` per frame and was not selected as the primary native path.
- Direct GDI `GetPixel` point sampling was rejected after measuring roughly `2.8s` per
  frame on this machine.

## Recommended Native API

Gemness/Antigravity advisory agreed with the local findings:

- Accept immediate frequency reduction, duplicate-write suppression, and native-side
  border reduction.
- Reject fake display IDs, same-process multi-worker capture as the main fix, GDI/BitBlt
  for this 5K2K display, and designs that keep shipping large raw grids into JavaScript.
- Treat DXGI Desktop Duplication as the primary Windows backend, with
  Windows.Graphics.Capture as a secondary candidate to benchmark.

Add a capture path that treats LED sync as a first-class use case instead of returning
screen-sized sampled grids:

```ts
type LedBorderCaptureOptions = {
  displayId: string;
  samplingRate: number;
  edgeThicknessPx: number;
  edgeNumber: 3 | 4;
  grid: {
    cols: number;
    rows: number;
  };
  output: "grid" | "edges";
};

type LedBorderFrame = {
  displayId: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  colors: Uint8Array; // RGB triplets for the final LED sampling grid or edge list.
};

startCaptureLedBorders(
  callback: (frame: LedBorderFrame) => void,
  options: LedBorderCaptureOptions
): void;
```

Implementation target:

- Create one capture session per physical display.
- Copy or map the desktop frame once per tick.
- Sample only the border cells needed by the LED layout.
- Avoid returning interior pixels to JavaScript.
- Return either the existing `cols * rows * RGB` grid with interior cells filled from
  nearest edges, or a direct edge-only RGB list that bypasses the current JS grid reducer.

For this device (`edgeNumber: 3`, 75 LEDs), the useful regions are left, top, and right.
The bottom edge does not need to be captured.

## Expected Benefit

The current full-display path returns `2001` RGB cells at sampling `50`. A native
border-only path can operate on roughly:

- top band: `276` RGB cells
- left band: `145` RGB cells
- right band: `145` RGB cells

That is about `566` sampled RGB cells before any further LED-specific reduction, and
only three edge regions instead of the whole display. A deeper implementation can reduce
again by sampling directly into the LED layout, avoiding the intermediate grid.

## DRM Boundary

Do not design this as a DRM bypass. Protected video surfaces may be intentionally hidden
from OS-level screen capture. If DRM content is black in normal capture APIs, supported
fallbacks should be non-bypass options such as ambient fallback colors, app-provided
metadata where available, or external hardware that observes an allowed output signal.
