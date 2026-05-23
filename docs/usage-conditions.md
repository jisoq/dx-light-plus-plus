# Usage Conditions

DX Light++ is intended for users who already have DX Light installed and have permission to modify files on their own computer.

## Allowed Use

- Build and inspect the native sampler source.
- Apply local performance patches to a local DX Light installation.
- Measure CPU/GPU impact on your own hardware.
- Adapt the patcher for personal display and LED layouts.
- Share improvements to the original DX Light++ source code.

## Not Included

- DX Light installers or application bundles.
- Patched `app.asar` files.
- Vendor firmware or native modules.
- Device-specific private configuration.
- DRM bypass logic.

## User Responsibilities

You are responsible for:

- Backing up your local DX Light installation and settings.
- Complying with any third-party licenses or terms that apply to DX Light.
- Reviewing scripts before running them.
- Keeping private identifiers and logs out of public issues and pull requests.
- Re-running verification after DX Light, Windows, GPU driver, or firmware updates.

## Publication Rules

When publishing forks or releases:

- Publish source code, scripts, and documentation only.
- Do not publish local vendor bundles, generated binaries, logs, or app backups.
- Keep the project described as unofficial and unaffiliated.
- Keep DRM-related language limited to non-bypass compatibility boundaries.
- Run `scripts/audit-public-release.ps1` before pushing.
