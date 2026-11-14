// Source picker: a full-screen layer over the player (same family as the
// episode picker). It is a view in the player's own tree, not a Dialog:
// on iOS views composite over the WKWebView in tree order, and on the
// desktop the player hides the web view while a picker is open (GPUI
// cannot draw over it), so the layer shows in its place.
//
// State: player.ts's `showSources` IS the picker's state (re-exported as
// `showSourcesPicker`), so everything that already opens or closes
// "sources" — the page's `sources`/`srcx` actions, `pickSource`, the
// app's Escape — drives this picker.

import { batch, computed, platform, safeAreaInsets, Scroll, Text, View } from "nsh";
import { activeSource, closePalette, pickSource, playerRoute, showSources } from "../lib/player";
import { NEEDS_INTERCEPT, sourcesFor, type MediaType, type Source } from "../lib/sources";
import { nativeEnabled, nativeMode, sourcePlayback } from "../lib/playback/caps";
import { Glyph } from "./PlayerControls";
import { showEpisodes } from "./EpisodePicker";

export const showSourcesPicker = showSources;

export function openSources() {
  batch(() => {
    closePalette();
    showEpisodes.set(false);
    showSources.set(true);
  });
}

export function closeSources() {
  showSources.set(false);
}

export function SourcePicker() {
  return (
    <If when={showSources()}>
      <SourceLayer />
    </If>
  );
}

function SourceLayer() {
  const ins = safeAreaInsets();
  const padL = computed(() => Math.max(ins().left, 20));
  const padR = computed(() => Math.max(ins().right, 20));
  const route = computed(() => playerRoute());
  const list = computed(() => sourcesFor((route()?.type ?? "movie") as MediaType));
  // Where the app's player is on: the sources it plays first, the rest
  // (their own page) after a quiet "Site player" label.
  const grouped = computed(() => nativeEnabled() === true && nativeMode() !== "1");
  const inApp = computed(() => (grouped() ? list().filter((s) => sourcePlayback(s.id) === "native") : list()));
  const onSite = computed(() => (grouped() ? list().filter((s) => sourcePlayback(s.id) !== "native") : []));
  const row = (s: () => Source) => (
    <View
      role="button"
      accessibilityLabel={s().label}
      onPress={() => pickSource(s().id)}
      class={`min-h-[52px] cursor-pointer flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-white/15 ${
        platform.desktop ? "hover:bg-white/10" : ""
      } ${activeSource() === s().id ? "bg-white/5" : ""}`}
    >
      <View class="flex-1 flex-col gap-0.5">
        <Text class="text-base font-semibold text-foreground">{s().label}</Text>
        <If when={NEEDS_INTERCEPT.includes(s().id) || s().tag || s().note}>
          <View class="flex-row items-center gap-2">
            <If when={NEEDS_INTERCEPT.includes(s().id) && !(grouped() && sourcePlayback(s().id) === "native")}>
              <Text class="text-xs text-amber-500">may not load</Text>
            </If>
            <If when={[s().tag, s().note].filter(Boolean).join(" · ")}>
              {(t) => <Text class="text-xs text-muted-foreground">{t()}</Text>}
            </If>
          </View>
        </If>
      </View>
      <If when={activeSource() === s().id}>
        <Glyph d="check" size={20} color="#e50914" />
      </If>
    </View>
  );
  return (
    <View
      class="absolute inset-0 flex-col"
      style={{
        backgroundColor: "#0b0b0d",
        paddingTop: Math.max(ins().top, 12),
        paddingBottom: Math.max(ins().bottom, 12),
      }}
    >
      <View class="flex-row items-center" style={{ paddingLeft: padL(), paddingRight: padR() - 8 }}>
        <View class="flex-1 flex-col">
          <Text class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sources
          </Text>
          <Text class="text-xl font-bold text-foreground" style={{ numberOfLines: 1 }}>
            {route()?.title ?? ""}
          </Text>
        </View>
        <View
          role="button"
          accessibilityLabel="Close"
          onPress={closeSources}
          class="h-11 w-11 cursor-pointer items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20"
        >
          <Glyph d="close" size={22} />
        </View>
      </View>
      <Scroll class="mt-3 flex-1">
        <View class="flex-col gap-1 pb-4" style={{ paddingLeft: padL() - 8, paddingRight: padR() - 8 }}>
          <If when={grouped() && inApp().length > 0}>
            <Text class="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Plays in the app's player
            </Text>
          </If>
          <Each of={inApp()}>{row}</Each>
          <If when={onSite().length > 0}>
            <Text class="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Site player
            </Text>
          </If>
          <Each of={onSite()}>{row}</Each>
        </View>
      </Scroll>
    </View>
  );
}
