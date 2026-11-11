#!/bin/bash
# Builds rustflix (release) and assembles rustflix.app.
# Usage: ./scripts-package-macos.sh [output-dir]   (default: ~/Applications)
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release

# build.rs writes $OUT_DIR/app; find it under the cargo target dir.
OUT=""
for base in target "$HOME"/.cargo/targets/rustflix-*; do
  cand=$(find "$base/release" -type d -path "*rustflix-*/out/app" 2>/dev/null | head -1)
  if [ -n "$cand" ] && [ -f "$cand/bundle.nshc" ]; then OUT="$cand"; break; fi
done
[ -n "$OUT" ] || { echo "bundle.nshc not found" >&2; exit 1; }

BIN=""
for base in target/release "$HOME"/.cargo/targets/rustflix-*/release; do
  [ -f "$base/rustflix" ] && BIN="$base/rustflix" && break
done
[ -n "$BIN" ] || BIN=$(find target/release "$HOME"/.cargo/targets/rustflix-*/release -maxdepth 1 -name rustflix -type f 2>/dev/null | head -1)
[ -n "$BIN" ] || { echo "release binary not found" >&2; exit 1; }

DEST="${1:-$HOME/Applications}/rustflix.app"
rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"
cp "$BIN" "$DEST/Contents/MacOS/rustflix"
cp -R "$OUT" "$DEST/Contents/Resources/nsh"

# Icon: generated once into /tmp; regenerate with ios/icon tooling if missing.
ICNS="${ICNS:-/tmp/rustflix.icns}"
[ -f "$ICNS" ] && cp "$ICNS" "$DEST/Contents/Resources/rustflix.icns"

cat > "$DEST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>rustflix</string>
  <key>CFBundleIdentifier</key><string>com.hexuria.rustflix</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>rustflix</string>
  <key>CFBundleDisplayName</key><string>rustflix</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>rustflix</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$DEST" 2>/dev/null || true
echo "packaged $DEST"
