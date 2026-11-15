//! The Linux player: GStreamer decodes the stream to BGRA frames
//! ([`gst`]), painted by GPUI through the image atlas — gpui-fast's
//! `surface`/`paint_surface` is macOS/iOS-only (CVPixelBuffer), so on
//! Linux each decoded frame becomes a `RenderImage` uploaded to the
//! sprite atlas once ([`component`]).
//!
//! Same contract as `super::av` (see `super::component`'s header and
//! `app/lib/nativevideo.tsx`): props, the `ready` handle and
//! `sys.nativeVideo` reach the player without a drawn frame; events are
//! `ready`-adjacent `load`, `frame`, `tracks`, `progress` (4 Hz),
//! `buffer`, `seeked`, `rate`, `end`, `error`, `cues`.
//!
//! Differences from AVPlayer, by platform limits:
//! - picture in picture does not exist (`pip` is a no-op, `pip` events
//!   report `possible: false`);
//! - Now Playing / media keys are not wired (`nowPlaying` is ignored);
//! - playback rate goes through `gst_element_seek`'s rate — sinks that
//!   cannot follow it simply keep their rate (reported back through
//!   `rate` events as the pipeline reports it).

pub(crate) mod component;
mod gst;

pub(crate) use gst::{LIVE, PLAYING, control};

/// `sys.nativeVideoInfo.pip`: no picture in picture on Linux.
pub(crate) fn pip_supported() -> bool {
    false
}

/// How the picture fits its `frame` rect (`contain` | `cover`).
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

/// `{width, height}` → a size (positive numbers only).
pub(crate) fn size_of(v: Option<&serde_json::Value>) -> Option<(f64, f64)> {
    let v = v?;
    let w = v.get("width")?.as_f64()?;
    let h = v.get("height")?.as_f64()?;
    (w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0).then_some((w, h))
}

/// Now Playing info (`nowPlaying` prop / `sys.nativeVideo`): accepted
/// and ignored — there is no MPRIS wiring yet.
#[allow(dead_code)]
#[derive(Clone, Debug, Default)]
pub(crate) struct NowPlaying {
    pub(crate) title: String,
    pub(crate) subtitle: Option<String>,
    pub(crate) artwork: Option<String>,
}

impl NowPlaying {
    pub(crate) fn parse(v: Option<&serde_json::Value>) -> Option<NowPlaying> {
        let v = v?;
        if v.is_null() {
            return None;
        }
        let title = v.get("title").and_then(serde_json::Value::as_str).unwrap_or("").to_owned();
        Some(NowPlaying {
            title,
            subtitle: v.get("subtitle").and_then(serde_json::Value::as_str).map(str::to_owned),
            artwork: v.get("artwork").and_then(serde_json::Value::as_str).map(str::to_owned),
        })
    }
}
