param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $root "native\DxLightBorderSampler\DxLightBorderSampler.cs"
$outDir = Join-Path $root "native\bin"
$outFile = Join-Path $outDir "DxLightBorderSampler.exe"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $source)) {
    throw "Missing source: $source"
}

if (-not (Test-Path $csc)) {
    throw "Missing .NET Framework C# compiler: $csc"
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$optimize = if ($Configuration -ieq "Debug") { "/optimize-" } else { "/optimize+" }
& $csc `
    /nologo `
    /platform:x64 `
    /target:exe `
    $optimize `
    /warn:4 `
    /out:$outFile `
    /reference:System.Drawing.dll `
    $source

if ($LASTEXITCODE -ne 0) {
    throw "Native sampler build failed with exit code $LASTEXITCODE"
}

Get-Item $outFile | Select-Object FullName, Length, LastWriteTime
