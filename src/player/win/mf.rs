//! The Windows player core: one `IMFMediaEngine` per source, in frame-server
//! mode (no window of its own), on a D3D11 device of its own.
//!
//! Threads. Each player has one worker thread (COM MTA) that owns
//! everything Media Foundation and Direct3D: the device, the engine, its
//! timed-text service, the textures. Nothing else calls them. The app's
//! calls (props, `sys.nativeVideo`, commands) and Media Foundation's own
//! callbacks (`IMFMediaEngineNotify`, `IMFTimedTextNotify`, called on its
//! work-queue threads) only queue a [`Msg`] for that thread. The main
//! thread never waits on Media Foundation: it reads the newest frame from a
//! mutexed slot ([`Player::frame`]) and paints it.
//!
//! Frames. While the media plays (or a seek, a source change or a size
//! change wants a new picture), the worker asks the engine every 8 ms
//! whether a new frame is due (`OnVideoStreamTick`). A new one is scaled
//! into a BGRA texture (`TransferVideoFrame`), copied to a staging texture,
//! read back once into the buffer GPUI's image owns (alpha forced opaque:
//! GPUI blends by it), and published; then the component is asked to
//! redraw. A paused picture makes no new frames, so nothing redraws, and
//! the worker only wakes for its 4 Hz tick.
//!
//! The tick sends `progress` (4 Hz) and is the fallback for `seeked` and
//! `end`, like the Linux player's.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant},
};

use image::{Frame, ImageBuffer, Rgba};
use nsh_platform_gpui::gpui::RenderImage;
use serde_json::{Value, json};
use smallvec::SmallVec;
use windows::Win32::{
    Foundation::{HMODULE, RECT},
    Graphics::{
        Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP},
        Direct3D10::ID3D10Multithread,
        Direct3D11::{
            D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_MAP_READ,
            D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
            D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
            ID3D11DeviceContext, ID3D11Texture2D,
        },
        Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
    },
    Media::MediaFoundation::*,
    System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize,
        StructuredStorage::{PropVariantToGUID, PropVariantToStringAlloc},
    },
};
use windows_core::{BOOL, BSTR, HRESULT, Interface, PWSTR, Ref, implement};

use super::{Fit, size_of};

pub(crate) static LIVE: AtomicUsize = AtomicUsize::new(0);
pub(crate) static PLAYING: AtomicUsize = AtomicUsize::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);
static SEQ: AtomicU64 = AtomicU64::new(1);

/// Events and redraws come from the worker thread.
pub(crate) type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub(crate) type Redraw = Arc<dyn Fn() + Send + Sync>;

/// One decoded frame as the image GPUI paints: BGRA, tightly packed.
pub(crate) struct FrameData {
    pub(crate) seq: u64,
    pub(crate) image: Arc<RenderImage>,
}

/// What the main thread reads: the newest frame and the fit.
#[derive(Default)]
struct Shared {
    latest: Option<Arc<FrameData>>,
    fit: Fit,
    /// The child window the picture goes to while `direct_on`
    /// (`super::direct`; 0: none), and the last frame's size.
    direct_hwnd: isize,
    direct_on: bool,
    picture: (u32, u32),
    /// `sys.nativeVideo {uncovered}`: nothing is drawn over the picture.
    uncovered: bool,
}

/// Work for the player's thread.
enum Msg {
    Src(Option<String>),
    StartAt(f64),
    Paused(bool),
    Muted(bool),
    Volume(f32),
    Rate(f32),
    MaxRes(Option<(f64, f64)>),
    /// The picture's size on screen, in pixels.
    Display(Option<(f64, f64)>),
    Seek(f64),
    Select { legible: bool, id: Option<String> },
    /// The picture's destination changed (`Shared::direct_on`).
    Direct,
    /// `IMFMediaEngineNotify::EventNotify` for the engine of generation `gen`.
    Event { generation: u64, event: u32, param1: usize, param2: u32 },
    /// The timed-text track list changed.
    TextTracks { generation: u64 },
    /// A timed-text cue became active (`on`) or inactive.
    Cue { generation: u64, track: u32, on: bool, start: f64, end: f64, now: f64, lines: Vec<String> },
    Shutdown,
}

// --- Registry (`sys.nativeVideo`) ----------------------------------------------

struct Entry {
    tx: Sender<Msg>,
    shared: Weak<Mutex<Shared>>,
    redraw: Redraw,
}

fn registry() -> &'static Mutex<HashMap<u64, Entry>> {
    static REG: OnceLock<Mutex<HashMap<u64, Entry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `sys.nativeVideo {handle, …}`: the player's props and commands without
/// a frame of the window (same fields as `super::super::av::control`).
/// False when there is no such player.
pub(crate) fn control(handle: u64, data: &Value) -> bool {
    let reg = registry().lock().unwrap();
    let Some(e) = reg.get(&handle) else { return false };
    let send = |m: Msg| {
        let _ = e.tx.send(m);
    };
    if let Some(v) = data.get("muted").and_then(Value::as_bool) {
        send(Msg::Muted(v));
    }
    if let Some(v) = data.get("volume").and_then(Value::as_f64) {
        send(Msg::Volume(v as f32));
    }
    if let Some(v) = data.get("rate").and_then(Value::as_f64) {
        send(Msg::Rate(v as f32));
    }
    if let Some(v) = data.get("fit").and_then(Value::as_str) {
        if let Some(shared) = e.shared.upgrade() {
            shared.lock().unwrap().fit = Fit::parse(Some(v));
        }
        (e.redraw)();
    }
    if let Some(v) = data.get("maxResolution") {
        send(Msg::MaxRes(size_of(Some(v))));
    }
    if let Some(v) = data.get("uncovered").and_then(Value::as_bool) {
        if let Some(shared) = e.shared.upgrade() {
            shared.lock().unwrap().uncovered = v;
        }
        (e.redraw)();
    }
    if let Some(f) = data.get("frame") {
        // Points; the component sends the size in pixels once it draws.
        send(Msg::Display(size_of(Some(f))));
    }
    if let Some(v) = data.get("startAt").and_then(Value::as_f64) {
        send(Msg::StartAt(v));
    }
    if let Some(v) = data.get("paused").and_then(Value::as_bool) {
        send(Msg::Paused(v));
    }
    match data.get("src") {
        Some(Value::String(u)) => send(Msg::Src(Some(u.clone()))),
        Some(Value::Null) => send(Msg::Src(None)),
        _ => {}
    }
    if let Some(t) = data.get("seek").and_then(Value::as_f64) {
        send(Msg::Seek(t));
    }
    if let Some(id) = data.get("selectAudio").and_then(Value::as_str) {
        send(Msg::Select { legible: false, id: Some(id.to_owned()) });
    }
    match data.get("selectSubtitle") {
        Some(Value::String(id)) => send(Msg::Select { legible: true, id: Some(id.clone()) }),
        Some(Value::Null) => send(Msg::Select { legible: true, id: None }),
        _ => {}
    }
    // `pip`, `nowPlaying`: no picture in picture or Now Playing on Windows.
    true
}

