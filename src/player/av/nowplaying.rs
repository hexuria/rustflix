//! Now Playing and the media keys: `MPNowPlayingInfoCenter` shows the
//! player that last started (title / subtitle / artwork from the
//! `nowPlaying` prop, duration, position, rate), and `MPRemoteCommandCenter`
//! takes the keyboard's media keys, Control Centre and headphone buttons:
//! play, pause, toggle, skip ±10 s, change position. A remote play/pause
//! changes the player itself and says so — `rate {rate, paused, by:
//! "remote"}`, the shape iOS uses — so the app's state follows.

use std::cell::{Cell, RefCell};

use block2::RcBlock;
use objc2::{msg_send, rc::Retained, runtime::AnyObject};
use serde_json::{Value, json};

use super::{CGSize, Inner, Obj, SendBox, background, class, constant, guarded, lookup};

#[link(name = "MediaPlayer", kind = "framework")]
unsafe extern "C" {
    static MPMediaItemPropertyTitle: *const AnyObject;
    static MPMediaItemPropertyArtist: *const AnyObject;
    static MPMediaItemPropertyPlaybackDuration: *const AnyObject;
    static MPMediaItemPropertyArtwork: *const AnyObject;
    static MPNowPlayingInfoPropertyElapsedPlaybackTime: *const AnyObject;
    static MPNowPlayingInfoPropertyPlaybackRate: *const AnyObject;
    static MPNowPlayingInfoPropertyMediaType: *const AnyObject;
}

/// The `nowPlaying` prop.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Info {
    pub title: String,
    pub subtitle: Option<String>,
    pub artwork: Option<String>,
}

impl Info {
    pub(crate) fn parse(v: Option<&Value>) -> Option<Info> {
        let v = v?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
        Some(Info { title: s("title")?, subtitle: s("subtitle"), artwork: s("artwork") })
    }
}

thread_local! {
    /// The player Now Playing shows.
    static OWNER: Cell<Option<u64>> = const { Cell::new(None) };
    /// The command targets (registered once; they act on the owner).
    static TARGETS: RefCell<Vec<Obj>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone, Copy)]
enum Remote {
    Play,
    Pause,
    Toggle,
    Skip(f64),
    Position(f64),
}

/// A remote command for the owner, on the main thread's next turn.
fn remote(action: Remote) {
    dispatch2::DispatchQueue::main().exec_async(move || {
        let Some(id) = OWNER.with(Cell::get) else { return };
        let Some(p) = lookup(id) else { return };
        let Ok(mut i) = p.try_borrow_mut() else { return };
        i.remote(action);
    });
}

/// Registers the command targets once.
fn register_commands() {
    if TARGETS.with(|t| !t.borrow().is_empty()) {
        return;
    }
    let Ok(center_cls) = class(c"MPRemoteCommandCenter") else { return };
    let Ok(number_cls) = class(c"NSNumber") else { return };
    let Ok(array_cls) = class(c"NSArray") else { return };
    // SAFETY: MPRemoteCommandCenter's commands and their block targets
    // (copied by MediaPlayer, called on the main thread, returning
    // MPRemoteCommandHandlerStatus).
    let _ = guarded("remote commands", || unsafe {
        let center: Option<Obj> = msg_send![center_cls, sharedCommandCenter];
        let Some(center) = center else { return };
        let mut tokens = Vec::new();
        let mut add = |name: &str, f: Box<dyn Fn(*mut AnyObject)>| {
            let cmd: Option<Obj> = match name {
                "play" => msg_send![&*center, playCommand],
                "pause" => msg_send![&*center, pauseCommand],
                "toggle" => msg_send![&*center, togglePlayPauseCommand],
                "forward" => msg_send![&*center, skipForwardCommand],
                "back" => msg_send![&*center, skipBackwardCommand],
                _ => msg_send![&*center, changePlaybackPositionCommand],
            };
            let Some(cmd) = cmd else { return };
            if name == "forward" || name == "back" {
                let ten: Option<Obj> = msg_send![number_cls, numberWithDouble: 10.0f64];
                if let Some(ten) = ten {
                    let list: Option<Obj> = msg_send![array_cls, arrayWithObject: &*ten];
                    if let Some(list) = list {
                        let _: () = msg_send![&*cmd, setPreferredIntervals: &*list];
                    }
                }
            }
            let _: () = msg_send![&*cmd, setEnabled: objc2::runtime::Bool::YES];
            let block = RcBlock::new(move |event: *mut AnyObject| -> isize {
                f(event);
                0 // MPRemoteCommandHandlerStatusSuccess
            });
            let token: Option<Obj> = msg_send![&*cmd, addTargetWithHandler: &*block];
            if let Some(t) = token {
                tokens.push(t);
            }
        };
        add("play", Box::new(|_| remote(Remote::Play)));
        add("pause", Box::new(|_| remote(Remote::Pause)));
        add("toggle", Box::new(|_| remote(Remote::Toggle)));
        add("forward", Box::new(|_| remote(Remote::Skip(10.0))));
        add("back", Box::new(|_| remote(Remote::Skip(-10.0))));
        add(
            "position",
            Box::new(|event: *mut AnyObject| {
                // SAFETY: MPChangePlaybackPositionCommandEvent's positionTime.
                if let Some(e) = event.as_ref() {
                    let t: f64 = msg_send![e, positionTime];
                    remote(Remote::Position(t));
                }
            }),
        );
        TARGETS.with(|t| *t.borrow_mut() = tokens);
    });
}

