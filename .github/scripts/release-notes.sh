#!/bin/bash
# Writes the release notes (Markdown) to stdout and SHA256SUMS.txt into the
# artifact directory.
#
#   .github/scripts/release-notes.sh <artifact-dir>
#
# Inputs (environment): CHANNEL (tag|latest), RELEASE_TAG, VERSION, BUILD,
# GITHUB_SHA, GITHUB_REPOSITORY, and the jobs' outcomes:
#   ANDROID_RESULT MACOS_RESULT IOS_RESULT   success|failure|cancelled|skipped
#   ANDROID_SIGNING  release|debug          MACOS_SIGNING  notarized|developer-id|adhoc
#   IOS_STATUS       built|no-secrets       IOS_METHOD     app-store-connect|release-testing
# Needs the full history (checkout fetch-depth: 0) for the commit list.
set -euo pipefail

DIR="${1:?usage: release-notes.sh <artifact-dir>}"
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
REPO="${GITHUB_REPOSITORY:-hexuria/rustflix}"

# Checksums of everything that will be attached.
(
  cd "$DIR"
  files=()
  while IFS= read -r f; do files+=("$f"); done < <(find . -maxdepth 1 -type f ! -name SHA256SUMS.txt -exec basename {} \; | LC_ALL=C sort)
  if [ ${#files[@]} -gt 0 ]; then shasum -a 256 "${files[@]}" >SHA256SUMS.txt; fi
)

# The previous version tag: before this tag for a tag build, the newest
# reachable one for `latest`.
if [ "${CHANNEL:-}" = "tag" ]; then
  PREV=$(git describe --tags --abbrev=0 --match 'v*' "$SHA^" 2>/dev/null || true)
else
  PREV=$(git describe --tags --abbrev=0 --match 'v*' "$SHA" 2>/dev/null || true)
fi
RANGE="$SHA"
[ -n "$PREV" ] && RANGE="$PREV..$SHA"

status() {
  case "$1" in
    success) echo "built" ;;
    skipped) echo "not built in this run" ;;
    cancelled) echo "cancelled" ;;
    *) echo "**failed**" ;;
  esac
}

if [ "${CHANNEL:-}" = "latest" ]; then
  echo "Rolling build of \`main\` at ${SHA:0:12}: rustflix ${VERSION:?} (build ${BUILD:?}). Replaced on every push to \`main\`; for a fixed version use a \`v*\` release."
else
  echo "rustflix ${VERSION:?} (build ${BUILD:?}), commit ${SHA:0:12}."
fi
echo
echo "## Downloads"
echo
echo "| Target | Status | Notes |"
echo "| --- | --- | --- |"

a_note="Per-ABI APKs: \`arm64-v8a\` for nearly all phones, \`armeabi-v7a\` for old 32-bit ones. The \`.aab\` is for Google Play."
[ "${ANDROID_SIGNING:-}" = "debug" ] && a_note="**Signed with a throwaway test key**: will not install over other builds. $a_note"
echo "| Android | $(status "${ANDROID_RESULT:-skipped}") | $a_note |"

case "${MACOS_SIGNING:-}" in
  notarized) m_note="Apple silicon. Developer ID signed and notarized." ;;
  developer-id) m_note="Apple silicon. Developer ID signed but not notarized: Gatekeeper asks before the first launch." ;;
  *) m_note="Apple silicon. **Ad-hoc signed, not notarized**: macOS blocks the first launch. Unzip, move \`rustflix.app\` to Applications, then right-click it → Open (or run \`xattr -dr com.apple.quarantine /Applications/rustflix.app\`)." ;;
esac
echo "| macOS | $(status "${MACOS_RESULT:-skipped}") | $m_note |"

if [ "${IOS_RESULT:-skipped}" = "success" ] && [ "${IOS_STATUS:-}" != "built" ]; then
  echo "| iOS | not built | No iOS signing secrets on the repository. |"
else
  if [ "${IOS_METHOD:-}" = "release-testing" ]; then i_note="Ad hoc: installs only on the devices in its provisioning profile."; else i_note="App Store signed: for TestFlight / App Store Connect, not for direct install."; fi
  echo "| iOS | $(status "${IOS_RESULT:-skipped}") | $i_note |"
fi

echo
echo "## Changes${PREV:+ since $PREV}"
echo
count=$(git rev-list --count "$RANGE")
git log --no-merges --format='- %s (%h)' -n 200 "$RANGE"
[ "$count" -gt 200 ] && echo "- … and $((count - 200)) more"
[ -n "$PREV" ] && { echo; echo "Full diff: https://github.com/$REPO/compare/$PREV...${SHA:0:12}"; }

if [ -f "$DIR/SHA256SUMS.txt" ]; then
  echo
  echo "## SHA-256"
  echo
  echo '```'
  cat "$DIR/SHA256SUMS.txt"
  echo '```'
fi
