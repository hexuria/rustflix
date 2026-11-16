# Desktop ports (Windows, Linux)

Status of `spike/desktop-ports` and the Linux work on `port/linux`.
Verified on Ubuntu 26.04 x86_64, X display `:1`, software Vulkan
(Mesa llvmpipe, no GPU).

## Milestone 1 — build from source, run on :1 — DONE

- `cargo build --release` succeeds on Linux.
- The app runs on `:1` (`cd <runnable folder> && DISPLAY=:1 ./rustflix`).
- `.github/workflows/desktop-ports.yml` gained a `macos-latest` job
  (`cargo build`, no signing) alongside the Windows/Linux jobs.

## Milestone 2 — native player `rustflix.video` on Linux — DONE (with notes)

Implementation: `src/player/linux/` (`mod.rs`, `gst.rs`, `component.rs`),
behind `cfg(target_os = "linux")`. macOS (`src/player/av.rs`,
`src/player/component.rs`) is untouched.

- **Decoder**: GStreamer `playbin3` (needs GStreamer ≥ 1.24; the test
  machine has 1.28). Video → `video/x-raw,BGRA` appsink, text →
  `text/x-raw` appsink, audio → default sink. Decoding runs entirely
  on GStreamer streaming threads; the appsink callbacks only copy the
  frame into an `Arc` and bump a redraw — nothing blocks the main
  thread, and a paused pipeline delivers no samples, so no frames and
  no redraws.
- **Frames → GPUI**: gpui-fast's `surface`/`paint_surface` is
  macOS/iOS-only (CVPixelBuffer). On Linux each BGRA frame becomes a
  `RenderImage` in the sprite atlas, painted by a custom `FrameElement`
  with `ObjectFit` (contain/cover). The replaced image is dropped from
  the atlas on the next paint, so at most one frame is resident. Cost
  is one ~8 MB memcpy + one atlas upload per frame — fine at 1080p on
  llvmpipe; a real GPU will not notice it.
- **Contract**: props `src`, `startAt`, `paused`, `muted`, `volume`,
  `rate`, `fit`, `frame`, `maxResolution`, `nowPlaying` (accepted,
  ignored — no MPRIS yet); `ready` handle + `sys.nativeVideo` commands
  (`seek`, `selectAudio`, `selectSubtitle`); events `load` (with
  duration/size/tracks), `frame`, `tracks`, `progress` (4 Hz),
  `buffer`, `seeked`, `rate`, `pip` (never: `pip` reports
  `possible:false` via `nativeVideoInfo.pip=false`), `cues`, `end`,
  `error`.
- **Tracks**: playbin3's `GstStreamCollection` message gives audio and
  text streams with language tags; selection goes out as
  `GST_EVENT_SELECT_STREAMS` (playbin2 does not post collections —
  that is why playbin3). `aN`/`tN` track ids index the reported lists.
- **Subtitles**: text appsink buffers become `cues {time, lines}`;
  the tick clears the cue at its end. Verified end-to-end with an
  MKV carrying two audio tracks and an SRT subtitle.
- **Pipeline calls never run under the player's lock**: state changes
  (including the stop of a replaced pipeline), seeks, rate changes and
  `send_event(SELECT_STREAMS)` wait on GStreamer streaming threads,
  which take the player's mutex in the appsink callbacks. `Inner` only
  queues them as `Job`s; the player's worker thread (the one that also
  does the 4 Hz tick) runs them in order with the lock released, so
  they do not block the main thread either.
- **Quality switches**: HLS changes the picture's size mid-stream. The
  video callback reads each sample's own caps; with the first sample's
  size kept, every frame after a switch to a smaller variant failed to
  map (`gst_video_frame_map_id: assertion 'info->width <= meta->width'`)
  and the picture froze or went black. Seen on a real source about 30 s
  into playback.
- **One quality for the whole play**: `connection-bitrate` is set on
  hlsdemux2/dashdemux2, so the demuxer picks the best variant at start
  and never switches by measured bandwidth. Reason: hlsdemux2
  (GStreamer 1.28.2) never returns from a seek that arrives while a
  variant switch is under way — `gst_hls_demux_seek` →
  `gst_hls_demux_wait_for_variant_playlist` loops on a playlist that
  cannot load once the seek has stopped the stream, and the calling
  thread spins at 100 % for good (backtrace taken with
  `gstreamer1.0-plugins-good-dbgsym`). A download of the same title
  made switches frequent; a seek during it, or the `startAt` seek of a
  rewatch, then hung the player, and the app moved on to the next
  source after its timeout. Cost: no adaptive quality on a slow
  connection (it buffers instead). Revisit when the upstream loop is
  fixed.
- **`startAt`**: a new pipeline prerolls in PAUSED; the worker then
  seeks to `startAt` (once per source, as av.rs does) and only then
  goes to PLAYING, so nothing plays from 0 first. Until the position
  is there, `progress` reports `startAt`, not the preroll's 0.
- **Loopback proxy**: `souphttpsrc` honours `http_proxy` even for
  `127.0.0.1`; a `deep-element-added` hook clears `proxy` on every
  `souphttpsrc` (including the ones hlsdemux creates per playlist and
  per segment).
- **`sys.nativeVideoInfo`** reports `available:true` on Linux with
  `pip:false`, `fullscreen:false`, `local:true`,
  `embeddedSubtitles:true`, `subtitleCues:true`.

Verified (`rustflix.nativetest` debug screen, `download` + `stream`
modes):

- Finished-download MP4 via `dl.playUrl` → `src`: first frame
  ~120–260 ms, `load` with duration/size/tracks, seeks to 10/50/90 %
  land on target, progress advances, buffer events, teardown leaves
  `sys.nativePlayers` at `live:0, playing:0`.