fn info_center() -> Option<Obj> {
    let cls = class(c"MPNowPlayingInfoCenter").ok()?;
    // SAFETY: the shared center.
    unsafe { msg_send![cls, defaultCenter] }
}

impl Inner {
    /// This player started: Now Playing shows it, the media keys drive it.
    pub(super) fn claim_now_playing(&mut self) {
        register_commands();
        OWNER.with(|o| o.set(Some(self.id)));
        self.update_now_playing();
    }

    pub(super) fn set_now_playing(&mut self, info: Option<Info>) {
        if info == self.now {
            return;
        }
        let artwork = info.as_ref().and_then(|i| i.artwork.clone());
        let changed_art = artwork != self.now.as_ref().and_then(|i| i.artwork.clone());
        self.now = info;
        if changed_art {
            self.artwork = None;
            if let Some(url) = artwork.filter(|u| u.starts_with("https://") || u.starts_with("http://")) {
                self.load_artwork(url);
            }
        }
        self.update_now_playing();
    }

    fn load_artwork(&mut self, url: String) {
        let (id, gen_) = (self.id, self.gen_);
        background(move || {
            let (Ok(url_cls), Ok(image_cls)) = (class(c"NSURL"), class(c"NSImage")) else { return };
            let s = objc2_foundation::NSString::from_str(&url);
            // SAFETY: NSURL / NSImage constructors (NSImage loads the URL
            // here, off the main thread).
            let image: Option<Obj> = guarded("artwork", || unsafe {
                let u: Option<Obj> = msg_send![url_cls, URLWithString: &*s];
                let u = u?;
                let a: objc2::rc::Allocated<AnyObject> = msg_send![image_cls, alloc];
                let img: Option<Obj> = msg_send![a, initWithContentsOfURL: &*u];
                img
            })
            .ok()
            .flatten();
            let Some(image) = image else { return };
            let image = SendBox(image);
            dispatch2::DispatchQueue::main().exec_async(move || {
                super::with_player(id, gen_, move |i| {
                    let image = image;
                    i.set_artwork(image.0);
                });
            });
        });
    }

    fn set_artwork(&mut self, image: Obj) {
        let Ok(cls) = class(c"MPMediaItemArtwork") else { return };
        // SAFETY: NSImage's size; MPMediaItemArtwork's block initializer
        // (the block keeps the image alive and hands it out at +0).
        let art: Option<Obj> = guarded("artwork", || unsafe {
            let size: CGSize = msg_send![&*image, size];
            let keep: Retained<AnyObject> = image.clone();
            let handler = RcBlock::new(move |_size: CGSize| -> *mut AnyObject { Retained::as_ptr(&keep).cast_mut() });
            let a: objc2::rc::Allocated<AnyObject> = msg_send![cls, alloc];
            let art: Option<Obj> = msg_send![a, initWithBoundsSize: size, requestHandler: &*handler];
            art
        })
        .ok()
        .flatten();
        self.artwork = art;
        self.update_now_playing();
    }

