param(
    [switch]$Strict
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$forbiddenPathPatterns = @(
    '(^|[\\/])vendor-patched([\\/]|$)',
    '(^|[\\/])vendor([\\/]|$)',
    '(^|[\\/])\.tmp([\\/]|$)',
    '(^|[\\/])\.antigravitycli([\\/]|$)',
    '(^|[\\/])node_modules([\\/]|$)',
    '(^|[\\/])dist([\\/]|$)',
    '(^|[\\/])native[\\/]bin([\\/]|$)',
    '(^|[\\/])plan([\\/]|$)',
    '\.asar($|\.)',
    '\.pdb$',
    '\.exe$',
    '\.dll$',
    '\.log$'
)

$sensitiveContentPatterns = @(
    'C:\\Users\\',
    'HID#',
    'VID_[0-9a-fA-F]{4}.*PID_[0-9a-fA-F]{4}',
    'cdab763c2ebd71a5',
    'native-sampler-worker\.log',
    'app\.asar\.before',
    'SENTRY|sentry_key',
    'api[_-]?key\s*[:=]',
    'token\s*[:=]',
    'password\s*[:=]'
)

function Get-RelativePathForAudit([string]$basePath, [string]$fullPath) {
    $base = $basePath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($fullPath.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        return $fullPath.Substring($base.Length).Replace('\', '/')
    }
    return $fullPath.Replace('\', '/')
}

function Get-CandidateFiles {
    Push-Location $root
    try {
        if (Test-Path (Join-Path $root ".git")) {
            return @(git ls-files --cached --others --exclude-standard)
        }

        $exclude = @(
            ".tmp",
            ".antigravitycli",
            "dist",
            "node_modules",
            "vendor",
            "vendor-patched",
            "native/bin",
            "plan",
            "public-release"
        )
        return @(Get-ChildItem -Recurse -File -Force | Where-Object {
            $relative = Get-RelativePathForAudit $root $_.FullName
            $isExcluded = $false
            foreach ($item in $exclude) {
                if ($relative -eq $item -or $relative.StartsWith("$item/")) {
                    $isExcluded = $true
                    break
                }
            }
            -not $isExcluded
        } | ForEach-Object { Get-RelativePathForAudit $root $_.FullName })
    }
    finally {
        Pop-Location
    }
}

function Test-AllowedContentFinding([string]$file, [string]$pattern) {
    if ($file -eq "scripts/audit-public-release.ps1") {
        return $true
    }
    if ($file -eq "scripts/patch-dxlight-runtime.cjs" -and $pattern -eq 'app\.asar\.before') {
        return $true
    }
    if ($file -eq "scripts/templates/screen-capture-worker.edge.cjs" -and $pattern -eq 'native-sampler-worker\.log') {
        return $true
    }
    return $false
}

$files = @(Get-CandidateFiles)
$pathFindings = @()
foreach ($file in $files) {
    foreach ($pattern in $forbiddenPathPatterns) {
        if ($file -match $pattern) {
            $pathFindings += [pscustomobject]@{ File = $file; Pattern = $pattern }
        }
    }
}

$contentFindings = @()
foreach ($file in $files) {
    $fullPath = Join-Path $root $file
    if (-not (Test-Path $fullPath)) {
        continue
    }
    $extension = [IO.Path]::GetExtension($file).ToLowerInvariant()
    if ($extension -in @(".png", ".jpg", ".jpeg", ".gif", ".ico", ".exe", ".dll", ".pdb", ".zip", ".asar")) {
        continue
    }

    $text = Get-Content -LiteralPath $fullPath -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) {
        continue
    }
    foreach ($pattern in $sensitiveContentPatterns) {
        if ($text -match $pattern) {
            if (-not (Test-AllowedContentFinding $file $pattern)) {
                $contentFindings += [pscustomobject]@{ File = $file; Pattern = $pattern }
            }
        }
    }
}

$result = [pscustomobject]@{
    CandidateFileCount = $files.Count
    ForbiddenPathFindings = @($pathFindings)
    SensitiveContentFindings = @($contentFindings)
}

$result | ConvertTo-Json -Depth 5

if ($pathFindings.Count -gt 0 -or $contentFindings.Count -gt 0) {
    if ($Strict) {
        throw "Public release audit failed."
    }
    exit 1
}
