#!/bin/bash
# Sets up Android release signing for CI: decodes the release keystore from
# the environment and writes android/keystore.properties (gitignored) naming
# it and its alias. The passwords are not written anywhere: Gradle reads them
# from RUSTFLIX_UPLOAD_STORE_PASSWORD / RUSTFLIX_UPLOAD_KEY_PASSWORD, which
# the build step sets from the same secrets.
#
# Inputs (environment):
#   ANDROID_KEYSTORE_BASE64    base64 of the keystore file (JKS or PKCS12)
#   ANDROID_KEYSTORE_PASSWORD  the keystore's password
#   ANDROID_KEY_ALIAS          the key's alias
#   ANDROID_KEY_PASSWORD       the key's password (checked for presence only)
#   ALLOW_DEBUG_SIGNING        "true": without the secrets, sign with a
#                              throwaway key made on this runner (test runs only)
#   KEYSTORE_DIR               where the keystore file goes (default $RUNNER_TEMP)
#
# Writes signing=release|debug to $GITHUB_OUTPUT.
set -euo pipefail
cd "$(dirname "$0")/../.."

DIR="${KEYSTORE_DIR:-${RUNNER_TEMP:?}}"
PROPS=android/keystore.properties
OUT="${GITHUB_OUTPUT:-/dev/null}"

missing=()
for v in ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  [ -n "${!v:-}" ] || missing+=("$v")
done

if [ ${#missing[@]} -eq 0 ]; then
  STORE="$DIR/rustflix-release.keystore"
  printf '%s' "$ANDROID_KEYSTORE_BASE64" | tr -d ' \r\n' | base64 --decode >"$STORE"
  chmod 600 "$STORE"
  # Fails early, with a readable message, on a wrong password or alias.
  if ! keytool -list -keystore "$STORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
      -alias "$ANDROID_KEY_ALIAS" >/dev/null 2>&1; then
    echo "::error::The Android keystore from ANDROID_KEYSTORE_BASE64 could not be opened with ANDROID_KEYSTORE_PASSWORD, or has no key named ANDROID_KEY_ALIAS. Check the four ANDROID_* secrets (docs/RELEASING.md)."
    exit 1
  fi
  # The certificate fingerprint is public; it shows which key signed the build.
  keytool -list -v -keystore "$STORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
    -alias "$ANDROID_KEY_ALIAS" 2>/dev/null | grep -E '^[[:space:]]*SHA256:' | sed 's/^[[:space:]]*/signing certificate /' || true
  printf 'storeFile=%s\nkeyAlias=%s\n' "$STORE" "$ANDROID_KEY_ALIAS" >"$PROPS"
  echo "signing=release" >>"$OUT"
  echo "android-signing: release keystore set up"
  exit 0
fi

if [ "${ALLOW_DEBUG_SIGNING:-false}" != "true" ]; then
  echo "::error::Android release signing secrets are missing: ${missing[*]}. A release must always be signed with the same permanent key, or users cannot install updates over it. Add the secrets (docs/RELEASING.md), or run the workflow manually with allow_debug_signing for a throwaway test build."
  exit 1
fi

# Test runs only: a key made here, different on every run. These APKs do
# not install over any other build.
echo "::warning::Signing with a throwaway key generated on this runner (allow_debug_signing). Do not distribute these APKs."
STORE="$DIR/rustflix-throwaway.keystore"
rm -f "$STORE"
keytool -genkeypair -keystore "$STORE" -storetype PKCS12 -alias throwaway \
  -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 30 \
  -dname "CN=rustflix CI throwaway" >/dev/null 2>&1
printf 'storeFile=%s\nkeyAlias=throwaway\nstorePassword=android\nkeyPassword=android\n' "$STORE" >"$PROPS"
echo "signing=debug" >>"$OUT"
