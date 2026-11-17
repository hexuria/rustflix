//! The picture outside GPUI's frame, for machines without a GPU.
//!
//! On the Microsoft Basic Render Driver every pixel GPUI draws is CPU time:
//! a video frame painted as a GPUI image, scaled to the window, costs
//! ~20-30 ms a frame on two cores, and the whole window is drawn again for
//! it. While nothing is drawn over the picture (the app says so: through
//! `sys.nativeVideo {uncovered}`), the frames go to a child window of the app's window
//! instead: a flip-model swap chain of the video's own size that the
//! system compositor stretches to the window (measured: ~0 % of a core in
//! the app, ~14 % in dwm, against ~50-60 % through GPUI), and GPUI draws
//! nothing while the video plays.
//!
//! The child window sits above everything GPUI draws at its place, as a web
//! view does, which is why it is only shown while nothing has to be over
//! the picture; the mouse goes through it to the app's window.
//!
//! Captions: the app's captions are drawn by the app, under this window.
//! While the picture is here, [`CaptionWindow`] shows them instead: a
//! layered child window above the picture, its text drawn with GDI into a
//! bitmap with per-pixel alpha (white, semibold, the app's soft shadow), so
//! a subtitled film stays on the fast path.
//!
//! Threads: [`Window`] is made, placed, hidden and destroyed on the main
//! thread; [`Presenter`] (the device and swap chain) lives on the player's
//! thread, which also shows the window once it has presented a frame.

use windows::Win32::{
    Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM},
    Graphics::{
        Direct3D::D3D_DRIVER_TYPE_WARP,
        Direct3D11::{
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
            ID3D11DeviceContext, ID3D11Texture2D,
        },
        Dxgi::{
            Common::{DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
            DXGI_PRESENT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG,
            DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIDevice,
            IDXGIFactory2, IDXGISwapChain1,
        },
    },
    Media::MediaFoundation::MF_E_UNEXPECTED,
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, HTTRANSPARENT, HWND_TOP, IsWindowVisible,
        RegisterClassW, SW_HIDE, SW_SHOWNA, SWP_NOACTIVATE, SetWindowPos, ShowWindow,
        ShowWindowAsync, WM_ERASEBKGND, WM_NCHITTEST, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS,
        WS_EX_NOACTIVATE,
    },
};
use windows_core::{Interface, w};

/// Whether the picture may go to a child window: only where GPUI draws on
/// the CPU. `RUSTFLIX_DIRECT_VIDEO=1` allows it everywhere, `=0` nowhere.
pub(crate) fn allowed(software: bool) -> bool {
    match std::env::var("RUSTFLIX_DIRECT_VIDEO").as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => software,
    }
}

/// Whether the first adapter is the Microsoft Basic Render Driver (GPUI
/// then draws on the CPU).
pub(crate) fn software() -> bool {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    static SOFTWARE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SOFTWARE.get_or_init(|| {
        // SAFETY: DXGI queries with locals.
        unsafe {
            CreateDXGIFactory1::<IDXGIFactory1>()
                .and_then(|factory| factory.EnumAdapters1(0))
                .and_then(|adapter| adapter.GetDesc1())
                .is_ok_and(|desc| (desc.VendorId, desc.DeviceId) == (0x1414, 0x8c))
        }
    })
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        // The mouse goes to the app's window under it.
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_ERASEBKGND => LRESULT(1),
        // SAFETY: the default procedure with the message's own arguments.
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}

/// The child window the picture shows in. Main thread only.
pub(crate) struct Window {
    hwnd: HWND,
    rect: (i32, i32, i32, i32),
}

