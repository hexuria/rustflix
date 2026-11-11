//! rustflix: a native streaming app — a GPUI window hosting the NSH (TSX)
//! interface in `app/`, built by `build.rs`.
//!
//! The shell is deliberately thin: `run_app` opens a native GPUI window
//! for the bundle and nsh's engine runs the whole interface (navigation,
//! TMDB client, library storage, the WebView/Video player). The host
//! only chooses the window and serves `nsh/base`.

use std::path::{Path, PathBuf};

use nsh_platform_gpui::{AppOptions, AppSource, AssetBase, Bundle, run_app};

/// The bundle to run: the argument (a `.nshc` or its directory), else
/// `app/` as `build.rs` built it.
fn bundle_path() -> PathBuf {
    let arg = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .next();
    let path = arg.unwrap_or_else(|| Path::new(env!("OUT_DIR")).join("app"));
    if path.is_dir() {
        path.join("bundle.nshc")
    } else {
        path
    }
}

fn main() -> std::process::ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // SAFETY: the bundle is this app's own build output (`build.rs`), or
    // one its developer names, the same trust as the app's resources.
    let path = bundle_path();
    let bundle = match unsafe { Bundle::read_trusted(&path) } {
        Ok(bundle) => bundle,
        Err(err) => {
            log::error!("cannot read {}: {err}", path.display());
            return std::process::ExitCode::FAILURE;
        }
    };
    let options = AppOptions {
        asset_base: path
            .parent()
            .map(|dir| AssetBase::Directory(dir.join("assets"))),
        app_id: "com.hexuria.rustflix".to_owned(),
        title: "rustflix".to_owned(),
        size: (1440, 900),
        ..AppOptions::default()
    };
    run_app(AppSource::Bundle(bundle), options)
}
