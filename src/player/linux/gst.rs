//! The Linux player core: a `playbin3` whose video and text outputs are
//! `appsink`s. The video sink hands BGRA frames to the component through
//! a shared slot (one `Arc` per frame, no copy after the row unpack);
//! the text sink turns subtitle buffers into `cues` events. Audio goes
//! to the default sink; playbin3's `volume`/`mute` cover those, and its
//! `GstStreamCollection`/`GST_EVENT_SELECT_STREAMS` API covers the
//! audio/subtitle tracks (playbin2 does not post stream collections).
//!
//! Threads: GStreamer calls the appsink callbacks on its streaming
//! threads and posts bus messages on the pipeline's thread; both only
//! take `Inner`'s mutex briefly and then `emit`/`redraw` (both are safe
//! from any thread — `ComponentContext` is Send + Sync). A 4 Hz tick
//! thread does the position/duration queries and the `progress`,
//! `seeked` and end bookkeeping, so nothing here ever blocks the main
//! thread and a paused pipeline produces no frames and no redraws
//! (appsink's `sync` paces `new_sample` to the stream clock).

use std::{
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use gstreamer::{prelude::*, SeekFlags, SeekType};
use gstreamer_app::{AppSink, AppSinkCallbacks};
use gstreamer_video::{VideoFrame, VideoFrameExt, VideoInfo};
use serde_json::{Value, json};

use super::{Fit, NowPlaying, size_of};

pub(crate) static LIVE: AtomicUsize = AtomicUsize::new(0);
pub(crate) static PLAYING: AtomicUsize = AtomicUsize::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);
static SEQ: AtomicU64 = AtomicU64::new(1);

/// Events and redraws may come from GStreamer's threads.
pub(crate) type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub(crate) type Redraw = Arc<dyn Fn() + Send + Sync>;

/// One decoded frame, BGRA tightly packed (what GPUI's atlas wants).
pub(crate) struct FrameData {
    pub(crate) seq: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bgra: Vec<u8>,
}

#[derive(Clone)]
struct Track {
    id: String,
    label: String,
    lang: Option<String>,
    default: bool,
    selected: bool,
    /// The `GstStream` id `select-streams` selects by.
    gst_id: Option<String>,
}

impl Track {
    fn json(&self) -> Value {
        json!({
            "id": self.id, "label": self.label, "lang": self.lang,
            "default": self.default, "selected": self.selected,
        })
    }
}

struct Cue {
    /// When the cue's text stops being current (the tick clears it).
    end: f64,
    /// An empty `cues` was already sent for this cue's tail.
    cleared: bool,
}

struct Inner {
    id: u64,
    emit: Emit,
    redraw: Redraw,
    dead: bool,

    pipeline: Option<gstreamer::Element>,
    /// Bumped for every new pipeline; a stale bus thread exits on it.
    bus_gen: u64,

    src: Option<String>,
    start_at: f64,
    paused: bool,
    muted: bool,
    volume: f32,
    rate: f32,
    fit: Fit,
    max_res: Option<(f64, f64)>,
    display_res: Option<(f64, f64)>,
    now_playing: Option<NowPlaying>,

    started: Instant,
    ready_at: Option<Instant>,
    loaded: bool,
    failed: bool,
    ended: bool,
    playing: bool,
    stalled: bool,
    buffering_pct: Option<i32>,
    duration: Option<f64>,
    position: f64,
    pending_seek: Option<(f64, Instant)>,
    last_seeked_ms: Option<u64>,

    frames: u64,
    latest: Option<Arc<FrameData>>,
    /// The stream collection parsed and holds no video stream: `load`
    /// may fire without a frame (audio-only media).
    no_video: bool,
    audio: Vec<Track>,
    subs: Vec<Track>,
    /// Stream ids that are not audio/text (video etc.): always kept
    /// selected when `select-streams` goes out.
    other_ids: Vec<String>,
    /// The stream ids `selectAudio`/`selectSubtitle` picked (None: the
    /// default audio, no subtitles).
    sel_audio: Option<String>,
    sel_text: Option<String>,
    /// Stream ids the pipeline last reported as selected.
    sel_ids: std::collections::HashSet<String>,
    /// A text stream is among the selected ones; gates `cues`.
    text_on: bool,
    cue: Option<Cue>,
}

type Registry = std::collections::HashMap<u64, Weak<Mutex<Inner>>>;

