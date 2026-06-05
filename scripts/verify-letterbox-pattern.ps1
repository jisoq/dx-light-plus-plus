param(
    [string]$DisplayId = "DISPLAY1",
    [int]$PhysicalWidth = 5120,
    [int]$PhysicalHeight = 2160,
    [int]$SamplingRate = 80,
    [int]$EdgeThicknessPx = 240,
    [int]$Frames = 3,
    [ValidateSet("solid", "left-only", "right-only")]
    [string]$Pattern = "solid"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$sampler = Join-Path $root "native\bin\DxLightDxgiBorderSampler.exe"
if (-not (Test-Path $sampler)) {
    throw "Missing native sampler: $sampler"
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$activeWidth = [Math]::Round($screen.Height * 16 / 9)
$inset = [Math]::Max(0, [Math]::Floor(($screen.Width - $activeWidth) / 2))

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Bounds = $screen
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::Black
$form.ShowInTaskbar = $false

function Add-Panel([int]$Left, [int]$Top, [int]$Width, [int]$Height, [System.Drawing.Color]$Color) {
    $panel = New-Object System.Windows.Forms.Panel
    $panel.Left = $Left
    $panel.Top = $Top
    $panel.Width = $Width
    $panel.Height = $Height
    $panel.BackColor = $Color
    $form.Controls.Add($panel)
}

$contentColor = [System.Drawing.Color]::FromArgb(32, 180, 120)
$stripeWidth = [Math]::Max($EdgeThicknessPx, [Math]::Round($activeWidth * 0.12))
switch ($Pattern) {
    "solid" {
        Add-Panel -Left $inset -Top 0 -Width $activeWidth -Height $screen.Height -Color $contentColor
    }
    "left-only" {
        Add-Panel -Left $inset -Top 0 -Width $stripeWidth -Height $screen.Height -Color $contentColor
    }
    "right-only" {
        Add-Panel -Left ($inset + $activeWidth - $stripeWidth) -Top 0 -Width $stripeWidth -Height $screen.Height -Color $contentColor
    }
}

try {
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 500

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    $arguments = @(
        "--displayId", $DisplayId,
        "--width", $PhysicalWidth,
        "--height", $PhysicalHeight,
        "--samplingRate", $SamplingRate,
        "--edgeThicknessPx", $EdgeThicknessPx,
        "--edgeNumber", 3,
        "--intervalMs", 50,
        "--frames", $Frames
    )
    $process = Start-Process -FilePath $sampler -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

    $stderr = if (Test-Path $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
    if ($process.ExitCode -ne 0) {
        throw "Sampler failed with exit code $($process.ExitCode): $stderr"
    }

    $frame = $null
    $frameBytes = $null
    $frameResults = @()
    $stdout = if (Test-Path $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
    foreach ($line in ($stdout -split "`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed) {
            continue
        }
        $message = $trimmed | ConvertFrom-Json
        if ($message.type -eq "frame") {
            $bytes = [Convert]::FromBase64String([string]$message.colors)
            $hasNonZeroByte = $false
            foreach ($byte in $bytes) {
                if ($byte -ne 0) {
                    $hasNonZeroByte = $true
                    break
                }
            }
            if ($null -eq $frame -or $hasNonZeroByte) {
                $frame = $message
                $frameBytes = $bytes
            }
            $frameResults += [PSCustomObject]@{
                Signature = [string]$message.signature
                NonZero = $hasNonZeroByte
                ContentBoundsActive = [bool]$message.contentBoundsActive
                ElapsedMs = [Math]::Round([double]$message.elapsedMs, 3)
            }
        }
    }

    if ($null -eq $frame) {
        throw "No sampler frame result. $stderr"
    }

    function Test-GridColumnNonZero([byte[]]$Bytes, [int]$Cols, [int]$Rows, [int]$Column) {
        for ($row = 0; $row -lt $Rows; $row += 1) {
            $offset = 3 * ($row * $Cols + $Column)
            if ($Bytes[$offset] -ne 0 -or $Bytes[$offset + 1] -ne 0 -or $Bytes[$offset + 2] -ne 0) {
                return $true
            }
        }
        return $false
    }

    $cols = [int]$frame.cols
    $rows = [int]$frame.rows

    [PSCustomObject]@{
        LogicalScreen = "$($screen.Width)x$($screen.Height)"
        LogicalPatternInset = $inset
        Pattern = $Pattern
        ContentBoundsActive = [bool]$frame.contentBoundsActive
        ContentLeft = [int]$frame.contentLeft
        ContentRight = [int]$frame.contentRight
        LeftColumnNonZero = Test-GridColumnNonZero -Bytes $frameBytes -Cols $cols -Rows $rows -Column 0
        RightColumnNonZero = Test-GridColumnNonZero -Bytes $frameBytes -Cols $cols -Rows $rows -Column ($cols - 1)
        ElapsedMs = [Math]::Round([double]$frame.elapsedMs, 3)
        FrameCount = $frameResults.Count
        NonZeroFrameCount = @($frameResults | Where-Object { $_.NonZero }).Count
        Frames = $frameResults
    } | ConvertTo-Json -Depth 3
}
finally {
    $form.Close()
    $form.Dispose()
    if ($stdoutPath) {
        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    }
    if ($stderrPath) {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}