impl Window {
    /// A hidden child of `parent`.
    pub(crate) fn new(parent: HWND) -> windows_core::Result<Window> {
        // SAFETY: plain window creation with a class of ours (registering it
        // again fails harmlessly).
        unsafe {
            let instance = GetModuleHandleW(None)?;
            let class = WNDCLASSW {
                lpfnWndProc: Some(proc),
                hInstance: instance.into(),
                lpszClassName: w!("RustflixVideo"),
                ..Default::default()
            };
            RegisterClassW(&class);
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE,
                w!("RustflixVideo"),
                w!(""),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                Some(parent),
                None,
                Some(instance.into()),
                None,
            )?;
            Ok(Window { hwnd, rect: (0, 0, 0, 0) })
        }
    }

    /// Its handle, for the player's thread.
    pub(crate) fn handle(&self) -> isize {
        self.hwnd.0 as isize
    }

    /// Moves it to `rect` (x, y, width, height in the parent's pixels),
    /// above the app's other child windows; `true` when it moved (a
    /// caption window over it is to be raised again).
    pub(crate) fn place(&mut self, rect: (i32, i32, i32, i32)) -> bool {
        if rect == self.rect {
            return false;
        }
        self.rect = rect;
        // SAFETY: a window of this thread.
        let _ = unsafe { SetWindowPos(self.hwnd, Some(HWND_TOP), rect.0, rect.1, rect.2, rect.3, SWP_NOACTIVATE) };
        true
    }

    pub(crate) fn visible(&self) -> bool {
        // SAFETY: a window of this thread.
        unsafe { IsWindowVisible(self.hwnd) }.as_bool()
    }

    pub(crate) fn hide(&self) {
        // SAFETY: a window of this thread.
        let _ = unsafe { ShowWindow(self.hwnd, SW_HIDE) };
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        // SAFETY: a window of this thread; the player's thread only meets
        // failed presents after this.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

/// Presents frames into a [`Window`]. The player's thread only.
#[derive(Default)]
pub(crate) struct Presenter {
    device: Option<(ID3D11Device, ID3D11DeviceContext)>,
    chain: Option<(isize, (u32, u32), IDXGISwapChain1)>,
    shown: bool,
    /// A chain was let go since the device last flushed.
    released: bool,
}

impl Presenter {
    /// Shows `bgra` (rows packed, `size` pixels) in the window `hwnd`, and
    /// the window itself once its first frame is in.
    pub(crate) fn present(&mut self, hwnd: isize, size: (u32, u32), bgra: &[u8]) -> windows_core::Result<()> {
        let (w, h) = size;
        if w == 0 || h == 0 || bgra.len() < (w as usize) * (h as usize) * 4 {
            return Err(MF_E_UNEXPECTED.into());
        }
        // SAFETY: Direct3D objects used on this thread only; `bgra` holds
        // w x h x 4 bytes (checked above).
        unsafe {
            if self.device.is_none() {
                let mut device = None;
                let mut context = None;
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_WARP,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )?;
                self.device = device.zip(context);
            }
            let Some((device, context)) = self.device.as_ref() else { return Err(MF_E_UNEXPECTED.into()) };
            // A new size for the same window: its buffers resized (a second
            // swap chain for a window can fail while the first one's
            // destruction is still deferred).
            if let Some((of, s, chain)) = self.chain.as_mut() {
                if *of == hwnd && *s != size {
                    match chain.ResizeBuffers(0, w, h, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SWAP_CHAIN_FLAG(0)) {
                        Ok(()) => *s = size,
                        Err(e) => {
                            log::debug!("player: swap chain not resized: {e}");
                            self.chain = None;
                        }
                    }
                }
            }
            if self.chain.as_ref().is_none_or(|(of, s, _)| *of != hwnd || *s != size) {
                if self.chain.take().is_some() || self.released {
                    // The old chain's destruction done before a new one.
                    context.ClearState();
                    context.Flush();
                }
                self.released = false;
                self.shown = false;
                let factory: IDXGIFactory2 = device.cast::<IDXGIDevice>()?.GetAdapter()?.GetParent()?;
                let desc = DXGI_SWAP_CHAIN_DESC1 {
                    Width: w,
                    Height: h,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                    BufferCount: 2,
                    // The compositor stretches the video's pixels to the window.
                    Scaling: DXGI_SCALING_STRETCH,
                    SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                    AlphaMode: DXGI_ALPHA_MODE_IGNORE,
                    ..Default::default()
                };
                let chain = factory.CreateSwapChainForHwnd(device, HWND(hwnd as *mut _), &desc, None, None)?;
                self.chain = Some((hwnd, size, chain));
            }
            let Some((_, _, chain)) = self.chain.as_ref() else { return Err(MF_E_UNEXPECTED.into()) };
            let back: ID3D11Texture2D = chain.GetBuffer(0)?;
            context.UpdateSubresource(&back, 0, None, bgra.as_ptr().cast(), w * 4, 0);
            chain.Present(0, DXGI_PRESENT(0)).ok()?;
            if !self.shown {
                self.shown = true;
                let _ = ShowWindowAsync(HWND(hwnd as *mut _), SW_SHOWNA);
            }
        }
        Ok(())
    }

    /// Forgets the window (it is hidden or gone): the next present shows it again.
    pub(crate) fn reset(&mut self) {
        self.shown = false;
    }

    pub(crate) fn release(&mut self) {
        self.released |= self.chain.take().is_some();
        self.shown = false;
    }
}

