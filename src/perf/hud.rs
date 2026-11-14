//! The monitor's panel on macOS: Core Animation layers over GPUI's view.
//!
//! The panel is a `CALayer` added on top of the `GPUIView`'s layer (a
//! `CATextLayer` for the rows, 120 thin `CALayer` bars), positioned at the
//! window's top right. Updating it sets layer properties inside a
//! `CATransaction` with actions disabled: Core Animation composites it on
//! its own, so the panel never makes GPUI draw, never invalidates the app's
//! view, and adds no node to the accessibility tree (layers are not
//! accessibility elements). Layers take no mouse events.

#[cfg(target_os = "macos")]
mod mac {
    use objc2::encode::{Encode, Encoding, RefEncode};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{MainThreadMarker, class, msg_send};
    use objc2_foundation::NSString;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Size {
        w: f64,
        h: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    // SAFETY: the layouts and encodings of CGPoint, CGSize, CGRect (64-bit).
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }

    #[repr(C)]
    struct CGColor {
        _private: [u8; 0],
    }
    // SAFETY: `^{CGColor=}`, the encoding of `CGColorRef`.
    unsafe impl RefEncode for CGColor {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGColor", &[]));
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGColorCreateSRGB(r: f64, g: f64, b: f64, a: f64) -> *mut CGColor;
    }

    type Obj = Retained<AnyObject>;

    const BARS: usize = 120;
    const W: f64 = 260.0;
    const TEXT_H: f64 = 74.0;
    const GRAPH_H: f64 = 30.0;
    const PAD: f64 = 6.0;
    const H: f64 = PAD + TEXT_H + 4.0 + GRAPH_H + PAD;
    /// From the window's top (under the app's 40 pt title bar) and right.
    const TOP: f64 = 48.0;
    const RIGHT: f64 = 10.0;

    /// The panel's layers (main thread only).
    pub(crate) struct Hud {
        root: Obj,
        text: Obj,
        bars: Vec<Obj>,
        line: Obj,
        colors: [*mut CGColor; 4],
    }

    fn color(r: f64, g: f64, b: f64, a: f64) -> *mut CGColor {
        // SAFETY: a plain CoreGraphics constructor; kept for the process.
        unsafe { CGColorCreateSRGB(r, g, b, a) }
    }

    fn new_layer(class: &AnyClass) -> Option<Obj> {
        // SAFETY: `[CALayer layer]` / `[CATextLayer layer]`.
        unsafe { msg_send![class, layer] }
    }

    fn is_kind(obj: &AnyObject, cls: &AnyClass) -> bool {
        // SAFETY: NSObject's isKindOfClass: on a live object.
        let r: Bool = unsafe { msg_send![obj, isKindOfClass: cls] };
        r.as_bool()
    }

    fn array(list: Option<&AnyObject>) -> Vec<Obj> {
        let Some(list) = list else { return Vec::new() };
        // SAFETY: NSArray's count / objectAtIndex: within its bounds.
        unsafe {
            let n: usize = msg_send![list, count];
            (0..n)
                .filter_map(|i| {
                    let o: Option<Obj> = msg_send![list, objectAtIndex: i];
                    o
                })
                .collect()
        }
    }

    /// The layer of the app window's GPUIView (else its content view).
    fn host_layer() -> Option<(Obj, f64)> {
        let gpui = AnyClass::get(c"GPUIView");
        // SAFETY: NSApplication / NSWindow / NSView messages on the main thread.
        unsafe {
            let app: Option<Obj> = msg_send![class!(NSApplication), sharedApplication];
            let windows: Option<Obj> = msg_send![&*app?, windows];
            for window in array(windows.as_deref()) {
                let content: Option<Obj> = msg_send![&*window, contentView];
                let Some(content) = content else { continue };
                let mut view = content.clone();
                if let Some(gpui) = gpui {
                    let subs: Option<Obj> = msg_send![&*content, subviews];
                    if let Some(v) = array(subs.as_deref()).into_iter().find(|v| is_kind(v, gpui)) {
                        view = v;
                    } else if !is_kind(&content, gpui) {
                        continue;
                    }
                }
                let layer: Option<Obj> = msg_send![&*view, layer];
                let scale: f64 = msg_send![&*window, backingScaleFactor];
                if let Some(layer) = layer {
                    return Some((layer, scale));
                }
            }
            None
        }
    }

