//! `rustflix.video` on Linux: the GStreamer player ([`super::gst`]) as an
//! NSH native component. Same contract as `super::super::component`
//! (macOS): props `src`, `startAt`, `paused`, `muted`, `volume`, `rate`,
//! `fit`, `nowPlaying`, `maxResolution`, `frame`; commands `seek`,
//! `selectAudio`, `selectSubtitle`; events `ready`, `load`, `frame`,
//! `tracks`, `progress`, `buffer`, `seeked`, `rate`, `pip`, `cues`,
//! `end`, `error`.
//!
//! Painting: gpui-fast's `surface`/`paint_surface` is macOS/iOS-only
//! (CVPixelBuffer), so each decoded BGRA frame becomes a `RenderImage`
//! uploaded to the sprite atlas once per video frame. The previous
//! frame's image is dropped from the atlas in the same paint
//! (`Window::drop_image`), so the atlas holds at most the frame on
//! screen. A paused pipeline delivers no samples, so no frames are made
//! and nothing redraws.

use std::{panic::AssertUnwindSafe, sync::Arc};

use image::{Frame, ImageBuffer, Rgba};
use nsh_platform_gpui::{
    ComponentContext, NativeComponent,
    gpui::{
        self, AnyElement, App, Bounds, Corners, Element, ElementId, GlobalElementId,
        InspectorElementId, IntoElement, LayoutId, ObjectFit, Pixels, Refineable,
        Style, StyleRefinement, Styled, Window, px,
    },
};
use serde_json::{Value as JsonValue, json};
use smallvec::SmallVec;

use super::{
    Fit,
    gst::{self, FrameData},
};

#[derive(Clone, Copy, Default, PartialEq, Debug)]
struct FrameRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

/// The newest decoded frame as a GPUI image (built once per frame seq).
struct Shown {
    seq: u64,
    image: Arc<gpui::RenderImage>,
}

pub(crate) struct Video {
    cx: ComponentContext,
    player: gst::Player,
    frame: FrameRect,
    shown: Option<Shown>,
    /// The image the last painted element replaced: dropped from the
    /// atlas on the next paint (its sprite is only in last frame's
    /// scene, already drawn).
    retired: Option<Arc<gpui::RenderImage>>,
}

impl Video {
    pub(crate) fn new(cx: ComponentContext) -> Video {
        let emit_cx = cx.clone();
        let redraw_cx = cx.clone();
        let player = gst::Player::new(
            Arc::new(move |name: &str, data: JsonValue| emit_cx.emit(name, data)),
            Arc::new(move || redraw_cx.redraw()),
        );
        // Its handle, for `sys.nativeVideo` (props wait for a frame of
        // the window; that op does not).
        cx.emit("ready", json!({ "handle": player.handle() }));
        Video { cx, player, frame: FrameRect::default(), shown: None, retired: None }
    }

    /// Runs `f`; a panic becomes an `error` event.
    fn safely(&mut self, what: &str, f: impl FnOnce(&mut Video)) {
        if std::panic::catch_unwind(AssertUnwindSafe(|| f(self))).is_err() {
            self.cx.emit("error", json!({ "message": format!("internal error in {what}"), "code": "internal", "fatal": false }));
        }
    }

    /// The current frame as a `RenderImage`, rebuilt only when the
    /// player's seq moved. The replaced image retires to the atlas drop.
    fn shown_image(&mut self) -> Option<Arc<gpui::RenderImage>> {
        let fd: Arc<FrameData> = self.player.frame()?;
        if self.shown.as_ref().is_some_and(|s| s.seq == fd.seq) {
            return self.shown.as_ref().map(|s| s.image.clone());
        }
        // BGRA bytes in an Rgba-typed buffer: the atlas reads bytes, the
        // pixel type is only the container (same trick as gpui's WebP
        // path, which swaps RGBA→BGRA before Frame::new).
        let buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_raw(fd.width, fd.height, fd.bgra.clone())?;
        let image = Arc::new(gpui::RenderImage::new(SmallVec::from_elem(
            Frame::new(buffer),
            1,
        )));
        self.retired = self.shown.replace(Shown { seq: fd.seq, image: image.clone() }).map(|s| s.image);
        Some(image)
    }
}

