//! Smoke test for the Windows native player: plays a URL through libmpv
//! (software render API -> BGRA CPU frames) and writes the first decoded
//! frame to a BMP. Proves decode+render works on this machine without the
//! app (which is blocked by the M1 upstream crash).
//!
//! Needs `libmpv-2.dll` at C:\tools\mpv\ (mpv-dev package, SourceForge
//! mpv-player-windows/libmpv). Run: `cargo run --example mpv-smoke -- <url>`
//! default url: the public HLS test stream.

#![cfg(target_os = "windows")]

use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::ptr;
use std::time::{Duration, Instant};

// ---- Win32 loader -------------------------------------------------------

type HModule = *mut c_void;
type FnAddr = *const ();

unsafe extern "system" {
    fn LoadLibraryW(name: *const u16) -> HModule;
    fn GetProcAddress(module: HModule, name: *const c_char) -> FnAddr;
    fn FreeLibrary(module: HModule) -> c_int;
}

struct Lib {
    module: HModule,
}

impl Lib {
    unsafe fn load(path: &str) -> Lib {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let m = unsafe { LoadLibraryW(wide.as_ptr()) };
        assert!(!m.is_null(), "LoadLibraryW({path}) failed");
        Lib { module: m }
    }
    unsafe fn sym<T>(&self, name: &str) -> T {
        let n = CString::new(name).unwrap();
        let f = unsafe { GetProcAddress(self.module, n.as_ptr()) };
        assert!(!f.is_null(), "missing export {name}");
        unsafe { std::mem::transmute_copy(&f) }
    }
}

impl Drop for Lib {
    fn drop(&mut self) {
        unsafe { FreeLibrary(self.module) };
    }
}

// ---- libmpv FFI ---------------------------------------------------------

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
    format: c_int, // mpv_format; STRING=1 INT64=4 DOUBLE=5 NODE_ARRAY=7 NODE_MAP=8
}

#[repr(C)]
struct MpvNodeList {
    num: c_int,
    values: *mut MpvNode,
    keys: *mut *mut c_char,
    _pad: *mut c_void,
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

struct Mpv {
    ctx: *mut c_void,
    _lib: Lib,
    // fn pointers (kept so signatures stay checked at compile time)
    #[allow(dead_code)]
    fns: Fns,
}

struct Fns {
    mpv_create: unsafe extern "C" fn() -> *mut c_void,
    mpv_initialize: unsafe extern "C" fn(*mut c_void) -> c_int,
    mpv_destroy: unsafe extern "C" fn(*mut c_void),
    mpv_set_option_string: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    mpv_command: unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int,
    mpv_wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent,
    mpv_free: unsafe extern "C" fn(*mut c_void),
    mpv_get_property_string: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char,
    mpv_observe_property: unsafe extern "C" fn(*mut c_void, u64, *const c_char, c_int) -> c_int,
    mpv_request_log_messages: unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int,
    mpv_render_context_create: unsafe extern "C" fn(*mut *mut c_void, *mut c_void, *mut MpvRenderParam) -> c_int,
    mpv_render_context_render: unsafe extern "C" fn(*mut c_void, *mut MpvRenderParam) -> c_int,
    mpv_render_context_update: unsafe extern "C" fn(*mut c_void) -> u64,
    mpv_render_context_free: unsafe extern "C" fn(*mut c_void),
    mpv_render_context_report_swap: unsafe extern "C" fn(*mut c_void),
}

const MPV_FORMAT_NODE: c_int = 6;
const MPV_EVENT_END_FILE: c_int = 7;
const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;
const MPV_RENDER_UPDATE_FRAME: u64 = 1;

fn c(s: &str) -> CString {
    CString::new(s).unwrap()
}

impl Mpv {
    fn new() -> Mpv {
        let lib = unsafe { Lib::load(r"C:\tools\mpv\libmpv-2.dll") };
        let fns = Fns {
            mpv_create: unsafe { lib.sym("mpv_create") },
            mpv_initialize: unsafe { lib.sym("mpv_initialize") },
            mpv_destroy: unsafe { lib.sym("mpv_destroy") },
            mpv_set_option_string: unsafe { lib.sym("mpv_set_option_string") },
            mpv_command: unsafe { lib.sym("mpv_command") },
            mpv_wait_event: unsafe { lib.sym("mpv_wait_event") },
            mpv_free: unsafe { lib.sym("mpv_free") },
            mpv_get_property_string: unsafe { lib.sym("mpv_get_property_string") },
            mpv_observe_property: unsafe { lib.sym("mpv_observe_property") },
            mpv_request_log_messages: unsafe { lib.sym("mpv_request_log_messages") },
            mpv_render_context_create: unsafe { lib.sym("mpv_render_context_create") },
            mpv_render_context_render: unsafe { lib.sym("mpv_render_context_render") },
            mpv_render_context_update: unsafe { lib.sym("mpv_render_context_update") },
            mpv_render_context_free: unsafe { lib.sym("mpv_render_context_free") },
            mpv_render_context_report_swap: unsafe { lib.sym("mpv_render_context_report_swap") },
        };
        let ctx = unsafe { (fns.mpv_create)() };
        assert!(!ctx.is_null());
        Mpv { ctx, _lib: lib, fns }
    }

