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

- **Real streaming sources were not tested** — the hidden resolver
  webview hits Cloudflare on cloud machines (milestone 4). Playback
  was verified through `dl.stream.open` directly and through finished
  downloads.
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
- Upstream playback of resolved links was NOT verified end-to-end:
  both devideosrc (`r1.dropcdn.io`) and aether (`tik.1x2.space`)
  answers **403 to every replayed request** — with the page's exact
  Referer/Origin/User-Agent, direct and via proxy. The CDN tokens
  appear bound to the embed session (cookies/TLS fingerprint or
  single-use); `src/stream`/`src/dl` are shared cross-platform code,
  so this limitation is not Linux-specific.

Not verified: the visible fallback page (web-backend playback),
subframe players on real titles, `sys.webGuard` content-blocker rules
(`rules`/`on`/`embeds`/`markResolver` are not wired on Linux yet —
script injection and cookies are).

## Milestones 5–8 — NOT DONE

- Ad/pop-up blocking rules (`sys.webGuard` rules/`on`/`embeds`),
  remaining host calls (`sys.pickFolder`, Trash, `cache.clear`),
  window controls, `.tar.gz` packaging.

## Test hook

`rustflix.nativetest` (storage JSON, consumed once) drives
`app/screens/NativePlayerDebug.tsx`:

- `{"download": <id>, "holdMs": n, "rect": {...}}` — finished download
  via `dl.playUrl`.
- `{"stream": {"url": "...", "kind": "hls"|"file"}, ...}` — direct
  `dl.stream.open` session (no resolver).
- `{"type","id","source",...}` — full resolve path (needs a working
  webview; Cloudflare-blocked here).

Results land in `rustflix.nativetest.result` (incremental). Requires
`rustflix.nativeplayer = "1"`.

Note for local runs: the app loads `nsh/` from beside the executable,
so after `cargo build` copy `target/.../out/app/*` into the runnable
folder's `nsh/` — the TSX bundle is not embedded in the binary.
