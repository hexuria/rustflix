#!/bin/bash
# Builds the rustflix Rust host (which bundles app/ via build.rs) and copies
# the NSH app output into the iOS target's resources as `nsh/`.
set -euo pipefail
cd "$(dirname "$0")/.."

# Subtitle service keys are baked into the bundle by build.rs. They live in
# the macOS Keychain (`secret set WYZIE_API_KEY`, `secret set SUBDL_API_KEY`),
# never in the repo; a build without them simply ships no keys.
if command -v secret >/dev/null 2>&1; then
  : "${WYZIE_API_KEY:=$(secret get WYZIE_API_KEY 2>/dev/null || true)}"
  : "${SUBDL_API_KEY:=$(secret get SUBDL_API_KEY 2>/dev/null || true)}"
  export WYZIE_API_KEY SUBDL_API_KEY
fi

cargo build "$@"

# build.rs writes $OUT_DIR/app; OUT_DIR lives under the cargo target dir,
# which may be shared (~/.cargo/targets/<project>-<hash>) rather than ./target.
# A shared target dir keeps the output of earlier builds (other checkouts,
# other versions of app/) beside this one: the newest bundle is ours.
OUT=""
PROFILE=debug
for a in "$@"; do [ "$a" = "--release" ] && PROFILE=release; done
NSHC=$(find target/"$PROFILE"/build "$HOME"/.cargo/targets/rustflix-*/"$PROFILE"/build \
  -path '*/out/app/bundle.nshc' 2>/dev/null | xargs ls -t 2>/dev/null | head -1 || true)
[ -n "$NSHC" ] && OUT=$(dirname "$NSHC")
if [ -z "$OUT" ] || [ ! -f "$OUT/bundle.nshc" ]; then
  echo "sync-bundle: bundle.nshc not found" >&2
  exit 1
fi

DEST="ios/Rustflix/nsh"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$OUT"/. "$DEST"/
echo "sync-bundle: $OUT -> $DEST"
ls "$DEST"