fn registry() -> &'static Mutex<Registry> {
    static REG: std::sync::OnceLock<Mutex<Registry>> = std::sync::OnceLock::new();
    REG.get_or_init(|| Mutex::new(Registry::new()))
}

fn lookup(id: u64) -> Option<Arc<Mutex<Inner>>> {
    registry().lock().unwrap().get(&id).and_then(Weak::upgrade)
}

fn weak_for(id: u64) -> Weak<Mutex<Inner>> {
    registry().lock().unwrap().get(&id).cloned().unwrap_or_default()
}

fn gst_init() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if let Err(e) = gstreamer::init() {
            log::error!("gstreamer init failed: {e}");
        }
    });
}

/// `sys.nativeVideo {handle, …}`: the player's props and commands without
/// a frame of the window (same fields as `super::av::control`). False
/// when there is no such player.
pub(crate) fn control(handle: u64, data: &Value) -> bool {
    let Some(inner) = lookup(handle) else { return false };
    // Pipeline calls that can wait on streaming threads run after the
    // lock is released (the appsink callbacks take it).
    let mut seek_job = None;
    let mut sel_job = None;
    {
        let Ok(mut i) = inner.lock() else { return false };
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
        // The picture's size in points; the decode cap is not wired yet,
        // but keep the value like av.rs does for when it is.
        i.set_display_size(size_of(Some(f)));
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
        seek_job = i.seek_prepare(t);
    }
    if let Some(id) = data.get("selectAudio").and_then(Value::as_str) {
        let idx = id.strip_prefix('a').and_then(|s| s.parse::<usize>().ok());
        i.sel_audio = idx.and_then(|n| i.audio.get(n)).and_then(|t| t.gst_id.clone());
        sel_job = i.select_streams();
    }
    match data.get("selectSubtitle") {
        Some(Value::String(id)) => {
            let idx = id.strip_prefix('t').and_then(|s| s.parse::<usize>().ok());
            i.sel_text = idx.and_then(|n| i.subs.get(n)).and_then(|t| t.gst_id.clone());
            sel_job = i.select_streams();
        }
        Some(Value::Null) => {
            i.sel_text = None;
            sel_job = i.select_streams();
        }
        _ => {}
    }
    // `pip`: no picture in picture on Linux — accept and ignore.
    }
    if let Some((pipe, target)) = seek_job
        && pipe
            .seek_simple(SeekFlags::FLUSH, gstreamer::ClockTime::from_seconds_f64(target))
            .is_err()
        && let Ok(mut i) = inner.lock()
    {
        i.pending_seek = None;
        (i.emit)(
            "error",
            json!({ "message": "seek failed", "code": "seek", "fatal": false }),
        );
    }
    if let Some((pipe, ids)) = sel_job {
        pipe.send_event(gstreamer::event::SelectStreams::new(
            ids.iter().map(String::as_str),
        ));
    }
    true
}

pub(crate) struct Player {
    id: u64,
    inner: Arc<Mutex<Inner>>,
}

impl Player {
    pub(crate) fn new(emit: Emit, redraw: Redraw) -> Player {
        gst_init();
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let inner = Arc::new(Mutex::new(Inner {
            id,
            emit,
            redraw,
            dead: false,
            pipeline: None,
            bus_gen: 0,
            src: None,
            start_at: 0.0,
            paused: false,
            muted: false,
            volume: 1.0,
            rate: 1.0,
            fit: Fit::Contain,
            max_res: None,
            display_res: None,
            now_playing: None,
            started: Instant::now(),
            ready_at: None,
            loaded: false,
            failed: false,
            ended: false,
            playing: false,
            stalled: false,
            buffering_pct: None,
            duration: None,
            position: 0.0,
            pending_seek: None,
            last_seeked_ms: None,
            frames: 0,
            latest: None,
            no_video: false,
            audio: Vec::new(),
            subs: Vec::new(),
            other_ids: Vec::new(),
            sel_audio: None,
            sel_text: None,
            sel_ids: std::collections::HashSet::new(),
            text_on: false,
            cue: None,
        }));
        registry().lock().unwrap().insert(id, Arc::downgrade(&inner));
        LIVE.fetch_add(1, Ordering::Relaxed);
        // The 4 Hz tick: progress, seeked fallback, end detection, the
        // playing flag and the cue tail. One thread per player for its
        // life; it exits when the player is dropped.
        let weak = Arc::downgrade(&inner);
        std::thread::Builder::new()
            .name(format!("rustflix-player-{id}"))
            .spawn(move || {
                while let Some(inner) = weak.upgrade() {
                    std::thread::sleep(Duration::from_millis(250));
                    tick(&inner);
                }
            })
            .ok();
        Player { id, inner }
    }

