#!/bin/sh
# gitowl installer for macOS / Linux.
#   curl -fsSL <url>/install.sh | sh
# Options (environment): GITOWL_PACKAGE (default gitowl), GITOWL_NO_INIT=1 to skip the wizard.
set -eu

PACKAGE="${GITOWL_PACKAGE:-gitowl}"

say()  { printf '\033[1;35m◆\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✖\033[0m %s\n' "$1" >&2; exit 1; }

say "Installing gitowl"

command -v git >/dev/null 2>&1 || fail "git is not installed. Install it first (https://git-scm.com)."

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 20.19+ is required but was not found. Install it (https://nodejs.org, or 'brew install node' / your package manager) and rerun."
fi
# Node 20.19 is the floor (dependencies need it); anything from 22 up is fine.
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)'   || fail "Node.js 20.19+ is required (found $(node -v))."

if command -v pnpm >/dev/null 2>&1; then
  say "Using pnpm"
  pnpm add -g "$PACKAGE@latest"
elif command -v npm >/dev/null 2>&1; then
  say "Using npm"
  npm install -g "$PACKAGE@latest"
else
  fail "Neither pnpm nor npm was found."
fi

if ! command -v gitowl >/dev/null 2>&1; then
  printf '\033[1;33m▲\033[0m Installed, but "gitowl" is not on your PATH yet. Open a new terminal (or add your global bin directory to PATH).\n'
  exit 0
fi

say "Installed $(gitowl --version)"

# Under `curl | sh` stdin is the script itself, so hand the wizard the real terminal.
if [ "${GITOWL_NO_INIT:-}" != "1" ] && [ -e /dev/tty ]; then
  say "Starting setup"
  gitowl init </dev/tty
else
  say "Run 'gitowl init' to finish setup."
fi