    fn option(&self, name: &str, value: &str) {
        let r = unsafe { (self.fns.mpv_set_option_string)(self.ctx, c(name).as_ptr(), c(value).as_ptr()) };
        assert_eq!(r, 0, "set_option {name}={value} -> {r}");
    }

    fn command(&self, args: &[&str]) {
        let cs: Vec<CString> = args.iter().map(|s| c(s)).collect();
        let ptrs: Vec<*const c_char> = cs.iter().map(|s| s.as_ptr()).chain(std::iter::once(ptr::null())).collect();
        let r = unsafe { (self.fns.mpv_command)(self.ctx, ptrs.as_ptr()) };
        assert_eq!(r, 0, "command {args:?} -> {r}");
    }

    fn prop_string(&self, name: &str) -> Option<String> {
        let p = unsafe { (self.fns.mpv_get_property_string)(self.ctx, c(name).as_ptr()) };
        if p.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { (self.fns.mpv_free)(p as *mut c_void) };
        Some(s)
    }

    fn observe(&self, uid: u64, name: &str) {
        let r = unsafe { (self.fns.mpv_observe_property)(self.ctx, uid, c(name).as_ptr(), MPV_FORMAT_NODE) };
        assert_eq!(r, 0, "observe {name} -> {r}");
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe { (self.fns.mpv_destroy)(self.ctx) };
    }
}

fn node_str(n: &MpvNode) -> Option<String> {
    if n.format == 1 {
        unsafe { CStr::from_ptr(n.u.string) }.to_string_lossy().into_owned().into()
    } else {
        None
    }
}

fn node_f64(n: &MpvNode) -> Option<f64> {
    match n.format {
        4 => Some(unsafe { n.u.int64 } as f64),
        5 => Some(unsafe { n.u.double }),
        _ => None,
    }
}

fn dump_track_list(data: *mut c_void, mpv: &Mpv) {
    if data.is_null() {
        return;
    }
    let node = unsafe { &*(data as *const MpvNode) };
    if node.format != 8 {
        return;
    }
    let list = unsafe { &*node.u.list };
    for i in 0..list.num as usize {
        let pair = unsafe { &*list.values.add(i) };
        let key = unsafe { CStr::from_ptr(*list.keys.add(i)) }.to_string_lossy().into_owned();
        if key != "tracks" {
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
                    "id" => id = node_str(v).unwrap_or_default(),
                    "type" => kind = node_str(v).unwrap_or_default(),
                    "lang" => lang = node_str(v).unwrap_or_default(),
                    "title" => title = node_str(v).unwrap_or_default(),
                    "selected" => selected = v.format == 3 && unsafe { v.u.flag } != 0,
                    _ => {}
                }
            }
            if !id.is_empty() {
                println!("  track id={id} type={kind} lang={lang} title={title} selected={selected}");
            }
        }
    }
    let _ = mpv;
}

