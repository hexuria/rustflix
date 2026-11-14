# rustflix

A native app for browsing and watching movies, TV and anime on macOS,
iPhone/iPad and Android, built from one TSX interface.

<img alt="rustflix on macOS, iPhone and Android" src="https://github.com/user-attachments/assets/ec9af80f-b955-43b6-ab6f-cc327068f3fa" width="100%" />

Quick start on a Mac with Rust installed:

```sh
git clone https://github.com/hexuria/rustflix && cd rustflix
cargo run
```

See [Requirements and setup](#requirements-and-setup) for keys and the
phone builds.

## What it does

- **Browse** trending, now playing, popular, top-rated and upcoming titles from
  TMDB, and trending anime from AniList.
- **Search** across TMDB (movies and TV) and AniList (anime).
- **My List** and **Continue Watching**, kept on the device.
- **Title pages** with details, seasons and episodes.
- **A player with its own controls**: a source picker with automatic
  fallback to the next source, an episode picker, playback speed
  (0.5x to 2x), an audio and subtitles panel with online subtitle search,
  skip intro/credits for anime (AniSkip), picture-in-picture where the
  web view supports it, and resume from where you stopped.
- **Offline downloads** on macOS and iPhone, with a queue (one download at
  a time; the rest wait in "Up next").
- **Keyboard shortcuts** on macOS, and touch gestures on phones (tap,
  double tap to seek 10 s, hold for 2x, slide for brightness/volume,
  pinch to fill).
- **An FPS monitor** and performance recorder for diagnostics.

| Feature                                  | macOS            | iPhone / iPad                  | Android            |
| ---------------------------------------- | ---------------- | ------------------------------ | ------------------ |
| Browse, search, My List, Continue Watching | yes            | yes                            | yes                |
| Player: sources, episodes, speed, subtitles, resume | yes   | yes                            | yes                |
| Picture-in-picture                       | when the page supports it | when the page supports it | no            |
| Full-screen button                       | yes              | yes                            | no (player is always full screen) |
| Offline downloads                        | yes              | yes                            | no (hidden)        |
| Keyboard shortcuts                       | yes              | not verified (hardware keyboard) | not verified     |
| Player gestures (seek, 2x, brightness, volume) | no         | yes                            | yes                |
| FPS monitor                              | ⌘⇧F or Settings  | Settings → Diagnostics         | Settings → Diagnostics |

## Requirements and setup

- **Rust** with `cargo`. The crate uses edition 2024 (Rust 1.85 or newer).
  There is no `rust-toolchain` file; the stable toolchain is used.
- **macOS** for the desktop app. The shell uses AppKit and WebKit directly,
  and macOS is the only desktop platform it is built and packaged for.
- **NSH**. The desktop app needs no checkout: `nsh-platform-gpui`,
  `nsh-engine` and the bundler crates come from crates.io at 0.4.0
  (`Cargo.toml`). The iPhone and Android hosts need a checkout of
  [NSH](https://github.com/longbridge/nsh) to build its native runtimes.
  Both scripts expect it at `../_research/nsh`, next to this repository:

  ```sh
  git clone https://github.com/longbridge/nsh ../_research/nsh
  ```

  Android reads `NSH_DIR` to use another location; iOS reads the path from
  `ios/project.yml`. See [docs/IOS.md](docs/IOS.md) and
  [docs/ANDROID.md](docs/ANDROID.md).

### API keys

- **TMDB.** A key is built into `app/lib/tmdb.ts`, so the app works on
  first launch. To use your own, open **Settings → TMDB API Key** and paste
  a TMDB Read Access Token (v4) or v3 API key; it is stored on the device.
  If a build ships without a built-in key, the app opens a setup screen
  that asks for one.
- **Subtitles (optional).** Online subtitle search works without keys.
  Keys for Wyzie Subs and SubDL add results. They are never kept in the
  repository: `build.rs` reads `WYZIE_API_KEY` and `SUBDL_API_KEY` from the
  environment at build time and bakes them, lightly scrambled, into the
  bundle. Without them the build ships no keys. `package-macos.sh`,
  `ios/sync-bundle.sh` and `android/build.sh` fill unset variables from the
  macOS Keychain through a `secret` command when one is on your `PATH`
  (`secret get WYZIE_API_KEY`); otherwise export the variables yourself:

  ```sh
  export WYZIE_API_KEY=... SUBDL_API_KEY=...
  ```

  Users can also enter their own keys in **Settings → Languages & subtitles**.

## Run

```sh
cargo run                          # builds app/ and opens the window
cargo run -- path/to/bundle.nshc   # run another bundle (or its directory)
```

`build.rs` bundles and compiles `app/` on every build, the way `nsh build`
does, so there is no separate frontend step.

## Build

### macOS

```sh
./package-macos.sh                 # release build -> ~/Applications/rustflix.app
./package-macos.sh dist            # ... or into another folder
PERF=1 ./package-macos.sh          # perf profile: line tables kept for spike stacks
```

The app is ad-hoc signed. Details, data locations and the shortcut list:
[docs/MACOS.md](docs/MACOS.md).

### iPhone and iPad (simulator)

```sh
./ios/build.sh                     # first available iPhone simulator
./ios/build.sh 'platform=iOS Simulator,name=iPhone 17'
```

Needs Xcode, `xcodegen` and `NativeShell.xcframework` built from the NSH
checkout. Device builds, signing and TestFlight: [docs/IOS.md](docs/IOS.md).

### Android (debug)

```sh
./android/build.sh                       # debug APK, all ABIs
ABIS=arm64-v8a INSTALL=1 ./android/build.sh   # one ABI, install and launch
```

Needs the Android SDK and NDK, a JDK 17+ and the NSH checkout. Release
builds and signing: [docs/ANDROID.md](docs/ANDROID.md).

## Project layout

```
app/                     the TSX interface, shared by every platform
  App.tsx                shells (desktop sidebar, phone tabs), shortcuts, boot
  nsh.json               app id, theme, capabilities (network hosts, host calls)
  lib/
    tmdb.ts              TMDB client and image URLs
    anilist.ts           AniList GraphQL client
    aniskip.ts           AniSkip intro/credits timestamps
    sources.ts           embed playback sources
    player.ts            player controller: web view bridge, fallback, resume, palette
    resolver.ts          hidden web view that finds a title's stream link
    subtitles.ts         subtitle parsing and online providers
    downloads.ts         download queue over the host's dl.* calls
    store.ts             watchlist, progress and settings (nsh/storage)
    router.ts            routes and tab stacks
    cache.ts             Settings → Storage: cache sizes and clearing
    system.ts            brightness/volume (phones), macOS window fixes
    perf.ts              FPS monitor and performance recorder
    hero.tsx             desktop poster transition into the title page
    ui.tsx               shared components (cards, rows, buttons)
  screens/               Home, Search, Title, Library, Downloads, Settings, Setup,
                         Player, PlayerControls, SourcePicker, EpisodePicker,
                         AudioSubsPanel, ResolverHost, PerfFlood
src/                     macOS shell (Rust + GPUI)
  main.rs                window, bundle lookup, cache.* and file handlers
  appkit.rs              AppKit fixes (sys.*)
  dl/                    built-in downloader (HTTP, HLS, queue store, local server)
  perf/                  FPS monitor panel, frame clock, recorder, sampler
build.rs                 bundles app/ and bakes in the subtitle keys
package-macos.sh         release build -> rustflix.app
ios/                     UIKit host: project.yml (xcodegen), build.sh,
                         sync-bundle.sh, release.sh, Rustflix/*.swift
android/                 Android host: Gradle project, build.sh,
                         app/src/main/java/com/hexuria/rustflix/*.java
docs/                    platform guides
```

## Testing

```sh
cargo test
```

This runs the Rust unit tests of the macOS shell: the downloader
(`src/dl/`), the cache and file handlers (`src/main.rs`) and the perf
module. The TSX interface has no automated test suite.

## Troubleshooting

- **`bundle.nshc not found`** from `package-macos.sh` or
  `ios/sync-bundle.sh`: the scripts look for the build output under
  `target/` and `~/.cargo/targets/rustflix-*`. If you set a different
  `CARGO_TARGET_DIR`, the scripts will not find it.
- **`WYZIE_API_KEY is set but its slot ... is not in the bundle`** from
  `build.rs`: the key placeholder in `app/lib/subtitles.ts` was removed or
  renamed. Restore the `@@RUSTFLIX_WYZIE_KEY@@` / `@@RUSTFLIX_SUBDL_KEY@@`
  tokens, or unset the variable.
- **The packaged app has no icon**: `package-macos.sh` copies the icon only
  if `$ICNS` (default `/tmp/rustflix.icns`) exists.
- **A source does not play**: open the source picker and choose another.
  Some sources in `app/lib/sources.ts` are marked `NEEDS_INTERCEPT` and may
  not load in this app.

## Status

- macOS builds are ad-hoc signed, not Developer ID signed or notarized.
- Android has no downloads, no picture-in-picture and no full-screen button
  yet ([docs/ANDROID.md](docs/ANDROID.md#known-limitations)).
- Release steps for TestFlight and Google Play are in
  [docs/IOS.md](docs/IOS.md) and [docs/ANDROID.md](docs/ANDROID.md).

## Docs

- [docs/MACOS.md](docs/MACOS.md): packaging, data locations, keyboard shortcuts
- [docs/IOS.md](docs/IOS.md): Xcode setup, device builds, signing, TestFlight
- [docs/ANDROID.md](docs/ANDROID.md): SDK setup, release builds, signing

## Acknowledgements

Built on [NSH](https://github.com/longbridge/nsh) and
[GPUI](https://www.gpui.rs/), with metadata from
[TMDB](https://www.themoviedb.org/) and [AniList](https://anilist.co/); the
embed source list is adapted from
[Streambert](https://github.com/truelockmc/streambert).

This product uses the TMDB API but is not endorsed or certified by TMDB.
