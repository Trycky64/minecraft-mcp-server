Set-StrictMode -Version Latest

if (-not ('ProcessiaHarnessSafeLogPump' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public sealed class ProcessiaHarnessSafeLogPump {
  private readonly StreamReader reader;
  private readonly string path;
  private Thread thread;
  private volatile string failureCode;
  public string FailureCode { get { return failureCode; } }
  public ProcessiaHarnessSafeLogPump(StreamReader reader, string path) { this.reader = reader; this.path = path; }
  public void Start() {
    if (thread != null) throw new InvalidOperationException("log-pump-already-started");
    thread = new Thread(Pump); thread.IsBackground = true; thread.Name = "ProcessiaHarnessSafeLogPump"; thread.Start();
  }
  public bool Join(int timeoutMilliseconds) { return thread == null || thread.Join(timeoutMilliseconds); }
  private void Pump() {
    bool pendingCredentialContinuation = false;
    try {
      string line;
      while ((line = reader.ReadLine()) != null) {
        string safe;
        if (pendingCredentialContinuation) { safe = "[CREDENTIAL CONTINUATION REDACTED]"; pendingCredentialContinuation = false; }
        else if (Regex.IsMatch(line, @"(?i)(authorization\s*:\s*$|bearer\s*$|(?:secret|token|password|credential)\s*[:=]\s*$|https?://[^:/\s]+:\s*$)")) {
          safe = "[CREDENTIAL REDACTED]"; pendingCredentialContinuation = true;
        } else safe = Sanitize(line);
        File.AppendAllText(path, safe + Environment.NewLine, new UTF8Encoding(false));
      }
    } catch (Exception error) { failureCode = "safe-log-stream-failed:" + error.GetType().Name; }
  }
  private static string Sanitize(string line) {
    string safe = Regex.Replace(line, @"(?i)(authorization\s*:\s*|bearer\s+|(?:secret|token|password|credential)\s*[:=]\s*)[^\s,;]+", "$1[REDACTED]");
    safe = Regex.Replace(safe, @"(?i)(https?://[^:/\s]+:)[^@/\s]+@", "$1[REDACTED]@");
    if (Regex.IsMatch(safe, @"(?i)(""(?:chat|message)""\s*:|^\[[^\]]+\].*<[^>]{1,32}>)")) return "[CHAT REDACTED]";
    safe = Regex.Replace(safe, "[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]", "");
    return safe.Length > 4096 ? safe.Substring(0, 4096) + "[TRUNCATED]" : safe;
  }
}
'@
}

function Resolve-HarnessPath {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path, [switch]$RequireExists)
  $full = [IO.Path]::GetFullPath($Path)
  $pathRoot = [IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $pathRoot.Length) { $full = $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) }
  if ($RequireExists -and -not (Test-Path -LiteralPath $full)) { throw 'path-does-not-exist' }
  $root = [IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($root)) { throw 'path-root-unresolvable' }
  $current = $root
  $relative = $full.Substring($root.Length)
  foreach ($part in ($relative -split '[\\/]+' | Where-Object { $_ })) {
    $current = Join-Path $current $part
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-point-path-refused' }
    }
  }
  return $full
}

function Test-HarnessPathWithin {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$Child)
  $parentFull = Resolve-HarnessPath -Path $Parent
  $childFull = Resolve-HarnessPath -Path $Child
  $prefix = if ($parentFull.EndsWith([string][IO.Path]::DirectorySeparatorChar) -or $parentFull.EndsWith([string][IO.Path]::AltDirectorySeparatorChar)) { $parentFull } else { $parentFull + [IO.Path]::DirectorySeparatorChar }
  return $childFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-HarnessProcessIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory)][int]$ProcessId)
  try { $process = [Diagnostics.Process]::GetProcessById($ProcessId) } catch { return $null }
  try {
    $cim = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -ErrorAction Stop
    if (-not $cim -or [int]$cim.ProcessId -ne $ProcessId -or -not $cim.CommandLine) { return $null }
    return [pscustomobject]@{
      pid = $process.Id
      startedAt = $process.StartTime.ToUniversalTime().ToString('o')
      executablePath = [IO.Path]::GetFullPath($process.MainModule.FileName)
      commandLine = [string]$cim.CommandLine
    }
  } finally { $process.Dispose() }
}

