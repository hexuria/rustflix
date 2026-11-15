//! Minimal reproduction for the Windows startup panic:
//!
//!   thread 'main' panicked at gpui-fast-0.1.10/src/app/async_context.rs:178:28:
//!   RefCell already borrowed
//!
//! Mechanism (matches the rustflix backtrace):
//!   1. A foreground task is queued and its wake message
//!      (WM_GPUI_TASK_DISPATCHED_ON_MAIN_THREAD) sits in the thread queue.
//!   2. Something borrows the AppCell and pumps the thread's message queue
//!      while borrowed — in rustflix this is wry's `wait_with_pump` inside
//!      `WebItem::prepaint` -> `WebViewBuilder::build_as_child`, called
//!      during `Window::draw` inside `AnyWindowHandle::update`.
//!   3. The nested `DispatchMessageW` delivers the wake message; the window
//!      procedure runs `run_foreground_task`, which polls the queued task.
//!   4. The task calls `AsyncApp::update` -> `AppCell::borrow_mut` -> panic,
//!      because step 2's borrow is still held.
//!
//! This example reproduces steps 1-4 without wry: `AsyncApp::update` holds
//! the borrow while `pump_messages` dispatches the queued wake message.
//! Run on Windows with a desktop session: `cargo run --example nested-pump-repro`

#[cfg(target_os = "windows")]
mod imp {
    use std::ffi::c_void;
    use std::time::{Duration, Instant};

    use gpui_platform;
    use nsh_platform_gpui::gpui::{
        self, AppContext as _, Context, IntoElement, Render, Styled as _, Window, WindowOptions,
        div, px,
    };

    #[repr(C)]
    struct Msg {
        hwnd: *mut c_void,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: [i32; 2],
        lprivate: isize,
    }

    unsafe extern "system" {
        fn PeekMessageW(msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32, flags: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }

    const PM_REMOVE: u32 = 0x0001;

    /// Pumps this thread's message queue for `dur` — the same thing
    /// `webview2_com::wait_with_pump` does while WebView2 creates its
    /// environment and controller.
    fn pump_messages(dur: Duration) {
        let end = Instant::now() + dur;
        let mut msg: Msg = unsafe { std::mem::zeroed() };
        while Instant::now() < end {
            unsafe {
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    struct Empty;

    impl Render for Empty {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            div().size_full()
        }
    }

    pub(super) fn run() {
        gpui_platform::application().run(|cx| {
            let size = gpui::size(px(640.0), px(400.0));
            let bounds = gpui::Bounds::centered(None, size, cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                |_window, cx| cx.new(|_cx| Empty),
            )
            .expect("open_window");

            let app = cx.to_async();

            // Queue a foreground task that calls `AsyncApp::update`, like
            // nsh-platform-gpui's text-input blink (`rt::after_ms`). Its
            // wake message is posted to the thread queue but not yet
            // dispatched.
            app.spawn(async move |cx| {
                cx.update(|_app| {});
            })
            .detach();

            eprintln!("repro: borrowing AppCell and pumping messages for 1.5s");
            // Borrow the AppCell (as `AnyWindowHandle::update` does around
            // `Window::draw`) and pump the queue. The nested dispatch runs
            // the queued task, whose `cx.update` re-borrows -> panic.
            app.update(|_app| pump_messages(Duration::from_millis(1500)));

            eprintln!("repro: survived (no panic)");
            std::process::exit(0);
        });
    }
}

#[cfg(target_os = "windows")]
fn main() {
    imp::run();
}

#[cfg(not(target_os = "windows"))]
fn main() {}
