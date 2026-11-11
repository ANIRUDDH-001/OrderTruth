[CmdletBinding()]
param([switch]$PreflightOnly,[switch]$LandingOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$VideoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($env:CI -and -not $PreflightOnly) { throw 'Protected production stages require a separately reviewed CI authorization contract. Use the Stage 1 workflow.' }
Set-Location -LiteralPath $VideoRoot
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$PythonExe = (Get-Command python.exe -ErrorAction Stop).Source
$FfBin = Split-Path -Parent $env:FFMPEG_PATH
$FfmpegExe = $env:FFMPEG_PATH
$FfprobeExe = $env:FFPROBE_PATH
$LandingScript = Join-Path $PSScriptRoot 'capture-landing-playwright.cjs'
$ProductScript = Join-Path $PSScriptRoot 'capture-product-host.cjs'
$AssemblerScript = Join-Path $PSScriptRoot 'assemble-host.py'
$TimelinePath = Join-Path $VideoRoot 'phase-a\preproduction\timeline.json'
$SourceCardPath = Join-Path $VideoRoot 'renders\S02-source-card-1080p.mp4'
$TitleCardPath = Join-Path $VideoRoot 'renders\S03-title-1080p.mp4'
$EndCardPath = Join-Path $VideoRoot 'renders\S11-end-card-1080p.mp4'
$Required = @($NodeExe,$PythonExe,$FfmpegExe,$FfprobeExe,
 $LandingScript,$ProductScript,$AssemblerScript,$TimelinePath,$SourceCardPath,$TitleCardPath,$EndCardPath)
foreach ($File in $Required) { if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Missing existing dependency/asset: $File. Nothing will be installed automatically." } }
function Invoke-Checked {
 param([string]$Program,[string[]]$ArgumentList)
 & $Program @ArgumentList
 if ($LASTEXITCODE -ne 0) { throw "Stopped: $([IO.Path]::GetFileName($Program)) returned $LASTEXITCODE. No action or recording is replayed automatically." }
}
function Get-MediaInfo {
 param([string]$Path)
 $Json = & $FfprobeExe -v error -show_streams -show_format -of json $Path
 if ($LASTEXITCODE -ne 0) { throw "FFprobe failed: $Path" }
 return ($Json -join "`n" | ConvertFrom-Json)
}
function Assert-Video {
 param([string]$Path,[double]$ExpectedSeconds)
 $Info=Get-MediaInfo $Path
 $Stream=@($Info.streams | Where-Object codec_type -eq 'video')
 if ($Stream.Count -ne 1 -or $Stream[0].width -ne 1920 -or $Stream[0].height -ne 1080 -or $Stream[0].avg_frame_rate -ne '30/1' -or $Stream[0].codec_name -ne 'h264' -or $Stream[0].pix_fmt -ne 'yuv420p') { throw "Unexpected encoding: $Path" }
 if ([Math]::Abs([double]$Info.format.duration-$ExpectedSeconds) -gt 0.15) { throw "Unexpected duration: $Path" }
 Invoke-Checked $FfmpegExe @('-v','error','-xerror','-threads','1','-i',$Path,'-f','null','-')
 return $Info
}
Write-Host 'OrderTruth production: existing assets, real hosted UI, offline speech, sequential FFmpeg.'
Write-Host 'No application-source writes, installs, Git operations, dashboards, security-setting changes or financial provider calls.'
Invoke-Checked $NodeExe @('--check',$LandingScript)
Invoke-Checked $NodeExe @('--check',$ProductScript)
Invoke-Checked $NodeExe @($ProductScript,(Join-Path $VideoRoot 'footage\policy-test'),'--policy-self-test')
Invoke-Checked $PythonExe @('-c','import ast,sys,pathlib; ast.parse(pathlib.Path(sys.argv[1]).read_text())',$AssemblerScript)
$null=Assert-Video $SourceCardPath 6
$null=Assert-Video $TitleCardPath 7
$null=Assert-Video $EndCardPath 11
if ($PreflightOnly) { Write-Host 'PREFLIGHT PASS. No browser or hosted request started.'; return }
if (Test-Path -LiteralPath (Join-Path $VideoRoot 'final\OrderTruth-Final-Demo.mp4')) { throw 'Final MP4 already exists; preserving it. Review it before starting another recording.' }
try {
 $OperatingSystem=Get-CimInstance Win32_OperatingSystem
} catch {
 throw 'Could not measure available RAM. Recording will not start without a verified memory reading.'
}
$AvailableMiB=[math]::Floor([double]$OperatingSystem.FreePhysicalMemory/1024)
if ($AvailableMiB -lt 1280) { throw ('Capture safeguard: 1.25 GiB (1280 MiB) available required; detected {0} MiB. Free at least {1} MiB and retry. Existing footage is preserved; no application will be closed automatically.' -f $AvailableMiB,(1280-$AvailableMiB)) }
$RunName=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+([guid]::NewGuid().ToString('N').Substring(0,6))
$RunPath=Join-Path $VideoRoot "footage\$RunName"
$null=New-Item -ItemType Directory -Path $RunPath
try {
 $LandingWebm=Join-Path $VideoRoot 'footage\stage1\public\landing.webm'
 $LandingMp4=Join-Path $VideoRoot 'footage\stage1\public\landing.mp4'
 if (-not (Test-Path -LiteralPath $LandingWebm)) {
  if (Test-Path -LiteralPath $LandingMp4) { throw 'Landing MP4 exists without its original WebM. Preserving it; source review is required.' }
  Invoke-Checked $NodeExe @($LandingScript)
 }
 # Use the final six seconds: the existing script holds the genuine settled page for six seconds.
 # This excludes startup/loading frames from the validation clip without inventing any UI.
 $LandingVerified=Join-Path $RunPath 'landing-verified-1080p.mp4'
 Invoke-Checked $FfmpegExe @('-v','error','-threads','1','-sseof','-6','-i',$LandingWebm,'-t','6','-vf','fps=30,scale=1920:1080:flags=lanczos',
  '-an','-c:v','libx264','-threads','1','-filter_threads','1','-preset','ultrafast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart','-n',$LandingVerified)
 $LandingInfo=Assert-Video $LandingVerified 6
 $LandingInfo | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $RunPath 'landing-ffprobe.json') -Encoding UTF8
 Write-Host "REAL LANDING MP4 VERIFIED: $LandingVerified"
 if ($LandingOnly) { return }
 Invoke-Checked $NodeExe @($ProductScript,$RunPath)
 $Capture=Get-Content -LiteralPath (Join-Path $RunPath 'capture.json') -Raw | ConvertFrom-Json
 if (-not $Capture.complete) { throw 'Full case capture did not complete. Raw footage preserved; no fabricated rough cut will be assembled.' }
 if (-not $Capture.browserClosed) { throw 'Recording browser shutdown was not confirmed. Narration and encoding will not overlap a live recording browser.' }
 Invoke-Checked $PythonExe @($AssemblerScript,$RunPath,'--prepare-audio')
 Add-Type -AssemblyName System.Speech
 $Synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
 try {
  $Voices=@($Synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguage -eq 'en' })
  if ($Voices.Count -eq 0) { throw 'No installed offline English voice. Product footage is preserved; no online TTS fallback or installation will be used.' }
  $Chosen=@($Voices | Where-Object { $_.VoiceInfo.Name -like '*Zira*' })
  if ($Chosen.Count -eq 0) { $Chosen=@($Voices[0]) }
  $Synth.SelectVoice($Chosen[0].VoiceInfo.Name);$Synth.Rate=0;$Synth.Volume=100
  $Tasks=Get-Content -LiteralPath (Join-Path $RunPath 'tts-tasks.json') -Raw | ConvertFrom-Json
  foreach ($Task in $Tasks) {
   $WavPath=[IO.Path]::GetFullPath([string]$Task.wav)
   if (-not $WavPath.StartsWith($RunPath+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Narration path escaped this recording run.' }
   if (Test-Path -LiteralPath $WavPath) { throw 'Preserving existing narration file.' }
   $Synth.SetOutputToWaveFile($WavPath);$Synth.Speak([string]$Task.text);$Synth.SetOutputToNull()
   $Audio=Get-MediaInfo $WavPath
   if ([double]$Audio.format.duration -le 0.25) { throw 'Local speech output was empty or too short.' }
  }
  Write-Host ('OFFLINE NARRATION CREATED: '+$Chosen[0].VoiceInfo.Name)
 } finally { $Synth.Dispose();$Synth=$null;[GC]::Collect();[GC]::WaitForPendingFinalizers() }
 Invoke-Checked $PythonExe @($AssemblerScript,$RunPath)
 $null=Assert-Video (Join-Path $VideoRoot 'final\OrderTruth-Final-Demo.mp4') 162
 Write-Host "COMPLETE: $VideoRoot\final\OrderTruth-Final-Demo.mp4"
 Write-Host "SUBTITLES: $VideoRoot\final\OrderTruth-Final-Demo.srt"
 Write-Host "VALIDATION: $VideoRoot\final\OrderTruth-Final-Demo.ffprobe.json"
 Write-Host "ROUGH CUT: $RunPath\OrderTruth-Rough-Cut.mp4"
 Write-Host 'Technical validation is complete. Watch the film for visual fit and subjective voice quality before publication.'
} catch {
 $Failure=[ordered]@{status='STOPPED';reason=$_.Exception.Message;runDirectory=$RunPath;at=(Get-Date).ToString('o');automaticReplay=$false}
 $Failure | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunPath 'STOPPED.json') -Encoding UTF8
 Write-Error ("Production stopped safely. Existing recordings and assets preserved. "+$_.Exception.Message)
 exit 1
}