- MKV with 2 audio + 1 subtitle: `load`/`tracks` list all streams,
  `selectAudio a1` flips `selected`, `selectSubtitle t0` produces
  `cues` events with the cue text.
- Public HLS through `dl.stream.open` (test-streams.mux.dev, 634 s,
  720p): first frame ~2.1 s, seeks land (segment-aligned, within
  ~3.5 s of target — HLS keyframe/segment granularity), a forced
  upstream 403 produced `expired` in ~11 ms and playback resumed
  (stall ~275 ms) when the link recovered.
- Visual check: screenshots show real moving pictures in the `frame`
  rect (not a web page).

Not verified / known problems:

- **Real embed playback end-to-end was not achieved here** — the
  resolver finds real HLS URLs (milestone 4), but every tested CDN
  answers 403 even to the resolver WebView's own fetch (see the CDN
  note under milestone 4): this datacenter egress is refused. Playback
  itself is verified through `dl.stream.open` on public media and
  through finished downloads.
- `maxResolution` is stored but does not yet cap the decode size.
- `rate` is applied through `gst_element_seek`'s rate argument; sinks
  that cannot follow it keep their rate.
- `nowPlaying` is accepted and ignored (no MPRIS).
- External `.srt`/`.vtt` sidecar files are not picked up (only
  embedded text streams).
- Audio-only media: `load` fires from the stream collection
  (`no_video`); untested with a real audio-only file.
- `text/x-raw` caps on the text appsink may need widening for some
  subtitle formats (e.g. `subtitle/x-dvd`); untested beyond SRT-in-MKV.

## Milestone 3 — finished downloads play via `local: true` — DONE

- `src/dl/server.rs`: `Server::media_url(id, file)` returns the raw
  media endpoint `http://127.0.0.1:<port>/<token>/<id>/<file>`.
- `dl.playUrl` now returns `{url (legacy player.html), src (raw media
  URL)}`; the generated player page is kept as the web fallback.
- The TSX playback path passes `local: true` for download playback and
  the native backend plays `src` in `rustflix.video` — verified with
  `movie.mp4`, `long.mp4` and `test.mkv` download records.
- **Fix (real Downloads → Play path)**: downloads without a title
  identity (records whose native side has no `mediaId` — e.g. files
  added directly, keys `native:`/`legacy:`) got key `native:<id>`,
  which no player route can produce; `localPage` never matched, the
  player fell through to source resolution and ended on "None of the
  N sources could play it". `playDownload` now puts the record's
  `dlId` on the player route (`dl`) for those entries only, and
  `localPage` falls back to matching it when the route key finds
  nothing. Verified live with `{"playdownload": 1}`: route
  `movie:0 dl=1`, `playerUrl` = `http://127.0.0.1:<port>/…`, phase
  `playing` in ~1.5 s, `sys.nativePlayers {live:1, playing:1}` — no
  source-resolution errors. `liveEntry`/`playDownloadOf` resolve by
  `dlId` too (the row's Play button goes through them, not
  `playDownload` directly).
- **Download button on the failure screen**: the desktop title bar
  showed `DownloadButton` whenever the player route was up — including
  "Couldn't play this right now" — and `downloadCurrent` enqueued a
  phantom entry that could only end in "No video link yet". The button
  and its keyboard shortcut are now hidden/disabled in the `failed`
  phase, and `downloadCurrent` itself refuses there (plus a `dl` route
  answers "already downloaded" instead of enqueueing `movie:0`).
  Verified with `failcheck`: all sources forced to fail → phase
  `failed` ("None of the 6 sources responded") → `downloadCurrent`
  returned `null`, no new entry.

## Milestone 4 — web views on X11 — IN PROGRESS (resolver works; per-source limits)

WebKitGTK web views run on X11 through NSH's wry backend (X11 child
windows of GPUI composition surfaces, GTK events pumped from the GPUI
loop). Requirements for a user machine: X11 or Xwayland (a pure
Wayland parent is refused by wry's `build_as_child`), GTK3 +
WebKitGTK 4.1 (the `webkit2gtk-4.1` stack wry already links), and a
display the web process can reach. `WEBKIT_DISABLE_DMABUF_RENDERER=1`
helps on GPU-less/software-rendered machines.

`src/webkitgtk.rs` (Linux-only) reaches the `WebKitWebView` GtkWidgets
through GTK's toplevel list and provides what macOS gets from
WKWebView/WKUserContentController:

- `sys.webGuard {script}` — installs the script as a
  `WebKitUserScript` with `UserContentInjectedFrames::AllFrames`
  (NSH's own injection is main-frame only; embed players live in
  subframes). Web views created later are covered without polling:
  wry parents every web view it builds, so an emission hook on
  GtkWidget's `parent-set` sees each one as it is built and gives it
  the script, the navigation policy and the filters before its first
  load. Per-view state is dropped in the widget's `destroy` handler.
- **The player's web view takes its window's size when it is shown**
  (`fit_to_window`, on `map`). wry's `set_bounds` sizes the GtkWindow
  while the view is still hidden, GTK allocates nothing to a hidden
  widget, and showing it later allocates nothing either, so the view
  kept wry's default 200x200: a page shown as the fallback for a failed
  native play drew its controls squeezed into the top left corner. The
  1600x900 viewport fix is now applied only to the resolver's view (it
  pinned a minimum size on the player's view too).
- `sys.webCookies {url}` — the `Cookie` header WebKitGTK would send,
  from the default context's cookie manager.
- `sys.webViews` — per-view url/title/allocation/visibility.
- `sys.webEval {index?, js}` — JS evaluation diagnostic, a host call
  from the app's own bundle. (The file-driven variant that polled
  `/tmp/rf-webeval.json` is gone: any local user could feed it.)

