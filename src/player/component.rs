//! `rustflix.video`: the AVPlayer ([`super::av`]) as an NSH native
//! component, painted by GPUI from the video output's pixel buffers. The
//! cross-platform contract is `scratchpad/native/contract.md` §1.
//!
//! Props: `src`, `startAt`, `paused`, `muted`, `volume`, `rate`, `fit`,
//! `nowPlaying` (`{title, subtitle?, artwork?}`),
//! (`contain` | `cover`), `maxResolution` (`{width, height}` pixels),
//! `frame` (`{x?, y?, width, height}`: where the picture goes, in points,
//! from the component's own top-left corner). Commands: `seek {time}`,
//! `selectAudio {id}`, `selectSubtitle {id | null}`, `enterPip`, `exitPip`.
//! Events: `ready {handle}` at once when it is made, `load {duration, width,
//! height, audioTracks, subtitleTracks, ms}`, `frame {ms, width, height}`
//! (the first buffer), `tracks`, `progress {currentTime, buffered,
//! playable}` (4 Hz), `buffer {stalled, reason}`, `seeked {target, time,
//! finished, ms}`, `rate {rate, paused, by?}`, `pip {active, possible}`,
//! `cues {time, lines}` (the selected subtitle track's text), `end`, `error
//! {message, code, fatal}`.
//!
//! NSH delivers props and commands with the next frame the window draws
//! (native.rs `prepaint` → `deliver`); an occluded window draws none, so
//! `sys.nativeVideo {handle, …}` (`super::register_host`) sets the same
//! things at once, by the `ready` handle. Both may be used; the same `src`
//! twice changes nothing.
//!
//! The picture is painted at `frame`, not at the component's box: the app
//! gives the component an EMPTY box (0×0, at the picture's top-left), so
//! NSH inserts no mouse-blocking hitbox for it (native.rs `prepaint`: the
//! `BlockMouse` hitbox only when the box shows) and NSH's own controls
//! drawn after it keep their clicks. `cover` is clipped to `frame`.
//!
//! Redraws: only when the display link brought a new buffer (`av`), so
//! 24–30 a second for film, none while paused; never per display frame.
//! The decoded size is capped at `frame` × the window's scale (AVPlayer's
//! `preferredMaximumResolution`) unless `maxResolution` says otherwise.

use std::{panic::AssertUnwindSafe, rc::Rc};

use nsh_platform_gpui::{
    ComponentContext, NativeComponent,
    gpui::{self, AnyElement, App, IntoElement, ObjectFit, ParentElement, Styled, Window, px},
};
use serde_json::{Value as JsonValue, json};

use super::av::{self, Fit};

#[derive(Clone, Copy, Default, PartialEq)]
struct Frame {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

pub(crate) struct Video {
    cx: ComponentContext,
    player: av::Player,
    frame: Frame,
}

impl Video {
    pub(crate) fn new(cx: ComponentContext) -> Video {
        let emit_cx = cx.clone();
        let redraw_cx = cx.clone();
        let player = av::Player::new(
            Rc::new(move |name: &str, data: JsonValue| emit_cx.emit(name, data)),
            Rc::new(move || redraw_cx.redraw()),
        );
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
    fn render(&mut self, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        let f = self.frame;
        if f.w <= 0.0 || f.h <= 0.0 {
            return None;
        }
        if self.player.pip_active() {
            // The video plays in the PiP window: say so where it was.
            return Some(
                gpui::div()
                    .absolute()
                    .left(px(f.x))
                    .top(px(f.y))
                    .w(px(f.w))
                    .h(px(f.h))
                    .bg(gpui::black())
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(gpui::white())
                    .child("Playing in picture in picture")
                    .into_any_element(),
            );
        }
        let buffer = self.player.frame()?;
        let fit = match self.player.fit() {
            Fit::Contain => ObjectFit::Contain,
            Fit::Cover => ObjectFit::Cover,
        };
        Some(
            gpui::div()
                .absolute()
                .left(px(f.x))
                .top(px(f.y))
                .w(px(f.w))
                .h(px(f.h))
                .overflow_hidden()
                .child(gpui::surface(buffer).object_fit(fit).size_full())
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
            "maxResolution" => v.player.set_max_resolution(av::size_of(value)),
            "nowPlaying" => v.player.set_now_playing(av::NowPlaying::parse(value)),
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
            "enterPip" => v.player.pip(true),
            "exitPip" => v.player.pip(false),
            _ => {}
        });
    }
}
