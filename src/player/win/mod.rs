//! `rustflix.video` on Windows: libmpv (software render API) on a dedicated
//! thread, frames painted by GPUI's sprite atlas as BGRA `RenderImage`s.
//! Same contract as `super::av` (macOS) — see `super::component`'s header
//! and `app/lib/nativevideo.tsx`. No NSH types in the mpv layer below
//! [`Player`]; the component (`component.rs`) adapts it.
//!
//! - `libmpv-2.dll` is loaded at runtime (`LoadLibrary`), so the exe has no
//!   link-time dependency; `vulkan-1.dll` must sit beside it (see
//!   docs/DESKTOP-PORTS.md).
//! - `vo=libmpv` is required (mpv >= 0.38); the SW renderer writes B,G,R,X
//!   into a caller buffer — the X byte is set to 255 because GPUI's sprite
//!   shader multiplies texture alpha.
//! - One frame buffer per rendered frame is handed to GPUI as an
//!   `Arc<gpui::RenderImage>`; the component drops the previous one from the
//!   atlas (`Window::drop_image`) so tiles don't accumulate.
//! - The engine thread owns the `mpv_handle` and render context (mpv
//!   requires render-context calls on their creating thread) and pumps
//!   `mpv_wait_event`; commands arrive over a channel. Events go out
//!   through `ComponentContext::emit`/`redraw`, which are `Send + Sync`.

use std::{
    ffi::{CStr, CString, c_char, c_int, c_uint, c_void},
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc::{Receiver, Sender, channel},
    },
    thread,
    time::{Duration, Instant},
};

use image::{Frame, RgbaImage};
use nsh_platform_gpui::{ComponentContext, gpui};
use serde_json::{Value, json};

pub(crate) mod component;

// --- libmpv FFI -----------------------------------------------------------------

type HModule = *mut c_void;
type FnAddr = *const ();

unsafe extern "system" {
    fn LoadLibraryW(name: *const u16) -> HModule;
    fn GetProcAddress(module: HModule, name: *const c_char) -> FnAddr;
    fn FreeLibrary(module: HModule) -> c_int;
}

struct Lib(HModule);

impl Lib {
    fn load() -> Option<Lib> {
        // Next to the exe first, then the working directory.
        for path in ["libmpv-2.dll", r"lib\mpv\libmpv-2.dll"] {
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            let m = unsafe { LoadLibraryW(wide.as_ptr()) };
            if !m.is_null() {
                return Some(Lib(m));
            }
        }
        None
    }
    unsafe fn sym<T>(&self, name: &str) -> Option<T> {
        let n = CString::new(name).ok()?;
        let f = unsafe { GetProcAddress(self.0, n.as_ptr()) };
        (!f.is_null()).then(|| unsafe { std::mem::transmute_copy(&f) })
    }
}

impl Drop for Lib {
    fn drop(&mut self) {
        unsafe { FreeLibrary(self.0) };
    }
}

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
union MpvNodeU {
    string: *mut c_char,
    flag: c_int,
    int64: i64,
    double: f64,
    list: *mut MpvNodeList,
}

#[repr(C)]
struct MpvNode {
    u: MpvNodeU,
    format: c_int,
}

#[repr(C)]
struct MpvNodeList {
    num: c_int,
    values: *mut MpvNode,
    keys: *mut *mut c_char,
}