// --- Captions ---------------------------------------------------------------

/// The captions the app shows now: its lines (text, all italic), the font
/// size and the distance from the picture area's bottom, in points.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Caption {
    pub(crate) lines: Vec<(String, bool)>,
    pub(crate) font: f32,
    pub(crate) bottom: f32,
}

/// The window the captions show in while the picture is in [`Window`]: a
/// layered child above it. Main thread only.
pub(crate) struct CaptionWindow {
    hwnd: HWND,
    /// What is on screen: the caption, the area and the scale it was drawn for.
    shown: Option<(Caption, (i32, i32, i32, i32), u32)>,
    /// What could not be drawn: not tried again until something changes.
    failed: Option<(Caption, (i32, i32, i32, i32), u32)>,
}

impl CaptionWindow {
    /// A hidden layered child of `parent` (Windows 8+; fails where the
    /// system does not make layered child windows).
    pub(crate) fn new(parent: HWND) -> windows_core::Result<CaptionWindow> {
        use windows::Win32::UI::WindowsAndMessaging::{WS_EX_LAYERED, WS_EX_TRANSPARENT};
        // SAFETY: as `Window::new`.
        unsafe {
            let instance = GetModuleHandleW(None)?;
            let class = WNDCLASSW {
                lpfnWndProc: Some(proc),
                hInstance: instance.into(),
                lpszClassName: w!("RustflixCaption"),
                ..Default::default()
            };
            RegisterClassW(&class);
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
                w!("RustflixCaption"),
                w!(""),
                WS_CHILD,
                0,
                0,
                0,
                0,
                Some(parent),
                None,
                Some(instance.into()),
                None,
            )?;
            Ok(CaptionWindow { hwnd, shown: None, failed: None })
        }
    }

    /// Whether it shows a caption now.
    pub(crate) fn showing(&self) -> bool {
        self.shown.is_some()
    }

    /// Back above the picture's window (which went to the top as it moved).
    pub(crate) fn raise(&self) {
        if self.shown.is_some() {
            use windows::Win32::UI::WindowsAndMessaging::{SWP_NOMOVE, SWP_NOSIZE};
            // SAFETY: a window of this thread.
            let _ = unsafe { SetWindowPos(self.hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
        }
    }

    pub(crate) fn hide(&mut self) {
        if self.shown.take().is_some() {
            // SAFETY: a window of this thread.
            let _ = unsafe { ShowWindow(self.hwnd, SW_HIDE) };
        }
    }

    /// Shows `caption` over the picture area `area` (x, y, width, height
    /// in the parent's pixels) at `scale` pixels a point.
    pub(crate) fn show(&mut self, caption: &Caption, area: (i32, i32, i32, i32), scale: f32) {
        let key = (caption.clone(), area, scale.to_bits());
        if self.shown.as_ref() == Some(&key) || self.failed.as_ref() == Some(&key) {
            return;
        }
        match self.draw(caption, area, scale) {
            Ok(()) => {
                self.shown = Some(key);
                self.failed = None;
            }
            Err(e) => {
                log::debug!("player: caption not drawn: {e}");
                self.hide();
                self.failed = Some(key);
            }
        }
    }

    fn draw(&mut self, caption: &Caption, area: (i32, i32, i32, i32), scale: f32) -> windows_core::Result<()> {
        use windows::Win32::Foundation::{COLORREF, POINT, RECT, SIZE};
        use windows::Win32::Graphics::Gdi::{
            AC_SRC_ALPHA, AC_SRC_OVER, ANTIALIASED_QUALITY, BI_RGB, BITMAPINFO, BITMAPINFOHEADER,
            BLENDFUNCTION, CLIP_DEFAULT_PRECIS, CreateCompatibleDC, CreateDIBSection, CreateFontW,
            DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CALCRECT, DT_CENTER, DT_NOPREFIX, DT_WORDBREAK,
            DrawTextW, FW_SEMIBOLD, OUT_DEFAULT_PRECIS, SelectObject, SetBkMode, SetTextColor,
            TRANSPARENT,
        };
        use windows::Win32::UI::WindowsAndMessaging::{ULW_ALPHA, UpdateLayeredWindow};

        let (ax, ay, aw, ah) = area;
        let font_px = (caption.font * scale).round().max(8.0) as i32;
        let line_h = (caption.font * 1.22 * scale).round() as i32;
        // The shadow: 0 1px 3px, in pixels; its room around the text.
        let blur = (3.0 * scale).round().max(1.0) as i32;
        let drop = scale.round().max(1.0) as i32;
        let pad = blur + drop + 1;
        let text_w = (aw as f32 * 0.8).round() as i32;
        if text_w <= 0 || ah <= 0 || caption.lines.is_empty() {
            return Err(MF_E_UNEXPECTED.into());
        }
        // SAFETY: GDI objects made, used and freed here on this thread; the
        // bitmap's bits are read and written within width x height x 4.
        unsafe {
            let dc = CreateCompatibleDC(None);
            let font = |italic: bool| {
                CreateFontW(
                    -font_px,
                    0,
                    0,
                    0,
                    FW_SEMIBOLD.0 as i32,
                    italic as u32,
                    0,
                    0,
                    DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    ANTIALIASED_QUALITY,
                    0,
                    w!("Segoe UI"),
                )
            };
            // Freed on every way out, an early return included.
            let gdi = Gdi { dc, fonts: [font(false), font(true)], bitmap: None };
            let fonts = gdi.fonts;
            // Measure: each line wrapped to the text width.
            let mut texts: Vec<(Vec<u16>, bool, i32)> = Vec::new();
            let mut total_h = 0;
            for (text, italic) in &caption.lines {
                let mut wide: Vec<u16> = text.encode_utf16().collect();
                let old = SelectObject(dc, fonts[*italic as usize].into());
                let mut r = RECT { left: 0, top: 0, right: text_w, bottom: 0 };
                DrawTextW(dc, &mut wide, &mut r, DT_CALCRECT | DT_CENTER | DT_WORDBREAK | DT_NOPREFIX);
                SelectObject(dc, old);
                let rows = ((r.bottom - r.top) as f32 / font_px as f32 / 1.2).round().max(1.0) as i32;
                let h = rows * line_h;
                texts.push((wide, *italic, h));
                total_h += h;
            }
            let (w, h) = (text_w + 2 * pad, total_h + 2 * pad);
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
            let mut gdi = gdi;
            gdi.bitmap = Some((bitmap, SelectObject(dc, bitmap.into())));
            let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, (w * h * 4) as usize);
            pixels.fill(0);
            // White text on black: a pixel's green is the text's coverage.
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, COLORREF(0x00ff_ffff));
            let mut y = pad;
            for (wide, italic, line) in &mut texts {
                let old = SelectObject(dc, fonts[*italic as usize].into());
                let mut r = RECT { left: pad, top: y, right: pad + text_w, bottom: y + *line };
                DrawTextW(dc, wide, &mut r, DT_CENTER | DT_WORDBREAK | DT_NOPREFIX);
                SelectObject(dc, old);
                y += *line;
            }
            let (wu, hu) = (w as usize, h as usize);
            let cover: Vec<u8> = pixels.chunks_exact(4).map(|p| p[1]).collect();
            let shadow = blurred(&cover, wu, hu, blur as usize);
            for yy in 0..hu {
                for xx in 0..wu {
                    let m = cover[yy * wu + xx] as f32 / 255.0;
                    // The shadow, a pixel lower, strengthened as a text shadow is.
                    let s = if yy >= drop as usize { shadow[(yy - drop as usize) * wu + xx] } else { 0.0 };
                    let s = (s * 2.2).min(1.0) * 0.95;
                    let alpha = m + s * (1.0 - m);
                    let white = (m * 255.0).round() as u8;
                    let px = &mut pixels[(yy * wu + xx) * 4..][..4];
                    px[0] = white;
                    px[1] = white;
                    px[2] = white;
                    px[3] = (alpha * 255.0).round() as u8;
                }
            }
            // Centred in the area, its text's bottom `bottom` points up.
            let x = ax + (aw - w) / 2;
            let top = ay + ah - (caption.bottom * scale).round() as i32 - total_h - pad;
            let _ = SetWindowPos(self.hwnd, Some(HWND_TOP), x, top, w, h, SWP_NOACTIVATE);
            let size = SIZE { cx: w, cy: h };
            let origin = POINT::default();
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            let updated = UpdateLayeredWindow(self.hwnd, None, None, Some(&size), Some(dc), Some(&origin), COLORREF(0), Some(&blend), ULW_ALPHA);
            std::mem::drop(gdi);
            updated?;
            let _ = ShowWindow(self.hwnd, SW_SHOWNA);
        }
        Ok(())
    }
}

