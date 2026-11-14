//! The FPS monitor, the performance recorder and the spike capture on the
//! desktop (`perf.*`, `app/lib/perf.ts`; gated by capabilities.host
//! "perf.*").
//!
//! nsh 0.4.0's GPUI backend has no on-screen monitor (`AppView::
//! set_fps_monitor` only logs one `nsh::perf fps …` line a second), so the
//! app measures itself:
//!
//! - **Frames** ([`present`], [`clock`]): every frame GPUI encodes
//!   takes a drawable with `-[CAMetalLayer nextDrawable]`; while
//!   measuring, that method is hooked: each call is a frame (whichever view
//!   was dirty), the time it blocks is the drawable *wait*, and the
//!   drawable reports its on-glass time. A frame's *cost* is the main
//!   thread's work in the wake-up that produced it, the wait excluded
//!   (run-loop observers time the wake-ups). *Late* (red): reached the
//!   glass more than 1.5 refreshes after the previous frame while frames
//!   were coming continuously. *Slow*: cost alone over one refresh.
//!   Wake-ups that drew nothing are *stretches* (a *stall* when over one
//!   refresh), never charged to a frame.
//! - **JS** (engine thread): the engine's own `nsh::perf` trace lines
//!   (`AppOptions::trace`, always on: a `log` call that returns at the
//!   first atomic test while nothing measures) — event JS time, commit
//!   time with ops and mount items, timers — and `perf.js` from the app
//!   (timer lag, labelled long tasks).
//! - **Spikes**: every late or slow frame and every stall goes to
//!   `perf-spikes.jsonl` with its cost, wait, the work before it, the
//!   engine work around it, what the app was doing (route, scenario step)
//!   and main-thread stack samples taken while it ran ([`sampler`]);
//!   `scratchpad/perf/spikes.py` groups them.
//! - **The panel** ([`hud`]): Core Animation layers over GPUI's view,
//!   updated twice a second without drawing a GPUI frame.
//!
//! The recorder writes one JSON line a second to `perf.jsonl` (rolled at
//! 2 MB) in the app's data directory while the panel shows or the recorder
//! is on; `perf.save` rotates both files to timestamped names.
//!
//! **Off** (panel and recorder off, the default): no observers, no
//! watchdog, no display link, no timers, and `nextDrawable` is GPUI's own
//! again; per engine commit/event the trace's `log` call tests one atomic.

mod clock;
mod hud;
#[cfg(target_os = "macos")]
mod present;
#[cfg(not(target_os = "macos"))]
mod present {
    pub(crate) fn take_presented() -> Vec<(u64, f64)> {
        Vec::new()
    }
    pub(crate) fn has_present_times() -> bool {
        false
    }
}
mod sampler;