#[repr(C)]
struct MpvRenderParam {
    type_: c_uint,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventEndFile {
    reason: c_int,
    error: c_int,
    playlist_entry: c_int,
}

#[repr(C)]
struct MpvEventSeek {
    position: f64,
}

struct Fns {
    create: unsafe extern "C" fn() -> *mut c_void,
    initialize: unsafe extern "C" fn(*mut c_void) -> c_int,
    destroy: unsafe extern "C" fn(*mut c_void),
    set_option_string: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    set_property_string: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int,
    wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent,
    free: unsafe extern "C" fn(*mut c_void),
    get_property_string: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char,
    observe_property: unsafe extern "C" fn(*mut c_void, u64, *const c_char, c_int) -> c_int,
    request_log_messages: unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int,
    render_create: unsafe extern "C" fn(*mut *mut c_void, *mut c_void, *mut MpvRenderParam) -> c_int,
    render_render: unsafe extern "C" fn(*mut c_void, *mut MpvRenderParam) -> c_int,
    render_update: unsafe extern "C" fn(*mut c_void) -> u64,
    render_free: unsafe extern "C" fn(*mut c_void),
    render_swap: unsafe extern "C" fn(*mut c_void),
}

const MPV_FORMAT_NODE: c_int = 6;
const MPV_EVENT_END_FILE: c_int = 7;
const MPV_EVENT_SEEK: c_int = 20;
const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;
const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;
const MPV_RENDER_UPDATE_FRAME: u64 = 1;
// mpv_end_file_reason
const END_EOF: c_int = 0;
const END_ERROR: c_int = 4;

struct Mpv {
    ctx: *mut c_void,
    fns: Fns,
    _lib: Lib,
}

fn cs(s: &str) -> CString {
    CString::new(s).unwrap()
}

impl Mpv {
    fn new() -> Result<Mpv, String> {
        let lib = Lib::load().ok_or("libmpv-2.dll not found")?;
        macro_rules! sym {
            ($n:literal) => {
                unsafe { lib.sym($n) }.ok_or(concat!("missing export ", $n))?
            };
        }
        let fns = Fns {
            create: sym!("mpv_create"),
            initialize: sym!("mpv_initialize"),
            destroy: sym!("mpv_destroy"),
            set_option_string: sym!("mpv_set_option_string"),
            set_property_string: sym!("mpv_set_property_string"),
            command: sym!("mpv_command"),
            wait_event: sym!("mpv_wait_event"),
            free: sym!("mpv_free"),
            get_property_string: sym!("mpv_get_property_string"),
            observe_property: sym!("mpv_observe_property"),
            request_log_messages: sym!("mpv_request_log_messages"),
            render_create: sym!("mpv_render_context_create"),
            render_render: sym!("mpv_render_context_render"),
            render_update: sym!("mpv_render_context_update"),
            render_free: sym!("mpv_render_context_free"),
            render_swap: sym!("mpv_render_context_report_swap"),
        };
        let ctx = unsafe { (fns.create)() };
        if ctx.is_null() {
            return Err("mpv_create failed".into());
        }
        let mpv = Mpv { ctx, fns, _lib: lib };
        mpv.option("config", "no")?;
        mpv.option("terminal", "no")?;
        mpv.option("idle", "yes")?;
        mpv.option("vo", "libmpv")?;
        mpv.option("cache", "yes")?;
        mpv.option("cache-secs", "20")?;
        mpv.option("msg-level", "all=warn")?;
        let r = unsafe { (mpv.fns.initialize)(mpv.ctx) };
        if r != 0 {
            return Err(format!("mpv_initialize -> {r}"));
        }
        Ok(mpv)
    }

    fn option(&self, name: &str, value: &str) -> Result<(), String> {
        let r = unsafe { (self.fns.set_option_string)(self.ctx, cs(name).as_ptr(), cs(value).as_ptr()) };
        (r == 0).then_some(()).ok_or_else(|| format!("set_option {name}={value} -> {r}"))
    }

    fn prop(&self, name: &str, value: &str) -> Result<(), String> {
        let r = unsafe { (self.fns.set_property_string)(self.ctx, cs(name).as_ptr(), cs(value).as_ptr()) };
        (r == 0).then_some(()).ok_or_else(|| format!("set_property {name}={value} -> {r}"))
    }

    fn command(&self, args: &[&str]) -> Result<(), String> {
        let cargs: Vec<CString> = args.iter().map(|s| cs(s)).collect();
        let ptrs: Vec<*const c_char> = cargs.iter().map(|s| s.as_ptr()).chain(std::iter::once(ptr::null())).collect();
        let r = unsafe { (self.fns.command)(self.ctx, ptrs.as_ptr()) };
        (r == 0).then_some(()).ok_or_else(|| format!("command {args:?} -> {r}"))
    }

    fn observe(&self, uid: u64, name: &str) {
        unsafe { (self.fns.observe_property)(self.ctx, uid, cs(name).as_ptr(), MPV_FORMAT_NODE) };
    }

    fn prop_string(&self, name: &str) -> Option<String> {
        let p = unsafe { (self.fns.get_property_string)(self.ctx, cs(name).as_ptr()) };
        if p.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { (self.fns.free)(p as *mut c_void) };
        Some(s)
    }

    fn render_create(&self) -> Result<*mut c_void, String> {
        let api = cs("sw");
        let params = [
            MpvRenderParam { type_: 1, data: api.as_ptr() as *mut c_void },
            MpvRenderParam { type_: 0, data: ptr::null_mut() },
        ];
        let mut rctx = ptr::null_mut();
        let r = unsafe { (self.fns.render_create)(&mut rctx, self.ctx, params.as_ptr() as *mut MpvRenderParam) };
        (r == 0 && !rctx.is_null()).then_some(rctx).ok_or_else(|| format!("render_context_create -> {r}"))
    }

