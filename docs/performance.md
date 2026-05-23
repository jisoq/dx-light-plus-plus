# Performance Notes

These numbers are local measurements from a 5K2K / 21:9 test setup. They are useful as directionally comparable evidence, not as a universal benchmark.

## Final Applied Path

- Capture backend: DXGI Desktop Duplication sidecar.
- Display scope: selected DX Light display only.
- Spatial sampling: `80` logical pixels.
- Capture interval: `50ms`.
- LED layout: 3-edge monitor backlight, top/left/right.
- 21:9 behavior: detect 16:9 content bounds and avoid black pillarbox bars.

## Runtime CPU/GPU Comparison

| Runtime path | CPU, one logical CPU basis | CPU, 12-thread system basis | GPU engine |
| --- | ---: | ---: | ---: |
| Original full-display path, spatial `80`, original interval logic | `42-49%` | `3.5-4.1%` | `0%` |
| Sequential border fallback, spatial `80`, interval `80ms` | `3.9-9.3%` | `0.26-0.78%` | `0%` |
| DXGI native border sampler, spatial `80`, interval `50ms`, earlier sample | `1.6-7.0%` | `0.13-0.58%` | sampler `0.08%`, renderer `0.02%` |
| DXGI native border sampler, spatial `80`, interval `50ms`, latest sample | average `8.34%`, peak `14.72%` | average `0.69%`, peak `1.23%` | sampler `0.19%`, renderer `0.01%` |

The latest sample was taken after adding static-frame color retention and 21:9 active-content detection. It includes the Electron process group plus the native sampler.

## Interpreting The Numbers

The one-logical-CPU column treats one hardware thread as `100%`. The system-basis column divides that by the 12 logical processors on the test machine.

The final path uses a small amount of GPU work through DXGI. That was accepted because it removes far more CPU work from the original whole-display path and reduces foreground input stutter.

## Static Screens

Desktop Duplication can return "no new frame" on a static screen. The native sampler now keeps the last successful LED color buffer in that case instead of emitting black. A verification run with a fixed 16:9 pattern produced `NonZeroFrameCount=8` across 8 frames, including long no-change waits.

## Measurement Commands

```powershell
powershell -ExecutionPolicy Bypass -File scripts/measure-dxlight-load.ps1 -Samples 6 -IntervalSeconds 2

$env:DX_LIGHT_DISPLAY_ID='DISPLAY1'
$env:DX_LIGHT_DISPLAY_WIDTH='5120'
$env:DX_LIGHT_DISPLAY_HEIGHT='2160'
$env:DX_LIGHT_SAMPLING_RATE='80'
$env:DX_LIGHT_EDGE_THICKNESS_PX='240'
$env:DX_LIGHT_CAPTURE_INTERVAL='50'
$env:DX_LIGHT_BENCH_FRAMES='120'
node scripts/bench-native-sampler.cjs
```