use std::{
    cell::{Cell, RefCell},
    io::Write,
    path::PathBuf,
    rc::Rc,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use clock::{FrameWork, Presents, Ring, Stretch, WorkClock};
use nsh_engine::{HostCall, HostChannel, JsonValue};
use nsh_platform_gpui::{
    App as NshApp, AppOptions, AppSource, AppView,
    gpui::{
        self, AppContext as _, Context, Entity, Focusable as _, IntoElement, ParentElement as _,
        Render, Styled as _, Task, Window, div, px,
    },
};
use serde_json::json;

/// The panel shows.
static HUD: AtomicBool = AtomicBool::new(false);
/// The recorder writes.
static RECORD: AtomicBool = AtomicBool::new(false);

fn measuring() -> bool {
    HUD.load(Ordering::Relaxed) || RECORD.load(Ordering::Relaxed)
}

/// What the main thread is asked (engine thread → [`Shell`]).
enum Wake {
    /// The settings changed.
    Sync,
    /// Self-test: busy-loop the main thread this many ms inside one frame.
    Block(u64),
}

static WAKE: OnceLock<async_channel::Sender<Wake>> = OnceLock::new();
static WRITER: OnceLock<mpsc::Sender<Out>> = OnceLock::new();
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// A task of the engine thread from this long is a long task.
const LONG_US: u64 = 8_000;

// --- Logging: the engine's trace lines -------------------------------------------------

/// `env_logger` for everything but `nsh::perf`, whose lines (the engine's
/// trace, the GPUI backend's frame statistics) are read while measuring
/// and dropped otherwise.
struct Tee {
    inner: env_logger::Logger,
}

impl log::Log for Tee {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        if metadata.target() == "nsh::perf" {
            return measuring();
        }
        self.inner.enabled(metadata)
    }

    fn log(&self, record: &log::Record) {
        if record.target() == "nsh::perf" {
            if measuring() {
                // Never take the engine thread down over a statistic.
                let line = record.args().to_string();
                let _ = std::panic::catch_unwind(|| engine_line(&line));
            }
            return;
        }
        if self.inner.matches(record) {
            self.inner.log(record);
        }
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

/// Installs the logger (in place of `env_logger::init`): `RUST_LOG` as
/// before, `info` by default.
pub(crate) fn init_logging() {
    let inner = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).build();
    // The trace lines are info: they must reach `log`, whatever RUST_LOG.
    let level = inner.filter().max(log::LevelFilter::Info);
    if log::set_boxed_logger(Box::new(Tee { inner })).is_ok() {
        log::set_max_level(level);
    }
}

/// The engine thread's second.
#[derive(Default)]
struct EngineSecond {
    busy_us: u64,
    commits: u32,
    commit_max_us: u64,
    items: u64,
    events: u32,
    last_event: String,
    /// The previous line was a commit (a `turn:` line includes it).
    after_commit: u64,
    long: Vec<(f64, String)>,
    worst: Option<(f64, String)>,
    nsh: Option<String>,
}

static ENGINE: Mutex<EngineSecond> = Mutex::new(EngineSecond {
    busy_us: 0,
    commits: 0,
    commit_max_us: 0,
    items: 0,
    events: 0,
    last_event: String::new(),
    after_commit: 0,
    long: Vec::new(),
    worst: None,
    nsh: None,
});

/// One engine-thread happening, kept a little while for the spikes.
#[derive(Clone)]
struct EngineEvent {
    at: Instant,
    /// "commit", "event", "timers", "gc".
    kind: &'static str,
    us: u64,
    ops: u64,
    items: u64,
    label: String,
}

static RECENT: Mutex<Vec<EngineEvent>> = Mutex::new(Vec::new());

fn recent(e: EngineEvent) {
    let mut r = RECENT.lock().unwrap_or_else(|p| p.into_inner());
    if r.len() >= 256 {
        r.drain(..128);
    }
    r.push(e);
}

/// The first number in `s` after `key` (digits only).
fn num_after(s: &str, key: &str) -> Option<u64> {
    let rest = &s[s.find(key)? + key.len()..];
    let digits: String = rest.chars().skip_while(|c| *c == ' ').take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn long(e: &mut EngineSecond, us: u64, label: String) {
    if us < LONG_US {
        return;
    }
    let ms = (us as f64 / 100.0).round() / 10.0;
    // The worst is kept whatever the cap.
    if e.worst.as_ref().is_none_or(|w| ms > w.0) {
        e.worst = Some((ms, label.clone()));
    }
    if e.long.len() < 40 {
        e.long.push((ms, label));
    }
}

/// One `nsh::perf` line (nsh-engine lib.rs, nsh-platform-gpui stats.rs).
fn engine_line(line: &str) {
    let now = Instant::now();
    let mut e = ENGINE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(rest) = line.strip_prefix("commit: ") {
        let us = num_after(rest, "ops,").unwrap_or(0);
        let ops = num_after(rest, "").unwrap_or(0);
        let items = num_after(rest, "),").unwrap_or(0);
        e.busy_us += us;
        e.commits += 1;
        e.commit_max_us = e.commit_max_us.max(us);
        e.items += items;
        e.after_commit = us;
        // No event line before it: a timer, a scroll report or a list bind
        // (the trace does not say which).
        let what = if e.last_event.is_empty() { "no event (timer, scroll report or list bind)".to_owned() } else { e.last_event.clone() };
        long(&mut e, us, format!("commit {ops} ops {items} items after {what}"));
        drop(e);
        recent(EngineEvent { at: now, kind: "commit", us, ops, items, label: what });
        return;
    }
    let after = std::mem::take(&mut e.after_commit);
    if let Some(rest) = line.strip_prefix("event js: ") {
        let us = num_after(rest, "").unwrap_or(0);
        e.busy_us += us;
        let label = format!("event {}", e.last_event);
        long(&mut e, us, label.clone());
        drop(e);
        recent(EngineEvent { at: now, kind: "event", us, ops: 0, items: 0, label });
    } else if let Some(rest) = line.strip_prefix("event ") {
        e.events += 1;
        e.last_event = rest.to_owned();
    } else if let Some(rest) = line.strip_prefix("turn: ") {
        let us = num_after(rest, "").unwrap_or(0);
        let tasks = num_after(rest, "tasks").unwrap_or(0);
        e.busy_us += us.saturating_sub(after);
        e.last_event.clear();
        long(&mut e, tasks, "timers, tasks, scroll reports, list binds".to_owned());
        drop(e);
        recent(EngineEvent { at: now, kind: "timers", us: tasks, ops: 0, items: 0, label: String::new() });
    } else if let Some(rest) = line.strip_prefix("gc: ") {
        let us = num_after(rest, "").unwrap_or(0);
        e.busy_us += us;
        long(&mut e, us, "gc".to_owned());
        drop(e);
        recent(EngineEvent { at: now, kind: "gc", us, ops: 0, items: 0, label: String::new() });
    } else if line.starts_with("fps ") {
        e.nsh = Some(line.to_owned());
        if let Some(n) = nsh_fps(Some(line)) {
            let mut log = NSH_LOG.lock().unwrap_or_else(|p| p.into_inner());
            if log.len() < 256 {
                log.push((now, n));
            }
        }
    } else if let Some(rest) = line.strip_prefix("first frame: ") {
        let us = num_after(rest, "total").unwrap_or(0);
        long(&mut e, us, format!("first frame ({rest})"));
    }
}

// --- What JS reports ---------------------------------------------------------------------

#[derive(Default)]
struct JsSecond {
    lag_max: f64,
    lag_sum: f64,
    lag_base: f64,
    lag_abs_max: f64,
    lag_late_share: f64,
    long: Vec<JsonValue>,
}

static JS: Mutex<JsSecond> =
    Mutex::new(JsSecond { lag_max: 0.0, lag_sum: 0.0, lag_base: 0.0, lag_abs_max: 0.0, lag_late_share: 0.0, long: Vec::new() });
static ROUTE: Mutex<String> = Mutex::new(String::new());
static STEP: Mutex<String> = Mutex::new(String::new());
/// When each scenario step began: frames and stretches are labelled by the
/// step they happened in, not the second they were reported in.
static STEP_LOG: Mutex<Vec<(Instant, String)>> = Mutex::new(Vec::new());
/// NSH's own `fps` lines as they came: (when, frames it painted since its
/// previous line).
static NSH_LOG: Mutex<Vec<(Instant, u32)>> = Mutex::new(Vec::new());

fn note_step(step: Option<&str>) {
    let Some(step) = step else { return };
    let mut log = STEP_LOG.lock().unwrap_or_else(|p| p.into_inner());
    if log.last().is_none_or(|(_, s)| s != step) {
        if log.len() > 4096 {
            log.drain(..2048);
        }
        log.push((Instant::now(), step.to_owned()));
    }
}

/// The step that was running at `at`.
fn step_at(log: &[(Instant, String)], at: Instant) -> &str {
    log.iter().rev().find(|(t, _)| *t <= at).map_or("", |(_, s)| s.as_str())
}

fn set_text(m: &Mutex<String>, v: Option<&str>) {
    if let Some(v) = v {
        let mut s = m.lock().unwrap_or_else(|p| p.into_inner());
        s.clear();
        s.push_str(v);
    }
}

fn text(m: &Mutex<String>) -> String {
    m.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// `perf.set` / `perf.js` / `perf.route` / `perf.save` / `perf.block`;
/// `dir` is the app's data directory (the recorder's files go there).
pub(crate) fn register(host: &HostChannel, dir: Option<PathBuf>) {
    if let Some(dir) = dir {
        let _ = DIR.set(dir);
    }
    host.handle("perf.set", |call| {
        let d = call.data();
        let hud = d.get("hud").and_then(JsonValue::as_bool).unwrap_or(false);
        let record = d.get("record").and_then(JsonValue::as_bool).unwrap_or(false);
        HUD.store(hud, Ordering::Relaxed);
        RECORD.store(record, Ordering::Relaxed);
        if hud || record {
            start_writer();
        }
        if let Some(tx) = WAKE.get() {
            let _ = tx.try_send(Wake::Sync);
        }
        let file = DIR.get().map(|p| p.join("perf.jsonl").display().to_string());
        call.resolve(json!({ "ok": true, "hud": hud, "record": record, "file": file }));
    });
    host.handle("perf.js", |call| {
        if measuring() {
            let d = call.data();
            set_text(&ROUTE, d.get("route").and_then(JsonValue::as_str));
            set_text(&STEP, d.get("step").and_then(JsonValue::as_str));
            note_step(d.get("step").and_then(JsonValue::as_str));
            let mut js = JS.lock().unwrap_or_else(|p| p.into_inner());
            let lag = d.get("lagMax").and_then(JsonValue::as_f64).unwrap_or(0.0);
            js.lag_max = js.lag_max.max(lag);
            js.lag_sum += d.get("lagSum").and_then(JsonValue::as_f64).unwrap_or(0.0);
            js.lag_base = d.get("lagBase").and_then(JsonValue::as_f64).unwrap_or(0.0);
            js.lag_abs_max = js.lag_abs_max.max(d.get("lagAbsMax").and_then(JsonValue::as_f64).unwrap_or(0.0));
            js.lag_late_share = d.get("lagLateShare").and_then(JsonValue::as_f64).unwrap_or(0.0);
            if let Some(list) = d.get("long").and_then(JsonValue::as_array) {
                for item in list {
                    if js.long.len() < 60 {
                        js.long.push(item.clone());
                    }
                }
            }
        }
        call.resolve(JsonValue::Null);
    });
    host.handle("perf.route", |call| {
        set_text(&ROUTE, call.data().get("route").and_then(JsonValue::as_str));
        set_text(&STEP, call.data().get("step").and_then(JsonValue::as_str));
        note_step(call.data().get("step").and_then(JsonValue::as_str));
        call.resolve(JsonValue::Null);
    });
    host.handle("perf.save", |call| {
        start_writer();
        match WRITER.get() {
            Some(tx) => {
                if let Err(mpsc::SendError(Out::Save(call))) = tx.send(Out::Save(call)) {
                    call.resolve(json!({ "ok": false }));
                }
            }
            None => call.resolve(json!({ "ok": false })),
        }
    });
    host.handle("perf.block", |call| {
        let ms = call.data().get("ms").and_then(JsonValue::as_u64).unwrap_or(0).min(2_000);
        if let Some(tx) = WAKE.get() {
            let _ = tx.try_send(Wake::Block(ms));
        }
        call.resolve(json!({ "ok": true }));
    });
}

// --- The writer --------------------------------------------------------------------------

/// What the writer thread writes.
enum Out {
    /// A second: its recorder line (when recording) and its slow frames
    /// with their stacks, put into words here (off the main thread).
    Second(Box<SecondRaw>),
    /// Rotates the files to timestamped names; answers with their paths.
    Save(HostCall),
}

const ROLL: u64 = 2 * 1024 * 1024;

fn append(path: &std::path::Path, line: &str, rolled: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > ROLL) {
        let _ = std::fs::rename(path, path.with_file_name(rolled));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// The main executable's path (stacks name its frames as offsets).
fn exe() -> String {
    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
}

/// The writer, started the first time anything is measured.
fn start_writer() {
    let Some(dir) = DIR.get().cloned() else { return };
    if WRITER.get().is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<Out>();
    if WRITER.set(tx).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("rustflix-perf".to_owned())
        .spawn(move || {
            let perf = dir.join("perf.jsonl");
            let spikes = dir.join("perf-spikes.jsonl");
            let exe = exe();
            let mut headed = false;
            let mut selftest = SelfTest::default();
            while let Ok(out) = rx.recv() {
                match out {
                    Out::Second(raw) => {
                        if let Some(v) = selftest.feed(&raw) {
                            append(&perf, &v.to_string(), "perf.1.jsonl");
                        }
                        if raw.record {
                            append(&perf, &second_line(&raw).to_string(), "perf.1.jsonl");
                        }
                        for (mut v, stacks) in spike_lines(&raw) {
                        if !headed || !spikes.exists() {
                            headed = true;
                            let head = json!({
                                "kind": "header",
                                "exe": exe,
                                "atos": format!("atos -o '{exe}' -l 0x100000000 <addresses>"),
                                "pid": std::process::id(),
                            });
                            append(&spikes, &head.to_string(), "perf-spikes.1.jsonl");
                        }
                        let named: Vec<Vec<String>> = stacks
                            .iter()
                            .map(|s| s.iter().map(|f| sampler::describe(*f, &exe)).collect())
                            .collect();
                        // Every sample parked in mach_msg: the thread was
                        // waiting (a nested run loop: a window resize, a
                        // menu; IPC), not working.
                        if !named.is_empty() && named.iter().all(|st| st.first().is_some_and(|f| f.contains("mach_msg"))) {
                            v["waiting"] = json!(true);
                            if let Some(r) = v["reason"].as_str() {
                                v["reason"] = json!(format!("{r}; every stack sample is parked in mach_msg: waiting (nested run loop / IPC), not work"));
                            }
                        }
                        v["stacks"] = json!(named);
                        append(&spikes, &v.to_string(), "perf-spikes.1.jsonl");
                        }
                        if let Some(cutoff) = Instant::now().checked_sub(Duration::from_secs(2)) {
                            sampler::forget_before(cutoff);
                        }
                    }
                    Out::Save(call) => {
                        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
                        let mut files = Vec::new();
                        for (from, to) in [
                            (&perf, format!("perf-{stamp}.jsonl")),
                            (&spikes, format!("perf-spikes-{stamp}.jsonl")),
                        ] {
                            let to = dir.join(to);
                            if from.exists() && std::fs::rename(from, &to).is_ok() {
                                files.push(to.display().to_string());
                            }
                        }
                        headed = false;
                        call.resolve(json!({ "ok": true, "dir": dir.display().to_string(), "files": files }));
                    }
                }
            }
        });
    if let Err(err) = spawned {
        log::warn!("perf: no writer thread: {err}");
    }
}

fn send(out: Out) {
    if let Some(tx) = WRITER.get() {
        let _ = tx.send(out);
    }
}


#[cfg(target_os = "macos")]
mod runloop {
    use std::ffi::c_void;

    type Ref = *mut c_void;
    const BEFORE_WAITING: usize = 1 << 5;
    const AFTER_WAITING: usize = 1 << 6;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRunLoopGetMain() -> Ref;
        fn CFRunLoopObserverCreate(
            allocator: *const c_void,
            activities: usize,
            repeats: u8,
            order: isize,
            callout: extern "C" fn(Ref, usize, *mut c_void),
            context: *mut c_void,
        ) -> Ref;
        fn CFRunLoopAddObserver(rl: Ref, observer: Ref, mode: *const c_void);
        fn CFRunLoopRemoveObserver(rl: Ref, observer: Ref, mode: *const c_void);
        fn CFRelease(cf: *const c_void);
        static kCFRunLoopCommonModes: *const c_void;
    }

    extern "C" fn woke(_: Ref, _: usize, _: *mut c_void) {
        let now = std::time::Instant::now();
        super::sampler::awake(Some(now));
        super::with_mon(|m| m.work.woke(now));
    }

    extern "C" fn sleeps(_: Ref, _: usize, _: *mut c_void) {
        let now = std::time::Instant::now();
        super::sampler::awake(None);
        super::with_mon(|m| {
            m.work.suspended += super::sampler::take_suspended();
            let (f, s) = m.work.slept(now);
            m.take(f, s);
        });
    }

    /// The observers while installed (main thread only).
    pub(super) struct Observers([Ref; 2]);

    impl Observers {
        pub(super) fn install() -> Observers {
            // SAFETY: CoreFoundation's documented calls on the main thread's
            // run loop; the callouts touch only this thread's state.
            unsafe {
                let rl = CFRunLoopGetMain();
                let first = CFRunLoopObserverCreate(std::ptr::null(), AFTER_WAITING, 1, isize::MIN, woke, std::ptr::null_mut());
                let last = CFRunLoopObserverCreate(std::ptr::null(), BEFORE_WAITING, 1, isize::MAX, sleeps, std::ptr::null_mut());
                CFRunLoopAddObserver(rl, first, kCFRunLoopCommonModes);
                CFRunLoopAddObserver(rl, last, kCFRunLoopCommonModes);
                Observers([first, last])
            }
        }
    }

    impl Drop for Observers {
        fn drop(&mut self) {
            // SAFETY: the observers this made, removed and released once.
            unsafe {
                let rl = CFRunLoopGetMain();
                for o in self.0 {
                    CFRunLoopRemoveObserver(rl, o, kCFRunLoopCommonModes);
                    CFRelease(o);
                }
            }
            super::sampler::awake(None);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod runloop {
    /// No run-loop observers here: frames end at the next render.
    pub(super) struct Observers;
    impl Observers {
        pub(super) fn install() -> Observers {
            Observers
        }
    }
}


// --- Vsync: the display's refreshes, from a display link of the monitor's own -------------

/// While measuring, a `CVDisplayLink` (the timing source GPUI's own frames
/// follow, gpui-fast-macos display_link.rs) reports the main display's
/// measured refresh period (`videoRefreshPeriod / videoTimeScale`, so a
/// ProMotion screen running below 120 Hz reads as it runs): the budget.
#[cfg(target_os = "macos")]
mod vsync {
    use std::{
        ffi::c_void,
        sync::{
            OnceLock,
            atomic::{AtomicBool, AtomicU64, Ordering},
        },
        time::Duration,
    };


    /// The leading fields of CoreVideo's `CVTimeStamp` (what is read).
    #[repr(C)]
    struct TimeStamp {
        version: u32,
        video_time_scale: i32,
        video_time: i64,
        host_time: u64,
        rate_scalar: f64,
        video_refresh_period: i64,
    }

    type Link = *mut c_void;
    type Callback = extern "C" fn(Link, *const TimeStamp, *const TimeStamp, u64, *mut u64, *mut c_void) -> i32;

    #[link(name = "CoreVideo", kind = "framework")]
    unsafe extern "C" {
        fn CVDisplayLinkCreateWithActiveCGDisplays(link: *mut Link) -> i32;
        fn CVDisplayLinkSetOutputCallback(link: Link, cb: Callback, ctx: *mut c_void) -> i32;
        fn CVDisplayLinkStart(link: Link) -> i32;
        fn CVDisplayLinkStop(link: Link) -> i32;
    }

    static RUNNING: AtomicBool = AtomicBool::new(false);
    static PERIOD_NS: AtomicU64 = AtomicU64::new(0);
    /// The last vsync callback (ns since the sampler's base).
    static LAST_TICK_NS: AtomicU64 = AtomicU64::new(0);
    /// The link, made once and kept (CoreVideo links have no safe teardown).
    struct Handle(Link);
    // SAFETY: CVDisplayLink is thread-safe; only start/stop are called.
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}
    static LINK: OnceLock<Option<Handle>> = OnceLock::new();

    extern "C" fn on_vsync(_: Link, _: *const TimeStamp, out: *const TimeStamp, _: u64, _: *mut u64, _: *mut c_void) -> i32 {
        if !RUNNING.load(Ordering::Relaxed) {
            return 0;
        }
        LAST_TICK_NS.store(super::sampler::ns(std::time::Instant::now()), Ordering::Relaxed);
        // SAFETY: CoreVideo passes valid time stamps for the call.
        if let Some(out) = unsafe { out.as_ref() }
            && out.video_time_scale > 0
            && out.video_refresh_period > 0
        {
            let ns = out.video_refresh_period as u128 * 1_000_000_000 / out.video_time_scale as u128;
            PERIOD_NS.store(ns as u64, Ordering::Relaxed);
        }
        0
    }

    pub(super) fn start() {
        let link = LINK.get_or_init(|| {
            let mut link: Link = std::ptr::null_mut();
            // SAFETY: CoreVideo's documented calls; the callback is a plain fn.
            unsafe {
                if CVDisplayLinkCreateWithActiveCGDisplays(&mut link) != 0 || link.is_null() {
                    return None;
                }
                CVDisplayLinkSetOutputCallback(link, on_vsync, std::ptr::null_mut());
            }
            Some(Handle(link))
        });
        if let Some(h) = link {
            RUNNING.store(true, Ordering::Relaxed);
            // SAFETY: a live link.
            unsafe { CVDisplayLinkStart(h.0) };
        }
    }

    pub(super) fn stop() {
        RUNNING.store(false, Ordering::Relaxed);
        if let Some(Some(h)) = LINK.get() {
            // SAFETY: a live link.
            unsafe { CVDisplayLinkStop(h.0) };
        }
    }

    /// How long after the last vsync callback `at` is (`None` before one).
    pub(super) fn since_tick(at: std::time::Instant) -> Option<Duration> {
        let t = LAST_TICK_NS.load(Ordering::Relaxed);
        (t != 0).then(|| Duration::from_nanos(super::sampler::ns(at).saturating_sub(t)))
    }

    /// The display's measured refresh period, once the link ran.
    pub(super) fn period() -> Option<Duration> {
        let ns = PERIOD_NS.load(Ordering::Relaxed);
        (ns > 1_000_000 && ns < 100_000_000).then(|| Duration::from_nanos(ns))
    }

}

#[cfg(not(target_os = "macos"))]
mod vsync {
    pub(super) fn start() {}
    pub(super) fn stop() {}
    pub(super) fn period() -> Option<std::time::Duration> {
        None
    }
    pub(super) fn since_tick(_at: std::time::Instant) -> Option<std::time::Duration> {
        None
    }
}

/// The machine's thermal state (`NSProcessInfo.thermalState`: nominal,
/// fair, serious, critical): a hot machine runs slower.
fn thermal() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        use objc2::{class, msg_send};
        // SAFETY: NSProcessInfo's documented class method and property.
        let state: isize = unsafe {
            let info: *mut objc2::runtime::AnyObject = msg_send![class!(NSProcessInfo), processInfo];
            if info.is_null() {
                return "?";
            }
            msg_send![info, thermalState]
        };
        return match state {
            0 => "nominal",
            1 => "fair",
            2 => "serious",
            3 => "critical",
            _ => "?",
        };
    }
    #[allow(unreachable_code)]
    "?"
}


// --- The main thread's frames ------------------------------------------------------------

/// One frame, as the recorder keeps it.
#[derive(Clone, Copy, Debug)]
struct FrameRec {
    seq: u64,
    from: Instant,
    end: Instant,
    cost: Duration,
    wait: Duration,
    period: Duration,
    /// On-glass time (seconds, `CACurrentMediaTime` base); `Some(0.0)`:
    /// never shown; `None`: not reported yet.
    presented: Option<f64>,
    /// Refreshes it reached the glass late by (0: on time).
    late: u32,
    /// Since the previous presentation (ms), in an active run.
    gap_ms: Option<f32>,
    /// How long after the display link's last vsync GPUI asked for the
    /// drawable (ms): a late tick delivery shows here, back-pressure in
    /// `wait`.
    since_vsync_ms: Option<f32>,
    reported: bool,
}

/// The main thread's measuring state.
struct Monitor {
    work: WorkClock,
    presents: Presents,
    period: Duration,
    /// The last frames (matched with their on-glass times as they come).
    recent: Ring<FrameRec>,
    /// This second's wake-ups that drew nothing.
    stretches: Vec<Stretch>,
    /// When the frames' ends are the only times (no on-glass times): the
    /// previous frame's end, for the fallback gaps.
    last_end: Option<f64>,
    base: Instant,
    /// When NSH's previous `fps` line came (its window starts there).
    last_nsh: Option<Instant>,
    /// Frames' `since_vsync_ms` until their frame closes: (seq, ms).
    since: std::collections::VecDeque<(u64, f32)>,
    /// The accessibility tree is being built (an assistive client attached).
    a11y: bool,
}

impl Monitor {
    fn new() -> Monitor {
        Monitor {
            work: WorkClock::default(),
            presents: Presents::default(),
            period: Duration::from_nanos(16_666_667),
            recent: Ring::new(1200),
            stretches: Vec::with_capacity(256),
            last_end: None,
            base: Instant::now(),
            last_nsh: None,
            since: std::collections::VecDeque::with_capacity(16),
            a11y: false,
        }
    }

    fn take(&mut self, frame: Option<FrameWork>, stretch: Option<Stretch>) {
        if let Some(f) = frame {
            let mut rec = FrameRec {
                seq: f.seq,
                from: f.from,
                end: f.end,
                cost: f.cost,
                wait: f.wait,
                period: self.period,
                presented: None,
                late: 0,
                gap_ms: None,
                since_vsync_ms: self.since.iter().find(|(s, _)| *s == f.seq).map(|(_, v)| *v),
                reported: false,
            };
            self.since.retain(|(s, _)| *s > f.seq);
            if !present::has_present_times() {
                // Fallback: the frames' ends as their presentations.
                let at = f.end.saturating_duration_since(self.base).as_secs_f64();
                let (late, gap) = self.presents.presented(at, self.period.as_secs_f64());
                rec.presented = Some(at);
                rec.late = late;
                rec.gap_ms = gap.map(|g| (g * 1e3) as f32);
                self.last_end = Some(at);
            }
            self.recent.push(rec);
        }
        if let Some(s) = stretch
            && s.busy >= Duration::from_micros(200)
            && self.stretches.len() < 2048
        {
            self.stretches.push(s);
        }
    }

    /// Matches the on-glass times reported so far with their frames, in
    /// order, and classifies them.
    fn match_presents(&mut self) {
        let period = self.period.as_secs_f64();
        for (seq, at) in present::take_presented() {
            let Some(rec) = self.recent.iter_mut().rev().find(|r| r.seq == seq) else { continue };
            if at <= 0.0 {
                rec.presented = Some(0.0);
                continue;
            }
            let (late, gap) = self.presents.presented(at, period);
            rec.presented = Some(at);
            rec.late = late;
            rec.gap_ms = gap.map(|g| (g * 1e3) as f32);
        }
    }
}

thread_local! {
    static MON: RefCell<Option<Monitor>> = const { RefCell::new(None) };
}

/// Runs `f` with the monitor while measuring (never re-entered: skipped).
fn with_mon<R>(f: impl FnOnce(&mut Monitor) -> R) -> Option<R> {
    MON.with(|m| m.try_borrow_mut().ok().and_then(|mut m| m.as_mut().map(f)))
}

/// A drawable was taken (the hook in [`present`], main thread).
pub(crate) fn on_drawable(seq: u64, call: Instant, ret: Instant) {
    let since = vsync::since_tick(call).map(ms);
    with_mon(|m| {
        if let Some(v) = since {
            if m.since.len() >= 16 {
                m.since.pop_front();
            }
            m.since.push_back((seq, v));
        }
        let f = m.work.drawable(seq, call, ret);
        m.take(f, None);
    });
}

// --- Numbers -----------------------------------------------------------------------------

fn ms(d: Duration) -> f32 {
    d.as_secs_f32() * 1e3
}

fn pct(sorted: &[f32], q: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let at = ((sorted.len() as f32 * q).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[at]
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() { 0.0 } else { v.iter().sum::<f32>() / v.len() as f32 }
}

fn r2(v: f32) -> f64 {
    (v as f64 * 100.0).round() / 100.0
}

/// What made a frame late or slow, in words.
fn reason(f: &FrameRec, stall_before: Duration, items: u64) -> String {
    let p = ms(f.period);
    let mut parts = Vec::new();
    if f.late > 0 {
        parts.push(format!("on glass {} refresh(es) late", f.late));
    }
    if f.cost > f.period {
        parts.push(format!("main-thread work {:.1} ms (over {:.1})", ms(f.cost), p));
    }
    if stall_before > f.period {
        parts.push(format!("main thread busy {:.1} ms before it, drawing nothing", ms(stall_before)));
    }
    if f.wait > f.period / 2 {
        parts.push(format!("waited {:.1} ms for a drawable (display/GPU back-pressure, not work)", ms(f.wait)));
    }
    if items > 0 {
        parts.push(format!("{items} mount items applied around it"));
    }
    if parts.is_empty() || (f.late > 0 && f.cost <= f.period && stall_before <= f.period && f.wait <= f.period / 2) {
        parts.push("no main-thread cause found: GPU, compositor or a pause in input".to_owned());
    }
    parts.join("; ")
}

/// What the panel shows of the last full second of the engine and JS.
#[derive(Default, Clone)]
struct LastSecond {
    busy_ms: f32,
    commits: u32,
    lag_ms: f32,
    worst: Option<(f64, String)>,
}

// --- The window ----------------------------------------------------------------------------

/// The window's root: the app's view (the monitor's own frames come from
/// the Metal layer, [`present`]; the shell only hosts the self-test block).
struct Shell {
    app: Entity<AppView>,
    last: LastSecond,
    hz: f32,
    /// Self-test: ms to busy-loop in the next render.
    block: u64,
    observers: Option<runloop::Observers>,
    hud: Option<hud::Hud>,
    hud_task: Option<Task<()>>,
    second_task: Option<Task<()>>,
    _listen: Task<()>,
}

impl Shell {
    fn new(app: Entity<AppView>, cx: &mut Context<Self>) -> Shell {
        sampler::init_on_main();
        let (tx, rx) = async_channel::unbounded::<Wake>();
        // Settings that arrived before the window: applied at once.
        let _ = tx.try_send(Wake::Sync);
        let _ = WAKE.set(tx);
        let listen = cx.spawn(async move |this, cx| {
            while let Ok(w) = rx.recv().await {
                let done = this.update(cx, |shell, cx| match w {
                    Wake::Sync => shell.sync(cx),
                    Wake::Block(ms) => {
                        // Run inside the next frame's render, so exactly one
                        // frame carries it.
                        shell.block = ms;
                        shell.app.update(cx, |_, cx| cx.notify());
                        cx.notify();
                    }
                });
                if done.is_err() {
                    break;
                }
            }
        });
        Shell {
            app,
            last: LastSecond::default(),
            hz: 60.0,
            block: 0,
            observers: None,
            hud: None,
            hud_task: None,
            second_task: None,
            _listen: listen,
        }
    }

    /// Follows `HUD` / `RECORD`.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let hud = HUD.load(Ordering::Relaxed);
        let record = RECORD.load(Ordering::Relaxed);
        let on = hud || record;
        // NSH's own frame statistics line, for the recorder (and the
        // consistency check against it).
        self.app.read(cx).set_fps_monitor(on);
        if on && self.observers.is_none() {
            MON.with(|m| *m.borrow_mut() = Some(Monitor::new()));
            self.observers = Some(runloop::Observers::install());
            sampler::start();
            vsync::start();
            #[cfg(target_os = "macos")]
            present::install();
            *ENGINE.lock().unwrap_or_else(|p| p.into_inner()) = EngineSecond::default();
            *JS.lock().unwrap_or_else(|p| p.into_inner()) = JsSecond::default();
            RECENT.lock().unwrap_or_else(|p| p.into_inner()).clear();
        }
        if !on && self.observers.is_some() {
            #[cfg(target_os = "macos")]
            present::uninstall();
            self.observers = None;
            sampler::stop();
            vsync::stop();
            MON.with(|m| *m.borrow_mut() = None);
        }
        if on && self.second_task.is_none() {
            self.second_task = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    if this.update(cx, |shell, _| shell.close_second()).is_err() {
                        break;
                    }
                }
            }));
        } else if !on {
            self.second_task = None;
        }
        if hud && self.hud.is_none() {
            // The panel never takes the app down: a failure leaves it off
            // (the recorder keeps going).
            self.hud = std::panic::catch_unwind(hud::Hud::show).unwrap_or_else(|_| {
                log::warn!("perf: the panel could not be shown");
                None
            });
        } else if !hud {
            self.hud = None;
        }
        if hud && self.hud_task.is_none() {
            self.hud_task = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(500)).await;
                    if this.update(cx, |shell, _| shell.update_panel()).is_err() {
                        break;
                    }
                }
            }));
        } else if !hud {
            self.hud_task = None;
        }
    }

    fn refresh_period(&mut self) {
        if let Some(p) = vsync::period() {
            self.hz = (1.0 / p.as_secs_f32()).clamp(10.0, 1000.0);
        }
        let period = Duration::from_secs_f32(1.0 / self.hz);
        sampler::set_budget(period);
        with_mon(|m| m.period = period);
    }

    /// The panel's numbers (twice a second; no GPUI frame).
    fn update_panel(&mut self) {
        self.refresh_period();
        let Some(hud) = &self.hud else { return };
        let budget = 1e3 / self.hz;
        let Some((bars, rows)) = with_mon(|m| {
            m.match_presents();
            let now = Instant::now();
            let in_last = |f: &FrameRec, s: u64| now.saturating_duration_since(f.end) <= Duration::from_secs(s);
            let mut costs = Vec::new();
            let mut waits = Vec::new();
            let (mut fps, mut late1, mut late10) = (0, 0u32, 0u32);
            for f in m.recent.iter() {
                if in_last(f, 1) {
                    fps += 1;
                    late1 += f.late;
                    costs.push(ms(f.cost));
                    waits.push(ms(f.wait));
                }
                if in_last(f, 10) {
                    late10 += f.late;
                }
            }
            // One bar per frame, the last 120: its height is its cost; red:
            // late on glass; amber: cost over half a refresh; a long wait
            // shows as a thin grey bar.
            let bars: Vec<(f32, u8)> = m
                .recent
                .iter()
                .rev()
                .take(120)
                .rev()
                .map(|f| {
                    let kind = if f.late > 0 {
                        2
                    } else if ms(f.cost) > budget / 2.0 {
                        1
                    } else if ms(f.wait) > budget / 2.0 {
                        3
                    } else {
                        0
                    };
                    (ms(f.cost).max(if kind == 3 { ms(f.wait) } else { 0.0 }), kind)
                })
                .collect();
            costs.sort_by(f32::total_cmp);
            waits.sort_by(f32::total_cmp);
            let rows = format!(
                "FPS  {fps:>3} / {:.0} Hz  late {late1} (1s) {late10} (10s)\nCOST {:>5.2} p95 {:>5.2} max {:>5.2} ms\nWAIT p95 {:>5.2} max {:>5.2} ms (drawable)\n",
                1e3 / budget,
                mean(&costs),
                pct(&costs, 0.95),
                costs.last().copied().unwrap_or(0.0),
                pct(&waits, 0.95),
                waits.last().copied().unwrap_or(0.0),
            );
            (bars, rows)
        }) else {
            return;
        };
        let mut rows = rows;
        rows.push_str(&format!(
            "ENG  busy {:>3.0}% {:>3} commits lag {:>4.1}\n",
            self.last.busy_ms / 10.0,
            self.last.commits,
            self.last.lag_ms
        ));
        match &self.last.worst {
            Some((ms, label)) => rows.push_str(&format!("JS   {ms:>5.1} {}", label.chars().take(30).collect::<String>())),
            None => rows.push_str("JS   no long task"),
        }
        let shown = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| hud.update(&rows, &bars, budget)));
        if shown.is_err() {
            log::warn!("perf: the panel failed; it is off");
            self.hud = None;
        }
    }

    /// A second ended: the panel's JS row on this thread (a max over a few
    /// numbers); the recorder's line, the spikes and the self-test go to the
    /// writer thread as they are, to be put into words there.
    fn close_second(&mut self) {
        self.refresh_period();
        let engine = std::mem::take(&mut *ENGINE.lock().unwrap_or_else(|p| p.into_inner()));
        let js = std::mem::take(&mut *JS.lock().unwrap_or_else(|p| p.into_inner()));
        let now = Instant::now();
        let nsh_lines = std::mem::take(&mut *NSH_LOG.lock().unwrap_or_else(|p| p.into_inner()));
        let (frames, stretches, a11y, nsh_windows) = with_mon(|m| {
            m.match_presents();
            // NSH's line covers its paints from its previous line to this
            // one (logged on the first paint a second after the window
            // began, so windows do not follow our seconds): ours counted
            // over the same window.
            let mut windows = Vec::new();
            for (at, n) in &nsh_lines {
                let from = m.last_nsh.unwrap_or(m.base);
                let ours = m.recent.iter().filter(|f| f.end > from && f.end <= *at).count() as u32;
                windows.push((*n, ours, at.saturating_duration_since(from)));
                m.last_nsh = Some(*at);
            }
            // Frames whose on-glass time had time to come (or never will).
            let mut out = Vec::new();
            for f in m.recent.iter_mut() {
                if !f.reported && (f.presented.is_some() || now.saturating_duration_since(f.end) > Duration::from_millis(500)) {
                    f.reported = true;
                    out.push(*f);
                }
            }
            (out, std::mem::take(&mut m.stretches), m.a11y, windows)
        })
        .unwrap_or_default();
        let mut worst: Option<(f64, String)> = engine.worst.clone();
        for v in &js.long {
            if let Some(a) = v.as_array()
                && let (Some(ms), Some(label)) = (a.first().and_then(JsonValue::as_f64), a.get(1).and_then(JsonValue::as_str))
                && worst.as_ref().is_none_or(|w| ms > w.0)
            {
                worst = Some((ms, label.to_owned()));
            }
        }
        self.last = LastSecond {
            busy_ms: engine.busy_us as f32 / 1e3,
            commits: engine.commits,
            lag_ms: js.lag_max as f32,
            worst,
        };
        send(Out::Second(Box::new(SecondRaw {
            wall: SystemTime::now(),
            now,
            hz: self.hz,
            route: text(&ROUTE),
            step: text(&STEP),
            frames,
            stretches,
            engine,
            js,
            record: measuring(),
            a11y,
            present_times: present::has_present_times(),
            nsh_windows,
        })));
    }
}

