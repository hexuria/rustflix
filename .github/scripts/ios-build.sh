#!/bin/bash
# Archives rustflix for iOS devices and exports a signed IPA with manual
# signing (CI has no Xcode account for automatic signing). The bundle and
# project steps are ios/release.sh's.
#
#   .github/scripts/ios-build.sh <out.ipa>
#
# Inputs (environment):
#   KEYCHAIN                         job keychain with the distribution cert (apple-keychain.sh)
#   IOS_PROVISIONING_PROFILE_BASE64  base64 of the .mobileprovision for com.hexuria.rustflix
#   IOS_SIGNING_IDENTITY             optional, default "Apple Distribution"
# NativeShell.xcframework must already be at ../_research/nsh/dist/nsh/embed/ios
# (ios/project.yml's path); WYZIE_API_KEY / SUBDL_API_KEY as for every build.
#
# The export method follows the profile: one with a device list is ad hoc
# (release-testing), one without is App Store Connect.
set -euo pipefail
cd "$(dirname "$0")/../.."

IPA_OUT="${1:?usage: ios-build.sh <out.ipa>}"
: "${KEYCHAIN:?}" "${IOS_PROVISIONING_PROFILE_BASE64:?}"
IDENTITY="${IOS_SIGNING_IDENTITY:-Apple Distribution}"
WORK="${RUNNER_TEMP:?}/ios"
rm -rf "$WORK"
mkdir -p "$WORK"

# --- The provisioning profile ----------------------------------------------------
PROFILE="$WORK/profile.mobileprovision"
printf '%s' "$IOS_PROVISIONING_PROFILE_BASE64" | tr -d ' \r\n' | base64 --decode >"$PROFILE"
security cms -D -i "$PROFILE" >"$WORK/profile.plist"
pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$WORK/profile.plist" 2>/dev/null; }
UUID=$(pb UUID)
TEAM=$(pb TeamIdentifier:0)
APP_ID=$(pb Entitlements:application-identifier)
[ -n "$UUID" ] && [ -n "$TEAM" ] || { echo "::error::IOS_PROVISIONING_PROFILE_BASE64 is not a readable provisioning profile"; exit 1; }
if [ "$APP_ID" != "$TEAM.com.hexuria.rustflix" ] && [ "$APP_ID" != "$TEAM.*" ]; then
  echo "::error::The provisioning profile is for '$APP_ID', not $TEAM.com.hexuria.rustflix"
  exit 1
fi
if pb ProvisionedDevices >/dev/null; then METHOD=release-testing; else METHOD=app-store-connect; fi
echo "ios-build: profile $(pb Name) ($UUID), team $TEAM, export method $METHOD"
for d in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
  mkdir -p "$d"
  cp "$PROFILE" "$d/$UUID.mobileprovision"
done

# --- Bundle and project (as ios/release.sh) --------------------------------------
./ios/sync-bundle.sh --release
(cd ios && xcodegen generate)

# --- Archive and export ----------------------------------------------------------
xcodebuild -project ios/rustflix.xcodeproj -scheme rustflix \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$WORK/Rustflix.xcarchive" \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_IDENTITY="$IDENTITY" PROVISIONING_PROFILE_SPECIFIER="$UUID" \
  OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN" \
  archive

cat >"$WORK/exportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>$METHOD</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$IDENTITY</string>
  <key>provisioningProfiles</key>
  <dict><key>com.hexuria.rustflix</key><string>$UUID</string></dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive -archivePath "$WORK/Rustflix.xcarchive" \
  -exportOptionsPlist "$WORK/exportOptions.plist" -exportPath "$WORK/ipa"
IPA=$(find "$WORK/ipa" -maxdepth 1 -name '*.ipa' | head -1)
[ -n "$IPA" ] || { echo "::error::xcodebuild -exportArchive wrote no .ipa"; exit 1; }
mkdir -p "$(dirname "$IPA_OUT")"
cp "$IPA" "$IPA_OUT"
echo "method=$METHOD" >>"${GITHUB_OUTPUT:-/dev/null}"
echo "ios-build: $IPA_OUT"
