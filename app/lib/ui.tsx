// Small shared UI: cards, rows, badges, buttons. Styling uses the NSH
// theme's Tailwind tokens (bg-background, text-foreground, ...).

import { Scroll, Text, View, type JSX } from "nsh";
import { Image } from "nsh";
import type { Media } from "./tmdb";
import { imgUrl, title as mediaTitle, year } from "./tmdb";

export function Button(props: {
  label: string;
  onPress?: () => void;
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class={
        props.primary
          ? "items-center justify-center rounded-lg bg-primary px-4 py-2 active:opacity-70"
          : "items-center justify-center rounded-lg border border-border px-4 py-2 active:bg-muted"
      }
    >
      <Text
        class={
          props.primary
            ? "font-semibold text-primary-foreground"
            : "font-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </View>
  );
}

/** A poster card for a TMDB media object. */
export function MediaCard(props: { media: Media; width?: number; onPress?: () => void }) {
  const w = props.width ?? 140;
  const m = props.media;
  return (
    <View
      role="button"
      onPress={props.onPress}
      style={{ width: w }}
      class="gap-1 active:opacity-70"
    >
      <Image
        src={imgUrl(m.poster_path, "w342")}
        style={{ width: w, height: w * 1.5, borderRadius: 8 }}
      />
      <Text class="text-xs font-medium text-foreground" style={{ numberOfLines: 1 }}>
        {mediaTitle(m)}
      </Text>
      <Text class="text-[11px] text-muted-foreground">
        {year(m)} {m.vote_average ? `· ${m.vote_average.toFixed(1)}` : ""}
      </Text>
    </View>
  );
}

/** A horizontal scrolling row of cards under a heading. */
export function Row(props: {
  title: string;
  children: JSX.Element;
}) {
  return (
    <View class="gap-2">
      <Text class="px-4 text-lg font-bold text-foreground">{props.title}</Text>
      <Scroll horizontal class="px-4">
        <View class="flex-row gap-3 pb-2">{props.children}</View>
      </Scroll>
    </View>
  );
}

export function Badge(props: { text: string; accent?: boolean }) {
  return (
    <View
      class={
        props.accent
          ? "rounded-md bg-primary px-2 py-0.5"
          : "rounded-md bg-muted px-2 py-0.5"
      }
    >
      <Text
        class={
          props.accent
            ? "text-xs font-semibold text-primary-foreground"
            : "text-xs text-muted-foreground"
        }
      >
        {props.text}
      </Text>
    </View>
  );
}

export function Section(props: { title?: string; children: JSX.Element }) {
  return (
    <View class="gap-3">
      {props.title ? (
        <Text class="text-base font-bold text-foreground">{props.title}</Text>
      ) : null}
      {props.children}
    </View>
  );
}
