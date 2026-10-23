[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('vanilla', 'neoforge-third-party', 'processia-optional')][string]$Profile,
  [Parameter(Mandatory)][string]$HarnessRoot,
  [Parameter(Mandatory)][string]$TemplateDirectory,
  [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ApprovedManifestSha256,
  [Parameter(Mandatory)][int]$MinecraftPort,
  [int]$BridgePort,
  [ValidateRange(30, 600)][int]$StartupTimeoutSeconds = 180,
  [Parameter(Mandatory)][switch]$AuthorizeStart,
  [string]$ApprovedThirdPartyModId
)
$ErrorActionPreference = 'Stop'
$coreModule = Join-Path $PSScriptRoot 'Supervisor.Core.psm1'
Import-Module -Name $coreModule -Force

function Resolve-FullPath([string]$Value) { Resolve-HarnessPath -Path $Value }
function Test-ChildPath([string]$Parent, [string]$Child) {
  return Test-HarnessPathWithin -Parent $Parent -Child $Child
}
function Assert-Port([int]$Port, [string]$Name) {
  if ($Port -lt 1 -or $Port -gt 65535 -or $Port -eq 25565) { throw "$Name-port-invalid-or-forbidden" }
  $listener = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  $occupied = if ($listener.Count -gt 0) { @($Port) } else { @() }
  $check = Test-HarnessPortPolicy -HostName '127.0.0.1' -MinecraftPort $Port -OccupiedPorts $occupied
  if (-not $check.valid) { throw "$Name-port-refused:$($check.errors -join ',')" }
}
function New-OwnerOnlyPipe([string]$Name) {
  return New-OwnerOnlyNamedPipe -Name $Name
}
function Wait-PreservedManagedProcess([Diagnostics.Process]$ManagedProcess, [System.Collections.IDictionary]$Lease,
  [string]$LeaseFile, [int]$MinecraftPort, [string]$PipeName) {
  while (-not $ManagedProcess.HasExited) {
    $preservedPipe = $null
    try {
      $preservedPipe = New-OwnerOnlyPipe $PipeName
      $connection = $preservedPipe.WaitForConnectionAsync()
      while (-not $ManagedProcess.HasExited -and -not $connection.Wait(250)) { }
      if ($ManagedProcess.HasExited) { $preservedPipe.Dispose(); break }
      $reader = [IO.StreamReader]::new($preservedPipe, [Text.Encoding]::UTF8, $false, 1024, $true)
      $writer = [IO.StreamWriter]::new($preservedPipe, [Text.Encoding]::UTF8, 1024, $true); $writer.AutoFlush = $true
      $pipeRead = Read-HarnessPipeRequest -Reader $reader -Writer $writer -TimeoutMilliseconds 5000
      if ($pipeRead.status -eq 'received') {
        $expected = [pscustomobject]@{ pid=[int]$Lease.pid; startedAt=[string]$Lease.startedAt; executablePath=[string]$Lease.executablePath; commandLine=[string]$Lease.commandLine; workingDirectory=[string]$Lease.workingDirectory }
        $decision = Test-HarnessStopRequest -Request $pipeRead.request -RunId ([string]$Lease.runId) -ExpectedProcess $expected
        if ($decision -eq 'accepted' -and -not $ManagedProcess.HasExited) {
          $Lease.stopRequested = $true; $Lease.stopAcceptedAt = [DateTime]::UtcNow.ToString('o'); $Lease.status = 'running'
          [IO.File]::WriteAllText($LeaseFile, ($Lease | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
          $ManagedProcess.StandardInput.WriteLine('stop'); $ManagedProcess.StandardInput.Flush(); $writer.WriteLine('accepted')
        } else { $writer.WriteLine($decision) }
      } elseif ($pipeRead.status -eq 'disconnected') { $writer.WriteLine('refused-disconnected') }
      $reader.Dispose(); $writer.Dispose(); $preservedPipe.Dispose(); $preservedPipe = $null
    } catch { Start-Sleep -Milliseconds 500 }
    finally { if ($preservedPipe) { $preservedPipe.Dispose() } }
  }
  $ManagedProcess.WaitForExit(); $ManagedProcess.Refresh()
  $Lease.processExited = $true; $Lease.exitCode = $ManagedProcess.ExitCode
  $Lease.listenerClosed = -not [bool](Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $MinecraftPort -ErrorAction SilentlyContinue)
  if ($Lease.listenerClosed -and $Lease.stopRequested) { $Lease.status = 'stopped-confirmed' }
  elseif ($Lease.listenerClosed) { $Lease.status = 'supervisor-failure-stopped' }
  else { $Lease.status = 'stop-request-accepted-but-listener-remains-uncertain' }
  [IO.File]::WriteAllText($LeaseFile, ($Lease | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
}

if (-not $AuthorizeStart) { throw 'server-start-disabled: pass -AuthorizeStart only in a separately authorized runtime mission' }
if ($MinecraftPort -eq 25565) { throw 'personal-server-port-forbidden' }
Assert-Port $MinecraftPort 'minecraft'
if ($Profile -eq 'vanilla' -and $PSBoundParameters.ContainsKey('BridgePort')) { throw 'vanilla-profile-does-not-use-bridge-port' }
if ($Profile -ne 'vanilla') {
  if (-not $PSBoundParameters.ContainsKey('BridgePort')) { throw 'explicit-bridge-port-required' }
  Assert-Port $BridgePort 'bridge'
  if ($BridgePort -eq $MinecraftPort) { throw 'bridge-port-collides-with-minecraft' }
}
if ($Profile -eq 'neoforge-third-party' -and [string]::IsNullOrWhiteSpace($ApprovedThirdPartyModId)) { throw 'third-party-mod-approval-required' }
if ($Profile -eq 'neoforge-third-party' -and $ApprovedThirdPartyModId -match '(?i)^processia$') { throw 'processia-is-not-the-third-party-profile-mod' }
if ($Profile -ne 'vanilla') {
  throw 'neoforge-runbat-supervision-unproven: cmd.exe may exit while its Java child and listener remain; no modded profile is launched until a verified direct-Java or job-object supervisor is implemented'
}

$root = Resolve-FullPath $HarnessRoot
$template = Resolve-FullPath $TemplateDirectory
$repo = Resolve-FullPath (Join-Path $PSScriptRoot '..\..')
if (Test-ChildPath $repo $root -or (Test-ChildPath $root $repo) -or $root -eq $repo) { throw 'harness-root-must-be-disjoint-from-repository' }
if (-not (Test-ChildPath $root $template)) { throw 'template-must-be-staged-under-dedicated-harness-root' }
if (-not (Test-Path -LiteralPath $template -PathType Container)) { throw 'profile-template-not-found' }
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'harness-root-must-be-prepared-separately' }
$runsRoot = Join-Path $root 'runs'
New-Item -ItemType Directory -Path $runsRoot -Force | Out-Null
Resolve-HarnessPath -Path $runsRoot -RequireExists | Out-Null
$lockPath = Join-Path $runsRoot '.active.lock'
if (Test-Path -LiteralPath $lockPath) { Resolve-HarnessPath -Path $lockPath -RequireExists | Out-Null }
try { $runLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { throw 'another-profile-launcher-holds-the-harness-lock' }
try {
$terminalLeaseStates = @('stopped-confirmed','startup-failed','exited-without-stop-request','supervisor-failure-stopped')
$allLeases = @(Get-ChildItem -LiteralPath (Join-Path $root 'runs') -Filter 'runtime-harness-lease.json' -File -Recurse -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json })
$activeLeases = @($allLeases | Where-Object { $_.status -notin $terminalLeaseStates })
if ($activeLeases) { throw 'another-managed-profile-is-recorded-running' }
if (Get-ChildItem -LiteralPath $template -Force -Recurse | Where-Object { $_.Name -match '(?i)(^\.env($|\.)|credential|secret|token|server\.properties|usercache\.json|ops\.json|whitelist\.json|level\.dat)' }) {
  throw 'template-contains-private-or-world-specific-data'
}
$textExtensions = @('.json', '.toml', '.properties', '.cfg', '.conf', '.yaml', '.yml', '.txt', '.bat', '.sh', '.xml')
foreach ($textFile in (Get-ChildItem -LiteralPath $template -File -Recurse | Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() -and $_.Length -le 2MB })) {
  $text = [IO.File]::ReadAllText($textFile.FullName)
  if ($text -match '(?im)(secret|token|password|bearer|credential)\s*[:=]\s*["'']?(?!<|\[REDACTED\])[^\s"'';,]{16,}') { throw 'template-may-contain-credential-material' }
}
if (-not (Test-Path -LiteralPath (Join-Path $template 'eula.txt') -PathType Leaf) -or
    (Get-Content -LiteralPath (Join-Path $template 'eula.txt') -Raw).Trim() -ne 'eula=true') {
  throw 'explicit-eula-acceptance-required-in-new-template'
}
if (Test-Path -LiteralPath (Join-Path $template 'server.properties')) { throw 'template-must-not-carry-server-properties' }
if (Get-ChildItem -LiteralPath $template -Force -Recurse | Where-Object { $_.Name -eq 'level.dat' -or $_.Name -match '^(world|world_[^/\\]+)$' }) {
  throw 'template-contains-world-data'
}
$templateManifestPath = Join-Path $template 'harness-template.json'
if (-not (Test-Path -LiteralPath $templateManifestPath -PathType Leaf)) { throw 'template-manifest-required' }
$templateManifest = Get-Content -LiteralPath $templateManifestPath -Raw | ConvertFrom-Json
Assert-HarnessTemplateIntegrity -TemplateDirectory $template -Manifest $templateManifest -ApprovedManifestSha256 $ApprovedManifestSha256 | Out-Null
if ($templateManifest.schemaVersion -ne 1 -or $templateManifest.profile -ne $Profile -or $templateManifest.minecraftVersion -ne '1.21.1') { throw 'template-manifest-profile-or-version-mismatch' }
if ($Profile -eq 'vanilla' -and -not (Test-Path -LiteralPath (Join-Path $template 'server.jar') -PathType Leaf)) { throw 'vanilla-server-jar-missing' }
if ($Profile -ne 'vanilla' -and -not (Test-Path -LiteralPath (Join-Path $template 'run.bat') -PathType Leaf)) { throw 'neoforge-run-script-missing' }
if ($Profile -ne 'vanilla') {
  if ($templateManifest.neoForgeVersion -ne '21.1.259') { throw 'template-neoforge-version-mismatch' }
  $mods = Join-Path $template 'mods'
  if (-not (Test-Path -LiteralPath $mods -PathType Container)) { throw 'modded-profile-mods-directory-missing' }
  $modsById = @{}
  foreach ($mod in $templateManifest.mods) {
    if (-not $mod.id -or -not $mod.file -or [IO.Path]::GetFileName([string]$mod.file) -ne [string]$mod.file -or $mod.file -notlike '*.jar') { throw 'template-mod-manifest-entry-invalid' }
    $jar = Join-Path $mods $mod.file
    if (-not (Test-Path -LiteralPath $jar -PathType Leaf)) { throw "template-mod-jar-missing:$($mod.id)" }
    if ((Get-FileHash -LiteralPath $jar -Algorithm SHA256).Hash -ne ([string]$mod.sha256).ToUpperInvariant()) { throw "template-mod-checksum-mismatch:$($mod.id)" }
    if ($modsById.ContainsKey([string]$mod.id)) { throw 'template-mod-id-duplicate' }
    $modsById[[string]$mod.id] = $mod
  }
  if (-not $modsById.ContainsKey('minecraft_mcp_bridge')) { throw 'generic-bridge-jar-missing' }
  if ($Profile -eq 'processia-optional' -and -not $modsById.ContainsKey('processia')) { throw 'processia-mod-jar-missing' }
  if ($Profile -eq 'neoforge-third-party') {
    if (-not $templateManifest.thirdParty -or $templateManifest.thirdParty.approved -ne $true -or $templateManifest.thirdParty.approvedBy -ne 'user' -or
        $templateManifest.thirdParty.modId -ne $ApprovedThirdPartyModId -or $templateManifest.thirdParty.licenseReviewed -ne $true) { throw 'third-party-approval-manifest-invalid' }
    if (-not $modsById.ContainsKey($ApprovedThirdPartyModId)) { throw 'approved-third-party-mod-not-staged' }
  }
}

$runId = [guid]::NewGuid().ToString('N')
$runDirectory = Join-Path (Join-Path $root 'runs') (Join-Path $Profile $runId)
if (Test-Path -LiteralPath $runDirectory) { throw 'new-run-directory-collision' }
$logsDirectory = Join-Path $runDirectory 'logs'
$serverProperties = @(
  'server-ip=127.0.0.1', "server-port=$MinecraftPort", 'level-name=world', 'gamemode=survival',
  'enable-rcon=false', 'enable-query=false', 'enable-command-block=false', 'view-distance=4', 'simulation-distance=4',
  'max-players=2', 'online-mode=false', 'motd=Processia MCP isolated validation'
) -join [Environment]::NewLine

# Copy only an approved, world-free server template into a fresh run UUID. No existing world is copied or removed.
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
function Set-OwnerOnlyDirectoryAcl([string]$Directory) {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($current); $acl.SetAccessRuleProtection($true, $false)
  $rights = [Security.AccessControl.FileSystemRights]::FullControl
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($current, $rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule); Set-Acl -LiteralPath $Directory -AclObject $acl
}
Set-OwnerOnlyDirectoryAcl $runDirectory
Resolve-HarnessPath -Path $runDirectory -RequireExists | Out-Null
foreach ($templateEntry in (Get-ChildItem -LiteralPath $template -Force)) {
  Copy-Item -LiteralPath $templateEntry.FullName -Destination $runDirectory -Recurse -Force
}
Assert-HarnessTemplateIntegrity -TemplateDirectory $runDirectory -Manifest (Get-Content -LiteralPath (Join-Path $runDirectory 'harness-template.json') -Raw | ConvertFrom-Json) -ApprovedManifestSha256 $ApprovedManifestSha256 | Out-Null
New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $runDirectory 'server.properties'), $serverProperties + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

$pipeName = "ProcessiaMcpHarness-$runId"
$leasePath = Join-Path $runDirectory 'runtime-harness-lease.json'
$stdoutPath = Join-Path $logsDirectory 'server.stdout.log'
$stderrPath = Join-Path $logsDirectory 'server.stderr.log'
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.WorkingDirectory = $runDirectory
if ($Profile -eq 'vanilla') {
  $java = (Get-Command java.exe -ErrorAction Stop).Source
  $startInfo.FileName = $java
  $startInfo.Arguments = '-jar "' + (Join-Path $runDirectory 'server.jar') + '" nogui'
} else {
  $startInfo.FileName = $env:ComSpec
  if ([string]::IsNullOrWhiteSpace($startInfo.FileName)) { throw 'cmd-executable-unavailable' }
  $runBat = Join-Path $runDirectory 'run.bat'
  $startInfo.Arguments = '/d /s /c ""' + $runBat + '" nogui"'
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$stdoutPump = $null; $stderrPump = $null
$variables = @{
  MINECRAFT_MCP_BRIDGE_SECRET = $null
  PROCESSIA_BRIDGE_SECRET = $null
  PROCESSIA_BRIDGE_SERVER_IDENTITY = $null
}
if ($Profile -ne 'vanilla') {
  $configDirectory = Join-Path $runDirectory 'config'
  New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
  Set-OwnerOnlyDirectoryAcl $configDirectory
  $credentialFile = Join-Path $configDirectory 'minecraft-mcp-bridge.credentials.json'
  $variables += @{
    MINECRAFT_MCP_BRIDGE_ENABLED = 'true'; MINECRAFT_MCP_ENVIRONMENT = 'development'
    MINECRAFT_MCP_BRIDGE_PORT = [string]$BridgePort; MINECRAFT_MCP_SERVER_ENDPOINT = "127.0.0.1:$MinecraftPort"
    MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE = $credentialFile
    PROCESSIA_BRIDGE_ENABLED = $null; PROCESSIA_BRIDGE_PORT = $null
  }
}
Assert-Port $MinecraftPort 'minecraft'
if ($Profile -ne 'vanilla') { Assert-Port $BridgePort 'bridge' }
Start-HarnessProcessWithCleanEnvironment -Process $process -Environment $variables | Out-Null
$stdoutPump = New-HarnessSafeLogPump -Reader $process.StandardOutput -Path $stdoutPath
$stderrPump = New-HarnessSafeLogPump -Reader $process.StandardError -Path $stderrPath
$stdoutPump.Start(); $stderrPump.Start()
$processIdentity = Get-HarnessProcessIdentity -ProcessId $process.Id
if ($null -eq $processIdentity) {
  try { $process.StandardInput.WriteLine('stop'); $process.StandardInput.Flush() } catch { }
  if (-not $process.WaitForExit(30000)) { throw 'process-identity-unavailable-after-start: stop requested but child preserved for manual review' }
  throw 'process-identity-unavailable-after-start: launched process exited safely; no lease published'
}
$identity = [ordered]@{
  schemaVersion = 2; runId = $runId; profile = $Profile; pid = $process.Id
  startedAt = $processIdentity.startedAt; executablePath = $processIdentity.executablePath; commandLine = $processIdentity.commandLine
  workingDirectory = $runDirectory; minecraftHost = '127.0.0.1'; minecraftPort = $MinecraftPort
  bridgePort = $null; pipeName = $pipeName; status = 'running'; stopRequested = $false
  stopAcceptedAt = $null; processExited = $false; listenerClosed = $false; exitCode = $null
}
[IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
$pipe = $null
$pipeWait = $null
$stopRequested = $false
Write-Host "Supervising isolated profile '$Profile' in a new world directory. Logs: $logsDirectory"
try {
  $pipe = New-OwnerOnlyPipe $pipeName
  $pipeWait = $pipe.WaitForConnectionAsync()
  if ([IO.Path]::GetFileName($processIdentity.executablePath) -ine 'java.exe') { throw 'unexpected-managed-executable' }
  $readinessDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  $minecraftReady = $false; $bridgeReady = ($Profile -eq 'vanilla')
  while (-not $process.HasExited -and -not $minecraftReady -and [DateTime]::UtcNow -lt $readinessDeadline) {
    $minecraftReady = Test-HarnessListenerOwnedByIdentity -ExpectedProcess $processIdentity -Port $MinecraftPort
    if (-not ($minecraftReady -and $bridgeReady)) { Start-Sleep -Milliseconds 500 }
  }
  if (-not ($minecraftReady -and $bridgeReady)) {
    if (-not $process.HasExited) {
      $identity.stopRequested = $true; $identity.stopAcceptedAt = [DateTime]::UtcNow.ToString('o')
      [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
      $process.StandardInput.WriteLine('stop'); $process.StandardInput.Flush()
    }
    if (-not $process.HasExited -and -not $process.WaitForExit(120000)) {
      $identity.status = 'startup-timeout-process-preserved'; [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
      throw 'startup-readiness-timeout: graceful stop was requested; process and world were preserved, no force termination attempted'
    }
    if ($process.HasExited) { $identity.status = 'startup-failed'; $identity.exitCode = $process.ExitCode; [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false)) }
    throw 'startup-readiness-failed: server or bridge listener was not owned by the launched process tree'
  }
  Write-Host 'Minecraft and required bridge listeners were observed on loopback under this launched process tree.'
  while (-not $process.HasExited -and -not $stopRequested) {
    if ($pipeWait.Wait(250)) {
      $reader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 1024, $true)
      $writer = [IO.StreamWriter]::new($pipe, [Text.Encoding]::UTF8, 1024, $true); $writer.AutoFlush = $true
      $pipeRead = Read-HarnessPipeRequest -Reader $reader -Writer $writer -TimeoutMilliseconds 5000
      if ($pipeRead.status -eq 'disconnected') { $writer.WriteLine('refused-disconnected') }
      elseif ($pipeRead.status -eq 'received') {
        $expectedProcess = [pscustomobject]@{ pid = [int]$identity.pid; startedAt = [string]$identity.startedAt; executablePath = [string]$identity.executablePath; commandLine = [string]$identity.commandLine; workingDirectory = [string]$identity.workingDirectory }
        $decision = Test-HarnessStopRequest -Request $pipeRead.request -RunId $runId -ExpectedProcess $expectedProcess
        if ($decision -ceq 'accepted' -and -not $process.HasExited) {
          $identity.stopRequested = $true; $identity.stopAcceptedAt = [DateTime]::UtcNow.ToString('o')
          [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
          $process.StandardInput.WriteLine('stop'); $process.StandardInput.Flush(); $writer.WriteLine('accepted')
          $stopRequested = $true
        } elseif ($process.HasExited -and $decision -ceq 'accepted') { $writer.WriteLine('refused-process-exited') }
        else { $writer.WriteLine($decision) }
      }
      $reader.Dispose(); $writer.Dispose(); $pipe.Dispose()
      if (-not $stopRequested -and -not $process.HasExited) {
        $pipe = New-OwnerOnlyPipe $pipeName
        $pipeWait = $pipe.WaitForConnectionAsync()
      }
    }
  }
  if ($stopRequested -and -not $process.WaitForExit(120000)) {
    $identity.status = 'stop-timeout-process-preserved'; [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    throw 'graceful-stop-timeout: request was accepted but process exit was not confirmed; no force termination was attempted'
  }
  $process.WaitForExit()
  $identity.processExited = $true; $identity.exitCode = $process.ExitCode
  $identity.listenerClosed = -not [bool](Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $MinecraftPort -ErrorAction SilentlyContinue)
  if ($stopRequested -and $identity.listenerClosed) { $identity.status = 'stopped-confirmed' }
  elseif ($stopRequested) { $identity.status = 'stop-request-accepted-but-listener-remains-uncertain' }
  else { $identity.status = 'exited-without-stop-request' }
  [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  if ($identity.status -ne 'stopped-confirmed') { throw "server-stop-not-confirmed:$($identity.status)" }
  Write-Host "Graceful stop confirmed (process exited and listener closed). Run directory and world were preserved."
} catch {
  if (-not $process.HasExited -and -not $identity.stopRequested) {
    $identity.stopRequested = $true; $identity.stopAcceptedAt = [DateTime]::UtcNow.ToString('o')
    $identity.status = 'supervisor-failure-stop-requested'
    try { [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false)) } catch { }
    try { $process.StandardInput.WriteLine('stop'); $process.StandardInput.Flush() } catch { }
  }
  if (-not $process.HasExited) { [void]$process.WaitForExit(30000) }
  if (-not $process.HasExited) {
    $identity.status = 'supervisor-failure-process-preserved'
    try { [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false)) } catch { }
    Write-Warning 'Managed process remains alive after a graceful stop request. It is preserved, no kill is attempted, and the supervisor remains available for a new explicit stop request.'
    Wait-PreservedManagedProcess -ManagedProcess $process -Lease $identity -LeaseFile $leasePath -MinecraftPort $MinecraftPort -PipeName $pipeName
  }
  $process.Refresh()
  $identity.processExited = $process.HasExited
  if ($process.HasExited) { $identity.exitCode = $process.ExitCode }
  $identity.listenerClosed = -not [bool](Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $MinecraftPort -ErrorAction SilentlyContinue)
  if ($process.HasExited -and $identity.listenerClosed) {
    if ($identity.stopRequested) { $identity.status = 'stopped-confirmed' } else { $identity.status = 'supervisor-failure-stopped' }
  } else { $identity.status = 'supervisor-failure-process-preserved' }
  try { [IO.File]::WriteAllText($leasePath, ($identity | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false)) } catch { }
  throw
} finally {
  if ($stdoutPump) {
    if (-not $stdoutPump.Join(5000)) { Write-Warning 'stdout-log-pump-did-not-drain-before-supervisor-exit' }
    if ($stdoutPump.FailureCode) { Write-Warning $stdoutPump.FailureCode }
  }
  if ($stderrPump) {
    if (-not $stderrPump.Join(5000)) { Write-Warning 'stderr-log-pump-did-not-drain-before-supervisor-exit' }
    if ($stderrPump.FailureCode) { Write-Warning $stderrPump.FailureCode }
  }
  if ($pipe) { $pipe.Dispose() }
  $process.Dispose()
}
} finally { $runLock.Dispose() }
