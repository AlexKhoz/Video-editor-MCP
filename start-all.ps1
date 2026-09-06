<#
.SYNOPSIS
  Starts the whole local dev stack: Redis, the render-service API, both workers and the editor.

.DESCRIPTION
  Dev convenience only - no error recovery beyond clear messages, no production ambitions.
  Opens one Windows Terminal window with four titled tabs (or four plain PowerShell windows
  when wt.exe is missing), then waits until the API reports healthy.

  Records what it started in .dev-stack.json so stop-all.ps1 can shut it down again.

.EXAMPLE
  .\start-all.ps1
  .\start-all.ps1 -DockerTimeoutSeconds 90 -HealthTimeoutSeconds 60
#>
[CmdletBinding()]
param(
    [int]$DockerTimeoutSeconds = 60,
    [int]$HealthTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stateFile = Join-Path $root '.dev-stack.json'
$healthUrl = 'http://127.0.0.1:3001/health'
$editorUrl = 'http://localhost:5173'

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    OK   $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "    WARN $Text" -ForegroundColor Yellow }
function Write-Bad  { param([string]$Text) Write-Host "    FAIL $Text" -ForegroundColor Red }

function Test-DockerRunning {
    # `docker info` fails fast when the engine is down; the exit code is the signal.
    # The redirect happens inside cmd on purpose: PowerShell 5.1 wraps a native command's
    # redirected stderr in a NativeCommandError, which $ErrorActionPreference='Stop' turns
    # into a terminating error - killing this script exactly when Docker is down.
    cmd /c "docker info >NUL 2>&1"
    return ($LASTEXITCODE -eq 0)
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

# --------------------------------------------------------------------- 1. Docker

Write-Step 'Docker'
if (Test-DockerRunning) {
    Write-Ok 'Docker engine already running.'
} else {
    $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $exe)) {
        # Fall back to whatever the shell can find, then give up with something actionable.
        $cmd = Get-Command 'Docker Desktop.exe' -ErrorAction SilentlyContinue
        if ($cmd) { $exe = $cmd.Source }
    }
    if (-not (Test-Path $exe)) {
        Write-Bad "Docker Desktop not found at '$exe'. Start it manually, then re-run this script."
        exit 1
    }

    Write-Host "    Launching $exe ..."
    Start-Process $exe | Out-Null

    $deadline = (Get-Date).AddSeconds($DockerTimeoutSeconds)
    while (-not (Test-DockerRunning)) {
        if ((Get-Date) -ge $deadline) {
            Write-Bad "Docker did not come up within $DockerTimeoutSeconds seconds."
            Write-Host "         It is probably still booting - give it a moment and re-run this script."
            exit 1
        }
        Start-Sleep -Seconds 2
        Write-Host '    ...waiting for the Docker engine'
    }
    Write-Ok 'Docker engine is up.'
}

# ---------------------------------------------------------------------- 2. Redis

Write-Step 'Redis'
docker compose -f (Join-Path $root 'infra\docker-compose.yml') up -d
if ($LASTEXITCODE -ne 0) {
    Write-Bad 'docker compose up failed - see the output above.'
    exit 1
}
Write-Ok 'Redis container up on 127.0.0.1:6379.'

# ------------------------------------------------------------- 2b. Port check

# Without this, a leftover process on 3001 or 5173 answers the health check below and the
# summary cheerfully reports a stack that was never started. Been bitten by exactly that.
Write-Step 'Ports'
$busy = $false
foreach ($check in @(@{ Port = 3001; Name = 'Render API' }, @{ Port = 5173; Name = 'Editor' })) {
    $held = Get-ListenerPid -Port $check.Port
    if ($held -gt 0) {
        $info = Get-CimInstance Win32_Process -Filter "ProcessId = $held" -ErrorAction SilentlyContinue
        $what = 'unknown process'
        if ($info) { $what = $info.Name }
        Write-Bad "port $($check.Port) ($($check.Name)) already held by pid $held ($what)"
        $busy = $true
    } else {
        Write-Ok "port $($check.Port) free"
    }
}
if ($busy) {
    Write-Host '         A leftover process would be reported as healthy below. Run .\stop-all.ps1 first.'
    exit 1
}

# ------------------------------------------------------------------- 3. Services

$services = @(
    @{ Title = 'Render API';    Dir = 'apps\render-service'; Cmd = 'npm start' }
    @{ Title = 'Render Worker'; Dir = 'apps\render-service'; Cmd = 'npm run worker' }
    @{ Title = 'Export Worker'; Dir = 'apps\render-service'; Cmd = 'npm run export-worker' }
    @{ Title = 'Editor';        Dir = 'apps\editor';         Cmd = 'pnpm --filter @openreel/web dev' }
)

