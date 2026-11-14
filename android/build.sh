#!/bin/bash
# Builds the rustflix Android app: the NSH runtime for the Android ABIs,
# the app's bundle (app/ via the Rust build's build.rs, as ios/sync-bundle.sh
# does), then an APK / AAB with Gradle.
#
#   android/build.sh                 debug APK, all ABIs (debug key)
#   android/build.sh release         release APK + AAB (needs android/keystore.properties to be signed)
#   android/build.sh release-splits  release, one APK per ABI
#   ABIS=arm64-v8a android/build.sh  only these ABIs (comma-separated)
#   SKIP_RUNTIME=1 android/build.sh  reuse the staged NSH runtime
#   INSTALL=1 android/build.sh       then adb install -r and launch
#
# Requires: the NSH repository (NSH_DIR, default ../_research/nsh next to this
# repo) with its Rust toolchain targets, the Android SDK (ANDROID_HOME) with
# platforms;android-36, build-tools and the NDK, and a JDK (JAVA_HOME).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
ANDROID_DIR="$ROOT/android"
MODE="${1:-debug}"
case "$MODE" in debug|release|release-splits) ;; *) echo "usage: $0 [debug|release|release-splits]" >&2; exit 2;; esac

NSH_DIR="${NSH_DIR:-$ROOT/../_research/nsh}"
ABIS="${ABIS:-arm64-v8a,armeabi-v7a,x86_64}"
RUNTIME="$ANDROID_DIR/nsh-runtime"
ASSETS="$ANDROID_DIR/app/src/main/assets/nsh"

# --- 1. The NSH runtime: libnsh.so per ABI and the Java runtime -------------------
# `cargo xtask android --release` in the NSH repo writes target/android/release/
# {classes.jar, classes.dex, lib/<abi>/libnsh.so (stripped), symbols/<abi>/libnsh.so}.
if [ "${SKIP_RUNTIME:-0}" != "1" ]; then
  [ -f "$NSH_DIR/crates/nsh-platform-android/Cargo.toml" ] || { echo "build.sh: NSH repo not found at $NSH_DIR (set NSH_DIR)" >&2; exit 1; }
  abi_args=()
  IFS=, read -ra abi_list <<<"$ABIS"
  for a in "${abi_list[@]}"; do abi_args+=(--abi "$a"); done
  (cd "$NSH_DIR" && cargo xtask android --release "${abi_args[@]}")
  BUILT="$NSH_DIR/target/android/release"
  [ -n "$RUNTIME" ] && [ "$RUNTIME" != "/" ] || exit 1
  rm -rf "$RUNTIME"
  mkdir -p "$RUNTIME/jni"
  cp "$BUILT/classes.jar" "$RUNTIME/classes.jar"
  for a in "${abi_list[@]}"; do
    mkdir -p "$RUNTIME/jni/$a"
    # With symbols: Gradle strips what it packages and keeps the symbols
    # for Play Console (native-debug-symbols.zip).
    cp "$BUILT/symbols/$a/libnsh.so" "$RUNTIME/jni/$a/libnsh.so"
  done
fi
[ -f "$RUNTIME/classes.jar" ] || { echo "build.sh: no staged NSH runtime in $RUNTIME (run without SKIP_RUNTIME)" >&2; exit 1; }