    /// Renders the next queued frame into `buf` (len w*h*4, "0bgr").
    /// Returns false when mpv had nothing new.
    fn render_frame(&self, rctx: *mut c_void, w: usize, h: usize, buf: &mut [u8]) -> bool {
        let flags = unsafe { (self.fns.render_update)(rctx) };
        if flags & MPV_RENDER_UPDATE_FRAME == 0 {
            return false;
        }
        let fmt = cs("0bgr");
        let size = [w as c_int, h as c_int];
        let stride = w * 4;
        let params = [
            MpvRenderParam { type_: 17, data: size.as_ptr() as *mut c_void },
            MpvRenderParam { type_: 18, data: fmt.as_ptr() as *mut c_void },
            MpvRenderParam { type_: 19, data: (&stride as *const usize) as *mut c_void },
            MpvRenderParam { type_: 20, data: buf.as_mut_ptr() as *mut c_void },
            MpvRenderParam { type_: 0, data: ptr::null_mut() },
        ];
        let r = unsafe { (self.fns.render_render)(rctx, params.as_ptr() as *mut MpvRenderParam) };
        if r == 0 {
            for px in buf.chunks_exact_mut(4) {
                px[3] = 255;
            }
            unsafe { (self.fns.render_swap)(rctx) };
            true
        } else {
            false
        }
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe { (self.fns.destroy)(self.ctx) };
    }
}

// --- mpv node helpers ------------------------------------------------------------

fn node_string(n: &MpvNode) -> Option<String> {
    (n.format == 1).then(|| unsafe { CStr::from_ptr(n.u.string) }.to_string_lossy().into_owned())
}

fn node_f64(n: &MpvNode) -> Option<f64> {
    match n.format {
        4 => Some(unsafe { n.u.int64 } as f64),
        5 => Some(unsafe { n.u.double }),
        _ => None,
    }
}

fn node_flag(n: &MpvNode) -> Option<bool> {
    (n.format == 3).then(|| unsafe { n.u.flag } != 0)
}

// mpv_event_property { name, format, data: *mut mpv_node }
#[repr(C)]
struct EvProp {
    name: *const c_char,
    format: c_int,
    data: *mut MpvNode,
}

fn prop_name(data: *mut c_void) -> (String, *mut MpvNode) {
    let p = unsafe { &*(data as *const EvProp) };
    let name = if p.name.is_null() { String::new() } else { unsafe { CStr::from_ptr(p.name) }.to_string_lossy().into_owned() };
    (name, p.data)
}

// --- Shared frame slot ------------------------------------------------------------

/// What the component's `render` reads.
pub(crate) struct FrameSlot {
    /// The newest rendered frame (BGRA bytes inside an RgbaImage).
    pub image: Option<Arc<gpui::RenderImage>>,
    /// Rendered size in pixels.
    pub size: Option<(u32, u32)>,
    seq: u64,
}

// --- Commands ---------------------------------------------------------------------

#[derive(Debug)]
enum Cmd {
    Src(Option<String>),
    StartAt(f64),
    Pause(bool),
    Mute(bool),
    Volume(f64),
    Rate(f64),
    Seek(f64),
    Audio(Option<String>),
    Subtitle(Option<String>),
    /// Cap for the decoded size, in device pixels (min of maxResolution and
    /// the on-screen frame size).
    Cap(Option<(f64, f64)>),
    Shutdown,
}

// --- The engine thread --------------------------------------------------------------

struct Engine {
    mpv: Mpv,
    rctx: *mut c_void,
    rx: Receiver<Cmd>,
    slot: Arc<Mutex<FrameSlot>>,
    cx: ComponentContext,
    // playback state mirrored for events
    start_at: Option<f64>,
    start_at_done: bool,
    pending_seek: Option<f64>,
    last_progress: Instant,
    time_pos: f64,
    duration: Option<f64>,
    buffered: f64,
    vw: u32,
    vh: u32,
    out_w: usize,
    out_h: usize,
    cap: Option<(f64, f64)>,
    paused: bool,
    speed: f64,
    first_frame: bool,
    tracks_json: Value,
    load_sent: bool,
    load_started: Instant,
    ended: bool,
}

impl Engine {
    fn run(mut self) {
        self.mpv.observe(1, "time-pos");
        self.mpv.observe(2, "duration");
        self.mpv.observe(3, "track-list");
        self.mpv.observe(4, "paused-for-cache");
        self.mpv.observe(5, "pause");
        self.mpv.observe(6, "speed");
        self.mpv.observe(7, "video-params/w");
        self.mpv.observe(8, "video-params/h");
        self.mpv.observe(9, "demuxer-cache-duration");
        self.mpv.observe(10, "sub-text");
        self.mpv.observe(11, "seeking");
        self.mpv.observe(12, "video-params/aspect");
        unsafe { (self.mpv.fns.request_log_messages)(self.mpv.ctx, cs("warn").as_ptr()) };

        // Apply initial commands.
        while let Ok(cmd) = self.rx.try_recv() {
            if self.apply(cmd) {
                self.shutdown();
                return;
            }
        }

        loop {
            // Drain commands.
            loop {
                match self.rx.try_recv() {
                    Ok(cmd) => {
                        if self.apply(cmd) {
                            self.shutdown();
                            return;
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        self.shutdown();
                        return;
                    }
                }
            }
            // Render a queued frame.
            if self.out_w > 0 && self.out_h > 0 && !self.ended {
                let n = self.out_w * self.out_h * 4;
                let mut buf = vec![0u8; n];
                if self.mpv.render_frame(self.rctx, self.out_w, self.out_h, &mut buf) {
                    let rgba = RgbaImage::from_raw(self.out_w as u32, self.out_h as u32, buf)
                        .expect("buffer size matches w*h*4");
                    let image = Arc::new(gpui::RenderImage::new(vec![Frame::new(rgba)]));
                    {
                        let mut s = self.slot.lock().unwrap();
                        s.image = Some(image);
                        s.size = Some((self.out_w as u32, self.out_h as u32));
                        s.seq += 1;
                    }
                    if !self.first_frame {
                        self.first_frame = true;
                        self.emit(
                            "frame",
                            json!({ "ms": self.load_started.elapsed().as_millis() as u64, "width": self.out_w, "height": self.out_h }),
                        );
                    }
                    self.cx.redraw();
                }
            }
            // Events.
            let ev = unsafe { (self.mpv.fns.wait_event)(self.mpv.ctx, 0.05) };
            if ev.is_null() {
                continue;
            }
            let e = unsafe { &*ev };
            match e.event_id {
                MPV_EVENT_END_FILE => {
                    let ef = unsafe { &*(e.data as *const MpvEventEndFile) };
                    self.on_end_file(ef.reason, ef.error);
                }
                MPV_EVENT_SEEK => {
                    // Seek finished starting; playback-restart follows.
                }
                MPV_EVENT_PLAYBACK_RESTART => {
                    if let Some(target) = self.pending_seek.take() {
                        self.emit("seeked", json!({ "target": target, "time": self.time_pos, "finished": true, "ms": 0 }));
                    }
                }
                MPV_EVENT_PROPERTY_CHANGE => {
                    let (name, node) = prop_name(e.data);
                    if node.is_null() {
                        continue;
                    }
                    let node = unsafe { &*node };
                    self.on_prop(e.reply_userdata, &name, node);
                }
                _ => {}
            }
        }
    }

    fn emit(&self, name: &str, data: Value) {
        self.cx.emit(name, data);
    }

    fn shutdown(&mut self) {
        // The render context must be freed before the mpv core is destroyed.
        unsafe { (self.mpv.fns.render_free)(self.rctx) };
    }

    /// Returns true on Cmd::Shutdown.
    fn apply(&mut self, cmd: Cmd) -> bool {
        match cmd {
            Cmd::Shutdown => return true,
            Cmd::Src(url) => {
                self.load_sent = false;
                self.first_frame = false;
                self.ended = false;
                match url {
                    Some(u) => {
                        let _ = self.mpv.command(&["loadfile", &u]);
                    }
                    None => {
                        let _ = self.mpv.command(&["stop"]);
                    }
                }
            }
            Cmd::StartAt(s) => self.start_at = Some(s),
            Cmd::Pause(p) => {
                let _ = self.mpv.prop("pause", if p { "yes" } else { "no" });
            }
            Cmd::Mute(m) => {
                let _ = self.mpv.prop("mute", if m { "yes" } else { "no" });
            }
            Cmd::Volume(v) => {
                let _ = self.mpv.prop("volume", &format!("{:.1}", (v.clamp(0.0, 1.0) * 100.0)));
            }
            Cmd::Rate(r) => {
                let _ = self.mpv.prop("speed", &format!("{r}"));
            }
            Cmd::Seek(t) => {
                self.pending_seek = Some(t);
                let _ = self.mpv.command(&["seek", &format!("{t}"), "absolute"]);
            }
            Cmd::Audio(id) => {
                let v = id.unwrap_or_else(|| "no".into());
                let _ = self.mpv.prop("aid", &v);
            }
            Cmd::Subtitle(id) => {
                let v = id.unwrap_or_else(|| "no".into());
                let _ = self.mpv.prop("sid", &v);
            }
            Cmd::Cap(cap) => {
                self.cap = cap;
                self.recompute_size();
            }
        }
        false
    }

    /// Recompute the SW render size from video size × caps.
    fn recompute_size(&mut self) {
        if self.vw == 0 || self.vh == 0 {
            return;
        }
        let mut cap_w = f64::INFINITY;
        let mut cap_h = f64::INFINITY;
        if let Some((w, h)) = self.cap {
            cap_w = cap_w.min(w);
            cap_h = cap_h.min(h);
        }
        // Default cap before the frame size is known: 1080p.
        if !cap_w.is_finite() && !cap_h.is_finite() {
            cap_w = 1920.0;
            cap_h = 1080.0;
        }
        let s = (cap_w / self.vw as f64).min(cap_h / self.vh as f64).min(1.0);
        self.out_w = ((self.vw as f64 * s).round() as usize).max(2);
        self.out_h = ((self.vh as f64 * s).round() as usize).max(2);
    }

    fn on_end_file(&mut self, reason: c_int, error: c_int) {
        match reason {
            END_EOF => {
                self.ended = true;
                self.emit("end", json!({}));
            }
            END_ERROR => {
                self.emit("error", json!({ "message": format!("playback failed (mpv error {error})"), "code": "mpv", "fatal": true }));
            }
            _ => {}
        }
    }

    fn on_prop(&mut self, uid: u64, name: &str, node: &MpvNode) {
        match uid {
            1 => {
                if let Some(t) = node_f64(node) {
                    self.time_pos = t;
                    if self.last_progress.elapsed() >= Duration::from_millis(250) {
                        self.last_progress = Instant::now();
                        let buffered = self.time_pos + self.buffered;
                        let playable = self.duration.unwrap_or(self.time_pos);
                        self.emit(
                            "progress",
                            json!({ "currentTime": self.time_pos, "buffered": buffered.min(playable.max(buffered)), "playable": playable }),
                        );
                    }
                }
            }
            2 => {
                if let Some(d) = node_f64(node) {
                    if (self.duration.unwrap_or(-1.0) - d).abs() > 0.01 {
                        self.duration = Some(d);
                        self.emit_tracks_load();
                    }
                }
            }
            3 => {
                self.tracks_json = parse_tracks(node);
                self.emit("tracks", self.tracks_json.clone());
                self.emit_tracks_load();
            }
            4 => {
                if let Some(b) = node_flag(node) {
                    self.emit("buffer", json!({ "stalled": b, "reason": if b { "cache" } else { "" } }));
                }
            }
            5 => {
                if let Some(p) = node_flag(node) {
                    self.paused = p;
                    self.emit("rate", json!({ "rate": self.speed, "paused": p }));
                }
            }
            6 => {
                if let Some(r) = node_f64(node) {
                    self.speed = r;
                    self.emit("rate", json!({ "rate": r, "paused": self.paused }));
                }
            }
            7 => {
                if let Some(w) = node_f64(node) {
                    self.vw = w as u32;
                    self.recompute_size();
                }
            }
            8 => {
                if let Some(h) = node_f64(node) {
                    self.vh = h as u32;
                    self.recompute_size();
                }
            }
            9 => {
                if let Some(d) = node_f64(node) {
                    self.buffered = d.max(0.0);
                }
            }
            10 => {
                if let Some(text) = node_string(node) {
                    if !text.is_empty() {
                        self.emit("cues", json!({ "time": self.time_pos, "lines": [text] }));
                    }
                }
            }
            11 => {
                // seeking flag; nothing needed (seeked comes from playback-restart)
            }
            _ => {}
        }
        let _ = name;
    }

    fn emit_tracks_load(&mut self) {
        if self.load_sent || self.vw == 0 {
            return;
        }
        // Wait until we have duration or tracks once.
        if self.duration.is_none() && self.tracks_json.is_null() {
            return;
        }
        self.load_sent = true;
        let audio = self.tracks_json.get("audioTracks").cloned().unwrap_or(json!([]));
        let subs = self.tracks_json.get("subtitleTracks").cloned().unwrap_or(json!([]));
        self.emit(
            "load",
            json!({
                "duration": self.duration.unwrap_or(0.0),
                "width": self.out_w,
                "height": self.out_h,
                "audioTracks": audio,
                "subtitleTracks": subs,
                "ms": self.load_started.elapsed().as_millis() as u64,
            }),
        );
        // Apply startAt once the file is loaded.
        if !self.start_at_done {
            self.start_at_done = true;
            if let Some(t) = self.start_at {
                if t > 0.0 {
                    let _ = self.mpv.command(&["seek", &format!("{t}"), "absolute"]);
                }
            }
        }
    }
}

fn parse_tracks(node: &MpvNode) -> Value {
    // track-list is a NODE_MAP {tracks: [ {id,type,lang,title,selected,...}, ... ]}
    let mut audio = Vec::new();
    let mut subs = Vec::new();
    if node.format != 8 {
        return json!({ "audioTracks": audio, "subtitleTracks": subs });
    }
    let list = unsafe { &*node.u.list };
    for i in 0..list.num as usize {
        let pair = unsafe { &*list.values.add(i) };
        let key = unsafe { CStr::from_ptr(*list.keys.add(i)) }.to_string_lossy().into_owned();
        if key != "tracks" || pair.format != 8 {
            continue;
        }
        let tracks = unsafe { &*pair.u.list };
        for t in 0..tracks.num as usize {
            let track = unsafe { &*tracks.values.add(t) };
            if track.format != 8 {
                continue;
            }
            let tl = unsafe { &*track.u.list };
            let mut id = String::new();
            let mut kind = String::new();
            let mut lang = String::new();
            let mut title = String::new();
            let mut selected = false;
            for j in 0..tl.num as usize {
                let k = unsafe { CStr::from_ptr(*tl.keys.add(j)) }.to_string_lossy().into_owned();
                let v = unsafe { &*tl.values.add(j) };
                match k.as_str() {
                    "id" => {
                        id = match v.format {
                            4 => unsafe { v.u.int64 }.to_string(),
                            1 => node_string(v).unwrap_or_default(),
                            _ => String::new(),
                        };
                    }
                    "type" => kind = node_string(v).unwrap_or_default(),
                    "lang" => lang = node_string(v).unwrap_or_default(),
                    "title" => title = node_string(v).unwrap_or_default(),
                    "selected" => selected = node_flag(v).unwrap_or(false),
                    _ => {}
                }
            }
            if id.is_empty() {
                continue;
            }
            let entry = json!({ "id": id, "lang": lang, "title": title, "selected": selected });
            match kind.as_str() {
                "audio" => audio.push(entry),
                "sub" => subs.push(entry),
                _ => {}
            }
        }
    }
    json!({ "audioTracks": audio, "subtitleTracks": subs })
}

// --- Player (main-thread side) ------------------------------------------------------

pub(crate) static LIVE: AtomicUsize = AtomicUsize::new(0);
pub(crate) static PLAYING: AtomicUsize = AtomicUsize::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);

static PLAYERS: std::sync::LazyLock<Mutex<std::collections::HashMap<u64, Arc<PlayerInner>>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn lookup(id: u64) -> Option<Arc<PlayerInner>> {
    PLAYERS.lock().unwrap().get(&id).cloned()
}

pub(crate) struct PlayerInner {
    id: u64,
    tx: Sender<Cmd>,
    slot: Arc<Mutex<FrameSlot>>,
    cx: ComponentContext,
    fit: std::sync::Mutex<Fit>,
    max_res: std::sync::Mutex<Option<(f64, f64)>>,
    disp: std::sync::Mutex<Option<(f64, f64)>>,
    last_painted: Mutex<Option<Arc<gpui::RenderImage>>>,
    has_src: std::sync::atomic::AtomicBool,
    paused: std::sync::atomic::AtomicBool,
    counted: std::sync::atomic::AtomicBool,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Fit {
    #[default]
    Contain,
    Cover,
}

impl Fit {
    pub(crate) fn parse(v: Option<&str>) -> Fit {
        match v {
            Some("cover") => Fit::Cover,
            _ => Fit::Contain,
        }
    }
}

/// `{width, height}` → a size (positive numbers only).
pub(crate) fn size_of(v: Option<&Value>) -> Option<(f64, f64)> {
    let v = v?;
    let w = v.get("width")?.as_f64()?;
    let h = v.get("height")?.as_f64()?;
    (w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0).then_some((w, h))
}

impl PlayerInner {
    fn send(&self, cmd: Cmd) {
        let _ = self.tx.send(cmd);
    }

