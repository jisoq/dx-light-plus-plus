# Public Release Checklist

Use this checklist before making a repository public or uploading an archive.

## Required

- Repository slug uses a safe GitHub name such as `dx-light-plus-plus`.
- README clearly says the project is unofficial and unaffiliated.
- `LICENSE`, `NOTICE.md`, `DISCLAIMER.md`, `PRIVACY.md`, and `SECURITY.md` are present.
- The repository contains source code and documentation only.
- `vendor-patched/`, `.tmp/`, `dist/`, `native/bin/`, `node_modules/`, and `plan/` are not included.
- No `app.asar`, patched app bundle, installer, or proprietary vendor binary is included.
- No local logs are included.
- No personal filesystem paths, HID paths, device UUIDs, or raw personal device reports are included.
- DRM language is limited to non-bypass compatibility boundaries.

## Commands

```powershell
npm test
npm run build
powershell -ExecutionPolicy Bypass -File scripts/audit-public-release.ps1
```

## Recommended Git Flow

```powershell
git init
git add .
git status --short
powershell -ExecutionPolicy Bypass -File scripts/audit-public-release.ps1
git commit -m "Prepare DX Light++ public release"
```

Review `git status --short` before committing. The status should not include generated binaries, vendor bundles, logs, or private working notes.
