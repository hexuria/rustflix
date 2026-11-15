//! `rustflix.video` on Windows: the libmpv player ([`super`]) painted by
//! GPUI's sprite atlas as BGRA `RenderImage`s. Same contract as the macOS
//! component (`super::super::component`) — see its header for props,
//! commands and events. The picture is painted at `frame` with
//! `ObjectFit`; the previous atlas tile is dropped on each new frame so
//! the sprite atlas doesn't grow without bound.

use std::panic::AssertUnwindSafe;

use nsh_platform_gpui::{
    ComponentContext, NativeComponent,
    gpui::{self, AnyElement, App, Corners, IntoElement, ObjectFit, ParentElement, Styled, Window, canvas, px},
};
use serde_json::{Value as JsonValue, json};

use super::Fit;

#[derive(Clone, Copy, Default, PartialEq)]
struct Frame {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

pub(crate) struct Video {
    cx: ComponentContext,
    player: super::Player,
    frame: Frame,
}

impl Video {
    pub(crate) fn new(cx: ComponentContext) -> Video {
        let player = super::Player::new(cx.clone());
        // Its handle, for `sys.nativeVideo` (props wait for a frame of the
        // window; that op does not).
        cx.emit("ready", json!({ "handle": player.handle() }));
        Video { cx, player, frame: Frame::default() }
    }

    /// Runs `f`; a panic becomes an `error` event.
    fn safely(&mut self, what: &str, f: impl FnOnce(&mut Video)) {
        if std::panic::catch_unwind(AssertUnwindSafe(|| f(self))).is_err() {
            self.cx.emit("error", json!({ "message": format!("internal error in {what}"), "code": "internal", "fatal": false }));
        }
    }
}

fn num(v: Option<&JsonValue>, key: &str) -> f32 {
    v.and_then(|v| v.get(key)).and_then(JsonValue::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0) as f32
}

impl NativeComponent for Video {
    fn render(&mut self, window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        let f = self.frame;
        if f.w <= 0.0 || f.h <= 0.0 {
            return None;
        }
        // Swap in the newest frame and drop the previous atlas tile.
        let image = self.player.take_for_paint(window)?;
        let fit = match self.player.fit() {
            Fit::Contain => ObjectFit::Contain,
            Fit::Cover => ObjectFit::Cover,
        };
        let image2 = image.clone();
        Some(
            gpui::div()
                .absolute()
                .left(px(f.x))
                .top(px(f.y))
                .w(px(f.w))
                .h(px(f.h))
                .overflow_hidden()
                .child(
                    canvas(
                        move |bounds, _window, _cx| bounds,
                        move |bounds, _pre, window, _cx| {
                            let img_bounds = fit.get_bounds(bounds, image2.size(0));
                            let _ = window.paint_image(
                                bounds,
                                img_bounds,
                                Corners::default(),
                                image2.clone(),
                                0,
                                false,
                            );
                        },
                    )
                    .size_full(),
                )
                .into_any_element(),
        )
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>, window: &mut Window, _cx: &mut App) {
        let name = name.to_owned();
        let scale = window.scale_factor() as f64;
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
            "nowPlaying" => {} // unsupported on Windows
            "frame" => {
                let f = Frame { x: num(value, "x"), y: num(value, "y"), w: num(value, "width"), h: num(value, "height") };
                if f != v.frame {
                    v.frame = f;
                    let px = (f.w > 0.0 && f.h > 0.0).then(|| (f.w as f64 * scale, f.h as f64 * scale));
                    v.player.set_display_size(px);
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
            _ => {}
        });
    }
}