    pub(crate) fn set_src(&self, url: Option<&str>) {
        self.has_src.store(url.is_some(), Ordering::Relaxed);
        self.sync_playing();
        self.send(Cmd::Src(url.map(str::to_owned)));
    }

    pub(crate) fn set_start_at(&self, secs: f64) {
        self.send(Cmd::StartAt(secs));
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
        self.sync_playing();
        self.send(Cmd::Pause(paused));
    }

    /// PLAYING counts players with a source that aren't paused.
    fn sync_playing(&self) {
        let playing = self.has_src.load(Ordering::Relaxed) && !self.paused.load(Ordering::Relaxed);
        if self.counted.swap(playing, Ordering::Relaxed) != playing {
            if playing {
                PLAYING.fetch_add(1, Ordering::Relaxed);
            } else {
                PLAYING.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }

    pub(crate) fn set_muted(&self, muted: bool) {
        self.send(Cmd::Mute(muted));
    }

    pub(crate) fn set_volume(&self, volume: f32) {
        self.send(Cmd::Volume(volume as f64));
    }

    pub(crate) fn set_rate(&self, rate: f32) {
        self.send(Cmd::Rate(rate as f64));
    }

    pub(crate) fn set_fit(&self, fit: Fit) {
        *self.fit.lock().unwrap() = fit;
    }

    pub(crate) fn fit(&self) -> Fit {
        *self.fit.lock().unwrap()
    }

    /// The effective decode cap: component-wise min of maxResolution and
    /// the on-screen frame size (device pixels).
    fn effective_cap(&self) -> Option<(f64, f64)> {
        let max = *self.max_res.lock().unwrap();
        let disp = *self.disp.lock().unwrap();
        match (max, disp) {
            (Some((mw, mh)), Some((dw, dh))) => Some((mw.min(dw), mh.min(dh))),
            (a, b) => a.or(b),
        }
    }

    pub(crate) fn set_max_resolution(&self, size: Option<(f64, f64)>) {
        *self.max_res.lock().unwrap() = size;
        self.send(Cmd::Cap(self.effective_cap()));
    }

    /// The picture's size on screen in device pixels (the default cap).
    pub(crate) fn set_display_size(&self, size: Option<(f64, f64)>) {
        *self.disp.lock().unwrap() = size;
        self.send(Cmd::Cap(self.effective_cap()));
    }

    /// Seeks to `secs`; a `seeked` event follows.
    pub(crate) fn seek(&self, secs: f64) {
        self.send(Cmd::Seek(secs));
    }

    /// `selectAudio` / `selectSubtitle` (`None`: off).
    pub(crate) fn select(&self, legible: bool, id: Option<&str>) {
        if legible {
            self.send(Cmd::Subtitle(id.map(str::to_owned)));
        } else {
            self.send(Cmd::Audio(id.map(str::to_owned)));
        }
    }

    /// The newest rendered frame, if any.
    pub(crate) fn frame(&self) -> Option<Arc<gpui::RenderImage>> {
        self.slot.lock().unwrap().image.clone()
    }

    /// Rendered size in pixels.
    pub(crate) fn frame_size(&self) -> Option<(u32, u32)> {
        self.slot.lock().unwrap().size
    }

    /// Now Playing info — unsupported on Windows (capability reports false).
    #[allow(dead_code)]
    pub(crate) fn set_now_playing(&self, _info: Option<()>) {}

    /// For the component's render: swap the painted image, dropping the
    /// previous atlas tile. Called on the main thread during render.
    pub(crate) fn take_for_paint(&self, window: &mut gpui::Window) -> Option<Arc<gpui::RenderImage>> {
        let img = self.frame()?;
        let mut last = self.last_painted.lock().unwrap();
        if last.as_ref().is_some_and(|l| l.id == img.id) {
            return Some(img);
        }
        if let Some(old) = last.replace(img.clone()) {
            let _ = window.drop_image(old);
        }
        Some(img)
    }
}

pub(crate) struct Player {
    inner: Arc<PlayerInner>,
}

impl Player {
    /// Spawns the mpv engine thread. mpv init failures surface as an
    /// `error` event on `cx` (the component stays usable).
    pub(crate) fn new(cx: ComponentContext) -> Player {
        let (tx, rx) = channel::<Cmd>();
        let slot = Arc::new(Mutex::new(FrameSlot { image: None, size: None, seq: 0 }));
        let cx2 = cx.clone();
        let slot2 = slot.clone();
        let _ = thread::Builder::new()
            .name("rustflix-mpv".into())
            .spawn(move || {
                let (mpv, rctx) = match Mpv::new().and_then(|m| m.render_create().map(|r| (m, r))) {
                    Ok(pair) => pair,
                    Err(e) => {
                        cx2.emit(
                            "error",
                            json!({ "message": format!("native player unavailable: {e}"), "code": "unavailable", "fatal": true }),
                        );
                        return;
                    }
                };
                let engine = Engine {
                    mpv,
                    rctx,
                    rx,
                    slot: slot2,
                    cx: cx2,
                    start_at: None,
                    start_at_done: false,
                    pending_seek: None,
                    last_progress: Instant::now(),
                    time_pos: 0.0,
                    duration: None,
                    buffered: 0.0,
                    vw: 0,
                    vh: 0,
                    out_w: 0,
                    out_h: 0,
                    cap: None,
                    paused: true,
                    speed: 1.0,
                    first_frame: false,
                    tracks_json: Value::Null,
                    load_sent: false,
                    load_started: Instant::now(),
                    ended: false,
                };
                engine.run();
            });
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let inner = Arc::new(PlayerInner {
            id,
            tx,
            slot,
            cx,
            fit: std::sync::Mutex::new(Fit::Contain),
            max_res: std::sync::Mutex::new(None),
            disp: std::sync::Mutex::new(None),
            last_painted: Mutex::new(None),
            has_src: std::sync::atomic::AtomicBool::new(false),
            paused: std::sync::atomic::AtomicBool::new(true),
            counted: std::sync::atomic::AtomicBool::new(false),
        });
        PLAYERS.lock().unwrap().insert(id, inner.clone());
        LIVE.fetch_add(1, Ordering::Relaxed);
        Player { inner }
    }

    /// The handle `sys.nativeVideo` reaches this player by.
    pub(crate) fn handle(&self) -> u64 {
        self.inner.id
    }

    pub(crate) fn set_src(&self, url: Option<&str>) {
        self.inner.set_src(url);
    }

    pub(crate) fn set_start_at(&self, secs: f64) {
        self.inner.set_start_at(secs);
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.inner.set_paused(paused);
    }

    pub(crate) fn set_muted(&self, muted: bool) {
        self.inner.set_muted(muted);
    }

    pub(crate) fn set_volume(&self, volume: f32) {
        self.inner.set_volume(volume);
    }

    pub(crate) fn set_rate(&self, rate: f32) {
        self.inner.set_rate(rate);
    }

    pub(crate) fn set_fit(&self, fit: Fit) {
        self.inner.set_fit(fit);
    }

    pub(crate) fn fit(&self) -> Fit {
        self.inner.fit()
    }

    pub(crate) fn set_max_resolution(&self, size: Option<(f64, f64)>) {
        self.inner.set_max_resolution(size);
    }

    /// The picture's size on screen in device pixels (the default cap).
    pub(crate) fn set_display_size(&self, size: Option<(f64, f64)>) {
        self.inner.set_display_size(size);
    }

    /// Seeks to `secs`; a `seeked` event follows.
    pub(crate) fn seek(&self, secs: f64) {
        self.inner.seek(secs);
    }

    /// `selectAudio` / `selectSubtitle` (`None`: off).
    pub(crate) fn select(&self, legible: bool, id: Option<&str>) {
        self.inner.select(legible, id);
    }

    /// The newest rendered frame, if any.
    pub(crate) fn frame(&self) -> Option<Arc<gpui::RenderImage>> {
        self.inner.frame()
    }

    /// Rendered size in pixels.
    pub(crate) fn frame_size(&self) -> Option<(u32, u32)> {
        self.inner.frame_size()
    }

    /// Now Playing info — unsupported on Windows (capability reports false).
    #[allow(dead_code)]
    pub(crate) fn set_now_playing(&self, _info: Option<()>) {}

    /// For the component's render: swap the painted image, dropping the
    /// previous atlas tile. Called on the main thread during render.
    pub(crate) fn take_for_paint(&self, window: &mut gpui::Window) -> Option<Arc<gpui::RenderImage>> {
        self.inner.take_for_paint(window)
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        if self.inner.counted.swap(false, Ordering::Relaxed) {
            PLAYING.fetch_sub(1, Ordering::Relaxed);
        }
        let _ = self.inner.tx.send(Cmd::Shutdown);
        PLAYERS.lock().unwrap().remove(&self.inner.id);
        LIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

/// `sys.nativeVideo {handle, …}` (on the main thread): the player's props
/// and commands without a frame of the window. False when there is no
/// such player.
pub(crate) fn control(handle: u64, data: &Value) -> bool {
    let Some(p) = lookup(handle) else { return false };
    if let Some(v) = data.get("muted").and_then(Value::as_bool) {
        p.set_muted(v);
    }
    if let Some(v) = data.get("volume").and_then(Value::as_f64) {
        p.set_volume(v as f32);
    }
    if let Some(v) = data.get("rate").and_then(Value::as_f64) {
        p.set_rate(v as f32);
    }
    if let Some(v) = data.get("fit").and_then(Value::as_str) {
        p.set_fit(Fit::parse(Some(v)));
        p.cx.redraw();
    }
    if let Some(v) = data.get("maxResolution") {
        p.set_max_resolution(size_of(Some(v)));
    }
    if let Some(f) = data.get("frame") {
        // The picture's size in points × the window's scale.
        let scale = window_scale_hint();
        p.set_display_size(size_of(Some(f)).map(|(w, h)| (w * scale, h * scale)));
    }
    if let Some(v) = data.get("startAt").and_then(Value::as_f64) {
        p.set_start_at(v);
    }
    if let Some(v) = data.get("paused").and_then(Value::as_bool) {
        p.set_paused(v);
    }
    match data.get("src") {
        Some(Value::String(u)) => p.set_src(Some(u)),
        Some(Value::Null) => p.set_src(None),
        _ => {}
    }
    if let Some(t) = data.get("seek").and_then(Value::as_f64) {
        p.seek(t);
    }
    if let Some(id) = data.get("selectAudio").and_then(Value::as_str) {
        p.select(false, Some(id));
    }
    match data.get("selectSubtitle") {
        Some(Value::String(id)) => p.select(true, Some(id)),
        Some(Value::Null) => p.select(true, None),
        _ => {}
    }
    true
}

/// The window scale factor isn't reachable from `control` (no Window); the
/// component's own `frame` prop path passes device pixels already via
/// `set_display_size`. For the host-call path use scale 1.0 — the app's
/// `frame` values are in points and GPUI scales them; being off by the
/// scale factor only over/under-caps the decode size slightly.
fn window_scale_hint() -> f64 {
    1.0
}