**Root-cause fix for "loading indicator forever"**: an `opacity: 0`
ancestor makes NSH's `geometry()` return `None`, so wry never calls
`set_bounds` and the hidden resolver web view kept WebKitGTK's ~200×200
default viewport. Embed players measure 0×0 controls, the synthetic
play click finds nothing, `video.src` stays empty and the resolver
reports `candidates=0` on every source. `ResolverHost.tsx` now gives
the Linux resolver web view a real 1600×900 box clipped to a 1×1
`overflow:hidden` sliver: NSH places it (real viewport) while the
composition surface shows one pixel. Verified: `innerWidth` 200 → 1600
in the resolver page.

Verified resolver results (movie 1368337 / 550, `rustflix.resolvetest`):

- **devideosrc**: resolves a real HLS `master.m3u8` in ~2–5 s,
  repeatedly.
- **aether**: resolves HLS in ~10–20 s, but intermittently (its backend
  is flaky; several 45 s timeouts between successes).
- **vidsrc, vidfast, vidrift, vidnest**: pages load and the sniffer
  runs, but the players never start — vidfast's page shows its own
  "OOPS! SOMETHING WENT WRONG" error in WebKitGTK; the others leave
  `video.src` empty (likely gesture/compat differences vs WKWebView).
- Upstream playback of resolved links was NOT verified end-to-end,
  and the investigation points at the CDNs refusing this environment,
  not the port:
  - `r1.dropcdn.io`/`ds1.dropcdn.io` (devideosrc) and
    `tik.1x2.space` (aether) answer **403 to every replayed request** —
    with the page's exact Referer/Origin/User-Agent, direct, via the
    env proxy, and via `--noproxy`.
  - The resolver WebView **itself** gets `Forbidden` fetching the
    resolved `master.m3u8` (navigated to it in-page), and the embed
    page's own `<video>` stays `readyState 0`/paused for the whole
    resolve — i.e. the page's own player cannot play the stream in
    WebKitGTK either, so the 403 is not specific to `src/stream`.
  - ureq already honours `http(s)_proxy`/`no_proxy`
    (`Config::default()` → `Proxy::try_from_env()`), so the stream
    proxy and the WebView share the same egress path here.
  - Likely cause: the CDN rejects this datacenter egress IP or
    non-browser TLS fingerprints outright. `src/stream`/`src/dl` are
    shared cross-platform code; macOS would hit the same wall from
    the same network. On a normal residential connection this may
    simply work — untested.

Ad blocking (`sys.webGuard`, `src/webkitgtk.rs`): NSH/wry has no web
view configuration hook, so the Linux side finds every
`WebKitWebView` GtkWidget in the GTK toplevel tree and drives it
directly:

- `script`: `WebKitUserScript` at document start in **all frames** on
  each view's `WebKitUserContentManager` — what macOS gets from
  `WKUserScript forMainFrameOnly: NO`. Without this the media sniffer
  never sees iframe players.
- `rules` / `resolverRules`: the same WebKit content-blocker JSON
  `WKContentRuleList` takes, compiled by `WebKitUserContentFilterStore`
  (under `$XDG_CACHE_HOME/com.hexuria.rustflix/webkit-filters`) and
  attached per content manager — ad rules on every view while `on`,
  resolver rules on views `markResolver` marks (the `__rf_resolver__`
  title protocol is unchanged, the mark is kept with the view's state
  like macOS remembers the controller). **Caveat found the hard way**: compiling
  before the first `WebKitWebView` exists aborts the process (the
  compile runs through the WebKit network process a view spawns), so
  rulesets are queued until a view exists.
- `decide-policy` per view: `NewWindowAction` is always ignored
  (pop-ups never open) and non-web-scheme navigations are refused via
  the shared `webguard::verdict` with `main = false` — the only part
  safe to apply, because WebKitGTK 4.1 exposes no is-main-frame on
  `WebKitNavigationAction` and subframe navigations (embed players live
  in iframes) must not be site-checked. The macOS main-frame site
  policy therefore has **no Linux equivalent yet**.
- `on`, `embeds`, `stats` handled; `hosts`, `patterns`, `allow` are
  accepted but unused (they feed the macOS navigation policy).
- `sys.webCookies` returns the `Cookie` header WebKitGTK would send,
  from the shared default `WebKitCookieManager`.

Verified: both rulesets compile (`content rules compiled` in the
log), the resolver view is marked (`resolver view marked (1)`), and
the app stays up.

## Milestones 6–8

