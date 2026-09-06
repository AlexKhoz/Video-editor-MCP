<#
.SYNOPSIS
  Stops everything start-all.ps1 started: the four node processes, their terminal tabs, and Redis.

.DESCRIPTION
  Uses .dev-stack.json when it is there, but does not depend on it - the services are also
  discoverable by listening port (3001, 5173) and by command line (worker.js, export-worker.js),
  so this still works after a reboot or if the stack was started by hand.

.EXAMPLE
  .\stop-all.ps1
  .\stop-all.ps1 -KeepRedis
#>
[CmdletBinding()]
param(
    [switch]$KeepRedis
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stateFile = Join-Path $root '.dev-stack.json'

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    OK   $Text" -ForegroundColor Green }
function Write-Info { param([string]$Text) Write-Host "    ---  $Text" -ForegroundColor DarkGray }
function Write-Bad  { param([string]$Text) Write-Host "    FAIL $Text" -ForegroundColor Red }

function Get-ProcessInfo {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $null }
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

# Never kill ourselves or the shell that launched us.
function Get-AncestorIds {
    param([int]$ProcessId)
    $ids = @()
    $current = $ProcessId
    for ($i = 0; $i -lt 8 -and $current -gt 0; $i++) {
        $ids += $current
        $info = Get-ProcessInfo -ProcessId $current
        if (-not $info) { break }
        $current = [int]$info.ParentProcessId
    }
    return $ids
}

$protected = Get-AncestorIds -ProcessId $PID

function Stop-Target {
    param([int]$ProcessId, [string]$Label)
    if ($ProcessId -le 0) { return $false }
    if ($protected -contains $ProcessId) {
        Write-Info "$Label (pid $ProcessId) is this session's own shell - left alone."
        return $false
    }
    $info = Get-ProcessInfo -ProcessId $ProcessId
    if (-not $info) { return $false }
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        Write-Ok "$Label stopped (pid $ProcessId, $($info.Name))"
        return $true
    } catch {
        Write-Bad "$Label (pid $ProcessId) would not stop: $($_.Exception.Message)"
        return $false
    }
}

function Get-ListenerPid {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return 0
}

function Get-NodePidByCommandLine {
    param([string]$Pattern)
    $proc = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like $Pattern } |
        Select-Object -First 1
    if ($proc) { return [int]$proc.ProcessId }
    return 0
}

# The tab hosting a service is a powershell.exe some levels above the node process
# (node <- cmd.exe from npm <- powershell.exe; pnpm nests deeper still, hence 8).
# Returns the first powershell ancestor; Stop-Target refuses to kill our own shell.
function Get-HostShellId {
    param([int]$ProcessId)
    $current = $ProcessId
    for ($i = 0; $i -lt 8 -and $current -gt 0; $i++) {
        $info = Get-ProcessInfo -ProcessId $current
        if (-not $info) { return 0 }
        $current = [int]$info.ParentProcessId
        $parent = Get-ProcessInfo -ProcessId $current
        if (-not $parent) { return 0 }
        if ($parent.Name -in @('powershell.exe', 'pwsh.exe')) { return $current }
    }
    return 0
}

# ------------------------------------------------------------------ 1. Services

Write-Step 'Services'

$state = $null
if (Test-Path $stateFile) {
    try { $state = Get-Content $stateFile -Raw | ConvertFrom-Json } catch { $state = $null }
}

$targets = @(
    @{ Name = 'Render API';    Port = 3001; Pattern = $null }
    @{ Name = 'Render Worker'; Port = 0;    Pattern = '*src?worker.js*' }
    @{ Name = 'Export Worker'; Port = 0;    Pattern = '*src?export-worker.js*' }
    # Vite silently falls back to 5174+ when 5173 is taken, so match its command line too.
    @{ Name = 'Editor';        Port = 5173; Pattern = '*apps\editor*vite*' }
)

$stopped = 0
$shellIds = @()

foreach ($target in $targets) {
    # Live discovery first - a recorded pid can be stale or recycled.
    $processId = 0
    if ($target.Port -gt 0) { $processId = Get-ListenerPid -Port $target.Port }
    if ($processId -le 0 -and $target.Pattern) { $processId = Get-NodePidByCommandLine -Pattern $target.Pattern }
    if ($processId -le 0 -and $state) {
        $recorded = $state.services | Where-Object { $_.name -eq $target.Name } | Select-Object -First 1
        if ($recorded) {
            $info = Get-ProcessInfo -ProcessId ([int]$recorded.pid)
            if ($info -and $info.Name -eq 'node.exe') { $processId = [int]$recorded.pid }
        }
    }

    if ($processId -le 0) {
        Write-Info "$($target.Name) was not running."
        continue
    }

    $shell = Get-HostShellId -ProcessId $processId
    if ($shell -gt 0) { $shellIds += $shell }
    if (Stop-Target -ProcessId $processId -Label $target.Name) { $stopped++ }
}

# ------------------------------------------------------------------- 2. Windows

Write-Step 'Terminal windows'
foreach ($shell in ($shellIds | Sort-Object -Unique)) {
    Stop-Target -ProcessId $shell -Label 'Service tab' | Out-Null
}
if ($state -and $state.windowPids) {
    foreach ($windowPid in $state.windowPids) {
        Stop-Target -ProcessId ([int]$windowPid) -Label 'Terminal window' | Out-Null
    }
}
if ($shellIds.Count -eq 0) { Write-Info 'No service tabs to close.' }

# --------------------------------------------------------------------- 3. Redis

if ($KeepRedis) {
    Write-Step 'Redis'
    Write-Info 'Left running (-KeepRedis).'
} else {
    Write-Step 'Redis'
    docker compose -f (Join-Path $root 'infra\docker-compose.yml') down
    if ($LASTEXITCODE -eq 0) { Write-Ok 'Container stopped and removed (the redis-data volume is kept).' }
    else { Write-Bad 'docker compose down failed - see the output above.' }
}

# ---------------------------------------------------------------- 4. Verify

Write-Step 'Verifying'
$clean = $true
foreach ($port in @(3001, 5173)) {
    $processId = Get-ListenerPid -Port $port
    if ($processId -gt 0) { Write-Bad "port $port still held by pid $processId"; $clean = $false }
    else { Write-Ok "port $port free" }
}
foreach ($pattern in @('*src?worker.js*', '*src?export-worker.js*', '*apps\editor*vite*')) {
    $processId = Get-NodePidByCommandLine -Pattern $pattern
    if ($processId -gt 0) { Write-Bad "still running: pid $processId ($pattern)"; $clean = $false }
}
if (-not $KeepRedis) {
    # No 2>$null here: redirecting native stderr under ErrorActionPreference='Stop'
    # raises a terminating NativeCommandError.
    $container = docker ps --filter name=video-editor-redis --format '{{.Names}}'
    if ($container) { Write-Bad "container still up: $container"; $clean = $false }
    else { Write-Ok 'redis container stopped' }
}

if (Test-Path $stateFile) { Remove-Item $stateFile -Force }

Write-Host ''
if ($clean) { Write-Host " Stack is down ($stopped service(s) stopped)." -ForegroundColor Green }
else { Write-Host ' Something is still up - see the FAIL lines above.' -ForegroundColor Yellow; exit 1 }
Write-Host ''