/// A caption's GDI objects: its memory DC, its two fonts and the bitmap
/// selected into the DC (with what it replaced), freed when dropped.
struct Gdi {
    dc: windows::Win32::Graphics::Gdi::HDC,
    fonts: [windows::Win32::Graphics::Gdi::HFONT; 2],
    bitmap: Option<(windows::Win32::Graphics::Gdi::HBITMAP, windows::Win32::Graphics::Gdi::HGDIOBJ)>,
}

impl Drop for Gdi {
    fn drop(&mut self) {
        use windows::Win32::Graphics::Gdi::{DeleteDC, DeleteObject, SelectObject};
        // SAFETY: objects made by `CaptionWindow::draw` on this thread and
        // used by nothing else now.
        unsafe {
            if let Some((bitmap, old)) = self.bitmap.take() {
                SelectObject(self.dc, old);
                let _ = DeleteObject(bitmap.into());
            }
            for font in self.fonts {
                let _ = DeleteObject(font.into());
            }
            let _ = DeleteDC(self.dc);
        }
    }
}

impl Drop for CaptionWindow {
    fn drop(&mut self) {
        // SAFETY: a window of this thread.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

/// `cover` (w x h, 0-255) blurred by a box of `radius` both ways, as 0-1.
fn blurred(cover: &[u8], w: usize, h: usize, radius: usize) -> Vec<f32> {
    let pass = |src: &[f32], horizontal: bool| -> Vec<f32> {
        let mut out = vec![0.0; w * h];
        let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
        let at = |o: usize, i: usize| if horizontal { o * w + i } else { i * w + o };
        let span = (2 * radius + 1) as f32;
        for o in 0..outer {
            let mut sum = 0.0;
            for i in 0..inner + radius {
                if i < inner {
                    sum += src[at(o, i)];
                }
                if i > 2 * radius {
                    sum -= src[at(o, i - 2 * radius - 1)];
                }
                if i >= radius {
                    out[at(o, i - radius)] = sum / span;
                }
            }
        }
        out
    };
    let src: Vec<f32> = cover.iter().map(|c| *c as f32 / 255.0).collect();
    pass(&pass(&src, true), false)
}