/// A second as measured, put into words by the writer thread.
struct SecondRaw {
    wall: SystemTime,
    now: Instant,
    hz: f32,
    route: String,
    step: String,
    frames: Vec<FrameRec>,
    stretches: Vec<Stretch>,
    engine: EngineSecond,
    js: JsSecond,
    record: bool,
    a11y: bool,
    present_times: bool,
    /// NSH's `fps` lines this second: (its paints, our frames over the same
    /// window, the window's length).
    nsh_windows: Vec<(u32, u32, Duration)>,
}

/// NSH's own frames per second, from its `fps N active a/b …` line.
fn nsh_fps(line: Option<&str>) -> Option<u32> {
    line?.strip_prefix("fps ")?.split_whitespace().next()?.parse().ok()
}

/// The recorder's line for a second (writer thread).
fn second_line(r: &SecondRaw) -> JsonValue {
    let budget = 1e3 / r.hz;
    let frames = &r.frames;
    let mut costs: Vec<f32> = frames.iter().map(|f| ms(f.cost)).collect();
    costs.sort_by(f32::total_cmp);
    let mut waits: Vec<f32> = frames.iter().map(|f| ms(f.wait)).collect();
    waits.sort_by(f32::total_cmp);
    let mut gaps: Vec<f32> = frames.iter().filter_map(|f| f.gap_ms).collect();
    gaps.sort_by(f32::total_cmp);
    let late_frames = frames.iter().filter(|f| f.late > 0).count();
    let n = frames.len();
    let t = r.wall.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let e = &r.engine;
    let between: f32 = r.stretches.iter().map(|s| ms(s.busy)).sum();
    let stalls = r.stretches.iter().filter(|s| ms(s.busy) > budget).count();
    let nsh = nsh_fps(e.nsh.as_deref());
    // Ours count every drawable (draws and present-only re-encodes); NSH's
    // its surface's paints, over its own windows. Ours below NSH's over
    // the same window means frames are being missed by the hook.
    let consistent = r.nsh_windows.iter().all(|(p, ours, _)| *ours as i64 >= *p as i64 - 2);
    json!({
        "t": t,
        "platform": std::env::consts::OS,
        "route": r.route,
        "step": r.step,
        "hz": r.hz.round(),
        "periodMs": r2(budget),
        "frames": n,
        "nshFps": nsh,
        "framesMatchNsh": consistent,
        "nshWindows": r.nsh_windows.iter().map(|(p, ours, d)| json!({ "nsh": p, "ours": ours, "ms": d.as_millis() as u64 })).collect::<Vec<_>>(),
        "presentOnlyEst": nsh.map(|p| (n as i64 - p as i64).max(0)),
        "late": late_frames,
        "lateRefreshes": frames.iter().map(|f| f.late).sum::<u32>(),
        "notPresented": frames.iter().filter(|f| f.presented == Some(0.0)).count(),
        "lateFrom": if r.present_times { "on-glass times" } else { "frame ends (no on-glass times)" },
        "cost": { "avg": r2(mean(&costs)), "p95": r2(pct(&costs, 0.95)), "max": r2(costs.last().copied().unwrap_or(0.0)) },
        "slow": costs.iter().filter(|c| **c > budget).count(),
        "wait": { "p95": r2(pct(&waits, 0.95)), "max": r2(waits.last().copied().unwrap_or(0.0)) },
        "gap": { "p95": r2(pct(&gaps, 0.95)), "max": r2(gaps.last().copied().unwrap_or(0.0)) },
        "between": { "busyMs": r2(between), "wakeUps": r.stretches.len(), "stalls": stalls },
        "a11y": r.a11y,
        "thermal": thermal(),
        "engine": {
            // The engine thread: the app's JS and NSH's core (render,
            // layout, diff) together. Turns that ran JS but committed
            // nothing log no line (nsh-engine): their time is not here.
            "busyMs": r2(e.busy_us as f32 / 1e3),
            "commits": e.commits,
            "commitMax": r2(e.commit_max_us as f32 / 1e3),
            "items": e.items,
            "events": e.events,
            "long": e.long.iter().map(|(ms, l)| json!([ms, l])).collect::<Vec<_>>(),
        },
        "js": {
            "lagMax": r.js.lag_max,
            "lagAbsMax": r.js.lag_abs_max,
            "lagLateShare": r.js.lag_late_share,
            "lagSum": r.js.lag_sum.round(),
            "lagBase": r.js.lag_base,
            "long": r.js.long,
        },
        "nsh": e.nsh,
    })
}

