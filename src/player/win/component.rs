//! `rustflix.video` on Windows: the Media Foundation player ([`super::mf`])
//! as an NSH native component. Same contract as `super::super::component`
//! (macOS): props `src`, `startAt`, `paused`, `muted`, `volume`, `rate`,
//! `fit`, `nowPlaying`, `maxResolution`, `frame`; commands `seek`,
//! `selectAudio`, `selectSubtitle`; events `ready`, `load`, `frame`,
//! `tracks`, `progress`, `buffer`, `seeked`, `rate`, `cues`, `end`,
//! `error`.
//!
//! Painting, as on Linux: each frame the player made becomes a
//! `RenderImage` (built on the player's thread, never copied here) uploaded
//! to the sprite atlas once; the frame it replaces is dropped from the atlas
//! in the next paint, so the atlas holds at most the frame on screen. A
//! paused player makes no frames, so nothing redraws.
//!
//! The picture's size on screen, in pixels, is the player's default decode
//! cap: it is sent whenever the `frame` rect or the window's scale changes.

use std::{cell::RefCell, panic::AssertUnwindSafe, rc::Rc, sync::Arc};

use nsh_platform_gpui::{
    ComponentContext, NativeComponent,
    gpui::{
        self, AnyElement, App, Bounds, Corners, Element, ElementId, GlobalElementId,
        InspectorElementId, IntoElement, LayoutId, ObjectFit, Pixels, Refineable, Style,
        StyleRefinement, Styled, Window, px,
    },
};
use serde_json::{Value as JsonValue, json};

use super::{
    Fit, direct,
    mf::{self, FrameData},
};

#[derive(Clone, Copy, Default, PartialEq, Debug)]
struct FrameRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

/// The frame on screen (the player's image for that frame seq).
struct Shown {
    seq: u64,
    image: Arc<gpui::RenderImage>,
}

pub(crate) struct Video {
    cx: ComponentContext,
    player: mf::Player,
    frame: FrameRect,
    /// The decode cap last sent to the player (pixels).
    sent_size: Option<(f64, f64)>,
    shown: Option<Shown>,
    /// The image the last painted element replaced: dropped from the
    /// atlas on the next paint.
    retired: Option<Arc<gpui::RenderImage>>,
    /// The child window the picture goes to while nothing is over it
    /// (`super::direct`), whether it is in use, and a hide put off by one
    /// frame so that GPUI's picture is on screen first.
    direct: Option<Rc<RefCell<direct::Window>>>,
    direct_on: bool,
    hide_pending: bool,
    /// The captions' window above it; `captions_failed` once it could not
    /// be made (the picture then stays GPUI's while a caption shows).
    captions: Option<Rc<RefCell<direct::CaptionWindow>>>,
    captions_failed: bool,
    /// The picture's window failed: not tried again before this.
    direct_retry: Option<std::time::Instant>,
}

impl Video {
    pub(crate) fn new(cx: ComponentContext) -> Video {
        let emit_cx = cx.clone();
        let redraw_cx = cx.clone();
        let player = mf::Player::new(
            Arc::new(move |name: &str, data: JsonValue| emit_cx.emit(name, data)),
            Arc::new(move || redraw_cx.redraw()),
        );
        // Its handle, for `sys.nativeVideo` (props wait for a frame of the
        // window; that op does not).
        cx.emit("ready", json!({ "handle": player.handle() }));
        Video {
            cx,
            player,
            frame: FrameRect::default(),
            sent_size: None,
            shown: None,
            retired: None,
            direct: None,
            direct_on: false,
            hide_pending: false,
            captions: None,
            captions_failed: false,
            direct_retry: None,
        }
    }

    /// Runs `f`; a panic becomes an `error` event.
    fn safely(&mut self, what: &str, f: impl FnOnce(&mut Video)) {
        if std::panic::catch_unwind(AssertUnwindSafe(|| f(self))).is_err() {
            self.cx.emit("error", json!({ "message": format!("internal error in {what}"), "code": "internal", "fatal": false }));
        }
    }

