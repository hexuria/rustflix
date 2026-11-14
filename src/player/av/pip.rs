//! Picture in picture on macOS: an `AVPlayerLayer` on the same `AVPlayer`
//! (decoding is shared) in a layer-backed host view that sits BEHIND the
//! window's content view (GPUI's opaque view covers it, so it is never
//! seen and takes no clicks), driven by an `AVPictureInPictureController`.
//!
//! Made on the first `enterPip` and dropped when PiP ends, so the second
//! rendering only exists while it is needed. While PiP is active the
//! component paints a placeholder instead of the picture; the PiP window's
//! own controls (play / pause / skip) act on the AVPlayer, and the app
//! follows through the `rate` events; "restore" hands back to the window.
//!
//! `pip {possible}` is true when the system supports PiP and the player has
//! a window to host the layer in; the controller's own
//! `isPictureInPicturePossible` is waited for (≤ 3 s) after `enterPip`.

use std::time::{Duration, Instant};

use block2::Block;
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool, NSObject},
};
use serde_json::json;

use super::{Inner, Obj, class, guarded, with_player};

#[link(name = "AVKit", kind = "framework")]
unsafe extern "C" {}

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVLayerVideoGravityResizeAspect: *const AnyObject;
}

pub(super) struct Ivars {
    id: u64,
    gen_: u64,
}

#[derive(Clone, Copy)]
enum Change {
    Started,
    Stopped,
    Failed,
}

fn tell(this: &Delegate, change: Change, message: Option<String>) {
    let (id, gen_) = (this.ivars().id, this.ivars().gen_);
    // The next turn: never tear the controller down inside its own callback.
    dispatch2::DispatchQueue::main().exec_async(move || with_player(id, gen_, move |i| i.pip_changed(change, message)));
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; no Drop.
    #[unsafe(super(NSObject))]
    #[name = "RustflixPipDelegate"]
    #[ivars = Ivars]
    pub(super) struct Delegate;

    impl Delegate {
        #[unsafe(method(pictureInPictureControllerDidStartPictureInPicture:))]
        fn did_start(&self, _c: *mut AnyObject) {
            tell(self, Change::Started, None);
        }

        #[unsafe(method(pictureInPictureControllerDidStopPictureInPicture:))]
        fn did_stop(&self, _c: *mut AnyObject) {
            tell(self, Change::Stopped, None);
        }

        #[unsafe(method(pictureInPictureController:failedToStartPictureInPictureWithError:))]
        fn failed(&self, _c: *mut AnyObject, error: *mut AnyObject) {
            // SAFETY: the NSError AVKit passes, alive for the call.
            let (m, _) = super::error_info(unsafe { error.as_ref() });
            tell(self, Change::Failed, Some(m));
        }

        /// "Back to the app": the window shows the picture again.
        #[unsafe(method(pictureInPictureController:restoreUserInterfaceForPictureInPictureStopWithCompletionHandler:))]
        fn restore(&self, _c: *mut AnyObject, done: *mut Block<dyn Fn(Bool)>) {
            // SAFETY: AVKit's completion block, called once.
            if let Some(done) = unsafe { done.as_ref() } {
                done.call((Bool::YES,));
            }
        }
    }
);

/// Whether this Mac does PiP at all.
pub(super) fn supported() -> bool {
    let Ok(cls) = class(c"AVPictureInPictureController") else { return false };
    // SAFETY: the class method.
    let r: Bool = unsafe { msg_send![cls, isPictureInPictureSupported] };
    r.as_bool()
}

