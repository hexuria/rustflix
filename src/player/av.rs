//! An `AVPlayer` with an `AVPlayerItemVideoOutput` that hands out pixel
//! buffers in the one format GPUI's Metal renderer draws
//! (`kCVPixelFormatType_420YpCbCr8BiPlanarFullRange`: gpui-fast-apple
//! metal_renderer.rs asserts it, so any other buffer is dropped here).
//! No NSH types: the component (`super::component`), `sys.nativeVideo`
//! ([`control`]) and the scratch harness all drive it.
//!
//! The main thread never waits on AVFoundation:
//! - frames: a CVDisplayLink callback (its own thread) asks the video output
//!   for a new buffer at the display's next refresh
//!   (`itemTimeForMachAbsoluteTime:` — the output's own timebase, never the
//!   player's lock; stage 0's `-[AVPlayerItem currentTime]` on the main
//!   thread blocked up to 173 ms on MediaToolbox's player queue) and hops
//!   to the main thread only when there is one: one wake-up and one redraw
//!   per video frame, none while paused;
//! - time: a periodic time observer (4 Hz) hands the current time over;
//! - the asset, item, output and player are made on a background queue
//!   (`playerItemWithURL:` cost 21 ms of main thread), and released on one;
//! - a 100 ms tick reads only cached state (status, time control status,
//!   rate) for `load`, stalls, `rate` and failures.
//! Notifications: played to end, failed to play to end, playback stalled.
//! Blocks and callbacks find their player through a thread-local registry
//! by id and a generation, so a player that is gone or has a new source is
//! never touched by stale callbacks, and none borrows it re-entrantly.
//!
//! Tracks: the asset's audible / legible media selection groups (loaded
//! asynchronously), selectable by id; the selected subtitle track's text
//! comes out as `cues` events ([`legible`]) for the app to draw. Picture in
//! picture: [`pip`]. Now Playing and the media keys: [`nowplaying`].
//! Resolution: the variant is capped at the picture's size on screen (the
//! screen's size before that is known), and a stream that is bigger anyway
//! (one 4K variant) gets a video output scaled to that size, so GPUI never
//! paints 8-megapixel surfaces into a 3-megapixel rect.
//!
//! Raw `msg_send!` through `objc2` (no objc2-av-foundation), every class
//! looked up (never `class!`, which panics when missing), the calls that can
//! raise wrapped in `objc2::exception::catch`: a failure is an `error`
//! event, never a panic.

use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{CStr, c_void},
    panic::AssertUnwindSafe,
    ptr::NonNull,
    rc::Rc,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use block2::RcBlock;
use dispatch2::{DispatchQoS, DispatchQueue, DispatchTime, GlobalQueueIdentifier};
use objc2::{
    encode::{Encode, Encoding, RefEncode},
    msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool, Sel},
    sel,
};
use objc2_core_foundation::CFRetained;
use objc2_core_video::{CVPixelBuffer, CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth};
use objc2_foundation::NSString;
use serde_json::{Value, json};

mod legible;
mod nowplaying;
mod pip;

pub(crate) use nowplaying::Info as NowPlaying;

/// Whether this Mac does picture in picture (`sys.nativeVideoInfo`).
pub(crate) fn pip_supported() -> bool {
    pip::supported()
}

/// `kCVPixelFormatType_420YpCbCr8BiPlanarFullRange` ('420f').
pub(crate) const FORMAT_420F: u32 = 0x3432_3066;

type Obj = Retained<AnyObject>;

/// Moves main-thread objects across a queue hop. Objective-C objects are
/// reference counted atomically; the code on the other side only sends
/// them messages AVFoundation allows off the main thread (creation,
/// release, the video output's buffer calls).
struct SendBox<T>(T);
// SAFETY: see above.
unsafe impl<T> Send for SendBox<T> {}

/// CoreMedia's `CMTime` (`{?=qiIq}`).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub(crate) struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

// SAFETY: the field types and order of CoreMedia's CMTime.
unsafe impl Encode for CMTime {
    const ENCODING: Encoding = Encoding::Struct("?", &[Encoding::LongLong, Encoding::Int, Encoding::UInt, Encoding::LongLong]);
}
// SAFETY: a pointer to the above.
unsafe impl RefEncode for CMTime {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

impl CMTime {
    const VALID: u32 = 1;
    /// Positive / negative infinity, indefinite.
    const NOT_NUMERIC: u32 = 4 | 8 | 16;

    pub(crate) fn seconds(self) -> Option<f64> {
        let ok = self.flags & Self::VALID != 0 && self.flags & Self::NOT_NUMERIC == 0 && self.timescale > 0;
        ok.then(|| self.value as f64 / self.timescale as f64)
    }

    pub(crate) fn from_seconds(s: f64) -> CMTime {
        let s = if s.is_finite() { s.max(0.0) } else { 0.0 };
        CMTime { value: (s * 600.0).round() as i64, timescale: 600, flags: Self::VALID, epoch: 0 }
    }
}

/// CoreMedia's `CMTimeRange`.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CMTimeRange {
    start: CMTime,
    duration: CMTime,
}

// SAFETY: two CMTimes, as CoreMedia declares it.
unsafe impl Encode for CMTimeRange {
    const ENCODING: Encoding = Encoding::Struct("?", &[CMTime::ENCODING, CMTime::ENCODING]);
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

// SAFETY: CoreGraphics' CGSize on 64-bit platforms.
unsafe impl Encode for CGSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[Encoding::Double, Encoding::Double]);
}

/// CoreVideo's `CVSMPTETime`.
#[repr(C)]
#[derive(Clone, Copy)]
struct SmpteTime {
    subframes: i16,
    subframe_divisor: i16,
    counter: u32,
    kind: u32,
    flags: u32,
    hours: i16,
    minutes: i16,
    seconds: i16,
    frames: i16,
}

/// CoreVideo's `CVTimeStamp`.
#[repr(C)]
#[derive(Clone, Copy)]
struct CvTimeStamp {
    version: u32,
    video_time_scale: i32,
    video_time: i64,
    host_time: u64,
    rate_scalar: f64,
    video_refresh_period: i64,
    smpte: SmpteTime,
    flags: u64,
    reserved: u64,
}

type LinkCallback = extern "C" fn(*mut c_void, *const CvTimeStamp, *const CvTimeStamp, u64, *mut u64, *mut c_void) -> i32;

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVPlayerItemDidPlayToEndTimeNotification: *const AnyObject;
    static AVPlayerItemFailedToPlayToEndTimeNotification: *const AnyObject;
    static AVPlayerItemPlaybackStalledNotification: *const AnyObject;
    static AVPlayerItemFailedToPlayToEndTimeErrorKey: *const AnyObject;
    static AVMediaCharacteristicAudible: *const AnyObject;
    static AVMediaCharacteristicLegible: *const AnyObject;
    static AVAudioTimePitchAlgorithmSpectral: *const AnyObject;
}

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    static kCVPixelBufferPixelFormatTypeKey: *const AnyObject;
    static kCVPixelBufferMetalCompatibilityKey: *const AnyObject;
    static kCVPixelBufferIOSurfacePropertiesKey: *const AnyObject;
    static kCVPixelBufferWidthKey: *const AnyObject;
    static kCVPixelBufferHeightKey: *const AnyObject;
    fn CVDisplayLinkCreateWithActiveCGDisplays(out: *mut *mut c_void) -> i32;
    // src/perf declares it with its own timestamp type (ABI-identical).
    #[allow(clashing_extern_declarations)]
    fn CVDisplayLinkSetOutputCallback(link: *mut c_void, callback: Option<LinkCallback>, ctx: *mut c_void) -> i32;
    fn CVDisplayLinkStart(link: *mut c_void) -> i32;
    fn CVDisplayLinkStop(link: *mut c_void) -> i32;
    fn CVDisplayLinkRelease(link: *mut c_void);
}

unsafe extern "C" {
    fn mach_absolute_time() -> u64;
}

/// A framework's constant object (NSString / CFString), if linked.
fn constant(p: *const AnyObject) -> Option<&'static AnyObject> {
    // SAFETY: framework constants live for the process.
    unsafe { p.as_ref() }
}

