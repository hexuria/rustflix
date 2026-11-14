# rustflix on Android

The Android app runs the same `app/` bundle as the desktop, in NSH's Android
runtime: `libnsh.so` and its Java classes, hosted in an `NshView`. The
host in `android/app/src/main/java/com/hexuria/rustflix/` handles the
interface's `sys.*` (brightness, volume, the player window), `cache.*`
(Settings → Storage), `perf.*` (FPS monitor) and `dl.*` (downloads) calls.
Downloads use the desktop shell's own Rust downloader (`src/dl`), built for
Android as `librustflix_dl.so` (see [Downloads](#downloads)).

Package `com.hexuria.rustflix`, minSdk 26 (Android 8.0), targetSdk and
compileSdk 36. ABIs: `arm64-v8a`, `armeabi-v7a`, `x86_64`.

## Prerequisites

- **Android SDK** with `ANDROID_HOME` set (NSH also finds
  `~/Library/Android/sdk`, Android Studio's default), and these packages:
  - `platforms;android-36` (this app's `compileSdk`)
  - build-tools
  - NDK `29.0.13113456` (`ndkVersion` in `android/app/build.gradle.kts`).
    NSH's `cargo xtask android` uses `ANDROID_NDK_HOME`, or else the newest
    NDK in the SDK.
  - the SDK platform NSH's own Java runtime compiles against (`COMPILE_SDK`
    in the NSH checkout's `crates/xtask/src/android.rs`; android-35 at the
    time of writing).
- **JDK 17 or newer** (`JAVA_HOME`). The app compiles with Java 17
  source/target compatibility; Gradle 9.9.1 comes from the wrapper.
- **Rust** with the Android targets for the ABIs you build:

  ```sh
  rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
  ```

- **An NSH checkout.** `android/build.sh` builds the runtime from it. The
  default location is `../_research/nsh`, next to this repository; set
  `NSH_DIR` to use another one:

  ```sh
  git clone https://github.com/longbridge/nsh ../_research/nsh
  # or: export NSH_DIR=/path/to/nsh
  ```

## Build

```sh
./android/build.sh                    # debug APK, all ABIs (debug key)
./android/build.sh release            # release APK + AAB
./android/build.sh release-splits     # release AAB, plus one APK per ABI
```

Environment variables:

| Variable | Effect |
| --- | --- |
| `ABIS=arm64-v8a` | Build only these ABIs (comma-separated). Default `arm64-v8a,armeabi-v7a,x86_64`. |
| `SKIP_RUNTIME=1` | Reuse the NSH runtime already staged in `android/nsh-runtime/`. |
| `INSTALL=1` | After the build, `adb install -r` the newest APK and launch `MainActivity`. |
| `NSH_DIR=/path/to/nsh` | The NSH checkout. Default `../_research/nsh`. |

What the script does:

1. Unless `SKIP_RUNTIME=1`: runs `cargo xtask android --release` in
   `NSH_DIR` for the chosen ABIs and stages `classes.jar` and
   `jni/<abi>/libnsh.so` (with symbols) in `android/nsh-runtime/`.
2. Builds the downloader, `android/rustflix-dl`, with the NDK's clang for
   each ABI (`cargo build --release --target <triple>`, 16 KB pages) and
   stages `jni/<abi>/librustflix_dl.so` in `android/dl-runtime/`.
3. Builds `app/` with `cargo build` (`--release` for release modes), with
   the subtitle keys from the environment or `secret get` (see the
   README's "API keys"), and copies the bundle into
   `android/app/src/main/assets/nsh/` without `bundle.js` and its source map.
4. Runs Gradle: `assembleDebug`, or `assembleRelease bundleRelease`
   (`-PabiSplits` for `release-splits`), and lists the APKs and AABs it
   produced under `android/app/build/outputs/`.

`android/nsh-runtime/`, `android/dl-runtime/`, `android/rustflix-dl/target/` and `android/app/src/main/assets/nsh/` are generated
and gitignored. The staged bundle contains the baked-in subtitle keys.

### Versions

`versionName` and `versionCode` come from `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION` in `ios/project.yml`. Bump them there; both
phone apps share one version.

## Run on an emulator or device

Enable USB debugging on the device (or start an emulator), check that
`adb devices` lists it, then:

```sh
ABIS=arm64-v8a INSTALL=1 ./android/build.sh    # most phones
ABIS=x86_64 INSTALL=1 ./android/build.sh       # x86_64 emulator
```

After the first build, add `SKIP_RUNTIME=1` to skip rebuilding the NSH
runtime when only `app/` changed.

`INSTALL=1` installs the most recently written APK. After
`release-splits` that is whichever ABI's APK was written last, so install
the one you need with `adb install -r <apk>` instead. An unsigned release
APK cannot be installed.

## Release signing

Release builds are signed with an upload key that is never committed
(`keystore.properties`, `*.jks` and `*.keystore` are gitignored).

1. Create the key once:

   ```sh
   keytool -genkeypair -v -keystore ~/keys/rustflix-upload.jks \
     -alias upload -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Write `android/keystore.properties`:

   ```properties
   storeFile=/Users/<you>/keys/rustflix-upload.jks
   keyAlias=upload
   ```

3. Provide the passwords through the environment:

   ```sh
   export RUSTFLIX_UPLOAD_STORE_PASSWORD=... RUSTFLIX_UPLOAD_KEY_PASSWORD=...
   ```

   `build.sh` fills them from `secret get RUSTFLIX_UPLOAD_STORE_PASSWORD` /
   `secret get RUSTFLIX_UPLOAD_KEY_PASSWORD` when the `secret` command
   exists. As a fallback, Gradle also reads `storePassword` and
   `keyPassword` from `keystore.properties`.

Without `android/keystore.properties`, release outputs are unsigned.

Release builds are minified with R8 (`proguard-rules.pro`) and keep the
native symbol table (`debugSymbolLevel = "SYMBOL_TABLE"`) for Play
Console's native crash reports.

## APK or AAB

- **AAB** (`android/build.sh release`): for Google Play, which splits it
  by ABI itself.
- **Per-ABI APKs** (`android/build.sh release-splits`): for direct
  downloads; each APK carries one ABI's `libnsh.so`.
- **Single APK** (`android/build.sh release`): all selected ABIs in one
  file.

Native libraries are stored uncompressed and page-aligned
(`jniLibs.useLegacyPackaging = false`), as Android 15's 16 KB pages
require.

## Downloads

The same `dl.*` host API as the iPhone app and the desktop shell, answered
by the desktop's downloader itself (HLS and progressive, resume, link
expiry, the record store, the localhost playback server):

- **`android/rustflix-dl/`** — a `cdylib` crate with its own workspace (the
  desktop crate, its lockfile and its tests are untouched). It compiles
  `src/dl/mod.rs` as is through `#[path]`; `crate::cache` / `crate::files`
  get Android meanings there (statvfs free space; remove = delete, no
  Trash; no "show in folder"), and `nsh_engine` is a tiny stand-in crate
  (`hostshim/`). `src/bridge.rs` answers calls as JSON in, JSON out and adds
  Wi-Fi only; `src/jni_glue.rs` is the JNI surface of
  `com.hexuria.rustflix.DlNative` (`nativeInit`, `nativeCall(name, json)`,
  `nativeSetMetered`, and the `DlNative.onEvent(json)` callback).
  `cd android/rustflix-dl && cargo test` runs the downloader's own tests
  plus the bridge's on the host.
- **`Downloads.java`** registers `dl.list`, `dl.start`, `dl.cancel`,
  `dl.remove`, `dl.playUrl`, `dl.space`, `dl.nextId`, `dl.options`
  (`dl.reveal` / `dl.adopt` answer `{ok: false}`) and forwards each on a
  worker thread; record changes go to the app as `dl.event`.
- **Storage.** Downloads, one folder each:
  `Android/data/com.hexuria.rustflix/files/downloads/` (the app's external
  files directory: no storage permission, removed with the app). Records:
  `files/rustflix-dl/rustflix-downloads.json`. Nothing goes to backups
  (`allowBackup="false"`, `data_extraction_rules.xml`). Free space is that
  volume's; a download needs 1 GB free to start and stops below 200 MB.
  The folder can't be changed.
- **In the background.** `DownloadService` is a foreground service of type
  `dataSync` (permissions `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_DATA_SYNC`): it runs while any record is `running`
  and stops when the queue is idle. Its notification (channel "Downloads")
  shows overall progress; each download gets its own with a progress bar
  and **Cancel**; tapping one opens the Downloads tab. On Android 15 a
  `dataSync` service may run about 6 hours in 24; at the limit the service
  stops (transfers continue only while the system keeps the process).
- **Notifications permission.** Android 13+ asks for `POST_NOTIFICATIONS`
  at the first download, once. Refused: downloads still work, only the
  progress notifications stay hidden.
- **Resume.** A record left `running` (the app was killed, the device
  restarted) resumes at the next launch; Retry continues from the files.
- **Wi-Fi only** (Settings → Downloads, on by default). While the network
  is metered, new downloads are refused ("Waiting for Wi-Fi") and running
  ones are stopped with their files kept (`ACCESS_NETWORK_STATE`); they
  continue by themselves when an unmetered network returns (or Wi-Fi only
  is turned off). Downloads refused while metered need Retry.
- **Playback offline.** `dl.playUrl` starts the downloader's server on
  `127.0.0.1` (the only cleartext host in `network_security_config.xml`).
  WebView's built-in HLS cannot parse fragmented-MP4 playlists, so the
  page there is Android's own `assets/local-player.html` (served by
  `WebViewTweaks`): fMP4 HLS through Media Source Extensions; mp4 files and
  MPEG-TS playlists play natively.
- **Finding the stream link.** The page bridge sees requests in the top
  document only on Android (NSH injects its scripts there); `WebViewTweaks`
  also watches every request of every frame (`shouldInterceptRequest`) and
  reports HLS playlists and mp4s to the page's channel as the bridge's own
  stream report, which the hidden resolver and the player take.

## Native playback (the app's own player)

The player is moving off the web view: the stream is resolved in the hidden
web view, served by a local proxy that adds the page's headers, and played by
the app's own player (contract: `scratchpad/native/contract.md`; behind the
Storage flag `rustflix.nativeplayer` until the TS core switches over).

- **`rustflix.video`** (`NativeVideo.java`, registered with
  `NshView.registerComponent`): Media3 ExoPlayer with HLS
  (`media3-exoplayer`, `media3-exoplayer-hls`) and `media3-session` for a
  MediaSession (headset / Bluetooth / system media keys). It renders to a
  `TextureView` so NSH views draw over it and transform it; a `SurfaceView`
  would be cheaper (hardware overlay, HDR passthrough) but cannot be overlaid
  or animated like a view — not used. Props, commands and events per the
  contract; audio focus and the headphones-unplugged pause are ExoPlayer's;
  the screen stays on while it plays; the activity's stop pauses it (unless
  in picture-in-picture) and its start resumes it.
- **PiP** shows the native picture (transformed to fill the PiP window), with
  the video's real aspect ratio and its on-screen rect as the animation hint;
  the remote actions drive the player directly.
- **Decoders**: a decoder failure retries once on H.264 ≤ 1080p (a non-fatal
  `error`), then fails. The emulator (API 36 arm64) has hardware-backed
  `c2.goldfish` H.264/HEVC/VP8/VP9 and software AV1 (`c2.android.av1`);
  phones generally decode H.264 and HEVC in hardware, AV1 in hardware only on
  recent SoCs (software otherwise).
- **`dl.stream.*`**: the desktop's proxy (`src/stream`), compiled into
  `librustflix_dl.so` like `src/dl` and answered over JNI
  (`android/rustflix-dl/src/streams.rs`); events go to the app as
  `dl.stream.event`. It listens on 127.0.0.1 (a random port and a per-launch
  token; the network security config already allows cleartext there).
- **Link capture**: the Sniffer's stream reports carry the requesting frame's
  `Origin` and the media host's cookies (CookieManager). The hidden resolver
  web view (the activity's own window) needs a gesture for unmuted
  playback, in every frame, so it is never heard.
- **Offline**: a finished download plays in `rustflix.video` from the
  downloader's localhost server (`dl.playUrl`'s page URL or the media URL);
  `assets/local-player.html` stays as the web-view fallback.
- **Test hook**: Storage `rustflix.nativeplayer` = "1" and
  `rustflix.nativetest` = `{"type":"movie","id":550,"source":"vidfast",
  "rect":{"x":0,"y":120,"width":411,"height":231}}` → result in
  `rustflix.nativetest.result` (resolve, first frame, seeks, forced expiry,
  proxy stats).

## Player: full screen

As on iPhone the player opens inline: the device's orientation, system
bars shown. **Full screen** (top right) turns the window landscape and
immersive; the button then shows "exit full screen". Back leaves full
screen first (the back gesture on Android 13+, and the back key on every
version), then the player.

## Player: picture-in-picture

The PiP button (top right, before Sources, as on iPhone) and leaving the
app while a video plays (Home, recents; `setAutoEnterEnabled` on Android
12+, `onUserLeaveHint` before) put the activity in PiP (`Pip.java`;
`android:supportsPictureInPicture`). WebView has no element PiP, so the
whole task shrinks: the player's Dialog window goes with it, and every view
in it except the web view is hidden while in PiP (restored on expand). The
PiP window has −10 s / play-pause / +10 s actions; dismissing it pauses the
video. The aspect ratio is 16:9.

## Player: gestures

Double tap on the left / right half seeks ∓10 s, each further tap within
0.8 s adds 10 s (a triple tap is 20 s); a single tap toggles the controls
after 260 ms; hold for 2× until release; vertical slides for brightness
(left) and volume (right); pinch to fill. NSH reports a click count only for
mouse clicks, so the double tap is recognised from the taps' timing (all
phones).

## Known limitations

- WebView's default video poster (a grey Android robot) is replaced by a
  transparent one, and poster-less videos of the page get a transparent
  poster too (a web view's first poster request can come before the app's
  client is installed).
- **No poster transition into the title page.** That transition is
  desktop-only; phones use the platform's push and pop.
- NSH 0.4.0's Android dialog can report one back press twice; the player
  ignores a second press within 400 ms.
- Downloads: no "show in folder"; the folder can't be changed; the
  `dataSync` time limit on Android 15 (above). The back key in full screen goes through the dialog window's
  callback, reached by reflection (`DecorView.mWindow`); where Android
  refuses that, the back key leaves the player at once (the gesture still
  leaves full screen first).