fn write_bmp(path: &str, w: usize, h: usize, bgra: &[u8]) {
    // BMP stores rows bottom-up, BGRX — our "0bgr" buffer is already B,G,R,X.
    let row = w * 4;
    let img = row * h;
    let off = 54;
    let size = off + img;
    let mut f = Vec::with_capacity(size);
    f.extend_from_slice(b"BM");
    f.extend_from_slice(&(size as u32).to_le_bytes());
    f.extend_from_slice(&[0; 4]);
    f.extend_from_slice(&(off as u32).to_le_bytes());
    f.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER
    f.extend_from_slice(&(w as i32).to_le_bytes());
    f.extend_from_slice(&(h as i32).to_le_bytes()); // positive = bottom-up
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&32u16.to_le_bytes());
    f.extend_from_slice(&[0; 4]);
    f.extend_from_slice(&(img as u32).to_le_bytes());
    f.extend_from_slice(&2835i32.to_le_bytes());
    f.extend_from_slice(&2835i32.to_le_bytes());
    f.extend_from_slice(&[0; 8]);
    for y in (0..h).rev() {
        f.extend_from_slice(&bgra[y * row..(y + 1) * row]);
    }
    std::fs::write(path, &f).unwrap();
}

fn main() {
    let url = std::env::args().nth(1).unwrap_or_else(|| {
        "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8".to_string()
    });
    println!("mpv-smoke: {url}");

    let mpv = Mpv::new();
    mpv.option("config", "no");
    mpv.option("terminal", "no");
    mpv.option("idle", "yes");
    mpv.option("msg-level", if std::env::var("MPV_SMOKE_DEBUG").is_ok() { "all=v" } else { "all=warn" });
    // Render API requires vo=libmpv (mpv >=0.38 no longer auto-selects it).
    let nullvo = std::env::var("MPV_SMOKE_NULLVO").unwrap_or_default();
    if std::env::var("MPV_SMOKE_NOVO").is_err() && nullvo != "both" && nullvo != "vo" {
        mpv.option("vo", "libmpv");
    }
    match nullvo.as_str() {
        "both" => {
            mpv.option("vo", "null");
            mpv.option("ao", "null");
        }
        "ao" => mpv.option("ao", "null"),
        "vo" => mpv.option("vo", "null"),
        _ => {}
    }
    if std::env::var("MPV_SMOKE_HWDEC").is_ok() {
        mpv.option("hwdec", "no");
    }
    if let Ok(api) = std::env::var("MPV_SMOKE_GPUAPI") {
        mpv.option("gpu-api", &api);
    }
    if let Ok(ctx) = std::env::var("MPV_SMOKE_GPUCTX") {
        mpv.option("gpu-context", &ctx);
    }
    unsafe {
        (mpv.fns.mpv_request_log_messages)(mpv.ctx, c(if std::env::var("MPV_SMOKE_DEBUG").is_ok() { "v" } else { "warn" }).as_ptr())
    };
    let r = unsafe { (mpv.fns.mpv_initialize)(mpv.ctx) };
    assert_eq!(r, 0, "mpv_initialize -> {r}");
    println!("mpv initialized, version={}", mpv.prop_string("mpv-version").unwrap_or_default());

    mpv.observe(1, "time-pos");
    mpv.observe(2, "duration");
    mpv.observe(3, "track-list");
    mpv.observe(4, "paused-for-cache");

    // Render context: SW, 1280x720 "0bgr" (B,G,R,X).
    let w = 1280usize;
    let h = 720usize;
    let stride = w * 4;
    let mut pixels = vec![0u8; stride * h];
    let no_render = std::env::var("MPV_SMOKE_NORENDER").is_ok();
    let mut rctx: *mut c_void = ptr::null_mut();
    let api = c("sw");
    let create_params = [
        MpvRenderParam { type_: 1, data: api.as_ptr() as *mut c_void }, // API_TYPE
        MpvRenderParam { type_: 0, data: ptr::null_mut() },
    ];
    let rc = if no_render {
        0
    } else {
        unsafe {
            (mpv.fns.mpv_render_context_create)(&mut rctx, mpv.ctx, create_params.as_ptr() as *mut MpvRenderParam)
        }
    };
    assert_eq!(rc, 0, "render_context_create -> {rc}");
    println!("render context created (no_render={no_render})");

    mpv.command(&["loadfile", &url]);
    println!("loadfile sent");

    let start = Instant::now();
    let mut frames = 0u32;
    let mut last_pos = 0.0f64;
    let mut done = false;

    while start.elapsed() < Duration::from_secs(30) && !done {
        // render if a new frame is queued
        eprintln!("[update]");
        let flags = if no_render {
            0
        } else {
            unsafe { (mpv.fns.mpv_render_context_update)(rctx) }
        };
        eprintln!("[flags {flags}]");
        if flags & MPV_RENDER_UPDATE_FRAME != 0 {
            eprintln!("[render frame]");
            let fmt = c("0bgr");
            let size = [w as c_int, h as c_int];
            let params = [
                MpvRenderParam { type_: 17, data: size.as_ptr() as *mut c_void }, // SW_SIZE
                MpvRenderParam { type_: 18, data: fmt.as_ptr() as *mut c_void }, // SW_FORMAT
                MpvRenderParam { type_: 19, data: (&stride as *const usize) as *mut c_void }, // SW_STRIDE
                MpvRenderParam { type_: 20, data: pixels.as_mut_ptr() as *mut c_void }, // SW_POINTER
                MpvRenderParam { type_: 0, data: ptr::null_mut() },
            ];
            let rr = unsafe { (mpv.fns.mpv_render_context_render)(rctx, params.as_ptr() as *mut MpvRenderParam) };
            if rr == 0 {
                frames += 1;
                unsafe { (mpv.fns.mpv_render_context_report_swap)(rctx) };
            } else {
                println!("render -> {rr}");
            }
        }

        // pump events with a small timeout
        let ev = unsafe { (mpv.fns.mpv_wait_event)(mpv.ctx, 0.05) };
        if ev.is_null() {
            continue;
        }
        let e = unsafe { &*ev };
        eprintln!("[ev {} err={} uid={}]", e.event_id, e.error, e.reply_userdata);
        match e.event_id {
            2 => {
                #[repr(C)]
                struct EvLog {
                    prefix: *const c_char,
                    level: *const c_char,
                    text: *const c_char,
                }
                let l = unsafe { &*(e.data as *const EvLog) };
                let p = unsafe { CStr::from_ptr(l.prefix) }.to_string_lossy();
                let t = unsafe { CStr::from_ptr(l.text) }.to_string_lossy();
                eprintln!("[mpv:{p}] {t}");
            }
            MPV_EVENT_END_FILE => {
                let ef = unsafe { &*(e.data as *const MpvEventEndFile) };
                println!("END_FILE reason={} error={}", ef.reason, ef.error);
                done = true;
            }
            MPV_EVENT_PROPERTY_CHANGE => {
                // mpv_event_property: {name, format, data: void*}
                #[repr(C)]
                struct EvProp {
                    name: *const c_char,
                    format: c_int,
                    data: *mut MpvNode,
                }
                let prop = unsafe { &*(e.data as *const EvProp) };
                if prop.data.is_null() {
                    continue;
                }
                let name = unsafe { CStr::from_ptr(prop.name) }.to_string_lossy().into_owned();
                let _ = name;
                let node = unsafe { &*prop.data };
                match e.reply_userdata {
                    1 => {
                        if let Some(v) = node_f64(node) {
                            last_pos = v;
                        }
                    }
                    2 => {
                        if let Some(v) = node_f64(node) {
                            println!("duration: {v:.1}s");
                        }
                    }
                    3 => dump_track_list(prop.data as *mut c_void, &mpv),
                    4 => {
                        if node.format == 3 {
                            let buffering = unsafe { node.u.flag } != 0;
                            println!("buffering: {buffering}");
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    if frames > 0 {
        for px in pixels.chunks_exact_mut(4) {
            px[3] = 255;
        }
        write_bmp(r"C:\tools\mpv-frame.bmp", w, h, &pixels);
        println!("wrote C:\\tools\\mpv-frame.bmp (last of {frames} frames)");
    }
    println!(
        "done: {} frames rendered, last_pos={last_pos:.2}s, elapsed={:.1}s",
        frames,
        start.elapsed().as_secs_f64()
    );
    if !no_render {
        unsafe { (mpv.fns.mpv_render_context_free)(rctx) };
    }
}

#[allow(dead_code)]
fn main2() {}
