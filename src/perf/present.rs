//! Every frame GPUI encodes, from the Metal layer itself (macOS).
//!
//! GPUI's Metal renderer takes one drawable per frame it encodes — every
//! window draw and every present-only re-encode — with
//! `-[CAMetalLayer nextDrawable]` (gpui-fast-apple metal_renderer.rs), on
//! the main thread, whichever view was dirty. While the monitor measures,
//! that method is swapped for [`hooked`]: it calls the original, times it
//! (the time it blocked is the drawable wait), hands the frame to the
//! main-thread accounting ([`super::on_drawable`]) and asks the drawable
//! for its on-glass time (`addPresentedHandler:`, `presentedTime`), which
//! Metal reports on a thread of its own ([`take_presented`]). When the
//! monitor stops, the original implementation is put back: nothing of this
//! runs while it is off.

use std::{
    ffi::c_void,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering},
    },
    time::Instant,
};

use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{msg_send, sel};

#[link(name = "objc")]
unsafe extern "C" {
    fn class_getInstanceMethod(cls: *const AnyClass, name: Sel) -> *mut c_void;
    fn method_setImplementation(m: *mut c_void, imp: *const c_void) -> *const c_void;
}

type NextDrawable = unsafe extern "C" fn(*mut AnyObject, Sel) -> *mut AnyObject;

static ORIGINAL: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static INSTALLED: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU64 = AtomicU64::new(0);
/// (seq, on-glass time in seconds — `CACurrentMediaTime`'s base — or 0
/// when the drawable was never shown).
static PRESENTED: Mutex<Vec<(u64, f64)>> = Mutex::new(Vec::new());

/// Whether drawables can report their on-glass time (macOS 10.15.4+).
static PRESENT_TIMES: AtomicBool = AtomicBool::new(true);

unsafe extern "C" fn hooked(this: *mut AnyObject, cmd: Sel) -> *mut AnyObject {
    let original = ORIGINAL.load(Ordering::Acquire);
    if original.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the method's own implementation, as the runtime had it.
    let original: NextDrawable = unsafe { std::mem::transmute(original) };
    let call = Instant::now();
    // SAFETY: the original `nextDrawable` with its own receiver and selector.
    let drawable = unsafe { original(this, cmd) };
    let ret = Instant::now();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    super::on_drawable(seq, call, ret);
    if !drawable.is_null() && PRESENT_TIMES.load(Ordering::Relaxed) {
        // SAFETY: a live drawable (autoreleased, returned to GPUI as is);
        // the block is copied by Metal and called once, on its thread.
        unsafe {
            let d = &*drawable;
            let ok: Bool = msg_send![d, respondsToSelector: sel!(addPresentedHandler:)];
            if ok.as_bool() {
                let block = block2::RcBlock::new(move |shown: *mut AnyObject| {
                    let at: f64 = if shown.is_null() { 0.0 } else { msg_send![&*shown, presentedTime] };
                    let mut p = PRESENTED.lock().unwrap_or_else(|e| e.into_inner());
                    if p.len() < 4096 {
                        p.push((seq, at));
                    }
                });
                let _: () = msg_send![d, addPresentedHandler: &*block];
            } else {
                PRESENT_TIMES.store(false, Ordering::Relaxed);
            }
        }
    }
    drawable
}

fn method() -> Option<*mut c_void> {
    let cls = AnyClass::get(c"CAMetalLayer")?;
    // SAFETY: a runtime lookup of a class's instance method.
    let m = unsafe { class_getInstanceMethod(cls, sel!(nextDrawable)) };
    (!m.is_null()).then_some(m)
}