    /// The handle `sys.nativeVideo` reaches this player by.
    pub(crate) fn handle(&self) -> u64 {
        self.id
    }

    fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> Option<R> {
        self.inner.lock().ok().map(|mut i| f(&mut i))
    }

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
        self.with(|i| i.set_fit(fit));
    }

    pub(crate) fn fit(&self) -> Fit {
        self.inner.lock().map(|i| i.fit).unwrap_or_default()
    }

    pub(crate) fn set_max_resolution(&self, size: Option<(f64, f64)>) {
        self.with(|i| i.set_max_resolution(size));
    }

    /// The picture's size on screen in pixels (the default resolution cap).
    pub(crate) fn set_display_size(&self, size: Option<(f64, f64)>) {
        self.with(|i| i.set_display_size(size));
    }

    /// Seeks to `secs`; a `seeked` event follows. The GStreamer call runs
    /// outside `Inner`'s lock: it can wait on streaming threads, and the
    /// appsink callbacks take that same lock.
    pub(crate) fn seek(&self, secs: f64) {
        let job = self.with(|i| i.seek_prepare(secs));
        let Some((pipe, target)) = job.flatten() else { return };
        if pipe
            .seek_simple(SeekFlags::FLUSH, gstreamer::ClockTime::from_seconds_f64(target))
            .is_err()
        {
            self.with(|i| {
                i.pending_seek = None;
                (i.emit)(
                    "error",
                    json!({ "message": "seek failed", "code": "seek", "fatal": false }),
                );
            });
        }
    }

    /// `selectAudio` / `selectSubtitle` (`None`: subtitles off). Like
    /// `seek`, the `select-streams` event goes out without the lock.
    pub(crate) fn select(&self, legible: bool, id: Option<&str>) {
        let job = self.with(|i| {
            // "a3"/"t2" index the tracks `load`/`tracks` reported; the
            // pipeline selects by the GstStream id behind them.
            if !legible {
                let idx = id.and_then(|s| s.strip_prefix('a')).and_then(|s| s.parse::<usize>().ok());
                i.sel_audio = idx.and_then(|n| i.audio.get(n)).and_then(|t| t.gst_id.clone());
            } else {
                let idx = id.and_then(|s| s.strip_prefix('t')).and_then(|s| s.parse::<usize>().ok());
                i.sel_text = idx.and_then(|n| i.subs.get(n)).and_then(|t| t.gst_id.clone());
            }
            i.select_streams()
        });
        let Some((pipe, ids)) = job.flatten() else { return };
        pipe.send_event(gstreamer::event::SelectStreams::new(
            ids.iter().map(String::as_str),
        ));
    }

    /// The newest frame for the component to paint.
    pub(crate) fn frame(&self) -> Option<Arc<FrameData>> {
        self.inner.lock().ok()?.latest.clone()
    }

    pub(crate) fn set_now_playing(&self, info: Option<NowPlaying>) {
        self.with(|i| i.set_now_playing(info));
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        if let Ok(mut i) = self.inner.lock() {
            i.dead = true;
            i.teardown();
        }
        registry().lock().unwrap().remove(&self.id);
        LIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

// --- The tick -----------------------------------------------------------------

fn tick(inner: &Arc<Mutex<Inner>>) {
    let Ok(mut i) = inner.lock() else { return };
    if i.dead || i.src.is_none() {
        return;
    }
    let Some(pipe) = i.pipeline.clone() else { return };

    let pos = pipe.query_position::<gstreamer::ClockTime>().map(|t| t.seconds_f64());
    let dur = pipe
        .query_duration::<gstreamer::ClockTime>()
        .map(|t| t.seconds_f64())
        .filter(|d| d.is_finite() && *d > 0.0);
    if let Some(d) = dur {
        i.duration = Some(d);
    }
    if let Some(p) = pos {
        i.position = p;
    }

    // PLAYING count: pipeline in PLAYING and not paused by us.
    let playing = !i.paused && !i.ended && pos.is_some();
    if playing != i.playing {
        i.playing = playing;
        if playing {
            PLAYING.fetch_add(1, Ordering::Relaxed);
        } else {
            PLAYING.fetch_sub(1, Ordering::Relaxed);
        }
    }

    // A seek that got no ASYNC_DONE still completes: the position lands.
    if let Some((target, at)) = i.pending_seek {
        let close = pos.is_some_and(|p| (p - target).abs() < 0.5);
        if close || at.elapsed() > Duration::from_secs(5) {
            i.pending_seek = None;
            let ms = at.elapsed().as_millis() as u64;
            i.last_seeked_ms = Some(ms);
            let time = pos;
            (i.emit)(
                "seeked",
                json!({ "target": target, "time": time, "finished": close, "ms": ms }),
            );
        }
    }

    // End: EOS is the bus's word; position at the duration is the backup
    // for streams whose duration was unknown until late.
    if !i.ended && dur.is_some_and(|d| i.position >= d - 0.05) {
        i.ended = true;
        i.set_playing_state(false);
        (i.emit)("end", json!({}));
    }

    // The selected cue's tail: nothing arrives for it, so clear it here.
    let clear_cue = i
        .cue
        .as_ref()
        .is_some_and(|c| !c.cleared && i.position > c.end);
    if clear_cue {
        i.cue = None;
        (i.emit)("cues", json!({ "time": i.position, "lines": [] }));
    }

    // buffered / playable: the BUFFERING message's percent of the
    // duration, when the pipeline reports one.
    let buffered = i.buffering_pct.map(|p| dur.map(|d| d * p as f64 / 100.0)).flatten();
    let playable = buffered;
    (i.emit)(
        "progress",
        json!({
            "currentTime": pos,
            "buffered": buffered,
            "playable": playable,
        }),
    );
}

// --- Inner ---------------------------------------------------------------------

impl Inner {
    fn emit_load(&mut self) {
        // `load` describes the media: wait for the first frame (its size)
        // or, for audio-only media, until the collection says there is
        // no video at all.
        if self.loaded || (self.latest.is_none() && !self.no_video) {
            return;
        }
        if self.duration.is_none()
            && let Some(d) = self
                .pipeline
                .as_ref()
                .and_then(|p| p.query_duration::<gstreamer::ClockTime>())
                .map(|t| t.seconds_f64())
                .filter(|d| d.is_finite() && *d > 0.0)
        {
            self.duration = Some(d);
        }
        self.loaded = true;
        let ms = self.started.elapsed().as_millis() as u64;
        self.ready_at = Some(Instant::now());
        let w = self.latest.as_ref().map(|f| f.width).unwrap_or(0);
        let h = self.latest.as_ref().map(|f| f.height).unwrap_or(0);
        (self.emit)(
            "load",
            json!({
                "duration": self.duration,
                "width": w,
                "height": h,
                "ms": ms,
                "audioTracks": self.audio.iter().map(Track::json).collect::<Vec<_>>(),
                "subtitleTracks": self.subs.iter().map(Track::json).collect::<Vec<_>>(),
            }),
        );
        (self.redraw)();
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

    /// Stops and releases the pipeline (any thread).
    fn teardown(&mut self) {
        self.bus_gen += 1;
        if let Some(pipe) = self.pipeline.take() {
            let _ = pipe.set_state(gstreamer::State::Null);
        }
        self.latest = None;
        self.no_video = false;
        self.audio.clear();
        self.subs.clear();
        self.other_ids.clear();
        self.sel_audio = None;
        self.sel_text = None;
        self.sel_ids.clear();
        self.text_on = false;
        self.cue = None;
        self.pending_seek = None;
        self.buffering_pct = None;
        self.stalled = false;
        self.ended = false;
        self.failed = false;
        self.loaded = false;
        self.duration = None;
        self.position = 0.0;
        self.set_playing_state(false);
    }

    /// Applies the current props to a fresh pipeline (call after build).
    fn apply_state(&mut self) {
        let Some(pipe) = &self.pipeline else { return };
        // Volume 0..1 → playbin's 0..10; mute is its own flag.
        pipe.set_property("volume", f64::from(self.volume));
        pipe.set_property("mute", self.muted);
        if self.paused {
            let _ = pipe.set_state(gstreamer::State::Paused);
        } else {
            let _ = pipe.set_state(gstreamer::State::Playing);
        }
        if (self.rate - 1.0).abs() > f32::EPSILON {
            self.set_rate(self.rate);
        }
    }

    fn set_src(&mut self, url: Option<&str>) {
        // The same URL again changes nothing.
        if url == self.src.as_deref() {
            return;
        }
        self.teardown();
        self.src = url.map(str::to_owned);
        self.started = Instant::now();
        self.ready_at = None;
        self.position = self.start_at.max(0.0);
        let Some(url) = url else { return };
        match self.build(url) {
            Ok(()) => self.apply_state(),
            Err(e) => {
                self.failed = true;
                (self.emit)(
                    "error",
                    json!({ "message": format!("gstreamer: {e}"), "code": "pipeline", "fatal": true }),
                );
            }
        }
    }

    /// Builds the playbin: video → BGRA appsink, text → appsink,
    /// audio → the default sink. Returns Err(String) on setup failure.
    fn build(&mut self, url: &str) -> Result<(), String> {
        let video_sink = video_appsink()?;
        let text_sink = text_appsink()?;
        let pipeline = gstreamer::ElementFactory::make("playbin3")
            .property("uri", url)
            .property("video-sink", video_sink.upcast_ref::<gstreamer::Element>())
            .property("text-sink", text_sink.upcast_ref::<gstreamer::Element>())
            .build()
            .map_err(|e| e.to_string())?;

        // The element's default flags already cover video|audio|text|
        // soft-volume|buffering|deinterlace|soft-colorbalance; add
        // download+buffering by nick so the exact default does not
        // matter. `flags` is a GstPlayFlags (GFlags) value, which
        // `.property` cannot take from a `u32` — build it at the
        // property's own GType instead.
        set_play_flags(&pipeline, &["download", "buffering"]);

        // souphttpsrc takes `http_proxy` from the environment and applies
        // it even to loopback; every URL this player fetches is the app's
        // own 127.0.0.1 stream server, which a proxy cannot reach (it
        // answers 403). Clear `proxy` on each souphttpsrc as it joins the
        // pipeline — deep-element-added also catches the sources
        // hlsdemux creates for playlists and segments.
        if let Some(bin) = pipeline.downcast_ref::<gstreamer::Bin>() {
            bin.connect("deep-element-added", false, |values| {
                // (bin, sub_bin, element)
                if let Some(v) = values.get(2)
                    && let Ok(el) = v.get::<gstreamer::Element>()
                    && el.factory().is_some_and(|f| f.name() == "souphttpsrc")
                {
                    el.set_property("proxy", "");
                }
                None
            });
        }

        // The video sink's frames. The callback shares `self` through
        // the registry's Weak so a dropped player never gets a frame.
        let weak = weak_for(self.id);
        let emit = self.emit.clone();
        let redraw = self.redraw.clone();
        let bus_seq = self.bus_gen + 1;
        let video_cb = video_frame_callback(weak.clone(), emit.clone(), redraw.clone());
        video_sink.set_callbacks(AppSinkCallbacks::builder().new_sample(video_cb).build());
        let text_cb = text_frame_callback(weak.clone(), emit.clone());
        text_sink.set_callbacks(AppSinkCallbacks::builder().new_sample(text_cb).build());

        // The bus thread.
        let bus = pipeline.bus().ok_or("playbin has no bus")?;
        let bus_weak = weak_for(self.id);
        let gen_ = bus_seq;
        std::thread::Builder::new()
            .name(format!("rustflix-bus-{}", self.id))
            .spawn(move || bus_loop(bus_weak, gen_, bus))
            .map_err(|e| e.to_string())?;

        self.bus_gen = bus_seq;
        self.pipeline = Some(pipeline);
        Ok(())
    }

    fn set_paused(&mut self, paused: bool) {
        if self.paused == paused {
            return;
        }
        self.paused = paused;
        if let Some(pipe) = &self.pipeline {
            let _ = pipe.set_state(if paused { gstreamer::State::Paused } else { gstreamer::State::Playing });
        }
        (self.emit)("rate", json!({ "rate": if paused { 0.0 } else { self.rate as f64 }, "paused": paused }));
    }

    fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
        if let Some(pipe) = &self.pipeline {
            pipe.set_property("mute", muted);
        }
    }

    fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
        if let Some(pipe) = &self.pipeline {
            pipe.set_property("volume", f64::from(self.volume));
        }
    }

    fn set_rate(&mut self, rate: f32) {
        self.rate = rate.max(0.25);
        let Some(pipe) = &self.pipeline else { return };
        if (self.rate - 1.0).abs() < f32::EPSILON {
            // Back to normal speed is still a seek with rate 1.
        }
        let pos = self.position;
        let r = f64::from(self.rate);
        if pipe
            .seek(
                r,
                SeekFlags::empty(),
                SeekType::Set,
                gstreamer::ClockTime::from_seconds_f64(pos),
                SeekType::None,
                gstreamer::ClockTime::NONE,
            )
            .is_err()
        {
            log::debug!("player {}: rate {r} seek refused", self.id);
        }
    }

    fn set_fit(&mut self, fit: Fit) {
        self.fit = fit;
    }

    fn set_max_resolution(&mut self, size: Option<(f64, f64)>) {
        self.max_res = size;
    }

    fn set_display_size(&mut self, size: Option<(f64, f64)>) {
        self.display_res = size;
    }

    /// Marks a seek pending and returns the pipeline + target for the
    /// caller to seek outside the lock.
    fn seek_prepare(&mut self, secs: f64) -> Option<(gstreamer::Element, f64)> {
        let pipe = self.pipeline.clone()?;
        let target = secs.max(0.0);
        self.pending_seek = Some((target, Instant::now()));
        self.ended = false;
        Some((pipe, target))
    }

    /// `GST_EVENT_SELECT_STREAMS` inputs for playbin3, computed under the
    /// lock but sent by the caller without it: the streams to keep are
    /// everything not audio/text, the chosen audio (default: the first
    /// reported) and the chosen subtitle (none when subtitles are off).
    fn select_streams(&self) -> Option<(gstreamer::Element, Vec<String>)> {
        let pipe = self.pipeline.clone()?;
        let mut ids: Vec<String> = self.other_ids.clone();
        if let Some(a) = self
            .sel_audio
            .clone()
            .or_else(|| self.audio.iter().find_map(|t| t.gst_id.clone()))
        {
            ids.push(a);
        }
        if let Some(t) = &self.sel_text {
            ids.push(t.clone());
        }
        (!ids.is_empty()).then_some((pipe, ids))
    }

    fn set_now_playing(&mut self, info: Option<NowPlaying>) {
        self.now_playing = info;
    }
}

