#!/usr/bin/env bash
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────
DORKOS_VERSION="latest"
DORKOS_NO_PROMPT="${DORKOS_NO_PROMPT:-0}"
MIN_NODE_VERSION="22.22.3"
DRY_RUN=0

# Parse arguments: first non-flag arg is the version
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-prompt) DORKOS_NO_PROMPT=1 ;;
    --) ;; # skip separator
    --help)
      echo "Usage: curl -fsSL https://dorkos.ai/install | bash [-s VERSION]"
      echo ""
      echo "Flags (pass after -s --):"
      echo "  --dry-run     Show what would happen without installing"
      echo "  --no-prompt   Skip all interactive prompts (for CI)"
      echo "  --help        Show this help"
      echo ""
      echo "Examples:"
      echo "  curl -fsSL https://dorkos.ai/install | bash"
      echo "  curl -fsSL https://dorkos.ai/install | bash -s 1.2.3"
      echo "  curl -fsSL https://dorkos.ai/install | bash -s -- --dry-run"
      exit 0
      ;;
    *) DORKOS_VERSION="$arg" ;;
  esac
done

# ─── Dependency checks ───────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required but not installed."
  echo ""
  echo "Install Node.js ${MIN_NODE_VERSION} or later from https://nodejs.org"
  echo "Or use nvm:"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "  nvm install 22"
  exit 1
fi

NODE_VERSION=$(node --version | sed 's/^v//')
if ! node -e '
  const parse = (value) => value.split(".").map(Number);
  const current = parse(process.argv[1]);
  const minimum = parse(process.argv[2]);
  for (let i = 0; i < minimum.length; i += 1) {
    if ((current[i] ?? 0) > minimum[i]) process.exit(0);
    if ((current[i] ?? 0) < minimum[i]) process.exit(1);
  }
' "$NODE_VERSION" "$MIN_NODE_VERSION"; then
  echo "Error: Node.js ${MIN_NODE_VERSION} or later is required. Current version: v${NODE_VERSION}"
  echo ""
  echo "Upgrade Node.js: https://nodejs.org"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "Error: npm is required but not found."
  echo "npm is bundled with Node.js — reinstall Node.js from https://nodejs.org"
  exit 1
fi

# ─── Install ──────────────────────────────────────────────────────

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] Would run: npm install -g dorkos@${DORKOS_VERSION}"
  echo "[dry-run] Node.js $(node --version) ✓"
  echo "[dry-run] npm $(npm --version) ✓"
  exit 0
fi

echo "Installing DorkOS..."
echo ""

if [ "$DORKOS_VERSION" = "latest" ]; then
  npm install -g dorkos
else
  npm install -g "dorkos@${DORKOS_VERSION}"
fi

# ─── Verify ───────────────────────────────────────────────────────

if ! command -v dorkos &>/dev/null; then
  echo ""
  echo "Warning: 'dorkos' command not found in PATH after install."
  echo "You may need to restart your terminal or add npm's global bin to PATH."
  echo ""
  echo "Try: export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
  exit 1
fi

# ─── Post-install ─────────────────────────────────────────────────

INSTALLED_VERSION=$(dorkos --version 2>/dev/null || echo "unknown")

echo ""
echo "  DorkOS ${INSTALLED_VERSION} installed successfully."
echo ""
echo "  Start:   dorkos"
echo "  Setup:   dorkos init"
echo "  Docs:    https://dorkos.ai/docs"
echo ""

if [ "$DORKOS_NO_PROMPT" != "1" ] && [ -t 0 ]; then
  printf "Run setup wizard now? (y/N) "
  read -r answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    dorkos init
  fi
fi