    fn transaction(f: impl FnOnce()) {
        // SAFETY: CATransaction's class methods on the main thread.
        unsafe {
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: Bool::YES];
            f();
            let _: () = msg_send![class!(CATransaction), commit];
        }
    }

    impl Hud {
        /// Adds the panel over the app's window; `None` when there is none.
        pub(crate) fn show() -> Option<Hud> {
            MainThreadMarker::new()?;
            let (host, scale) = host_layer()?;
            let calayer = AnyClass::get(c"CALayer")?;
            let textlayer = AnyClass::get(c"CATextLayer")?;
            let colors = [
                color(0.133, 0.773, 0.369, 1.0),
                color(0.961, 0.620, 0.043, 1.0),
                color(0.937, 0.267, 0.267, 1.0),
                color(0.6, 0.6, 0.6, 0.8),
            ];
            let root = new_layer(calayer)?;
            let text = new_layer(textlayer)?;
            let line = new_layer(calayer)?;
            let mut bars = Vec::with_capacity(BARS);
            for _ in 0..BARS {
                bars.push(new_layer(calayer)?);
            }
            let hud = Hud { root, text, bars, line, colors };
            transaction(|| {
                // SAFETY: CALayer / CATextLayer setters on new layers, main thread.
                unsafe {
                    let r = &*hud.root;
                    let _: () = msg_send![r, setBackgroundColor: color(0.0, 0.0, 0.0, 0.78)];
                    let _: () = msg_send![r, setCornerRadius: 6.0f64];
                    let _: () = msg_send![r, setZPosition: 10_000.0f64];
                    let _: () = msg_send![r, setMasksToBounds: Bool::YES];
                    let t = &*hud.text;
                    let font = NSString::from_str("Menlo-Regular");
                    let key = NSString::from_str("font");
                    let _: () = msg_send![t, setValue: &*font, forKey: &*key];
                    let _: () = msg_send![t, setFontSize: 10.0f64];
                    let _: () = msg_send![t, setForegroundColor: color(0.85, 1.0, 0.85, 1.0)];
                    let _: () = msg_send![t, setContentsScale: scale];
                    let _: () = msg_send![t, setFrame: Rect {
                        origin: Point { x: PAD, y: PAD + GRAPH_H + 4.0 },
                        size: Size { w: W - 2.0 * PAD, h: TEXT_H },
                    }];
                    let _: () = msg_send![r, addSublayer: t];
                    for b in &hud.bars {
                        let _: () = msg_send![r, addSublayer: &**b];
                    }
                    let l = &*hud.line;
                    let _: () = msg_send![l, setBackgroundColor: color(1.0, 1.0, 1.0, 0.5)];
                    let _: () = msg_send![r, addSublayer: l];
                    let _: () = msg_send![&*host, addSublayer: r];
                }
            });
            hud.place();
            Some(hud)
        }

        /// Keeps the panel at the window's top right (it follows resizes at
        /// each update).
        fn place(&self) {
            // SAFETY: CALayer geometry on the main thread.
            unsafe {
                let sup: Option<Obj> = msg_send![&*self.root, superlayer];
                let Some(sup) = sup else { return };
                let b: Rect = msg_send![&*sup, bounds];
                let flipped: Bool = msg_send![&*sup, isGeometryFlipped];
                // Our rows are laid out bottom up: undo a flipped host.
                let _: () = msg_send![&*self.root, setGeometryFlipped: flipped];
                let x = b.size.w - W - RIGHT;
                let y = if flipped.as_bool() { TOP } else { b.size.h - TOP - H };
                let _: () = msg_send![&*self.root, setFrame: Rect {
                    origin: Point { x, y },
                    size: Size { w: W, h: H },
                }];
            }
        }

        /// New rows and bars (`bars`: the last frames, oldest first: height
        /// in ms and kind — 0 on time, 1 cost over half a refresh, 2 late on
        /// glass, 3 a long drawable wait; `budget`: one refresh in ms).
        pub(crate) fn update(&self, rows: &str, bars: &[(f32, u8)], budget: f32) {
            transaction(|| {
                self.place();
                // SAFETY: CALayer / CATextLayer setters on our layers, main thread.
                unsafe {
                    let s = NSString::from_str(rows);
                    let _: () = msg_send![&*self.text, setString: &*s];
                    let scale = GRAPH_H / (budget as f64 * 2.0);
                    let start = BARS.saturating_sub(bars.len());
                    for (i, bar) in self.bars.iter().enumerate() {
                        let (h, c) = match i.checked_sub(start).and_then(|k| bars.get(k)) {
                            Some(&(ms, kind)) => {
                                let c = self.colors[(kind as usize).min(3)];
                                // A late frame shows at least a refresh tall.
                                let ms = if kind == 2 { ms.max(budget * 1.05) } else { ms };
                                ((ms as f64 * scale).clamp(1.0, GRAPH_H), c)
                            }
                            None => (0.0, self.colors[0]),
                        };
                        let _: () = msg_send![&**bar, setBackgroundColor: c];
                        let _: () = msg_send![&**bar, setFrame: Rect {
                            origin: Point { x: PAD + i as f64 * 2.0, y: PAD },
                            size: Size { w: 1.5, h },
                        }];
                    }
                    let _: () = msg_send![&*self.line, setFrame: Rect {
                        origin: Point { x: PAD, y: PAD + budget as f64 * scale },
                        size: Size { w: BARS as f64 * 2.0, h: 0.5 },
                    }];
                }
            });
        }
    }

    impl Drop for Hud {
        fn drop(&mut self) {
            transaction(|| {
                // SAFETY: removes our layer from its superlayer, main thread.
                unsafe {
                    let _: () = msg_send![&*self.root, removeFromSuperlayer];
                }
            });
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use mac::Hud;

/// Elsewhere: no panel (the recorder still works).
#[cfg(not(target_os = "macos"))]
pub(crate) struct Hud;

#[cfg(not(target_os = "macos"))]
impl Hud {
    pub(crate) fn show() -> Option<Hud> {
        None
    }
    pub(crate) fn update(&self, _rows: &str, _bars: &[(f32, u8)], _budget: f32) {}
}