// --- The sinks' callbacks ---------------------------------------------------------

/// ORs `nicks` into the element's `flags` (a GstPlayFlags GFlags)
/// on top of its default: a `u32` cannot go through `.property`, so
/// the value is built at the property's own GType.
fn set_play_flags(el: &gstreamer::Element, nicks: &[&str]) {
    use gstreamer::glib::{FlagsClass, prelude::*};
    let flags = el.property_value("flags");
    let Some(class) = FlagsClass::with_type(flags.type_()) else { return };
    let Some(builder) = class.builder_with_value(flags) else { return };
    let mut builder = builder;
    for nick in nicks {
        builder = builder.set_by_nick(nick);
    }
    if let Some(v) = builder.build() {
        el.set_property_from_value("flags", &v);
    }
}

fn video_appsink() -> Result<AppSink, String> {
    let caps = gstreamer::Caps::builder("video/x-raw")
        .field("format", "BGRA")
        .build();
    Ok(AppSink::builder()
        .caps(&caps)
        .max_buffers(3)
        .sync(true)
        .build())
}

fn text_appsink() -> Result<AppSink, String> {
    let caps = gstreamer::Caps::builder("text/x-raw").build();
    Ok(AppSink::builder()
        .caps(&caps)
        .max_buffers(8)
        .sync(false)
        .build())
}

