#!/usr/bin/env bash
# Re-install the built plugin into MiniMax Code's local plugin directory.
#
# A copy (not a symlink) is required: the host's local-plugin scanner skips
# symlinked directories silently, so a symlink looks installed but never loads.
# That makes this script the way to push a rebuild — `pnpm build && pnpm sync`.
#
# node_modules and .git are excluded from the copy: the bundle in dist/ is
# self-contained, so the installed copy never needs them, and piping through
# tar keeps the copy fast even in a large working tree.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST="${MINIMAX_PLUGIN_DIR:-$HOME/.minimax/plugins}/litefuse-observability"

[ -f "$REPO/dist/index.mjs" ] || { echo "dist/index.mjs missing — run 'pnpm build' first" >&2; exit 1; }

mkdir -p "$(dirname -- "$DEST")"
STAGE="$DEST.tmp.$$"
trap 'rm -rf -- "$STAGE"' EXIT
mkdir -p -- "$STAGE"
# .gitignore does not apply to this copy — exclude local-only files explicitly:
# DEV-REPORT.md (internal hostnames) and any real litefuse.json (credentials).
tar -C "$REPO" \
  --exclude=./node_modules --exclude=./.git --exclude=.DS_Store \
  --exclude=./DEV-REPORT.md --exclude=./litefuse.json \
  -cf - . | tar -C "$STAGE" -xf -
# BSD mv has no --no-target-directory: if DEST already exists, `mv STAGE DEST`
# would nest STAGE *inside* it. Remove the previous install first.
rm -rf -- "$DEST"
mv -- "$STAGE" "$DEST"

echo "installed -> $DEST"
echo "restart mcode (or open a new session) to pick it up"
