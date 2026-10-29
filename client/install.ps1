# Install the `aireport` CLI and the `pl-report` skill for Claude Code and Codex on Windows.
#
#   PowerShell (no git needed):
#     $env:AIREPORT_OWNER = "<your name>"; irm https://plreport.oncosoft.io/client/install.ps1 | iex
#     (GitHub copy: irm https://raw.githubusercontent.com/jmleeonco/ai-platform-report/main/client/install.ps1 | iex)
#   From a checkout of the ai-platform-report repo:
#     powershell -ExecutionPolicy Bypass -File client\install.ps1
#
# Installs:
#   %LOCALAPPDATA%\aireport\aireport.py  + aireport.cmd (cmd / PowerShell) + aireport (Git Bash), dir added to user PATH
#   %USERPROFILE%\.claude\skills\pl-report\SKILL.md          (Claude Code)
#   %CODEX_HOME% or %USERPROFILE%\.codex\skills\pl-report\SKILL.md   (Codex)
# Options (env): AIREPORT_URL, AIREPORT_OWNER, AIREPORT_BIN_DIR, SKILL_TARGETS="claude codex"
# ASCII only in this file: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
# No `exit` (under `irm | iex` it would close the user's window) - errors `throw`.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Url = if ($env:AIREPORT_URL) { $env:AIREPORT_URL } else { "__AIREPORT_URL__" }
if ($Url.StartsWith("__")) { $Url = "https://plreport.oncosoft.io" }
$Url = $Url.TrimEnd("/")
$GhRaw = "https://raw.githubusercontent.com/jmleeonco/ai-platform-report/main"
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$BinDir = if ($env:AIREPORT_BIN_DIR) { $env:AIREPORT_BIN_DIR }
          elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "aireport" }
          else { Join-Path $UserHome ".local/share/aireport" }
$Targets = if ($env:SKILL_TARGETS) { $env:SKILL_TARGETS -split "\s+" } else { @("claude", "codex") }

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [!] $m" -ForegroundColor Yellow }
$Utf8 = New-Object System.Text.UTF8Encoding($false)
# run a native command quietly and return its exit code (PS 5.1 throws on redirected stderr under "Stop")
function Quiet([string[]]$Cmd) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $Cmd[0] @($Cmd | Select-Object -Skip 1) *> $null; return $LASTEXITCODE } catch { return 1 }
  finally { $ErrorActionPreference = $old }
}

# repo checkout? (the script sits in <repo>\client)
$Src = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "aireport")) -and
    (Test-Path (Join-Path $PSScriptRoot "../skills/pl-report/SKILL.md"))) {
  $Src = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

# fetch <server path> <repo path> <dest>: local checkout, else the report server, else GitHub
function Fetch($ServerPath, $RepoPath, $Dest) {
  if ($Src) { Copy-Item (Join-Path $Src $RepoPath) $Dest -Force; return }
  try { Invoke-WebRequest -UseBasicParsing "$Url/$ServerPath" -OutFile $Dest; return } catch { }
  try { Invoke-WebRequest -UseBasicParsing "$GhRaw/$RepoPath" -OutFile $Dest }
  catch { throw "cannot download $RepoPath from $Url or GitHub: $_" }
}

# --- Python 3.8+ (skip the Microsoft Store "python3" stub: it exists but does not run)
Say "Python"
$Py = $null; $PyCmd = $null
foreach ($c in @(@("py", "-3"), @("python"), @("python3"))) {
  if (-not (Get-Command $c[0] -ErrorAction SilentlyContinue)) { continue }
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    $exe = & $c[0] @($c | Select-Object -Skip 1) -c "import sys; assert sys.version_info >= (3, 8); print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe) { $Py = ([string]($exe | Select-Object -Last 1)).Trim(); $PyCmd = $c }
  } catch { } finally { $ErrorActionPreference = $old }
  if ($Py) { break }
}
if (-not $Py) {
  throw "Python 3.8+ is required. Install it (winget install -e --id Python.Python.3.12), open a new terminal, and re-run."
}
Ok "$Py  (launched as: $($PyCmd -join ' '))"

# --- CLI
Say "aireport CLI -> $BinDir"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$PyFile = Join-Path $BinDir "aireport.py"
Fetch "client/aireport" "client/aireport" $PyFile
# shims call the launcher by name (e.g. "py -3"), never by full path: a .cmd file is read in the
# console code page, so a path under a Korean user name would break it
$Launch = $PyCmd -join " "
[IO.File]::WriteAllText((Join-Path $BinDir "aireport.cmd"), "@echo off`r`n$Launch `"%~dp0aireport.py`" %*`r`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $BinDir "aireport"), "#!/bin/sh`nexec $Launch `"`$(dirname `"`$0`")/aireport.py`" `"`$@`"`n", $Utf8)
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($UserPath -split ";") -contains $BinDir)) {
  [Environment]::SetEnvironmentVariable("Path", (@($UserPath, $BinDir) | Where-Object { $_ }) -join ";", "User")
  Ok "added $BinDir to your user PATH (new terminals pick it up)"
}
if (-not (($env:Path -split [IO.Path]::PathSeparator) -contains $BinDir)) { $env:Path = "$BinDir$([IO.Path]::PathSeparator)$env:Path" }
Ok "installed"

# --- skills
foreach ($t in $Targets) {
  switch ($t) {
    "claude" { $root = Join-Path $UserHome ".claude/skills" }
    "codex"  { $root = Join-Path $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $UserHome ".codex" }) "skills" }
    default  { Warn "unknown skill target $t"; continue }
  }
  $dir = Join-Path $root "pl-report"
  Say "skill ($t) -> $dir\SKILL.md"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Fetch "client/SKILL.md" "skills/pl-report/SKILL.md" (Join-Path $dir "SKILL.md")
  Ok "installed"
  # the skill used to be called ai-report; remove that copy (only if it is ours)
  $old = Join-Path $root "ai-report/SKILL.md"
  if ((Test-Path $old) -and (Select-String -Path $old -Pattern "^name: ai-report" -Quiet) -and
      (Select-String -Path $old -Pattern "aireport" -Quiet)) {
    Remove-Item -Recurse -Force (Split-Path $old); Ok "removed old skill name ai-report"
  }
}

# --- config + checks
Say "config"
$cfg = @("config", "--url", $Url)
if ($env:AIREPORT_OWNER) { $cfg += @("--owner", $env:AIREPORT_OWNER) }
& $Py $PyFile @cfg | Out-Null
if ($LASTEXITCODE -ne 0) { throw "aireport config failed" }
Ok ("server $Url" + $(if ($env:AIREPORT_OWNER) { ", owner $($env:AIREPORT_OWNER)" } else { "" }))
if ((Quiet @($Py, $PyFile, "health")) -eq 0) { Ok "server reachable" } else { Warn "server not reachable right now ($Url)" }
if ((Quiet @($Py, "-c", "import numpy, scipy, nibabel")) -eq 0) { Ok "numpy + scipy + nibabel present (aireport viewer works)" }
else { Warn "for ``aireport viewer``: `"$Py`" -m pip install --user numpy scipy nibabel" }
if (-not $env:AIREPORT_OWNER) { Write-Host "    next: aireport config --owner `"<your name>`"" }
Write-Host "    Restart Claude Code / Codex, then: /pl-report (Claude Code) or `$pl-report (Codex), or just ask for a report"