function Test-HarnessProcessIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Expected)
  $observed = Get-HarnessProcessIdentity -ProcessId ([int]$Expected.pid)
  $matches = ($null -ne $observed -and $observed.pid -eq [int]$Expected.pid -and
    $observed.startedAt -ceq [string]$Expected.startedAt -and
    $observed.executablePath -ieq [IO.Path]::GetFullPath([string]$Expected.executablePath) -and
    $observed.commandLine -ceq [string]$Expected.commandLine)
  if (-not $matches) { return $false }
  if ($Expected.PSObject.Properties['workingDirectory'] -and
      $observed.commandLine.IndexOf([string]$Expected.workingDirectory, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  return $true
}

function Start-HarnessProcessWithCleanEnvironment {
  [CmdletBinding()]
  param([Parameter(Mandatory)][Diagnostics.Process]$Process, [hashtable]$Environment = @{})
  $oldValues = @{}
  $names = @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { [string]$_ -match '(?i)(secret|token|password|credential|api.?key|access.?key|authorization)' })
  foreach ($key in $Environment.Keys) { if ($names -notcontains [string]$key) { $names += [string]$key } }
  try {
    foreach ($name in $names) {
      $oldValues[$name] = [Environment]::GetEnvironmentVariable([string]$name, 'Process')
      [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
    foreach ($key in $Environment.Keys) {
      if ($null -eq $Environment[$key]) { [Environment]::SetEnvironmentVariable([string]$key, $null, 'Process') }
      else { [Environment]::SetEnvironmentVariable([string]$key, [string]$Environment[$key], 'Process') }
    }
    if (-not $Process.Start()) { throw 'managed-process-start-failed' }
    return $true
  } finally {
    foreach ($name in $oldValues.Keys) { [Environment]::SetEnvironmentVariable([string]$name, $oldValues[$name], 'Process') }
  }
}

function Test-HarnessStopRequest {
  [CmdletBinding()]
  param([AllowNull()][string]$Request, [Parameter(Mandatory)][string]$RunId, [Parameter(Mandatory)]$ExpectedProcess)
  if ($Request -cne "stop:$RunId") { return 'refused-invalid-run' }
  if (-not (Test-HarnessProcessIdentity -Expected $ExpectedProcess)) { return 'refused-process-identity' }
  return 'accepted'
}

function Test-HarnessListenerOwnedByIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$ExpectedProcess, [ValidateRange(1,65535)][int]$Port)
  if (-not (Test-HarnessProcessIdentity -Expected $ExpectedProcess)) { return $false }
  $listeners = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) { return $false }
  foreach ($listener in $listeners) { if ([int]$listener.OwningProcess -ne [int]$ExpectedProcess.pid) { return $false } }
  return $true
}

