// Captions over the app's own player (the native backend). The app's
// subtitle engine (lib/subtitles.ts, the model in lib/player.ts) loads the
// cues — online providers, the subtitle saved with a download — and this
// draws the ones due at the player's time, the way the page bridge draws
// them inside a page: size from the viewport height (S / M / L), raised
// above the controls while they show, shifted by the timing offset.
// Embedded tracks of the stream are drawn by the platform's player itself
// (contract `selectSubtitle`), not here.
//
// Time: `position()` arrives ~4×/s; between reports it is carried forward
// at the playback rate on a 100 ms tick (never more than 0.5 s ahead), so
// cues change on time.

import { cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { mediaPaused, mediaRate, playerPhase, position, subtitleOffset } from "../lib/player";
import { captionConfig, embeddedCues, nativeCaptions } from "../lib/playback/nativeBackend";
import { nativeInfo } from "../lib/playback/caps";
import { settings } from "../lib/store";

/** Font size in % of the picture's height, as the page bridge's CAP_VH. */
const CAP_VH = { s: 3.3, m: 4.2, l: 5.4 } as const;

type Cue = { s: number; e: number; t: string };

/** The cues due at `t` (sorted by start), their texts joined by lines. */
export function cueText(cues: Cue[], t: number): string {
  const parts: string[] = [];
  // Binary search for the first cue starting after t; walk back over the
  // ones that may still be on (cues overlap rarely, a few at most).
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].s <= t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0 && i >= lo - 8; i--) {
    const c = cues[i];
    if (t < c.e) parts.unshift(c.t);
  }
  return parts.join("\n");
}

/** One line split at the italics markers (\u0001 on, \u0002 off). */
function segments(line: string, startItalic: boolean): { text: string; italic: boolean }[] {
  const out: { text: string; italic: boolean }[] = [];
  let ital = startItalic;
  for (const part of line.split(/([\u0001\u0002])/)) {
    if (part === "\u0001") ital = true;
    else if (part === "\u0002") ital = false;
    else if (part) out.push({ text: part, italic: ital });
  }
  return out;
}

export function Captions(props: { mobile: boolean; size: () => { w: number; h: number } }) {
  // The player's time, carried forward between reports.
  let basePos = 0;
  let baseAt = 0;
  const tick = signal(0);
  effect(() => {
    basePos = position();
    baseAt = Date.now();
    untracked(() => tick.set(untracked(tick) + 1));
  });
  const cues = computed(() => nativeCaptions()?.cues ?? null);
  const timer = setInterval(() => {
    if (!untracked(cues) || untracked(mediaPaused) || untracked(playerPhase) !== "playing") return;
    tick.set(untracked(tick) + 1);
  }, 100);
  cleanup(() => clearInterval(timer));

  const text = computed(() => {
    // An embedded track whose text the player hands over (macOS `cues`):
    // drawn as is (the player times it; the offset applies to online
    // subtitles only). Exclusive with online cues (one selection).
    const emb = embeddedCues();
    if (!cues() && emb && nativeInfo().subtitleCues) return emb.join("\n");
    tick();
    const list = cues();
    if (!list || !list.length) return "";
    let t = basePos;
    if (!mediaPaused() && playerPhase() === "playing") {
      t += Math.min(0.5, Math.max(0, ((Date.now() - baseAt) / 1000) * (mediaRate() || 1)));
    }
    return cueText(list, t - subtitleOffset());
  });

  const layout = computed(() => {
    const { w, h } = props.size();
    const vh = h || 600;
    const size = settings().subtitleSize ?? "m";
    // Sized from the picture's short side: a portrait phone shows a 16:9
    // picture across its width, and the screen height would make lines
    // three times too big (the page's `vh` is the same in landscape).
    const base = w > 0 && w < vh ? w : vh;
    const fs = Math.max(13, Math.round((base * (CAP_VH[size] ?? CAP_VH.m)) / 100));
    const lifted = captionConfig().lift;
    const bottom = lifted ? Math.round(props.mobile ? vh * 0.18 + 24 : 96 + vh * 0.02) : Math.round(vh * 0.07);
    return { fs, bottom };
  });

  // The same text gives the same array (the 100 ms tick must not hand
  // <Each> new items, which would re-create the caption views).
  let lastText = "";
  let lastLines: { key: string; segs: { text: string; italic: boolean }[] }[] = [];
  const lines = computed(() => {
    const t0 = text();
    if (t0 === lastText) return lastLines;
    lastText = t0;
    const out: { key: string; segs: { text: string; italic: boolean }[] }[] = [];
    let ital = false;
    text()
      .split("\n")
      .slice(0, 3)
      .forEach((l, i) => {
        if (!l) return;
        const segs = segments(l, ital);
        // An italic run may span lines.
        for (const ch of l) {
          if (ch === "\u0001") ital = true;
          else if (ch === "\u0002") ital = false;
        }
        out.push({ key: `${i}:${l}`, segs });
      });
    lastLines = out;
    return out;
  });

  return (
    <If when={lines().length > 0}>
      <View
        class="pointer-events-none absolute items-center"
        style={{ left: "10%", right: "10%", bottom: layout().bottom }}
        accessibilityLabel="Captions"
      >
        <Each of={lines()} key={(l: { key: string; segs: { text: string; italic: boolean }[] }) => l.key}>
          {(line) => (
            <View style={{ maxWidth: "100%" }}>
              <Text
                class="text-center font-semibold text-white"
                style={{
                  fontSize: layout().fs,
                  lineHeight: Math.round(layout().fs * 1.22),
                  // The page's caption look (bridge CAP_CSS).
                  textShadow: "0 1px 3px rgba(0,0,0,0.95)",
                }}
              >
                <Each of={line().segs}>
                  {(seg) => <Text style={{ fontStyle: seg().italic ? "italic" : "normal" }}>{seg().text}</Text>}
                </Each>
              </Text>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
