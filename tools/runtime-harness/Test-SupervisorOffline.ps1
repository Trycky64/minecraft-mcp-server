[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot 'Supervisor.Core.psm1'
Import-Module -Name $modulePath -Force
if (-not ('ProcessiaHarnessNativeSecurity' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ProcessiaHarnessNativeSecurity {
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint securityInformation,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,
    uint revision, uint securityInformation, out IntPtr output, out uint outputLength);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
  public static string GetSddl(SafePipeHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor, output; uint length;
    uint result = GetSecurityInfo(handle.DangerousGetHandle(), 1, 0x5, out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new System.ComponentModel.Win32Exception((int)result);
    try {
      if (!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 0x5, out output, out length))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try { return Marshal.PtrToStringUni(output); } finally { LocalFree(output); }
    } finally { LocalFree(descriptor); }
  }
}
'@
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('processia-runtime-harness-m29-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$passed = 0
$checks = [Collections.Generic.List[string]]::new()

function Assert-That([bool]$Condition, [string]$Name) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Name" }
  $script:passed++
  $script:checks.Add($Name)
}
function Assert-Throws([scriptblock]$Action, [string]$Expected, [string]$Name) {
  try { & $Action; throw "ASSERTION FAILED: expected $Expected" }
  catch { if ($_.Exception.Message -notlike "*$Expected*") { throw }; $script:passed++; $script:checks.Add($Name) }
}
function Wait-File([string]$Path, [int]$Seconds = 10) {
  $limit = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $limit) { if (Test-Path -LiteralPath $Path) { return }; Start-Sleep -Milliseconds 50 }
  throw "fake-process-readiness-timeout:$([IO.Path]::GetFileName($Path))"
}
function Quote-ProcessArgument([string]$Value) { '"' + $Value.Replace('"','\"') + '"' }
function Start-FakeProcess([string]$Script, [string[]]$Arguments, [switch]$CleanEnvironment, [string]$WorkingDirectory) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = Join-Path $PSHOME 'powershell.exe'
  $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-ProcessArgument $Script) + ' ' + (($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
  $info.UseShellExecute = $false; $info.RedirectStandardInput = $true
  if ($WorkingDirectory) { $info.WorkingDirectory = $WorkingDirectory }
  $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
  if ($CleanEnvironment) { Start-HarnessProcessWithCleanEnvironment -Process $process | Out-Null }
  elseif (-not $process.Start()) { throw 'fake-process-start-failed' }
  return $process
}

$workerPath = Join-Path $testRoot 'fake-worker.ps1'
$worker = @'
param([string]$ReadyPath, [string]$ReleasePath, [int]$DelayMs, [string]$CapturePath, [string]$IgnoreStop)
$inheritedTestSecret = [Environment]::GetEnvironmentVariable('PROCESSIA_MISSION29_SYNTHETIC_SECRET', 'Process')
if ($CapturePath) { [IO.File]::WriteAllText($CapturePath, [string]$inheritedTestSecret) }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
[IO.File]::WriteAllText($ReadyPath, "$PID`n$port")
if ($IgnoreStop -eq 'true') {
  $null = [Console]::ReadLine()
  while (-not (Test-Path -LiteralPath $ReleasePath)) { Start-Sleep -Milliseconds 50 }
} else {
  $line = [Console]::ReadLine()
  if ($line -ceq 'stop') { Start-Sleep -Milliseconds $DelayMs }
}
$listener.Stop()
'@
[IO.File]::WriteAllText($workerPath, $worker, [Text.UTF8Encoding]::new($false))

$childPath = Join-Path $testRoot 'fake-child.ps1'
$child = @'
param([string]$ReadyPath, [string]$ReleasePath)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
[IO.File]::WriteAllText($ReadyPath, "$PID`n$port")
while (-not (Test-Path -LiteralPath $ReleasePath)) { Start-Sleep -Milliseconds 50 }
$listener.Stop()
'@
[IO.File]::WriteAllText($childPath, $child, [Text.UTF8Encoding]::new($false))
$parentPath = Join-Path $testRoot 'fake-parent.ps1'
$parent = @'
param([string]$ChildScript, [string]$ReadyPath, [string]$ReleasePath, [string]$ChildPidPath)
$powershell = Join-Path $PSHOME 'powershell.exe'
$childArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $ChildScript + '" "' + $ReadyPath + '" "' + $ReleasePath + '"'
$child = Start-Process -FilePath $powershell -ArgumentList $childArguments -PassThru -WindowStyle Hidden
[IO.File]::WriteAllText($ChildPidPath, [string]$child.Id)
'@
[IO.File]::WriteAllText($parentPath, $parent, [Text.UTF8Encoding]::new($false))

$processesToCleanup = [Collections.Generic.List[Diagnostics.Process]]::new()
$pipesToCleanup = [Collections.Generic.List[IDisposable]]::new()
$childIdentity = $null
$childRelease = $null
$ignoredRelease = $null
try {
  # Pure target, path, identity and port policy checks.
  $portPolicy = Test-HarnessPortPolicy -HostName '127.0.0.1' -MinecraftPort 26001 -BridgePort 26002 -GuiPort 26003
  Assert-That $portPolicy.valid 'explicit loopback ports accepted'
  Assert-That ((Test-HarnessPortPolicy -HostName '0.0.0.0' -MinecraftPort 26001).errors -contains 'loopback-only-required') 'non-loopback refused'
  Assert-That ((Test-HarnessPortPolicy -HostName '127.0.0.1' -MinecraftPort $null).errors -contains 'minecraft-port-required') 'missing port refused'
  Assert-That ((Test-HarnessPortPolicy -HostName '127.0.0.1' -MinecraftPort 25565).errors -contains 'personal-server-port-forbidden') 'forbidden port refused without socket access'
  Assert-That ((Test-HarnessPortPolicy -HostName '127.0.0.1' -MinecraftPort 26001 -BridgePort 26001).errors -contains 'service-port-collision') 'colliding service ports refused'
  Assert-That ((Test-HarnessPortPolicy -HostName '127.0.0.1' -MinecraftPort 26001 -OccupiedPorts @(26001)).errors -contains 'minecraft-port-occupied') 'occupied port refused'
  $sub = Join-Path $testRoot 'root\runs\one'; New-Item -ItemType Directory -Path $sub -Force | Out-Null
  Assert-That (Test-HarnessPathWithin -Parent (Join-Path $testRoot 'root') -Child $sub) 'child path accepted'
  Assert-That (-not (Test-HarnessPathWithin -Parent (Join-Path $testRoot 'root') -Child (Join-Path $testRoot 'root-sibling\x'))) 'prefix sibling refused'

  # Template manifest has a separately supplied trust digest and an exhaustive file inventory.
  $template = Join-Path $testRoot 'template'; New-Item -ItemType Directory -Path $template | Out-Null
  $serverFile = Join-Path $template 'server.jar'; [IO.File]::WriteAllText($serverFile, 'synthetic-server-fixture')
  $eulaFile = Join-Path $template 'eula.txt'; [IO.File]::WriteAllText($eulaFile, 'eula=true')
  $manifest = [ordered]@{ schemaVersion = 1; profile = 'vanilla'; minecraftVersion = '1.21.1'; mods = @(); files = @(
    @{ path = 'server.jar'; sha256 = (Get-FileHash $serverFile -Algorithm SHA256).Hash },
    @{ path = 'eula.txt'; sha256 = (Get-FileHash $eulaFile -Algorithm SHA256).Hash }
  ) }
  $manifestFile = Join-Path $template 'harness-template.json'; [IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json -Depth 8))
  $manifestHash = (Get-FileHash $manifestFile -Algorithm SHA256).Hash
  Assert-That (Assert-HarnessTemplateIntegrity -TemplateDirectory $template -Manifest (Get-Content $manifestFile -Raw | ConvertFrom-Json) -ApprovedManifestSha256 $manifestHash) 'complete hashed template accepted'
  Assert-Throws { Assert-HarnessTemplateIntegrity -TemplateDirectory $template -Manifest (Get-Content $manifestFile -Raw | ConvertFrom-Json) -ApprovedManifestSha256 ('0' * 64) } 'template-manifest-digest-mismatch' 'tampered trust digest refused'
  $validManifestText = [IO.File]::ReadAllText($manifestFile)
  [IO.File]::WriteAllText($manifestFile, $validManifestText + ' ')
  Assert-Throws { Assert-HarnessTemplateIntegrity -TemplateDirectory $template -Manifest (Get-Content $manifestFile -Raw | ConvertFrom-Json) -ApprovedManifestSha256 $manifestHash } 'template-manifest-digest-mismatch' 'modified manifest rejected against external approval hash'
  [IO.File]::WriteAllText($manifestFile, $validManifestText)
  $traversalManifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
  $traversalManifest.files[0].path = '../outside.jar'
  Assert-Throws { Assert-HarnessTemplateIntegrity -TemplateDirectory $template -Manifest $traversalManifest -ApprovedManifestSha256 $manifestHash } 'template-file-manifest-path-invalid' 'path traversal manifest entry refused'
  $incompleteManifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
  $incompleteManifest.files = @()
  Assert-Throws { Assert-HarnessTemplateIntegrity -TemplateDirectory $template -Manifest $incompleteManifest -ApprovedManifestSha256 $manifestHash } 'template-file-manifest-incomplete' 'incomplete manifest refused'
  $extra = Join-Path $template 'extra.exe'; [IO.File]::WriteAllText($extra, 'synthetic')
  Assert-Throws { Assert-HarnessTemplateIntegrity -TemplateDirectory $template -Manifest (Get-Content $manifestFile -Raw | ConvertFrom-Json) -ApprovedManifestSha256 $manifestHash } 'template-contains-undeclared-files' 'undeclared executable refused'
  Remove-Item -LiteralPath $extra
  $startScriptPath = Join-Path $PSScriptRoot 'Start-TestProfile.ps1'
  Assert-Throws { & $startScriptPath -Profile vanilla -HarnessRoot $testRoot -TemplateDirectory $template -ApprovedManifestSha256 $manifestHash -MinecraftPort 26004 -AuthorizeStart:$false } 'server-start-disabled' 'production launcher refuses without explicit authorization before run preparation'

  # Synthetic log payloads exercise redaction, controls and line bounding.
  $log = ConvertTo-SafeHarnessLogLine 'Authorization: synthetic-auth Bearer synthetic-bearer secret=synthetic-secret'
  Assert-That ($log -notmatch 'synthetic-auth|synthetic-bearer|synthetic-secret') 'authorization and secret values redacted'
  Assert-That ((ConvertTo-SafeHarnessLogLine 'https://user:synthetic-password@example.invalid/path') -notmatch 'synthetic-password') 'URL credentials redacted'
  Assert-That ((ConvertTo-SafeHarnessLogLine '{"message":"synthetic private chat"}') -ceq '[CHAT REDACTED]') 'structured chat redacted'
  Assert-That ((ConvertTo-SafeHarnessLogLine ("line`0with" + [char]0x1f + 'controls')).Length -le 30) 'control characters removed'
  Assert-That ((ConvertTo-SafeHarnessLogLine ('x' * 6000)).Length -le 4108) 'long log line bounded'
  $stdoutLog = Join-Path $testRoot 'fake.stdout.log'; $stderrLog = Join-Path $testRoot 'fake.stderr.log'
  Assert-That (Write-SafeHarnessLogLine -Path $stdoutLog -Line 'stdout Authorization: synthetic-one') 'stdout callback writes sanitized line'
  Assert-That (Write-SafeHarnessLogLine -Path $stderrLog -Line 'stderr password=synthetic-two') 'stderr callback writes sanitized line'
  $combinedLogs = [IO.File]::ReadAllText($stdoutLog) + [IO.File]::ReadAllText($stderrLog)
  Assert-That ($combinedLogs -notmatch 'synthetic-one|synthetic-two' -and $combinedLogs -match '\[REDACTED\]') 'stdout and stderr log content contains no synthetic credentials'
  $continuedLog = Join-Path $testRoot 'split-credential.log'; $continuedState = New-HarnessLogState
  Write-SafeHarnessLogLine -Path $continuedLog -Line 'Authorization:' -State $continuedState | Out-Null
  Write-SafeHarnessLogLine -Path $continuedLog -Line 'synthetic-split-secret' -State $continuedState | Out-Null
  Assert-That ([IO.File]::ReadAllText($continuedLog) -notmatch 'synthetic-split-secret') 'credential value split across output lines is redacted'
  $outputProbe = Join-Path $testRoot 'fake-output.ps1'
  [IO.File]::WriteAllText($outputProbe, "[Console]::Out.WriteLine('Authorization:')`r`n[Console]::Out.WriteLine('synthetic-output-continuation')`r`n[Console]::Error.WriteLine('password=synthetic-stderr-password')", [Text.UTF8Encoding]::new($false))
  $outputInfo = [Diagnostics.ProcessStartInfo]::new(); $outputInfo.FileName = Join-Path $PSHOME 'powershell.exe'
  $outputInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-ProcessArgument $outputProbe)
  $outputInfo.UseShellExecute = $false; $outputInfo.RedirectStandardOutput = $true; $outputInfo.RedirectStandardError = $true
  $outputProcess = [Diagnostics.Process]::new(); $outputProcess.StartInfo = $outputInfo
  $actualStdoutLog = Join-Path $testRoot 'actual.stdout.log'; $actualStderrLog = Join-Path $testRoot 'actual.stderr.log'
  if (-not $outputProcess.Start()) { throw 'fake-output-process-start-failed' }
  $processesToCleanup.Add($outputProcess)
  $actualStdoutPump = New-HarnessSafeLogPump -Reader $outputProcess.StandardOutput -Path $actualStdoutLog
  $actualStderrPump = New-HarnessSafeLogPump -Reader $outputProcess.StandardError -Path $actualStderrLog
  $actualStdoutPump.Start(); $actualStderrPump.Start()
  if (-not $outputProcess.WaitForExit(10000)) { throw 'fake-output-process-timeout' }
  $outputProcess.WaitForExit()
  Assert-That ($actualStdoutPump.Join(5000) -and $actualStderrPump.Join(5000) -and -not $actualStdoutPump.FailureCode -and -not $actualStderrPump.FailureCode) 'real redirected stdout/stderr streams fully drained'
  $actualLogs = [IO.File]::ReadAllText($actualStdoutLog) + [IO.File]::ReadAllText($actualStderrLog)
  Assert-That ($actualLogs -notmatch 'synthetic-output-continuation|synthetic-stderr-password' -and $actualLogs -match 'CREDENTIAL CONTINUATION REDACTED') 'real stdout/stderr data callbacks redact split sensitive output'
  Assert-That (-not (Write-SafeHarnessLogLine -Path (Join-Path $testRoot 'missing\cannot.log') -Line 'synthetic-three')) 'log callback failure reported without throwing'

  # Actual Windows PowerShell child process: acceptance is not treated as exit confirmation.
  $ready = Join-Path $testRoot 'ready-normal.txt'; $release = Join-Path $testRoot 'release-normal.txt'
  $fake = Start-FakeProcess $workerPath @($ready,$release,'1200')
  $processesToCleanup.Add($fake); Wait-File $ready
  $readyLines = Get-Content -LiteralPath $ready; $fakePid = [int]$readyLines[0]; $fakePort = [int]$readyLines[1]
  $fakeIdentity = Get-HarnessProcessIdentity -ProcessId $fakePid
  Assert-That ($null -ne $fakeIdentity -and (Test-HarnessProcessIdentity $fakeIdentity)) 'real fake-process identity verified'
  Assert-That ((Test-HarnessStopRequest -Request "stop:$($fakeIdentity.runId)" -RunId 'other-run' -ExpectedProcess $fakeIdentity) -ceq 'refused-invalid-run') 'stop protocol binds request to expected run ID'
  $mismatchedIdentity = [pscustomobject]@{ pid=$fakeIdentity.pid; startedAt=$fakeIdentity.startedAt; executablePath=$fakeIdentity.executablePath; commandLine=$fakeIdentity.commandLine + ' changed' }
  Assert-That ((Test-HarnessStopRequest -Request 'stop:expected-run' -RunId 'expected-run' -ExpectedProcess $mismatchedIdentity) -ceq 'refused-process-identity') 'modified process command line identity refused'
  $listener = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $fakePort -ErrorAction SilentlyContinue)
  Assert-That ($listener.Count -gt 0 -and [int]$listener[0].OwningProcess -eq $fakePid) 'ephemeral listener ownership verified by PID'
  Assert-That (Test-HarnessListenerOwnedByIdentity -ExpectedProcess $fakeIdentity -Port $fakePort) 'listener accepted only for exact managed process identity'
  $changedCommandLine = [pscustomobject]@{ pid=$fakeIdentity.pid; startedAt=$fakeIdentity.startedAt; executablePath=$fakeIdentity.executablePath; commandLine=$fakeIdentity.commandLine + ' changed' }
  Assert-That (-not (Test-HarnessListenerOwnedByIdentity -ExpectedProcess $changedCommandLine -Port $fakePort)) 'stale or mismatched listener identity refused'
  Assert-That ((Test-HarnessStopRequest -Request 'stop:wrong-run' -RunId 'expected-run' -ExpectedProcess $fakeIdentity) -ceq 'refused-invalid-run') 'wrong run ID refused'
  $timer = [Diagnostics.Stopwatch]::StartNew(); $fake.StandardInput.WriteLine('stop'); $fake.StandardInput.Flush()
  Start-Sleep -Milliseconds 150
  Assert-That ((Test-HarnessProcessIdentity $fakeIdentity) -and $timer.ElapsedMilliseconds -lt 1000) 'stop request acceptance window is not exit confirmation'
  Assert-That ($fake.WaitForExit(10000)) 'graceful fake process stop completed'
  $remaining = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $fakePort -ErrorAction SilentlyContinue)
  Assert-That ($remaining.Count -eq 0) 'listener closed after graceful process exit'

  $secretCapture = Join-Path $testRoot 'child-environment-secret.txt'; $envName = 'PROCESSIA_MISSION29_SYNTHETIC_SECRET'
  [Environment]::SetEnvironmentVariable($envName, 'synthetic-parent-only-secret', 'Process')
  $cleanReady = Join-Path $testRoot 'ready-clean-env.txt'; $cleanRelease = Join-Path $testRoot 'release-clean-env.txt'
  $clean = Start-FakeProcess $workerPath @($cleanReady,$cleanRelease,'0',$secretCapture) -CleanEnvironment
  $processesToCleanup.Add($clean); Wait-File $cleanReady
  $capturedSecret = [IO.File]::ReadAllText($secretCapture)
  Assert-That ($capturedSecret.Length -eq 0) ("credential-like environment not inherited by fake child (captured-length={0})" -f $capturedSecret.Length)
  Assert-That ([Environment]::GetEnvironmentVariable($envName,'Process') -ceq 'synthetic-parent-only-secret') 'parent environment restored after successful start'
  $clean.StandardInput.WriteLine('stop'); $clean.StandardInput.Flush()
  Assert-That ($clean.WaitForExit(10000)) 'clean-environment child stopped gracefully'
  $failedInfo = [Diagnostics.ProcessStartInfo]::new(); $failedInfo.FileName = Join-Path $testRoot 'missing-executable.exe'; $failedInfo.UseShellExecute = $false
  $failedStart = [Diagnostics.Process]::new(); $failedStart.StartInfo = $failedInfo
  $failureObserved = $false
  try { Start-HarnessProcessWithCleanEnvironment -Process $failedStart | Out-Null } catch { $failureObserved = $true }
  Assert-That ($failureObserved -and [Environment]::GetEnvironmentVariable($envName,'Process') -ceq 'synthetic-parent-only-secret') 'parent environment restored after start failure'
  $failedStart.Dispose()
  [Environment]::SetEnvironmentVariable($envName, $null, 'Process')

  # A fake server that ignores the graceful command remains managed until its own watchdog releases it.
  $ignoredReady = Join-Path $testRoot 'ready-ignored.txt'; $ignoredRelease = Join-Path $testRoot 'release-ignored.txt'
  $ignored = Start-FakeProcess $workerPath @($ignoredReady,$ignoredRelease,'0','','true')
  $processesToCleanup.Add($ignored); Wait-File $ignoredReady
  $ignoredLines = Get-Content -LiteralPath $ignoredReady; $ignoredPid = [int]$ignoredLines[0]; $ignoredPort = [int]$ignoredLines[1]
  $ignoredIdentity = Get-HarnessProcessIdentity -ProcessId $ignoredPid
  $pipeName = 'ProcessiaM29-' + [guid]::NewGuid().ToString('N')
  $pipe = New-OwnerOnlyNamedPipe -Name $pipeName
  $pipesToCleanup.Add($pipe)
  $client = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut)
  $pipesToCleanup.Add($client)
  $pipeWait = $pipe.WaitForConnectionAsync(); $client.Connect(3000); $pipeWait.Wait(3000) | Out-Null
  $serverReader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 1024, $true)
  $serverWriter = [IO.StreamWriter]::new($pipe, [Text.Encoding]::UTF8, 1024, $true); $serverWriter.AutoFlush = $true
  $clientReader = [IO.StreamReader]::new($client, [Text.Encoding]::UTF8, $false, 1024, $true)
  $clientWriter = [IO.StreamWriter]::new($client, [Text.Encoding]::UTF8, 1024, $true); $clientWriter.AutoFlush = $true
  $clientWriter.WriteLine('stop:wrong-run'); $request = $serverReader.ReadLine()
  $serverWriter.WriteLine((Test-HarnessStopRequest -Request $request -RunId 'expected-run' -ExpectedProcess $ignoredIdentity))
  Assert-That ($clientReader.ReadLine() -ceq 'refused-invalid-run') 'pipe request for different run refused'
  $client.Dispose(); $pipe.Dispose()

  $pipeName = 'ProcessiaM29-' + [guid]::NewGuid().ToString('N')
  $pipe = New-OwnerOnlyNamedPipe -Name $pipeName
  $pipesToCleanup.Add($pipe)
  $client = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut)
  $pipesToCleanup.Add($client)
  $pipeWait = $pipe.WaitForConnectionAsync(); $client.Connect(3000); $pipeWait.Wait(3000) | Out-Null
  $serverReader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 1024, $true)
  $serverWriter = [IO.StreamWriter]::new($pipe, [Text.Encoding]::UTF8, 1024, $true); $serverWriter.AutoFlush = $true
  $clientReader = [IO.StreamReader]::new($client, [Text.Encoding]::UTF8, $false, 1024, $true)
  $clientWriter = [IO.StreamWriter]::new($client, [Text.Encoding]::UTF8, 1024, $true); $clientWriter.AutoFlush = $true
  $clientWriter.WriteLine('stop:expected-run'); $request = $serverReader.ReadLine()
  $decision = Test-HarnessStopRequest -Request $request -RunId 'expected-run' -ExpectedProcess $ignoredIdentity
  $serverWriter.WriteLine($decision)
  Assert-That ($clientReader.ReadLine() -ceq 'accepted') 'authenticated pipe stop accepted for exact live process'
  $ignored.StandardInput.WriteLine('stop'); $ignored.StandardInput.Flush(); Start-Sleep -Milliseconds 200
  Assert-That ((Test-HarnessProcessIdentity $ignoredIdentity) -and
    @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $ignoredPort -ErrorAction SilentlyContinue).Count -gt 0) 'ignored graceful stop remains unconfirmed and listener stays open'
  [IO.File]::WriteAllText($ignoredRelease, 'release')
  Assert-That ($ignored.WaitForExit(10000)) 'fake ignored stop exits only after test watchdog release'
  $client.Dispose(); $pipe.Dispose()

  # A parent exits while its real child and listener remain; parent exit alone is insufficient.
  $parentReady = Join-Path $testRoot 'ready-child.txt'; $childRelease = Join-Path $testRoot 'release-child.txt'; $childPidFile = Join-Path $testRoot 'child-pid.txt'
  $parentProc = Start-FakeProcess $parentPath @($childPath,$parentReady,$childRelease,$childPidFile)
  $processesToCleanup.Add($parentProc); Wait-File $childPidFile; Wait-File $parentReady
  if (-not $parentProc.WaitForExit(10000)) { throw 'fake-parent-did-not-exit' }
  $childLines = Get-Content -LiteralPath $parentReady; $childPid = [int]$childLines[0]; $childPort = [int]$childLines[1]
  $childIdentity = Get-HarnessProcessIdentity -ProcessId $childPid
  $parentIdentityAfterExit = Get-HarnessProcessIdentity -ProcessId $parentProc.Id
  Assert-That (($null -eq $parentIdentityAfterExit) -and (Test-HarnessProcessIdentity $childIdentity)) 'parent exit leaves independently identified child alive'
  $childListeners = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $childPort -ErrorAction SilentlyContinue)
  Assert-That ($childListeners.Count -gt 0 -and [int]$childListeners[0].OwningProcess -eq $childPid) 'child listener survives parent exit'
  [IO.File]::WriteAllText($childRelease, 'release')
  $childWait = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $childWait -and (Test-HarnessProcessIdentity $childIdentity)) { Start-Sleep -Milliseconds 50 }
  Assert-That (-not (Test-HarnessProcessIdentity $childIdentity)) 'child shutdown independently confirmed'
  Assert-That (@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $childPort -ErrorAction SilentlyContinue).Count -eq 0) 'child listener closure confirmed'

  # Exercise the production Stop-TestProfile script end-to-end against a fake direct child and isolated lease.
  $managedRoot = Join-Path $testRoot 'managed'; $managedRun = Join-Path $managedRoot 'runs\vanilla\fake-stop-run'
  New-Item -ItemType Directory -Path $managedRun -Force | Out-Null
  $managedReady = Join-Path $testRoot 'ready-managed-stop.txt'; $managedRelease = Join-Path $testRoot 'release-managed-stop.txt'
  $managedId = 'mission29-fake-run-' + [guid]::NewGuid().ToString('N')
  $managedPipeName = 'ProcessiaM29-' + [guid]::NewGuid().ToString('N')
  $managed = Start-FakeProcess $workerPath @($managedReady,$managedRelease,'400',$null,$managedRun) -WorkingDirectory $managedRun
  $processesToCleanup.Add($managed); Wait-File $managedReady
  $managedLines = Get-Content -LiteralPath $managedReady; $managedPid = [int]$managedLines[0]; $managedPort = [int]$managedLines[1]
  $managedIdentity = Get-HarnessProcessIdentity -ProcessId $managedPid
  $lease = [ordered]@{
    schemaVersion = 2; runId = $managedId; profile = 'vanilla'; pid = $managedPid
    startedAt = $managedIdentity.startedAt; executablePath = $managedIdentity.executablePath; commandLine = $managedIdentity.commandLine
    workingDirectory = $managedRun; minecraftHost = '127.0.0.1'; minecraftPort = $managedPort; bridgePort = $null
    pipeName = $managedPipeName; status = 'running'; stopRequested = $false; stopAcceptedAt = $null
    processExited = $false; listenerClosed = $false; exitCode = $null
  }
  $leasePath = Join-Path $managedRun 'runtime-harness-lease.json'
  [IO.File]::WriteAllText($leasePath, ($lease | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  $stopScriptPath = Join-Path $PSScriptRoot 'Stop-TestProfile.ps1'
  $mismatchedLease = [ordered]@{}
  foreach ($leaseKey in $lease.Keys) { $mismatchedLease[$leaseKey] = $lease[$leaseKey] }
  $mismatchedLease.commandLine += ' forged'
  [IO.File]::WriteAllText($leasePath, ($mismatchedLease | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  $mismatchInfo = [Diagnostics.ProcessStartInfo]::new()
  $mismatchInfo.FileName = Join-Path $PSHOME 'powershell.exe'; $mismatchInfo.UseShellExecute = $false; $mismatchInfo.RedirectStandardOutput = $true; $mismatchInfo.RedirectStandardError = $true
  $mismatchInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-ProcessArgument $stopScriptPath) + ' -HarnessRoot ' + (Quote-ProcessArgument $managedRoot) + ' -RunDirectory ' + (Quote-ProcessArgument $managedRun) + ' -TimeoutSeconds 3'
  $mismatchClient = [Diagnostics.Process]::new(); $mismatchClient.StartInfo = $mismatchInfo
  if (-not $mismatchClient.Start()) { throw 'mismatched-stop-client-start-failed' }
  $processesToCleanup.Add($mismatchClient)
  if (-not $mismatchClient.WaitForExit(5000)) { throw 'mismatched-stop-client-timeout' }
  $mismatchError = $mismatchClient.StandardError.ReadToEnd()
  Assert-That ($mismatchClient.ExitCode -ne 0 -and $mismatchError -match 'managed-process-identity-mismatch' -and (Test-HarnessProcessIdentity $managedIdentity)) 'production Stop refuses a forged process identity without affecting the live fake'
  [IO.File]::WriteAllText($leasePath, ($lease | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  $supervisorPipe = New-OwnerOnlyNamedPipe -Name $managedPipeName; $pipesToCleanup.Add($supervisorPipe)
  $connectTask = $supervisorPipe.WaitForConnectionAsync()
  $stopInfo = [Diagnostics.ProcessStartInfo]::new()
  $stopInfo.FileName = Join-Path $PSHOME 'powershell.exe'; $stopInfo.UseShellExecute = $false
  $stopInfo.RedirectStandardOutput = $true; $stopInfo.RedirectStandardError = $true
  $stopInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-ProcessArgument $stopScriptPath) +
    ' -HarnessRoot ' + (Quote-ProcessArgument $managedRoot) + ' -RunDirectory ' + (Quote-ProcessArgument $managedRun) + ' -TimeoutSeconds 10'
  $stopClient = [Diagnostics.Process]::new(); $stopClient.StartInfo = $stopInfo
  if (-not $stopClient.Start()) { throw 'production-stop-client-start-failed' }
  $processesToCleanup.Add($stopClient)
  if (-not $connectTask.Wait(5000)) { throw 'production-stop-client-did-not-connect-to-fake-supervisor' }
  $pipeReader = [IO.StreamReader]::new($supervisorPipe, [Text.Encoding]::UTF8, $false, 1024, $true)
  $pipeWriter = [IO.StreamWriter]::new($supervisorPipe, [Text.Encoding]::UTF8, 1024, $true); $pipeWriter.AutoFlush = $true
  $stopRequest = Read-HarnessPipeRequest -Reader $pipeReader -Writer $pipeWriter -TimeoutMilliseconds 5000
  Assert-That ($stopRequest.status -eq 'received' -and (Test-HarnessStopRequest -Request $stopRequest.request -RunId $managedId -ExpectedProcess $managedIdentity) -ceq 'accepted') 'production Stop script request authenticated to exact fake run'
  $lease.stopRequested = $true; $lease.stopAcceptedAt = [DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText($leasePath, ($lease | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  $pipeWriter.WriteLine('accepted')
  $managed.StandardInput.WriteLine('stop'); $managed.StandardInput.Flush()
  Assert-That ($managed.WaitForExit(5000)) 'production stop request ended fake process gracefully'
  $lease.processExited = $true; $lease.exitCode = $managed.ExitCode
  $lease.listenerClosed = (@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $managedPort -ErrorAction SilentlyContinue).Count -eq 0)
  $lease.status = if ($lease.listenerClosed) { 'stopped-confirmed' } else { 'stop-request-accepted-but-listener-remains-uncertain' }
  [IO.File]::WriteAllText($leasePath, ($lease | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  Assert-That ($stopClient.WaitForExit(10000) -and $stopClient.ExitCode -eq 0) ("production Stop script confirmed fake server shutdown: {0}" -f $stopClient.StandardOutput.ReadToEnd())
  Assert-That ((Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json).status -eq 'stopped-confirmed') 'fake lease terminal state records process and listener confirmation'

  # Owner SID and DACL are checked in the same security descriptor used to create the live pipe.
  $security = New-OwnerOnlyPipeSecurity
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $rules = @($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  Assert-That ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value) 'named-pipe owner SID is current user'
  Assert-That ($rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $security.AreAccessRulesProtected) 'named-pipe DACL is owner-only and protected'

  $pipeName = 'ProcessiaM29-' + [guid]::NewGuid().ToString('N')
  $pipe = New-OwnerOnlyNamedPipe -Name $pipeName; $pipesToCleanup.Add($pipe)
  $client = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut); $pipesToCleanup.Add($client)
  $pipeWait = $pipe.WaitForConnectionAsync(); $client.Connect(3000); $pipeWait.Wait(3000) | Out-Null
  $serverReader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 1024, $true)
  $serverWriter = [IO.StreamWriter]::new($pipe, [Text.Encoding]::UTF8, 1024, $true); $serverWriter.AutoFlush = $true
  $client.Dispose()
  Assert-That ((Read-HarnessPipeRequest -Reader $serverReader -Writer $serverWriter -TimeoutMilliseconds 500).status -eq 'disconnected') 'abandoned named-pipe client is treated as disconnected'
  $pipe.Dispose()

  $pipeName = 'ProcessiaM29-' + [guid]::NewGuid().ToString('N')
  $pipe = New-OwnerOnlyNamedPipe -Name $pipeName; $pipesToCleanup.Add($pipe)
  $client = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut); $pipesToCleanup.Add($client)
  $pipeWait = $pipe.WaitForConnectionAsync(); $client.Connect(3000); $pipeWait.Wait(3000) | Out-Null
  $serverReader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 1024, $true)
  $serverWriter = [IO.StreamWriter]::new($pipe, [Text.Encoding]::UTF8, 1024, $true); $serverWriter.AutoFlush = $true
  $clientReader = [IO.StreamReader]::new($client, [Text.Encoding]::UTF8, $false, 1024, $true)
  $timeoutRead = Read-HarnessPipeRequest -Reader $serverReader -Writer $serverWriter -TimeoutMilliseconds 100
  Assert-That ($timeoutRead.status -eq 'timeout' -and $clientReader.ReadLine() -ceq 'refused-timeout') 'blocked named-pipe request times out with explicit refusal'
  $client.Dispose(); $pipe.Dispose()

  $pipeName = 'ProcessiaM29-' + [guid]::NewGuid().ToString('N')
  $pipe = New-OwnerOnlyNamedPipe -Name $pipeName
  $client = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut)
  $wait = $pipe.WaitForConnectionAsync(); $client.Connect(3000); $wait.Wait(3000) | Out-Null
  Assert-That ($pipe.IsConnected -and $client.IsConnected) 'owner-only named pipe live connection works'
  $effectiveSddl = [ProcessiaHarnessNativeSecurity]::GetSddl($pipe.SafePipeHandle)
  $effectiveAllowRules = [regex]::Matches($effectiveSddl, '\(A;[^)]*\)')
  Assert-That ($effectiveSddl.Contains($sid.Value) -and $effectiveAllowRules.Count -eq 1 -and $effectiveSddl.Contains('D:P')) ("effective kernel pipe DACL is protected and grants only current SID: {0}" -f $effectiveSddl)
  $client.Dispose(); $pipe.Dispose()

  Write-Output ("PASS: {0} targeted assertions" -f $passed)
  foreach ($name in $checks) { Write-Output ("  - {0}" -f $name) }
} finally {
  if ($ignoredRelease -and (Test-Path -LiteralPath $ignoredRelease)) { [IO.File]::WriteAllText($ignoredRelease, 'release') }
  if ($childRelease -and $childIdentity -and (Test-HarnessProcessIdentity $childIdentity)) {
    [IO.File]::WriteAllText($childRelease, 'release')
    $childDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $childDeadline -and (Test-HarnessProcessIdentity $childIdentity)) { Start-Sleep -Milliseconds 50 }
    if (Test-HarnessProcessIdentity $childIdentity) { throw "tracked-fake-child-cleanup-timeout:$($childIdentity.pid)" }
  }
  foreach ($process in $processesToCleanup) {
    try {
      if (-not $process.HasExited) {
        try { $process.StandardInput.WriteLine('stop'); $process.StandardInput.Flush() } catch { }
        if (-not $process.WaitForExit(3000)) { throw "tracked-fake-process-cleanup-timeout:$($process.Id)" }
      }
    } finally { $process.Dispose() }
  }
  foreach ($pipeObject in $pipesToCleanup) { try { $pipeObject.Dispose() } catch { } }
  $expectedTempPrefix = Join-Path ([IO.Path]::GetTempPath()) 'processia-runtime-harness-m29-'
  $resolvedTemp = [IO.Path]::GetFullPath($testRoot).TrimEnd([char[]]@([char]92,[char]47))
  $parsedRunId = [guid]::Empty
  if ($resolvedTemp.StartsWith($expectedTempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      [guid]::TryParse([IO.Path]::GetFileName($resolvedTemp).Substring('processia-runtime-harness-m29-'.Length), [ref]$parsedRunId) -and
      (Test-Path -LiteralPath $resolvedTemp -PathType Container)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
  } else { throw 'refusing-to-clean-unverified-runtime-test-directory' }
}