/// Pulls one video sample into a `FrameData` and shares it with the
/// component. Runs on the appsink's streaming thread.
fn video_frame_callback(
    weak: Weak<Mutex<Inner>>,
    emit: Emit,
    redraw: Redraw,
) -> impl FnMut(&AppSink) -> Result<gstreamer::FlowSuccess, gstreamer::FlowError> + Send + 'static {
    let mut framed = false;
    let mut info: Option<VideoInfo> = None;
    move |sink| {
        let Ok(sample) = sink.pull_sample() else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        let caps = match sample.caps() {
            Some(c) => c,
            None => return Ok(gstreamer::FlowSuccess::Ok),
        };
        if info.is_none() {
            match VideoInfo::from_caps(caps) {
                Ok(v) => info = Some(v),
                Err(_) => return Ok(gstreamer::FlowSuccess::Ok),
            }
        }
        let Some(vinfo) = &info else { return Ok(gstreamer::FlowSuccess::Ok) };
        let Some(buffer) = sample.buffer_owned() else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        let Ok(frame) = VideoFrame::from_buffer_readable(buffer, vinfo) else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        let (w, h) = (vinfo.width(), vinfo.height());
        let stride = frame.plane_stride().first().copied().unwrap_or(0).max(0) as usize;
        let row = w as usize * 4;
        let Ok(data) = frame.plane_data(0) else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        if stride < row || data.len() < stride * h as usize {
            return Ok(gstreamer::FlowSuccess::Ok);
        }
        let mut bgra = vec![0u8; row * h as usize];
        if stride == row {
            let n = bgra.len();
            bgra.copy_from_slice(&data[..n]);
        } else {
            for y in 0..h as usize {
                let (s, d) = (y * stride, y * row);
                bgra[d..d + row].copy_from_slice(&data[s..s + row]);
            }
        }
        // The alpha byte is padding in video/x-raw BGRA and decoders
        // leave it undefined; GPUI blends by it, so force opaque.
        for px in bgra.chunks_exact_mut(4) {
            px[3] = 255;
        }
        let fd = Arc::new(FrameData {
            seq: SEQ.fetch_add(1, Ordering::Relaxed),
            width: w,
            height: h,
            bgra,
        });
        let Some(inner) = weak.upgrade() else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        let (first, ms, wh) = {
            let Ok(mut i) = inner.lock() else {
                return Ok(gstreamer::FlowSuccess::Ok);
            };
            if i.dead {
                return Ok(gstreamer::FlowSuccess::Ok);
            }
            i.frames += 1;
            let first = !framed;
            framed = true;
            i.latest = Some(fd);
            let ms = i.started.elapsed().as_millis() as u64;
            let wh = i.latest.as_ref().map(|f| (f.width, f.height)).unwrap_or((0, 0));
            (first, ms, wh)
        };
        if first {
            (emit)("frame", json!({ "ms": ms, "width": wh.0, "height": wh.1 }));
            if let Ok(mut i) = inner.lock() {
                if !i.dead {
                    i.emit_load();
                }
            }
        }
        redraw();
        Ok(gstreamer::FlowSuccess::Ok)
    }
}

