param(
    [int]$Samples = 8,
    [int]$IntervalSeconds = 2
)

$ErrorActionPreference = "Stop"

function Get-DxLightProcessRows {
    Get-Process -Name "DX Light", "DxLightDxgiBorderSampler" -ErrorAction SilentlyContinue |
        Sort-Object Id |
        Select-Object Id, ProcessName, CPU, WorkingSet64, PriorityClass, StartTime
}

$cpuSamples = @()
for ($i = 0; $i -lt $Samples; $i++) {
    $procs = @(Get-DxLightProcessRows)
    $cpuSamples += [pscustomobject]@{
        T = Get-Date
        Cpu = ($procs | Measure-Object CPU -Sum).Sum
        WorkingSet = ($procs | Measure-Object WorkingSet64 -Sum).Sum
        Count = $procs.Count
    }
    if ($i -lt ($Samples - 1)) {
        Start-Sleep -Seconds $IntervalSeconds
    }
}

$logicalProcessors = [Environment]::ProcessorCount
$intervalRows = for ($i = 1; $i -lt $cpuSamples.Count; $i++) {
    $dt = ($cpuSamples[$i].T - $cpuSamples[$i - 1].T).TotalSeconds
    $dcpu = $cpuSamples[$i].Cpu - $cpuSamples[$i - 1].Cpu
    $oneLogicalCpuPercent = if ($dt -gt 0) { ($dcpu / $dt) * 100 } else { 0 }
    [pscustomobject]@{
        From = $cpuSamples[$i - 1].T.ToString("HH:mm:ss")
        To = $cpuSamples[$i].T.ToString("HH:mm:ss")
        CpuPercentOfOneLogicalCpu = [Math]::Round($oneLogicalCpuPercent, 2)
        CpuPercentOfSystem = [Math]::Round($oneLogicalCpuPercent / $logicalProcessors, 2)
        ProcCount = $cpuSamples[$i].Count
        WorkingSetMB = [Math]::Round($cpuSamples[$i].WorkingSet / 1MB, 1)
    }
}

$processRows = Get-DxLightProcessRows | ForEach-Object {
    [pscustomobject]@{
        Id = $_.Id
        ProcessName = $_.ProcessName
        CPU = [Math]::Round($_.CPU, 2)
        WorkingSetMB = [Math]::Round($_.WorkingSet64 / 1MB, 1)
        PriorityClass = $_.PriorityClass
        StartTime = $_.StartTime
    }
}

$gpuRows = @()
try {
    $dxPids = @($processRows | Select-Object -ExpandProperty Id)
    $gpuRows = Get-Counter "\GPU Engine(*)\Utilization Percentage" -ErrorAction Stop |
        Select-Object -ExpandProperty CounterSamples |
        Where-Object {
            $instance = $_.InstanceName
            $dxPids | Where-Object { $instance -match "pid_$_" }
        } |
        Sort-Object CookedValue -Descending |
        Select-Object InstanceName, @{ Name = "Utilization"; Expression = { [Math]::Round($_.CookedValue, 2) } }
} catch {
    $gpuRows = @([pscustomobject]@{ InstanceName = "unavailable"; Utilization = $_.Exception.Message })
}

[pscustomobject]@{
    LogicalProcessors = $logicalProcessors
    Intervals = @($intervalRows)
    Processes = @($processRows)
    GpuEngines = @($gpuRows)
} | ConvertTo-Json -Depth 6