fn class(name: &CStr) -> Result<&'static AnyClass, String> {
    AnyClass::get(name).ok_or_else(|| format!("{} is not available", name.to_string_lossy()))
}

/// Runs `f`, turning an Objective-C exception into an error message.
fn guarded<R>(what: &str, f: impl FnOnce() -> R) -> Result<R, String> {
    // An exception unwinds out of `f` into `catch`, which is what it is for.
    match objc2::exception::catch(AssertUnwindSafe(f)) {
        Ok(r) => Ok(r),
        Err(e) => Err(format!("{what}: {}", e.map(|e| format!("{e:?}")).unwrap_or_else(|| "exception".into()))),
    }
}

fn responds(obj: &AnyObject, sel: Sel) -> bool {
    // SAFETY: NSObject's respondsToSelector:.
    let r: Bool = unsafe { msg_send![obj, respondsToSelector: sel] };
    r.as_bool()
}

fn ns_string(obj: Option<&AnyObject>) -> Option<String> {
    let obj = obj?;
    // SAFETY: NSObject's description works for any object (NSString's is itself).
    let s: Option<Retained<NSString>> = unsafe { msg_send![obj, description] };
    s.map(|s| s.to_string())
}

/// An NSError as (message "description (domain code); underlying: …", code).
fn error_info(err: Option<&AnyObject>) -> (String, String) {
    let Some(err) = err else { return ("unknown error".into(), "internal".into()) };
    // SAFETY: NSError's own messages.
    unsafe {
        let desc: Option<Obj> = msg_send![err, localizedDescription];
        let domain: Option<Obj> = msg_send![err, domain];
        let code: isize = msg_send![err, code];
        let domain = ns_string(domain.as_deref()).unwrap_or_default();
        let mut s = format!("{} ({domain} {code})", ns_string(desc.as_deref()).unwrap_or_default());
        let info: Option<Obj> = msg_send![err, userInfo];
        if let Some(info) = info {
            let key = NSString::from_str("NSUnderlyingError");
            let under: Option<Obj> = msg_send![&*info, objectForKey: &*key];
            if let Some(under) = under {
                let d: Option<Obj> = msg_send![&*under, localizedDescription];
                let c: isize = msg_send![&*under, code];
                s.push_str(&format!("; underlying: {} ({c})", ns_string(d.as_deref()).unwrap_or_default()));
            }
        }
        let kind = match domain.as_str() {
            "NSURLErrorDomain" => "network",
            "CoreMediaErrorDomain" => "media",
            "AVFoundationErrorDomain" => "av",
            _ => "platform",
        };
        (s, kind.to_owned())
    }
}

// --- Registry ---------------------------------------------------------------------

/// Players alive / playing now (`sys.nativePlayers`).
pub(crate) static LIVE: AtomicUsize = AtomicUsize::new(0);
pub(crate) static PLAYING: AtomicUsize = AtomicUsize::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static PLAYERS: RefCell<HashMap<u64, Rc<RefCell<Inner>>>> = RefCell::new(HashMap::new());
}

fn lookup(id: u64) -> Option<Rc<RefCell<Inner>>> {
    PLAYERS.with(|p| p.borrow().get(&id).cloned())
}

/// Runs `f` with player `id` when it still plays generation `gen_` and is
/// not borrowed (a callback that comes while it is busy tries again).
fn with_player(id: u64, gen_: u64, f: impl FnOnce(&mut Inner) + Send + 'static) {
    let Some(p) = lookup(id) else { return };
    let Ok(mut inner) = p.try_borrow_mut() else {
        DispatchQueue::main().exec_async(move || with_player(id, gen_, f));
        return;
    };
    if inner.gen_ == gen_ {
        f(&mut inner);
    }
}

fn schedule(id: u64, gen_: u64, ms: u64) {
    let when = DispatchTime::try_from(Duration::from_millis(ms)).unwrap_or(DispatchTime::NOW);
    let _ = DispatchQueue::main().after(when, move || tick(id, gen_));
}

fn tick(id: u64, gen_: u64) {
    let Some(p) = lookup(id) else { return };
    let next = match p.try_borrow_mut() {
        Ok(mut inner) if inner.gen_ == gen_ => inner.step(),
        Ok(_) => None,
        Err(_) => Some(5),
    };
    if let Some(ms) = next {
        schedule(id, gen_, ms);
    }
}

fn background(work: impl FnOnce() + Send + 'static) {
    DispatchQueue::global_queue(GlobalQueueIdentifier::QualityOfService(DispatchQoS::UserInitiated)).exec_async(work);
}

/// `sys.nativeVideo {handle, src?, startAt?, paused?, muted?, volume?, rate?,
/// fit?, maxResolution?, seek?, selectAudio?, selectSubtitle?, pip?}` (on the
/// main thread): the player's props and commands without a frame of the
/// window. NSH hands a component its props and commands only while it
/// draws a frame (native.rs `prepaint` → `deliver`), which an occluded
/// window never does; the player itself needs none. False when there is no
/// such player.
pub(crate) fn control(handle: u64, data: &Value) -> bool {
    let Some(p) = lookup(handle) else { return false };
    let Ok(mut i) = p.try_borrow_mut() else { return false };
    if let Some(v) = data.get("muted").and_then(Value::as_bool) {
        i.set_muted(v);
    }
    if let Some(v) = data.get("volume").and_then(Value::as_f64) {
        i.set_volume(v as f32);
    }
    if let Some(v) = data.get("rate").and_then(Value::as_f64) {
        i.set_rate(v as f32);
    }
    if let Some(v) = data.get("fit").and_then(Value::as_str) {
        i.fit = Fit::parse(Some(v));
        (i.redraw)();
    }
    if let Some(v) = data.get("maxResolution") {
        i.set_max_resolution(size_of(Some(v)));
    }
    if let Some(f) = data.get("frame") {
        // The picture's size in points (the window draws no frames, so the
        // component's own `frame` prop may not have come yet).
        let scale = screen_scale();
        i.set_display_size(size_of(Some(f)).map(|(w, h)| (w * scale, h * scale)));
    }
    if let Some(v) = data.get("nowPlaying") {
        i.set_now_playing(NowPlaying::parse(Some(v)));
    }
    if let Some(v) = data.get("startAt").and_then(Value::as_f64) {
        i.start_at = v;
    }
    if let Some(v) = data.get("paused").and_then(Value::as_bool) {
        i.set_paused(v);
    }
    match data.get("src") {
        Some(Value::String(u)) => i.set_src(Some(u)),
        Some(Value::Null) => i.set_src(None),
        _ => {}
    }
    if let Some(t) = data.get("seek").and_then(Value::as_f64) {
        i.seek(t);
    }
    if let Some(id) = data.get("selectAudio").and_then(Value::as_str) {
        i.select(false, Some(id));
    }
    match data.get("selectSubtitle") {
        Some(Value::String(id)) => i.select(true, Some(id)),
        Some(Value::Null) => i.select(true, None),
        _ => {}
    }
    if let Some(on) = data.get("pip").and_then(Value::as_bool) {
        i.pip(on);
    }
    true
}

/// `{width, height}` → a size (positive numbers only).
pub(crate) fn size_of(v: Option<&Value>) -> Option<(f64, f64)> {
    let v = v?;
    let w = v.get("width")?.as_f64()?;
    let h = v.get("height")?.as_f64()?;
    (w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0).then_some((w, h))
}

// --- The display link ---------------------------------------------------------------

/// What the display link's thread shares with the main thread.
struct LinkCtx {
    output: Obj,
    id: u64,
    gen_: u64,
    /// The newest buffer the main thread has not taken yet.
    slot: Mutex<Option<SendBox<CFRetained<CVPixelBuffer>>>>,
    /// A hop to the main thread is on its way.
    pending: AtomicBool,
}

// SAFETY: `output` is only sent the video output's thread-safe buffer
// messages from the link's thread (Apple's display-link pattern); the
// rest is atomics and a mutex.
unsafe impl Sync for LinkCtx {}
unsafe impl Send for LinkCtx {}

struct Link {
    raw: *mut c_void,
    ctx: *mut LinkCtx,
}