/// Turns subtitle buffers into `cues` events. Runs on the text sink's
/// streaming thread.
fn text_frame_callback(
    weak: Weak<Mutex<Inner>>,
    emit: Emit,
) -> impl FnMut(&AppSink) -> Result<gstreamer::FlowSuccess, gstreamer::FlowError> + Send + 'static {
    move |sink| {
        let Ok(sample) = sink.pull_sample() else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        let Some(buffer) = sample.buffer() else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        let Ok(map) = buffer.map_readable() else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        let text = String::from_utf8_lossy(map.as_slice()).into_owned();
        let Some(inner) = weak.upgrade() else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        let Ok(mut i) = inner.lock() else {
            return Ok(gstreamer::FlowSuccess::Ok);
        };
        if i.dead || !i.text_on {
            return Ok(gstreamer::FlowSuccess::Ok);
        }
        // text/x-raw buffers may carry a leading timestamp line or pango
        // markup; keep it simple — the app draws plain lines.
        let lines: Vec<String> = text
            .lines()
            .map(|l| l.trim().to_owned())
            .filter(|l| !l.is_empty())
            .collect();
        let start = buffer.pts().map(|t| t.seconds_f64()).unwrap_or(i.position);
        let dur = buffer.duration().map(|t| t.seconds_f64()).unwrap_or(0.0);
        i.cue = Some(Cue { end: start + dur, cleared: false });
        drop(i);
        (emit)("cues", json!({ "time": start, "lines": lines }));
        Ok(gstreamer::FlowSuccess::Ok)
    }
}