Write-Step 'Service windows'
$windowPids = @()
$wt = Get-Command wt.exe -ErrorAction SilentlyContinue

if ($wt) {
    # One window, four titled tabs. Arguments go straight to wt.exe (no shell in between),
    # so ";" separates tabs literally and only spaces need quoting.
    $wtArgs = @()
    foreach ($svc in $services) {
        if ($wtArgs.Count -gt 0) { $wtArgs += ';' }
        $wtArgs += @(
            'new-tab',
            '--title', ('"{0}"' -f $svc.Title),
            '-d', ('"{0}"' -f (Join-Path $root $svc.Dir)),
            'powershell', '-NoExit', '-Command', ('"{0}"' -f $svc.Cmd)
        )
    }
    $proc = Start-Process $wt.Source -ArgumentList $wtArgs -PassThru
    if ($proc) { $windowPids += $proc.Id }
    Write-Ok ('Windows Terminal: ' + (($services | ForEach-Object { $_.Title }) -join ', '))
} else {
    foreach ($svc in $services) {
        $inner = "`$host.UI.RawUI.WindowTitle = '$($svc.Title)'; $($svc.Cmd)"
        $proc = Start-Process powershell `
            -ArgumentList '-NoExit', '-Command', $inner `
            -WorkingDirectory (Join-Path $root $svc.Dir) `
            -PassThru
        if ($proc) { $windowPids += $proc.Id }
        Write-Ok "Window: $($svc.Title)"
    }
    Write-Warn 'wt.exe not found - opened four separate PowerShell windows instead.'
}

# ---------------------------------------------------------------- 4. Health check

Write-Step 'Waiting for the stack'
$apiHealthy = $false
$deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($health.status -eq 'ok' -and $health.redis -eq 'up') { $apiHealthy = $true; break }
    } catch {
        # Not listening yet - keep waiting.
    }
    Start-Sleep -Seconds 2
}

# Vite takes ~15-20s from cold, so it gets its own slice of patience.
$editorUp = $false
$deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    try {
        Invoke-WebRequest -Uri $editorUrl -TimeoutSec 2 -UseBasicParsing | Out-Null
        $editorUp = $true; break
    } catch {
    }
    Start-Sleep -Seconds 2
}

$apiPid       = Get-ListenerPid -Port 3001
$editorPid    = Get-ListenerPid -Port 5173
$workerPid    = Get-NodePidByCommandLine -Pattern '*src?worker.js*'
$exportPid    = Get-NodePidByCommandLine -Pattern '*src?export-worker.js*'

@{
    startedAt  = (Get-Date).ToString('o')
    root       = $root
    windowPids = $windowPids
    services   = @(
        @{ name = 'Render API';    pid = $apiPid;    port = 3001 }
        @{ name = 'Render Worker'; pid = $workerPid; port = 0 }
        @{ name = 'Export Worker'; pid = $exportPid; port = 0 }
        @{ name = 'Editor';        pid = $editorPid; port = 5173 }
    )
} | ConvertTo-Json -Depth 4 | Set-Content -Path $stateFile -Encoding utf8

# ----------------------------------------------------------------- 5. Summary

Write-Host "`n----------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ' Local dev stack' -ForegroundColor White
Write-Host '----------------------------------------------------------' -ForegroundColor DarkGray

if ($apiHealthy) { Write-Ok  "Render API      $healthUrl  (status ok, redis up)" }
else             { Write-Bad "Render API      not healthy after $HealthTimeoutSeconds s - check the 'Render API' tab" }

if ($workerPid) { Write-Ok  "Render Worker   pid $workerPid" }
else            { Write-Bad "Render Worker   no node process found - check the 'Render Worker' tab" }

if ($exportPid) { Write-Ok  "Export Worker   pid $exportPid" }
else            { Write-Bad "Export Worker   no node process found - check the 'Export Worker' tab" }

if ($editorUp) { Write-Ok  "Editor          $editorUrl" }
else           { Write-Bad "Editor          not serving yet - Vite is slow from cold, check the 'Editor' tab" }

Write-Host ''
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host ' MCP: register the server once with' -ForegroundColor DarkGray
} else {
    Write-Host ' MCP: register the server once (run this where the claude CLI is on PATH)' -ForegroundColor DarkGray
}
Write-Host ("   claude mcp add video-editor --scope user -- node {0}\apps\mcp-server\src\index.js" -f $root) -ForegroundColor DarkGray
Write-Host ''
Write-Host " Tear it all down with:  .\stop-all.ps1" -ForegroundColor DarkGray
Write-Host ''

if (-not ($apiHealthy -and $editorUp -and $workerPid -and $exportPid)) { exit 1 }