/// `sys.nativeVideoInfo.available`: Media Foundation's media engine can be
/// made here (it is missing from Windows N editions without the Media
/// Feature Pack, and from Server without Desktop Experience). Probed once,
/// on a thread of its own (COM).
pub(crate) fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::thread::spawn(|| {
            let _com = Com::init();
            // SAFETY: plain COM/MF calls on this thread, which COM was
            // initialised on; MFShutdown balances MFStartup.
            unsafe {
                if MFStartup(MF_VERSION, MFSTARTUP_FULL).is_err() {
                    return false;
                }
                let ok = CoCreateInstance::<_, IMFMediaEngineClassFactory>(
                    &CLSID_MFMediaEngineClassFactory,
                    None,
                    CLSCTX_INPROC_SERVER,
                )
                .is_ok();
                let _ = MFShutdown();
                ok
            }
        })
        .join()
        .unwrap_or(false)
    })
}

// --- The player (main-thread side) ------------------------------------------------

pub(crate) struct Player {
    id: u64,
    tx: Sender<Msg>,
    shared: Arc<Mutex<Shared>>,
}

impl Player {
    pub(crate) fn new(emit: Emit, redraw: Redraw) -> Player {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Mutex::new(Shared::default()));
        registry().lock().unwrap().insert(
            id,
            Entry { tx: tx.clone(), shared: Arc::downgrade(&shared), redraw: redraw.clone() },
        );
        LIVE.fetch_add(1, Ordering::Relaxed);
        let worker_tx = tx.clone();
        let worker_shared = shared.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("rustflix-player-{id}"))
            .spawn(move || Worker::new(id, emit, redraw, worker_shared, worker_tx).run(rx));
        if let Err(e) = spawned {
            log::error!("player {id}: cannot start its thread: {e}");
        }
        Player { id, tx, shared }
    }

    /// The handle `sys.nativeVideo` reaches this player by.
    pub(crate) fn handle(&self) -> u64 {
        self.id
    }

    fn send(&self, m: Msg) {
        let _ = self.tx.send(m);
    }

    pub(crate) fn set_src(&self, url: Option<&str>) {
        self.send(Msg::Src(url.map(str::to_owned)));
    }

    pub(crate) fn set_start_at(&self, secs: f64) {
        self.send(Msg::StartAt(secs));
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.send(Msg::Paused(paused));
    }

    pub(crate) fn set_muted(&self, muted: bool) {
        self.send(Msg::Muted(muted));
    }

    pub(crate) fn set_volume(&self, volume: f32) {
        self.send(Msg::Volume(volume));
    }

    pub(crate) fn set_rate(&self, rate: f32) {
        self.send(Msg::Rate(rate));
    }

    pub(crate) fn set_fit(&self, fit: Fit) {
        self.shared.lock().unwrap().fit = fit;
    }

    pub(crate) fn fit(&self) -> Fit {
        self.shared.lock().map(|s| s.fit).unwrap_or_default()
    }

    pub(crate) fn set_max_resolution(&self, size: Option<(f64, f64)>) {
        self.send(Msg::MaxRes(size));
    }

    /// The picture's size on screen in pixels (the default decode cap).
    pub(crate) fn set_display_size(&self, size: Option<(f64, f64)>) {
        self.send(Msg::Display(size));
    }

    /// Seeks to `secs`; a `seeked` event follows.
    pub(crate) fn seek(&self, secs: f64) {
        self.send(Msg::Seek(secs));
    }

    /// `selectAudio` / `selectSubtitle` (`None`: subtitles off).
    pub(crate) fn select(&self, legible: bool, id: Option<&str>) {
        self.send(Msg::Select { legible, id: id.map(str::to_owned) });
    }

    /// Sends the picture to the child window `hwnd` (`super::direct`)
    /// instead of GPUI, or back.
    pub(crate) fn set_direct(&self, on: bool, hwnd: isize) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.direct_on = on;
            shared.direct_hwnd = hwnd;
        }
        self.send(Msg::Direct);
    }

    /// Whether the app says nothing is drawn over the picture.
    pub(crate) fn uncovered(&self) -> bool {
        self.shared.lock().map(|s| s.uncovered).unwrap_or(false)
    }

    /// The size of the last frame made, in pixels.
    pub(crate) fn picture_size(&self) -> (u32, u32) {
        self.shared.lock().map(|s| s.picture).unwrap_or_default()
    }

    /// The newest frame for the component to paint.
    pub(crate) fn frame(&self) -> Option<Arc<FrameData>> {
        self.shared.lock().ok()?.latest.clone()
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        registry().lock().unwrap().remove(&self.id);
        self.send(Msg::Shutdown);
        LIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

// --- Media Foundation callbacks -------------------------------------------------

#[implement(IMFMediaEngineNotify)]
struct Notify {
    tx: Mutex<Sender<Msg>>,
    generation: u64,
}

impl IMFMediaEngineNotify_Impl for Notify_Impl {
    fn EventNotify(&self, event: u32, param1: usize, param2: u32) -> windows_core::Result<()> {
        // Progress and time updates are the tick's job; the rest is queued.
        if event != MF_MEDIA_ENGINE_EVENT_TIMEUPDATE.0 as u32
            && event != MF_MEDIA_ENGINE_EVENT_PROGRESS.0 as u32
        {
            let _ = self.tx.lock().unwrap().send(Msg::Event {
                generation: self.generation,
                event,
                param1,
                param2,
            });
        }
        Ok(())
    }
}

#[implement(IMFTimedTextNotify)]
struct TextNotify {
    tx: Mutex<Sender<Msg>>,
    generation: u64,
}

impl TextNotify_Impl {
    fn tracks_changed(&self) {
        let _ = self.tx.lock().unwrap().send(Msg::TextTracks { generation: self.generation });
    }
}

impl IMFTimedTextNotify_Impl for TextNotify_Impl {
    fn TrackAdded(&self, _id: u32) {
        self.tracks_changed();
    }
    fn TrackRemoved(&self, _id: u32) {
        self.tracks_changed();
    }
    fn TrackSelected(&self, _id: u32, _selected: BOOL) {
        self.tracks_changed();
    }
    fn TrackReadyStateChanged(&self, _id: u32) {}
    fn Error(&self, code: MF_TIMED_TEXT_ERROR_CODE, extended: HRESULT, track: u32) {
        log::debug!("player: timed text error {} ({extended:?}) on track {track}", code.0);
    }
    fn Cue(&self, event: MF_TIMED_TEXT_CUE_EVENT, now: f64, cue: Ref<IMFTimedTextCue>) {
        let on = event == MF_TIMED_TEXT_CUE_EVENT_ACTIVE;
        if !on && event != MF_TIMED_TEXT_CUE_EVENT_INACTIVE {
            return;
        }
        let Some(cue) = cue.as_ref() else { return };
        // SAFETY: the cue is valid for this call; its lines are read here.
        let (track, start, end, lines) = unsafe {
            let mut lines = Vec::new();
            for i in 0..cue.GetLineCount() {
                if let Ok(line) = cue.GetLine(i)
                    && let Ok(text) = line.GetText()
                {
                    let text = text.to_string().unwrap_or_default();
                    lines.extend(text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned));
                }
            }
            let start = cue.GetStartTime();
            (cue.GetTrackId(), start, start + cue.GetDuration(), lines)
        };
        let _ = self.tx.lock().unwrap().send(Msg::Cue {
            generation: self.generation,
            track,
            on,
            start,
            end,
            now,
            lines,
        });
    }
    fn Reset(&self) {}
}