function New-OwnerOnlyPipeSecurity {
  $security = [IO.Pipes.PipeSecurity]::new()
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [IO.Pipes.PipeAccessRule]::new($sid, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  return $security
}

function Read-HarnessPipeRequest {
  [CmdletBinding()]
  param([Parameter(Mandatory)][IO.StreamReader]$Reader, [Parameter(Mandatory)][IO.StreamWriter]$Writer,
    [ValidateRange(100,5000)][int]$TimeoutMilliseconds = 5000)
  try {
    $read = $Reader.ReadLineAsync()
    if (-not $read.Wait($TimeoutMilliseconds)) {
      $Writer.WriteLine('refused-timeout')
      return [pscustomobject]@{ status = 'timeout'; request = $null }
    }
    $request = $read.Result
  } catch { return [pscustomobject]@{ status = 'disconnected'; request = $null } }
  if ($null -eq $request) { return [pscustomobject]@{ status = 'disconnected'; request = $null } }
  return [pscustomobject]@{ status = 'received'; request = $request }
}

function New-OwnerOnlyNamedPipe {
  [CmdletBinding()]
  param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9-]{16,100}$')][string]$Name)
  $security = New-OwnerOnlyPipeSecurity
  return [IO.Pipes.NamedPipeServerStream]::new($Name, [IO.Pipes.PipeDirection]::InOut, 1,
    [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 1024, 1024, $security)
}

function Assert-HarnessTemplateIntegrity {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$TemplateDirectory, [Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)][string]$ApprovedManifestSha256)
  $template = Resolve-HarnessPath -Path $TemplateDirectory -RequireExists
  if (-not (Test-Path -LiteralPath $template -PathType Container)) { throw 'template-not-directory' }
  if ($ApprovedManifestSha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'approved-manifest-digest-required' }
  $manifestPath = Join-Path $template 'harness-template.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'template-manifest-required' }
  if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ine $ApprovedManifestSha256) { throw 'template-manifest-digest-mismatch' }
  $allFiles = @(Get-ChildItem -LiteralPath $template -File -Force -Recurse -ErrorAction Stop)
  foreach ($item in (Get-ChildItem -LiteralPath $template -Force -Recurse -ErrorAction Stop)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'template-reparse-point-refused' }
  }
  if ($null -eq $Manifest.files -or @($Manifest.files).Count -eq 0) { throw 'template-file-manifest-incomplete' }
  $expected = @{}
  foreach ($entry in $Manifest.files) {
    $relative = ([string]$entry.path).Replace('/', [string][char]92)
    if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or $relative -match '(^|\\)\.\.?($|\\)' -or $relative -match '[<>:"|?*]' -or $relative -ieq 'harness-template.json') { throw 'template-file-manifest-path-invalid' }
    if ([string]$entry.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'template-file-manifest-hash-invalid' }
    $key = $relative.ToLowerInvariant()
    if ($expected.ContainsKey($key)) { throw 'template-file-manifest-duplicate' }
    $file = Join-Path $template $relative
    $resolved = Resolve-HarnessPath -Path $file -RequireExists
    if (-not (Test-HarnessPathWithin -Parent $template -Child $resolved) -or -not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'template-file-manifest-file-missing' }
    if ((Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash -ine [string]$entry.sha256) { throw 'template-file-checksum-mismatch' }
    $expected[$key] = $true
  }
    $actual = @($allFiles | Where-Object { $_.Name -ine 'harness-template.json' } | ForEach-Object { $_.FullName.Substring($template.Length).TrimStart([char[]]@([char]92,[char]47)).Replace('/', [string][char]92).ToLowerInvariant() })
  if ($actual.Count -ne $expected.Count) { throw 'template-contains-undeclared-files' }
  foreach ($path in $actual) { if (-not $expected.ContainsKey($path)) { throw 'template-contains-undeclared-files' } }
  $modsPath = Join-Path $template 'mods'
  $modEntries = @($Manifest.mods)
  if ([string]$Manifest.profile -eq 'vanilla') {
    if ($modEntries.Count -ne 0 -or (Test-Path -LiteralPath $modsPath)) { throw 'vanilla-template-must-not-contain-mods' }
  } else {
    $modFiles = @($modEntries | ForEach-Object { ([string]$_.file).ToLowerInvariant() } | Sort-Object -Unique)
    if ($modFiles.Count -ne $modEntries.Count) { throw 'template-mod-manifest-duplicate' }
    $diskMods = @(Get-ChildItem -LiteralPath $modsPath -File -Filter '*.jar' -ErrorAction Stop | ForEach-Object { $_.Name.ToLowerInvariant() } | Sort-Object -Unique)
    if ($diskMods.Count -ne $modFiles.Count -or (Compare-Object $modFiles $diskMods)) { throw 'template-contains-undeclared-mods' }
    foreach ($mod in $modEntries) {
      $listed = @($Manifest.files | Where-Object { ([string]$_.path).Replace('/', [string][char]92) -ieq ('mods' + [string][char]92 + [string]$mod.file) })
      if ($listed.Count -ne 1 -or [string]$listed[0].sha256 -ine [string]$mod.sha256) { throw 'mod-and-file-manifest-inconsistent' }
    }
  }
  return $true
}

