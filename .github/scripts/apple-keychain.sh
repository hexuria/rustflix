#!/bin/bash
# Imports a signing certificate (.p12) into a temporary keychain for this
# job and puts it first in the search list, so codesign / xcodebuild find it.
#
# Inputs (environment):
#   P12_BASE64    base64 of the .p12 (certificate + private key)
#   P12_PASSWORD  the .p12's export password
# Writes keychain=<path> to $GITHUB_OUTPUT. Remove it afterwards with
# `security delete-keychain <path>` (the runner is discarded anyway).
set -euo pipefail

: "${P12_BASE64:?}" "${P12_PASSWORD:?}"
TMP="${RUNNER_TEMP:?}"
KC="$TMP/rustflix-signing.keychain-db"
KC_PASS=$(openssl rand -hex 24)
echo "::add-mask::$KC_PASS"

P12="$TMP/rustflix-signing.p12"
printf '%s' "$P12_BASE64" | tr -d ' \r\n' | base64 --decode >"$P12"

security delete-keychain "$KC" >/dev/null 2>&1 || true
security create-keychain -p "$KC_PASS" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KC_PASS" "$KC"
if ! security import "$P12" -k "$KC" -P "$P12_PASSWORD" -f pkcs12 \
    -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild >/dev/null; then
  rm -f "$P12"
  echo "::error::Could not import the signing certificate: check the .p12 secret and its password (docs/RELEASING.md)."
  exit 1
fi
rm -f "$P12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KC" >/dev/null
# This keychain first, then the existing user search list.
existing=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line//\"/}"
  [ -n "$line" ] && existing+=("$line")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$KC" "${existing[@]}"

echo "signing identities in the job keychain:"
security find-identity -v -p codesigning "$KC" | sed -E 's/[0-9A-F]{40}/<sha1>/'
echo "keychain=$KC" >>"${GITHUB_OUTPUT:-/dev/null}"
