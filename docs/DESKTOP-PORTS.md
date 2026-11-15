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

Status: in progress.

Known crash (from PR #6's smoke test): the GitHub-built exe dies within
seconds: after `Using GPU: Microsoft Basic Render Driver` and `Created
device with Direct3D 11.1 feature level`, `thread 'main' panicked at
gpui-fast-0.1.10/src/app/async_context.rs:178:28: RefCell already
borrowed` (exit 0xC0000409).

Investigation so far (source reading, not yet reproduced locally):

- `async_context.rs:178` is `AsyncApp::update`'s `app.borrow_mut()` — a
  second mutable borrow of the single-threaded `AppCell`.
- gpui-fast-windows already guards the *frame* path
  (`draw_in_progress()` in the `on_request_frame` callback, window.rs
  ~1818), but not the *foreground task* path.
- wry (lb-wry 0.53.3) builds WebView2 with `webview2_com::wait_with_pump`,
  a nested `GetMessage`/`DispatchMessage` loop
  (webview2-com-0.38.2/src/lib.rs:60). NSH builds web views in `prepaint`
  (nsh-platform-gpui native/web.rs `WebItem::build`), i.e. inside
  `window.draw`, i.e. inside `App::open_window`'s `AppCell` borrow. A
  `WM_GPUI_TASK_DISPATCHED_ON_MAIN_THREAD` already queued (e.g. the perf
  monitor's `Shell` listen task, spawned in `Shell::new`) is then
  dispatched by that nested pump, `run_foreground_task` polls it, the
  task calls `AsyncApp::update`, and the `RefCell` panics.

To verify: local debug build + `RUST_BACKTRACE=full` run (in progress —
first full build on this 2-CPU box is slow).
