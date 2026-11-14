// Whether a play uses the app's own player (lib/playback/nativeBackend.ts)
// or the source's embed page (lib/playback/webBackend.ts).
//
// - Storage `rustflix.nativeplayer`: "auto" (default) — the app's player
//   wherever the platform's `rustflix.video` component reports itself
//   available (`sys.nativeVideoInfo`, contract "requests"); "1" — always
//   (every source tries it first; a missing component then fails over to
//   the page like any failure); "0" — never.
// - Per source: `Source.playback` (lib/sources.ts) is the seed. A source
//   whose stream resolved on this device becomes "native"; one whose
//   native play failed FAIL_LIMIT times in a row goes back to "web" until
//   the app (the bundle's version key) changes. Stored in
//   `rustflix.playcaps.v1`.
//
// No imports from the player (lib/player.ts imports this module).

import { host, signal, Storage, untracked } from "nsh";
import { PLAYER_SOURCES } from "../sources";

export const NATIVE_PLAYER_KEY = "rustflix.nativeplayer";
const CAPS_KEY = "rustflix.playcaps.v1";
/** Failed native plays in a row before a source falls back to its page. */
export const FAIL_LIMIT = 3;
/** How long the availability check may take before it counts as "no". */
const CHECK_MS = 1500;

export type NativeMode = "auto" | "1" | "0";

/** The stored mode ("auto" until read). */
export const nativeMode = signal<NativeMode>("auto");
/** The mode has been read from Storage. */
const modeRead = signal(false);
/** What the platform's component said: true / false; null while asking. */
export const nativeAvailable = signal<boolean | null>(null);
/** Extra facts the component reported (`sys.nativeVideoInfo`). */
export const nativeInfo = signal<{
  pip?: boolean;
  fullscreen?: boolean;
  local?: boolean;
  embeddedSubtitles?: boolean;
  /** The component sends the embedded track's text as `cues` for the app to draw (macOS). */
  subtitleCues?: boolean;
}>({});

/** Whether plays may use the app's player now: true / false, or null
 * while the mode or the platform's answer is not in yet (a play waits —
 * nothing loads — rather than flash a page it would then replace). */
export function nativeEnabled(): boolean | null {
  if (!modeRead()) return null;
  const m = nativeMode();
  if (m === "0") return false;
  if (m === "1") return true;
  return nativeAvailable();
}

/** Settings → Diagnostics: "auto" | "1" | "0". */
export function setNativeMode(m: NativeMode): void {
  nativeMode.set(m);
  modeRead.set(true);
  void Storage.setItem(NATIVE_PLAYER_KEY, m).catch(() => {});
}

/** One-run override (autotest `backend`), not stored. */
export function overrideNativeMode(m: NativeMode): void {
  nativeMode.set(m);
  modeRead.set(true);
}

// --- Per-source capability ---------------------------------------------------------

type Caps = { ver: string; native: string[]; fails: Record<string, number> };
let caps: Caps = { ver: "", native: [], fails: {} };
/** Bumped on every change (reactive readers of sourcePlayback). */
const capsRev = signal(0);
let versionKey = "";

function saveCaps() {
  capsRev.set(untracked(capsRev) + 1);
  void Storage.setItem(CAPS_KEY, JSON.stringify(caps)).catch(() => {});
}

/** "native" | "web" for source `id` on this device (reactive). */
export function sourcePlayback(id: string): "native" | "web" {
  capsRev();
  if (PLAYER_SOURCES.find((s) => s.id === id)?.noNative) return "web";
  if ((caps.fails[id] ?? 0) >= FAIL_LIMIT) return "web";
  if (caps.native.includes(id)) return "native";
  return PLAYER_SOURCES.find((s) => s.id === id)?.playback ?? "web";
}

/** A native play (resolve + start) of `id` worked (true) or failed. A page
 * that exposed its stream link also counts as success: it resolves. */
export function noteNativeResult(id: string, ok: boolean): void {
  if (!id) return;
  if (ok) {
    const had = caps.native.includes(id) && !caps.fails[id];
    if (had) return;
    caps.native = [id, ...caps.native.filter((x) => x !== id)].slice(0, 20);
    delete caps.fails[id];
  } else {
    caps.fails[id] = (caps.fails[id] ?? 0) + 1;
  }
  saveCaps();
}

/** The platform refused the source outright (its CDN 403s our proxy):
 * its page from now on, on this device, until the app changes. */
export function markNotNative(id: string): void {
  if (!id) return;
  caps.fails[id] = Math.max(caps.fails[id] ?? 0, FAIL_LIMIT);
  saveCaps();
}

// --- Boot ---------------------------------------------------------------------------

let started = false;

/** Reads the mode and the learned capabilities, and asks the platform
 * whether its component exists. `ver`: the app's version key (learned
 * "web" fallbacks are forgotten when it changes). Idempotent. */
export function initNativePlayer(ver: string): void {
  if (started) return;
  started = true;
  versionKey = ver;
  void Storage.getItem(NATIVE_PLAYER_KEY)
    .then((v) => {
      if (!untracked(modeRead)) {
        nativeMode.set(v === "1" || v === "0" ? v : "auto");
        modeRead.set(true);
      }
    })
    .catch(() => modeRead.set(true));
  void Storage.getItem(CAPS_KEY)
    .then((raw) => {
      const v = raw ? (JSON.parse(raw) as Partial<Caps>) : null;
      if (v && typeof v === "object") {
        caps = {
          ver: typeof v.ver === "string" ? v.ver : "",
          native: Array.isArray(v.native) ? v.native.filter((x) => typeof x === "string") : [],
          fails: v.fails && typeof v.fails === "object" ? (v.fails as Record<string, number>) : {},
        };
      }
      if (caps.ver !== versionKey) {
        // A new app: every source is worth its native try again.
        caps = { ver: versionKey, native: caps.native, fails: {} };
        saveCaps();
      } else capsRev.set(untracked(capsRev) + 1);
    })
    .catch(() => {});
  void checkAvailable().then((ok) => nativeAvailable.set(ok));
}

async function checkAvailable(): Promise<boolean> {
  try {
    if (!host.available()) return false;
  } catch {
    return false;
  }
  try {
    const res = (await Promise.race([
      host.call("sys.nativeVideoInfo", {} as never),
      new Promise<null>((done) => setTimeout(() => done(null), CHECK_MS)),
    ])) as { ok?: unknown; available?: unknown; pip?: unknown; fullscreen?: unknown; local?: unknown; embeddedSubtitles?: unknown; subtitleCues?: unknown } | null;
    if (!res || res.available !== true) return false;
    nativeInfo.set({
      pip: typeof res.pip === "boolean" ? res.pip : undefined,
      fullscreen: typeof res.fullscreen === "boolean" ? res.fullscreen : undefined,
      local: typeof res.local === "boolean" ? res.local : undefined,
      // Absent: the platform draws the stream's own subtitle tracks.
      embeddedSubtitles: typeof res.embeddedSubtitles === "boolean" ? res.embeddedSubtitles : undefined,
      subtitleCues: res.subtitleCues === true,
    });
    return true;
  } catch {
    // An op the host lacks: no component on this platform yet.
    return false;
  }
}
