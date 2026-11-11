// Player: the chosen embed source in a WebView. All chrome is in-flow —
// the WebView is a native view above GPUI content, so nothing may be
// drawn over it. Cmd+K opens the in-flow command palette (episodes +
// playback controls), the source picker sits below it, progress and
// next-episode at the bottom.

import { computed, effect, signal, Text, View, WebView } from "nsh";
import { Command, type CommandItem } from "nsh/base";
import { route } from "../lib/router";
import {
  closePalette,
  episodes,
  goEpisode,
  loadEpisodes,
  loadTracks,
  mediaPaused,
  mediaRate,
  nextEpisode,
  paletteView,
  pickSource,
  playerRoute,
  playerUrl,
  position,
  duration,
  seekBy,
  setRate,
  setTrack,
  showPalette,
  showSources,
  seasons,
  sourceId,
  SPEEDS,
  startPlayer,
  stopPlayer,
  subTracks,
  togglePlay,
  webview,
} from "../lib/player";
import { NEEDS_INTERCEPT, sourcesFor, type MediaType } from "../lib/sources";

/** Embed players sometimes leave a video at an unusual playback rate
 * (seen: 2x after a space-bar toggle). Snap anything off the offered
 * rates back to 1x. */
const RATE_GUARD = `(() => {
  const ok = new Set([0.5, 0.75, 1, 1.25, 1.5, 2]);
  const fix = (v) => {
    if (v && v.playbackRate && !ok.has(v.playbackRate)) {
      try { v.playbackRate = 1; } catch (e) {}
    }
  };
  document.addEventListener('play', (e) => fix(e.target), true);
  document.addEventListener('ratechange', (e) => fix(e.target), true);
})()`;

const error = signal("");

const paletteItems = computed<CommandItem[]>(() => {
  const view = paletteView();
  const r = playerRoute();
  if (view === "speed") {
    return [
      { id: "nav:root", label: "‹ Playback", group: "Speed" },
      ...SPEEDS.map((s) => ({
        id: `speed:${s}`,
        label: `${s}×`,
        group: "Speed",
        checked: mediaRate() === s,
      })),
    ];
  }
  if (view === "subs") {
    const items: CommandItem[] = [
      { id: "nav:root", label: "‹ Playback", group: "Subtitles" },
      {
        id: "sub:off",
        label: "Off",
        group: "Subtitles",
        checked: subTracks().every((t) => t.mode !== "showing"),
      },
    ];
    for (const t of subTracks()) {
      items.push({
        id: `sub:${t.i}`,
        label: t.label,
        group: "Subtitles",
        checked: t.mode === "showing",
      });
    }
    return items;
  }
  const items: CommandItem[] = [];
  const eps = episodes();
  if (r && r.type !== "movie" && eps.length > 1) {
    for (const e of eps) {
      const tag =
        r.type === "tv" ? `S${r.season ?? 1}E${e.n}` : `Episode ${e.n}`;
      items.push({
        id: `ep:${e.n}`,
        label: `${tag}${e.name ? ` — ${e.name}` : ""}`,
        group: "Episodes",
        checked: e.n === (r.episode ?? 1),
      });
    }
  }
  items.push(
    {
      id: "ctl:toggle",
      label: mediaPaused() ? "Play" : "Pause",
      group: "Playback",
    },
    { id: "ctl:back10", label: "Back 10 seconds", group: "Playback" },
    { id: "ctl:fwd10", label: "Forward 10 seconds", group: "Playback" },
    {
      id: "ctl:speed",
      label: `Playback speed · ${mediaRate()}×`,
      group: "Playback",
    },
    { id: "ctl:subs", label: "Subtitles", group: "Playback" },
    { id: "ctl:source", label: "Choose source…", group: "Playback" },
  );
  return items;
});

function onPaletteSelect(e: { id: string }) {
  const id = e.id;
  if (id === "nav:root") {
    paletteView.set("root");
    return;
  }
  if (id.startsWith("ep:")) {
    goEpisode(Number(id.slice(3)));
    closePalette();
    return;
  }
  if (id.startsWith("speed:")) {
    setRate(Number(id.slice(6)));
    paletteView.set("root");
    return;
  }
  if (id === "sub:off") {
    setTrack(-1);
    paletteView.set("root");
    return;
  }
  if (id.startsWith("sub:")) {
    setTrack(Number(id.slice(4)));
    paletteView.set("root");
    return;
  }
  switch (id) {
    case "ctl:toggle":
      togglePlay();
      break;
    case "ctl:back10":
      seekBy(-10);
      break;
    case "ctl:fwd10":
      seekBy(10);
      break;
    case "ctl:speed":
      paletteView.set("speed");
      break;
    case "ctl:subs":
      void loadTracks().then(() => paletteView.set("subs"));
      break;
    case "ctl:source":
      closePalette();
      showSources.set(true);
      break;
  }
}

