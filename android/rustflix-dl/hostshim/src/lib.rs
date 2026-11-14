//! The few `nsh_engine` names `src/dl/mod.rs` imports, for the Android
//! library. Only its desktop `register()` uses them, which the Android
//! library never calls (it builds the downloader's `Config` itself and
//! answers calls over JNI), so these do nothing.

use std::path::PathBuf;

pub type JsonValue = serde_json::Value;

/// Stand-in for NSH's host channel (never registered with anything).
#[derive(Clone, Default)]
pub struct HostChannel;

impl HostChannel {
    pub fn handle<F: Fn(HostCall) + Send + Sync + 'static>(&self, _name: &str, _f: F) {}
    pub fn send(&self, _name: &str, _data: JsonValue) -> bool {
        false
    }
}

/// Stand-in for a call from the app.
pub struct HostCall {
    data: JsonValue,
}

impl HostCall {
    pub fn data(&self) -> &JsonValue {
        &self.data
    }
    pub fn resolve(self, _value: JsonValue) {}
}

pub fn data_dir() -> Option<PathBuf> {
    None
}

pub fn app_dir_name(id: Option<&str>) -> String {
    id.unwrap_or("default").to_owned()
}
