param(
  [ValidateSet('bootstrap','install','build','serve','check','stop','stop-db','pnpm')][string]$Task = 'check',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ToolArgs
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$tools = Join-Path (Get-Location) '.work/tools'
$nodeDir = Join-Path $tools 'node-v22.18.0-win-x64'
$node = Join-Path $nodeDir 'node.exe'
$pnpm = Join-Path $tools 'pnpm/node_modules/pnpm/bin/pnpm.cjs'
if ($Task -eq 'bootstrap') {
  New-Item -ItemType Directory -Force $tools | Out-Null
  if (!(Test-Path $node)) {
    $archive = 'node-v22.18.0-win-x64.zip'
    Invoke-WebRequest "https://nodejs.org/dist/v22.18.0/$archive" -OutFile (Join-Path $tools $archive) -TimeoutSec 180
    Invoke-WebRequest 'https://nodejs.org/dist/v22.18.0/SHASUMS256.txt' -OutFile (Join-Path $tools 'SHASUMS256.txt') -TimeoutSec 30
    $expected = ((Get-Content (Join-Path $tools 'SHASUMS256.txt') | Where-Object { $_ -match "  $([regex]::Escape($archive))$" }) -split '\s+')[0]
    if ((Get-FileHash (Join-Path $tools $archive) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node archive checksum mismatch' }
    Expand-Archive -LiteralPath (Join-Path $tools $archive) -DestinationPath $tools
  }
}
if (!(Test-Path $node)) { throw 'Run scripts/qualification.ps1 bootstrap first' }
# Allowlist the child environment. Never inherit owner credentials, NODE_OPTIONS,
# proxy settings, DATABASE_URL, AI keys or provider credentials; never read .env.
$safe = @{}
foreach ($key in @('SystemRoot','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PATHEXT','ORDERTRUTH_PG_BIN')) {
  $value = [Environment]::GetEnvironmentVariable($key)
  if ($value) { $safe[$key] = $value }
}
$safe['PATH'] = "$nodeDir;$tools/pnpm/node_modules/.bin;$env:SystemRoot/System32;$env:SystemRoot"
# The Lab reads its publication identity through Git. Allow only the resolved
# executable directory; do not inherit the ambient PATH or credential variables.
$gitCommand = Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1
$safe['PATH'] += ";$(Split-Path $gitCommand.Source -Parent)"
$safe['NODE_ENV'] = 'test'
$safe['npm_config_frozen_lockfile'] = 'true'
$safe['npm_config_verify_deps_before_run'] = 'false'
function Invoke-Local([string[]]$Arguments) {
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $node
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.WorkingDirectory = (Get-Location).Path
  $info.Environment.Clear()
  foreach ($entry in $safe.GetEnumerator()) { $info.Environment[$entry.Key] = $entry.Value }
  foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
  $child = [System.Diagnostics.Process]::Start($info)
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()
  try {
    if ($Task -eq 'serve' -and $Arguments -contains 'scripts/qualification-server.ts') {
      $deadline = [DateTime]::UtcNow.AddSeconds(45)
      $ready = $false
      while (!$child.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        try {
          $identity = Invoke-RestMethod 'http://127.0.0.1:3003/qualification/identity' -TimeoutSec 1
          if ($identity.pid -eq $child.Id -and $identity.qualificationOnly) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 250
      }
      if (!$ready) { throw 'Backend did not become ready within 45 seconds; inspect startup output and .work/postgres/server.log' }
      Write-Output "READY http://127.0.0.1:3003/qualification/ (PID $($child.Id)); external network denied, 45-minute maximum lifetime"
    }
    $child.WaitForExit()
  } finally {
    if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
    Write-Output $stdout.GetAwaiter().GetResult()
    Write-Output $stderr.GetAwaiter().GetResult()
  }
  if ($child.ExitCode -ne 0) { throw "Local command failed (exit $($child.ExitCode)); inspect sanitized output" }
}
Invoke-Local -Arguments @('--version')
if ($Task -eq 'bootstrap') {
  Invoke-Local -Arguments @((Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js'),'install','--prefix',(Join-Path $tools 'pnpm'),'pnpm@11.4.0','--ignore-scripts','--no-package-lock','--no-audit','--no-fund')
} elseif (!(Test-Path $pnpm)) { throw 'Run bootstrap first to install isolated pnpm' }
switch ($Task) {
  'bootstrap' { Invoke-Local -Arguments @($pnpm,'--version') }
  'install' { Invoke-Local -Arguments @($pnpm,'install','--frozen-lockfile') }
  'build' { Invoke-Local -Arguments @($pnpm,'build:frontend') }
  'pnpm' {
    $isVitest = $ToolArgs.Count -ge 3 -and $ToolArgs[0] -eq 'exec' -and $ToolArgs[1] -eq 'vitest' -and $ToolArgs[2] -eq 'run'
    if (!$ToolArgs -or ($ToolArgs[0] -notin @('typecheck','test','test:postgres') -and !$isVitest)) {
      throw 'Qualification permits only typecheck, test, test:postgres or exec vitest run; provider/hosted scripts are excluded'
    }
    if ($ToolArgs | Where-Object { $_ -match '^(--config(?:=|$)|-c)' }) {
      throw 'Custom test configuration is excluded; use the guarded test:postgres task for PostgreSQL tests'
    }
    if ($ToolArgs -contains 'test:postgres') {
      Invoke-Local -Arguments @('--import','tsx','scripts/local-postgres.ts','check')
    }
    Invoke-Local -Arguments (@($pnpm) + $ToolArgs)
  }
  'serve' { Invoke-Local -Arguments @('--import','tsx','scripts/qualification-server.ts') }
  'check' { Invoke-Local -Arguments @('--import','tsx','scripts/qualification-server.ts','--check') }
  'stop' {
    $runtime = Get-Content -LiteralPath '.work/qualification/runtime.json' | ConvertFrom-Json
    $owned = Get-CimInstance Win32_Process -Filter "ProcessId=$($runtime.pid)"
    if (!$owned) { Write-Output 'Recorded local backend is already stopped'; break }
    if ($owned.ExecutablePath -ne $node -or $owned.CommandLine -notmatch 'qualification-server.ts') { throw 'Refusing unknown backend process' }
    Stop-Process -Id $runtime.pid
    Write-Output 'Stopped owned local backend; database retained'
  }
  'stop-db' { Invoke-Local -Arguments @('--import','tsx','scripts/local-postgres.ts','stop') }
}
