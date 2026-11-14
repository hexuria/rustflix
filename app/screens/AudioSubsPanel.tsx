// "Audio & Subtitles" panel and the speed list: the two player popups.
//
// Their content only; where they sit is the caller's (PhoneControls draws
// them over the video, the desktop fallback bar in the strip above it).
// One popup at a time: `playerPopup` is that state, module-level so it
// survives the phone overlay re-mounting.

import { computed, keymap, Scroll, signal, Text, View } from "nsh";
import {
  audioHint,
  audioOptions,
  currentAudio,
  currentSubtitle,
  ensureSubtitleSearch,
  findAudioSource,
  mediaRate,
  nudgeSubtitle,
  resetSubtitleOffset,
  selectAudio,
  selectSubtitle,
  setRate,
  setSubtitleSize,
  SPEEDS,
  subtitleOffset,
  subtitleOptions,
  subtitleSearch,
  type SubOption,
} from "../lib/player";
import { settings } from "../lib/store";
import { Glyph, rateLabel, Spinner } from "./PlayerControls";

const RED = "#e50914";

export const playerPopup = signal<"subs" | "speed" | null>(null);

/** Closes whichever popup is open; true when one was. */
export function closePlayerPopups(): boolean {
  if (playerPopup() === null) return false;
  playerPopup.set(null);
  return true;
}

export function toggleSubsPanel() {
  if (playerPopup() === "subs") {
    playerPopup.set(null);
    return;
  }
  playerPopup.set("subs");
  ensureSubtitleSearch();
}

export function toggleSpeedList() {
  playerPopup.set(playerPopup() === "speed" ? null : "speed");
}

