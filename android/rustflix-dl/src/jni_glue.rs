//! JNI surface of `com.hexuria.rustflix.DlNative`:
//!
//! - `nativeInit(String dataDir, String downloadsDir)` — once per process;
//!   records left running resume at once.
//! - `nativeCall(String name, String json) -> String` — one `dl.*` call,
//!   blocking (Java calls it on a worker thread).
//! - `nativeSetMetered(boolean)` — the network is metered (Wi-Fi only).
//! - events: the static `DlNative.onEvent(String json)` (downloads) and
//!   `DlNative.onStreamEvent(String json)` (`dl.stream.event`), from the
//!   library's threads (attached to the VM as daemons).

use std::sync::{Arc, OnceLock};

use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JString, JValue},
    sys::{jboolean, jstring},
};
use serde_json::Value;

use crate::bridge::Bridge;

static BRIDGE: OnceLock<Bridge> = OnceLock::new();
static VM: OnceLock<JavaVM> = OnceLock::new();
static CLASS: OnceLock<GlobalRef> = OnceLock::new();

fn string(env: &mut JNIEnv<'_>, s: &JString<'_>) -> String {
    env.get_string(s).map(|s| s.into()).unwrap_or_default()
}

fn event(v: Value) {
    callback("onEvent", v);
}

fn stream_event(v: Value) {
    callback("onStreamEvent", v);
}

/// The static `DlNative.<method>(String json)`, from any thread.
fn callback(method: &str, v: Value) {
    let (Some(vm), Some(class)) = (VM.get(), CLASS.get()) else { return };
    let Ok(mut env) = vm.attach_current_thread_as_daemon() else { return };
    let Ok(text) = env.new_string(v.to_string()) else { return };
    let cls: &JClass<'_> = class.as_obj().into();
    if env
        .call_static_method(cls, method, "(Ljava/lang/String;)V", &[JValue::Object(&text)])
        .is_err()
    {
        let _ = env.exception_clear();
    }
    let _ = env.delete_local_ref(text);
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_hexuria_rustflix_DlNative_nativeInit(
    mut env: JNIEnv<'_>,
    class: JClass<'_>,
    data_dir: JString<'_>,
    downloads_dir: JString<'_>,
) {
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("rustflix-dl"));
    if BRIDGE.get().is_some() {
        return;
    }
    if let Ok(vm) = env.get_java_vm() {
        let _ = VM.set(vm);
    }
    if let Ok(g) = env.new_global_ref(&class) {
        let _ = CLASS.set(g);
    }
    let data = string(&mut env, &data_dir);
    let downloads = string(&mut env, &downloads_dir);
    crate::streams::set_sink(Arc::new(stream_event));
    let _ = BRIDGE.set(Bridge::new(data.as_ref(), downloads.as_ref(), Arc::new(event)));
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_hexuria_rustflix_DlNative_nativeCall(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    name: JString<'_>,
    json: JString<'_>,
) -> jstring {
    let name = string(&mut env, &name);
    let data = string(&mut env, &json);
    let out = match BRIDGE.get() {
        Some(b) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| b.call(&name, &data)))
            .unwrap_or_else(|_| r#"{"ok":false,"error":"internal error"}"#.to_owned()),
        None => r#"{"ok":false,"error":"the downloader is not running"}"#.to_owned(),
    };
    env.new_string(out).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_hexuria_rustflix_DlNative_nativeSetMetered(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    metered: jboolean,
) {
    if let Some(b) = BRIDGE.get() {
        b.set_metered(metered != 0);
    }
}
