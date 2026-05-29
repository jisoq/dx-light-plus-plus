param(
    [ValidateSet("enable", "disable", "status")]
    [string] $Action = "enable"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$StartScript = Join-Path $Root "scripts\start-local-dx-light.ps1"
$StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$StartupScript = Join-Path $StartupDir "DX Light Local Startup.vbs"

function Escape-VbsString([string] $Value) {
    return $Value.Replace('"', '""')
}

function Write-StartupLauncher {
    if (-not (Test-Path -LiteralPath $StartScript)) {
        throw "Startup target script was not found: $StartScript"
    }

    New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null

    $command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$StartScript"""
    $body = @(
        "' DX Light++ local startup launcher",
        "Set shell = CreateObject(""WScript.Shell"")",
        "shell.CurrentDirectory = ""$(Escape-VbsString $Root)""",
        "shell.Run ""$(Escape-VbsString $command)"", 0, False"
    ) -join "`r`n"

    Set-Content -LiteralPath $StartupScript -Value $body -Encoding ASCII
}

switch ($Action) {
    "enable" {
        Write-StartupLauncher
        Write-Host "Enabled Windows startup launcher: $StartupScript"
    }
    "disable" {
        if (Test-Path -LiteralPath $StartupScript) {
            Remove-Item -LiteralPath $StartupScript -Force
        }
        Write-Host "Disabled Windows startup launcher: $StartupScript"
    }
    "status" {
        if (Test-Path -LiteralPath $StartupScript) {
            Write-Host "Enabled: $StartupScript"
        } else {
            Write-Host "Disabled: $StartupScript"
        }
    }
}