fn num(v: Option<&JsonValue>, key: &str) -> f32 {
    v.and_then(|v| v.get(key)).and_then(JsonValue::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0) as f32
}

/// Paints one `RenderImage` with `ObjectFit`, like gpui's `surface`
/// element does for CVPixelBuffers on macOS. `drop` is the image this
/// one replaced: removed from the atlas during this paint.
struct FrameElement {
    image: Arc<gpui::RenderImage>,
    drop: Option<Arc<gpui::RenderImage>>,
    object_fit: ObjectFit,
    style: StyleRefinement,
}

impl Element for FrameElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.refine(&self.style);
        let layout_id = window.request_layout(style, [], cx);
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
    }

    fn paint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        if let Some(old) = self.drop.take() {
            // Its sprite was only in the previous frame's scene, already
            // drawn: safe to free the atlas tile now.
            let _ = window.drop_image(old);
        }
        if self.image.frame_count() == 0 {
            return;
        }
        let image_bounds =
            self.object_fit.get_bounds(bounds, self.image.size(0));
        let _ = window.paint_image(
            bounds,
            image_bounds,
            Corners::default(),
            self.image.clone(),
            0,
            false,
        );
    }
}

impl IntoElement for FrameElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Styled for FrameElement {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl NativeComponent for Video {
    fn render(&mut self, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        let f = self.frame;
        if f.w <= 0.0 || f.h <= 0.0 {
            return None;
        }
        let image = self.shown_image()?;
        let fit = match self.player.fit() {
            Fit::Contain => ObjectFit::Contain,
            Fit::Cover => ObjectFit::Cover,
        };
        // The element itself carries the frame rect: a child with default
        // style would lay out 0x0 and paint nothing.
        Some(
            FrameElement {
                image,
                drop: self.retired.take(),
                object_fit: fit,
                style: StyleRefinement::default(),
            }
            .absolute()
            .left(px(f.x))
            .top(px(f.y))
            .w(px(f.w))
            .h(px(f.h))
            .overflow_hidden()
            .into_any_element(),
        )
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>, _window: &mut Window, _cx: &mut App) {
        let name = name.to_owned();
        self.safely("set_prop", move |v| match name.as_str() {
            "src" => v.player.set_src(value.and_then(JsonValue::as_str)),
            "startAt" => v.player.set_start_at(value.and_then(JsonValue::as_f64).unwrap_or(0.0)),
            "paused" => v.player.set_paused(value.and_then(JsonValue::as_bool).unwrap_or(false)),
            "muted" => v.player.set_muted(value.and_then(JsonValue::as_bool).unwrap_or(false)),
            "volume" => v.player.set_volume(value.and_then(JsonValue::as_f64).unwrap_or(1.0) as f32),
            "rate" => v.player.set_rate(value.and_then(JsonValue::as_f64).unwrap_or(1.0) as f32),
            "fit" => {
                v.player.set_fit(Fit::parse(value.and_then(JsonValue::as_str)));
                v.cx.redraw();
            }
            "maxResolution" => v.player.set_max_resolution(super::size_of(value)),
            "nowPlaying" => v.player.set_now_playing(super::NowPlaying::parse(value)),
            "frame" => {
                let f = FrameRect { x: num(value, "x"), y: num(value, "y"), w: num(value, "width"), h: num(value, "height") };
                if f != v.frame {
                    v.frame = f;
                    v.player.set_display_size((f.w > 0.0 && f.h > 0.0).then_some((f.w as f64, f.h as f64)));
                    v.cx.redraw();
                }
            }
            _ => {}
        });
    }

    fn command(&mut self, name: &str, args: &JsonValue, _window: &mut Window, _cx: &mut App) {
        let name = name.to_owned();
        let args = args.clone();
        self.safely("command", move |v| match name.as_str() {
            "seek" => v.player.seek(args.get("time").and_then(JsonValue::as_f64).unwrap_or(0.0)),
            "selectAudio" => {
                if let Some(id) = args.get("id").and_then(JsonValue::as_str) {
                    v.player.select(false, Some(id));
                }
            }
            "selectSubtitle" => v.player.select(true, args.get("id").and_then(JsonValue::as_str)),
            // enterPip / exitPip: no picture in picture on Linux.
            _ => {}
        });
    }
}