    /// The player's newest frame. When its seq moved, the image it
    /// replaces retires to the atlas drop.
    fn shown_image(&mut self) -> Option<Arc<gpui::RenderImage>> {
        let fd: Arc<FrameData> = self.player.frame()?;
        if self.shown.as_ref().is_none_or(|s| s.seq != fd.seq) {
            let next = Shown { seq: fd.seq, image: fd.image.clone() };
            self.retired = self.shown.replace(next).map(|s| s.image);
        }
        Some(fd.image.clone())
    }

    /// Switches the picture between GPUI and the child window as `want`.
    fn set_direct(&mut self, want: bool) {
        let mut want = want;
        if want && self.direct.is_none() {
            match crate::win::shell::app_window().map(direct::Window::new) {
                Some(Ok(window)) => self.direct = Some(Rc::new(RefCell::new(window))),
                Some(Err(e)) => {
                    log::debug!("player: no window for the picture: {e}");
                    want = false;
                }
                None => want = false,
            }
        }
        if want == self.direct_on {
            return;
        }
        log::debug!("player: picture {}", if want { "in its own window" } else { "in the app's drawing" });
        self.direct_on = want;
        self.hide_pending = false;
        let hwnd = self.direct.as_ref().map_or(0, |w| w.borrow().handle());
        self.player.set_direct(want, hwnd);
    }

    /// The captions' window, made on first use; `None` where the system
    /// makes no layered child windows.
    fn captions_window(&mut self) -> Option<Rc<RefCell<direct::CaptionWindow>>> {
        if self.captions.is_none() && !self.captions_failed {
            match crate::win::shell::app_window().map(direct::CaptionWindow::new) {
                Some(Ok(window)) => self.captions = Some(Rc::new(RefCell::new(window))),
                Some(Err(e)) => {
                    log::debug!("player: no window for captions: {e}");
                    self.captions_failed = true;
                }
                None => {}
            }
        }
        self.captions.clone()
    }

    /// Hides the child window once GPUI's picture has had a frame.
    fn hide_direct(&mut self, painted: bool) {
        let Some(window) = self.direct.as_ref() else { return };
        if !window.borrow().visible() {
            self.hide_pending = false;
        } else if !painted || self.hide_pending {
            window.borrow().hide();
            self.hide_pending = false;
        } else {
            self.hide_pending = true;
            self.cx.redraw();
        }
    }
}

/// How long the picture stays in the app's drawing after its window failed.
const DIRECT_RETRY: std::time::Duration = std::time::Duration::from_secs(3);

fn num(v: Option<&JsonValue>, key: &str) -> f32 {
    v.and_then(|v| v.get(key)).and_then(JsonValue::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0) as f32
}

