#!/usr/bin/env bash
# Re-install the built plugin into MiniMax Code's local plugin directory.
#
# A copy (not a symlink) is required: the host's local-plugin scanner skips
# symlinked directories silently, so a symlink looks installed but never loads.
# That makes this script the way to push a rebuild — `pnpm build && pnpm sync`.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST="${MINIMAX_PLUGIN_DIR:-$HOME/.minimax/plugins}/litefuse-observability"

[ -f "$REPO/dist/index.mjs" ] || { echo "dist/index.mjs missing — run 'pnpm build' first" >&2; exit 1; }

mkdir -p "$(dirname -- "$DEST")"
STAGE="$DEST.tmp.$$"
trap 'rm -rf -- "$STAGE"' EXIT
cp -R "$REPO" "$STAGE"
rm -rf -- "$STAGE/node_modules" "$STAGE/.git"
mv -- "$STAGE" "$DEST"

echo "installed -> $DEST"
echo "restart mcode (or open a new session) to pick it up"
