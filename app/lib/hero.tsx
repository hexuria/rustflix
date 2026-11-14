// The poster → poster shared element of the desktop: a card's poster flies
// to the title page's poster slot (and back on Back), drawn in one layer
// over the whole window.
//
// The flying view sits at its destination frame and is moved there by a
// native transform: `translate` and `scale` from the top left corner, both
// following one animated progress value (cubic ease-in-out). The image is
// the same URL (one cached texture) as at both ends, drawn with
// `objectFit: cover` in a frame of the same 2:3 aspect, so it is never
// cropped differently; its corner radius is the destination's, scaled with
// the frame, so it starts at the source's (8 pt on a 140 pt card scales to
// 7.8) and lands on the destination's exactly. The pages hand over by the
// caller showing the real poster in the batch that removes this one.
//
// GPUI draws axis-aligned translations and scales exactly (images at their
// mapped bounds, rounded clips scaled with them), and runs the animated
// values on its frame clock: no JS per frame.

import { createAnimatedValue, Easing, Image, signal, View, type AnimatedValue } from "nsh";
import type { HeroRect } from "./router";
import { motionReduced } from "./store";

interface Flight {
  id: number;
  image: string;
  from: HeroRect;
  to: HeroRect;
  /** The destination's corner radius. */
  radius: number;
  p: AnimatedValue;
}

const flight = signal<Flight | null>(null);
let seq = 0;

/** The card a flight leaves from or lands on (its `cardKey`): hidden while
 * the flying poster stands for it, so it never shows twice. */
export const hiddenCard = signal("");

/** How long a flight takes (ms); the debug hook can slow it down. */
export let heroMs = 360;
export function setHeroMs(ms: number) {
  heroMs = Math.max(50, ms);
}

/** The curve of the flight (and of the page fades timed against it). */
export const HERO_EASING = Easing.inOut(Easing.cubic);

/** Flies `image` from `from` to `to` (window points), landing with corner
 * radius `radius`. Resolves when it has landed; `onLand` runs in the same
 * turn that removes the flying view, so the real poster the caller shows
 * there replaces it in one frame. A newer flight ends this one. */
export function flyPoster(
  image: string,
  from: HeroRect,
  to: HeroRect,
  radius: number,
  onLand?: () => void,
  cardKey?: string,
): Promise<void> {
  // Reduce motion (the user's setting or the system's): no flight, the
  // poster just shows in its slot.
  if (motionReduced()) {
    flight.set(null);
    hiddenCard.set("");
    onLand?.();
    return Promise.resolve();
  }
  const id = ++seq;
  const p = createAnimatedValue(0);
  flight.set({ id, image, from, to, radius, p });
  hiddenCard.set(cardKey ?? "");
  return p
    .timing(1, { duration: heroMs, easing: HERO_EASING })
    .then(() => undefined, () => undefined)
    .then(() => {
      onLand?.();
      if (flight()?.id === id) {
        flight.set(null);
        hiddenCard.set("");
      }
    });
}

/** Whether a frame is on the window (a card scrolled away, a tab not shown
 * measure outside it or with no size). */
export function onScreen(r: HeroRect | null | undefined, win: { width: number; height: number }) {
  if (!r || !(r.w > 1 && r.h > 1)) return false;
  return r.x < win.width && r.y < win.height && r.x + r.w > 0 && r.y + r.h > 0;
}

/** The layer the posters fly in: put it last in the window's root, over
 * everything; it never takes the pointer. */
export function HeroLayer() {
  return (
    <If when={flight()}>
      {(f) => (
        <View
          class="pointer-events-none absolute overflow-hidden bg-white/10"
          style={{
            left: f().to.x,
            top: f().to.y,
            width: f().to.w,
            height: f().to.h,
            borderRadius: f().radius,
            transformOrigin: "left top",
            translate: [
              f().p.interpolate({ inputRange: [0, 1], outputRange: [f().from.x - f().to.x, 0] }),
              f().p.interpolate({ inputRange: [0, 1], outputRange: [f().from.y - f().to.y, 0] }),
            ],
            scale: f().p.interpolate({ inputRange: [0, 1], outputRange: [f().from.w / f().to.w, 1] }),
          }}
        >
          <Image
            src={f().image}
            fadeDuration={0}
            style={{ width: f().to.w, height: f().to.h, objectFit: "cover" }}
          />
        </View>
      )}
    </If>
  );
}