- **M6 host calls**: `sys.pickFolder` is a `GtkFileChooserDialog`
  (SelectFolder) on the GTK main thread; `sys.webBackground` sets the
  background color on every web view; `fs.trash` on Linux goes through
  `gio trash` (Freedesktop Trash); permanent delete only when there is
  no `gio` to run, never when `gio` ran and failed;
  `fs.reveal` uses `xdg-open`; `cache.clear`/`cache.info` already
  covered the app's own caches (image/poster cache); the WebKit
  website-data caches are not cleared on Linux (WebKitGTK shares its
  data dirs across apps — clearing them would nuke other programs').
  `sys.focusContent` stays a stub (returns `{ok:false}`).
  `canPickFolder`/`webBackground` are enabled for `platform.os ===
  "linux"` in `app/lib/system.ts` — the only TSX change, because the
  host calls now exist.
- **M7 window**: `nsh-platform-gpui`'s chrome requests client-side
  decorations on Linux (`_MOTIF_WM_HINTS` decorations=0 under X11) and
  draws its own caption controls, `windowDrag` moves via
  `_NET_WM_MOVERESIZE`, double-click zooms, and
  `Window.toggleFullScreen` maps to GPUI's fullscreen.
  **Traffic lights**: upstream draws GTK-style round buttons at the
  right; the user asked for the macOS look, so `Cargo.toml` patches
  the `nsh-*` crates to `github.com/hexuria/nsh` branch
  `linux-traffic-lights` (commit `6fb68b1`, on top of the published
  0.4.0 — drop the `[patch.crates-io]` section once it lands
  upstream). Linux now draws close/minimize/zoom circles at the left
  with hover glyphs and reports the left title-bar inset like macOS.
  They need a compositor and a window manager that lists
  `_GTK_FRAME_EXTENTS` in `_NET_SUPPORTED` (GNOME, KDE, Xfce do;
  openbox does not): without both, gpui-fast falls back to the window
  manager's title bar and the app shows two bars.
  Verified live: red/yellow/green circles at the window's top-left,
  minimize click iconifies (`_NET_WM_STATE_HIDDEN`), maximize/restore
  and drag verified earlier. Windows/macOS code paths untouched.
  Xwayland itself was not exercised — this machine has no Wayland
  session; under Wayland the same X11 path runs through Xwayland.
- **M8 packaging**: the Linux workflow job now tars the runnable
  folder (`rustflix-linux-x86_64.tar.gz`, binary + `nsh/` bundle) and
  uploads it as the `rustflix-linux-x86_64` artifact. System packages
  a user needs (build-time equivalents in the workflow's "System
  packages" step): `libwebkit2gtk-4.1-0`, `gstreamer1.0-plugins-base`,
  `gstreamer1.0-plugins-good` (playback), `libgtk-3-0`, plus the
  usual fontconfig/freetype and an X11 or XWayland session for the web
  views. Software rendering works (`WEBKIT_DISABLE_DMABUF_RENDERER=1`
  may be needed without a GPU).

## Test hook

`rustflix.nativetest` (storage JSON, consumed once) drives
`app/screens/NativePlayerDebug.tsx`:

- `{"download": <id>, "holdMs": n, "rect": {...}}` — finished download
  via `dl.playUrl`.
- `{"playdownload": <id>, ...}` — finished download through the real
  Downloads → Play path (`playDownload` → route → `localPage` → native
  player); records route/phase/URL origin/failure line.
- `{"stream": {"url": "...", "kind": "hls"|"file"}, ...}` — direct
  `dl.stream.open` session (no resolver).
- `{"type","id","source",...}` — full resolve path (needs a working
  webview; Cloudflare-blocked here).

Results land in `rustflix.nativetest.result` (incremental). Requires
`rustflix.nativeplayer = "1"`.

Note for local runs: the app loads `nsh/` from beside the executable,
so after `cargo build` copy `target/.../out/app/*` into the runnable
folder's `nsh/` — the TSX bundle is not embedded in the binary.

---

# Windows (branch `port/windows-v2`)

Written fresh on top of main `9f330db` (the old `port/windows` branch
is not used; facts taken from it were re-checked here).

**Test machine.** Windows Server 2022, 2 vCPUs, 8 GB, **no GPU**: Direct3D is
the Microsoft Basic Render Driver (WARP, `d3d10warp.dll`). Sampled while
scrolling Home: ~160 % of a core in WARP's thread-pool workers, ~3 % on the
app's main thread. The UI is slow here because the picture is rasterised on
the CPU, not because of app code. Real sources: the Vidfast source played in
the web-page player on this machine (not blocked by Cloudflare); others were
not tried. No audio device on this VM: sound output is unverified.

## Upstream dependency (startup crash)

**Blocked upstream (shipping only).** Per the task, milestones are verified
with the local patch; the CI-built zip crashes until a fixed gpui-fast or nsh
is released (CI run 43788529299: `exited early with code -1073740791`,
`RefCell already borrowed` at gpui-fast-0.1.10 `async_context.rs:178:28`).
Environment limits (this VM, not the app): no audio device (sound and mute
audible effect unverifiable), no GPU (hardware decode unverifiable).

**Status (2026-11-16):** longbridge/nsh#2116 is **merged** but not released
(latest nsh-platform-gpui is 0.5.1); longbridge/gpui-fast#145 is reviewed
(all points addressed), waiting for the owner. Product decision for the
maintainer: this repo already builds nsh from the `hexuria/nsh` branch
`linux-traffic-lights` (Linux traffic lights); #2116 could be carried there
to fix the CI build before an nsh release — not done here (no fork changes).


nsh-platform-gpui 0.4 builds a web view inside `prepaint` while GPUI holds the
app; WebView2 creation pumps messages; a queued GPUI task re-borrows the app:
`RefCell already borrowed` (gpui-fast `async_context.rs:178`), exit
0xC0000409. Fixes, both open and unreleased:

- longbridge/gpui-fast#145: defers GPUI messages that call into the app while
  it is borrowed; drains them in order, also from OS modal loops.
- longbridge/nsh#2116: builds Windows web views outside the app borrow.

Until one ships, local runs use gpui-fast 0.1.10 with #145 backported, applied
through `C:\work\.cargo\config.toml` (`[patch.crates-io]`), **outside this repo**.
Nothing patched is committed, so the CI build of this branch still has the
crash: the windows-latest smoke test is expected to exit early until a
released gpui-fast/nsh contains a fix.

## Milestone 1 — it starts — DONE (with the local patch)

- `cargo build` of this branch + patched gpui-fast: the window opens, Home
  loads (hero, Trending, Now Playing), no panic.
- Driven for minutes with injected input: Home ↔ Search ↔ Settings ↔
  Downloads, scrolling, search typing, Details, Play. Process stays up and
  responding. Screenshots: `C:\tools\shots\m1-start.png`, `m2-*.png`.
- Release builds are GUI-subsystem programs (no console window); debug
  builds keep the console for logs.

- **Timed run (release, 2026-11-16):** 130.7 s of continuous injected
  navigation — Search (typed "fallout", results), Settings → Downloads,
  Downloads, Home with scrolling, back and forth — process alive and
  responding afterwards, 0 panics in the log (`m1-nav-*.png`).

## Milestone 2 — the interface with the web-page player — DONE

- Home, navigation, Search (typing + results + filter chips), Settings
  (all panes listed), Downloads (empty state), Details all render and react.
- **WebView2 pages were black.** GPUI's DirectComposition target is created
  topmost (`CreateTargetForHwnd(hwnd, true)`, gpui-fast-windows
  `directx_renderer.rs`), so it is composed above child windows, and every
  wry web view is a child window (`WRY_WEBVIEW` → `Chrome_WidgetWin_*`). The
  page was there (`page: video ready` in the log; child window visible at
  the right rect) but under GPUI's picture. `src/win` sets
  `GPUI_DISABLE_DIRECT_COMPOSITION=true` before GPUI starts (kept if the user
  set it): GPUI then presents through a swap chain on the window, which
  child windows draw above, as a WKWebView sits above GPUI on macOS.
  Verified: Play → the source's page plays in the window
  (`m2-code-play-60s.png`).
- Known, upstream: while WebView2 is created (nested message pump inside the
  draw), GPUI drops frame and input callbacks that find the app borrowed
  (`ERROR RefCell already borrowed` lines, up to ~20 in ~3 s at startup in
  some runs, none in others). Clicks in that window are lost. nsh#2116 is
  the real fix.
- Typing is slow on this VM (SendKeys waited ~1 s per key in a debug build:
  each key re-renders the results on WARP). Not measured in release yet.
- Downloads shows "0 KB free": `fs.space` has no Windows implementation yet
  (Milestone 4).

## Milestone 3 — native player `rustflix.video` — IMPLEMENTED (verification below)

### Decoder choice (smallest install burden that meets the contract)

| Option | HLS | Contract fit | Install burden | Verdict |
|---|---|---|---|---|
| **Media Foundation `IMFMediaEngine`** (frame-server mode) | yes: master playlist, rendition switches (`FORMATCHANGE`) | HTML5-like events (load, seeked, waiting, ended, error with codes); audio streams via `IMFMediaEngineEx`; WebVTT renditions via `IMFTimedText` with cue start/duration/text; rate, volume, mute, `GetBuffered` | **none**: part of Windows (desktop editions; Server with Desktop Experience; N editions need the Media Feature Pack) | **chosen** |
| WinRT `MediaPlayer` + `AdaptiveMediaSource` | yes | frame server works, but less control over tracks/timed text than the engine | none | not needed |
| GStreamer (shares `src/player/linux/gst.rs`'s logic) | yes | complete | runtime + plugins installed separately (~100 MB), LGPL | rejected: install burden |
| libmpv | yes | complete | ~120 MB DLL + `vulkan-1.dll` beside the exe | rejected: install burden |

Measured here with a standalone probe (`IMFMediaEngine` + D3D11 device on
the Basic Render Driver, no app): the mux HLS test stream loads its
metadata in 0.6 s, plays 1920×1080 at the stream's rate (switching up to
its 60 fps rendition); per frame `TransferVideoFrame` into a BGRA texture
took 3–4 ms and the staging readback 4–14 ms (WARP, 1080p). Apple's
`img_bipbop_adv_example_ts` shows its English WebVTT rendition as an
`IMFTimedText` track whose cues arrive with start, duration and text.

### Painting (what gpui-fast 0.1.10 accepts on Windows)

`Window::paint_surface` (zero-copy video surfaces) is macOS/iOS-only. The
DirectX renderer takes images through the sprite atlas (`paint_image` with
a `RenderImage`), which is what Linux uses: each new frame is read back to
BGRA once and uploaded once; the previous frame's tile is dropped. A 1080p
frame is ~8 MB per upload, so the decoded size is capped to the picture's
size on screen in pixels (and `maxResolution`): `TransferVideoFrame` scales
on the GPU (here: WARP) before the readback.

### Implementation (`src/player/win/`)

- `mf.rs`: one worker thread per player owns the D3D11 device (GPU when
  present → hardware decode, else WARP), the engine, its timed-text service
  and the textures. Props, `sys.nativeVideo` and Media Foundation's
  callbacks only queue messages for it; the main thread only reads the
  newest frame from a mutex. While a frame may be due it asks
  `OnVideoStreamTick` every 8 ms; a paused picture makes no frames and no
  redraws (the worker then only wakes for its 4 Hz tick).
- Events as on Linux: `ready`, `frame` (first frame), `load` (duration,
  size, tracks), `progress` (4 Hz; `buffered`/`playable` = end of the
  buffered range playback is in), `buffer` (WAITING/BUFFERINGSTARTED vs
  PLAYING/BUFFERINGENDED), `seeked` (SEEKED, 5 s fallback in the tick),
  `rate` (on pause changes), `end`, `error` (`network`/`decode`/
  `unsupported`/`drm`/`aborted` + HRESULT), `tracks`, `cues`.
- `startAt` goes out as the first `SetCurrentTime` once the metadata is
  in, before `Play`; `progress` reports the target until playback is there.
- `maxResolution` caps the decoded picture (not the rendition Media
  Foundation picks by bandwidth). `pip`/`nowPlaying`: not on Windows.
- `sys.nativeVideoInfo.available` probes the engine's class factory once.

### Milestone 3 — verification (release build, this VM)

- **HLS through the local proxy** (`dl.stream.open` → `rustflix.video`,
  nativetest `{"stream": {...mux x36xhzz...}}`): first frame 1.0–3.0 s,
  `load` 634.6 s with its audio track; seeks to 10 / 50 / 90 % landed
  within 15–400 ms (`finished: true`); a forced upstream 403 → `expired` →
  playback resumed (stall 0.4 s). Frames arrive at the stream's rate (~31/s
  at 1080p source, decoded at the 960×540 picture); the TSX press target
  draws over the picture (`m3-rel-a.png`, `m3-rel-b.png`: the picture
  moves between them).
- **Debug builds are not representative**: the proxy (rustls, unoptimised)
  delayed the first frame to 7–12 s and the frame rate fell to 4–8/s.
- **Paused = no redraws**: real Player screen, HLS download, pause →
  rustflix 0.0 % of a core over 8 s; playing 480p ≈ 29 % (decode + WARP).
- **App's own controls over the picture** (real Player screen,
  Downloads → Play): ±10 s, play/pause, progress, speed, subtitles, volume,
  full screen (`m4-hls-controls.png`, `m4-hls-paused.png`).