// --- The worker -------------------------------------------------------------------

/// COM, initialised for this thread while the value lives.
struct Com(bool);

impl Com {
    fn init() -> Com {
        // SAFETY: balanced by CoUninitialize in Drop on the same thread.
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: this thread's successful CoInitializeEx.
            unsafe { CoUninitialize() };
        }
    }
}

#[derive(Clone)]
struct Track {
    id: String,
    label: String,
    lang: Option<String>,
    default: bool,
    selected: bool,
    /// The engine's stream index (audio) or the timed-text track id.
    key: u32,
}

impl Track {
    fn json(&self) -> Value {
        json!({
            "id": self.id, "label": self.label, "lang": self.lang,
            "default": self.default, "selected": self.selected,
        })
    }
}

/// The engine of one source, with what is made for it.
struct Media {
    engine: IMFMediaEngine,
    text: Option<IMFTimedText>,
    /// Kept alive while the engine may call them.
    _notify: IMFMediaEngineNotify,
    _text_notify: Option<IMFTimedTextNotify>,
}

/// The output textures, at one size.
struct Target {
    size: (u32, u32),
    texture: ID3D11Texture2D,
    staging: ID3D11Texture2D,
}

const TICK: Duration = Duration::from_millis(250);
/// Video frames painted by the component, for the tick's trace line.
pub(crate) static PAINTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// How often a new frame is asked for while one may be due.
const FRAME_POLL: Duration = Duration::from_millis(8);
/// How long `progress` reports `startAt` while the seek to it lands.
const LANDING: Duration = Duration::from_secs(10);
/// How long a picture-changing request (a seek, a size change, a new
/// source) keeps the frame poll going while paused.
const SETTLE: Duration = Duration::from_millis(1500);

struct Worker {
    id: u64,
    emit: Emit,
    redraw: Redraw,
    shared: Arc<Mutex<Shared>>,
    tx: Sender<Msg>,

    device: Option<(ID3D11Device, ID3D11DeviceContext, IMFDXGIDeviceManager)>,
    /// Frames through the CPU (`super::wic`) for the current engine, where
    /// there is no GPU; `None`: through `target` on the device.
    cpu: Option<super::wic::CpuTarget>,
    /// The picture outside GPUI (`super::direct`): the swap chain, whether
    /// frames go there now, and the last frame shown there.
    presenter: super::direct::Presenter,
    direct_live: bool,
    last_direct: Option<((u32, u32), Vec<u8>)>,
    media: Option<Media>,
    target: Option<Target>,
    /// Bumped for every new engine; callbacks of an older one are dropped.
    generation: u64,

    src: Option<String>,
    start_at: f64,
    paused: bool,
    muted: bool,
    volume: f32,
    rate: f32,
    max_res: Option<(f64, f64)>,
    display_res: Option<(f64, f64)>,

    started: Instant,
    metadata: bool,
    loaded: bool,
    failed: bool,
    ended: bool,
    playing: bool,
    stalled: bool,
    duration: Option<f64>,
    position: f64,
    native: (u32, u32),
    landing: Option<(f64, Instant)>,
    pending_seek: Option<(f64, Instant)>,
    last_pts: Option<i64>,
    frames: u64,
    settle_until: Option<Instant>,

    audio: Vec<Track>,
    subs: Vec<Track>,
    /// The timed-text track whose cues are shown (None: subtitles off).
    sel_text: Option<u32>,
    /// The cue on screen: its track and end.
    cue: Option<(u32, f64)>,
}

impl Worker {
    fn new(id: u64, emit: Emit, redraw: Redraw, shared: Arc<Mutex<Shared>>, tx: Sender<Msg>) -> Worker {
        Worker {
            id,
            emit,
            redraw,
            shared,
            tx,
            device: None,
            cpu: None,
            presenter: super::direct::Presenter::default(),
            direct_live: false,
            last_direct: None,
            media: None,
            target: None,
            generation: 0,
            src: None,
            start_at: 0.0,
            paused: false,
            muted: false,
            volume: 1.0,
            rate: 1.0,
            max_res: None,
            display_res: None,
            started: Instant::now(),
            metadata: false,
            loaded: false,
            failed: false,
            ended: false,
            playing: false,
            stalled: false,
            duration: None,
            position: 0.0,
            native: (0, 0),
            landing: None,
            pending_seek: None,
            last_pts: None,
            frames: 0,
            settle_until: None,
            audio: Vec::new(),
            subs: Vec::new(),
            sel_text: None,
            cue: None,
        }
    }

