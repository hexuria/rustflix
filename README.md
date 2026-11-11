# rustflix

A native streaming app: **Rust + GPUI + NSH**. Reverse-engineered from
[Streambert](https://github.com/truelockmc/streambert) — browse movies,
TV and anime (TMDB + AniList), pick an embed playback source, keep a
watchlist and continue-watching progress. No ads, no trackers.

The UI is a TSX app (`app/`) running on
[NSH](https://github.com/longbridge/nsh) inside a GPUI window
(`nsh-platform-gpui`); `build.rs` bundles it like `nsh build` does.
See `docs/REVERSE-ENGINEERING.md` for the feature map.

## Run

```sh
cargo run            # builds app/ and opens the window
cargo run -- path/to/bundle.nshc   # run another bundle
```

First run: add a free TMDB API key (v3 key or v4 read access token) in
Settings or the setup screen.

## Layout

- `src/main.rs` — thin GPUI shell (`run_app`)
- `build.rs` — NSH bundler + QuickJS bytecode pipeline
- `app/` — the TSX interface
  - `lib/tmdb.ts` — TMDB client + image URLs
  - `lib/anilist.ts` — AniList GraphQL client
  - `lib/sources.ts` — player embed sources (ported from Streambert)
  - `lib/store.ts` — watchlist / progress / settings (`nsh/storage`)
  - `lib/router.ts` — signal router
  - `screens/` — Home, Search, Title, Player, Library, Settings, Setup

## Packaging

### macOS

```sh
./package-macos.sh [output-dir]   # default: ~/Applications
```

Builds the release binary, bundles `app/` into
`Contents/Resources/nsh/` (the binary finds it relative to the
executable; the dev `OUT_DIR` copy remains the fallback), writes
`Info.plist`, embeds the icon and ad-hoc signs. For distribution,
re-sign with a Developer ID certificate and notarize.

### iOS

The iOS app embeds the same `app/` bundle in NSH's UIKit runtime
(`NativeShell.xcframework`), not the GPUI backend.

```sh
# 1. NSH iOS runtime (once, in a checkout of github.com/longbridge/nsh)
cd <nsh checkout> && cargo xtask ios-embed --no-dev
#    -> dist/nsh/embed/ios/NativeShell.xcframework

# 2. rustflix bundle -> ios/Rustflix/nsh/
./ios/sync-bundle.sh

# 3. Xcode project (xcodegen) and build — ./ios/build.sh does all of
#    steps 2+3 and picks an available iPhone simulator automatically
./ios/build.sh            # or: ./ios/build.sh 'platform=iOS Simulator,name=iPhone 17'
```

`ios/project.yml` points at the xcframework in the NSH checkout;
adjust the path or copy the framework into `ios/Frameworks/`.
Subprocess downloads are desktop-only and hide themselves on iOS.

### TestFlight

`ios/release.sh` syncs the release bundle, regenerates the project and
produces a distribution-signed IPA at `ios/build/ipa/rustflix.ipa`
(archive + export via `ios/exportOptions.plist`, team `5KZ8MD34QW`).

One-time App Store Connect setup:

1. https://appstoreconnect.apple.com → **Apps → + → New App**
   - Platform: iOS · Name: `rustflix` · Bundle ID: `com.hexuria.rustflix`
     (registered automatically the first time Xcode signed the app)
   - SKU: any unique string, e.g. `rustflix-ios`
2. Upload the IPA — any of:
   - **Transporter** app (free, Mac App Store): drag `rustflix.ipa` in.
   - **Xcode**: Window → Organizer → select the archive → Distribute App.
   - CLI: `xcrun altool --upload-app -f ios/build/ipa/rustflix.ipa
     --apiKey <KeyID> --apiIssuer <IssuerID>` (keys in
     `~/.private_keys/`; issuer ID is in App Store Connect →
     Users and Access → Integrations).
3. Wait ~5–15 min for processing (email arrives), then
   **TestFlight → rustflix → Testers**: add yourself (internal testers
   need no review) or external groups (first build needs a short
   beta review).

For each new upload bump `CURRENT_PROJECT_VERSION` in `ios/project.yml`
(App Store rejects reused build numbers).
