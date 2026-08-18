<#
.SYNOPSIS
  One-shot statusline setup for a new machine (Windows).
.DESCRIPTION
  Verifies Node 18+, installs the Claude Code hooks, registers the watcher to
  start at login, runs the preflight checks, and opens the UI.
  Safe to re-run: every step is idempotent.
.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -NoAutostart -NoOpen
.EXAMPLE
  .\install.ps1 -JoinUrl https://team.example.net -JoinCode <enroll-code>
#>
[CmdletBinding()]
param(
  [switch]$NoAutostart,   # skip login registration
  [switch]$NoOpen,        # do not open the browser
  [switch]$NoStart,       # do not launch the watcher now
  [string]$JoinUrl,       # team endpoint to enroll with (from your dashboard)
  [string]$JoinCode       # single-use enroll code (from your dashboard)
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$cli = Join-Path $repo 'src\cli.js'

function Say($msg)  { Write-Host "  $msg" }
function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Die($msg)  { Write-Host "`nX $msg" -ForegroundColor Red; exit 1 }

Write-Host "`nstatusline setup" -ForegroundColor White
Say "repo: $repo"

Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'Node.js is not installed or not on PATH. Get it from https://nodejs.org (18+), then re-run.' }
$ver = (& node --version).TrimStart('v')
$major = [int]($ver.Split('.')[0])
if ($major -lt 18) { Die "Node $ver found, but statusline needs 18 or newer." }
Say "Node $ver at $($node.Source)"

if (-not (Test-Path $cli)) { Die "Cannot find $cli - run this script from inside the cloned repo." }

Step 'Checking Claude Code'
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Say 'WARNING: the `claude` CLI is not on PATH.'
  Say 'Hooks will still record sessions, but nothing can be classified until it is installed and logged in.'
} else {
  Say "claude at $($claude.Source)"
}

Step 'Installing hooks into ~\.claude\settings.json'
& node $cli install
if ($LASTEXITCODE -ne 0) { Die 'Hook installation failed - see the error above. Your settings file was not modified.' }

if (-not $NoAutostart) {
  Step 'Registering the watcher to start at login'
  & node $cli autostart
  if ($LASTEXITCODE -ne 0) {
    Say 'WARNING: autostart registration failed. Start the watcher by hand with: node src\cli.js start'
  }
} else {
  Step 'Skipping autostart (-NoAutostart)'
}

if ($JoinUrl -or $JoinCode) {
  if (-not ($JoinUrl -and $JoinCode)) { Die 'Enrollment needs both -JoinUrl and -JoinCode (copy them from your team dashboard).' }
  Step 'Enrolling this machine with the team endpoint'
  & node $cli join $JoinUrl $JoinCode
  if ($LASTEXITCODE -ne 0) { Die 'Enrollment failed - see the error above. Re-run with a fresh code from your dashboard.' }
}

if (-not $NoStart) {
  Step 'Starting the watcher'
  $running = $false
  try {
    $null = Invoke-WebRequest -Uri 'http://127.0.0.1:45817/api/health' -TimeoutSec 2 -UseBasicParsing
    $running = $true
  } catch { $running = $false }
  if ($running) {
    Say 'Already running.'
  } else {
    Start-Process -FilePath 'node' -ArgumentList @($cli, 'start') -WorkingDirectory $repo -WindowStyle Hidden
    Say 'Launched in the background.'
    Start-Sleep -Seconds 3
  }
}

Step 'Running preflight checks'
& node $cli doctor

Write-Host "`nSetup complete." -ForegroundColor Green
Say 'UI:        http://127.0.0.1:45817'
Say 'Re-check:  node src\cli.js doctor'
Say 'Remove:    node src\cli.js uninstall; node src\cli.js autostart --off'
Write-Host ''
Say 'statusline observes every Claude Code session on this machine, including personal'
Say 'work, and sends a text digest of each one to an LLM through your own Claude login.'
Say 'The Egress tab lists every call. Label a session "Ignore" to exclude it.'
Write-Host ''

if (-not $NoOpen -and -not $NoStart) { Start-Process 'http://127.0.0.1:45817' }
