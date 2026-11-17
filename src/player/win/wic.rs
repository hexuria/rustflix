//! Frames on the CPU, for machines without a GPU.
//!
//! Where Direct3D's only adapter is the Microsoft Basic Render Driver (WARP,
//! a rasterizer on the CPU), a media engine on a Direct3D device converts and
//! scales every frame by emulating a GPU, on the same cores that draw the
//! window: ~60-90 ms a 640x360 frame on two cores. Without a DXGI device
//! manager the engine decodes in software and `TransferVideoFrame` writes into
//! a WIC bitmap with Media Foundation's own CPU converters instead, which is
//! what this module holds.
//!
//! `RUSTFLIX_MF_SOFTWARE=1` forces this path, `=0` forbids it.

use windows::Win32::{
    Foundation::RECT,
    Graphics::{
        Direct3D11::ID3D11Device,
        Dxgi::IDXGIDevice,
        Imaging::{
            CLSID_WICImagingFactory, GUID_WICPixelFormat32bppBGRA, IWICBitmap, IWICImagingFactory,
            WICBitmapCacheOnLoad, WICBitmapLockRead, WICRect,
        },
    },
    Media::MediaFoundation::{IMFMediaEngine, MF_E_UNEXPECTED, MFARGB},
    System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
};
use windows_core::Interface;

/// The Microsoft Basic Render Driver's PCI ids (WARP behind DXGI).
const BASIC_RENDER: (u32, u32) = (0x1414, 0x8c);

/// Whether frames go through the CPU: the setting, else whether `device`
/// (when there is one) is the Basic Render Driver.
pub(crate) fn wanted(device: Option<&ID3D11Device>) -> bool {
    match std::env::var("RUSTFLIX_MF_SOFTWARE").as_deref() {
        Ok("1") => return true,
        Ok("0") => return false,
        _ => {}
    }
    let Some(device) = device else { return true };
    // SAFETY: COM calls on a live device.
    unsafe {
        device
            .cast::<IDXGIDevice>()
            .and_then(|d| d.GetAdapter())
            .and_then(|a| a.GetDesc())
            .is_ok_and(|desc| (desc.VendorId, desc.DeviceId) == BASIC_RENDER)
    }
}

/// A WIC bitmap the engine's frames are transferred into.
#[derive(Default)]
pub(crate) struct CpuTarget {
    factory: Option<IWICImagingFactory>,
    bitmap: Option<((u32, u32), IWICBitmap)>,
}

impl CpuTarget {
    /// The engine's current frame scaled to `size`: BGRA rows, packed,
    /// alpha opaque. Called on the engine's thread.
    pub(crate) fn transfer(&mut self, engine: &IMFMediaEngine, (w, h): (u32, u32)) -> windows_core::Result<Vec<u8>> {
        // SAFETY: COM calls on this thread with live arguments; the locked
        // pointer is read within stride x h bytes before the lock drops.
        unsafe {
            if self.factory.is_none() {
                self.factory = Some(CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?);
            }
            if self.bitmap.as_ref().is_none_or(|(size, _)| *size != (w, h)) {
                let factory = self.factory.as_ref().ok_or_else(|| windows_core::Error::from(MF_E_UNEXPECTED))?;
                let bitmap = factory.CreateBitmap(w, h, &GUID_WICPixelFormat32bppBGRA, WICBitmapCacheOnLoad)?;
                self.bitmap = Some(((w, h), bitmap));
            }
            let Some((_, bitmap)) = self.bitmap.as_ref() else { return Err(MF_E_UNEXPECTED.into()) };
            let rect = RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
            let black = MFARGB { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbAlpha: 255 };
            engine.TransferVideoFrame(bitmap, None, &rect, Some(&black))?;
            let lock = bitmap.Lock(&WICRect { X: 0, Y: 0, Width: w as i32, Height: h as i32 }, WICBitmapLockRead.0 as u32)?;
            let stride = lock.GetStride()? as usize;
            let mut len = 0u32;
            let mut data = std::ptr::null_mut();
            lock.GetDataPointer(&mut len, &mut data)?;
            let row = w as usize * 4;
            if data.is_null() || (len as usize) < stride * (h as usize - 1) + row {
                return Err(MF_E_UNEXPECTED.into());
            }
            const OPAQUE: u32 = u32::from_ne_bytes([0, 0, 0, 255]);
            let mut bgra = vec![0u8; row * h as usize];
            for (y, dst) in bgra.chunks_exact_mut(row).enumerate() {
                let src = std::slice::from_raw_parts(data.add(y * stride), row);
                for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                    let px = u32::from_ne_bytes([s[0], s[1], s[2], s[3]]) | OPAQUE;
                    d.copy_from_slice(&px.to_ne_bytes());
                }
            }
            Ok(bgra)
        }
    }
}