/// The late or slow frames of a second, and its stalls, with what was going
/// on around them and the stacks sampled while they ran (writer thread).
fn spike_lines(r: &SecondRaw) -> Vec<(JsonValue, Vec<Vec<u64>>)> {
    let recent = RECENT.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let wall_of = |at: Instant| {
        let ago = r.now.saturating_duration_since(at);
        r.wall.checked_sub(ago).unwrap_or(r.wall).duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
    };
    let engine_around = |from: Instant, to: Instant| -> (Vec<JsonValue>, u64) {
        let around: Vec<&EngineEvent> = recent.iter().filter(|e| e.at >= from && e.at <= to).collect();
        let items = around.iter().map(|e| e.items).sum();
        let v = around
            .iter()
            .map(|e| {
                json!({
                    "agoMs": r2(ms(to.saturating_duration_since(e.at))),
                    "kind": e.kind,
                    "ms": r2(e.us as f32 / 1e3),
                    "ops": e.ops,
                    "items": e.items,
                    "label": e.label,
                })
            })
            .collect();
        (v, items)
    };
    let mut out = Vec::new();
    let mut prev_end: Option<Instant> = None;
    for f in &r.frames {
        // Work in wake-ups that drew nothing since the previous frame.
        let stall_before: Duration = r
            .stretches
            .iter()
            .filter(|s| prev_end.is_none_or(|p| s.from >= p) && s.from <= f.from)
            .map(|s| s.busy)
            .max()
            .unwrap_or(Duration::ZERO);
        prev_end = Some(f.end);
        if f.late == 0 && f.cost <= f.period {
            continue;
        }
        let from = f.from.checked_sub(f.period * 2).unwrap_or(f.from);
        let (engine, items) = engine_around(from, f.end);
        let stacks: Vec<Vec<u64>> = sampler::take_since(f.from, f.end).into_iter().map(|s| s.frames).collect();
        out.push((
            json!({
                "kind": "frame",
                "t": wall_of(f.end),
                "platform": std::env::consts::OS,
                "route": r.route,
                "step": r.step,
                "hz": r.hz.round(),
                "budget": r2(ms(f.period)),
                "late": f.late,
                "gapMs": f.gap_ms,
                "cost": r2(ms(f.cost)),
                "wait": r2(ms(f.wait)),
                "sinceVsyncMs": f.since_vsync_ms.map(r2),
                "stallBefore": r2(ms(stall_before)),
                "a11y": r.a11y,
                "reason": reason(f, stall_before, items),
                "engine": engine,
                // JS tasks are reported per second by the app.
                "jsSecond": r.js.long,
            }),
            stacks,
        ));
    }
    let budget = Duration::from_secs_f32(1.0 / r.hz);
    for s in &r.stretches {
        if s.busy <= budget {
            continue;
        }
        let end = s.from + s.busy;
        let (engine, items) = engine_around(s.from.checked_sub(budget * 2).unwrap_or(s.from), end);
        let stacks: Vec<Vec<u64>> = sampler::take_since(s.from, end).into_iter().map(|x| x.frames).collect();
        out.push((
            json!({
                "kind": "stall",
                "t": wall_of(end),
                "platform": std::env::consts::OS,
                "route": r.route,
                "step": r.step,
                "hz": r.hz.round(),
                "budget": r2(ms(budget)),
                "busy": r2(ms(s.busy)),
                "a11y": r.a11y,
                "reason": format!(
                    "main thread busy {:.1} ms in a wake-up that drew nothing{}",
                    ms(s.busy),
                    if items > 0 { format!("; {items} mount items applied around it") } else { String::new() }
                ),
                "engine": engine,
                "jsSecond": r.js.long,
            }),
            stacks,
        ));
    }
    out
}