function Test-HarnessPortPolicy {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$HostName,
    [AllowNull()][object]$MinecraftPort,
    [AllowNull()][object]$BridgePort,
    [AllowNull()][object]$GuiPort,
    [int[]]$OccupiedPorts = @()
  )
  $errors = [Collections.Generic.List[string]]::new()
  if ($HostName -cne '127.0.0.1') { $errors.Add('loopback-only-required') }
  $ports = @(
    [pscustomobject]@{ name = 'minecraft'; value = $MinecraftPort },
    [pscustomobject]@{ name = 'bridge'; value = $BridgePort },
    [pscustomobject]@{ name = 'gui'; value = $GuiPort }
  )
  foreach ($entry in $ports) {
    $name = [string]$entry.name; $port = $entry.value
    if ($null -eq $port) { if ($name -eq 'minecraft') { $errors.Add('minecraft-port-required') }; continue }
    if ($port -lt 1 -or $port -gt 65535) { $errors.Add("$name-port-invalid"); continue }
    if ($port -eq 25565) { $errors.Add('personal-server-port-forbidden') }
    if ($port -eq 25665) { $errors.Add('historical-test-server-port-forbidden') }
    if ($OccupiedPorts -contains $port) { $errors.Add("$name-port-occupied") }
  }
  $selected = @($ports | Where-Object { $null -ne $_.value } | ForEach-Object { [int]$_.value })
  $uniqueSelected = @($selected | Select-Object -Unique)
  if ($uniqueSelected.Length -ne $selected.Length) { $errors.Add('service-port-collision') }
  return [pscustomobject]@{ valid = ($errors.Count -eq 0); errors = @($errors) }
}

function ConvertTo-SafeHarnessLogLine {
  [CmdletBinding()]
  param([AllowEmptyString()][string]$Line)
  if ($null -eq $Line) { return '' }
  $safe = $Line -replace '(?i)(authorization\s*:\s*|bearer\s+|(?:secret|token|password|credential)\s*[:=]\s*)[^\s,;]+', '$1[REDACTED]'
  $safe = $safe -replace '(?i)(https?://[^:/\s]+:)[^@/\s]+@', '$1[REDACTED]@'
  if ($safe -match '(?i)("(?:chat|message)"\s*:|^\[[^\]]+\].*<[^>]{1,32}>)') { return '[CHAT REDACTED]' }
  $safe = [regex]::Replace($safe, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '')
  if ($safe.Length -gt 4096) { $safe = $safe.Substring(0, 4096) + '[TRUNCATED]' }
  return $safe
}

function New-HarnessLogState { return @{ pendingCredentialContinuation = $false } }

function New-HarnessSafeLogPump {
  [CmdletBinding()]
  param([Parameter(Mandatory)][IO.StreamReader]$Reader, [Parameter(Mandatory)][string]$Path)
  return [ProcessiaHarnessSafeLogPump]::new($Reader, $Path)
}

function Write-SafeHarnessLogLine {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path, [AllowEmptyString()][string]$Line, [hashtable]$State)
  $safe = ConvertTo-SafeHarnessLogLine -Line $Line
  if ($State) {
    if ($State.pendingCredentialContinuation) {
      $safe = '[CREDENTIAL CONTINUATION REDACTED]'
      $State.pendingCredentialContinuation = $false
    } elseif ($Line -match '(?i)(authorization\s*:\s*$|bearer\s*$|(?:secret|token|password|credential)\s*[:=]\s*$|https?://[^:/\s]+:\s*$)') {
      $safe = '[CREDENTIAL REDACTED]'
      $State.pendingCredentialContinuation = $true
    }
  }
  try {
    [IO.File]::AppendAllText($Path, $safe + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    return $true
  } catch { return $false }
}

Export-ModuleMember -Function Resolve-HarnessPath, Test-HarnessPathWithin, Get-HarnessProcessIdentity, Test-HarnessProcessIdentity, Test-HarnessStopRequest, Test-HarnessListenerOwnedByIdentity, Start-HarnessProcessWithCleanEnvironment, New-OwnerOnlyPipeSecurity, Read-HarnessPipeRequest, New-OwnerOnlyNamedPipe, Assert-HarnessTemplateIntegrity, Test-HarnessPortPolicy, ConvertTo-SafeHarnessLogLine, New-HarnessLogState, New-HarnessSafeLogPump, Write-SafeHarnessLogLine
