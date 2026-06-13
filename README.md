# DX Light++

DX Light++ is an unofficial optimization patcher for DX Light screen sync. It was built to reduce capture overhead on high-resolution displays and to improve LED behavior on 21:9 ultrawide monitors when 16:9 video produces black side bars.

The repository name recommended for GitHub is `dx-light-plus-plus`; the project title is DX Light++.

## What It Does

- Runs a native DXGI border sampler for the selected DX Light display instead of repeatedly sampling the whole desktop.
- Samples only the LED-relevant top, left, and right edges for 3-edge monitor backlight layouts.
- Detects 16:9 content inside a 21:9 monitor and samples the active video border instead of black pillarbox bars.
- Keeps the previous LED frame on static screens when Desktop Duplication reports that no new frame is available.
- Locks sync brightness to maximum during screen sync and can apply an optional RGB output gain.
- Adds a Korean sync-focused dashboard with runtime, capture, and diagnostic status.
- Falls back to the original region-capture path if the native sidecar cannot start.

## What This Repository Does Not Include

- No original DX Light application files.
- No patched `app.asar`, installer, or redistributed vendor bundle.
- No device-specific logs, UUIDs, HID paths, or private user settings.
- No DRM bypass, protected-content extraction, HDCP workaround, or browser flag workaround.

Users must install DX Light separately and use this repository only to build and apply local patches to their own installation.

## Safety And Privacy

DX Light++ is designed as a local patcher. It does not require cloud services and does not intentionally collect or transmit personal data.

Before publishing or packaging this repository, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/audit-public-release.ps1
```

The audit checks for common private paths, generated vendor bundles, logs, native binaries, and known local device identifiers. The root `.gitignore` also excludes local DX Light bundles and build artifacts by default.

## Requirements

- Windows 10/11
- Node.js and npm
- A locally installed DX Light application
- A DX Light-compatible monitor backlight device
- Zig is downloaded by `scripts/build-dxgi-sampler.ps1` when needed

## Common Commands

```powershell
npm install
npm test
npm run build
npm run native:build
npm run dxlight:patch
npm run dxlight:patch:restart
npm run dxlight:verify
```

`npm run dxlight:patch:restart` stops DX Light, patches the local installation under `vendor-patched/DX Light`, deploys the locally built native sampler, verifies patch markers, and starts DX Light again.

The RGB output gain defaults to `1.0` until the continuous-use hardware headroom is known. It can be tuned before patching or before launching the patched app:

```powershell
$env:DX_LIGHT_OUTPUT_BRIGHTNESS_GAIN = "1.35"
npm run dxlight:patch:restart
```

Supported values are `1.0` through `2.0`; values above the LED byte range clamp at `255`.

## Performance Summary

On the test 5K2K / 21:9 setup, the original full-screen capture path measured about `3.5-4.1%` total system CPU. The final native border sampler at a `50ms` interval measured about `0.69%` average total system CPU in the latest runtime sample, with the DXGI sampler using about `0.19%` GPU 3D engine utilization.

See [docs/performance.md](docs/performance.md) for details and measurement caveats.

## Legal And Compatibility Notice

DX Light++ is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by the makers of DX Light or any related hardware vendor.

The MIT license in this repository applies only to original code and documentation in this repository. It does not apply to DX Light, its bundled modules, firmware, installers, trademarks, or other third-party software.

Use at your own risk. Local patching can break after upstream DX Light updates, and device behavior may vary by hardware revision.

## More Documents

- [Usage conditions](docs/usage-conditions.md)
- [Performance notes](docs/performance.md)
- [Privacy policy](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Disclaimer](DISCLAIMER.md)
- [Notice](NOTICE.md)
