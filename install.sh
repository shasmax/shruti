#!/bin/bash
# shruti installer — fetches the latest release, builds, and puts `shruti` on PATH.
#
# Usage:
#   curl -fsSL https://github.com/shasmax/shruti/releases/latest/download/install.sh | sh
#
# Env vars:
#   SHRUTI_INSTALL_DIR    where source lives (default ~/.local/share/shruti)
#   SHRUTI_BIN_DIR        where the `shruti` symlink goes (default ~/.local/bin)
#   SHRUTI_VERSION        tag to install (default: latest)

set -euo pipefail

# ---- pretty output ---------------------------------------------------------
if [ -t 1 ]; then
  C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m')
  C_GRN=$(printf '\033[32m'); C_RED=$(printf '\033[31m'); C_RST=$(printf '\033[0m')
else
  C_BOLD=; C_DIM=; C_GRN=; C_RED=; C_RST=
fi
say()  { printf "%s\n" "$*"; }
note() { printf "${C_DIM}%s${C_RST}\n" "$*"; }
ok()   { printf "${C_GRN}✓${C_RST} %s\n" "$*"; }
die()  { printf "${C_RED}✗${C_RST} %s\n" "$*" >&2; exit 1; }

say "${C_BOLD}shruti installer${C_RST}"

# ---- platform check --------------------------------------------------------
case "$(uname -s)" in
  Darwin) ;;
  *) die "shruti currently supports macOS only (you have $(uname -s))." ;;
esac
case "$(uname -m)" in
  arm64) ;;
  *) die "shruti currently supports Apple Silicon (arm64) only. You have $(uname -m). Intel support is on the roadmap." ;;
esac

MACOS_VER=$(sw_vers -productVersion 2>/dev/null || echo "0.0")
MACOS_MAJOR=${MACOS_VER%%.*}
if [ "${MACOS_MAJOR}" -lt 13 ]; then
  die "shruti requires macOS 13 (Ventura) or newer. You're on $MACOS_VER."
fi
ok "macOS $MACOS_VER, arm64"

# ---- prereqs ---------------------------------------------------------------
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing: $1$([ -n "${2:-}" ] && printf ' — %s' "$2")"
}
need_cmd curl
need_cmd tar
need_cmd node "install Node 20+ from https://nodejs.org or via 'brew install node'"
need_cmd npm

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "${NODE_MAJOR}" -lt 20 ]; then
  die "shruti requires Node 20+. You have $(node -v)."
fi

# Swift compiler is OPTIONAL — we prefer to download the prebuilt sidecar
# binary from the GitHub release. If that fails (e.g. user is offline or on
# a tag that doesn't ship one) we fall back to swiftc, which requires Xcode
# Command Line Tools.
HAS_SWIFTC=0
if command -v swiftc >/dev/null 2>&1; then
  HAS_SWIFTC=1
  ok "node $(node -v), npm $(npm -v), swift $(swift -version 2>&1 | head -1 | awk '{print $4}')"
else
  ok "node $(node -v), npm $(npm -v) (swiftc not found — will use prebuilt sidecar)"
fi

# ---- paths -----------------------------------------------------------------
INSTALL_DIR="${SHRUTI_INSTALL_DIR:-$HOME/.local/share/shruti}"
BIN_DIR="${SHRUTI_BIN_DIR:-$HOME/.local/bin}"
VERSION="${SHRUTI_VERSION:-latest}"
REPO="shasmax/shruti"

mkdir -p "$INSTALL_DIR" "$BIN_DIR"

# ---- download tarball ------------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -z "$TAG" ] && die "couldn't resolve latest release tag"
else
  TAG="$VERSION"
fi
say "${C_BOLD}installing ${TAG}${C_RST}"

TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
note "downloading from $TARBALL_URL"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL_URL" | tar -xz -C "$TMP" || die "tarball download failed"

# strip-components=1 equivalent: find the single top-level dir, move its contents
SRC=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)
[ -d "$SRC" ] || die "tarball had unexpected layout"

# Wipe + repopulate INSTALL_DIR cleanly (preserves user's models/cache living elsewhere)
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$SRC/." "$INSTALL_DIR/"
ok "extracted to $INSTALL_DIR"

# ---- install + build -------------------------------------------------------
cd "$INSTALL_DIR"

note "installing dependencies (this takes ~30s)..."
npm install --silent --no-audit --no-fund 2>&1 | tail -3 || die "npm install failed"
ok "dependencies installed"

note "building TypeScript CLI..."
npm run build --silent 2>&1 | tail -3 || die "tsc build failed"
ok "CLI compiled"

# Drop dev deps (TypeScript, electron-builder, vitest, etc.) — runtime only
# needs `commander`. Saves ~150MB on disk after the build.
note "pruning dev dependencies..."
npm prune --omit=dev --silent --no-audit --no-fund 2>&1 | tail -3 || true
ok "pruned"

note "fetching native audio sidecar..."
SIDECAR_URL="https://github.com/$REPO/releases/download/$TAG/shruti-capture"
SIDECAR_DEST="native/macos/shruti-capture"
mkdir -p native/macos
if curl -fsSL "$SIDECAR_URL" -o "$SIDECAR_DEST" 2>/dev/null && [ -s "$SIDECAR_DEST" ]; then
  chmod +x "$SIDECAR_DEST"
  # Sanity-check it's the right architecture
  if file "$SIDECAR_DEST" | grep -q "Mach-O.*arm64"; then
    ok "downloaded prebuilt sidecar (Mach-O arm64)"
  else
    rm -f "$SIDECAR_DEST"
    die "downloaded sidecar is not a valid arm64 binary"
  fi
else
  rm -f "$SIDECAR_DEST"
  if [ "$HAS_SWIFTC" -eq 1 ]; then
    note "prebuilt unavailable, compiling from source..."
    swiftc -O \
      native/macos/ShrutiCapture.swift \
      -o "$SIDECAR_DEST" \
      -framework AVFoundation \
      -framework ScreenCaptureKit \
      -framework CoreMedia 2>&1 | tail -3 || die "Swift compile failed"
    chmod +x "$SIDECAR_DEST"
    ok "compiled sidecar from source"
  else
    die "couldn't download prebuilt sidecar and swiftc is not installed.

    Install Xcode Command Line Tools to enable source compilation:
        xcode-select --install
    Or install the desktop app instead — it ships with the sidecar:
        https://github.com/$REPO/releases/latest"
  fi
fi

# ---- link CLI on PATH ------------------------------------------------------
chmod +x "$INSTALL_DIR/dist/cli.js"
ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_DIR/shruti"
ok "linked $BIN_DIR/shruti → $INSTALL_DIR/dist/cli.js"

# ---- PATH hint -------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "${C_BOLD}Add $BIN_DIR to your PATH:${C_RST}"
    if [ -n "${ZSH_VERSION:-}" ] || [ "${SHELL:-}" = "/bin/zsh" ] || [ -f "$HOME/.zshrc" ]; then
      echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
    else
      echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
    fi
    ;;
esac

echo
ok "${C_BOLD}shruti installed${C_RST}"
echo
echo "Next steps:"
echo "  1. Set your API keys:"
echo "       shruti config set --smallest-key sk_..."
echo "       shruti config set --openrouter-key sk-or-..."
echo "  2. Register the skill with your AI agents:"
echo "       shruti install-skill --auto"
echo "  3. (Optional) Install the GUI app:"
echo "       open https://github.com/$REPO/releases/latest"
