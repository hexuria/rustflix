// Player: the chosen embed source in a WebView. The WebView is a native
// view above all GPUI content, so nothing can draw over it: while the
// command palette or the source picker is open, the video area collapses
// to zero height (the page keeps its state) and a fixed-size floating
// card takes the space. Cmd+K toggles the palette; it lists episodes and
// playback controls, filters as you type, and ⌘1–⌘9 pick items.

import { computed, effect, Text, View, WebView } from "nsh";
import { route } from "../lib/router";
import {
  cancelDownload,
  debug,
  downloads,
  episodes,
  extLoading,
  loadEpisodes,
  nextEpisode,
  onPlayerMessage,
  paletteQuery,
  paletteRows,
  paletteSelect,
  paletteView,
  paletteViewTitle,
  pickSource,
  armBridge,
  PLAYER_BRIDGE,
  playerRoute,
  playerUrl,
  setPageKeysBlocked,
  showPalette,
  showSources,
  seasons,
  sourceId,
  startPlayer,
  stopPlayer,
  webview,
} from "../lib/player";
import { NEEDS_INTERCEPT, sourcesFor, type MediaType } from "../lib/sources";

// The last player route we armed for. NSH effects re-run on signal
// writes, and the player writes signals every probe — without this guard
// startPlayer/armResume would re-fire constantly and the resume seek
// would keep resetting the video (the 9:43 loop).
let handledRoute = "";

export function Player() {
  // (Re)arm state, episode list and resume only when the route itself
  // changes — not on every position/progress signal write.
  effect(() => {
    const r = route();
    const key =
      r.name === "player"
        ? `p:${r.type}:${r.id}:${r.season ?? 0}:${r.episode ?? 0}`
        : r.name;
    if (key === handledRoute) return;
    handledRoute = key;
    if (r.name === "player") {
      startPlayer();
      void loadEpisodes(r);
    } else {
      stopPlayer();
    }
  });

  // While an overlay card owns the keyboard, the page must not also act
  // on the same keys: the native web view keeps first responder (GPUI's
  // blur() cannot resign it), so the bridge swallows keys page-side.
  effect(() => {
    setPageKeysBlocked(showPalette() || showSources());
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

  // Recent downloads (running first, then latest finished/failed) shown
  // in the bottom bar so progress is visible outside the palette.
  const recentDownloads = computed(() =>
    downloads()
      .slice()
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"))
      .slice(0, 2),
  );
  const showBar = computed(() => canNext() || recentDownloads().length > 0);

  return (
    <View class="flex-1 bg-black">
      <View class="flex-1 flex-col">
        {/* Video area: shrunk while an overlay card is open so the card
            can sit in-flow (the WebView itself stays mounted). It must
            NOT collapse to zero — a hidden/zero-size web view suspends
            page JS, which kills the bridge's reports and commands. */}
        <View
          class={overlay() ? "overflow-hidden" : "flex-1"}
          style={overlay() ? { height: "44%" } : undefined}
        >
          <If when={src()}>
            {(u) => (
              <WebView
                ref={(node) => webview.set(node)}
                src={u()}
                class="flex-1"
                userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
                injectedJavaScriptBeforeContentLoaded={PLAYER_BRIDGE}
                onMessage={onPlayerMessage}
                onLoadStart={(e: unknown) => debug("wv:loadStart", e)}
                onLoad={(e: unknown) => {
                  debug("wv:load", e);
                  armBridge();
                }}
                onError={(e: unknown) => debug("wv:error", e)}
              />
            )}
          </If>
          <If when={!src()}>
            <View class="flex-1 items-center justify-center">
              <Text class="text-zinc-400">
                {extLoading() ? "Loading source…" : "This source cannot play this title."}
              </Text>
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
                {/* The palette owns the keyboard through keymap bindings
                    (bound on open, removed on close) — no text field, so
                    Escape and every printable key reach it. */}
                <If when={paletteView() === "root"}>
                  <View class="mx-3 mb-2 mt-1 flex-row items-center rounded-lg border border-zinc-800 bg-zinc-950 px-3"
                    style={{ height: 40 }}
                  >
                    <If when={!paletteQuery()}>
                      <Text class="text-sm text-zinc-500">Type to filter…</Text>
                    </If>
                    <Text class="flex-1 text-sm text-zinc-100">{paletteQuery()}</Text>
                    <Text class="text-[11px] text-zinc-600">↵</Text>
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
                        onPress={() => pickSource(s().id)}
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

      {/* Bottom bar: download status + next episode (the embed player
          owns its own timeline — no duplicate progress UI). */}
      <If when={showBar()}>
        <View class="flex-row items-center gap-3 border-t border-zinc-800 bg-zinc-950 px-3 py-2">
          <View class="flex-1 flex-col gap-0.5">
            <Each of={recentDownloads()}>
              {(d) => (
                <View class="flex-row items-center gap-2">
                  <Text
                    class={
                      d().status === "running"
                        ? "text-xs text-sky-400"
                        : d().status === "done"
                          ? "text-xs text-green-500"
                          : "text-xs text-red-400"
                    }
                  >
                    {d().status === "running"
                      ? `↓ ${d().name}${d().progress != null ? ` ${d().progress}%` : ""}`
                      : d().status === "done"
                        ? `✓ ${d().name} — downloaded`
                        : `✗ ${d().name} — ${d().message.slice(0, 60)}`}
                  </Text>
                  <If when={d().status === "running"}>
                    <View
                      role="button"
                      onPress={() => cancelDownload(d().id)}
                      class="rounded px-1.5 py-0.5 active:bg-zinc-800"
                    >
                      <Text class="text-[10px] text-zinc-500">cancel</Text>
                    </View>
                  </If>
                </View>
              )}
            </Each>
          </View>
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
      </If>
    </View>
  );
}