    /// Writes this player's state to Now Playing, when it is the owner.
    pub(super) fn update_now_playing(&self) {
        if OWNER.with(Cell::get) != Some(self.id) {
            return;
        }
        let (Some(center), Ok(dict_cls), Ok(number_cls)) = (info_center(), class(c"NSMutableDictionary"), class(c"NSNumber")) else {
            return;
        };
        let title = self.now.as_ref().map_or("rustflix", |n| n.title.as_str());
        let subtitle = self.now.as_ref().and_then(|n| n.subtitle.clone());
        let elapsed = self.output_time().or(self.last_time).unwrap_or(0.0);
        let rate = if self.playing { self.rate as f64 } else { 0.0 };
        // SAFETY: NSMutableDictionary / NSNumber / NSString with
        // MediaPlayer's key constants; MPNowPlayingInfoCenter's setters.
        let _ = guarded("now playing", || unsafe {
            let d: Option<Obj> = msg_send![dict_cls, dictionary];
            let Some(d) = d else { return };
            let put = |key: *const AnyObject, value: &AnyObject| {
                if let Some(k) = constant(key) {
                    let _: () = msg_send![&*d, setObject: value, forKey: k];
                }
            };
            let num = |v: f64| -> Option<Obj> { msg_send![number_cls, numberWithDouble: v] };
            put(MPMediaItemPropertyTitle, &objc2_foundation::NSString::from_str(title));
            if let Some(s) = &subtitle {
                put(MPMediaItemPropertyArtist, &objc2_foundation::NSString::from_str(s));
            }
            if let Some(n) = self.duration.and_then(num) {
                put(MPMediaItemPropertyPlaybackDuration, &n);
            }
            if let Some(n) = num(elapsed) {
                put(MPNowPlayingInfoPropertyElapsedPlaybackTime, &n);
            }
            if let Some(n) = num(rate) {
                put(MPNowPlayingInfoPropertyPlaybackRate, &n);
            }
            // MPNowPlayingInfoMediaTypeVideo.
            if let Some(n) = num(2.0) {
                put(MPNowPlayingInfoPropertyMediaType, &n);
            }
            if let Some(a) = &self.artwork {
                put(MPMediaItemPropertyArtwork, a);
            }
            let _: () = msg_send![&*center, setNowPlayingInfo: &*d];
            // MPNowPlayingPlaybackState: playing 1, paused 2 (macOS routes the
            // media keys by it).
            let state: usize = if self.playing || !self.paused { 1 } else { 2 };
            let _: () = msg_send![&*center, setPlaybackState: state];
        });
    }

    /// This player goes: Now Playing empties when it was the owner.
    pub(super) fn release_now_playing(&mut self) {
        if OWNER.with(Cell::get) != Some(self.id) {
            return;
        }
        OWNER.with(|o| o.set(None));
        if let Some(center) = info_center() {
            // SAFETY: clearing MPNowPlayingInfoCenter (stopped = 4).
            let _ = guarded("now playing", || unsafe {
                let _: () = msg_send![&*center, setNowPlayingInfo: std::ptr::null::<AnyObject>()];
                let _: () = msg_send![&*center, setPlaybackState: 4usize];
            });
        }
    }

    fn remote(&mut self, action: Remote) {
        let pause = match action {
            Remote::Play => Some(false),
            Remote::Pause => Some(true),
            Remote::Toggle => Some(!self.paused),
            Remote::Skip(d) => {
                let t = self.output_time().unwrap_or(0.0) + d;
                self.seek(t.max(0.0));
                None
            }
            Remote::Position(t) => {
                self.seek(t);
                None
            }
        };
        if let Some(p) = pause {
            self.set_paused(p);
            let rate = if p { 0.0 } else { self.rate };
            (self.emit)("rate", json!({ "rate": rate, "paused": p, "by": "remote" }));
        }
        self.update_now_playing();
    }
}
