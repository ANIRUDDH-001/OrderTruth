$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Hosted Windows runner only.' }
$Pins = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\tool-pins.json') | ConvertFrom-Json
if ((& node.exe --version) -ne "v$($Pins.node)") { throw 'Node pin mismatch' }
$Archive = Join-Path $env:RUNNER_TEMP 'ffmpeg-9.0.2-full_build.zip'
$Tools = Join-Path $env:RUNNER_TEMP 'ordertruth-encoding'
Invoke-WebRequest -Uri $Pins.ffmpegUrl -OutFile $Archive
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash -ne $Pins.ffmpegSha256) { throw 'FFmpeg archive hash mismatch' }
Expand-Archive -LiteralPath $Archive -DestinationPath $Tools
$Bin = Join-Path $Tools 'ffmpeg-9.0.2-full_build\bin'
foreach ($Tool in @('ffmpeg','ffprobe')) {
    $Exe = Join-Path $Bin "$Tool.exe"
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw 'Pinned encoding tool missing' }
    $Version = & $Exe -version
    if ($LASTEXITCODE -ne 0 -or $Version[0] -notmatch '^ff(?:mpeg|probe) version 9\.0\.2-') { throw 'FFmpeg version mismatch' }
    $Key = if ($Tool -eq 'ffmpeg') { 'FFMPEG_PATH' } else { 'FFPROBE_PATH' }
    "$Key=$Exe" | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8
}
# Playwright's exact npm lock also fixes browser revision 1254 and its recording codec.
& node.exe node_modules/playwright/cli.js install chromium
if ($LASTEXITCODE -ne 0) { throw 'Pinned browser installation failed' }
