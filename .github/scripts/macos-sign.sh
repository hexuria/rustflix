#!/bin/bash
# Signs rustflix.app and zips it.
#
#   .github/scripts/macos-sign.sh <path/to/rustflix.app> <out.zip>
#
# With a Developer ID certificate in the job keychain (KEYCHAIN, set up by
# apple-keychain.sh): hardened runtime + timestamp, then notarization and
# stapling when notarization credentials are present. Otherwise: ad-hoc
# signature (Gatekeeper warns; the user has to allow the app once).
#
# Inputs (environment, all optional):
#   KEYCHAIN                      the job keychain holding the certificate
#   MACOS_SIGNING_IDENTITY        identity to sign with (default: the first
#                                 "Developer ID Application" in KEYCHAIN)
#   App Store Connect API key (preferred for notarization):
#     APP_STORE_CONNECT_API_KEY_P8_BASE64, APP_STORE_CONNECT_API_KEY_ID,
#     APP_STORE_CONNECT_ISSUER_ID
#   or an Apple ID: APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID
#
# Writes signing=notarized|developer-id|adhoc to $GITHUB_OUTPUT.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="${1:?usage: macos-sign.sh <app> <out.zip>}"
ZIP="${2:?usage: macos-sign.sh <app> <out.zip>}"
ENTITLEMENTS="$PWD/.github/macos/rustflix.entitlements"
OUT="${GITHUB_OUTPUT:-/dev/null}"
[ -d "$APP/Contents/MacOS" ] || { echo "::error::$APP is not an app bundle"; exit 1; }

zipit() { rm -f "$ZIP"; ditto -c -k --norsrc --noextattr --keepParent "$APP" "$ZIP"; }

if [ -z "${KEYCHAIN:-}" ]; then
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
  zipit
  echo "signing=adhoc" >>"$OUT"
  echo "::warning::macOS app is ad-hoc signed (no Developer ID secrets): Gatekeeper will warn on first launch."
  exit 0
fi

IDENTITY="${MACOS_SIGNING_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  # The team's Developer ID (APPLE_TEAM_ID), else the first one there is.
  ids=$(security find-identity -v -p codesigning "$KEYCHAIN" \
    | sed -nE 's/.*"(Developer ID Application:[^"]*)".*/\1/p')
  [ -n "${APPLE_TEAM_ID:-}" ] && IDENTITY=$(printf '%s\n' "$ids" | grep -F "($APPLE_TEAM_ID)" | head -1 || true)
  [ -n "$IDENTITY" ] || IDENTITY=$(printf '%s\n' "$ids" | head -1)
fi
[ -n "$IDENTITY" ] || { echo "::error::No \"Developer ID Application\" identity in MACOS_CERTIFICATE_P12_BASE64 (set MACOS_SIGNING_IDENTITY if it has another name)."; exit 1; }

codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
  --keychain "$KEYCHAIN" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

notary=()
if [ -n "${APP_STORE_CONNECT_API_KEY_P8_BASE64:-}" ] && [ -n "${APP_STORE_CONNECT_API_KEY_ID:-}" ] && [ -n "${APP_STORE_CONNECT_ISSUER_ID:-}" ]; then
  P8="${RUNNER_TEMP:?}/AuthKey_notary.p8"
  printf '%s' "$APP_STORE_CONNECT_API_KEY_P8_BASE64" | tr -d ' \r\n' | base64 --decode >"$P8"
  notary=(--key "$P8" --key-id "$APP_STORE_CONNECT_API_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notary=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi

zipit
if [ ${#notary[@]} -eq 0 ]; then
  echo "signing=developer-id" >>"$OUT"
  echo "::warning::macOS app is Developer ID signed but not notarized (no notarization credentials): Gatekeeper will still warn."
  exit 0
fi

result=$(xcrun notarytool submit "$ZIP" "${notary[@]}" --wait --timeout 45m --output-format json)
status=$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')
id=$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
if [ "$status" != "Accepted" ]; then
  echo "::error::Notarization finished with status '$status'"
  [ -n "$id" ] && xcrun notarytool log "$id" "${notary[@]}" || true
  exit 1
fi
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
zipit
echo "signing=notarized" >>"$OUT"
