# Privacy

DX Light++ is designed to run locally.

## Data Collected By This Repository

The project code does not intentionally collect, upload, sell, or share personal data.

Runtime scripts may read local display metadata, local DX Light configuration, process state, and device status only to apply or verify the local patch. Diagnostic scripts can print process IDs, monitor dimensions, performance counters, and generic device status to the local terminal.

## Data Not Intended For Publication

Do not publish:

- DX Light application bundles or patched `app.asar` files.
- Local logs.
- Device UUIDs, HID paths, serial-like identifiers, or raw device reports from personal hardware.
- Personal filesystem paths.
- Screenshots or captures that reveal private desktop content.

## Network Behavior

The core patching scripts do not require a remote service. Build tooling may download public compiler or package dependencies according to npm and script configuration.

## Public Release Audit

Before publishing, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/audit-public-release.ps1
```

The audit is a guardrail, not a legal or security guarantee. Review the diff yourself before publishing.
