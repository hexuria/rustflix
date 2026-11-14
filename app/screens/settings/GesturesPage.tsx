// Gestures (phones and tablets, in place of Keyboard shortcuts; an iPad
// with a keyboard shows both): the player's touch gestures, each with a
// small drawing. The two-finger triple tap (the FPS monitor) is listed only
// while Diagnostics are unlocked; it works either way.

import { Image, platform, Text, View } from "nsh";
import { icon } from "../PlayerControls";
import { devMode } from "./state";

const ST = `fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"`;
const DOT = (x: number, y: number, r = 2.6) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`;

const GLYPH = {
  tap: `${DOT(12, 12)}<circle cx="12" cy="12" r="6.5" ${ST}/>`,
  doubleTap: `${DOT(8, 12, 2.2)}${DOT(16, 12, 2.2)}<circle cx="8" cy="12" r="5" ${ST}/><circle cx="16" cy="12" r="5" ${ST}/>`,
  hold: `${DOT(12, 12)}<circle cx="12" cy="12" r="5.5" ${ST}/><circle cx="12" cy="12" r="9" ${ST} stroke-opacity="0.5"/>`,
  slide: `<path d="M12 4v16M12 4 8.5 7.5M12 4l3.5 3.5M12 20l-3.5-3.5M12 20l3.5-3.5" ${ST}/>`,
  pinch: `<path d="M4 4l5.5 5.5M9.5 9.5V5.5M9.5 9.5H5.5M20 20l-5.5-5.5M14.5 14.5v4M14.5 14.5h4" ${ST}/>`,
  twoFinger: `${DOT(9, 12, 2.2)}${DOT(15, 12, 2.2)}<path d="M5 18.5h14" ${ST}/><path d="M7 21h2M11 21h2M15 21h2" ${ST}/>`,
  swipe: `<path d="M3.5 4v16" ${ST}/><path d="M8 12h12m0 0-3.5-3.5M20 12l-3.5 3.5" ${ST}/>`,
};

type Gesture = { glyph: keyof typeof GLYPH; what: string; does: string; dev?: boolean };

const GESTURES: Gesture[] = [
  { glyph: "tap", what: "Tap", does: "Show or hide the controls" },
  { glyph: "doubleTap", what: "Double tap, left or right", does: "Back or forward 10 seconds" },
  { glyph: "hold", what: "Hold", does: "Play at 2× while you hold" },
  { glyph: "slide", what: "Slide up or down, left half", does: "Brightness" },
  { glyph: "slide", what: "Slide up or down, right half", does: "Volume" },
  { glyph: "pinch", what: "Pinch", does: "Fill the screen, or fit the video" },
  { glyph: "twoFinger", what: "Two-finger triple tap", does: "FPS monitor", dev: true },
  {
    glyph: "swipe",
    what: platform.os === "android" ? "Back gesture" : "Swipe from the left edge",
    does: "Go back",
  },
];

function GestureRow(props: { g: Gesture }) {
  return (
    <View class="min-h-12 flex-row items-center gap-3 px-4 py-2.5">
      <View class="h-8 w-8 items-center justify-center rounded-lg bg-white/10">
        <Image src={icon(GLYPH[props.g.glyph], 20)} style={{ width: 20, height: 20 }} />
      </View>
      <Text class="flex-1 text-sm font-medium text-foreground">{props.g.what}</Text>
      <Text class="text-sm text-muted-foreground" style={{ textAlign: "right", flexShrink: 1 }}>
        {props.g.does}
      </Text>
    </View>
  );
}

/** The "gestures" custom row: the list. */
export function GesturesList() {
  const list = () => GESTURES.filter((g) => !g.dev || devMode());
  return (
    <View>
      <Each of={list()} key={(g: Gesture) => g.what}>
        {(g, i) => (
          <>
            <If when={i() > 0}>
              <View class="ml-[60px] h-px bg-border" />
            </If>
            <GestureRow g={g()} />
          </>
        )}
      </Each>
    </View>
  );
}