/// The self-test's verdicts (writer thread): every frame, stretch and
/// engine commit is put in the step it happened in (`STEP_LOG`), and the
/// verdicts are written once the scenario says "done".
#[derive(Default)]
struct SelfTest {
    steps: Vec<(String, StepAgg)>,
    written: bool,
    /// The engine commits up to here are counted.
    counted_to: Option<Instant>,
}

#[derive(Default, Clone)]
struct StepAgg {
    frames: u32,
    late: u32,
    late_refreshes: u32,
    cost_max: f32,
    stall_max: f32,
    items: u64,
    js_long_max: f64,
    /// How long the step ran (from the step log).
    secs: f32,
    hz: f32,
}

impl SelfTest {
    fn agg(&mut self, step: &str) -> Option<&mut StepAgg> {
        if step.is_empty() || step == "done" || step == "start" {
            return None;
        }
        let i = match self.steps.iter().position(|(s, _)| s == step) {
            Some(i) => i,
            None => {
                self.steps.push((step.to_owned(), StepAgg::default()));
                self.steps.len() - 1
            }
        };
        Some(&mut self.steps[i].1)
    }

    fn feed(&mut self, r: &SecondRaw) -> Option<JsonValue> {
        let log = STEP_LOG.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if log.is_empty() {
            return None;
        }
        for f in &r.frames {
            let step = step_at(&log, f.end).to_owned();
            if let Some(a) = self.agg(&step) {
                a.frames += 1;
                a.late += (f.late > 0) as u32;
                a.late_refreshes += f.late;
                a.cost_max = a.cost_max.max(ms(f.cost));
                a.hz = r.hz;
            }
        }
        for st in &r.stretches {
            let step = step_at(&log, st.from).to_owned();
            if let Some(a) = self.agg(&step) {
                a.stall_max = a.stall_max.max(ms(st.busy));
            }
        }
        let recent = RECENT.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let from = self.counted_to.unwrap_or(log[0].0);
        self.counted_to = Some(r.now);
        for e in recent.iter().filter(|e| e.kind == "commit" && e.at > from && e.at <= r.now) {
            let step = step_at(&log, e.at).to_owned();
            if let Some(a) = self.agg(&step) {
                a.items += e.items;
            }
        }
        for v in &r.js.long {
            if let Some(a) = v.as_array()
                && let Some(label) = a.get(1).and_then(JsonValue::as_str)
                && label.contains("jsblock")
            {
                let ms = a.first().and_then(JsonValue::as_f64).unwrap_or(0.0);
                // The task names its step ("selftest jsblock 30").
                let step = self.steps.iter().map(|(s, _)| s.clone()).find(|s| s.contains("jsblock"));
                if let Some(step) = step
                    && let Some(agg) = self.agg(&step)
                {
                    agg.js_long_max = agg.js_long_max.max(ms);
                }
            }
        }
        if step_at(&log, r.now) != "done" || self.written {
            if step_at(&log, r.now) != "done" {
                self.written = false;
            }
            return None;
        }
        // Each step ran until the next began (steps with nothing in them,
        // a clean idle, are steps too).
        for (_, step) in &log {
            let _ = self.agg(step);
        }
        for (i, (t, step)) in log.iter().enumerate() {
            let end = log.get(i + 1).map_or(r.now, |(n, _)| *n);
            if let Some(a) = self.steps.iter_mut().find(|(s, _)| s == step).map(|(_, a)| a) {
                a.secs += end.saturating_duration_since(*t).as_secs_f32();
            }
        }
        self.written = true;
        // In the order the steps ran.
        let order = |name: &str| log.iter().position(|(_, s)| s == name).unwrap_or(usize::MAX);
        self.steps.sort_by_key(|(s, _)| order(s));
        let v = self.verdicts();
        self.steps.clear();
        Some(v)
    }

