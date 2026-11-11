#!/bin/bash
# Syncs the NSH bundle and builds the iOS app for the simulator.
# Requires: NativeShell.xcframework at ../../_research/nsh/dist/nsh/embed/ios/
# (or adjust the framework path in project.yml), xcodegen, Xcode.
set -euo pipefail
cd "$(dirname "$0")"

./sync-bundle.sh
xcodegen generate

# Default: first available iPhone simulator; pass a full -destination as $1.
if [ $# -ge 1 ]; then
  DEST="$1"
else
  SIM_NAME=$(xcrun simctl list devices available -j \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["name"] for v in d["devices"].values() for x in v if "iPhone" in x["name"]))')
  DEST="platform=iOS Simulator,name=$SIM_NAME"
fi

xcodebuild -project rustflix.xcodeproj -scheme rustflix \
  -destination "$DEST" -configuration Debug build
