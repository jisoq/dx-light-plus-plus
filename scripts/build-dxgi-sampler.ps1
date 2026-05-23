param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $root "native\DxLightBorderSampler\DxLightDxgiBorderSampler.cpp"
$outDir = Join-Path $root "native\bin"
$outFile = Join-Path $outDir "DxLightDxgiBorderSampler.exe"
$zig = Join-Path $root ".tmp\zig-0.16.0\zig.exe"
$zigDir = Join-Path $root ".tmp\zig-0.16.0"
$zigZip = Join-Path $root ".tmp\zig-x86_64-windows-0.16.0.zip"
$zigUrl = "https://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip"
$zigSha256 = "68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e"

if (-not (Test-Path $source)) {
    throw "Missing source: $source"
}

if (-not (Test-Path $zig)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $root ".tmp") | Out-Null
    if (-not (Test-Path $zigZip)) {
        Invoke-WebRequest -Uri $zigUrl -OutFile $zigZip
    }

    $actualHash = (Get-FileHash $zigZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $zigSha256) {
        throw "Zig archive hash mismatch: $actualHash"
    }

    Expand-Archive -Path $zigZip -DestinationPath (Join-Path $root ".tmp") -Force
    $actualDir = Get-ChildItem (Join-Path $root ".tmp") -Directory |
        Where-Object { $_.Name -like "zig-x86_64-windows-0.16.0*" } |
        Select-Object -First 1
    if ($actualDir -and $actualDir.FullName -ne $zigDir) {
        if (Test-Path $zigDir) {
            Remove-Item -LiteralPath $zigDir -Recurse -Force
        }
        Move-Item -LiteralPath $actualDir.FullName -Destination $zigDir
    }
}

if (-not (Test-Path $zig)) {
    throw "Missing Zig compiler after setup: $zig"
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$optimize = if ($Configuration -ieq "Debug") { "-O0" } else { "-O2" }
& $zig c++ `
    -target x86_64-windows-gnu `
    $optimize `
    -std=c++17 `
    -Wno-nullability-completeness `
    -DUNICODE=0 `
    -o $outFile `
    $source `
    -ld3d11 `
    -ldxgi `
    -lole32

if ($LASTEXITCODE -ne 0) {
    throw "DXGI sampler build failed with exit code $LASTEXITCODE"
}

Get-Item $outFile | Select-Object FullName, Length, LastWriteTime