    fn verdicts(&self) -> JsonValue {
        let mut out = Vec::new();
        let mut all = true;
        for (step, a) in &self.steps {
            let name = step.split_once(' ').map_or(step.as_str(), |(_, s)| s);
            let (kind, arg) = name.split_once(':').unwrap_or((name, ""));
            let n: f32 = arg.split(':').next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
            let hz = if a.hz > 0.0 { a.hz } else { 120.0 };
            let budget = 1e3 / hz;
            let fps = if a.secs > 0.0 { a.frames as f32 / a.secs } else { 0.0 };
            let (pass, expect) = match kind {
                // After idleness the blocked frame is the first of its run:
                // never late by definition. Its cost is the check.
                "block" => (
                    a.cost_max >= n * 0.9 && a.cost_max <= n + budget * 2.0,
                    format!("one frame of ~{n} ms main-thread work"),
                ),
                // Blocked inside a scroll run: late on glass by about the
                // refreshes the block covered.
                "blockscroll" => {
                    let want = (n / budget).round() - 1.0;
                    let lr = a.late_refreshes as f32;
                    (
                        a.cost_max >= n * 0.9 && a.late >= 1 && lr >= want - 2.0 && lr <= want + 3.0,
                        format!("a ~{n} ms frame during a scroll, late by ~{want} refreshes"),
                    )
                }
                "jsblock" => (
                    a.js_long_max >= n as f64 * 0.8 && a.cost_max < budget * 2.0,
                    format!("a ~{n} ms JS task, no slow frame"),
                ),
                "flood" if n > 0.0 => (
                    a.items as f32 >= n || a.stall_max > budget || a.cost_max > budget,
                    format!("{n} mount items applied (or a stall / slow frame applying them)"),
                ),
                "idle" => (fps <= 2.0 && a.late == 0, "no frames, none late".to_owned()),
                "scrollanim" => (
                    fps >= hz * 0.8 && a.late as f32 <= a.secs.max(1.0) * 2.0,
                    "frames ≈ Hz, ≤ 2 late a second".to_owned(),
                ),
                _ => continue,
            };
            all &= pass;
            out.push(json!({
                "step": step,
                "pass": pass,
                "expect": expect,
                "seen": {
                    "seconds": r2(a.secs),
                    "frames": a.frames,
                    "framesPerSecond": r2(fps),
                    "late": a.late,
                    "lateRefreshes": a.late_refreshes,
                    "costMaxMs": r2(a.cost_max),
                    "stallMaxMs": r2(a.stall_max),
                    "items": a.items,
                    "jsTaskMs": a.js_long_max,
                },
            }));
        }
        json!({ "kind": "selftest", "pass": all, "steps": out })
    }
}

