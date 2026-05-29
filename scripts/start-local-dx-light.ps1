param(
    [switch] $NoSyncConfig
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DxLightDir = Join-Path $Root "vendor-patched\DX Light"
$DxLightExe = Join-Path $DxLightDir "DX Light.exe"
$ConfigPath = Join-Path $env:APPDATA "quiklight-desktop\config.json"

if (-not (Test-Path -LiteralPath $DxLightExe)) {
    throw "DX Light executable was not found: $DxLightExe"
}

function Enable-ScreenSyncInConfig {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        Write-Host "DX Light config does not exist yet; the app will create it after device discovery."
        return
    }

    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if (-not $config.devices -or $config.devices.Count -lt 1) {
        Write-Host "DX Light config has no saved devices yet."
        return
    }

    $displayId = $config.devices[0].displayId
    if (-not $displayId) {
        $displayId = "\\.\DISPLAY1"
    }

    for ($index = 0; $index -lt $config.devices.Count; $index += 1) {
        $device = $config.devices[$index]
        if ($index -eq 0) {
            $device.isSyncScreen = $true
            $device.isSwitchOn = $true
            $device.syncMode = 0
            if (-not $device.displayId) {
                $device.displayId = $displayId
            }
            if ($device.brightnessColor) {
                $device.brightnessColor.a = 1
            }
            $device.whiteBrightValue = 100
        } else {
            $device.isSyncScreen = $false
        }
    }

    $config | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
    Write-Host "DX Light config is set to start screen sync for the first saved device."
}

if (-not $NoSyncConfig) {
    Enable-ScreenSyncInConfig
}

$running = Get-Process -Name "DX Light" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $DxLightExe } |
    Select-Object -First 1

if ($running) {
    Write-Host "DX Light is already running from $DxLightExe (PID $($running.Id))."
    return
}

Start-Process -FilePath $DxLightExe -ArgumentList @("--startup", "1") -WorkingDirectory $DxLightDir -WindowStyle Minimized
Write-Host "Started DX Light from $DxLightExe."
