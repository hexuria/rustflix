//! Bundles and compiles `app/` as `nsh build` does, into `$OUT_DIR/app`
//! (`bundle.js`, its source map, `bundle.nshc`, `app.json`,
//! `capabilities.json` when the app declares any, `assets/`), which
//! `main.rs` runs: `cargo run` alone builds the app.
//!
//! The bundler compiles the app against nsh's own modules and UI set
//! (`nsh/base`); the app reaches everything else through `fetch`,
//! `Storage`, `WebView` and `Video`, all gated by the capabilities the
//! app declares in `app/nsh.json`.

use std::{
    fs,
    path::{Path, PathBuf},
};

use nsh_bundler::BundleOptions;

fn main() {
    let dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("app");
    // The app's sources, its `nsh.json` and anything it imports from there.
    println!("cargo:rerun-if-changed={}", dir.display());
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let out = out_dir.join("app");
    // A Windows host cannot read the manifest as it is (see `windows_app`).
    let dir = if HOST_WINDOWS {
        match windows_app(&dir, &out_dir.join("app-src")) {
            Ok(copy) => copy,
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(1);
            }
        }
    } else {
        dir
    };
    // `nsh build --release` in a release build: minified, bytecode stripped.
    let release = std::env::var("PROFILE").is_ok_and(|p| p == "release");
    if let Err(message) = build(&dir.join("App.tsx"), &out, release) {
        // Cargo shows a failed build script's output: the code frame.
        eprintln!("{message}");
        std::process::exit(1);
    }
}

const HOST_WINDOWS: bool = cfg!(windows);

/// `app/nsh.json` grants `process.execute` to `/bin/sh` and
/// `/usr/bin/python3`, which NSH rejects on Windows (a path with no drive is
/// not absolute there: "capabilities.process.execute needs exact executable
/// names or absolute paths"). The Windows build bundles a copy of `app/`
/// without those two entries; the sources and every other grant are as they
/// are, and `app/` itself is untouched.
fn windows_app(dir: &Path, copy: &Path) -> Result<PathBuf, String> {
    fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
        fs::create_dir_all(to).map_err(|e| format!("create {}: {e}", to.display()))?;
        for entry in fs::read_dir(from).map_err(|e| format!("read {}: {e}", from.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let (src, dst) = (entry.path(), to.join(entry.file_name()));
            if src.is_dir() {
                copy_tree(&src, &dst)?;
            } else {
                fs::copy(&src, &dst).map_err(|e| format!("copy {}: {e}", src.display()))?;
            }
        }
        Ok(())
    }
    let _ = fs::remove_dir_all(copy);
    copy_tree(dir, copy)?;
    let path = copy.join("nsh.json");
    let text = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut config: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    if let Some(execute) = config["capabilities"]["process"]["execute"].as_array_mut() {
        execute.retain(|s| !s.as_str().is_some_and(|s| s.starts_with('/')));
    }
    fs::write(&path, config.to_string()).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(copy.to_path_buf())
}

fn build(entry: &Path, out: &Path, release: bool) -> Result<(), String> {
    // `nsh/base` as the toolchain takes it: data (`SetDescription`).
    let ui_sets = vec![nsh_core::element::description::SetDescription::from(
        nsh_base::registry(),
    )];
    let bundle = nsh_bundler::bundle(&BundleOptions {
        entry: entry.to_path_buf(),
        minify: release,
        development: !release,
        split: false,
        ui_sets: ui_sets.clone(),
        ..Default::default()
    })
    .map_err(|e| e.plain)?;
    let code = inject_keys(&bundle.code)?;
    let bytecode =
        nsh_js::compile_bytecode_with(&code, release, &ui_sets).map_err(|e| e.message)?;
    let _ = fs::remove_dir_all(out);
    let write = |name: &str, bytes: &[u8]| {
        let path = out.join(name);
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
    };
    write("bundle.js", code.as_bytes())?;
    write(
        "bundle.js.map",
        bundle.source_map.as_deref().unwrap_or_default().as_bytes(),
    )?;
    write("bundle.nshc", &bytecode)?;
    // The app's id, which names where it keeps its data (`Bundle::read`).
    let config = fs::read_to_string(entry.with_file_name("nsh.json"))
        .ok()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
    let id = config
        .as_ref()
        .and_then(|c| c["id"].as_str())
        .ok_or("app/nsh.json needs an `id`")?;
    write(
        "app.json",
        serde_json::json!({ "id": id }).to_string().as_bytes(),
    )?;
    if let Some(capabilities) = &bundle.capabilities {
        write(
            "capabilities.json",
            capabilities.to_json().to_string().as_bytes(),
        )?;
    }
    // Assets keep their paths relative to the entry directory:
    // `asset:/img/a.png` -> `assets/img/a.png`; the UI sets' under
    // `@<package>/` (`path` is already relative).
    let entry_dir = entry.parent().unwrap_or(entry);
    let imported = bundle.assets.iter().filter_map(|abs| {
        let rel = abs.strip_prefix(entry_dir).unwrap_or(abs);
        let path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        Some((path, abs.clone()))
    });
    let shipped = ui_sets
        .iter()
        .flat_map(|set| &set.assets)
        .map(|file| (file.path.clone(), PathBuf::from(&file.source)));
    for (path, source) in imported.chain(shipped) {
        let bytes = fs::read(&source).map_err(|e| format!("read {}: {e}", source.display()))?;
        write(&format!("assets/{path}"), &bytes)?;
    }
    Ok(())
}

/// Subtitle service keys are baked into the built bundle, never kept in
/// the repository: `app/lib/subtitles.ts` holds two tokens, replaced here
/// with the values of `WYZIE_API_KEY` / `SUBDL_API_KEY` (the packaging
/// scripts read them from the Keychain). The value is XOR-scrambled and
/// hex-encoded so it is not plain text in `bundle.js`; that is tidiness,
/// not protection. Without the variables the tokens become empty and the
/// app ships no keys.
fn inject_keys(code: &str) -> Result<String, String> {
    const PAD: &[u8] = b"rustflix-subtitle-keys";
    let mut out = code.to_string();
    for (token, var) in [
        ("@@RUSTFLIX_WYZIE_KEY@@", "WYZIE_API_KEY"),
        ("@@RUSTFLIX_SUBDL_KEY@@", "SUBDL_API_KEY"),
    ] {
        println!("cargo:rerun-if-env-changed={var}");
        let key = std::env::var(var).unwrap_or_default();
        let key = key.trim();
        if !key.is_empty() && !out.contains(token) {
            return Err(format!(
                "{var} is set but its slot `{token}` is not in the bundle \
                 (did the minifier fold it away?)"
            ));
        }
        let packed: String = key
            .bytes()
            .enumerate()
            .map(|(i, b)| format!("{:02x}", b ^ PAD[i % PAD.len()]))
            .collect();
        out = out.replace(token, &packed);
    }
    Ok(out)
}