// --- The bus ----------------------------------------------------------------------

fn bus_loop(weak: Weak<Mutex<Inner>>, gen_: u64, bus: gstreamer::Bus) {
    loop {
        let Some(msg) = bus.timed_pop(Some(gstreamer::ClockTime::from_mseconds(500))) else {
            continue;
        };
        let Some(inner) = weak.upgrade() else { return };
        let Ok(mut i) = inner.lock() else { return };
        if i.dead || i.bus_gen != gen_ {
            return;
        }
        handle_message(&mut i, msg);
    }
}

fn handle_message(i: &mut Inner, msg: gstreamer::Message) {
    match msg.view() {
        gstreamer::MessageView::Error(e) => {
            let err = e.error();
            let debug = e.debug().unwrap_or_default();
            i.failed = true;
            i.set_playing_state(false);
            (i.emit)(
                "error",
                json!({
                    "message": format!("{err} {debug}"),
                    "code": "pipeline",
                    "fatal": true,
                }),
            );
        }
        gstreamer::MessageView::Eos(_) => {
            i.ended = true;
            i.set_playing_state(false);
            (i.emit)("end", json!({}));
        }
        gstreamer::MessageView::AsyncDone(_) => {
            if i.pending_seek.is_some() {
                let (target, at) = i.pending_seek.take().unwrap();
                let ms = at.elapsed().as_millis() as u64;
                i.last_seeked_ms = Some(ms);
                let time = i
                    .pipeline
                    .as_ref()
                    .and_then(|p| p.query_position::<gstreamer::ClockTime>())
                    .map(|t| t.seconds_f64());
                (i.emit)(
                    "seeked",
                    json!({ "target": target, "time": time, "finished": true, "ms": ms }),
                );
            }
        }
        gstreamer::MessageView::DurationChanged(_) => {
            if let Some(d) = i
                .pipeline
                .as_ref()
                .and_then(|p| p.query_duration::<gstreamer::ClockTime>())
                .map(|t| t.seconds_f64())
                .filter(|d| d.is_finite() && *d > 0.0)
            {
                i.duration = Some(d);
            }
            if !i.loaded {
                i.emit_load();
            }
        }
        gstreamer::MessageView::Buffering(b) => {
            let pct = b.percent();
            i.buffering_pct = Some(pct);
            let stalled = pct < 100;
            if stalled != i.stalled {
                i.stalled = stalled;
                (i.emit)(
                    "buffer",
                    json!({ "stalled": stalled, "reason": stalled.then_some("buffering") }),
                );
            }
        }
        gstreamer::MessageView::StreamCollection(sc) => {
            let collection = sc.stream_collection();
            let (mut audio, mut subs) = (Vec::new(), Vec::new());
            let mut other_ids = Vec::new();
            let mut has_video = false;
            let mut ai = 0usize;
            let mut ti = 0usize;
            for idx in 0..collection.size() {
                let Some(s) = collection.stream(idx) else { continue };
                use gstreamer::StreamType;
                let st = s.stream_type();
                let gst_id = s.stream_id().map(|g| g.to_string());
                if st.contains(StreamType::VIDEO) {
                    has_video = true;
                }
                let lang = s
                    .tags()
                    .and_then(|t| t.get::<gstreamer::tags::LanguageCode>().map(|v| v.get().to_owned()));
                let label = lang.clone().unwrap_or_else(|| "Track".to_owned());
                match s.stream_type() {
                    StreamType::AUDIO => {
                        audio.push(Track {
                            id: format!("a{ai}"),
                            label,
                            lang,
                            default: ai == 0,
                            selected: gst_id.as_ref().is_some_and(|id| i.sel_ids.contains(id)),
                            gst_id,
                        });
                        ai += 1;
                    }
                    StreamType::TEXT => {
                        subs.push(Track {
                            id: format!("t{ti}"),
                            label,
                            lang,
                            default: ti == 0,
                            selected: gst_id.as_ref().is_some_and(|id| i.sel_ids.contains(id)),
                            gst_id,
                        });
                        ti += 1;
                    }
                    _ => {
                        if let Some(id) = gst_id {
                            other_ids.push(id);
                        }
                    }
                }
            }
            i.audio = audio;
            i.subs = subs;
            i.other_ids = other_ids;
            i.no_video = !has_video;
            if !i.loaded {
                i.emit_load();
            } else {
                (i.emit)(
                    "tracks",
                    json!({
                        "audioTracks": i.audio.iter().map(Track::json).collect::<Vec<_>>(),
                        "subtitleTracks": i.subs.iter().map(Track::json).collect::<Vec<_>>(),
                    }),
                );
            }
        }
        gstreamer::MessageView::StreamsSelected(ss) => {
            use gstreamer::StreamType;
            i.sel_ids.clear();
            i.text_on = false;
            for s in ss.streams() {
                if let Some(id) = s.stream_id() {
                    i.sel_ids.insert(id.to_string());
                }
                if s.stream_type().contains(StreamType::TEXT) {
                    i.text_on = true;
                }
            }
            for t in i.audio.iter_mut().chain(i.subs.iter_mut()) {
                t.selected = t.gst_id.as_ref().is_some_and(|id| i.sel_ids.contains(id));
            }
            if i.loaded {
                (i.emit)(
                    "tracks",
                    json!({
                        "audioTracks": i.audio.iter().map(Track::json).collect::<Vec<_>>(),
                        "subtitleTracks": i.subs.iter().map(Track::json).collect::<Vec<_>>(),
                    }),
                );
            }
        }
        gstreamer::MessageView::Tag(t) => {
            // Stream tags (language etc.) — the stream collection above
            // carries what the contract needs.
            let _ = t;
        }
        _ => {}
    }
}