/// The app's window: key, else main, else the first one.
fn app_window() -> Option<Obj> {
    let app_cls = AnyClass::get(c"NSApplication")?;
    // SAFETY: NSApplication's own messages, on the main thread.
    unsafe {
        let app: Option<Obj> = msg_send![app_cls, sharedApplication];
        let app = app?;
        let w: Option<Obj> = msg_send![&*app, keyWindow];
        if w.is_some() {
            return w;
        }
        let w: Option<Obj> = msg_send![&*app, mainWindow];
        if w.is_some() {
            return w;
        }
        let all: Option<Obj> = msg_send![&*app, windows];
        let all = all?;
        let n: usize = msg_send![&*all, count];
        if n == 0 {
            return None;
        }
        msg_send![&*all, objectAtIndex: 0usize]
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

// SAFETY: `{CGRect={CGPoint=dd}{CGSize=dd}}` on 64-bit platforms.
unsafe impl objc2::encode::Encode for Rect {
    const ENCODING: objc2::encode::Encoding = objc2::encode::Encoding::Struct(
        "CGRect",
        &[
            objc2::encode::Encoding::Struct("CGPoint", &[objc2::encode::Encoding::Double, objc2::encode::Encoding::Double]),
            objc2::encode::Encoding::Struct("CGSize", &[objc2::encode::Encoding::Double, objc2::encode::Encoding::Double]),
        ],
    );
}

/// The PiP machinery of one player.
pub(super) struct Pip {
    host: Obj,
    layer: Obj,
    controller: Obj,
    _delegate: Retained<Delegate>,
    /// `enterPip` came; start once the controller says it is possible.
    wanted_since: Option<Instant>,
}

impl Pip {
    fn make(player: &AnyObject, id: u64, gen_: u64) -> Result<Pip, String> {
        let window = app_window().ok_or("no window to host picture in picture")?;
        let (view_cls, layer_cls, ctrl_cls) = (class(c"NSView")?, class(c"AVPlayerLayer")?, class(c"AVPictureInPictureController")?);
        let delegate: Retained<Delegate> = {
            let this = Delegate::alloc().set_ivars(Ivars { id, gen_ });
            // SAFETY: NSObject's init.
            unsafe { msg_send![super(this), init] }
        };
        // SAFETY: AppKit / AVFoundation / AVKit on the main thread; nil
        // results checked; the host view goes behind the content view.
        guarded("picture in picture", || unsafe {
            let content: Option<Obj> = msg_send![&*window, contentView];
            let content = content.ok_or("no content view")?;
            let parent: Option<Obj> = msg_send![&*content, superview];
            let frame: Rect = msg_send![&*content, frame];
            let a: Allocated<AnyObject> = msg_send![view_cls, alloc];
            let host: Option<Obj> = msg_send![a, initWithFrame: frame];
            let host = host.ok_or("no host view")?;
            let _: () = msg_send![&*host, setWantsLayer: Bool::YES];
            // Width + height sizable.
            let _: () = msg_send![&*host, setAutoresizingMask: 18usize];
            let layer: Option<Obj> = msg_send![layer_cls, playerLayerWithPlayer: player];
            let layer = layer.ok_or("no player layer")?;
            let bounds: Rect = msg_send![&*host, bounds];
            let _: () = msg_send![&*layer, setFrame: bounds];
            let _: () = msg_send![&*layer, setAutoresizingMask: 18u32];
            if let Some(g) = super::constant(AVLayerVideoGravityResizeAspect) {
                let _: () = msg_send![&*layer, setVideoGravity: g];
            }
            let host_layer: Option<Obj> = msg_send![&*host, layer];
            let host_layer = host_layer.ok_or("no host layer")?;
            let _: () = msg_send![&*host_layer, addSublayer: &*layer];
            // NSWindowBelow = -1.
            match parent {
                Some(p) => {
                    let _: () = msg_send![&*p, addSubview: &*host, positioned: -1isize, relativeTo: &*content];
                }
                None => {
                    let _: () = msg_send![&*content, addSubview: &*host, positioned: -1isize, relativeTo: std::ptr::null::<AnyObject>()];
                }
            }
            let a: Allocated<AnyObject> = msg_send![ctrl_cls, alloc];
            let controller: Option<Obj> = msg_send![a, initWithPlayerLayer: &*layer];
            let controller = controller.ok_or("no picture-in-picture controller")?;
            let _: () = msg_send![&*controller, setDelegate: &*delegate];
            Ok::<_, String>(Pip { host, layer, controller, _delegate: delegate, wanted_since: None })
        })?
    }

    fn possible(&self) -> bool {
        // SAFETY: AVPictureInPictureController's isPictureInPicturePossible.
        let r: Bool = unsafe { msg_send![&*self.controller, isPictureInPicturePossible] };
        r.as_bool()
    }

    fn drop_now(self) {
        // SAFETY: AppKit / CoreAnimation removal on the main thread.
        let _ = guarded("pip teardown", || unsafe {
            let _: () = msg_send![&*self.controller, setDelegate: std::ptr::null::<AnyObject>()];
            let _: () = msg_send![&*self.layer, setPlayer: std::ptr::null::<AnyObject>()];
            let _: () = msg_send![&*self.layer, removeFromSuperlayer];
            let _: () = msg_send![&*self.host, removeFromSuperview];
        });
    }
}

impl Inner {
    /// `pip.possible` as the app should see it.
    pub(super) fn pip_possible(&self) -> bool {
        self.pip_supported && self.player.is_some() && app_window().is_some()
    }

    pub(super) fn emit_pip(&mut self) {
        let (active, possible) = (self.pip_active, self.pip_possible());
        if self.pip_reported != Some((active, possible)) {
            self.pip_reported = Some((active, possible));
            (self.emit)("pip", json!({ "active": active, "possible": possible }));
        }
    }

    pub(super) fn pip(&mut self, on: bool) {
        if !on {
            if let Some(p) = &self.pip {
                // SAFETY: AVPictureInPictureController's stop.
                let _ = guarded("stop pip", || unsafe {
                    let _: () = msg_send![&*p.controller, stopPictureInPicture];
                });
            }
            self.pip_reported = None;
            self.emit_pip();
            return;
        }
        if self.pip_active {
            return;
        }
        if !self.pip_possible() {
            self.pip_reported = None;
            self.emit_pip();
            (self.emit)("error", json!({ "message": "picture in picture is not possible here", "code": "pip", "fatal": false }));
            return;
        }
        if self.pip.is_none() {
            let Some(player) = self.player.clone() else { return };
            match Pip::make(&player, self.id, self.gen_) {
                Ok(p) => self.pip = Some(p),
                Err(e) => {
                    (self.emit)("error", json!({ "message": e, "code": "pip", "fatal": false }));
                    return;
                }
            }
        }
        if let Some(p) = self.pip.as_mut() {
            p.wanted_since = Some(Instant::now());
        }
        self.pip_tick();
    }

    /// Starts a wanted PiP once the controller can (from the tick).
    pub(super) fn pip_tick(&mut self) {
        let Some(p) = self.pip.as_mut() else { return };
        let Some(since) = p.wanted_since else { return };
        if p.possible() {
            p.wanted_since = None;
            // SAFETY: AVPictureInPictureController's start, when possible.
            let r = guarded("start pip", || unsafe {
                let _: () = msg_send![&*p.controller, startPictureInPicture];
            });
            if let Err(e) = r {
                (self.emit)("error", json!({ "message": e, "code": "pip", "fatal": false }));
            }
        } else if since.elapsed() >= Duration::from_secs(3) {
            p.wanted_since = None;
            (self.emit)("error", json!({ "message": "picture in picture did not become possible", "code": "pip", "fatal": false }));
            self.drop_pip();
        }
    }

    fn pip_changed(&mut self, change: Change, message: Option<String>) {
        match change {
            Change::Started => {
                self.pip_active = true;
                (self.redraw)();
            }
            Change::Stopped => {
                self.pip_active = false;
                self.drop_pip();
                (self.redraw)();
            }
            Change::Failed => {
                self.pip_active = false;
                self.drop_pip();
                (self.emit)("error", json!({ "message": message.unwrap_or_default(), "code": "pip", "fatal": false }));
            }
        }
        self.emit_pip();
    }

    pub(super) fn pip_probe(&mut self) -> serde_json::Value {
        let supported = supported();
        let Some(player) = self.player.clone() else { return json!({ "supported": supported, "made": false, "error": "no player" }) };
        match Pip::make(&player, self.id, self.gen_) {
            Ok(p) => {
                let possible = p.possible();
                p.drop_now();
                json!({ "supported": supported, "made": true, "possible": possible, "reported": self.pip_possible() })
            }
            Err(e) => json!({ "supported": supported, "made": false, "error": e }),
        }
    }

    pub(super) fn drop_pip(&mut self) {
        if let Some(p) = self.pip.take() {
            p.drop_now();
        }
    }
}
