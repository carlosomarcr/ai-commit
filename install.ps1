# aicommit installer for Windows (PowerShell 5.1+).
#   irm <url>/install.ps1 | iex
# Optional: $env:AICOMMIT_PACKAGE (default aicommit-cli), $env:AICOMMIT_NO_INIT = "1" to skip the wizard.
$ErrorActionPreference = "Stop"

$package = if ($env:AICOMMIT_PACKAGE) { $env:AICOMMIT_PACKAGE } else { "aicommit-cli" }

function Say($msg)  { Write-Host "==> $msg" -ForegroundColor Magenta }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

Say "Installing aicommit"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "git is not installed. Install it first: winget install Git.Git"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js 20.19+ is required but was not found. Install it: winget install OpenJS.NodeJS.LTS (then open a new terminal and rerun)."
}
# Node 20.19 is the floor (dependencies need it); anything from 22 up is fine.
$ok = node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)"
if ($LASTEXITCODE -ne 0) { Fail "Node.js 20.19+ is required (found $(node -v))." }

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Say "Using pnpm"
  pnpm add -g "$package@latest"
} elseif (Get-Command npm -ErrorAction SilentlyContinue) {
  Say "Using npm"
  npm install -g "$package@latest"
} else {
  Fail "Neither pnpm nor npm was found."
}
if ($LASTEXITCODE -ne 0) { Fail "The package manager failed to install $package." }

# A fresh global install may not be on this session's PATH yet.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
if (-not (Get-Command aicommit -ErrorAction SilentlyContinue)) {
  Write-Host "WARNING: Installed, but 'aicommit' is not on your PATH yet. Open a new terminal." -ForegroundColor Yellow
  exit 0
}

Say "Installed $(aicommit --version)"
if ($env:AICOMMIT_NO_INIT -ne "1") {
  Say "Starting setup"
  aicommit init
} else {
  Say "Run 'aicommit init' to finish setup."
}
