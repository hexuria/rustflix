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
- **Deadlock found and fixed**: `send_event(SELECT_STREAMS)` (and
  seeks) can wait on GStreamer streaming threads, which take the
  player's mutex in the appsink callbacks. All pipeline calls now run
  outside the `Inner` lock (`seek_prepare`/`select_streams` return a
  job; the caller sends it after unlocking).
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
  subframes). Re-scans every 700 ms so web views created later are
  covered.
- `sys.webCookies {url}` — the `Cookie` header WebKitGTK would send,
  from the default context's cookie manager.
- `sys.webViews` — per-view url/title/allocation/visibility.
- `sys.webEval` + `/tmp/rf-webeval.json` — file-driven JS evaluation
  diagnostic (the result lands in `/tmp/rf-webeval-result.json`).

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
  title protocol is unchanged, widget pointer remembered like macOS
  remembers the controller). **Caveat found the hard way**: compiling
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
  `gio trash` (Freedesktop Trash) with permanent delete as fallback;
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
