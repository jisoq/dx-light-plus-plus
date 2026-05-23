# Security Policy

## Supported Scope

Security reports should focus on original DX Light++ code and documentation in this repository.

Out of scope:

- Vulnerabilities in DX Light itself.
- Vulnerabilities in vendor installers, firmware, or bundled third-party native modules.
- DRM or protected-content bypass requests.
- Reports that require publishing private device identifiers, private logs, or proprietary application bundles.

## Reporting

If this repository is published on GitHub, use private vulnerability reporting if enabled. Otherwise, open a minimal issue that describes the affected DX Light++ file or script without including secrets, device UUIDs, HID paths, private logs, or proprietary binaries.

## Handling Sensitive Artifacts

Never attach:

- `vendor-patched/`
- `app.asar` or app bundle backups
- `native/bin/`
- `.tmp/`
- local logs
- user configuration files

Use `scripts/audit-public-release.ps1` before publishing a branch or archive.
