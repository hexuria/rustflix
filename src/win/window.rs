//! The app window's caption on Windows.
//!
//! NSH marks its `windowDrag` views (the app's own title bar) as caption
//! (`HTCAPTION`, GPUI's `WindowControlArea::Drag`), so that Windows moves the
//! window — with Snap — and maximizes/restores it on a double click. But
//! gpui-fast first hands the press to GPUI as a mouse-down, and NSH's drag
//! area handles it (`cx.stop_propagation`, nsh-platform-gpui `chrome.rs`
//! `drag_area`), so gpui-fast reports the press handled and `DefWindowProc`
//! never sees it: no move loop, no Snap, no double-click. NSH's fallback,
//! `Window::start_window_move`, does nothing on Windows, and its double
//! click calls `zoom_window`, which only maximizes.
//!
//! Each of GPUI's windows is subclassed (`SetWindowSubclass`) so that a left
//! press or double click on the caption goes to `DefWindowProc` directly,
//! as for any captioned window. Everything else reaches GPUI unchanged. A
//! thread timer (main thread) finds GPUI's windows as they appear.

use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            DefWindowProcW, EnumThreadWindows, GetClassNameW, HTCAPTION, SetTimer, WM_NCDESTROY,
            WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN,
        },
    },
};

/// The subclass's id.
const SUBCLASS: usize = 0x5246_4350; // "RFCP"

unsafe extern "system" fn caption_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    // SAFETY: the window's own messages, on its thread.
    unsafe {
        if msg == WM_NCLBUTTONDOWN || msg == WM_NCLBUTTONDBLCLK {
            log::debug!("window: non-client press {msg:#x} on hit-test {}", wparam.0);
        }
        match msg {
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK if wparam.0 as u32 == HTCAPTION => {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(caption_proc), SUBCLASS);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

unsafe extern "system" fn each(hwnd: HWND, _: LPARAM) -> windows_core::BOOL {
    let mut name = [0u16; 64];
    // SAFETY: a window of this thread; a buffer of ours.
    let n = unsafe { GetClassNameW(hwnd, &mut name) } as usize;
    if String::from_utf16_lossy(&name[..n]) == "GpuiFast::Window" {
        // Setting it again only updates it: no need to track which windows
        // have it.
        // SAFETY: a window of this thread and a procedure that lives as long
        // as the process.
        let _ = unsafe { SetWindowSubclass(hwnd, Some(caption_proc), SUBCLASS, 0) };
    }
    true.into()
}

unsafe extern "system" fn tick(_: HWND, _: u32, _: usize, _: u32) {
    // SAFETY: enumerates this (the main) thread's windows.
    let _ = unsafe { EnumThreadWindows(GetCurrentThreadId(), Some(each), LPARAM(0)) };
}

/// Starts watching for GPUI's windows (main thread, before GPUI makes any).
pub(crate) fn install() {
    // SAFETY: a thread timer with a static procedure; the main thread's
    // message loop (GPUI's) dispatches it.
    if unsafe { SetTimer(None, 0, 250, Some(tick)) } == 0 {
        log::warn!("window: no timer; the title bar will not move the window");
    }
}
