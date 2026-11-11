// Player: the chosen embed source in a WebView. The WebView is a native
// view above all GPUI content, so nothing can draw over it: while the
// command palette or the source picker is open, the video area collapses
// to zero height (the page keeps its state) and a fixed-size floating
// card takes the space. Cmd+K toggles the palette; it lists episodes and
// playback controls, filters as you type, and ⌘1–⌘9 pick items.

import { computed, effect, signal, Text, View, WebView } from "nsh";
import { Input } from "nsh/base";
import { route } from "../lib/router";
import {
  duration,
  episodes,
  loadEpisodes,
  nextEpisode,
  onPlayerMessage,
  paletteQuery,
  paletteRows,
  paletteSelect,
  paletteView,
  paletteViewTitle,
  pickSource,
  PLAYER_BRIDGE,
  playerRoute,
  playerUrl,
  position,
  showPalette,
  showSources,
  seasons,
  sourceId,
  startPlayer,
  stopPlayer,
  webview,
} from "../lib/player";
import { NEEDS_INTERCEPT, sourcesFor, type MediaType } from "../lib/sources";

const error = signal("");

/** The palette's filter field; focused as soon as the palette mounts so
 * keystrokes (including space) go to it instead of the WebView. */
const paletteInput = signal<{ focus(): void } | null>(null);

