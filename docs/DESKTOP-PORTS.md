# Desktop ports: Windows (branch `port/windows`)

Working notes for making rustflix a native Windows app, on top of
`spike/desktop-ports` (draft PR #6). Milestones are the ones in the task;
each says what is done, how it was verified, and what is not.

## Machine / tooling

- Windows Server 2022 x86_64, 2 CPUs, no GPU (Microsoft Basic Render
  Driver). Debug `cargo build` is the iteration build; release builds are
  left to the `windows-latest` CI job.
- GUI apps must be started through `C:\tools\gui.ps1 <exe>` (SSH has no
  desktop); output lands in `C:\tools\gui-run.log`.
- Screenshots: kept outside the repo (voxl view / captures), not committed.

## Milestone 1 — the app starts

Status: **blocked upstream; minimal reproduction written.**

Known crash (from PR #6's smoke test, reproduced locally with
`RUST_BACKTRACE=full` via `C:\tools\gui.ps1`): the exe dies within
seconds: after `Using GPU: Microsoft Basic Render Driver` and `Created
device with Direct3D 11.1 feature level`, `thread 'main' panicked at
gpui-fast-0.1.10/src/app/async_context.rs:178:28: RefCell already
borrowed` (exit 0xC0000409).

### Root cause — confirmed, upstream

Full backtrace of the real app:

- `Window::new` → `Window::draw` → `prepaint` →
  `nsh_platform_gpui::native::web::WebItem::prepaint` → `WebItem::set` →
  `lb_wry::WebViewBuilder::build_as_child` → `InnerWebView::new_as_child`
  → `webview2_com::wait_with_pump`, a nested `GetMessageA`/`DispatchMessageA`
  loop that waits for WebView2's async environment/controller creation.
- The nested pump dispatches an already-queued
  `WM_GPUI_TASK_DISPATCHED_ON_MAIN_THREAD`. The window procedure runs
  `run_foreground_task` (gpui-windows `platform.rs`), which polls a
  pending foreground task — in the captured run it was
  `nsh_platform_gpui::rt::after_ms` for `text_input::blink` (the caret
  blink timer, `BLINK_MS = 530`).
- That task calls `AsyncApp::update` → `AppCell::borrow_mut`
  (`async_context.rs:178`) → panic, because the whole draw is running
  inside `AnyWindowHandle::update`/`update_window_erased`, which holds
  `&mut App` (the `AppCell` `RefMut`) for its duration.

So: **any** nested Win32 message pump while GPUI is mid-draw/update +
**any** pending foreground task = panic. Three upstream layers combine:
gpui-fast-windows dispatches foreground tasks from *any* dispatched
message (it cannot tell a nested pump from the real loop), lb-wry pumps
the thread queue synchronously inside `build_as_child`, and
nsh-platform-gpui creates web views inside `prepaint` (i.e. inside the
borrowed draw).

### Minimal reproduction

`examples/nested-pump-repro.rs` reproduces the panic with no wry/nsh/
rustflix code: it queues a foreground task, then calls
`AsyncApp::update` and pumps the message queue inside the borrow — the
nested dispatch runs the task's `cx.update` → identical panic at
`async_context.rs:178:28`. Verified on this machine: same file, same
line, same `RefCell already borrowed`. Run:
`cargo run --example nested-pump-repro` on a Windows desktop.

### What was tried

- `cargo update` of the gpui-fast family to 0.1.15 (semver-compatible
  with the `^0.1.x` specs): **does not compile** —
  `KeyBinding::new` now takes `&'static str` (changed in 0.1.11) and
  nsh-platform-gpui 0.4.0 passes a temporary `String`. nsh-platform-gpui
  0.5.1 requires gpui-fast ^0.1.13, so the pairing exists upstream, but
  migrating the whole nsh stack 0.4 → 0.5 is a separate, larger change.
- Checked gpui-fast 0.1.15 source anyway: `AsyncApp::update` still
  hard-panics on re-borrow, and `run_foreground_task` still executes
  queued runnables unconditionally during nested dispatches. The bug is
  **not fixed** in any released version.
- Checked nsh-platform-gpui 0.5.1's `native/web.rs`: web views are
  still built synchronously inside `prepaint` → same exposure.

### Why there is no app-side fix

- wry offers no hook to defer or re-parent the synchronous
  `build_as_child`; nsh-platform-gpui calls it inside `prepaint` and we
  cannot patch registry sources (no forks allowed).
- The pending task can be *any* foreground task (blink timer, engine
  commits, timers). Even if startup were made quiet, creating a web view
  later (e.g. opening the embed player) races the same way.
- `AsyncApp`/`ForegroundExecutor` are `!Send`, so nothing can be
  pre-staged from another thread to shorten the pump.

### Suggested upstream fixes (for the report)

- gpui-fast-windows: don't run foreground tasks when the dispatch is
  nested inside an app borrow — e.g. a thread-local "in update/draw"
  depth counter checked by `run_foreground_task` (re-post the wake
  message instead of draining), or make `AppCell::borrow_mut` failures
  in task context defer instead of panic.
- Alternatively/al additionally: nsh-platform-gpui could create web
  views outside `prepaint` (e.g. on `set`, before the draw, or in a
  deferred task once the surface is placed), and/or wry could offer an
  async creation path that doesn't pump the caller's queue.

### Also done under M1

- `macos-latest` `cargo build --release` job added to
  `desktop-ports.yml` (first commit on this branch); workflow triggers
  now include `port/*`.
- Console-window fix: `#![cfg_attr(target_os = "windows",
  windows_subsystem = "windows")]` in `src/main.rs` — the exe was
  console-subsystem, so Windows showed a command prompt next to the app.
  stdout/stderr still reach explicitly redirected handles (`gui.ps1`,
  CI), so logging is unchanged. Verified: logs still land in
  `C:\tools\gui-run.log`.

### Not verified / known problems

- The app still cannot start on Windows until upstream fixes the
  re-entrant borrow (or nsh moves webview creation out of `prepaint`).
- Real streaming sites were not tested (Cloudflare bot checks on cloud
  machines); unrelated to this crash.

## Milestone 3 — native player (`rustflix.video` on Windows)

Status: **evaluated, not implemented.** Blocked on M1 for verification,
but the design work below is source-verified.

### How frames reach the screen (what GPUI 0.1.10 offers on Windows)

- `gpui::surface()` / `Window::paint_surface()` are **Apple-only**:
  `SurfaceSource` has a single `CVPixelBuffer` variant
  (`gpui-fast-0.1.10/src/elements/surface.rs`), and `PaintSurface`'s
  `image_buffer` field is `#[cfg(macos|ios)]`.
- `draw_surfaces` in `gpui-fast-windows-0.1.10/src/directx_renderer.rs`
  is a **no-op** — there is no external-texture/video primitive on
  Windows at all in 0.1.10.
- The only raster path is `Window::paint_image` → the sprite atlas
  (`AtlasState`/`PlatformAtlas`), fed by `RenderImage`
  (`gpui-fast-0.1.10/src/assets.rs`): CPU bytes, "BGRA format". Polychrome
  atlas textures are `DXGI_FORMAT_B8G8R8A8_UNORM`
  (`directx_atlas.rs`). Decoded images get their R/B channels swapped
  into BGRA order (`platform.rs decode_static_image`); a `image::Frame`
  is an `RgbaImage` whose raw bytes we can fill with B,G,R,A directly
  (`ImageBuffer::from_raw`, zero-copy).
- Atlas caveat: **no eviction**. `tiles_by_key` grows forever, so a new
  `RenderImage` per frame must be paired with `window.drop_image(old)`
  (which deallocates the tile) or the atlas leaks ~8 MB of GPU memory
  per frame. With drop_image the live cost is ~1 video tile.
- gpui-fast 0.1.15 adds "mutable dynamic textures for streaming frames"
  (#86) + a Windows dynamic-texture backend (#131) — the *right* API for
  video — but it doesn't compile against nsh-platform-gpui 0.4.0
  (see M1) and doesn't fix the startup crash anyway.

### Per-frame cost estimate (1080p, atlas path)

- BGRA 1920×1080 = ~8.3 MB/frame. Decode output → `RenderImage` wrap is
  zero-copy; the per-frame main-thread cost is the atlas upload
  (`UpdateSubresource` of ~8.3 MB inside `paint_image`) plus
  `drop_image` bookkeeping — roughly 1–3 ms on a real GPU, several ms
  on the Basic Render Driver. At 24–30 fps that is ~25–75 ms/s of main
  thread — acceptable if decode happens off-thread; tight but plausible.
- Decoder must therefore produce **BGRA on a background thread** and
  hand the main thread only the newest frame (same newest-frame-wins
  rule as macOS's `latest` CVPixelBuffer and Linux's appsink
  `RenderImage`). Paused = no redraws, same as today.

### Decoder evaluation

| Option | HLS | Contract fit | Install burden | Verdict |
|---|---|---|---|---|
| Media Foundation (classic `IMFSourceResolver`/Source Reader) | **No** — desktop MF does not resolve `.m3u8`; HLS needs WinRT `AdaptiveMediaSource` or a self-registered byte-stream handler | n/a | none | rejected for HLS |
| WinRT `MediaPlayer` + `AdaptiveMediaSource` (frame-server mode) | Yes (HLS+DASH) | Partial: `IsVideoFrameServerEnabled` + `VideoFrameAvailable` + `CopyFrameToVideoSurface(IDirect3DSurface)` gives frames, but the API surface lacks volume/mute/rate and per-track selection parity, and subtitle cue access is unclear | none (OS) | fallback only |
| GStreamer (playbin + appsink, like Linux / nsh 0.5.1 `video` feature) | Yes (hlsdemux) | Good: tracks, volume, rate, text streams | heavy: runtime + plugin set ~50–150 MB, LGPL | viable, heavier than mpv |
| **libmpv (mpv render API, SW)** | Yes (ffmpeg hls demuxer) | **Best**: `track-list` (audio/subtitle ids, lang, title, selected), `volume`/`mute`/`speed`, `pause`, `time-pos`/`duration`, `paused-for-cache`/`seeking` (buffer), `end-file`, `sub-text`/`track-list` (cues approx.), `http-header-fields` for proxied URLs | bundled DLLs (~40–60 MB, mpv-2.dll + ffmpeg) inside the zip — no separate install; GPL-compatible with GPL-3.0 | **recommended** |
| FFmpeg alone | Yes | Would still need an audio output + sync layer | similar DLL weight | rejected (mpv already solves it) |

libmpv specifics (verified against `include/mpv/render.h`):

- `MPV_RENDER_API_TYPE_SW` + `MPV_RENDER_PARAM_SW_SIZE/FORMAT/STRIDE/
  POINTER` renders to a caller CPU buffer. Formats: `"0bgr"`, `"bgr0"`,
  `"rgb0"`, `"0rgb"`, `"rgb24"` — all opaque; the X byte is **garbage**.
  Verified the shader needs it: `polychrome_sprite_fragment` in
  `gpui-fast-windows-0.1.10/src/shaders.hlsl` multiplies `sample.a` into
  the output, so we must set alpha=255 on every frame (a stride-4 fill
  over ~8 MB, ~1–2 ms) — no way around it with mpv's SW formats.
- SW rendering is documented "extremely simple (but slow)": decode +
  colorspace + scale + OSD on one CPU thread. For 1080p this is the
  risk point on 2 vCPUs; `sw-fast`/zimg options and `maxResolution`
  capping mitigate. Hardware decode is *not* usable anyway: GPUI's D3D11
  device is internal and 0.1.10 has no external-texture path, so every
  frame ends up CPU-side regardless — SW decode+render is the honest
  minimum.
- Alternative inside mpv: GPU render API (OpenGL) + `glReadPixels` —
  more moving parts for no benefit on this stack; keep SW.

### Proposed architecture (mirrors `av.rs`'s rules)

- New `src/player/win/` (cfg windows): an mpv client on a dedicated
  thread owning `mpv_handle` + `mpv_render_context`; renders SW BGRA
  into a reused buffer at the capped display size; publishes the newest
  `Arc<RenderImage>`-ready BGRA buffer + metadata (time, duration,
  buffered ranges via `demuxer-cache-state`, track list, cues) to a
  mutexed slot; a wake callback asks the component to redraw.
- `component.rs`-side: a custom `Element` whose `paint` calls
  `window.paint_image` with the latest frame's `RenderImage` and drops
  the previous one — the Windows twin of the macOS `Surface` element.
  `render()` returns `None`/placeholder until the first frame, exactly
  like `player.frame()?` today.
- `sys.nativeVideoInfo`: `available: true` only for what works — PiP
  `false` on Windows; tracks/fit/startAt/maxResolution per mpv.

### Open questions for implementation

- ~~Alpha byte~~ — resolved: the sprite shader uses texture alpha; fill
  X=255 per frame (see above).
- `cues`: mpv gives `sub-text` (current text) but not cue in/out times;
  options are emitting `cues` on text change (check what
  `app/lib/nativevideo.tsx` actually consumes) or fetching the sidecar
  subtitle file ourselves. Decide at impl time against the TSX contract.
- mpv distribution: mpv-dev zip from mpv-player releases (build.rs or
  CI download) vs vcpkg `libmpv` — pick smallest-friction at impl time;
  record here.
- Real-source codec coverage (HEVC/AV1/AC3) is whatever ffmpeg-in-mpv
  ships — fine for the test streams; real sites untested (Cloudflare).
