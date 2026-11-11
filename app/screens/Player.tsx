// Player: the chosen embed source in a WebView, with an overlay for
// source switching, episode skipping and progress saving.

import { signal, Text, View, WebView, type WebViewRef } from "nsh";
import { navigate, route } from "../lib/router";
import { getSourceUrl, NEEDS_INTERCEPT, sourcesFor, type MediaType } from "../lib/sources";
import { itemKey, saveProgress, settings } from "../lib/store";
import type { Route } from "../lib/router";

type PlayerRoute = Extract<Route, { name: "player" }>;

const webview = signal<WebViewRef | null>(null);
const sourceId = signal(settings().defaultSource);
const showSources = signal(false);
const error = signal("");
const position = signal(0);
const duration = signal(0);
let progressTimer: ReturnType<typeof setInterval> | undefined;
let lastSaved = 0;

const POLL_MS = 10_000;

/** Reads the page's <video> time; embed players keep it same-origin or in
 * nested iframes we cannot reach, so failures are ignored quietly. */
const PROBE = `(() => {
  try {
    const v = document.querySelector('video');
    if (!v) return null;
    return JSON.stringify({ t: v.currentTime || 0, d: v.duration || 0 });
  } catch (e) { return null; }
})()`;

function currentRoute(): PlayerRoute | null {
  const r = route();
  return r.name === "player" ? r : null;
}

function probe() {
  const ref = webview();
  if (!ref || typeof ref.evaluate !== "function") return;
  Promise.resolve(ref.evaluate(PROBE))
    .then((raw) => {
      const s = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (!s) return;
      const v = JSON.parse(s);
      if (v && typeof v.t === "number") {
        position.set(v.t);
        if (typeof v.d === "number" && v.d > 0) duration.set(v.d);
        const now = Date.now();
        if (now - lastSaved > 30_000 && v.d > 0) {
          lastSaved = now;
          persist();
        }
      }
    })
    .catch(() => {});
}

function persist() {
  const r = currentRoute();
  if (!r) return;
  void saveProgress({
    key: itemKey(r.type, r.id, r.season ?? 0, r.episode ?? 0),
    type: r.type,
    id: r.id,
    title: r.title ?? "Untitled",
    poster: r.poster ?? "",
    season: r.season,
    episode: r.episode,
    position: position(),
    duration: duration(),
    source: sourceId(),
  });
}

function url(): string | null {
  const r = currentRoute();
  if (!r) return null;
  return getSourceUrl(
    sourceId(),
    {
      type: r.type as MediaType,
      id: r.id,
      season: r.season,
      episode: r.episode,
      lang: r.lang,
    },
    {},
    settings().accent,
    settings().subtitleLang || null,
  );
}

function pick(id: string) {
  sourceId.set(id);
  showSources.set(false);
  error.set("");
}

function next() {
  const r = currentRoute();
  if (!r?.next) return;
  persist();
  navigate({
    ...r,
    season: r.next.season ?? r.season,
    episode: r.next.episode ?? (r.episode ?? 0) + 1,
    next: undefined,
  });
}

function back() {
  persist();
  const r = currentRoute();
  navigate({ name: "title", type: r?.type ?? "movie", id: r?.id ?? 0 });
}

export function Player() {
  const r = route();
  const src = r.name === "player" ? url() : null;

  // (Re)arm the progress probe for this mount.
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(probe, POLL_MS);
  position.set(0);
  duration.set(0);
  lastSaved = 0;

  const title = r.name === "player" ? (r.title ?? "") : "";
  const seasonEp =
    r.name === "player" && r.season ? ` — S${r.season}E${r.episode}` : "";
  const hasNext = r.name === "player" && !!r.next;

  return (
    <View class="flex-1 bg-black">
      <If when={src}>
        {(u) => (
          <WebView
            ref={(node) => webview.set(node)}
            src={u()}
            class="flex-1"
            userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
            onError={(e) => error.set(String(e))}
          />
        )}
      </If>
      <If when={!src}>
        <View class="flex-1 items-center justify-center">
          <Text class="text-zinc-400">This source cannot play this title.</Text>
        </View>
      </If>

      {/* Top bar */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 12,
          backgroundColor: "rgba(0,0,0,0.75)",
        }}
      >
        <View role="button" onPress={back} class="rounded-lg bg-black/50 px-3 py-1.5">
          <Text class="text-sm font-semibold text-white">‹ Back</Text>
        </View>
        <Text class="flex-1 text-sm font-semibold text-white" style={{ numberOfLines: 1 }}>
          {title}
          {seasonEp}
        </Text>
        <View
          role="button"
          onPress={() => showSources.set(!showSources())}
          class="rounded-lg bg-black/50 px-3 py-1.5"
        >
          <Text class="text-sm font-semibold text-white">{sourceId()}</Text>
        </View>
      </View>

      {/* Source picker */}
      <If when={showSources()}>
        <View
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            maxHeight: "50%",
            borderTopWidth: 1,
            borderTopColor: "#27272a",
            backgroundColor: "rgba(9,9,11,0.95)",
            padding: 12,
            gap: 4,
          }}
        >
          <Text class="pb-1 text-xs font-bold uppercase text-zinc-500">Sources</Text>
          <Each of={sourcesFor((r.name === "player" ? r.type : "movie") as MediaType)}>
            {(s) => (
              <View
                role="button"
                onPress={() => pick(s().id)}
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
      <View
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          gap: 8,
          padding: 12,
          backgroundColor: "rgba(0,0,0,0.75)",
        }}
      >
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
          <If when={hasNext}>
            <View role="button" onPress={next} class="rounded-lg bg-red-600 px-4 py-1.5">
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
