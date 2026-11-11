#!/bin/bash
# Builds the rustflix Rust host (which bundles app/ via build.rs) and copies
# the NSH app output into the iOS target's resources as `nsh/`.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build "$@"

# build.rs writes $OUT_DIR/app; OUT_DIR lives under the cargo target dir,
# which may be shared (~/.cargo/targets/<project>-<hash>) rather than ./target.
OUT=""
PROFILE=debug
for a in "$@"; do [ "$a" = "--release" ] && PROFILE=release; done
for base in target "$HOME"/.cargo/targets/rustflix-*; do
  cand=$(find "$base/$PROFILE" -type d -path "*rustflix-*/out/app" 2>/dev/null | head -1)
  if [ -n "$cand" ] && [ -f "$cand/bundle.nshc" ]; then OUT="$cand"; break; fi
done
if [ -z "$OUT" ]; then
  echo "sync-bundle: bundle.nshc not found" >&2
  exit 1
fi

DEST="ios/Rustflix/nsh"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$OUT"/. "$DEST"/
echo "sync-bundle: $OUT -> $DEST"
ls "$DEST"
