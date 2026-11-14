// The web backend: the source's embed page in the player's web view,
// driven through the injected bridge (lib/player.ts PLAYER_BRIDGE) with
// JSON commands posted into the page. Every `{t: …}` command the app sends
// to a page is built here — lib/player.ts calls these methods, never the
// page directly. Reports come back as the web view's `onMessage`
// (lib/player.ts `onPlayerMessage`).
//
// Besides the media commands of PlaybackBackend, a page has things only a
// page has: the desktop's in-page Cinema overlay (`ctl`, `chrome`, `avs`,
// `srcm`, `toast`, `ptr`), the key block, the ad guard switch, the
// "blind" mode and the stream-link sniffer (`streams`).

import type { WebViewRef } from "nsh";
import type { CaptionSink, PlaybackBackend } from "./backend";

export interface WebBackend extends PlaybackBackend {
  readonly kind: "web";
  /** Desktop overlay on/off (and the page-side key handling). */
  pageControls(on: boolean): void;
  /** The overlay's app-supplied state (title, episode line, skip, …). */
  chrome(c: Record<string, unknown>): void;
  /** The overlay's Audio & Subtitles panel data. */
  panel(p: Record<string, unknown>): void;
  sourcesModal(on: boolean, items?: { id: string; label: string; note?: string; warn?: boolean }[], active?: string): void;
  toast(text: string, kind: string): void;
  pointer(k: string, x: number, y: number): void;
  keysBlocked(on: boolean): void;
  guard(on: boolean, skip?: string[]): void;
  blind(on: boolean): void;
  /** Asks the page for the media URLs it fetched (`{t:-2}` answer). */
  requestStreams(): void;
}

export function createWebBackend(opts: {
  ref: () => WebViewRef | null;
  debug: (event: string, data?: unknown) => void;
}): WebBackend {
  const { debug } = opts;
  /** App → page: a JSON command for the bridge's message listener. */
  const send = (msg: Record<string, unknown>) => {
    const ref = opts.ref();
    debug("send", msg);
    if (!ref) {
      debug("send: no webview ref");
      return;
    }
    try {
      if (typeof ref.postMessage === "function") {
        ref.postMessage(JSON.stringify(msg));
        return;
      }
    } catch (e) {
      debug("send: postMessage threw", String(e));
    }
    try {
      if (typeof ref.injectJavaScript === "function") {
        const data = JSON.stringify(JSON.stringify(msg));
        ref.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${data}}));`);
        debug("send: used injectJavaScript fallback");
      } else {
        debug("send: no postMessage/injectJavaScript on ref");
      }
    } catch (e) {
      debug("send: injectJavaScript threw", String(e));
    }
  };

  const CUE_CHUNK = 250;
  const captions: CaptionSink = {
    off: () => send({ t: "cap", mode: "off" }),
    track: (i, label, lang) => send({ t: "cap", mode: "track", i, label, lang }),
    cues: (id, cues) => {
      // In chunks (message-size limits).
      const n = Math.max(1, Math.ceil(cues.length / CUE_CHUNK));
      send({ t: "cap", mode: "ext", id, n });
      for (let k = 0; k < n; k++) send({ t: "capx", id, k, c: cues.slice(k * CUE_CHUNK, (k + 1) * CUE_CHUNK) });
    },
    config: (c) => {
      const m: Record<string, unknown> = { t: "capc" };
      if (c.size) m.size = c.size;
      if (typeof c.offset === "number") m.o = c.offset;
      if (typeof c.lift === "boolean") m.lift = c.lift;
      send(m);
    },
  };

  return {
    kind: "web",
    play: () => send({ t: "play" }),
    pause: () => send({ t: "pause" }),
    toggle: () => send({ t: "toggle" }),
    seek: (p) => send({ t: "seek", p }),
    seekBy: (s) => send({ t: "seekby", s }),
    setRate: (r) => send({ t: "rate", r }),
    hold: (on) => send({ t: "hold", on }),
    setVolume: (v) => send({ t: "vol", v }),
    toggleMute: () => send({ t: "mute" }),
    selectAudio: (i) => send({ t: "aud", i }),
    fit: (fill) => send({ t: "fill", on: fill }),
    pip: () => send({ t: "pip" }),
    fullscreen: (mode) => send({ t: mode === "enter" ? "fs" : mode === "exit" ? "fsx" : "fst" }),
    sync: () => send({ t: "sync" }),
    captions,
    destroy: () => {
      // The page goes with its URL (the web view returns to about:blank).
    },
    pageControls: (on) => send({ t: "ctl", on }),
    chrome: (c) => send({ t: "chrome", ...c }),
    panel: (p) => send({ t: "avs", ...p }),
    sourcesModal: (on, items, active) => send(items ? { t: "srcm", on, items, active } : { t: "srcm", on }),
    toast: (text, kind) => send({ t: "toast", text, kind }),
    pointer: (k, x, y) => send({ t: "ptr", k, x, y }),
    keysBlocked: (on) => send({ t: "keys", on }),
    guard: (on, skip) => send(skip ? { t: "guard", on, skip } : { t: "guard", on }),
    blind: (on) => send({ t: "blind", on }),
    requestStreams: () => send({ t: "streams" }),
  };
}