# --- 1b. The downloader: src/dl as librustflix_dl.so (android/rustflix-dl) ---------
# Built with the NDK's clang for each ABI, 16 KB pages; staged with symbols
# (Gradle strips what it packages) in android/dl-runtime/jni/<abi>/.
NDK="${ANDROID_NDK_HOME:-$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/ndk/* | sort -V | tail -1)}"
TC="$NDK/toolchains/llvm/prebuilt/darwin-x86_64"
[ -x "$TC/bin/llvm-ar" ] || { echo "build.sh: no NDK toolchain at $TC" >&2; exit 1; }
DL_RUNTIME="$ANDROID_DIR/dl-runtime"
[ -n "$DL_RUNTIME" ] && [ "$DL_RUNTIME" != "/" ] || exit 1
rm -rf "$DL_RUNTIME"
IFS=, read -ra dl_abis <<<"$ABIS"
for a in "${dl_abis[@]}"; do
  case "$a" in
    arm64-v8a) triple=aarch64-linux-android; clang=aarch64-linux-android ;;
    armeabi-v7a) triple=armv7-linux-androideabi; clang=armv7a-linux-androideabi ;;
    x86_64) triple=x86_64-linux-android; clang=x86_64-linux-android ;;
    *) echo "build.sh: unsupported ABI $a" >&2; exit 1 ;;
  esac
  env_triple=${triple//-/_}
  upper=$(echo "$env_triple" | tr '[:lower:]' '[:upper:]')
  (cd "$ANDROID_DIR/rustflix-dl" && env \
    "CC_$env_triple=$TC/bin/${clang}26-clang" \
    "AR_$env_triple=$TC/bin/llvm-ar" \
    "CARGO_TARGET_${upper}_LINKER=$TC/bin/${clang}26-clang" \
    "CARGO_TARGET_${upper}_RUSTFLAGS=-C link-arg=-Wl,-z,max-page-size=16384" \
    cargo build --release --target "$triple")
  mkdir -p "$DL_RUNTIME/jni/$a"
  cp "$ANDROID_DIR/rustflix-dl/target/$triple/release/librustflix_dl.so" "$DL_RUNTIME/jni/$a/"
done

# --- 2. The app bundle (bundle.nshc, app.json, capabilities.json, assets/) ---------
# Subtitle keys come from the Keychain exactly as ios/sync-bundle.sh reads them;
# build.rs bakes them into the bundle. Never echoed.
if command -v secret >/dev/null 2>&1; then
  : "${WYZIE_API_KEY:=$(secret get WYZIE_API_KEY 2>/dev/null || true)}"
  : "${SUBDL_API_KEY:=$(secret get SUBDL_API_KEY 2>/dev/null || true)}"
  export WYZIE_API_KEY SUBDL_API_KEY
fi
PROFILE=debug
CARGO_ARGS=()
if [ "$MODE" != "debug" ]; then PROFILE=release; CARGO_ARGS=(--release); fi
cargo build ${CARGO_ARGS[@]+"${CARGO_ARGS[@]}"}

# build.rs writes $OUT_DIR/app under the cargo target dir, which may be
# shared (~/.cargo/targets/<project>-<hash>) rather than ./target: the
# newest one wins.
# (build/rustflix-<hash>/out or, with cargo's newer layout, build/rustflix/<hash>/out).
OUT=""
NSHC=$(find target/"$PROFILE"/build "$HOME"/.cargo/targets/rustflix-*/"$PROFILE"/build \
  -path '*/out/app/bundle.nshc' 2>/dev/null | xargs ls -t 2>/dev/null | head -1 || true)
[ -n "$NSHC" ] && OUT=$(dirname "$NSHC")
[ -n "$OUT" ] && [ -f "$OUT/bundle.nshc" ] || { echo "build.sh: bundle.nshc not found (target/$PROFILE or ~/.cargo/targets/rustflix-*/$PROFILE)" >&2; exit 1; }
[ -n "$ASSETS" ] && [ "$ASSETS" != "/" ] || exit 1
rm -rf "$ASSETS"
mkdir -p "$ASSETS"
cp -R "$OUT"/. "$ASSETS"/
# Not needed at run time (bytecode runs); keeps the source out of the APK.
rm -f "$ASSETS/bundle.js" "$ASSETS/bundle.js.map"
echo "build.sh: bundle $OUT -> android/app/src/main/assets/nsh"

# --- 3. Gradle ---------------------------------------------------------------------
# Upload-key passwords for release signing (android/keystore.properties names
# the keystore and alias): from the Keychain, never echoed.
if [ "$MODE" != "debug" ] && command -v secret >/dev/null 2>&1; then
  : "${RUSTFLIX_UPLOAD_STORE_PASSWORD:=$(secret get RUSTFLIX_UPLOAD_STORE_PASSWORD 2>/dev/null || true)}"
  : "${RUSTFLIX_UPLOAD_KEY_PASSWORD:=$(secret get RUSTFLIX_UPLOAD_KEY_PASSWORD 2>/dev/null || true)}"
  export RUSTFLIX_UPLOAD_STORE_PASSWORD RUSTFLIX_UPLOAD_KEY_PASSWORD
fi
cd "$ANDROID_DIR"
GRADLE_ARGS=(-Pabis="$ABIS")
case "$MODE" in
  debug)          ./gradlew "${GRADLE_ARGS[@]}" assembleDebug ;;
  release)        ./gradlew "${GRADLE_ARGS[@]}" assembleRelease bundleRelease ;;
  release-splits) ./gradlew "${GRADLE_ARGS[@]}" -PabiSplits assembleRelease bundleRelease ;;
esac
echo "build.sh: outputs:"
find app/build/outputs \( -name '*.apk' -o -name '*.aab' \) -exec ls -l {} \;

if [ "${INSTALL:-0}" = "1" ]; then
  APK=$(ls -t app/build/outputs/apk/*/*.apk | head -1)
  adb install -r "$APK"
  adb shell am start -n com.hexuria.rustflix/.MainActivity
fi