    fn run(mut self, rx: mpsc::Receiver<Msg>) {
        let _com = Com::init();
        // SAFETY: balanced by MFShutdown below, on this thread.
        let mf = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.is_ok();
        if !mf {
            log::error!("player {}: MFStartup failed", self.id);
        }
        let mut next_tick = Instant::now() + TICK;
        loop {
            let now = Instant::now();
            let wait = if self.wants_frames(now) {
                FRAME_POLL.min(next_tick.saturating_duration_since(now))
            } else {
                next_tick.saturating_duration_since(now)
            };
            match rx.recv_timeout(wait) {
                Ok(Msg::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(msg) => {
                    self.handle(msg);
                    // Drain what else is queued before the frame work.
                    while let Ok(msg) = rx.try_recv() {
                        if matches!(msg, Msg::Shutdown) {
                            self.teardown();
                            return self.finish(mf);
                        }
                        self.handle(msg);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            let now = Instant::now();
            if self.wants_frames(now) {
                self.pump_frame();
            }
            if now >= next_tick {
                next_tick = now + TICK;
                self.tick();
            }
        }
        self.teardown();
        self.finish(mf);
    }

    fn finish(mut self, mf: bool) {
        self.target = None;
        self.device = None;
        if mf {
            // SAFETY: balances this thread's MFStartup.
            let _ = unsafe { MFShutdown() };
        }
    }

    /// A new frame may be due: the media plays, or a picture-changing
    /// request is settling, or the first frame is still to come.
    fn wants_frames(&self, now: Instant) -> bool {
        if self.media.is_none() || self.failed || !self.metadata {
            return false;
        }
        (!self.paused && !self.ended)
            || self.frames == 0
            || self.settle_until.is_some_and(|t| now < t)
    }

    fn settle(&mut self) {
        self.settle_until = Some(Instant::now() + SETTLE);
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Src(url) => self.set_src(url),
            Msg::StartAt(s) => self.start_at = s,
            Msg::Paused(p) => self.set_paused(p),
            Msg::Muted(m) => {
                self.muted = m;
                if let Some(m) = &self.media {
                    // SAFETY: the engine is used on this thread only.
                    let _ = unsafe { m.engine.SetMuted(self.muted) };
                }
            }
            Msg::Volume(v) => {
                self.volume = v.clamp(0.0, 1.0);
                if let Some(m) = &self.media {
                    // SAFETY: as above.
                    let _ = unsafe { m.engine.SetVolume(f64::from(self.volume)) };
                }
            }
            Msg::Rate(r) => self.set_rate(r),
            Msg::MaxRes(s) => {
                self.max_res = s;
                self.resized();
            }
            Msg::Display(s) => {
                if s != self.display_res {
                    self.display_res = s;
                    self.resized();
                }
            }
            Msg::Seek(t) => self.seek(t),
            Msg::Select { legible, id } => self.select(legible, id.as_deref()),
            Msg::Direct => self.direct_changed(),
            Msg::Event { generation, event, param1, param2 } => {
                if generation == self.generation {
                    self.on_event(event, param1, param2);
                }
            }
            Msg::TextTracks { generation } => {
                if generation == self.generation {
                    self.read_text_tracks();
                    self.emit_tracks();
                }
            }
            Msg::Cue { generation, track, on, start, end, now, lines } => {
                if generation == self.generation {
                    self.on_cue(track, on, start, end, now, lines);
                }
            }
            Msg::Shutdown => {}
        }
    }

    // --- Sources ---

    fn device(&mut self) -> Option<IMFDXGIDeviceManager> {
        if self.device.is_none() {
            self.device = make_device()
                .inspect_err(|e| log::error!("player {}: no D3D11 video device: {e}", self.id))
                .ok();
        }
        self.device.as_ref().map(|(_, _, m)| m.clone())
    }

    fn teardown(&mut self) {
        self.generation += 1;
        if let Some(m) = self.media.take() {
            // SAFETY: the engine is used on this thread only; Shutdown
            // releases its references to the notify objects.
            let _ = unsafe { m.engine.Shutdown() };
        }
        self.target = None;
        self.presenter.release();
        self.direct_live = false;
        self.last_direct = None;
        self.shared.lock().unwrap().latest = None;
        self.metadata = false;
        self.loaded = false;
        self.failed = false;
        self.ended = false;
        self.stalled = false;
        self.duration = None;
        self.native = (0, 0);
        self.landing = None;
        self.pending_seek = None;
        self.last_pts = None;
        self.frames = 0;
        self.audio.clear();
        self.subs.clear();
        self.sel_text = None;
        self.cue = None;
        self.set_playing_state(false);
    }

    fn set_src(&mut self, url: Option<String>) {
        // The same URL again changes nothing.
        if url == self.src {
            return;
        }
        log::debug!("player {}: src {url:?} (startAt {})", self.id, self.start_at);
        self.teardown();
        self.src = url.clone();
        self.started = Instant::now();
        self.position = self.start_at.max(0.0);
        let Some(url) = url else {
            (self.redraw)();
            return;
        };
        match self.open(&url) {
            Ok(media) => {
                self.media = Some(media);
                self.settle();
            }
            Err(e) => {
                self.failed = true;
                (self.emit)(
                    "error",
                    json!({ "message": format!("Media Foundation: {e}"), "code": "engine", "fatal": true }),
                );
            }
        }
        (self.redraw)();
    }

    /// A media engine for `url`, loading; playback starts once its metadata
    /// is in (`on_event`), so `startAt` goes out first.
    fn open(&mut self, url: &str) -> windows_core::Result<Media> {
        let manager = self.device();
        let cpu = manager.is_none() || super::wic::wanted(self.device.as_ref().map(|(d, _, _)| d));
        if cpu {
            log::info!("player {}: frames through the CPU (no GPU adapter)", self.id);
        }
        self.cpu = cpu.then(super::wic::CpuTarget::default);
        let generation = self.generation;
        let notify: IMFMediaEngineNotify =
            Notify { tx: Mutex::new(self.tx.clone()), generation }.into();
        // SAFETY: COM calls on this thread with live arguments.
        unsafe {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 3)?;
            let attrs = attrs.ok_or_else(|| windows_core::Error::from(MF_E_UNEXPECTED))?;
            attrs.SetUnknown(&MF_MEDIA_ENGINE_CALLBACK, &notify)?;
            // Without a DXGI manager the engine decodes in software and
            // transfers into WIC bitmaps (`super::wic`).
            if let (false, Some(manager)) = (cpu, manager.as_ref()) {
                attrs.SetUnknown(&MF_MEDIA_ENGINE_DXGI_MANAGER, manager)?;
                attrs.SetUINT32(&MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32)?;
            }
            let factory: IMFMediaEngineClassFactory =
                CoCreateInstance(&CLSID_MFMediaEngineClassFactory, None, CLSCTX_INPROC_SERVER)?;
            let engine = factory.CreateInstance(0, &attrs)?;
            // Subtitles: the timed-text service, before the source, so its
            // track notifications cover the source's renditions.
            let (text, text_notify) = match engine
                .cast::<IMFGetService>()
                .and_then(|s| s.GetService::<IMFTimedText>(&MF_MEDIA_ENGINE_TIMEDTEXT))
            {
                Ok(text) => {
                    let n: IMFTimedTextNotify =
                        TextNotify { tx: Mutex::new(self.tx.clone()), generation }.into();
                    let _ = text.RegisterNotifications(&n);
                    (Some(text), Some(n))
                }
                Err(e) => {
                    log::debug!("player {}: no timed text: {e}", self.id);
                    (None, None)
                }
            };
            let _ = engine.SetAutoPlay(false);
            let _ = engine.SetVolume(f64::from(self.volume));
            let _ = engine.SetMuted(self.muted);
            engine.SetSource(&BSTR::from(url))?;
            Ok(Media { engine, text, _notify: notify, _text_notify: text_notify })
        }
    }

    // --- Engine events ---

    fn on_event(&mut self, event: u32, param1: usize, param2: u32) {
        let Some(engine) = self.media.as_ref().map(|m| m.engine.clone()) else { return };
        log::debug!("player {}: event {event} ({param1}, {param2:#x}) at {} ms", self.id, self.started.elapsed().as_millis());
        let ev = MF_MEDIA_ENGINE_EVENT(event as i32);
        match ev {
            MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA => {
                self.read_size(&engine);
                self.read_duration(&engine);
                self.read_audio_tracks(&engine);
                self.read_text_tracks();
                if !self.metadata {
                    self.metadata = true;
                    self.start(&engine);
                }
            }
            MF_MEDIA_ENGINE_EVENT_DURATIONCHANGE => {
                self.read_duration(&engine);
            }
            MF_MEDIA_ENGINE_EVENT_FORMATCHANGE => {
                // HLS switched renditions: the picture's size may differ.
                self.read_size(&engine);
                self.settle();
            }
            MF_MEDIA_ENGINE_EVENT_FIRSTFRAMEREADY => self.settle(),
            MF_MEDIA_ENGINE_EVENT_TRACKSCHANGE => {
                self.read_audio_tracks(&engine);
                self.emit_tracks();
            }
            MF_MEDIA_ENGINE_EVENT_WAITING | MF_MEDIA_ENGINE_EVENT_BUFFERINGSTARTED => {
                self.set_stalled(true);
            }
            MF_MEDIA_ENGINE_EVENT_PLAYING
            | MF_MEDIA_ENGINE_EVENT_BUFFERINGENDED
            | MF_MEDIA_ENGINE_EVENT_CANPLAYTHROUGH => self.set_stalled(false),
            MF_MEDIA_ENGINE_EVENT_SEEKED => {
                self.settle();
                // SAFETY: the engine is used on this thread only.
                let time = unsafe { engine.GetCurrentTime() };
                if self.landing.is_some_and(|(at, _)| (time - at).abs() < 1.0) {
                    self.landing = None;
                }
                if let Some((target, at)) = self.pending_seek.take() {
                    let ms = at.elapsed().as_millis() as u64;
                    (self.emit)(
                        "seeked",
                        json!({ "target": target, "time": finite(time), "finished": true, "ms": ms }),
                    );
                }
            }
            MF_MEDIA_ENGINE_EVENT_ENDED => self.ended_now(),
            MF_MEDIA_ENGINE_EVENT_ERROR => {
                self.failed = true;
                self.set_playing_state(false);
                let (code, what) = match MF_MEDIA_ENGINE_ERR(param1 as i32) {
                    MF_MEDIA_ENGINE_ERR_ABORTED => ("aborted", "aborted"),
                    MF_MEDIA_ENGINE_ERR_NETWORK => ("network", "network error"),
                    MF_MEDIA_ENGINE_ERR_DECODE => ("decode", "cannot decode the media"),
                    MF_MEDIA_ENGINE_ERR_SRC_NOT_SUPPORTED => ("unsupported", "unsupported source"),
                    MF_MEDIA_ENGINE_ERR_ENCRYPTED => ("drm", "encrypted media"),
                    _ => ("engine", "media engine error"),
                };
                log::debug!("player {}: error {code} hr={param2:#010x}", self.id);
                (self.emit)(
                    "error",
                    json!({
                        "message": format!("Media Foundation: {what} (0x{param2:08x})"),
                        "code": code,
                        "fatal": true,
                    }),
                );
            }
            _ => {}
        }
    }

    /// The metadata is in: the first seek (`startAt`), the rate, then play
    /// unless paused.
    fn start(&mut self, engine: &IMFMediaEngine) {
        let at = std::mem::take(&mut self.start_at);
        // SAFETY: the engine is used on this thread only.
        unsafe {
            if at.is_finite() && at > 0.0 {
                self.position = at;
                self.landing = Some((at, Instant::now()));
                if engine.SetCurrentTime(at).is_err() {
                    log::warn!("player {}: start seek to {at} refused", self.id);
                    self.landing = None;
                }
            }
            if (self.rate - 1.0).abs() > f32::EPSILON {
                let _ = engine.SetPlaybackRate(f64::from(self.rate));
            }
            if !self.paused {
                let _ = engine.Play();
            }
        }
        self.settle();
    }

    fn ended_now(&mut self) {
        if !self.ended {
            self.ended = true;
            self.set_playing_state(false);
            (self.emit)("end", json!({}));
        }
    }

    fn set_stalled(&mut self, stalled: bool) {
        if stalled != self.stalled {
            self.stalled = stalled;
            (self.emit)("buffer", json!({ "stalled": stalled, "reason": stalled.then_some("buffering") }));
        }
    }

    fn read_size(&mut self, engine: &IMFMediaEngine) {
        let (mut w, mut h) = (0u32, 0u32);
        // SAFETY: the engine is used on this thread only.
        if unsafe { engine.GetNativeVideoSize(Some(&mut w), Some(&mut h)) }.is_ok() && w > 0 && h > 0 {
            if (w, h) != self.native {
                self.native = (w, h);
                self.last_pts = None;
            }
        }
    }

    fn read_duration(&mut self, engine: &IMFMediaEngine) {
        // SAFETY: the engine is used on this thread only.
        let d = unsafe { engine.GetDuration() };
        // NaN: unknown yet; +inf: a live stream.
        self.duration = (d.is_finite() && d > 0.0).then_some(d);
    }

    // --- Tracks ---

    fn read_audio_tracks(&mut self, engine: &IMFMediaEngine) {
        let Ok(ex) = engine.cast::<IMFMediaEngineEx>() else { return };
        let mut audio = Vec::new();
        // SAFETY: the engine is used on this thread only; each PROPVARIANT
        // is dropped (cleared) after it is read, strings freed with
        // CoTaskMemFree.
        unsafe {
            let n = ex.GetNumberOfStreams().unwrap_or(0);
            for index in 0..n {
                let major = ex.GetStreamAttribute(index, &MF_MT_MAJOR_TYPE).ok().and_then(|pv| PropVariantToGUID(&pv).ok());
                if major != Some(MFMediaType_Audio) {
                    continue;
                }
                let string = |key: &windows_core::GUID| {
                    ex.GetStreamAttribute(index, key)
                        .ok()
                        .and_then(|pv| PropVariantToStringAlloc(&pv).ok())
                        .map(take_pwstr)
                        .filter(|s| !s.is_empty())
                };
                let lang = string(&MF_SD_LANGUAGE);
                let name = string(&MF_SD_STREAM_NAME);
                let n = audio.len();
                audio.push(Track {
                    id: format!("a{n}"),
                    label: name.or_else(|| lang.clone()).unwrap_or_else(|| format!("Track {}", n + 1)),
                    lang,
                    default: n == 0,
                    selected: ex.GetStreamSelection(index).map(|b| b.as_bool()).unwrap_or(false),
                    key: index,
                });
            }
        }
        self.audio = audio;
    }

    fn read_text_tracks(&mut self) {
        let Some(text) = self.media.as_ref().and_then(|m| m.text.clone()) else { return };
        let mut subs = Vec::new();
        // SAFETY: the timed-text service is used on this thread only;
        // strings freed with CoTaskMemFree.
        unsafe {
            let Ok(list) = text.GetTextTracks() else { return };
            for i in 0..list.GetLength() {
                let Ok(track) = list.GetTrack(i) else { continue };
                let kind = track.GetTrackKind();
                if kind != MF_TIMED_TEXT_TRACK_KIND_SUBTITLES && kind != MF_TIMED_TEXT_TRACK_KIND_CAPTIONS {
                    continue;
                }
                let label = track.GetLabel().ok().map(take_pwstr).filter(|s| !s.is_empty());
                let lang = track.GetLanguage().ok().map(take_pwstr).filter(|s| !s.is_empty());
                // Renditions with neither label nor language are the
                // in-band caption channels of the video: no use as a choice.
                if label.is_none() && lang.is_none() {
                    continue;
                }
                let id = track.GetId();
                let n = subs.len();
                subs.push(Track {
                    id: format!("t{n}"),
                    label: label.or_else(|| lang.clone()).unwrap_or_else(|| format!("Subtitles {}", n + 1)),
                    lang,
                    default: n == 0,
                    selected: self.sel_text == Some(id),
                    key: id,
                });
            }
        }
        self.subs = subs;
    }

    fn emit_tracks(&mut self) {
        if !self.loaded {
            return;
        }
        (self.emit)(
            "tracks",
            json!({
                "audioTracks": self.audio.iter().map(Track::json).collect::<Vec<_>>(),
                "subtitleTracks": self.subs.iter().map(Track::json).collect::<Vec<_>>(),
            }),
        );
    }

    /// `selectAudio` / `selectSubtitle` (`None`: subtitles off). "a1"/"t0"
    /// index the tracks `load`/`tracks` reported.
    fn select(&mut self, legible: bool, id: Option<&str>) {
        let Some(media) = self.media.as_ref() else { return };
        let index = |prefix: char| id.and_then(|s| s.strip_prefix(prefix)).and_then(|s| s.parse::<usize>().ok());
        if legible {
            let want = index('t').and_then(|n| self.subs.get(n)).map(|t| t.key);
            if let Some(text) = &media.text {
                // SAFETY: the timed-text service is used on this thread only.
                unsafe {
                    for t in &self.subs {
                        if Some(t.key) != want {
                            let _ = text.SelectTrack(t.key, false);
                        }
                    }
                    if let Some(key) = want {
                        let _ = text.SelectTrack(key, true);
                    }
                }
            }
            self.sel_text = want;
            for t in &mut self.subs {
                t.selected = Some(t.key) == want;
            }
            if want.is_none() && self.cue.take().is_some() {
                (self.emit)("cues", json!({ "time": self.position, "lines": [] }));
            }
        } else {
            let Some(want) = index('a').and_then(|n| self.audio.get(n)).map(|t| t.key) else { return };
            let Ok(ex) = media.engine.cast::<IMFMediaEngineEx>() else { return };
            // SAFETY: the engine is used on this thread only.
            unsafe {
                for t in &self.audio {
                    let _ = ex.SetStreamSelection(t.key, t.key == want);
                }
                let _ = ex.ApplyStreamSelections();
            }
            for t in &mut self.audio {
                t.selected = t.key == want;
            }
        }
        self.emit_tracks();
    }

    fn on_cue(&mut self, track: u32, on: bool, start: f64, end: f64, now: f64, lines: Vec<String>) {
        if self.sel_text != Some(track) {
            return;
        }
        if on {
            self.cue = Some((track, end));
            (self.emit)("cues", json!({ "time": start, "lines": lines }));
        } else if self.cue.is_some_and(|(t, e)| t == track && (e - end).abs() < 0.01) {
            self.cue = None;
            (self.emit)("cues", json!({ "time": now, "lines": [] }));
        }
    }

    // --- Playback controls ---

    fn set_paused(&mut self, paused: bool) {
        if self.paused == paused {
            return;
        }
        self.paused = paused;
        if self.metadata
            && let Some(m) = &self.media
        {
            // SAFETY: the engine is used on this thread only.
            let _ = unsafe { if paused { m.engine.Pause() } else { m.engine.Play() } };
        }
        self.settle();
        (self.emit)("rate", json!({ "rate": if paused { 0.0 } else { f64::from(self.rate) }, "paused": paused }));
    }

    fn set_rate(&mut self, rate: f32) {
        let rate = rate.max(0.25);
        if (rate - self.rate).abs() < f32::EPSILON {
            return;
        }
        self.rate = rate;
        if self.metadata
            && let Some(m) = &self.media
        {
            // SAFETY: the engine is used on this thread only.
            unsafe {
                let _ = m.engine.SetDefaultPlaybackRate(f64::from(rate));
                let _ = m.engine.SetPlaybackRate(f64::from(rate));
            }
        }
    }

    /// Seeks to `secs`; a `seeked` event follows. Before the metadata is
    /// in, the target becomes the start position instead.
    fn seek(&mut self, secs: f64) {
        if self.media.is_none() {
            return;
        }
        let target = if secs.is_finite() { secs.max(0.0) } else { 0.0 };
        self.pending_seek = Some((target, Instant::now()));
        self.ended = false;
        self.landing = None;
        if !self.metadata {
            self.start_at = target;
            return;
        }
        if let Some(m) = &self.media {
            // SAFETY: the engine is used on this thread only.
            if unsafe { m.engine.SetCurrentTime(target) }.is_err() {
                self.pending_seek = None;
                (self.emit)("error", json!({ "message": "seek failed", "code": "seek", "fatal": false }));
            }
        }
        self.settle();
    }

    /// The decode cap changed: the next frame is made at the new size, and
    /// while paused the current one is made again.
    fn resized(&mut self) {
        self.last_pts = None;
        self.settle();
    }

    fn set_playing_state(&mut self, playing: bool) {
        if self.playing == playing {
            return;
        }
        self.playing = playing;
        if playing {
            PLAYING.fetch_add(1, Ordering::Relaxed);
        } else {
            PLAYING.fetch_sub(1, Ordering::Relaxed);
        }
    }

    // --- Frames ---

    /// The size frames are made at: the video's own, scaled down (aspect
    /// kept, never up) to fit `maxResolution` and the picture's size on
    /// screen; even, at least 2×2.
    fn out_size(&self) -> (u32, u32) {
        let (w, h) = (f64::from(self.native.0), f64::from(self.native.1));
        let mut scale = 1.0f64;
        for (bw, bh) in [self.max_res, self.display_res].into_iter().flatten() {
            scale = scale.min(bw / w).min(bh / h);
        }
        let even = |v: f64| (((v.round() as u32) / 2) * 2).max(2);
        (even(w * scale), even(h * scale))
    }

    fn pump_frame(&mut self) {
        let Some(engine) = self.media.as_ref().map(|m| m.engine.clone()) else { return };
        if self.native.0 == 0 {
            self.read_size(&engine);
            if self.native.0 == 0 {
                return;
            }
        }
        // SAFETY: the engine is used on this thread only.
        let Ok(pts) = (unsafe { engine.OnVideoStreamTick() }) else { return };
        if self.last_pts == Some(pts) {
            return;
        }
        let size = self.out_size();
        let t0 = Instant::now();
        match self.transfer(&engine, size) {
            Ok(pixels) => {
                let t1 = Instant::now();
                self.last_pts = Some(pts);
                self.publish(size, pixels);
                log::trace!(
                    "player {}: frame {}x{} transfer {:.1} ms publish {:.1} ms",
                    self.id, size.0, size.1,
                    (t1 - t0).as_secs_f64() * 1000.0, t1.elapsed().as_secs_f64() * 1000.0
                );
            }
            Err(e) => log::debug!("player {}: frame transfer failed: {e}", self.id),
        }
    }

    /// Scales the engine's current frame into the BGRA texture and reads
    /// it back: one buffer, rows packed, alpha opaque.
    fn transfer(&mut self, engine: &IMFMediaEngine, size: (u32, u32)) -> windows_core::Result<Vec<u8>> {
        if let Some(cpu) = self.cpu.as_mut() {
            return cpu.transfer(engine, size);
        }
        let Some((device, ctx, _)) = self.device.clone() else {
            return Err(MF_E_UNEXPECTED.into());
        };
        if self.target.as_ref().is_none_or(|t| t.size != size) {
            self.target = Some(make_target(&device, size)?);
        }
        let Some(target) = self.target.as_ref() else { return Err(MF_E_UNEXPECTED.into()) };
        let (w, h) = size;
        let rect = RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
        let black = MFARGB { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbAlpha: 255 };
        // SAFETY: device objects used on this thread only; the mapped
        // pointer is read within RowPitch × h bytes before Unmap.
        unsafe {
            engine.TransferVideoFrame(&target.texture, None, &rect, Some(&black))?;
            ctx.CopyResource(&target.staging, &target.texture);
            let mut map = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(&target.staging, 0, D3D11_MAP_READ, 0, Some(&mut map))?;
            const OPAQUE: u32 = u32::from_ne_bytes([0, 0, 0, 255]);
            let row = w as usize * 4;
            let pitch = map.RowPitch as usize;
            let mut bgra = vec![0u8; row * h as usize];
            for (y, dst) in bgra.chunks_exact_mut(row).enumerate() {
                let src = std::slice::from_raw_parts((map.pData as *const u8).add(y * pitch), row);
                for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                    let px = u32::from_ne_bytes([s[0], s[1], s[2], s[3]]) | OPAQUE;
                    d.copy_from_slice(&px.to_ne_bytes());
                }
            }
            ctx.Unmap(&target.staging, 0);
            Ok(bgra)
        }
    }

    /// Where frames go now: the child window, if the component asked.
    fn direct_target(&self) -> Option<isize> {
        let shared = self.shared.lock().ok()?;
        (shared.direct_on && shared.direct_hwnd != 0).then_some(shared.direct_hwnd)
    }

    /// The component switched the picture between GPUI and the child
    /// window: the picture on screen goes over with it, playing or not.
    fn direct_changed(&mut self) {
        match self.direct_target() {
            Some(hwnd) => {
                let latest = self.shared.lock().ok().and_then(|s| s.latest.clone());
                if let Some(fd) = latest {
                    let size = fd.image.size(0);
                    let size = (size.width.0 as u32, size.height.0 as u32);
                    if let Some(bytes) = fd.image.as_bytes(0) {
                        match self.presenter.present(hwnd, size, bytes) {
                            Ok(()) => self.direct_live = true,
                            Err(e) => log::debug!("player {}: direct present failed: {e}", self.id),
                        }
                    }
                }
            }
            None => {
                self.presenter.reset();
                self.direct_live = false;
                if let Some((size, bgra)) = self.last_direct.take() {
                    self.to_gpui(size, bgra);
                }
            }
        }
        (self.redraw)();
    }

    /// A frame as the image GPUI paints.
    fn to_gpui(&mut self, (w, h): (u32, u32), bgra: Vec<u8>) {
        // BGRA bytes in an Rgba-typed buffer: the atlas reads bytes, the
        // pixel type is only the container (as on Linux).
        let Some(pixels) = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(w, h, bgra) else { return };
        let fd = Arc::new(FrameData {
            seq: SEQ.fetch_add(1, Ordering::Relaxed),
            image: Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(pixels), 1))),
        });
        self.shared.lock().unwrap().latest = Some(fd);
    }

    fn publish(&mut self, (w, h): (u32, u32), bgra: Vec<u8>) {
        let resized = {
            let mut shared = self.shared.lock().unwrap();
            let resized = shared.picture != (w, h);
            shared.picture = (w, h);
            resized
        };
        let mut direct = false;
        if let Some(hwnd) = self.direct_target() {
            match self.presenter.present(hwnd, (w, h), &bgra) {
                Ok(()) => direct = true,
                Err(e) => {
                    log::debug!("player {}: direct present failed: {e}", self.id);
                    self.presenter.release();
                }
            }
        }
        // The component places the window when the picture's size is new.
        let redraw = !direct || !self.direct_live || resized;
        self.direct_live = direct;
        if direct {
            PAINTED.fetch_add(1, Ordering::Relaxed);
            self.last_direct = Some(((w, h), bgra));
        } else {
            self.last_direct = None;
            self.to_gpui((w, h), bgra);
        }
        self.frames += 1;
        if self.frames == 1 {
            let ms = self.started.elapsed().as_millis() as u64;
            (self.emit)("frame", json!({ "ms": ms, "width": self.native.0, "height": self.native.1 }));
            self.emit_load();
        }
        if redraw {
            (self.redraw)();
        }
    }

    fn emit_load(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let ms = self.started.elapsed().as_millis() as u64;
        (self.emit)(
            "load",
            json!({
                "duration": self.duration,
                "width": self.native.0,
                "height": self.native.1,
                "ms": ms,
                "audioTracks": self.audio.iter().map(Track::json).collect::<Vec<_>>(),
                "subtitleTracks": self.subs.iter().map(Track::json).collect::<Vec<_>>(),
            }),
        );
    }

    // --- The tick ---

    fn tick(&mut self) {
        if self.src.is_none() || self.failed {
            return;
        }
        let Some(engine) = self.media.as_ref().map(|m| m.engine.clone()) else { return };
        if !self.metadata {
            // Still loading: `progress` reports where playback will start.
            (self.emit)(
                "progress",
                json!({ "currentTime": self.position, "buffered": null, "playable": null, "frames": self.frames }),
            );
            return;
        }
        // SAFETY: the engine is used on this thread only.
        let (queried, engine_paused, engine_ended, ranges) = unsafe {
            let ranges = engine.GetBuffered().ok().map(|b| {
                (0..b.GetLength())
                    .filter_map(|i| Some((b.GetStart(i).ok()?, b.GetEnd(i).ok()?)))
                    .collect::<Vec<_>>()
            });
            (engine.GetCurrentTime(), engine.IsPaused().as_bool(), engine.IsEnded().as_bool(), ranges)
        };
        self.read_duration(&engine);
        if self.landing.is_some_and(|(at, since)| queried >= at - 1.0 || since.elapsed() > LANDING) {
            self.landing = None;
        }
        let pos = match self.landing {
            Some((at, _)) => at,
            None => queried,
        };
        if pos.is_finite() {
            self.position = pos;
        }

        let playing = !self.paused && !self.ended && !engine_paused && self.loaded;
        self.set_playing_state(playing);

        // A seek that got no SEEKED still completes: the position lands.
        if let Some((target, at)) = self.pending_seek {
            let close = (pos - target).abs() < 0.5;
            if close || at.elapsed() > Duration::from_secs(5) {
                self.pending_seek = None;
                (self.emit)(
                    "seeked",
                    json!({ "target": target, "time": finite(pos), "finished": close, "ms": at.elapsed().as_millis() as u64 }),
                );
            }
        }

        if engine_ended || self.duration.is_some_and(|d| self.position >= d - 0.05) && !self.paused {
            self.ended_now();
        }

        // A cue whose INACTIVE never came (a seek away from it).
        if self.cue.is_some_and(|(_, end)| self.position > end + 0.5 || self.position + 0.5 < end - 3600.0) {
            self.cue = None;
            (self.emit)("cues", json!({ "time": self.position, "lines": [] }));
        }

        log::trace!(
            "player {}: tick pos {pos:.2} queried {queried:.2} paused {}/{engine_paused} frames {} painted {} ranges {ranges:?}",
            self.id, self.paused, self.frames, PAINTED.load(Ordering::Relaxed)
        );
        // buffered / playable: the end of the buffered range playback is in.
        let buffered = ranges.and_then(|r| {
            r.iter()
                .find(|(s, e)| *s <= pos + 0.5 && pos <= *e + 0.5)
                .map(|(_, e)| *e)
                .filter(|e| e.is_finite())
        });
        (self.emit)(
            "progress",
            json!({
                "currentTime": finite(pos),
                "buffered": buffered,
                "playable": buffered,
                "frames": self.frames,
            }),
        );
    }
}

fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

/// A CoTaskMem string as a `String`, freed.
fn take_pwstr(p: PWSTR) -> String {
    // SAFETY: `p` came from a CoTaskMem allocation (PropVariantToStringAlloc,
    // IMFTimedTextTrack::GetLabel/GetLanguage) and is freed once here.
    unsafe {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

/// A D3D11 device that can decode video, shared with Media Foundation
/// through a DXGI device manager: the GPU when there is one (hardware
/// decode), else WARP.
fn make_device() -> windows_core::Result<(ID3D11Device, ID3D11DeviceContext, IMFDXGIDeviceManager)> {
    let flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    let create = |driver: D3D_DRIVER_TYPE| {
        let mut device = None;
        let mut ctx = None;
        // SAFETY: out-pointers to locals.
        unsafe {
            D3D11CreateDevice(None, driver, HMODULE::default(), flags, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx))
        }
        .map(|()| (device, ctx))
    };
    let (device, ctx) = match create(D3D_DRIVER_TYPE_HARDWARE) {
        Ok(v) => v,
        Err(_) => create(D3D_DRIVER_TYPE_WARP)?,
    };
    let (Some(device), Some(ctx)) = (device, ctx) else {
        return Err(MF_E_UNEXPECTED.into());
    };
    // SAFETY: COM calls on a live device; the manager keeps a reference.
    unsafe {
        // Media Foundation uses the device from its own threads.
        let _ = device.cast::<ID3D10Multithread>()?.SetMultithreadProtected(true);
        let mut token = 0u32;
        let mut manager = None;
        MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
        let manager: IMFDXGIDeviceManager = manager.ok_or_else(|| windows_core::Error::from(MF_E_UNEXPECTED))?;
        manager.ResetDevice(&device, token)?;
        Ok((device, ctx, manager))
    }
}

/// The BGRA render target `TransferVideoFrame` scales into, and the
/// staging copy it is read back from.
fn make_target(device: &ID3D11Device, (w, h): (u32, u32)) -> windows_core::Result<Target> {
    let mut desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    let mut staging = None;
    // SAFETY: valid descriptions, out-pointers to locals.
    unsafe {
        device.CreateTexture2D(&desc, None, Some(&mut texture))?;
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        device.CreateTexture2D(&desc, None, Some(&mut staging))?;
    }
    match (texture, staging) {
        (Some(texture), Some(staging)) => Ok(Target { size: (w, h), texture, staging }),
        _ => Err(MF_E_UNEXPECTED.into()),
    }
}
