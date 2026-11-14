//! The app's own video player (stage-0 spike, behind the Storage flag
//! `rustflix.nativeplayer`): an AVPlayer painted in the app's window as the
//! NSH native component `rustflix.video` (`app/lib/nativevideo.tsx`),
//! playing the local proxy's URLs (`src/stream`). The shipping player
//! (`screens/Player.tsx`, a web view) does not use it.
//!
//! - [`av`]: the AVPlayer, its video output and events (no NSH types);
//! - [`component`]: the NSH component around it;
//! - `sys.nativeVideoInfo` → `{ok, available, version: 1, pip, fullscreen,
//!   local, nowPlaying, embeddedSubtitles, subtitleCues}` (contract R1, R5);
//! - `sys.nativePlayers` → `{live, playing}`: players that exist / play now
//!   (the debug hook checks that leaving stops everything);
//! - `sys.nativeVideo {handle, src?, startAt?, paused?, muted?, volume?, rate?, fit?,
//!   maxResolution?, frame?, nowPlaying?, seek?, selectAudio?, selectSubtitle?, pip?}`
//!   → `{ok}`: a player's props and seek by the handle of its `ready`
//!   event, without waiting for a frame of the window (see `component`).

#[cfg(target_os = "macos")]
pub(crate) mod av;
#[cfg(target_os = "macos")]
mod component;

use nsh_engine::HostChannel;
use nsh_platform_gpui::Components;

/// The component's name in `nativeComponent(...)`.
pub(crate) const NAME: &str = "rustflix.video";

/// Registers `rustflix.video` (macOS; elsewhere it renders an empty view).
pub(crate) fn register(components: &Components) {
    #[cfg(target_os = "macos")]
    components.register(NAME, std::rc::Rc::new(|cx| Box::new(component::Video::new(cx))));
    #[cfg(not(target_os = "macos"))]
    let _ = components;
}

/// `sys.nativeVideoInfo`, `sys.nativePlayers`, `sys.nativeVideo`.
pub(crate) fn register_host(host: &HostChannel) {
    // What the app's player may count on here (contract R1): it turns the
    // native player on in "auto". `local`: finished downloads play from the
    // downloader's 127.0.0.1 server (`…/<token>/<id>/<file>`, Range + HLS).
    host.handle("sys.nativeVideoInfo", |call| {
        let info = |pip: bool| {
            let available = cfg!(target_os = "macos");
            serde_json::json!({
                "ok": true, "available": available, "version": 1,
                "pip": pip, "fullscreen": false, "local": available, "nowPlaying": available,
                // The stream's own subtitle tracks come out as `cues` events
                // (an AVPlayerItemLegibleOutput) for the app to draw.
                "embeddedSubtitles": available, "subtitleCues": available,
            })
        };
        #[cfg(target_os = "macos")]
        // AVKit is asked on the main thread.
        dispatch2::DispatchQueue::main().exec_async(move || call.resolve(info(av::pip_supported())));
        #[cfg(not(target_os = "macos"))]
        call.resolve(info(false));
    });
    host.handle("sys.nativeVideo", |call| {
        #[cfg(target_os = "macos")]
        {
            let data = call.data().clone();
            // The players live on the main thread (AVFoundation's).
            dispatch2::DispatchQueue::main().exec_async(move || {
                let ok = data.get("handle").and_then(serde_json::Value::as_u64).is_some_and(|h| av::control(h, &data));
                call.resolve(serde_json::json!({ "ok": ok }));
            });
        }
        #[cfg(not(target_os = "macos"))]
        call.resolve(serde_json::json!({ "ok": false }));
    });
    host.handle("sys.nativePlayers", |call| {
        #[cfg(target_os = "macos")]
        let (live, playing) = (
            av::LIVE.load(std::sync::atomic::Ordering::Relaxed),
            av::PLAYING.load(std::sync::atomic::Ordering::Relaxed),
        );
        #[cfg(not(target_os = "macos"))]
        let (live, playing) = (0usize, 0usize);
        call.resolve(serde_json::json!({ "ok": true, "live": live, "playing": playing }));
    });
}