/// Self-test: keeps the main thread busy for exactly `ms` (a stack sample
/// taken meanwhile names this function).
#[inline(never)]
fn selftest_block(ms: u64) {
    let until = Instant::now() + Duration::from_millis(ms);
    let mut x = 0u64;
    while Instant::now() < until {
        x = std::hint::black_box(x.wrapping_mul(6364136223846793005).wrapping_add(1));
    }
    std::hint::black_box(x);
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let block = std::mem::take(&mut self.block);
        if block > 0 {
            selftest_block(block);
        }
        div().size_full().relative().child(self.app.clone())
    }
}

pub(crate) fn run(source: AppSource, options: AppOptions) -> std::process::ExitCode {
    let ok = Rc::new(Cell::new(true));
    let result = ok.clone();
    gpui_platform::application().run(move |cx| {
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        if let Err(err) = open(source, options, cx) {
            log::error!("cannot open a window: {err}");
            ok.set(false);
            cx.quit();
            return;
        }
        cx.activate(true);
    });
    if result.get() { std::process::ExitCode::SUCCESS } else { std::process::ExitCode::FAILURE }
}

fn open(source: AppSource, options: AppOptions, cx: &mut gpui::App) -> gpui::Result<()> {
    let size = gpui::size(px(options.size.0 as f32), px(options.size.1 as f32));
    let bounds = gpui::Bounds::centered(None, size, cx);
    let window_options = gpui::WindowOptions {
        window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
        titlebar: Some(nsh_platform_gpui::titlebar_options(&options.title)),
        app_id: Some(options.app_id.clone()),
        window_decorations: Some(gpui::WindowDecorations::Server),
        // GPUI draws unfocused windows at 30 fps by default.
        inactive_frame_interval: None,
        window_background: gpui::WindowBackgroundAppearance::Opaque,
        ..Default::default()
    };
    cx.open_window(window_options, move |window, cx| {
        let view: Entity<AppView> = cx.new(|cx| AppView::new(options, window, cx));
        view.read(cx).own_window(window, cx);
        #[allow(unreachable_patterns)]
        match source {
            AppSource::Rust(root) => view.read(cx).load(NshApp::Rust(root)),
            AppSource::Bundle(bundle) => view.read(cx).load(NshApp::Js(bundle)),
            _ => log::error!("unsupported app source"),
        }
        let focus = view.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        cx.new(|cx| Shell::new(view, cx))
    })?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_lines_add_up_to_busy_time_and_long_tasks() {
        *ENGINE.lock().unwrap() = EngineSecond::default();
        engine_line("event Press on view 812");
        engine_line("event js: 9000µs");
        engine_line("commit: 56 ops, 3950µs (list js 6µs), 49 mount items, 21 nodes");
        engine_line("commit: 10 ops, 151µs (list js 2µs), 8 mount items, 27 nodes");
        engine_line("turn: 1151µs (timers and tasks 1000µs)");
        engine_line("fps 118 active 118/118 gap 8.3/8.3/8.4/9.0");
        let e = std::mem::take(&mut *ENGINE.lock().unwrap());
        assert_eq!(e.commits, 2);
        assert_eq!(e.items, 57);
        assert_eq!(e.commit_max_us, 3950);
        // 9000 + 3950 + 151 + (1151 - 151): the turn includes its commit.
        assert_eq!(e.busy_us, 9000 + 3950 + 151 + 1000);
        assert_eq!(e.long.len(), 1);
        assert_eq!(e.long[0].1, "event Press on view 812");
        assert_eq!(e.worst.unwrap().1, "event Press on view 812");
        assert_eq!(nsh_fps(e.nsh.as_deref()), Some(118));
        let r = RECENT.lock().unwrap();
        assert!(r.iter().any(|e| e.kind == "commit" && e.items == 49 && e.ops == 56));
    }

    #[test]
    fn numbers_after_keys() {
        assert_eq!(num_after("56 ops, 395µs (list js 6µs)", ""), Some(56));
        assert_eq!(num_after("56 ops, 395µs (list js 6µs)", "ops,"), Some(395));
        assert_eq!(num_after("x), 49 mount items", "),"), Some(49));
        assert_eq!(num_after("nothing", "ops,"), None);
        assert_eq!(nsh_fps(Some("fps 121 active 121/121 gap 8.39")), Some(121));
        assert_eq!(nsh_fps(None), None);
    }

    #[test]
    fn percentiles() {
        let v = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(pct(&v, 0.95), 4.0);
        assert_eq!(pct(&v, 0.5), 2.0);
        assert_eq!(pct(&[], 0.95), 0.0);
        assert_eq!(mean(&v), 2.5);
    }

    /// The self-test block keeps the thread busy as long as asked.
    #[test]
    fn the_selftest_block_is_exact() {
        let t = Instant::now();
        selftest_block(20);
        let d = t.elapsed();
        assert!(d >= Duration::from_millis(20) && d < Duration::from_millis(30), "{d:?}");
    }

    fn second(now: Instant, frames: Vec<FrameRec>, stretches: Vec<Stretch>, js: Vec<JsonValue>) -> SecondRaw {
        SecondRaw {
            wall: SystemTime::now(),
            now,
            hz: 120.0,
            route: "home".into(),
            step: String::new(),
            frames,
            stretches,
            engine: EngineSecond::default(),
            js: JsSecond { long: js, ..Default::default() },
            record: true,
            a11y: false,
            present_times: true,
            nsh_windows: Vec::new(),
        }
    }

    fn frame_at(end: Instant, cost_ms: f64, late: u32) -> FrameRec {
        FrameRec {
            seq: 1,
            from: end,
            end,
            cost: Duration::from_secs_f64(cost_ms / 1e3),
            wait: Duration::ZERO,
            period: Duration::from_nanos(8_333_333),
            presented: Some(1.0),
            late,
            gap_ms: None,
            since_vsync_ms: None,
            reported: true,
        }
    }

    #[test]
    fn the_selftest_says_pass_or_fail_per_step_from_each_frames_own_step() {
        let ms = |n: u64| Duration::from_millis(n);
        let t0 = Instant::now();
        let steps = [
            (0, "2 block:20"),
            (1000, "4 blockscroll:50"),
            (2000, "6 jsblock:30"),
            (3000, "8 flood:2000"),
            (4000, "10 idle:2000"),
            (6000, "12 scrollanim:1200:2000"),
            (8000, "14 idle:1500"),
            (9500, "done"),
        ];
        *STEP_LOG.lock().unwrap() = steps.iter().map(|(t, s)| (t0 + ms(*t), s.to_string())).collect();
        RECENT.lock().unwrap().push(EngineEvent {
            at: t0 + ms(3100),
            kind: "commit",
            us: 4000,
            ops: 2000,
            items: 2004,
            label: String::new(),
        });
        let mut st = SelfTest::default();
        let mut frames = vec![frame_at(t0 + ms(100), 21.0, 0)];
        // During the scroll run: one 50 ms frame, 5 refreshes late.
        frames.push(frame_at(t0 + ms(1200), 50.5, 5));
        frames.extend((0..100).map(|i| frame_at(t0 + ms(1300 + i * 8), 1.0, 0)));
        // The scrollanim step's frames; the idle after it: one stray frame
        // at its very start (allowed) — the idle step is its own.
        frames.extend((0..238).map(|i| frame_at(t0 + ms(6000 + i * 8), 1.5, 0)));
        frames.push(frame_at(t0 + ms(8001), 1.0, 0));
        // The second idle has frames: it fails.
        frames.extend((0..30).map(|i| frame_at(t0 + ms(8100 + i * 30), 1.0, 0)));
        let js = vec![json!([30.0, "selftest jsblock 30"])];
        let v = st.feed(&second(t0 + ms(9900), frames, vec![], js)).expect("the verdicts");
        let got: Vec<(String, bool)> = v["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["step"].as_str().unwrap().to_owned(), s["pass"].as_bool().unwrap()))
            .collect();
        assert_eq!(
            got,
            [
                ("2 block:20".to_owned(), true),
                ("4 blockscroll:50".to_owned(), true),
                ("6 jsblock:30".to_owned(), true),
                ("8 flood:2000".to_owned(), true),
                ("10 idle:2000".to_owned(), true),
                ("12 scrollanim:1200:2000".to_owned(), true),
                ("14 idle:1500".to_owned(), false),
            ],
            "{v}"
        );
        assert_eq!(v["pass"], json!(false));
        STEP_LOG.lock().unwrap().clear();
    }

    #[test]
    fn a_late_frame_with_no_main_thread_cause_says_so() {
        let f = frame_at(Instant::now(), 1.0, 1);
        assert!(reason(&f, Duration::ZERO, 0).contains("no main-thread cause"));
        let mut g = frame_at(Instant::now(), 12.0, 1);
        g.wait = Duration::from_millis(9);
        let r = reason(&g, Duration::ZERO, 0);
        assert!(r.contains("main-thread work 12.0") && r.contains("waited 9.0 ms"));
    }
}
