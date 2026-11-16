//! The Windows player: Media Foundation's `IMFMediaEngine` in frame-server
//! mode decodes the stream; each new frame is copied into a D3D11 texture
//! (`TransferVideoFrame`), read back to BGRA and painted by GPUI through the
//! image atlas, as on Linux (gpui-fast's `surface`/`paint_surface` is
//! macOS/iOS-only). See [`mf`] for the threads, [`component`] for the
//! painting.
//!
//! Media Foundation ships with Windows (desktop editions; Windows Server
//! has it with Desktop Experience), so nothing is installed beside the app.
//! It reads HLS (`.m3u8`) and MP4 itself; its WebVTT subtitle renditions
//! come through `IMFTimedText`, its audio renditions as the engine's
//! streams.
//!
//! Same contract as `super::av` (see `super::component`'s header and
//! `app/lib/nativevideo.tsx`), with these platform limits:
//! - picture in picture does not exist (`pip` is a no-op);
//! - Now Playing / media keys are not wired (`nowPlaying` is ignored);
//! - `maxResolution` caps the decoded picture's size (the frame the app
//!   paints), not the HLS rendition Media Foundation picks by bandwidth.

pub(crate) mod component;
mod mf;
mod wic;

pub(crate) use mf::{LIVE, PLAYING, available, control};

/// `sys.nativeVideoInfo.pip`: no picture in picture on Windows.
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
