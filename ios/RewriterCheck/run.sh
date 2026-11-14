#!/bin/bash
# Compiles the iOS playlist rewriter (pure Foundation) for the Mac with the
# golden check and runs it: PASS/FAIL, exit status 0/1.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/rustflix-rewritercheck"
[ -n "$OUT" ] || exit 1
xcrun swiftc -O -o "$OUT" main.swift ../Rustflix/StreamPlaylist.swift ../Rustflix/StreamRewriteCheck.swift
"$OUT"
