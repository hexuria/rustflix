// Screen brightness and media volume for the player's swipe gestures.
//
// Only the phone apps can do either: the calls go through `nsh/host` to the
// embedding app's SystemControls (ios/Rustflix/SystemControls.swift,
// android/app/src/main/java/com/hexuria/rustflix/SystemControls.java),
// gated by capabilities.host "sys.*". Everywhere else every function is a
// safe no-op, and none of them ever throws into UI code. The macOS window
// fixes below go to src/appkit.rs the same way.

import { host, platform, signal, untracked } from "nsh";

const IOS_HOST = process.platform === "ios";
const ANDROID_HOST = process.platform === "android";
let hostUp = false;
try {
  hostUp = (IOS_HOST || ANDROID_HOST) && host.available();
} catch {}

/** True only on iOS / Android with the native host bridge present. */
export function hasSystemControls(): boolean {
  return hostUp;
}

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Calls `sys.<name>` and returns its `{ value }`, or `fallback` on any failure. */
async function callValue(
  name: string,
  fallback: number,
  args?: { value: number },
): Promise<number> {
  if (!hostUp) return fallback;
  try {
    const res = (await host.call(name, args)) as { value?: unknown } | null;
    const v = res?.value;
    return typeof v === "number" ? clamp(v) : fallback;
  } catch {
    return fallback;
  }
}

/** Current screen brightness, 0…1 (1 when unavailable). */
export function getBrightness(): Promise<number> {
  return callValue("sys.getBrightness", 1);
}

/** Sets screen brightness (clamped to 0…1); resolves to the applied value. */
export function setBrightness(v: number): Promise<number> {
  const value = clamp(v);
  return callValue("sys.setBrightness", value, { value });
}

/** Puts back the brightness from before the first setBrightness since the
 * last restore. Call when the player closes. Resolves to the brightness now. */
export function restoreBrightness(): Promise<number> {
  return callValue("sys.restoreBrightness", 1);
}

// --- macOS window fixes (src/appkit.rs) ----------------------------------------
//
// AppKit work the GPUI/NSH stack does not do itself. macOS only; an op
// the host lacks (an older build) is remembered as missing and never
// asked again. Nothing here throws.

const MAC_HOST = (() => {
  try {
    return platform.os === "macos" && host.available();
  } catch {
    return false;
  }
})();
const missing = new Set<string>();

async function macCall<T>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!MAC_HOST || missing.has(name)) return null;
  try {
    return ((await host.call(name, args)) as T) ?? null;
  } catch {
    missing.add(name);
    return null;
  }
}

/** Whether `sys.pickFolder` can be asked (macOS with the op not known missing). */
export function canPickFolder(): boolean {
  return MAC_HOST && !missing.has("sys.pickFolder");
}

/** Gives the keyboard back to the app's own view (GPUI's) inside its
 * window: after a web view held first responder, plain keys otherwise
 * reach no text field. Never brings the window forward. */
export function focusContent(): void {
  void macCall("sys.focusContent");
}

/** Every web view in the window draws no background of its own (it is
 * transparent until its page paints). Safe to call repeatedly and with no
 * web view. Resolves to how many web views it changed; `null` where the
 * host cannot (not macOS, an older host). */
export async function webBackground(): Promise<number | null> {
  const res = await macCall<{ ok?: boolean; count?: unknown }>("sys.webBackground", {
    color: "black",
  });
  return res?.ok && typeof res.count === "number" ? res.count : null;
}

/** The native folder picker (macOS). The chosen path, `null` when
 * cancelled; `undefined` when there is no picker (use a text field). */
export async function pickFolder(start?: string): Promise<string | null | undefined> {
  const res = await macCall<{ ok?: boolean; path?: unknown; cancelled?: boolean }>(
    "sys.pickFolder",
    start ? { start } : {},
  );
  if (!res) return undefined;
  if (res.ok && typeof res.path === "string" && res.path) return res.path;
  return res.cancelled ? null : undefined;
}

/** Current media volume, 0…1 (1 when unavailable). */
export function getVolume(): Promise<number> {
  return callValue("sys.getVolume", 1);
}

/** Sets media volume (clamped to 0…1); resolves to the applied value. */
export function setVolume(v: number): Promise<number> {
  const value = clamp(v);
  return callValue("sys.setVolume", value, { value });
}

/** Android: whether the player is in full screen — landscape, immersive —
 * rather than inline (any orientation, system bars shown). The player
 * opens inline, as on iPhone; the Full screen button switches (as AVKit's
 * full screen does there) and the back gesture leaves full screen first
 * (Android 13+; SystemControls.java reports it back as `sys.fullscreen`).
 * Reactive. Always false elsewhere. */
export const playerFullscreen = signal(false);

if (ANDROID_HOST && hostUp) {
  try {
    host.on("sys.fullscreen", (d: unknown) => {
      playerFullscreen.set(!!(d as { on?: unknown } | null)?.on);
    });
  } catch {}
}

/** Android: enters or leaves the player's full screen (see playerFullscreen). */
export function togglePlayerFullscreen(): void {
  if (!ANDROID_HOST || !hostUp) return;
  playerFullscreen.set(!untracked(playerFullscreen));
}

/** Android: whether the system's navigation buttons stay hidden in the app
 * (`sys.navBar`; SystemControls.java keeps the choice, so the next launch
 * starts with it). A no-op elsewhere. */
export function setNavButtonsHidden(hidden: boolean): void {
  if (!ANDROID_HOST || !hostUp) return;
  void host.call("sys.navBar", { hidden }).catch(() => {});
}

/** Android: the player's window while it shows — screen kept on, inline or
 * full screen (`playerFullscreen`, read here so an effect calling this
 * follows it) — and back to normal when it closes (`sys.playerWindow`).
 * `pageTouches`: whether the player's web page gets touches (NSH's Android
 * views let touches through to a web view under them; the page's own
 * controls must only react when the app's overlay is not the transport).
 * A no-op elsewhere: iOS rotates through the dialog's orientation mask,
 * AVKit keeps the screen on, and the native overlay takes the touches. */
export function setPlayerWindow(on: boolean, pageTouches = false): void {
  if (!ANDROID_HOST || !hostUp) return;
  const fullscreen = on && playerFullscreen();
  // Every player opens inline.
  if (!on && untracked(playerFullscreen)) queueMicrotask(() => playerFullscreen.set(false));
  void host.call("sys.playerWindow", { on, pageTouches, fullscreen }).catch(() => {});
}