const canNext = computed(() => {
  const r = playerRoute();
  if (!r || r.type === "movie") return false;
  const cur = r.episode ?? 1;
  const eps = episodes();
  const i = eps.findIndex((e) => e.n === cur);
  if (i >= 0 && i + 1 < eps.length) return true;
  if (r.type === "anime") return false;
  const ss = seasons();
  const si = ss.indexOf(r.season ?? 1);
  return si >= 0 && si + 1 < ss.length;
});

export function Player() {
  // (Re)arm probes, episode list and resume whenever the route changes.
  effect(() => {
    const r = route();
    if (r.name === "player") {
      startPlayer();
      void loadEpisodes(r);
    } else {
      stopPlayer();
    }
  });

  const src = computed(() => playerUrl());
  const r = computed(() => playerRoute());

  return (
    <View class="flex-1 bg-black">
      <View class="flex-1">
        <If when={src()}>
          {(u) => (
            <WebView
              ref={(node) => webview.set(node)}
              src={u()}
              class="flex-1"
              userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
              injectedJavaScript={RATE_GUARD}
              onError={(e) => error.set(String(e))}
            />
          )}
        </If>
        <If when={!src()}>
          <View class="flex-1 items-center justify-center">
            <Text class="text-zinc-400">This source cannot play this title.</Text>
          </View>
        </If>
      </View>

      {/* Command palette (Cmd+K): in-flow, since nothing can draw over
          the WebView. Episodes plus playback controls and their
          submenus. */}
      <If when={showPalette()}>
        <View
          class="border-t border-zinc-800 bg-zinc-950"
          style={{ height: "55%" }}
        >
          <Command
            items={paletteItems()}
            onSelect={onPaletteSelect}
            onCancel={closePalette}
            autoFocus
            placeholder="Type to filter…"
            class="flex-1"
            searchBarClass="flex-row items-center border-b border-zinc-800 px-3"
            searchClass="h-10 flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500"
            listClass="flex-1 p-1"
            groupClass="px-2 py-1 text-[11px] font-bold uppercase text-zinc-500"
            itemClass="flex-row items-center rounded-md px-2 py-1.5 focus:bg-zinc-800"
            separatorClass="my-1 h-px bg-zinc-800"
          />
        </View>
      </If>

      {/* Source picker */}
      <If when={showSources()}>
        <View class="max-h-[50%] gap-1 overflow-y-auto border-t border-zinc-800 bg-zinc-950 p-3">
          <Text class="pb-1 text-xs font-bold uppercase text-zinc-500">Sources</Text>
          <Each of={sourcesFor((r()?.type ?? "movie") as MediaType)}>
            {(s) => (
              <View
                role="button"
                onPress={() => {
                  pickSource(s().id);
                  error.set("");
                }}
                class="flex-row items-center gap-2 rounded-lg p-2 active:bg-zinc-800"
              >
                <View class="flex-1">
                  <Text class="text-sm font-medium text-white">{s().label}</Text>
                  <If when={NEEDS_INTERCEPT.includes(s().id)}>
                    <Text class="text-[11px] text-amber-500">may not load</Text>
                  </If>
                </View>
                <If when={s().note}>
                  {(n) => <Text class="text-xs text-zinc-500">{n()}</Text>}
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>

      {/* Bottom bar: progress + next episode */}
      <View class="gap-2 border-t border-zinc-800 bg-zinc-950 p-3">
        <If when={error()}>
          {(e) => <Text class="text-xs text-red-400">{e()}</Text>}
        </If>
        <If when={duration() > 0}>
          <View class="h-1 w-full rounded bg-zinc-700">
            <View
              class="h-1 rounded bg-red-600"
              style={{ width: `${Math.min(100, (position() / duration()) * 100)}%` }}
            />
          </View>
        </If>
        <View class="flex-row items-center justify-between">
          <Text class="text-xs text-zinc-400">
            {duration() > 0 ? `${fmt(position())} / ${fmt(duration())}` : ""}
          </Text>
          <If when={canNext()}>
            <View role="button" onPress={() => void nextEpisode()} class="rounded-lg bg-red-600 px-4 py-1.5">
              <Text class="text-sm font-bold text-white">Next Episode ›</Text>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}

function fmt(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
