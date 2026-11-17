# Runs INSIDE Windows Sandbox (networking disabled). Never run on the host.
$ErrorActionPreference = 'Continue'
$Out  = 'C:\cap\out'
$Node = 'C:\cap\node\node.exe'
$Droid = 'C:\cap\bin\droid.exe'
$Fake = 'C:\cap\scripts\fake-anthropic.js'
"start $(Get-Date -Format o)" | Set-Content "$Out\run.log"
function Log($m) { "$(Get-Date -Format o) $m" | Add-Content "$Out\run.log" }
function WriteJson($path) { process { [IO.File]::WriteAllText($path, $_, (New-Object Text.UTF8Encoding($false))) } }

# Confirm the network really is off.
try { $r = Invoke-WebRequest -Uri 'https://example.com' -TimeoutSec 8 -UseBasicParsing; Log "NETWORK REACHABLE status=$($r.StatusCode)" } catch { Log "network check: unreachable ($($_.Exception.Message))" }

function Run-Droid($name, $hdir, $argv, $timeoutSec) {
  $o = Join-Path $Out "$name.stdout.txt"; $e = Join-Path $Out "$name.stderr.txt"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Droid; $psi.WorkingDirectory = $hdir; $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.Arguments = (($argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  foreach ($k in @('FACTORY_HOME_OVERRIDE','FACTORY_AIRGAP_ENABLED','FACTORY_DISABLE_KEYRING','FACTORY_DROID_AUTO_UPDATE_ENABLED','OTEL_SDK_DISABLED','FACTORY_FEATURE_FLAGS_SNAPSHOT_PATH')) { $v = [Environment]::GetEnvironmentVariable($k); if ($v) { $psi.EnvironmentVariables[$k] = $v } elseif ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) } }
  Log "$name args: $($psi.Arguments)"
  $Error.Clear()
  try { $p = [System.Diagnostics.Process]::Start($psi) } catch { Log "$name START FAILED: $($_.Exception.ToString() -replace '\s+',' ')"; return '' }
  $p.StandardInput.Close()
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutSec * 1000)) { Log "$name TIMEOUT, killing"; try { $p.Kill() } catch {}; $code = 'timeout' } else { $p.WaitForExit(); $code = $p.ExitCode }
  try { [void]$so.Wait(5000); [void]$se.Wait(5000) } catch {}
  $sot = if ($so.IsCompleted) { $so.Result } else { '' }; $set = if ($se.IsCompleted) { $se.Result } else { '' }
  [IO.File]::WriteAllText($o, $sot); [IO.File]::WriteAllText($e, $set)
  Log "$name exit=$code stdout=$($sot.Length) stderr=$($set.Length)"
  return $sot
}

function Scenario($name, $settings, $snapshot, [scriptblock]$body) {
  Log "=== scenario $name"
  $hdir = "C:\cap\work\$name"; New-Item -ItemType Directory -Force "$hdir\.factory" | Out-Null
  $settings | ConvertTo-Json -Depth 10 | WriteJson "$hdir\.factory\settings.json"
  $reqDir = Join-Path $Out "$name-requests"
  $srv = Start-Process -FilePath $Node -ArgumentList @($Fake, '18080', $reqDir) -RedirectStandardOutput "$Out\$name.server.out.txt" -RedirectStandardError "$Out\$name.server.err.txt" -NoNewWindow -PassThru
  Start-Sleep -Seconds 2
  $env:FACTORY_HOME_OVERRIDE = $hdir
  $env:FACTORY_AIRGAP_ENABLED = '1'
  $env:FACTORY_DISABLE_KEYRING = '1'
  $env:FACTORY_DROID_AUTO_UPDATE_ENABLED = 'false'
  $env:OTEL_SDK_DISABLED = 'true'
  if ($snapshot) { $sp = "$hdir\snapshot.json"; $snapshot | ConvertTo-Json -Depth 10 | WriteJson $sp; $env:FACTORY_FEATURE_FLAGS_SNAPSHOT_PATH = $sp } else { Remove-Item Env:FACTORY_FEATURE_FLAGS_SNAPSHOT_PATH -ErrorAction SilentlyContinue }
  & $body $hdir
  try { Stop-Process -Id $srv.Id -Force } catch {}
}

$model = @{ model = 'fake-model'; displayName = 'mock'; provider = 'anthropic'; baseUrl = 'http://127.0.0.1:18080'; apiKey = 'local-mock-not-a-secret'; maxContextLimit = 200000 }
$ids = @('custom:mock-0','custom:mock','fake-model')

# Diagnostics: CPU features and a plain version call
$item = Get-Item $Droid -ErrorAction SilentlyContinue; Log "droid exists=$([bool]$item) size=$($item.Length)"
try { Copy-Item $Droid 'C:\cap\droid.exe' -ErrorAction Stop; $Droid = 'C:\cap\droid.exe'; Log 'copied droid.exe to local disk' } catch { Log "copy failed: $($_.Exception.Message)" }
try { $o = & cmd /c """$Droid"" --version 2>&1"; Log "cmd --version rc=$LASTEXITCODE out=$($o -join ' | ')" } catch { Log "cmd run failed: $($_.Exception.Message)" }
Log ("cpu: " + (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name))
New-Item -ItemType Directory -Force 'C:\cap\work' | Out-Null
$null = Run-Droid 'version' 'C:\cap\work' @('--version') 30
$null = Run-Droid 'help-exec' 'C:\cap\work' @('exec','--help') 30

# A: airgap defaults (expected direct tool mode)
Scenario 'A' @{ customModels = @($model) } $null { param($h) $null = Run-Droid 'A' $h @('exec','-m','custom:mock-0','-o','json','say hi') 180 }

# B: snapshot puts the model on the script-tool list (expected Script mode)
Scenario 'B' @{ customModels = @($model) } @{ flags = @{}; configs = @{ script_tool_models = @{ models = $ids } } } { param($h) $null = Run-Droid 'B' $h @('exec','-m','custom:mock-0','-o','json','say hi') 180 }

# C: tiny compaction limit, two turns in one session to trigger a compaction request
Scenario 'C' @{ customModels = @($model); compactionTokenLimit = 1000 } $null {
  param($h)
  $o = Run-Droid 'C1' $h @('exec','-m','custom:mock-0','-o','json','say hi') 180
  $sid = $null
  if ($o -match '"session_?[iI]d"\s*:\s*"([^"]+)"') { $sid = $Matches[1] }
  Log "C session id: $sid"
  if ($sid) { $null = Run-Droid 'C2' $h @('exec','-m','custom:mock-0','-o','json','-s',$sid,'say hi again') 180 }
}

try { Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2} -MaxEvents 10 -ErrorAction Stop | ForEach-Object { Log ("event: " + $_.ProviderName + ' ' + ($_.Message -replace '\s+',' ').Substring(0, [Math]::Min(400, $_.Message.Length))) } } catch { Log 'no app error events' }
Log 'DONE'
'done' | Set-Content "$Out\DONE"
shutdown /s /t 5