/// Swaps the hook in (main thread; once per measuring session).
pub(crate) fn install() {
    if INSTALLED.load(Ordering::Acquire) {
        return;
    }
    let Some(m) = method() else {
        log::warn!("perf: no -[CAMetalLayer nextDrawable] to time frames with");
        return;
    };
    // SAFETY: swaps the implementation of a method whose signature `hooked`
    // matches (`id (id, SEL)`); the original is kept to call and restore.
    let original = unsafe { method_setImplementation(m, hooked as *const c_void) };
    ORIGINAL.store(original as *mut c_void, Ordering::Release);
    INSTALLED.store(true, Ordering::Release);
}

/// Puts the original back.
pub(crate) fn uninstall() {
    if !INSTALLED.swap(false, Ordering::AcqRel) {
        return;
    }
    let original = ORIGINAL.load(Ordering::Acquire);
    if let (Some(m), false) = (method(), original.is_null()) {
        // SAFETY: restores the implementation `install` replaced.
        unsafe { method_setImplementation(m, original) };
    }
    PRESENTED.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// The on-glass times reported since the last call, in frame order.
pub(crate) fn take_presented() -> Vec<(u64, f64)> {
    let mut v = std::mem::take(&mut *PRESENTED.lock().unwrap_or_else(|e| e.into_inner()));
    v.sort_by_key(|p| p.0);
    v
}

/// Whether frames get on-glass times (else lateness falls back to the
/// gaps between frames' ends).
pub(crate) fn has_present_times() -> bool {
    PRESENT_TIMES.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::encode::{Encode, Encoding};
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::class;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        w: f64,
        h: f64,
    }
    // SAFETY: CGSize's layout and encoding.
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    #[link(name = "Metal", kind = "framework")]
    unsafe extern "C" {
        fn MTLCreateSystemDefaultDevice() -> *mut AnyObject;
    }

    /// The hook sees every `nextDrawable` called through the Objective-C
    /// runtime (as GPUI calls it), times its wait, and the original is put
    /// back afterwards.
    #[test]
    fn every_drawable_is_a_frame_of_the_monitor() {
        // SAFETY: Metal's documented constructor.
        let device = unsafe { MTLCreateSystemDefaultDevice() };
        if device.is_null() {
            eprintln!("no Metal device: skipped");
            return;
        }
        super::super::MON.with(|m| *m.borrow_mut() = Some(super::super::Monitor::new()));
        install();
        let mut frames = 0;
        // SAFETY: CAMetalLayer's documented messages, on this thread.
        unsafe {
            let layer: Retained<AnyObject> = msg_send![class!(CAMetalLayer), layer];
            let _: () = msg_send![&*layer, setDevice: device];
            let _: () = msg_send![&*layer, setPixelFormat: 80usize];
            let _: () = msg_send![&*layer, setDrawableSize: Size { w: 64.0, h: 64.0 }];
            for _ in 0..5 {
                let t = Instant::now();
                super::super::with_mon(|m| m.work.woke(t));
                autoreleasepool(|_| {
                    let d: *mut AnyObject = msg_send![&*layer, nextDrawable];
                    assert!(!d.is_null());
                });
                super::super::with_mon(|m| {
                    let (f, s) = m.work.slept(Instant::now());
                    assert!(s.is_none(), "a wake-up with a drawable is a frame");
                    m.take(f, s);
                });
                frames += 1;
            }
        }
        uninstall();
        let seen = super::super::with_mon(|m| m.recent.iter().count()).unwrap_or(0);
        assert_eq!(seen, frames);
        // Restored: no frame recorded any more.
        unsafe {
            let layer: Retained<AnyObject> = msg_send![class!(CAMetalLayer), layer];
            let _: () = msg_send![&*layer, setDevice: device];
            let _: () = msg_send![&*layer, setDrawableSize: Size { w: 64.0, h: 64.0 }];
            autoreleasepool(|_| {
                let _d: *mut AnyObject = msg_send![&*layer, nextDrawable];
            });
        }
        assert_eq!(super::super::with_mon(|m| m.recent.iter().count()).unwrap_or(0), frames);
        super::super::MON.with(|m| *m.borrow_mut() = None);
    }
}
