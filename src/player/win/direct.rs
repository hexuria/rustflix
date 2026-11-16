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
            DXGI_PRESENT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1,
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

    /// Moves it to `rect` (x, y, width, height in the parent's pixels).
    pub(crate) fn place(&mut self, rect: (i32, i32, i32, i32)) {
        if rect == self.rect {
            return;
        }
        self.rect = rect;
        // SAFETY: a window of this thread.
        let _ = unsafe { SetWindowPos(self.hwnd, Some(HWND_TOP), rect.0, rect.1, rect.2, rect.3, SWP_NOACTIVATE) };
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
            if self.chain.as_ref().is_none_or(|(of, s, _)| *of != hwnd || *s != size) {
                self.chain = None;
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
        self.chain = None;
        self.shown = false;
    }
}
