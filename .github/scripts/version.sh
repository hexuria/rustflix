#!/bin/bash
# Reads the app version from ios/project.yml (the single source: Android's
# versionName / versionCode come from the same two settings) and decides
# where this run publishes.
#
#   .github/scripts/version.sh
#
# Inputs (environment): GITHUB_REF, GITHUB_EVENT_NAME, PUBLISH (dispatch
# input, "true"/"false"). Writes version, build, channel, release_tag and
# prefix to $GITHUB_OUTPUT (stdout when unset).
#
# channel: "tag"    a v* tag push   -> release named after the tag
#          "latest" a push to main  -> the rolling `latest` pre-release
#          "none"   anything else (dispatch without publish): artifacts only
set -euo pipefail
cd "$(dirname "$0")/../.."

setting() {
  # Same pattern android/app/build.gradle.kts uses: `NAME: "value"`.
  sed -nE "s/^[[:space:]]*$1:[[:space:]]*\"?([^\"[:space:]]+)\"?.*/\1/p" ios/project.yml | head -1
}

VERSION=$(setting MARKETING_VERSION)
BUILD=$(setting CURRENT_PROJECT_VERSION)
[ -n "$VERSION" ] || { echo "::error::ios/project.yml has no MARKETING_VERSION"; exit 1; }
[ -n "$BUILD" ] || { echo "::error::ios/project.yml has no CURRENT_PROJECT_VERSION"; exit 1; }
case "$BUILD" in *[!0-9]*) echo "::error::CURRENT_PROJECT_VERSION must be an integer (Android versionCode), got '$BUILD'"; exit 1 ;; esac

REF="${GITHUB_REF:-}"
EVENT="${GITHUB_EVENT_NAME:-}"
case "$REF" in
  refs/tags/v*)
    TAG="${REF#refs/tags/}"
    if [ "$TAG" != "v$VERSION" ]; then
      echo "::error::Tag $TAG does not match MARKETING_VERSION $VERSION in ios/project.yml. Bump MARKETING_VERSION to ${TAG#v} (and CURRENT_PROJECT_VERSION), commit, and tag that commit, or tag v$VERSION instead."
      exit 1
    fi
    CHANNEL=tag
    RELEASE_TAG="$TAG"
    ;;
  refs/heads/main)
    if [ "$EVENT" = "push" ] || [ "${PUBLISH:-false}" = "true" ]; then CHANNEL=latest; else CHANNEL=none; fi
    RELEASE_TAG=latest
    ;;
  *)
    if [ "${PUBLISH:-false}" = "true" ]; then
      echo "::error::publish is only allowed from main or a v* tag (this run is on $REF)"
      exit 1
    fi
    CHANNEL=none
    RELEASE_TAG=""
    ;;
esac

OUT="${GITHUB_OUTPUT:-/dev/stdout}"
{
  echo "version=$VERSION"
  echo "build=$BUILD"
  echo "channel=$CHANNEL"
  echo "release_tag=$RELEASE_TAG"
  echo "prefix=rustflix-$VERSION-$BUILD"
} >>"$OUT"
echo "rustflix $VERSION ($BUILD), channel $CHANNEL${RELEASE_TAG:+, release $RELEASE_TAG}" >&2