/** "+1.0 s", "−0.5 s", "0 s". */
function offsetLabel(v: number): string {
  if (Math.abs(v) < 0.05) return "0 s";
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} s`;
}

/** Escape closes the popup (the newest binding of a keystroke wins over
 * the app's own Escape → back; removed with the component). */
function useEscape() {
  keymap.bind("escape", () => {
    closePlayerPopups();
  });
}

function Row(props: {
  label: string;
  checked?: boolean;
  tag?: string;
  desktop?: boolean;
  icon?: "sources";
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: !!props.checked }}
      onPress={props.onPress}
      class={`flex-row items-center gap-2 rounded-lg px-2.5 ${
        props.desktop
          ? "h-9 cursor-pointer hover:bg-white/10 active:bg-white/15"
          : "min-h-11 active:bg-white/15"
      }`}
    >
      <If when={props.icon}>
        <Glyph d="sources" size={16} />
      </If>
      <Text
        class={`flex-1 text-white ${props.desktop ? "text-[13px]" : "text-[15px]"} ${
          props.checked ? "font-semibold" : ""
        }`}
        style={{ numberOfLines: 1 }}
      >
        {props.label}
      </Text>
      <If when={props.tag}>
        <Text class="text-[11px] text-zinc-400">{props.tag}</Text>
      </If>
      {/* A fixed slot so labels line up whether checked or not. */}
      <View class="w-5 items-center justify-center">
        <If when={props.checked}>
          <Glyph d="check" size={18} color={RED} />
        </If>
      </View>
    </View>
  );
}

function Heading(props: { label: string; first?: boolean }) {
  return (
    <Text
      class={`px-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500 ${
        props.first ? "pt-0.5" : "pt-2.5"
      }`}
    >
      {props.label}
    </Text>
  );
}

/** A small square-ish control of the bottom row (≥ 44 pt on the phone). */
function Chip(props: { label: string; on?: boolean; desktop?: boolean; a11y?: string; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.a11y ?? props.label}
      accessibilityState={{ selected: !!props.on }}
      onPress={props.onPress}
      class={`items-center justify-center rounded-md px-2 ${
        props.desktop
          ? "h-8 min-w-8 cursor-pointer hover:bg-white/15 active:bg-white/20"
          : "h-11 min-w-11 active:bg-white/20"
      } ${props.on ? "bg-white/20" : ""}`}
    >
      <Text class={`text-[13px] font-semibold ${props.on ? "text-white" : "text-zinc-300"}`}>
        {props.label}
      </Text>
    </View>
  );
}

/** The panel's content: Audio and Subtitles columns (each its own
 * scroll), then Size and Timing. Fills the box its caller gives it. */
export function AudioSubsPanel(props: { desktop?: boolean }) {
  useEscape();
  const desktop = !!props.desktop;
  const subs = computed(() => subtitleOptions());
  const mine = computed(() => subs().filter((o) => o.mine));
  const more = computed(() => subs().filter((o) => !o.mine));
  const size = computed(() => settings().subtitleSize ?? "m");
  const subRow = (o: () => SubOption) => (
    <Row
      label={o().label}
      checked={currentSubtitle() === o().id}
      tag={o().origin === "online" ? "online" : undefined}
      desktop={desktop}
      onPress={() => selectSubtitle(o().id)}
    />
  );
  return (
    <View
      class={`flex-1 flex-col overflow-hidden rounded-2xl ${
        desktop ? "border border-zinc-800 bg-zinc-900" : "bg-black/80"
      }`}
    >
      {/* Takes touches on the card's gaps (padding, between the columns)
          so none falls through to the layers under the panel. A sibling
          under the content, never an ancestor of the scrolls: a press
          recognizer around them would also end a list drag as a press. */}
      <View class="absolute inset-0" style={{ backgroundColor: "rgba(0,0,0,0.01)" }} onPress={() => {}} />
      <View class="flex-1 flex-row gap-1 px-1.5 pt-2.5">
        {/* Audio. */}
        <View class="flex-col" style={{ flex: 2 }}>
          <Heading label="Audio" first />
          <Scroll class="flex-1">
            <View class="flex-col pb-2">
              <If when={audioOptions().length > 1}>
                <Each of={audioOptions()}>
                  {(a) => (
                    <Row
                      label={a().label}
                      checked={currentAudio() === a().id}
                      desktop={desktop}
                      onPress={() => selectAudio(a().id)}
                    />
                  )}
                </Each>
              </If>
              <If when={audioOptions().length <= 1}>
                <If when={audioHint()}>
                  <Text class="px-2.5 py-2 text-[13px] text-zinc-400">{audioHint()}</Text>
                </If>
                <Row
                  label="Find another source"
                  icon="sources"
                  desktop={desktop}
                  onPress={() => {
                    closePlayerPopups();
                    findAudioSource();
                  }}
                />
              </If>
            </View>
          </Scroll>
        </View>
        <View class="my-1 w-px bg-white/10" />
        {/* Subtitles. */}
        <View class="flex-col" style={{ flex: 3 }}>
          <Heading label="Subtitles" first />
          <Scroll class="flex-1">
            <View class="flex-col pb-2">
              <Row
                label="Off"
                checked={currentSubtitle() === null}
                desktop={desktop}
                onPress={() => selectSubtitle(null)}
              />
              <If when={mine().length > 0}>
                <Heading label="My languages" />
                <Each of={mine()}>{subRow}</Each>
              </If>
              <If when={more().length > 0}>
                <Heading label="More" />
                <Each of={more()}>{subRow}</Each>
              </If>
              <If when={subtitleSearch() === "searching"}>
                <View class={`flex-row items-center gap-2 px-2.5 ${desktop ? "h-9" : "h-11"}`}>
                  <Spinner size={16} />
                  <Text class="text-[13px] text-zinc-400">Searching…</Text>
                </View>
              </If>
              <If when={subtitleSearch() === "error"}>
                <Text class="px-2.5 py-2 text-[12px] text-zinc-500">Couldn't search online</Text>
              </If>
            </View>
          </Scroll>
        </View>
      </View>
      <View class="mx-3 h-px bg-white/10" />
      {/* Size and Timing. */}
      <View class={`flex-row items-center gap-1 px-2.5 ${desktop ? "py-1.5" : "py-0.5"}`}>
        <Text class="mr-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Size</Text>
        <Chip label="S" a11y="Small captions" on={size() === "s"} desktop={desktop} onPress={() => setSubtitleSize("s")} />
        <Chip label="M" a11y="Medium captions" on={size() === "m"} desktop={desktop} onPress={() => setSubtitleSize("m")} />
        <Chip label="L" a11y="Large captions" on={size() === "l"} desktop={desktop} onPress={() => setSubtitleSize("l")} />
        <View class="flex-1" />
        <Text class="mr-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Timing</Text>
        <Chip label="− 0.5 s" a11y="Captions earlier" desktop={desktop} onPress={() => nudgeSubtitle(-0.5)} />
        <Text class="min-w-12 text-center text-[13px] font-semibold text-white">
          {offsetLabel(subtitleOffset())}
        </Text>
        <Chip label="+ 0.5 s" a11y="Captions later" desktop={desktop} onPress={() => nudgeSubtitle(0.5)} />
        <If when={Math.abs(subtitleOffset()) >= 0.05}>
          <Chip label="Reset" a11y="Reset caption timing" desktop={desktop} onPress={resetSubtitleOffset} />
        </If>
      </View>
    </View>
  );
}

/** The speed list: SPEEDS with a check on the current one; a pick sets
 * it and closes the list. */
export function SpeedList(props: { desktop?: boolean }) {
  useEscape();
  const desktop = !!props.desktop;
  return (
    <View
      class={`flex-col overflow-hidden rounded-xl p-1 ${
        desktop ? "border border-zinc-800 bg-zinc-900" : "bg-black/85"
      }`}
      style={{ width: desktop ? 112 : 128 }}
    >
      <View class="absolute inset-0" style={{ backgroundColor: "rgba(0,0,0,0.01)" }} onPress={() => {}} />
      <Each of={SPEEDS}>
        {(s) => (
          <Row
            label={rateLabel(s())}
            checked={Math.abs(mediaRate() - s()) < 0.01}
            desktop={desktop}
            onPress={() => {
              setRate(s());
              closePlayerPopups();
            }}
          />
        )}
      </Each>
    </View>
  );
}
