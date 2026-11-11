#!/bin/bash
# Archives rustflix for iOS device and exports a TestFlight-ready IPA.
# Requires: NativeShell.xcframework (see README), xcodegen, Xcode,
#           DEVELOPMENT_TEAM in project.yml set to your team.
#
#   ./ios/release.sh            # archive + export IPA to ios/build/ipa/
#
# Upload afterwards (Xcode Organizer, Transporter, or altool) — the app
# record must exist in App Store Connect first (see README "TestFlight").
set -euo pipefail
cd "$(dirname "$0")"

./sync-bundle.sh --release
xcodegen generate

xcodebuild -project rustflix.xcodeproj -scheme rustflix \
  -configuration Release \
  -archivePath build/Rustflix.xcarchive \
  -allowProvisioningUpdates archive

xcodebuild -exportArchive \
  -archivePath build/Rustflix.xcarchive \
  -exportOptionsPlist exportOptions.plist \
  -exportPath build/ipa \
  -allowProvisioningUpdates

echo "IPA: ios/build/ipa/rustflix.ipa"