impl Link {
    /// A display link pulling new buffers of `output`; `None` when the
    /// system has none (the main-thread tick pulls them then).
    fn start(output: &Obj, id: u64, gen_: u64) -> Option<Link> {
        let ctx = Box::into_raw(Box::new(LinkCtx { output: output.clone(), id, gen_, slot: Mutex::new(None), pending: AtomicBool::new(false) }));
        let mut raw: *mut c_void = std::ptr::null_mut();
        // SAFETY: CoreVideo's display link API; `ctx` outlives the link
        // (freed in `stop`, after CVDisplayLinkStop returned).
        unsafe {
            if CVDisplayLinkCreateWithActiveCGDisplays(&mut raw) != 0 || raw.is_null() {
                drop(Box::from_raw(ctx));
                return None;
            }
            if CVDisplayLinkSetOutputCallback(raw, Some(on_link), ctx.cast()) != 0 || CVDisplayLinkStart(raw) != 0 {
                CVDisplayLinkRelease(raw);
                drop(Box::from_raw(ctx));
                return None;
            }
        }
        Some(Link { raw, ctx })
    }

    fn ctx(&self) -> &LinkCtx {
        // SAFETY: alive until `stop`.
        unsafe { &*self.ctx }
    }

    fn stop(self) {
        // SAFETY: CVDisplayLinkStop returns once the callback is not running;
        // only then is the context freed.
        unsafe {
            CVDisplayLinkStop(self.raw);
            CVDisplayLinkRelease(self.raw);
            drop(Box::from_raw(self.ctx));
        }
    }
}

/// A new buffer of `output` for the display refresh at `host` (mach time),
/// if it has one. Any thread.
fn pull(output: &AnyObject, host: u64) -> Option<CFRetained<CVPixelBuffer>> {
    // SAFETY: the video output's buffer messages; copyPixelBuffer returns a
    // +1 reference (or NULL), adopted once.
    guarded("frame", || unsafe {
        let t: CMTime = msg_send![output, itemTimeForMachAbsoluteTime: host as i64];
        let has: Bool = msg_send![output, hasNewPixelBufferForItemTime: t];
        if !has.as_bool() {
            return None;
        }
        let pb: *mut CVPixelBuffer = msg_send![output, copyPixelBufferForItemTime: t, itemTimeForDisplay: std::ptr::null_mut::<CMTime>()];
        NonNull::new(pb).map(|p| CFRetained::from_raw(p))
    })
    .ok()
    .flatten()
}

extern "C" fn on_link(_link: *mut c_void, _now: *const CvTimeStamp, out: *const CvTimeStamp, _flags: u64, _flags_out: *mut u64, ctx: *mut c_void) -> i32 {
    // SAFETY: the context `Link::start` passed, alive while the link runs.
    let Some(ctx) = (unsafe { (ctx as *const LinkCtx).as_ref() }) else { return 0 };
    // SAFETY: CoreVideo's output time for this callback, or now.
    let host = unsafe { out.as_ref() }.map(|t| t.host_time).filter(|h| *h > 0).unwrap_or_else(|| unsafe { mach_absolute_time() });
    let Some(buffer) = pull(&ctx.output, host) else { return 0 };
    if let Ok(mut slot) = ctx.slot.lock() {
        *slot = Some(SendBox(buffer));
    }
    if !ctx.pending.swap(true, Ordering::AcqRel) {
        let (id, gen_) = (ctx.id, ctx.gen_);
        DispatchQueue::main().exec_async(move || with_player(id, gen_, |i| i.take_linked()));
    }
    0
}

// --- The player -------------------------------------------------------------------