- CPU while a 1080p HLS stream plays at 960×540: ≈ 118 % of one core
  (Media Foundation's software decode + WARP), on 2 vCPUs.
- Subtitle renditions: Apple's bipbop (`img_bipbop_adv_example_ts`) through
  the local proxy: `load` lists English audio and an English subtitle track
  (`t0`); `selectSubtitle t0` → `tracks` with `t0` selected → `cues`
  `{time: 0.008, lines: ["Subtitles: Bip!"]}` (nativetest `trackSelect`).
- **Real sources not tested with the native player**: the resolver finds
  no stream link on Windows yet (`candidates=0`): its hidden web view keeps
  a 200×200 viewport and its media sniffer runs only in the main frame.
  Both need the web-view hook of Milestone 5.
- Not verifiable here: sound (no audio device on this VM), hardware decode
  (no GPU).

## Milestone 4 — downloads — DONE (in-app downloading of a title: not tested)

- **Finished downloads play** in `rustflix.video` from the downloader's
  127.0.0.1 server (`local: true`): nativetest `{"playdownload": 1}` (mp4)
  and `{"playdownload": 2}` (HLS: `index.m3u8` + segments) go through the
  real Downloads → Play path; phase `playing` in ~3.5 s, title bar shows the
  downloaded mark (`m4-playdl-mp4.png`). The two records were made by hand
  (folder + `.rustflix-download` marker + `rustflix-downloads.json` entry),
  as a finished download leaves them.
- **`fs.space`**: `GetDiskFreeSpaceExW` (`src/win/shell.rs`). Downloads
  shows "4.1 MB used · 18 GB free" (`m4-downloads.png`).
- **Reveal in Explorer**: `SHOpenFolderAndSelectItems` (the old
  `explorer /select,…` broke on paths with spaces). Row menu → Show in
  folder opened the record folder with the file selected (`m4-reveal.png`).
- **Recycle Bin**: `IFileOperation` with `FOFX_RECYCLEONDELETE`, no UI. A
  progress sink refuses any item the shell would delete for good instead
  (its `PreDeleteItem` lacks `TSF_DELETE_RECYCLE_IF_POSSIBLE`), like the
  Linux Trash never falling back to deleting. Before this, Windows deleted
  permanently. Verified: row menu → Delete download → "dl: #1 removed
  (folder trashed: true)", the folder in the Recycle Bin with its original
  location; `trash_recycles` / `trash_refuses_where_it_would_delete`
  (ignored tests, run by hand: a file on `\\localhost\C$` stays).
- **Default download folder**: `dl` took the home folder from `HOME`, which
  Windows programs do not have, so it was the *relative* `Downloads\rustflix`
  (under whatever the working directory was). Now `USERPROFILE` on Windows;
  a relative folder stored by such a build falls back to the default.
- **Forbidden download folders** on Windows: `SystemRoot`, the Program
  Files folders, `ProgramData`, `%USERPROFILE%\AppData`, the Recycle Bin and
  the app's own folder (the Unix list does not apply).
- **Path checks**: in a verbatim Windows path (`\\?\C:\…`, what
  `canonicalize` returns) `/` is no separator, so `a/../b` was one
  component that slipped past the `..` check and `PathBuf::push` then
  resolved — out of the download folder. `files::inside` and
  `folder::validate` now refuse such components (no change on Unix,
  where no component holds a `/`).
- `cargo test` on Windows: 95 passed (3 tests had Unix-only assumptions;
  fixed for both).
- Not tested: downloading a title in the app (the resolver needs Milestone
  5 first); the downloader's own tests (local HTTP server, HLS, resume) pass.

## Milestone 5 — ad and pop-up blocking for web views — DONE

**Reaching WebView2.** wry builds every web view's controller itself, NSH
keeps the `wry::WebView`, and wry's `WRY_WEBVIEW` window stores no pointer
to it, so the controller cannot be found from the window. Options weighed:

| Option | Verdict |
|---|---|
| Patch WebView2's own entry point (`ICoreWebView2Environment10::CreateCoreWebView2ControllerWithOptions`, + the base `CreateCoreWebView2Controller`) in the environment class's COM vtable, at startup | **chosen**: the Windows twin of the macOS guard's WebKit method hooks; COM vtable layouts are a fixed ABI and the class's vtable is shared by every environment of the loaded runtime; each controller is set up before wry gets it, before its first navigation |
| Chromium DevTools protocol (`--remote-debugging-port` via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`) | rejected: opens a local port that any process could drive (cookies included) |
| A hook in NSH (hand the host each `wry::WebView`) | the proper long-term fix; needs an upstream change |

`src/win/webview.rs`: `install()` (after logging starts, before GPUI) makes a
throwaway environment in its own temp profile and replaces the two vtable
slots (4 ms here). The replacement wraps wry's completion handler; for each
new controller `adopt` adds, then hands it on:

- the guard script (`adblock.ts` GUARD_JS + the media sniffer) with
  `AddScriptToExecuteOnDocumentCreated` — it runs in child frames too (the
  resolver's sniffer reports streams from the embed's frames);
- a `WebResourceRequested` filter over every frame's requests
  (`AddWebResourceRequestedFilterWithRequestSourceKinds`): the WebKit
  content rules `sys.webGuard` sends (`rules`, `resolverRules` for the
  marked resolver) compiled to one `RegexSet` each, evaluated in order (last
  match wins; `ignore-previous-rules`), `resource-type`/`load-type` as WebKit
  does; a blocked request gets a 403;
- `NewWindowRequested` → handled (no pop-up windows, as on macOS);
- `NavigationStarting` (main frame) → `webguard::verdict`, the same rule as
  macOS (embed hosts, the site shown, its redirects while pending until
  `ContentLoading`); `FrameNavigationStarting` → no non-web schemes;
- camera/microphone permission requests → denied while on.

`markResolver` finds the resolver's view by its document title, applies the
resolver rules and gives it a real viewport: its `WRY_WEBVIEW` window is
sized 1600×900 and clipped to a 1×1 window region, the controller made
visible (NSH never places a view with no geometry, so it kept its 200×200
creation size — the Linux symptom, `candidates=0`). `sys.webCookies` reads
the profile's cookie manager (HttpOnly included); `sys.webViews` and
`sys.webBackground` work on Windows too.

Verified (release build, real source "vidfast", this VM):

- Hook in 4 ms; the guard took both web views; the resolver was marked.
- **Native playback of a real title**: the resolver found the HLS master in
  ~16 s (`candidates=2`, "via xhr from https://vidfast.vc" — the sniffer
  running in the embed's frames); `rustflix.video` played it through the
  local proxy from the stored resume point (`m5-full.png`: the app's own
  window, no web page). The 1080p stream saturates both vCPUs here (WARP:
  GPUI's redraw + Media Foundation's colour conversion on the CPU).
- **Web-page player** (`rustflix.nativeplayer` = "0"): the source's page
  plays; 17 requests to ad/tracker hosts blocked in the first ~40 s
  (googletagmanager, cloudflareinsights, three throwaway ad domains); clicks
  on the page opened no window.
- Not exercised: a refused main-frame navigation (none attempted in the
  runs); `sys.webCookies` output not inspected yet.

## Milestone 6 — the remaining host calls — DONE

- **`sys.pickFolder`**: `IFileOpenDialog` with `FOS_PICKFOLDERS`, modal to the app
  window, starting in the current folder; `{ok, path}` / `{ok, cancelled}` as on
  Linux (`src/win/shell.rs`). Verified: Settings → Downloads → Change… → the
  system picker → Videos → "Move 1 download?" → moved (`m6-picker.png`,
  `m6-pick-b.png`); Use default moved it back.
- **`cache.clear` of web data**: the web views' WebView2 profile now lives in
  `%LOCALAPPDATA%\com.hexuria.rustflix\WebView2` (`WEBVIEW2_USER_DATA_FOLDER`,
  set after the hook's probe; a value the user set wins). WebView2's default
  is a folder beside the executable, which fails where that is read-only
  (Program Files). `cache.info` measures `…\EBWebView\Default\Cache` (video
  pages) and `…\Default` (site data); `cache.clear` goes through the live
  profile (`ICoreWebView2Profile2::ClearBrowsingData`: disk cache + cache
  storage; site data: all site kinds + disk cache), as macOS goes through
  `WKWebsiteDataStore`. Verified: Storage & privacy showed 8.9 MB / 1.6 MB /
  4.4 MB; Clear → "Cleared 1.1 MB of video page files" (`m6-cleared.png`).
- **`sys.focusContent`**: keyboard focus back to the app's GPUI window
  (`SetFocus`) after a web view (a child window) held it. Implemented, not
  exercised by a test.
- `sys.webViews`, `sys.webBackground`: Windows versions (milestone 5).
- **TSX** (`platform.os` gated): `app/lib/system.ts` asks the `sys.*` calls on
  Windows too (they were macOS/Linux only); `app/lib/downloads.ts` takes
  Windows folder paths (drive or UNC; `\\` separators) in `changeDownloadDir`,
  which only accepted paths starting with `/`.
- **Download folder paths**: `folder::validate` canonicalises, which on Windows
  gives verbatim paths (`\\?\C:\…`) — they reached the settings and the records.
  The folder is now kept in its plain form (and a stored verbatim one is
  read back plain).
- Still not on Windows: the FPS monitor's native panel (`src/perf`, a macOS
  developer tool).

## Milestone 7 — window — DONE

Verified with injected mouse input on this VM (`m7-*.png`):

- **Caption buttons**: minimize (iconic), maximize ↔ restore, close (the
  process exits; GPUI logs three teardown errors on the way out —
  "window not found", "Class not registered", "Invalid window handle").
- **Dragging, Snap, double click** were broken: NSH marks its `windowDrag`
  views as caption (`HTCAPTION`), but its drag area also handles the press
  (`stop_propagation`, nsh-platform-gpui `chrome.rs` `drag_area`), so gpui-fast
  reports it handled and `DefWindowProc` never sees it; NSH's fallback
  `start_window_move` does nothing on Windows and its double click only
  maximizes (`zoom_window`). `src/win/window.rs` subclasses GPUI's windows
  so a left press or double click on the caption goes to `DefWindowProc`,
  as for any captioned window. After it: the title bar drags the window;
  dragging to the top edge maximizes (Aero Snap); dragging a maximized
  window restores it; Win+← snaps to the left half; a double click toggles
  maximize. The title bar's own buttons (back/forward) still work.
- **Full screen**: the player's full-screen button fills the screen
  (`0,0–1920,1080`, over the taskbar) and restores the window.
- **Keyboard**: player shortcuts reach the app — `m` muted the native player
  (Media Foundation VOLUMECHANGE) once the window was activated. The test
  input can only activate the window with an Alt tap, which also enters
  NSH's Windows menu-bar mode.
- **Open**: `Esc` ("dismiss": closes the player on macOS) did not close the
  player in three injected attempts, in or out of full screen; whether the
  Alt-tap menu mode or the app swallows it is not determined. Full screen is
  left with the player's button (verified) — the goal's milestone does not
  depend on `Esc`, but this needs a check with a real keyboard.
- **Not available here**: Snap Layouts (the Windows 11 flyout on the maximize
  button; this is a Windows 10–based Server — the maximize button answers
  `HTMAXBUTTON`, which is what Windows 11 needs).
- Reported upstream: longbridge/nsh#2143 (`drag_area` should let caption
  presses through on Windows).

## Milestone 8 — package — DONE (CI zip; the crash fix is still upstream)

- `desktop-ports.yml` (windows-latest) now uploads `rustflix-windows-x86_64.zip`:
  `rustflix.exe` (GUI subsystem, release), `nsh/` (the TSX bundle) and
  `README.txt` (`packaging/windows/README.txt`: requirements — Windows 10 1809+
  / 11 x64, the WebView2 runtime with where to get it, Media Foundation /
  the Media Feature Pack on N editions; where the app keeps its data; not
  signed yet). No installer, no signing (as asked).
- Verified locally with the same layout: the folder copied to the Desktop
  and the zip expanded run as is; no console window; WebView2's profile goes
  to `%LOCALAPPDATA%\com.hexuria.rustflix\WebView2`, nothing is written beside
  the executable.
- **The CI-built zip still crashes at startup** (`RefCell already borrowed`,
  exit 0xC0000409 — the windows-latest smoke step shows it) until a released
  gpui-fast contains longbridge/gpui-fast#145 or a released nsh contains
  longbridge/nsh#2116; every local verification above used gpui-fast 0.1.10
  with #145 backported (`C:\work\.cargo\config.toml`, outside the repo). Once
  either ships, the version bump goes in `Cargo.toml`/`Cargo.lock` (nsh 0.5.x
  needs gpui-fast ≥ 0.1.13; that migration is its own change).
- No extra DLLs: Media Foundation and WebView2 are Windows'.

## Performance on a machine without a GPU (2026-11-16)

Measured on the VM (Windows Server 2022, 2 vCPU, no GPU: Direct3D 11 runs on
WARP, the CPU rasterizer), release build, after the first screen settled
(loading Home keeps both CPUs busy for ~40 s; earlier numbers are polluted).

- **Cause.** NSH paints a frame in < 1 ms and GPUI encodes it in 0.5 ms;
  WARP then shaded ~300 ms per frame (3–5 fps while scrolling). Switching
  primitive kinds off one at a time showed it was quads: **overdraw**, the
  quads covered 5.7× the window per frame (window, content area, page and
  pages kept under the one shown, each an opaque full-size background).
  Shader complexity and clip distances were ruled out by experiment.
- **gpui-fast: overdraw culling** (draft longbridge/gpui-fast#149; local
  patch here). Primitives a later opaque rectangle or opaque image hides are
  not drawn; partly covered plain quads are drawn as their uncovered pieces.
  Pixel tests compare culled and whole drawing byte for byte.
  Home scrolling: quads 5.7× → 1.9× the window, `Present` ~300 → ~100 ms,
  CPU 165% → ~110%.
- **rustflix: video frames through the CPU** (`src/player/win/wic.rs`).
  On the Basic Render Driver the media engine converted each frame on WARP:
  60–90 ms for a 640×360 frame (~8 fps shown). Without a DXGI manager the
  engine decodes in software and transfers into a WIC bitmap: ~1 ms a frame.
  `RUSTFLIX_MF_SOFTWARE=1/0` forces the path; with a GPU the Direct3D path
  (hardware decode) stays.
- **Video result** (same 10 s 30 fps 360p file Edge plays; Downloads → Play):
  frames decoded 8 → 30 per second; painted ~2 → **23.1–25.7** per second
  with the window focused (8 runs, median ≈ 24; ~23 unfocused, where GPUI
  draws at 30 Hz); 10 s of media in 10 s; ~105–115% CPU playing, 0%
  paused; subtitles (bipbop `t0`: "Subtitles: Bip!"), controls over the
  picture and the web-page player checked.
- **What limits video now** (measured): putting each frame into GPUI's
  sprite atlas (`paint_image`) waits 8–21 ms for WARP to finish with the
  atlas texture the previous frame draws from (p50 0.5 ms, p90 34 ms per
  paint). gpui-fast 0.1.10's atlas has no path for an image that changes
  every frame. Moving the upload off the CPU's path (a texture made with
  the pixels and a queued copy, tried in the local patch) removed that wait
  but not the ceiling (22.9–23.9 fps over 4 runs): the frame rate is bounded
  by WARP drawing each frame (~40 ms, mostly the full-window picture). Past
  it, the picture has to be composed outside GPUI's frame (Media Foundation
  into a DirectComposition surface under a transparent GPUI base), which
  needs gpui-fast (a non-topmost composition target, so WebView2 child
  windows stay visible; an external surface below the base) and NSH (a
  transparent window; pages under the player not painted) — not done.
- **Next, prototyped only** (`C:\tools\perf-p3.md`, not in any repo):
  partial redraw of scrolled frames in the renderer (copy the previous frame
  shifted, draw only the exposed strip and what changed, scissored): Home
  scrolling `Present` 97 → **19 ms**, CPU 102% → 17%, checked against whole
  drawing (within 2/255: image sampling rounds differently after a move).
  Needs a design upstream (scroll hints from NSH, translation-invariant
  sprite sampling) before it can ship.
- On any machine with a GPU none of this is visible: the app's own work per
  frame is ~1.5 ms.
