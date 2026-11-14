# rustflix on iPhone and iPad

The iOS app runs the same `app/` bundle as the desktop, in NSH's UIKit
runtime (`NativeShell.xcframework`) rather than the GPUI backend. The host
in `ios/Rustflix/` adds what the shared interface asks the platform for:
downloads (`Downloads.swift`, `HlsDownloader.swift`), cache controls,
brightness and volume, inline video playback in web views, and the FPS
monitor.

Bundle id `com.hexuria.rustflix`, iOS 15.0 or newer, iPhone and iPad
(`TARGETED_DEVICE_FAMILY: "1,2"` in `ios/project.yml`).

## Prerequisites

- Xcode, with an iOS simulator runtime installed.
- [xcodegen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`.
  `ios/rustflix.xcodeproj` is generated from `ios/project.yml` and is not
  committed.
- Rust and `cargo` (the bundle is built by this repository's `build.rs`).
- `NativeShell.xcframework`, built from a checkout of
  [NSH](https://github.com/longbridge/nsh).

### Build NativeShell.xcframework

`ios/project.yml` links
`../../_research/nsh/dist/nsh/embed/ios/NativeShell.xcframework`, relative
to `ios/`, so put the NSH checkout at `../_research/nsh` next to this
repository:

```sh
git clone https://github.com/longbridge/nsh ../_research/nsh
cd ../_research/nsh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-ios-macabi
cargo xtask ios-embed --no-dev
# -> dist/nsh/embed/ios/NativeShell.xcframework
```

`--no-dev` leaves out `NativeShellDev`. NSH's `--no-catalyst` option also
leaves out the Mac Catalyst slice, and then `aarch64-apple-ios-macabi` is
not needed. NSH's `docs/dev/embedding.md` lists the other options.

If your checkout is somewhere else, change the framework path under
`dependencies` in `ios/project.yml` (keep that change local).

## Simulator

```sh
./ios/build.sh                                            # first available iPhone simulator
./ios/build.sh 'platform=iOS Simulator,name=iPhone 17'    # a specific destination
```

`build.sh` runs `sync-bundle.sh` (builds `app/` with `cargo build` and
copies the output to `ios/Rustflix/nsh/`), then `xcodegen generate`, then a
Debug `xcodebuild` for the destination. It builds only; to run, open the
project and press Run:

```sh
open ios/rustflix.xcodeproj
```

## Device

```sh
./ios/sync-bundle.sh            # or: ./ios/sync-bundle.sh --release
(cd ios && xcodegen generate)
open ios/rustflix.xcodeproj
```

Select your device in Xcode and press Run. Signing is automatic
(`CODE_SIGN_STYLE: Automatic`).

Run `sync-bundle.sh` again after every change in `app/`: Xcode copies
`ios/Rustflix/nsh/` as it is and does not rebuild it.

## Signing

`ios/project.yml` sets `DEVELOPMENT_TEAM: "5KZ8MD34QW"`, and
`ios/exportOptions.plist` sets the same `teamID`. To sign with your own
team, change both to your team id (Xcode → Settings → Accounts, or the
Apple Developer membership page) and regenerate the project with
`xcodegen generate`. Keep that change out of commits.

## Version and build number

`ios/project.yml` holds both:

- `MARKETING_VERSION`: the version users see (`CFBundleShortVersionString`).
- `CURRENT_PROJECT_VERSION`: the build number (`CFBundleVersion`). App
  Store Connect rejects a build number it has seen before, so bump it for
  every upload.

The Android build reads the same two values as `versionName` and
`versionCode`.

## Release build

```sh
./ios/release.sh
# -> ios/build/ipa/rustflix.ipa
```

`release.sh` runs `sync-bundle.sh --release`, regenerates the project,
archives to `ios/build/Rustflix.xcarchive` and exports with
`ios/exportOptions.plist` (method `app-store-connect`, automatic signing,
symbols uploaded). Both `xcodebuild` steps pass
`-allowProvisioningUpdates`, so Xcode may create or update the
distribution profile.

Set `WYZIE_API_KEY` / `SUBDL_API_KEY` (or have them in the Keychain for
`secret get`) before a release build if the build should ship subtitle
keys; see the README's "API keys".

## TestFlight

### One-time App Store Connect setup

1. The Account Holder accepts the current agreements in App Store Connect
   → **Business** (Agreements, Tax and Banking). Only the Account Holder
   can do this. Until then uploads fail.
2. **Apps → + → New App**:
   - Platform: iOS
   - Name: `rustflix`
   - Bundle ID: `com.hexuria.rustflix` (registered automatically the first
     time Xcode signed the app for the team)
   - SKU: any unique string, for example `rustflix-ios`

### Upload

Use one of:

- **Transporter** (free, Mac App Store): drag `ios/build/ipa/rustflix.ipa`
  in and press Deliver.
- **Xcode**: Window → Organizer → select the archive → Distribute App.
- **Command line**, with an App Store Connect API key in `~/.private_keys/`
  (the issuer id is in App Store Connect → Users and Access →
  Integrations):

  ```sh
  xcrun altool --upload-app -f ios/build/ipa/rustflix.ipa \
    --apiKey <KeyID> --apiIssuer <IssuerID>
  ```

Processing takes several minutes; App Store Connect sends an email when the
build is ready. Then open **TestFlight → rustflix**: add internal testers
(no review needed) or an external group (the first build for external
testers goes through a short beta review).

### Upload errors

- **403 "You do not have required contracts to perform an operation"**
  from Transporter: an agreement is pending in App Store Connect →
  Business. The build is fine; the Account Holder has to accept the
  agreement, then upload the same IPA again.
- **The build number has already been used**: bump
  `CURRENT_PROJECT_VERSION` in `ios/project.yml` and run `./ios/release.sh`
  again.

## Info.plist notes

- `CADisableMinimumFrameDurationOnPhone` is `true`, which lets iPhones with
  ProMotion displays run the app above 60 Hz.
- `NSAppTransportSecurity → NSAllowsLocalNetworking` is `true`: finished
  downloads and the stream proxy are served from `127.0.0.1`.
- `UIBackgroundModes` has `audio`: the app's own player keeps playing in
  the background and in Picture in Picture. App Review expects the app to
  actually play audio in the background when this key is set; it does.
- `ITSAppUsesNonExemptEncryption` is `false`, so uploads do not ask the
  export-compliance question.

## Downloads

Downloads run in the app process on background `URLSession`s, so they
continue while the app is suspended or the phone is locked. HLS streams
are planned in the foreground and then fetched segment by segment.
Settings → Downloads has a Wi-Fi only switch.

Files live in the app's `Library/Application Support/`:

- `rustflix-dl/<id>/`: one folder per download (`.manifest.json` for HLS)
- `rustflix-dl-records.json`: the download list

## Native player

The app's own player replaces the source's web page: the stream is resolved
in a hidden web view, served by a local proxy with the page's headers, and
played by AVPlayer. The TypeScript side talks to it through the API in
`app/lib/nativevideo.tsx`; the shared contract for all platforms is in the
native-playback design notes (`rustflix.video` component, `dl.stream.*`).

- `ios/Rustflix/NativeVideo.swift`: the `rustflix.video` component
  (AVPlayer in an AVPlayerLayer-backed view, registered with
  `NshAppView.register(component:)` before the bundle loads), plus the
  host ops `sys.nativeVideo`, `sys.nativePlayers` and `sys.webViews`.
  It sets the audio session to `.playback` / `.moviePlayback`, pauses when
  headphones are unplugged, handles interruptions, publishes Now Playing
  info, and answers lock-screen commands (play, pause, ±10 s, scrubbing).
  Changes the player makes on its own come back as `rate {rate, paused, by}`
  with `by` = `remote`, `route` or `interruption`.
- `sys.nativeVideoInfo` answers `{available: true, pip, fullscreen: true,
  local: true}`; with Storage `rustflix.nativeplayer` = "auto" this turns
  the app's player on.
- Full screen (the player's Full screen button) rotates to landscape and
  back to portrait (`enterFullscreen` / `exitFullscreen`). The app's
  controls and captions stay on screen, unlike AVKit's own full-screen
  player.
- Picture in Picture uses `AVPictureInPictureController` on the player
  layer and starts automatically when the app goes to the background while
  playing. Without PiP, the layer is detached in the background so the
  sound keeps going. The iOS Simulator reports PiP as unsupported, so the
  component answers `pip {active: false, possible: false}` there; test PiP
  on a device.
- AirPlay video is off (`allowsExternalPlayback = false`): an Apple TV
  cannot reach the proxy on `127.0.0.1`. Screen mirroring still works.
- `ios/Rustflix/StreamProxy.swift`: the `dl.stream.*` proxy, a Swift twin
  of `src/stream`. It listens on a random loopback port, and every URL
  carries a per-launch token: `http://127.0.0.1:<port>/<token>/s/<sid>/…`.
  A session serves only what its own playlists listed. Segments are
  streamed with back-pressure: the upstream task is suspended while more
  than 1 MB is waiting for the player. It forwards `Range`, cuts a 200 into
  the 206 the player asked for, and strips fake image headers in front of
  TS segments. A 401/403/410 holds the request for up to 20 s, waiting for
  `dl.stream.update`; local names stay stable across fresh links.
- `ios/Rustflix/StreamPlaylist.swift`: the playlist rewriter (a port of
  `src/stream/playlist.rs`). `ios/RewriterCheck/run.sh` compiles it for the
  Mac and runs the Rust tests' fixtures against it (prints PASS/FAIL). In
  the app, the same check is the host op `dl.stream.selftest`.
- Finished downloads: `dl.playUrl` answers `url` (the generated player
  page, kept as the web fallback) and `src` (the media itself, for
  `rustflix.video`).
- Debug builds only: the launch argument `-rustflixDebugPipAfter <s>`
  starts PiP that many seconds after the first frame,
  `-rustflixDebugFullscreenAfter <s>` goes full screen then (and back 6 s
  later), and
  `-rustflixDebugForce403After <s>` makes a session's next upstream answer
  a 403 that many seconds after it opens.
- Logs: `rustflix/video:` and `rustflix/stream:` (`NSLog`).

## Diagnostics

- **FPS monitor**: Settings → Diagnostics → Show FPS monitor, or a
  two-finger triple tap anywhere. Tap the panel to fold it to one line;
  long-press it to save the recording.
- **Recorder**: while the panel shows, one line a second goes to
  `Library/Application Support/perf.jsonl` (rolled at 2 MB). Settings →
  Diagnostics → Save performance recording saves it and opens the share
  sheet.
- **Diagnostics switch** (Settings → Diagnostics) records player bridge
  events to storage.
- The host logs with the prefix `rustflix/nsh:` (`NSLog`); view it in
  Xcode's console or Console.app.

## Known limitations

- iPad is a build target and runs the same tab-based phone shell as
  iPhone; there is no iPad-specific layout.
- Desktop keyboard shortcuts are bound in the shared code, but they have not
  been checked with a hardware keyboard on iPad.
- Native player: Picture in Picture, headphone unplugging, interruptions
  (calls, Siri) and lock-screen controls need a device; the Simulator cannot
  show them. AirPlay sends sound only (or mirrors the screen). DRM streams
  are not played natively: the proxy ends the session with `error drm`.
