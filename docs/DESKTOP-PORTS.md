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