/// Paints one `RenderImage` with `ObjectFit`, like gpui's `surface`
/// element does for CVPixelBuffers on macOS. `drop` is the image this one
/// replaced: removed from the atlas during this paint.
struct FrameElement {
    /// `None` while the picture is in the child window `place`.
    image: Option<Arc<gpui::RenderImage>>,
    /// The child window to put where the picture goes, and the picture's size.
    place: Option<(Rc<RefCell<direct::Window>>, (u32, u32))>,
    /// The captions' window and what it shows over the picture's window.
    caption: Option<(Rc<RefCell<direct::CaptionWindow>>, Option<direct::Caption>)>,
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
        (window.request_layout(style, [], cx), ())
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
        if let Some((child, (w, h))) = self.place.take() {
            if w > 0 && h > 0 {
                let size = gpui::size(gpui::DevicePixels(w as i32), gpui::DevicePixels(h as i32));
                let at = self.object_fit.get_bounds(bounds, size);
                let scale = window.scale_factor();
                let device = |v: Pixels| (f32::from(v) * scale).round() as i32;
                let (x, y) = (device(at.origin.x), device(at.origin.y));
                let (r, b) = (device(at.origin.x + at.size.width), device(at.origin.y + at.size.height));
                if child.borrow_mut().place((x, y, r - x, b - y)) {
                    // It went to the top: the caption goes back over it.
                    if let Some((captions, _)) = &self.caption {
                        captions.borrow().raise();
                    }
                }
            }
        }
        if let Some((captions, caption)) = self.caption.take() {
            let scale = window.scale_factor();
            let device = |v: Pixels| (f32::from(v) * scale).round() as i32;
            let (x, y) = (device(bounds.origin.x), device(bounds.origin.y));
            let area = (x, y, device(bounds.origin.x + bounds.size.width) - x, device(bounds.origin.y + bounds.size.height) - y);
            match caption {
                Some(caption) => captions.borrow_mut().show(&caption, area, scale),
                None => captions.borrow_mut().hide(),
            }
        }
        let Some(image) = self.image.clone() else { return };
        if image.frame_count() == 0 {
            return;
        }
        let image_bounds = self.object_fit.get_bounds(bounds, image.size(0));
        let _ = window.paint_image(bounds, image_bounds, Corners::default(), image, 0, false);
        mf::PAINTED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
    fn render(&mut self, window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        let f = self.frame;
        if f.w <= 0.0 || f.h <= 0.0 {
            if let Some(captions) = &self.captions {
                captions.borrow_mut().hide();
            }
            self.set_direct(false);
            self.hide_direct(false);
            return None;
        }
        // The decode cap: the picture's size in pixels at this window's scale.
        let scale = f64::from(window.scale_factor());
        let size = Some(((f64::from(f.w) * scale).round(), (f64::from(f.h) * scale).round()));
        if size != self.sent_size {
            self.sent_size = size;
            self.player.set_display_size(size);
        }
        let fit = match self.player.fit() {
            Fit::Contain => ObjectFit::Contain,
            Fit::Cover => ObjectFit::Cover,
        };
        // Outside GPUI while nothing is drawn over the picture, where GPUI
        // draws on the CPU; a cropped picture (cover) stays GPUI's.
        let mut want = self.player.uncovered() && matches!(fit, ObjectFit::Contain) && direct::allowed(direct::software());
        // A frame that could not go to the window: the worker already sends
        // frames to GPUI; the window comes down, and is tried again later.
        if self.player.take_direct_failed() {
            self.direct_retry = Some(std::time::Instant::now() + DIRECT_RETRY);
        }
        if self.direct_retry.is_some_and(|at| std::time::Instant::now() < at) {
            want = false;
        }
        // A caption shows over the picture's window in a window of its own.
        let caption = self.player.caption();
        let captions = if want && caption.is_some() { self.captions_window() } else { self.captions.clone() };
        if caption.is_some() && captions.is_none() {
            want = false;
        }
        self.set_direct(want);
        let (image, place, caption) = if self.direct_on {
            let place = self.direct.clone().map(|w| (w, self.player.picture_size()));
            (None, place, captions.map(|w| (w, caption)))
        } else {
            if let Some(captions) = &captions {
                captions.borrow_mut().hide();
            }
            let image = self.shown_image();
            self.hide_direct(image.is_some());
            (Some(image?), None, None)
        };
        // The element itself carries the frame rect: a child with default
        // style would lay out 0x0 and paint nothing.
        Some(
            FrameElement { image, place, caption, drop: self.retired.take(), object_fit: fit, style: StyleRefinement::default() }
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
            "frame" => {
                let f = FrameRect { x: num(value, "x"), y: num(value, "y"), w: num(value, "width"), h: num(value, "height") };
                if f != v.frame {
                    v.frame = f;
                    v.cx.redraw();
                }
            }
            // `nowPlaying`: no Now Playing / media keys on Windows yet.
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
            // enterPip / exitPip: no picture in picture on Windows.
            _ => {}
        });
    }
}
