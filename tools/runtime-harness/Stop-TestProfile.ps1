[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$HarnessRoot,
  [Parameter(Mandatory)][string]$RunDirectory,
  [ValidateRange(1, 120)][int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
$coreModule = Join-Path $PSScriptRoot 'Supervisor.Core.psm1'
Import-Module -Name $coreModule -Force
$root = Resolve-HarnessPath -Path $HarnessRoot -RequireExists
$run = Resolve-HarnessPath -Path $RunDirectory -RequireExists
if (-not (Test-HarnessPathWithin -Parent $root -Child $run)) { throw 'run-directory-outside-harness-root' }
$leasePath = Join-Path $run 'runtime-harness-lease.json'
if (-not (Test-Path -LiteralPath $leasePath -PathType Leaf)) { throw 'managed-process-lease-not-found' }
$lease = Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
if ($lease.schemaVersion -ne 2 -or $lease.workingDirectory -ne $run -or $lease.status -notin @('running','stop-timeout-process-preserved','supervisor-failure-process-preserved')) { throw 'managed-process-lease-invalid-or-inactive' }
if ($lease.minecraftPort -eq 25565 -or $lease.minecraftHost -ne '127.0.0.1') { throw 'lease-target-is-forbidden' }
$expected = [pscustomobject]@{ pid = [int]$lease.pid; startedAt = [string]$lease.startedAt; executablePath = [string]$lease.executablePath; commandLine = [string]$lease.commandLine; workingDirectory = [string]$lease.workingDirectory }
if (-not (Test-HarnessProcessIdentity -Expected $expected)) { throw 'managed-process-identity-mismatch' }

$client = [IO.Pipes.NamedPipeClientStream]::new('.', [string]$lease.pipeName, [IO.Pipes.PipeDirection]::InOut)
try {
  $client.Connect(5000)
  $writer = [IO.StreamWriter]::new($client, [Text.Encoding]::UTF8, 1024, $true); $writer.AutoFlush = $true
  $reader = [IO.StreamReader]::new($client, [Text.Encoding]::UTF8, $false, 1024, $true)
  $writer.WriteLine("stop:$($lease.runId)")
  $response = $reader.ReadLineAsync()
  if (-not $response.Wait(5000)) { throw 'supervisor-response-timeout: stop outcome remains unconfirmed' }
  if ($response.Result -cne 'accepted') { throw 'supervisor-refused-graceful-stop' }
} finally { if ($client) { $client.Dispose() } }

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
  $currentLease = Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
  if ($currentLease.runId -cne [string]$lease.runId -or $currentLease.pid -ne $lease.pid -or $currentLease.startedAt -cne $lease.startedAt) { throw 'managed-process-lease-identity-changed-during-stop' }
  if (Test-HarnessProcessIdentity -Expected $expected) { Start-Sleep -Milliseconds 250; continue }
  if ($currentLease.status -ceq 'stopped-confirmed' -and $currentLease.processExited -eq $true -and $currentLease.listenerClosed -eq $true) {
    if (Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort ([int]$lease.minecraftPort) -ErrorAction SilentlyContinue) { throw 'listener-remains-after-stop-confirmation' }
    Write-Output "Graceful stop confirmed by supervisor lease, process identity, and closed loopback listener. World retained at $run."
    exit 0
  }
  if ($currentLease.status -notin @('running','stop-timeout-process-preserved','supervisor-failure-process-preserved')) { throw "server-stop-not-confirmed:$($currentLease.status)" }
  Start-Sleep -Milliseconds 250
}
throw 'graceful-stop-timeout: request acceptance is not stop confirmation; no force termination attempted, inspect supervisor and preserve run directory'