export function Player() {
  // (Re)arm state, episode list and resume whenever the route changes.
  effect(() => {
    const r = route();
    if (r.name === "player") {
      startPlayer();
      void loadEpisodes(r);
    } else {
      stopPlayer();
    }
  });

  // The WebView keeps keyboard focus otherwise — every key (space
  // included) would keep reaching the page while the palette is open.
  effect(() => {
    if (showPalette()) {
      try {
        webview()?.blur();
      } catch {}
      const input = paletteInput();
      input?.focus();
      setTimeout(() => paletteInput()?.focus(), 120);
    }
  });

  const src = computed(() => playerUrl());
  const r = computed(() => playerRoute());
  const overlay = computed(() => showPalette() || showSources());

  const canNext = computed(() => {
    const p = r();
    if (!p || p.type === "movie") return false;
    const cur = p.episode ?? 1;
    const eps = episodes();
    const i = eps.findIndex((e) => e.n === cur);
    if (i >= 0 && i + 1 < eps.length) return true;
    if (p.type === "anime") return false;
    const ss = seasons();
    const si = ss.indexOf(p.season ?? 1);
    return si >= 0 && si + 1 < ss.length;
  });

  return (
    <View class="flex-1 bg-black">
      <View class="flex-1 flex-col">
        {/* Video area: collapsed while an overlay card is open so the
            card can sit in-flow (the WebView itself stays mounted). */}
        <View
          class={overlay() ? "overflow-hidden" : "flex-1"}
          style={overlay() ? { height: 0 } : undefined}
        >
          <If when={src()}>
            {(u) => (
              <WebView
                ref={(node) => webview.set(node)}
                src={u()}
                class="flex-1"
                userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
                injectedJavaScript={PLAYER_BRIDGE}
                onMessage={onPlayerMessage}
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

        {/* Floating cards: fixed width, fixed height, scrollable list. */}
        <If when={overlay()}>
          <View class="flex-1 items-center justify-center bg-black p-8">
            <If when={showPalette()}>
              <View
                class="flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
                style={{ width: 620, height: "62%" }}
              >
                <View class="flex-row items-center gap-2 border-b border-zinc-800 px-4 py-3">
                  <Text class="text-sm font-bold text-zinc-100">
                    {paletteViewTitle()}
                  </Text>
                  <View class="flex-1" />
                  <Text class="text-[11px] text-zinc-600">esc</Text>
                </View>
                <If when={paletteView() === "root"}>
                  <View class="border-b border-zinc-800 px-3 py-2">
                    <Input
                      ref={(node) => paletteInput.set(node)}
                      value={paletteQuery()}
                      onChange={({ value }) => paletteQuery.set(value)}
                      onSubmit={() => {
                        const items = paletteRows().filter((x) => x.kind === "item");
                        const first = items.find((x) => x.num === 1);
                        if (first?.id) paletteSelect(first.id);
                      }}
                      placeholder="Type to filter…"
                      class="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-500"
                    />
                  </View>
                </If>
                <View class="flex-1 overflow-y-auto p-1.5">
                  <Each of={paletteRows()}>
                    {(row) => (
                      <>
                        <If when={row().kind === "header"}>
                          <Text class="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                            {row().label}
                          </Text>
                        </If>
                        <If when={row().kind === "item"}>
                          <View
                            role="button"
                            onPress={() => {
                              const id = row().id;
                              if (id) paletteSelect(id);
                            }}
                            class="mx-1 flex-row items-center gap-2 rounded-lg px-3 py-2 active:bg-zinc-800"
                          >
                            <If when={(row().num ?? 99) <= 9}>
                              <Text class="w-6 text-[11px] font-bold text-zinc-600">
                                ⌘{row().num}
                              </Text>
                            </If>
                            <Text class="flex-1 text-sm text-zinc-100">
                              {row().label}
                            </Text>
                            <If when={row().checked}>
                              <Text class="text-sm text-red-500">✓</Text>
                            </If>
                          </View>
                        </If>
                      </>
                    )}
                  </Each>
                  <If when={paletteRows().length === 0}>
                    <Text class="p-4 text-sm text-zinc-500">No matches</Text>
                  </If>
                </View>
              </View>
            </If>

            <If when={showSources()}>
              <View
                class="flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
                style={{ width: 560, height: "55%" }}
              >
                <View class="border-b border-zinc-800 px-4 py-3">
                  <Text class="text-sm font-bold text-zinc-100">Sources</Text>
                </View>
                <View class="flex-1 overflow-y-auto p-1.5">
                  <Each of={sourcesFor((r()?.type ?? "movie") as MediaType)}>
                    {(s) => (
                      <View
                        role="button"
                        onPress={() => {
                          pickSource(s().id);
                          error.set("");
                        }}
                        class="mx-1 flex-row items-center gap-2 rounded-lg px-3 py-2 active:bg-zinc-800"
                      >
                        <View class="flex-1">
                          <Text class="text-sm font-medium text-zinc-100">
                            {s().label}
                          </Text>
                          <If when={NEEDS_INTERCEPT.includes(s().id)}>
                            <Text class="text-[11px] text-amber-500">
                              may not load
                            </Text>
                          </If>
                        </View>
                        <If when={s().note}>
                          {(n) => (
                            <Text class="text-xs text-zinc-500">{n()}</Text>
                          )}
                        </If>
                        <If when={sourceId() === s().id}>
                          <Text class="text-sm text-red-500">✓</Text>
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </If>
          </View>
        </If>
      </View>

      {/* Bottom bar: progress + next episode */}
      <View class="gap-2 border-t border-zinc-800 bg-zinc-950 p-3">
        <If when={error()}>
          {(e) => <Text class="text-xs text-red-400">{e()}</Text>}
        </If>
        <If when={duration() > 0}>
          <View class="h-1 w-full rounded bg-zinc-700">
            <View
              class="h-1 rounded bg-red-600"
              style={{
                width: `${Math.min(100, (position() / duration()) * 100)}%`,
              }}
            />
          </View>
        </If>
        <View class="flex-row items-center justify-between">
          <Text class="text-xs text-zinc-400">
            {duration() > 0 ? `${fmt(position())} / ${fmt(duration())}` : ""}
          </Text>
          <If when={canNext()}>
            <View
              role="button"
              onPress={() => void nextEpisode()}
              class="rounded-lg bg-red-600 px-4 py-1.5"
            >
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
