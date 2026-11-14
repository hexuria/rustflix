//! Embedded subtitles as text: an `AVPlayerItemLegibleOutput` on the item
//! hands the selected legible track's cues (attributed strings) to a
//! delegate on the main queue; they go to the app as `cues {time, lines}`
//! — plain text, line breaks kept, styling dropped — so the TS captions
//! overlay draws them with the app's own style, size and offset. A video
//! output carries no captions, and AVFoundation's own caption rendering
//! needs an `AVPlayerLayer`, so this is how the GPUI-painted player shows
//! them.

use objc2::{AnyThread, DefinedClass, define_class, msg_send, rc::Retained, runtime::AnyObject, runtime::NSObject};
use serde_json::json;

use super::{CMTime, Inner, Obj, class, guarded, ns_string, with_player};

pub(super) struct Ivars {
    id: u64,
    gen_: u64,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; no Drop.
    #[unsafe(super(NSObject))]
    #[name = "RustflixLegibleDelegate"]
    #[ivars = Ivars]
    pub(super) struct Delegate;

    impl Delegate {
        /// AVPlayerItemLegibleOutputPushDelegate: the cues to show from
        /// `time` on (an empty list clears them).
        #[unsafe(method(legibleOutput:didOutputAttributedStrings:nativeSampleBuffers:forItemTime:))]
        fn did_output(&self, _output: *mut AnyObject, strings: *mut AnyObject, _native: *mut AnyObject, time: CMTime) {
            // SAFETY: the NSArray AVFoundation passes, alive for the call.
            let lines = unsafe { strings.as_ref() }.map(texts).unwrap_or_default();
            let (id, gen_) = (self.ivars().id, self.ivars().gen_);
            let at = time.seconds();
            with_player(id, gen_, move |i| i.on_cues(at, lines));
        }
    }
);

/// The plain text of each attributed string of `list`.
fn texts(list: &AnyObject) -> Vec<String> {
    // SAFETY: NSArray of NSAttributedString; `string` is their plain text.
    unsafe {
        let n: usize = msg_send![list, count];
        (0..n)
            .filter_map(|k| {
                let s: Option<Obj> = msg_send![list, objectAtIndex: k];
                let s = s?;
                let plain: Option<Obj> = msg_send![&*s, string];
                ns_string(plain.as_deref())
            })
            .map(|t| t.replace("\r\n", "\n").replace('\r', "\n").trim().to_owned())
            .filter(|t| !t.is_empty())
            .collect()
    }
}

/// The legible output and its delegate, added to `item`.
pub(super) fn attach(item: &AnyObject, id: u64, gen_: u64) -> Option<(Obj, Retained<Delegate>)> {
    let cls = class(c"AVPlayerItemLegibleOutput").ok()?;
    let delegate: Retained<Delegate> = {
        let this = Delegate::alloc().set_ivars(Ivars { id, gen_ });
        // SAFETY: NSObject's init.
        unsafe { msg_send![super(this), init] }
    };
    let queue = dispatch2::DispatchQueue::main();
    let queue: *const AnyObject = (&*queue as *const dispatch2::DispatchQueue).cast();
    // SAFETY: AVPlayerItemLegibleOutput's init / delegate (a dispatch queue
    // is an Objective-C object on Apple platforms) and AVPlayerItem's
    // addOutput:, on the main thread.
    let output = guarded("legible output", || unsafe {
        let o: Option<Obj> = msg_send![cls, new];
        let o = o?;
        let _: () = msg_send![&*o, setDelegate: &*delegate, queue: queue];
        let _: () = msg_send![&*o, setSuppressesPlayerRendering: objc2::runtime::Bool::YES];
        let _: () = msg_send![item, addOutput: &*o];
        Some(o)
    })
    .ok()
    .flatten()?;
    Some((output, delegate))
}

impl Inner {
    pub(super) fn on_cues(&mut self, time: Option<f64>, lines: Vec<String>) {
        if lines == self.cue_lines {
            return;
        }
        self.cue_lines = lines.clone();
        (self.emit)("cues", json!({ "time": time, "lines": lines }));
    }

    /// Subtitles changed: whatever was shown goes.
    pub(super) fn clear_cues(&mut self) {
        if !self.cue_lines.is_empty() {
            self.cue_lines.clear();
            (self.emit)("cues", json!({ "time": self.output_time(), "lines": [] }));
        }
    }
}
