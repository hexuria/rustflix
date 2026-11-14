//! Main-thread stack samples for slow frames (macOS on Apple silicon).
//!
//! While the monitor measures, a watchdog thread looks at the main thread
//! every 2 ms. When the run loop's current wake-up has run longer than one
//! refresh, it suspends the main thread (`thread_suspend`), reads its
//! registers (`thread_get_state`, `ARM_THREAD_STATE64`), walks its frame
//! pointers (arm64 Apple code always keeps them) within the thread's stack,
//! and resumes it — a few microseconds, at most 4 samples per wake-up, 2 ms
//! apart. Nothing is allocated while the thread is suspended (it may hold
//! the allocator's lock). The samples are raw return addresses with their
//! time; the recorder keeps those inside a slow frame and the writer
//! symbolicates them (`dladdr` for system libraries; addresses in the app's
//! own binary are written as offsets for `atos`, as only its symbol table
//! names them).

use std::{
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

/// Frames kept per sample.
pub(crate) const DEPTH: usize = 48;

/// One sample of the main thread's stack.
#[derive(Clone)]
pub(crate) struct Sample {
    pub(crate) at: Instant,
    pub(crate) frames: Vec<u64>,
}

fn base() -> Instant {
    static BASE: OnceLock<Instant> = OnceLock::new();
    *BASE.get_or_init(Instant::now)
}

pub(crate) fn ns(at: Instant) -> u64 {
    at.saturating_duration_since(base()).as_nanos() as u64
}

/// The main thread's current wake-up began (ns since `base`); 0: asleep.
static WAKE_NS: AtomicU64 = AtomicU64::new(0);
/// One refresh, in ns.
static BUDGET_NS: AtomicU64 = AtomicU64::new(8_333_333);
static RUNNING: AtomicBool = AtomicBool::new(false);
static SAMPLES: Mutex<Vec<Sample>> = Mutex::new(Vec::new());

/// The run loop woke (`Some(now)`) or sleeps (`None`): called by the
/// observers.
pub(crate) fn awake(at: Option<Instant>) {
    WAKE_NS.store(at.map_or(0, |t| ns(t).max(1)), Ordering::Relaxed);
}

/// Time the main thread spent suspended for samples since the last call
/// (not the app's work: frames subtract it).
static SUSPENDED_NS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn take_suspended() -> Duration {
    Duration::from_nanos(SUSPENDED_NS.swap(0, Ordering::Relaxed))
}

pub(crate) fn set_budget(period: Duration) {
    BUDGET_NS.store(period.as_nanos() as u64, Ordering::Relaxed);
}

/// The samples taken between `from` and `to` (taken out; the others stay
/// for the frames and stalls around them).
pub(crate) fn take_since(from: Instant, to: Instant) -> Vec<Sample> {
    let mut all = SAMPLES.lock().unwrap_or_else(|p| p.into_inner());
    let inside = |s: &Sample| s.at >= from && s.at <= to;
    let out: Vec<Sample> = all.iter().filter(|s| inside(s)).cloned().collect();
    all.retain(|s| !inside(s));
    out
}

/// Drops samples older than `before` (frames that were not slow).
pub(crate) fn forget_before(before: Instant) {
    let mut all = SAMPLES.lock().unwrap_or_else(|p| p.into_inner());
    all.retain(|s| s.at >= before);
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod imp {
    use super::*;

    type Port = u32;
    const ARM_THREAD_STATE64: i32 = 6;
    const ARM_THREAD_STATE64_COUNT: u32 = 68;

    unsafe extern "C" {
        fn thread_suspend(thread: Port) -> i32;
        fn thread_resume(thread: Port) -> i32;
        fn thread_get_state(thread: Port, flavor: i32, state: *mut u32, count: *mut u32) -> i32;
    }

    #[repr(C)]
    #[derive(Default)]
    struct State {
        x: [u64; 29],
        fp: u64,
        lr: u64,
        sp: u64,
        pc: u64,
        cpsr: u32,
        pad: u32,
    }

    /// Pointer-authentication bits off (system code is arm64e).
    fn strip(p: u64) -> u64 {
        p & 0x0000_7FFF_FFFF_FFFF
    }

    struct Main {
        port: Port,
        lo: u64,
        hi: u64,
    }

    static MAIN: OnceLock<Main> = OnceLock::new();

    /// Remembers the main thread (call on it).
    pub(crate) fn init_on_main() {
        MAIN.get_or_init(|| {
            // SAFETY: pthread queries of the calling (main) thread.
            unsafe {
                let me = libc::pthread_self();
                let hi = libc::pthread_get_stackaddr_np(me) as u64;
                let size = libc::pthread_get_stacksize_np(me) as u64;
                Main { port: libc::pthread_mach_thread_np(me), lo: hi.saturating_sub(size), hi }
            }
        });
    }

    /// One sample into `out`; how many frames.
    fn sample(main: &Main, out: &mut [u64; DEPTH]) -> usize {
        let mut st = State::default();
        let mut count = ARM_THREAD_STATE64_COUNT;
        let mut n = 0;
        // SAFETY: suspends another thread of this process and reads its
        // registers and stack memory within its stack's bounds, then
        // resumes it; nothing here allocates or takes a lock.
        unsafe {
            if thread_suspend(main.port) != 0 {
                return 0;
            }
            let ok = thread_get_state(main.port, ARM_THREAD_STATE64, (&mut st as *mut State).cast(), &mut count) == 0;
            if ok {
                out[n] = strip(st.pc);
                n += 1;
                out[n] = strip(st.lr);
                n += 1;
                let mut fp = strip(st.fp);
                while n < DEPTH && fp >= main.lo && fp + 16 <= main.hi && fp % 8 == 0 {
                    let next = std::ptr::read_volatile(fp as *const u64);
                    let ret = std::ptr::read_volatile((fp + 8) as *const u64);
                    let ret = strip(ret);
                    if ret == 0 {
                        break;
                    }
                    out[n] = ret;
                    n += 1;
                    let next = strip(next);
                    if next <= fp {
                        break;
                    }
                    fp = next;
                }
            }
            thread_resume(main.port);
        }
        n
    }

    /// Starts the watchdog (once; it idles while `RUNNING` is off).
    pub(crate) fn start() {
        RUNNING.store(true, Ordering::Relaxed);
        static STARTED: AtomicBool = AtomicBool::new(false);
        if STARTED.swap(true, Ordering::Relaxed) {
            return;
        }
        let spawned = std::thread::Builder::new().name("rustflix-perf-watchdog".into()).spawn(|| {
            let mut buf = [0u64; DEPTH];
            let mut sampled_wake = 0u64;
            let mut taken = 0;
            let mut last = 0u64;
            loop {
                std::thread::sleep(Duration::from_millis(if RUNNING.load(Ordering::Relaxed) { 2 } else { 200 }));
                if !RUNNING.load(Ordering::Relaxed) {
                    continue;
                }
                let Some(main) = MAIN.get() else { continue };
                let wake = WAKE_NS.load(Ordering::Relaxed);
                if wake == 0 {
                    continue;
                }
                let now = Instant::now();
                let now_ns = ns(now);
                if wake != sampled_wake {
                    sampled_wake = wake;
                    taken = 0;
                }
                let budget = BUDGET_NS.load(Ordering::Relaxed);
                // From half a refresh: a wake-up that long is on its way to
                // a slow frame or a stall.
                if now_ns.saturating_sub(wake) < budget / 2 || taken >= 6 || now_ns.saturating_sub(last) < 2_000_000 {
                    continue;
                }
                let t0 = Instant::now();
                let n = sample(main, &mut buf);
                SUSPENDED_NS.fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
                if n == 0 {
                    continue;
                }
                taken += 1;
                last = now_ns;
                let mut all = SAMPLES.lock().unwrap_or_else(|p| p.into_inner());
                if all.len() >= 512 {
                    all.drain(..256);
                }
                all.push(Sample { at: now, frames: buf[..n].to_vec() });
            }
        });
        if let Err(e) = spawned {
            log::warn!("perf: no watchdog thread: {e}");
        }
    }

    pub(crate) fn stop() {
        RUNNING.store(false, Ordering::Relaxed);
        SAMPLES.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    /// `frame` symbolicated: `"0x1234"` (an offset in the app's binary,
    /// for `atos -o <binary> -l 0x100000000`) or `"AppKit`-[NSView …]+12"`.
    pub(crate) fn describe(frame: u64, exe: &str) -> String {
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        // SAFETY: dladdr fills `info` with pointers into dyld's tables.
        let found = unsafe { libc::dladdr(frame as *const libc::c_void, &mut info) } != 0;
        if !found || info.dli_fname.is_null() {
            return format!("0x{frame:x}");
        }
        // SAFETY: C strings from dyld, valid for the process' life.
        let file = unsafe { std::ffi::CStr::from_ptr(info.dli_fname) }.to_string_lossy();
        let base = info.dli_fbase as u64;
        if file == exe {
            // Offset from the image's load address, plus the default
            // __TEXT address: what `atos -l 0x100000000` takes.
            return format!("0x{:x}", frame - base + 0x1_0000_0000);
        }
        let lib = file.rsplit('/').next().unwrap_or(&file).to_owned();
        if info.dli_sname.is_null() {
            return format!("{lib}+0x{:x}", frame - base);
        }
        // SAFETY: as above.
        let sym = unsafe { std::ffi::CStr::from_ptr(info.dli_sname) }.to_string_lossy();
        format!("{lib}`{sym}+{}", frame.saturating_sub(info.dli_saddr as u64))
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
mod imp {
    pub(crate) fn init_on_main() {}
    pub(crate) fn start() {}
    pub(crate) fn stop() {}
    pub(crate) fn describe(frame: u64, _exe: &str) -> String {
        format!("0x{frame:x}")
    }
}

pub(crate) use imp::{describe, init_on_main, start, stop};