/// Where events go: (name, data).
pub(crate) type Emit = Rc<dyn Fn(&str, Value)>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Note {
    End,
    Failed,
    Stalled,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum Fit {
    #[default]
    Contain,
    Cover,
}

impl Fit {
    pub(crate) fn parse(v: Option<&str>) -> Fit {
        if v == Some("cover") { Fit::Cover } else { Fit::Contain }
    }
}

struct Track {
    id: String,
    label: String,
    lang: Option<String>,
    default: bool,
    option: Obj,
}

/// What the background queue made for a source.
struct Built {
    asset: Obj,
    item: Obj,
    output: Obj,
    player: Obj,
    /// Made there too (creating one can take tens of ms).
    link: Option<Link>,
}

struct Inner {
    id: u64,
    gen_: u64,
    emit: Emit,
    redraw: Rc<dyn Fn()>,
    player: Option<Obj>,
    item: Option<Obj>,
    output: Option<Obj>,
    asset: Option<Obj>,
    observers: Vec<Obj>,
    time_observer: Option<Obj>,
    link: Option<Link>,
    latest: Option<CFRetained<CVPixelBuffer>>,
    src: Option<String>,
    start_at: f64,
    paused: bool,
    muted: bool,
    volume: f32,
    rate: f32,
    fit: Fit,
    /// `maxResolution` (pixels), and the displayed size × scale.
    max_res: Option<(f64, f64)>,
    display_res: Option<(f64, f64)>,
    started: Instant,
    ready_at: Option<Instant>,
    loaded: bool,
    tracks_read: bool,
    failed: bool,
    ended: bool,
    stalled: bool,
    playing: bool,
    last_rate: f32,
    last_time: Option<f64>,
    last_progress: Option<Instant>,
    /// The loaded time ranges, read at most once a second (or after a seek).
    ranges: Vec<(f64, f64)>,
    ranges_read: Option<Instant>,
    frames: u64,
    wrong_format: u64,
    audio: Vec<Track>,
    subs: Vec<Track>,
    audio_group: Option<Obj>,
    legible_group: Option<Obj>,
    legible: Option<(Obj, Retained<legible::Delegate>)>,
    cue_lines: Vec<String>,
    now: Option<NowPlaying>,
    artwork: Option<Obj>,
    duration: Option<f64>,
    pip: Option<pip::Pip>,
    pip_supported: bool,
    pip_active: bool,
    pip_reported: Option<(bool, bool)>,
    /// The source's size (pixels) and the size the video output scales to
    /// (`None`: its own).
    source_size: Option<(f64, f64)>,
    out_size: Option<(f64, f64)>,
    resizing: bool,
}

/// One player. Dropping it stops it (paused at once, released off the
/// main thread).
pub(crate) struct Player {
    id: u64,
    inner: Rc<RefCell<Inner>>,
}

impl Player {
    pub(crate) fn new(emit: Emit, redraw: Rc<dyn Fn()>) -> Player {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let inner = Rc::new(RefCell::new(Inner {
            id,
            gen_: 0,
            emit,
            redraw,
            player: None,
            item: None,
            output: None,
            asset: None,
            observers: Vec::new(),
            time_observer: None,
            link: None,
            latest: None,
            src: None,
            start_at: 0.0,
            paused: false,
            muted: false,
            volume: 1.0,
            rate: 1.0,
            fit: Fit::Contain,
            max_res: None,
            display_res: None,
            started: Instant::now(),
            ready_at: None,
            loaded: false,
            tracks_read: false,
            failed: false,
            ended: false,
            stalled: false,
            playing: false,
            last_rate: 0.0,
            last_time: None,
            last_progress: None,
            ranges: Vec::new(),
            ranges_read: None,
            frames: 0,
            wrong_format: 0,
            audio: Vec::new(),
            subs: Vec::new(),
            audio_group: None,
            legible_group: None,
            legible: None,
            cue_lines: Vec::new(),
            now: None,
            artwork: None,
            duration: None,
            pip: None,
            pip_supported: false,
            pip_active: false,
            pip_reported: None,
            source_size: None,
            out_size: None,
            resizing: false,
        }));
        PLAYERS.with(|p| p.borrow_mut().insert(id, inner.clone()));
        LIVE.fetch_add(1, Ordering::Relaxed);
        Player { id, inner }
    }

    fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> Option<R> {
        self.inner.try_borrow_mut().ok().map(|mut i| f(&mut i))
    }

    /// The handle `sys.nativeVideo` reaches this player by.
    pub(crate) fn handle(&self) -> u64 {
        self.id
    }

    /// Plays `url` (http(s) or file); `None` stops. The same URL again
    /// changes nothing.
    pub(crate) fn set_src(&self, url: Option<&str>) {
        self.with(|i| i.set_src(url));
    }

    pub(crate) fn set_start_at(&self, secs: f64) {
        self.with(|i| i.start_at = secs);
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.with(|i| i.set_paused(paused));
    }

    pub(crate) fn set_muted(&self, muted: bool) {
        self.with(|i| i.set_muted(muted));
    }

    pub(crate) fn set_volume(&self, volume: f32) {
        self.with(|i| i.set_volume(volume));
    }

    pub(crate) fn set_rate(&self, rate: f32) {
        self.with(|i| i.set_rate(rate));
    }

    pub(crate) fn set_fit(&self, fit: Fit) {
        self.with(|i| i.fit = fit);
    }

    pub(crate) fn fit(&self) -> Fit {
        self.inner.try_borrow().map(|i| i.fit).unwrap_or_default()
    }

    pub(crate) fn set_max_resolution(&self, size: Option<(f64, f64)>) {
        self.with(|i| i.set_max_resolution(size));
    }

    /// The picture's size on screen in pixels (the default resolution cap).
    pub(crate) fn set_display_size(&self, size: Option<(f64, f64)>) {
        self.with(|i| i.set_display_size(size));
    }

    /// Seeks to `secs`; a `seeked` event follows.
    pub(crate) fn seek(&self, secs: f64) {
        self.with(|i| i.seek(secs));
    }

    /// `selectAudio` / `selectSubtitle` (`None`: subtitles off).
    pub(crate) fn select(&self, legible: bool, id: Option<&str>) {
        self.with(|i| i.select(legible, id));
    }

    pub(crate) fn pip(&self, on: bool) {
        self.with(|i| i.pip(on));
    }

    /// Picture in picture shows the video (the window paints a placeholder).
    pub(crate) fn pip_active(&self) -> bool {
        self.inner.try_borrow().is_ok_and(|i| i.pip_active)
    }

    /// Tests: builds the PiP machinery WITHOUT starting it and reports
    /// `{supported, made, possible, error}`, then drops it.
    #[allow(dead_code)]
    pub(crate) fn pip_probe(&self) -> Value {
        self.with(|i| i.pip_probe()).unwrap_or(Value::Null)
    }

    /// Tests: the size of the newest frame.
    #[allow(dead_code)]
    pub(crate) fn frame_size(&self) -> Option<(usize, usize)> {
        let f = self.frame()?;
        Some((CVPixelBufferGetWidth(&f), CVPixelBufferGetHeight(&f)))
    }

    pub(crate) fn set_now_playing(&self, info: Option<NowPlaying>) {
        self.with(|i| i.set_now_playing(info));
    }

    /// The newest frame.
    pub(crate) fn frame(&self) -> Option<CFRetained<CVPixelBuffer>> {
        self.inner.try_borrow().ok()?.latest.clone()
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        if let Ok(mut i) = self.inner.try_borrow_mut() {
            i.teardown();
        }
        PLAYERS.with(|p| p.borrow_mut().remove(&self.id));
        LIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

/// A video output of 420f buffers (scaled to `size` when given), any thread.
fn make_output(size: Option<(f64, f64)>) -> Result<Obj, String> {
    let output_cls = class(c"AVPlayerItemVideoOutput")?;
    let dict_cls = class(c"NSMutableDictionary")?;
    let number_cls = class(c"NSNumber")?;
    let (Some(k_format), Some(k_metal), Some(k_surface), Some(k_w), Some(k_h)) = (
        constant(unsafe { kCVPixelBufferPixelFormatTypeKey }),
        constant(unsafe { kCVPixelBufferMetalCompatibilityKey }),
        constant(unsafe { kCVPixelBufferIOSurfacePropertiesKey }),
        constant(unsafe { kCVPixelBufferWidthKey }),
        constant(unsafe { kCVPixelBufferHeightKey }),
    ) else {
        return Err("CoreVideo keys missing".into());
    };
    // SAFETY: NSDictionary / NSNumber / AVPlayerItemVideoOutput
    // constructors (any thread); nil results checked.
    guarded("video output", || unsafe {
        let attrs: Option<Obj> = msg_send![dict_cls, dictionary];
        let attrs = attrs.ok_or("no dictionary")?;
        let fmt: Option<Obj> = msg_send![number_cls, numberWithUnsignedInt: FORMAT_420F];
        let yes: Option<Obj> = msg_send![number_cls, numberWithBool: Bool::YES];
        let empty: Option<Obj> = msg_send![dict_cls, dictionary];
        let (Some(fmt), Some(yes), Some(empty)) = (fmt, yes, empty) else { return Err("no attributes".to_owned()) };
        let _: () = msg_send![&*attrs, setObject: &*fmt, forKey: k_format];
        let _: () = msg_send![&*attrs, setObject: &*yes, forKey: k_metal];
        let _: () = msg_send![&*attrs, setObject: &*empty, forKey: k_surface];
        if let Some((w, h)) = size {
            let w: Option<Obj> = msg_send![number_cls, numberWithInt: w as i32];
            let h: Option<Obj> = msg_send![number_cls, numberWithInt: h as i32];
            if let (Some(w), Some(h)) = (w, h) {
                let _: () = msg_send![&*attrs, setObject: &*w, forKey: k_w];
                let _: () = msg_send![&*attrs, setObject: &*h, forKey: k_h];
            }
        }
        let alloc: Allocated<AnyObject> = msg_send![output_cls, alloc];
        let output: Option<Obj> = msg_send![alloc, initWithPixelBufferAttributes: &*attrs];
        output.ok_or_else(|| "no video output".to_owned())
    })?
}

/// The main screen's points → pixels factor (2 on Retina).
fn screen_scale() -> f64 {
    let Some(cls) = AnyClass::get(c"NSScreen") else { return 2.0 };
    // SAFETY: NSScreen's mainScreen / backingScaleFactor, main thread.
    unsafe {
        let s: Option<Obj> = msg_send![cls, mainScreen];
        match s {
            Some(s) => {
                let f: f64 = msg_send![&*s, backingScaleFactor];
                if f > 0.0 { f } else { 2.0 }
            }
            None => 2.0,
        }
    }
}

/// The main screen's size in pixels: no picture can usefully be bigger.
fn screen_px() -> Option<(f64, f64)> {
    let cls = AnyClass::get(c"NSScreen")?;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect(f64, f64, f64, f64);
    // SAFETY: `{CGRect={CGPoint=dd}{CGSize=dd}}`.
    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct(
            "CGRect",
            &[Encoding::Struct("CGPoint", &[Encoding::Double, Encoding::Double]), Encoding::Struct("CGSize", &[Encoding::Double, Encoding::Double])],
        );
    }
    // SAFETY: NSScreen's mainScreen / frame, main thread.
    unsafe {
        let s: Option<Obj> = msg_send![cls, mainScreen];
        let s = s?;
        let f: Rect = msg_send![&*s, frame];
        let k = screen_scale();
        (f.2 > 0.0 && f.3 > 0.0).then_some((f.2 * k, f.3 * k))
    }
}

/// `source` fitted into `cap` (aspect kept, even sizes), when the source
/// is clearly bigger (> 1.3× its area); `None`: the source's own size.
pub(crate) fn scaled_output(source: (f64, f64), cap: (f64, f64)) -> Option<(f64, f64)> {
    let (sw, sh) = source;
    let (cw, ch) = cap;
    if sw <= 0.0 || sh <= 0.0 || cw <= 0.0 || ch <= 0.0 || sw * sh <= cw * ch * 1.3 {
        return None;
    }
    let k = (cw / sw).min(ch / sh).min(1.0);
    let even = |v: f64| ((v * k / 2.0).floor() * 2.0).max(2.0);
    Some((even(sw), even(sh)))
}

/// Makes the asset, item, output and player for `url` (background queue).
fn build(url: &str, max: Option<(f64, f64)>) -> Result<Built, String> {
    let nsurl_cls = class(c"NSURL")?;
    let asset_cls = class(c"AVURLAsset")?;
    let item_cls = class(c"AVPlayerItem")?;
    let player_cls = class(c"AVPlayer")?;
    let pitch = constant(unsafe { AVAudioTimePitchAlgorithmSpectral });
    let s = NSString::from_str(url);
    // SAFETY: Foundation / AVFoundation constructors with valid arguments
    // (all of them may be made off the main thread); nil results checked.
    guarded("AVPlayer setup", || unsafe {
        let nsurl: Option<Obj> = msg_send![nsurl_cls, URLWithString: &*s];
        let nsurl = nsurl.ok_or_else(|| format!("not a URL: {url}"))?;
        let asset: Option<Obj> = msg_send![asset_cls, URLAssetWithURL: &*nsurl, options: std::ptr::null::<AnyObject>()];
        let asset = asset.ok_or("no AVURLAsset")?;
        let item: Option<Obj> = msg_send![item_cls, playerItemWithAsset: &*asset];
        let item = item.ok_or("no AVPlayerItem")?;
        if let Some((w, h)) = max
            && responds(&item, sel!(setPreferredMaximumResolution:))
        {
            let _: () = msg_send![&*item, setPreferredMaximumResolution: CGSize { width: w, height: h }];
        }
        if let Some(pitch) = pitch {
            // Pitch-corrected rates.
            let _: () = msg_send![&*item, setAudioTimePitchAlgorithm: pitch];
        }
        let output = make_output(None)?;
        let _: () = msg_send![&*item, addOutput: &*output];
        let player: Option<Obj> = msg_send![player_cls, playerWithPlayerItem: &*item];
        let player = player.ok_or("no AVPlayer")?;
        Ok::<_, String>(Built { asset, item, output, player, link: None })
    })?
}

impl Inner {
    fn effective_max(&self) -> Option<(f64, f64)> {
        self.max_res.or(self.display_res).or_else(screen_px)
    }

    fn set_src(&mut self, url: Option<&str>) {
        let url = url.filter(|u| !u.is_empty());
        if url == self.src.as_deref() {
            return;
        }
        self.teardown();
        self.src = url.map(str::to_owned);
        let Some(url) = url else { return };
        // A new generation: whatever the old source's callbacks bring is ignored.
        self.gen_ += 1;
        self.started = Instant::now();
        self.ready_at = None;
        self.loaded = false;
        self.tracks_read = false;
        self.failed = false;
        self.ended = false;
        self.stalled = false;
        self.last_rate = 0.0;
        self.last_time = None;
        self.last_progress = None;
        self.ranges.clear();
        self.ranges_read = None;
        self.frames = 0;
        self.wrong_format = 0;
        let (id, gen_, url, max) = (self.id, self.gen_, url.to_owned(), self.effective_max());
        background(move || {
            let built = build(&url, max).map(|mut b| {
                b.link = Link::start(&b.output, id, gen_);
                b
            });
            let built = SendBox(built);
            DispatchQueue::main().exec_async(move || {
                with_player(id, gen_, move |i| {
                    // The whole box moves in (not just its field, which is not Send).
                    let built = built;
                    i.attach(built.0);
                });
            });
        });
    }

    fn fail(&mut self, message: String, code: &str) {
        self.failed = true;
        self.set_playing(false);
        (self.emit)("error", json!({ "message": message, "code": code, "fatal": true }));
    }

    /// The background queue made the source's objects: start playing.
    fn attach(&mut self, built: Result<Built, String>) {
        let b = match built {
            Ok(b) => b,
            Err(e) => return self.fail(e, "source"),
        };
        let (muted, volume) = (self.muted, self.volume);
        // SAFETY: AVPlayer's properties, on the main thread.
        let _ = guarded("AVPlayer properties", || unsafe {
            let _: () = msg_send![&*b.player, setMuted: Bool::new(muted)];
            let _: () = msg_send![&*b.player, setVolume: volume];
        });
        self.observe(&b.item);
        self.observe_time(&b.player);
        self.legible = legible::attach(&b.item, self.id, self.gen_);
        self.pip_supported = pip::supported();
        self.link = b.link;
        // Frames the link pulled before this: take the newest now.
        self.take_linked();
        self.load_tracks(&b.asset);
        self.player = Some(b.player);
        self.item = Some(b.item);
        self.output = Some(b.output);
        self.asset = Some(b.asset);
        // `startAt` applies once, to this source.
        let t = std::mem::take(&mut self.start_at);
        if t > 0.0 {
            self.seek(t);
        }
        self.apply_rate();
        self.claim_now_playing();
        schedule(self.id, self.gen_, 0);
    }

    fn set_paused(&mut self, paused: bool) {
        if self.paused == paused {
            return;
        }
        self.paused = paused;
        self.apply_rate();
        self.progress_now();
    }

    fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
        if let Some(p) = &self.player {
            // SAFETY: AVPlayer's muted, on the main thread.
            let _ = guarded("muted", || unsafe {
                let _: () = msg_send![&**p, setMuted: Bool::new(muted)];
            });
        }
    }

    fn set_volume(&mut self, volume: f32) {
        self.volume = if volume.is_finite() { volume.clamp(0.0, 1.0) } else { 1.0 };
        if let Some(p) = &self.player {
            let v = self.volume;
            // SAFETY: AVPlayer's volume, on the main thread.
            let _ = guarded("volume", || unsafe {
                let _: () = msg_send![&**p, setVolume: v];
            });
        }
    }

    fn set_rate(&mut self, rate: f32) {
        self.rate = if rate.is_finite() && rate > 0.0 { rate.clamp(0.25, 4.0) } else { 1.0 };
        self.apply_rate();
    }

    fn set_max_resolution(&mut self, size: Option<(f64, f64)>) {
        self.max_res = size;
        self.apply_max();
    }

    fn set_display_size(&mut self, size: Option<(f64, f64)>) {
        // Small changes (window resizing) do not switch variants.
        let changed = match (self.display_res, size) {
            (Some((a, b)), Some((c, d))) => (a - c).abs() > a * 0.2 || (b - d).abs() > b * 0.2,
            (a, b) => a.is_some() != b.is_some(),
        };
        if changed {
            self.display_res = size;
            self.apply_max();
            self.check_output_size();
        }
    }

    /// A source bigger than the cap gets a scaled video output (made off the
    /// main thread with its display link; swapped in here).
    fn check_output_size(&mut self) {
        let (Some(source), Some(cap)) = (self.source_size, self.effective_max()) else { return };
        let want = scaled_output(source, cap);
        if want == self.out_size || self.resizing || self.item.is_none() {
            return;
        }
        self.resizing = true;
        let (id, gen_) = (self.id, self.gen_);
        background(move || {
            let made = make_output(want).map(|o| {
                let link = Link::start(&o, id, gen_);
                (o, link)
            });
            let made = SendBox(made);
            DispatchQueue::main().exec_async(move || {
                with_player(id, gen_, move |i| {
                    let made = made;
                    i.swap_output(made.0, want);
                });
            });
        });
    }

    fn swap_output(&mut self, made: Result<(Obj, Option<Link>), String>, size: Option<(f64, f64)>) {
        self.resizing = false;
        let Ok((output, link)) = made else { return };
        let Some(item) = self.item.clone() else { return };
        // SAFETY: AVPlayerItem's addOutput: / removeOutput:, main thread.
        let ok = guarded("swap output", || unsafe {
            let _: () = msg_send![&*item, addOutput: &*output];
        })
        .is_ok();
        if !ok {
            return;
        }
        let now = self.output_time().or(self.last_time).unwrap_or(0.0);
        let old = SendBox((self.output.replace(output), std::mem::replace(&mut self.link, link), item));
        self.out_size = size;
        // An output added during playback gets no buffers until the pipeline
        // flushes: a quiet seek to where it is (no `seeked` for the app).
        if let Some(p) = self.player.clone() {
            let t = CMTime::from_seconds(now);
            let zero = CMTime::from_seconds(0.0);
            // SAFETY: AVPlayer's seekToTime:toleranceBefore:toleranceAfter:.
            let _ = guarded("flush", || unsafe {
                let _: () = msg_send![&*p, seekToTime: t, toleranceBefore: zero, toleranceAfter: zero];
            });
        }
        // The old output and its link go off the main thread.
        background(move || {
            let old = old;
            let (output, link, item) = old.0;
            if let Some(l) = link {
                l.stop();
            }
            if let Some(o) = output {
                let _ = guarded("removeOutput", || unsafe {
                    let _: () = msg_send![&*item, removeOutput: &*o];
                });
            }
        });
        // Re-check: the size may have moved on meanwhile.
        self.check_output_size();
    }

    fn apply_max(&self) {
        let (Some(item), max) = (&self.item, self.effective_max()) else { return };
        let (w, h) = max.unwrap_or((0.0, 0.0));
        if responds(item, sel!(setPreferredMaximumResolution:)) {
            // SAFETY: AVPlayerItem's preferredMaximumResolution (0×0: none).
            let _ = guarded("preferredMaximumResolution", || unsafe {
                let _: () = msg_send![&**item, setPreferredMaximumResolution: CGSize { width: w, height: h }];
            });
        }
    }

    fn observe(&mut self, item: &AnyObject) {
        let (Ok(center_cls), Ok(queue_cls)) = (class(c"NSNotificationCenter"), class(c"NSOperationQueue")) else { return };
        // SAFETY: NSNotificationCenter / NSOperationQueue singletons.
        let (center, queue): (Option<Obj>, Option<Obj>) = unsafe { (msg_send![center_cls, defaultCenter], msg_send![queue_cls, mainQueue]) };
        let (Some(center), Some(queue)) = (center, queue) else { return };
        let names = [
            (constant(unsafe { AVPlayerItemDidPlayToEndTimeNotification }), Note::End),
            (constant(unsafe { AVPlayerItemFailedToPlayToEndTimeNotification }), Note::Failed),
            (constant(unsafe { AVPlayerItemPlaybackStalledNotification }), Note::Stalled),
        ];
        for (name, note) in names {
            let Some(name) = name else { continue };
            let (id, gen_) = (self.id, self.gen_);
            let block = RcBlock::new(move |n: *mut AnyObject| {
                // SAFETY: the notification AppKit hands the block, alive for
                // the call.
                let info = if note == Note::Failed { failed_info(unsafe { n.as_ref() }) } else { (String::new(), String::new()) };
                DispatchQueue::main().exec_async(move || with_player(id, gen_, move |i| i.on_note(note, info)));
            });
            // SAFETY: the block-based observer API; the token is removed in
            // `teardown`.
            let token: Result<Option<Obj>, String> = guarded("observer", || unsafe {
                msg_send![&*center, addObserverForName: name, object: item, queue: &*queue, usingBlock: &*block]
            });
            if let Ok(Some(t)) = token {
                self.observers.push(t);
            }
        }
    }

    /// The current time, 4 times a second, from AVFoundation's own queue.
    fn observe_time(&mut self, player: &AnyObject) {
        let (id, gen_) = (self.id, self.gen_);
        let block = RcBlock::new(move |t: CMTime| {
            let secs = t.seconds();
            with_player(id, gen_, move |i| i.on_time(secs));
        });
        let every = CMTime::from_seconds(0.25);
        // SAFETY: AVPlayer's periodic time observer (nil queue: the main
        // queue); removed in `teardown`.
        let token: Result<Option<Obj>, String> = guarded("time observer", || unsafe {
            msg_send![player, addPeriodicTimeObserverForInterval: every, queue: std::ptr::null::<AnyObject>(), usingBlock: &*block]
        });
        self.time_observer = token.ok().flatten();
    }

    fn on_time(&mut self, secs: Option<f64>) {
        self.last_time = secs;
        if self.last_progress.is_none_or(|t| t.elapsed() >= Duration::from_millis(200)) {
            self.progress(secs);
        }
    }

    fn on_note(&mut self, note: Note, info: (String, String)) {
        match note {
            Note::End if !self.ended => {
                self.ended = true;
                (self.emit)("end", json!({}));
            }
            Note::Failed => self.fail(format!("failed to play to the end: {}", info.0), &info.1),
            Note::Stalled if !self.stalled => {
                self.stalled = true;
                (self.emit)("buffer", json!({ "stalled": true, "reason": "stalled" }));
                self.progress_now();
            }
            _ => {}
        }
    }

    fn apply_rate(&mut self) {
        let Some(p) = &self.player else { return };
        let (paused, rate) = (self.paused, self.rate);
        // SAFETY: AVPlayer's pause / rate, on the main thread.
        let r = guarded("rate", || unsafe {
            if paused {
                let _: () = msg_send![&**p, pause];
            } else {
                let _: () = msg_send![&**p, setRate: rate];
            }
        });
        if let Err(e) = r {
            (self.emit)("error", json!({ "message": e, "code": "internal", "fatal": false }));
        }
    }

    fn seek(&mut self, secs: f64) {
        let Some(p) = self.player.clone() else {
            // Not attached yet: where it starts.
            self.start_at = secs;
            return;
        };
        let target = if secs.is_finite() { secs.max(0.0) } else { 0.0 };
        let t = CMTime::from_seconds(target);
        let tol = CMTime::from_seconds(0.5);
        let (id, gen_, t0) = (self.id, self.gen_, Instant::now());
        let done = RcBlock::new(move |finished: Bool| {
            let finished = finished.as_bool();
            DispatchQueue::main().exec_async(move || {
                with_player(id, gen_, move |i| {
                    let now = i.output_time();
                    (i.emit)(
                        "seeked",
                        json!({ "target": target, "time": now, "finished": finished, "ms": t0.elapsed().as_millis() as u64 }),
                    );
                    i.ranges_read = None;
                    i.progress(now);
                    i.update_now_playing();
                });
            });
        });
        self.ended = false;
        // SAFETY: AVPlayer's seek with valid times; AVFoundation copies the
        // block and calls it once.
        let r = guarded("seek", || unsafe {
            let _: () = msg_send![&*p, seekToTime: t, toleranceBefore: tol, toleranceAfter: tol, completionHandler: &*done];
        });
        if let Err(e) = r {
            (self.emit)("error", json!({ "message": e, "code": "internal", "fatal": false }));
        }
    }

    /// The item's time now, from the video output's timebase (never the
    /// player's lock).
    fn output_time(&self) -> Option<f64> {
        let o = self.output.as_ref()?;
        // SAFETY: AVPlayerItemOutput's itemTimeForMachAbsoluteTime:.
        let t: CMTime = unsafe { msg_send![&**o, itemTimeForMachAbsoluteTime: mach_absolute_time() as i64] };
        t.seconds().or(self.last_time)
    }

    /// The display link's newest buffer.
    fn take_linked(&mut self) {
        let Some(link) = &self.link else { return };
        let ctx = link.ctx();
        ctx.pending.store(false, Ordering::Release);
        let buffer = ctx.slot.lock().ok().and_then(|mut s| s.take());
        if let Some(b) = buffer {
            self.accept(b.0);
        }
    }

    /// A new buffer: kept when GPUI can draw its format; a redraw.
    fn accept(&mut self, buffer: CFRetained<CVPixelBuffer>) {
        if CVPixelBufferGetPixelFormatType(&buffer) != FORMAT_420F {
            // GPUI's renderer asserts this format: never hand it another.
            self.wrong_format += 1;
            if self.wrong_format == 1 {
                log::warn!("player: dropped a pixel buffer of format {:#x}", CVPixelBufferGetPixelFormatType(&buffer));
            }
            return;
        }
        self.frames += 1;
        if self.frames == 1 {
            let (w, h) = (CVPixelBufferGetWidth(&buffer), CVPixelBufferGetHeight(&buffer));
            (self.emit)("frame", json!({ "ms": self.started.elapsed().as_millis() as u64, "width": w, "height": h }));
        }
        self.latest = Some(buffer);
        (self.redraw)();
    }

    fn progress_now(&mut self) {
        let t = self.output_time();
        self.progress(t);
    }

    fn progress(&mut self, now: Option<f64>) {
        if !self.loaded && self.frames == 0 {
            return;
        }
        self.last_progress = Some(Instant::now());
        let (buffered, playable) = self.buffered(now.unwrap_or(0.0));
        (self.emit)(
            "progress",
            json!({ "currentTime": now, "buffered": buffered, "playable": playable, "frames": self.frames, "dropped": self.wrong_format }),
        );
    }

    /// One tick (cached state only); the delay to the next, `None` to stop.
    fn step(&mut self) -> Option<u64> {
        let (Some(player), Some(item)) = (self.player.clone(), self.item.clone()) else { return None };
        // No display link: pull frames here (the output's own timebase).
        if self.link.is_none()
            && let Some(o) = self.output.clone()
            && let Some(b) = pull(&o, unsafe { mach_absolute_time() })
        {
            self.accept(b);
        }
        // SAFETY: cached properties of AVPlayerItem / AVPlayer, main thread.
        let (status, tcs, rate) = unsafe {
            let s: isize = msg_send![&*item, status];
            let c: isize = msg_send![&*player, timeControlStatus];
            let r: f32 = msg_send![&*player, rate];
            (s, c, r)
        };
        if status == 2 {
            if !self.failed {
                // SAFETY: AVPlayerItem's error.
                let err: Option<Obj> = unsafe { msg_send![&*item, error] };
                let (m, c) = error_info(err.as_deref());
                self.fail(m, &c);
            }
            return None;
        }
        if status == 1 && self.ready_at.is_none() {
            self.ready_at = Some(Instant::now());
        }
        // `load` once ready, with the tracks (or without them after 3 s).
        if !self.loaded && self.ready_at.is_some_and(|t| self.tracks_read || t.elapsed() >= Duration::from_secs(3)) {
            self.loaded = true;
            // SAFETY: AVPlayerItem's duration / presentationSize, ready by now.
            let (dur, size): (CMTime, CGSize) = unsafe { (msg_send![&*item, duration], msg_send![&*item, presentationSize]) };
            let (audio, subs) = self.tracks_json();
            (self.emit)(
                "load",
                json!({
                    "duration": dur.seconds(),
                    "width": size.width,
                    "height": size.height,
                    "audioTracks": audio,
                    "subtitleTracks": subs,
                    "ms": self.started.elapsed().as_millis() as u64,
                }),
            );
            self.duration = dur.seconds();
            if size.width > 0.0 && size.height > 0.0 {
                self.source_size = Some((size.width, size.height));
            }
            self.pip_reported = None;
            self.emit_pip();
            self.progress_now();
            self.update_now_playing();
            self.check_output_size();
        }
        let waiting = tcs == 1 && !self.paused;
        if waiting != self.stalled {
            self.stalled = waiting;
            let reason = if waiting {
                // SAFETY: AVPlayer's reasonForWaitingToPlay (an NSString or nil).
                let r: Option<Obj> = unsafe { msg_send![&*player, reasonForWaitingToPlay] };
                ns_string(r.as_deref())
            } else {
                None
            };
            (self.emit)("buffer", json!({ "stalled": waiting, "reason": reason }));
            self.progress_now();
        }
        let effective = if tcs == 2 { rate } else { 0.0 };
        if (effective - self.last_rate).abs() > 0.001 {
            self.last_rate = effective;
            (self.emit)("rate", json!({ "rate": effective, "paused": self.paused }));
            self.update_now_playing();
        }
        self.set_playing(tcs == 2);
        self.pip_tick();
        if self.loaded {
            // The source's size (often 0 at `load` for HLS; it also changes
            // with the variant): a bigger one than the cap gets a scaled output.
            // SAFETY: AVPlayerItem's presentationSize (cached).
            let size: CGSize = unsafe { msg_send![&*item, presentationSize] };
            let now = (size.width > 0.0 && size.height > 0.0).then_some((size.width, size.height));
            if now.is_some() && now != self.source_size {
                self.source_size = now;
                self.check_output_size();
            }
        }
        Some(if self.link.is_none() && tcs == 2 { 15 } else { 100 })
    }

    /// (end of the loaded range around `now`, end of the furthest one).
    fn buffered(&mut self, now: f64) -> (Option<f64>, Option<f64>) {
        if self.ranges_read.is_none_or(|t| t.elapsed() >= Duration::from_secs(1)) {
            self.ranges_read = Some(Instant::now());
            self.ranges = self.read_ranges();
        }
        let around = self.ranges.iter().find(|(a, e)| *a <= now + 0.5 && now <= *e).map(|r| r.1);
        let furthest = self.ranges.iter().map(|r| r.1).fold(None, |m: Option<f64>, e| Some(m.map_or(e, |m| m.max(e))));
        (around, furthest)
    }

    fn read_ranges(&self) -> Vec<(f64, f64)> {
        let Some(item) = self.item.as_ref() else { return Vec::new() };
        // SAFETY: AVPlayerItem's loadedTimeRanges, an NSArray of NSValue
        // holding CMTimeRange.
        unsafe {
            let ranges: Option<Obj> = msg_send![&**item, loadedTimeRanges];
            let Some(ranges) = ranges else { return Vec::new() };
            let n: usize = msg_send![&*ranges, count];
            let mut out = Vec::with_capacity(n);
            for k in 0..n {
                let v: Option<Obj> = msg_send![&*ranges, objectAtIndex: k];
                let Some(v) = v else { continue };
                let r: CMTimeRange = msg_send![&*v, CMTimeRangeValue];
                if let (Some(a), Some(d)) = (r.start.seconds(), r.duration.seconds()) {
                    out.push((a, a + d));
                }
            }
            out
        }
    }

    // --- Tracks ------------------------------------------------------------------

    fn load_tracks(&mut self, asset: &Obj) {
        let Ok(array_cls) = class(c"NSArray") else { return };
        let key = NSString::from_str("availableMediaCharacteristicsWithMediaSelectionOptions");
        let (id, gen_) = (self.id, self.gen_);
        let done = RcBlock::new(move || {
            DispatchQueue::main().exec_async(move || with_player(id, gen_, |i| i.read_tracks()));
        });
        // SAFETY: AVAsset's asynchronous key loading; the block is copied and
        // called once, on some queue (it hops to the main one).
        let _ = guarded("tracks", || unsafe {
            let keys: Option<Obj> = msg_send![array_cls, arrayWithObject: &*key];
            if let Some(keys) = keys {
                let _: () = msg_send![&**asset, loadValuesAsynchronouslyForKeys: &*keys, completionHandler: &*done];
            }
        });
    }

    fn read_tracks(&mut self) {
        let Some(asset) = self.asset.clone() else { return };
        let read = |c: *const AnyObject, prefix: char| -> (Option<Obj>, Vec<Track>) {
            let Some(ch) = constant(c) else { return (None, Vec::new()) };
            // SAFETY: AVAsset's media selection groups (loaded by now) and
            // AVMediaSelectionOption's properties.
            unsafe {
                let group: Option<Obj> = msg_send![&*asset, mediaSelectionGroupForMediaCharacteristic: ch];
                let Some(group) = group else { return (None, Vec::new()) };
                let options: Option<Obj> = msg_send![&*group, options];
                let default: Option<Obj> = msg_send![&*group, defaultOption];
                let mut out = Vec::new();
                if let Some(options) = options {
                    let n: usize = msg_send![&*options, count];
                    for k in 0..n {
                        let o: Option<Obj> = msg_send![&*options, objectAtIndex: k];
                        let Some(o) = o else { continue };
                        let name: Option<Obj> = msg_send![&*o, displayName];
                        let lang: Option<Obj> = if responds(&o, sel!(extendedLanguageTag)) { msg_send![&*o, extendedLanguageTag] } else { None };
                        let is_default = default.as_deref().is_some_and(|d| {
                            let eq: Bool = msg_send![d, isEqual: &*o];
                            eq.as_bool()
                        });
                        out.push(Track {
                            id: format!("{prefix}{k}"),
                            label: ns_string(name.as_deref()).unwrap_or_default(),
                            lang: ns_string(lang.as_deref()),
                            default: is_default,
                            option: o,
                        });
                    }
                }
                (Some(group), out)
            }
        };
        let (ag, audio) = read(unsafe { AVMediaCharacteristicAudible }, 'a');
        let (lg, subs) = read(unsafe { AVMediaCharacteristicLegible }, 's');
        self.audio_group = ag;
        self.legible_group = lg;
        self.audio = audio;
        self.subs = subs;
        let was = self.tracks_read;
        self.tracks_read = true;
        if was || self.loaded {
            self.emit_tracks();
        }
    }

    /// The selected option of `group`, if any.
    fn selected(&self, group: Option<&Obj>) -> Option<Obj> {
        let (item, group) = (self.item.as_ref()?, group?);
        // SAFETY: AVPlayerItem's currentMediaSelection (macOS 10.11+).
        unsafe {
            let sel: Option<Obj> = msg_send![&**item, currentMediaSelection];
            let sel = sel?;
            msg_send![&*sel, selectedMediaOptionInMediaSelectionGroup: &**group]
        }
    }

    fn tracks_json(&self) -> (Value, Value) {
        let list = |tracks: &[Track], group: Option<&Obj>| {
            let cur = self.selected(group);
            Value::Array(
                tracks
                    .iter()
                    .map(|t| {
                        let on = cur.as_deref().is_some_and(|c| {
                            // SAFETY: NSObject's isEqual:.
                            let eq: Bool = unsafe { msg_send![c, isEqual: &*t.option] };
                            eq.as_bool()
                        });
                        json!({ "id": t.id, "label": t.label, "lang": t.lang, "default": t.default, "selected": on })
                    })
                    .collect(),
            )
        };
        (list(&self.audio, self.audio_group.as_ref()), list(&self.subs, self.legible_group.as_ref()))
    }

    fn emit_tracks(&self) {
        let (audio, subs) = self.tracks_json();
        (self.emit)("tracks", json!({ "audioTracks": audio, "subtitleTracks": subs }));
    }

    fn select(&mut self, legible: bool, id: Option<&str>) {
        let (tracks, group) = if legible { (&self.subs, self.legible_group.clone()) } else { (&self.audio, self.audio_group.clone()) };
        let option = match id {
            Some(id) => match tracks.iter().find(|t| t.id == id) {
                Some(t) => Some(t.option.clone()),
                None => {
                    (self.emit)("error", json!({ "message": format!("no track {id}"), "code": "track", "fatal": false }));
                    return;
                }
            },
            None => None,
        };
        let (Some(item), Some(group)) = (self.item.clone(), group) else { return };
        // SAFETY: AVPlayerItem's selectMediaOption:inMediaSelectionGroup:
        // (nil: none, for groups that allow an empty selection).
        let r = guarded("select", || unsafe {
            if option.is_none() {
                let empty: Bool = msg_send![&*group, allowsEmptySelection];
                if !empty.as_bool() {
                    return;
                }
            }
            let o: *const AnyObject = option.as_deref().map_or(std::ptr::null(), |o| o as *const AnyObject);
            let _: () = msg_send![&*item, selectMediaOption: o, inMediaSelectionGroup: &*group];
        });
        match r {
            Ok(()) => {
                if legible {
                    self.clear_cues();
                }
                self.emit_tracks();
            }
            Err(e) => (self.emit)("error", json!({ "message": e, "code": "track", "fatal": false })),
        }
    }

    fn set_playing(&mut self, playing: bool) {
        if playing != self.playing {
            self.playing = playing;
            if playing {
                PLAYING.fetch_add(1, Ordering::Relaxed);
            } else {
                PLAYING.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }

    /// Stops at once (paused, no more frames or events) and releases the
    /// player off the main thread.
    fn teardown(&mut self) {
        self.gen_ += 1;
        self.set_playing(false);
        self.drop_pip();
        self.pip_active = false;
        self.pip_reported = None;
        self.release_now_playing();
        self.cue_lines.clear();
        self.source_size = None;
        self.out_size = None;
        self.resizing = false;
        self.duration = None;
        if let Some((o, _)) = &self.legible {
            // SAFETY: the legible output's delegate goes first.
            let _ = guarded("legible", || unsafe {
                let _: () = msg_send![&**o, setDelegate: std::ptr::null::<AnyObject>(), queue: std::ptr::null::<AnyObject>()];
            });
        }
        let legible_out = SendBox(self.legible.take());
        // Stopping a display link waits for its callback: off the main thread
        // (its late hops find a new generation and are ignored).
        let link = SendBox(self.link.take());
        if let (Ok(center_cls), false) = (class(c"NSNotificationCenter"), self.observers.is_empty()) {
            // SAFETY: removing the observers this player added.
            let center: Option<Obj> = unsafe { msg_send![center_cls, defaultCenter] };
            if let Some(center) = center {
                for t in self.observers.drain(..) {
                    let _ = guarded("removeObserver", || unsafe {
                        let _: () = msg_send![&*center, removeObserver: &*t];
                    });
                }
            }
        }
        self.observers.clear();
        let player = self.player.take();
        if let Some(p) = &player {
            let token = self.time_observer.take();
            // SAFETY: AVPlayer's pause / removeTimeObserver:, main thread.
            let _ = guarded("stop", || unsafe {
                let _: () = msg_send![&**p, pause];
                if let Some(t) = &token {
                    let _: () = msg_send![&**p, removeTimeObserver: &**t];
                }
            });
        }
        self.time_observer = None;
        let gone = SendBox((player, self.item.take(), self.output.take(), self.asset.take()));
        self.audio.clear();
        self.subs.clear();
        self.audio_group = None;
        self.legible_group = None;
        self.latest = None;
        if gone.0.0.is_some() || gone.0.1.is_some() || link.0.is_some() || legible_out.0.is_some() {
            // Releasing an item can wait on AVFoundation: not on the main thread.
            background(move || {
                let (gone, link, legible_out) = (gone, link, legible_out);
                if let Some(l) = link.0 {
                    l.stop();
                }
                let (player, item, output, _asset) = gone.0;
                let _ = guarded("release", || unsafe {
                    if let Some(p) = &player {
                        let _: () = msg_send![&**p, replaceCurrentItemWithPlayerItem: std::ptr::null::<AnyObject>()];
                    }
                    if let (Some(i), Some(o)) = (&item, &output) {
                        let _: () = msg_send![&**i, removeOutput: &**o];
                    }
                    if let (Some(i), Some((o, _))) = (&item, &legible_out.0) {
                        let _: () = msg_send![&**i, removeOutput: &**o];
                    }
                });
            });
        }
    }
}

fn failed_info(note: Option<&AnyObject>) -> (String, String) {
    let (Some(note), Some(key)) = (note, constant(unsafe { AVPlayerItemFailedToPlayToEndTimeErrorKey })) else {
        return ("unknown error".into(), "internal".into());
    };
    // SAFETY: NSNotification's userInfo and NSDictionary's objectForKey:.
    unsafe {
        let info: Option<Obj> = msg_send![note, userInfo];
        let err: Option<Obj> = match info {
            Some(info) => msg_send![&*info, objectForKey: key],
            None => None,
        };
        error_info(err.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_bigger_than_the_picture_gets_a_scaled_output() {
        // 4K into a 1440×900-pt window on a 2× screen (2880×1800 px).
        assert_eq!(scaled_output((3840.0, 2160.0), (2880.0, 1800.0)), Some((2880.0, 1620.0)));
        // 1080p into a 640×360 picture.
        assert_eq!(scaled_output((1920.0, 1080.0), (640.0, 360.0)), Some((640.0, 360.0)));
        // Odd results round down to even sizes, aspect kept.
        assert_eq!(scaled_output((1920.0, 800.0), (1001.0, 1001.0)), Some((1000.0, 416.0)));
        // Not clearly bigger (≤ 1.3× the area), or nothing known: its own size.
        assert_eq!(scaled_output((1920.0, 1080.0), (1800.0, 1000.0)), None);
        assert_eq!(scaled_output((1280.0, 720.0), (2880.0, 1800.0)), None);
        assert_eq!(scaled_output((0.0, 0.0), (640.0, 360.0)), None);
        assert_eq!(scaled_output((1920.0, 1080.0), (0.0, 0.0)), None);
    }

    #[test]
    fn now_playing_info_needs_a_title() {
        assert_eq!(
            NowPlaying::parse(Some(&json!({ "title": " Fight Club ", "subtitle": "1999", "artwork": "" }))),
            Some(NowPlaying { title: "Fight Club".into(), subtitle: Some("1999".into()), artwork: None })
        );
        assert_eq!(NowPlaying::parse(Some(&json!({ "subtitle": "x" }))), None);
        assert_eq!(NowPlaying::parse(Some(&json!(null))), None);
        assert_eq!(NowPlaying::parse(None), None);
    }
}
