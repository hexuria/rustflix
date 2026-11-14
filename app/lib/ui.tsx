// Shared UI: cards, rows, skeletons, empty/error states, badges, buttons
// and the card menu. Styling uses the NSH theme's Tailwind tokens
// (bg-background, text-foreground, bg-primary = the red accent, ...).

import {
  cleanup,
  computed,
  context,
  createAnimatedValue,
  Easing,
  Image,
  List,
  platform,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type JSX,
  type ScrollRef,
  type ViewRef,
} from "nsh";
import { AlertDialog } from "nsh/base";
import { isAvailable as hasMenu, Menu } from "nsh/desktop";
import { aniTitle, type AniMedia } from "./anilist";
import { goTitle, navigate, type Route } from "./router";
import { hiddenCard } from "./hero";
import type { MediaType } from "./sources";
import { debug } from "./player";
import { formatBytes } from "./cache";
import {
  canDownload,
  cancelDownload,
  downloadFor,
  enqueueDownload,
  playDownload,
  refreshDownloadSpace,
  removeDownload,
  retryDownload,
  revealDownload,
  type DlEntry,
  type DlTarget,
} from "./downloads";
import { icon, ICONS, Glyph, progressRing, Spinner, type IconName } from "../screens/PlayerControls";
import {
  inWatchlist,
  motionReduced,
  progress,
  removeProgressForTitle,
  settings,
  toggleWatchlist,
  watchlist,
  type Progress,
} from "./store";
import type { Media } from "./tmdb";
import { imgUrl, isMovie, title as mediaTitle, year } from "./tmdb";

const desktop = platform.desktop;

// --- Buttons, chips and badges -------------------------------------------------------
//
// The one place their geometry is decided. Labels are centred by the box,
// never by padding: every control has an explicit height and centres its
// content both ways, and its label is one line with a line height equal to
// its own box (no extra leading above or below the glyphs). Symbols are
// drawn icons (`ICONS` / `UI_ICONS`), never text glyphs such as "▶" or "+",
// whose font metrics differ from the label's and pull it off-centre.

/** Icons only the shared controls use (same 24-unit grid and stroke as
 * `ICONS` in PlayerControls). */
const UI_STROKE = `fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"`;
const UI_ICONS = {
  plus: `<path d="M12 5v14M5 12h14" ${UI_STROKE} stroke-width="2.2"/>`,
  info: `<circle cx="12" cy="12" r="8.5" ${UI_STROKE} stroke-width="1.9"/><path d="M12 11v5.2" ${UI_STROKE} stroke-width="2.1"/><circle cx="12" cy="7.9" r="1.25" fill="#fff"/>`,
  retry: `<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" ${UI_STROKE} stroke-width="2"/><path d="M19.5 4.5v4.2h-4.2" ${UI_STROKE} stroke-width="2"/>`,
} as const;

/** A drawn icon a control can lead with. */
export type ControlIcon = IconName | keyof typeof UI_ICONS;

/** A drawn icon (`ICONS` or `UI_ICONS`), `size` points square. */
export function ControlGlyph(props: { name: ControlIcon; size: number; color?: string }) {
  const body = (UI_ICONS as Record<string, string>)[props.name] ?? ICONS[props.name as IconName];
  return (
    <Image
      src={icon(props.color ? body.split("#fff").join(props.color) : body, props.size)}
      style={{ width: props.size, height: props.size }}
    />
  );
}

export type ButtonSize = "sm" | "md" | "lg";
export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost";

/** Height, label size, icon size and side padding per size. */
const BUTTON_SIZE: Record<ButtonSize, { h: number; font: number; icon: number; px: number }> = {
  sm: { h: 36, font: 14, icon: 16, px: 12 },
  md: { h: 44, font: 15, icon: 18, px: 16 },
  lg: { h: 48, font: 16, icon: 20, px: 16 },
};

/** Every button's corner radius. */
const BUTTON_RADIUS = 10;

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary hover:opacity-90 active:opacity-75",
  secondary: "bg-white/10 hover:bg-white/15 active:bg-white/20",
  outline: "border border-border hover:bg-muted active:bg-muted",
  ghost: "hover:bg-white/10 active:bg-white/15",
};

/**
 * A button: a box of a fixed height (`size`: sm 36, md 44, lg 48 pt) with
 * its icon and label centred as one group. `variant`: primary (the accent
 * fill), secondary (a translucent fill), outline, ghost. `icon` leads with
 * a drawn icon, `leading` with any element of the icon's size (a download
 * ring); `busy` swaps the icon for a spinner without moving the label.
 * `fullWidth` fills its row; `flex` shares a row equally with its siblings.
 * The label is one line: a state that changes it never changes the size.
 * `primary` / `small` are the older spelling of `variant` / `size`.
 */
export function Button(props: {
  label: string;
  onPress?: (e: { pagePosition?: { x: number; y: number } }) => void;
  onLongPress?: () => void;
  onContextMenu?: (e: { pagePosition: { x: number; y: number } }) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ControlIcon;
  leading?: JSX.Element;
  busy?: boolean;
  fullWidth?: boolean;
  flex?: boolean;
  disabled?: boolean;
  /** The spoken label when it says more than `label`. */
  accessibilityLabel?: string;
  primary?: boolean;
  small?: boolean;
}) {
  const variant = (): ButtonVariant => props.variant ?? (props.primary ? "primary" : "secondary");
  const sz = () => BUTTON_SIZE[props.size ?? (props.small ? "sm" : "md")];
  const fg = () => (variant() === "primary" ? "text-primary-foreground" : "text-foreground");
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={props.disabled ? undefined : props.onPress}
      onLongPress={props.disabled ? undefined : props.onLongPress}
      onContextMenu={props.onContextMenu}
      class={`flex-row items-center justify-center gap-2 ${props.disabled ? "opacity-40" : "cursor-pointer"} ${BUTTON_VARIANT[variant()]}`}
      style={{
        height: sz().h,
        minWidth: sz().h,
        paddingLeft: sz().px,
        paddingRight: sz().px,
        borderRadius: BUTTON_RADIUS,
        flexGrow: props.flex ? 1 : 0,
        flexShrink: props.flex ? 1 : 0,
        flexBasis: props.flex ? 0 : "auto",
        alignSelf: props.fullWidth ? "stretch" : undefined,
      }}
    >
      <If when={props.busy}>
        <Spinner size={sz().icon} />
      </If>
      <If when={!props.busy && props.leading}>{props.leading}</If>
      <If when={!props.busy && !props.leading && props.icon}>
        {(name) => (
          <ControlGlyph
            name={name()}
            size={sz().icon}
            color={variant() === "primary" ? undefined : "#fafafa"}
          />
        )}
      </If>
      <Text
        class={`font-semibold ${fg()}`}
        allowFontScaling={false}
        style={{
          fontSize: sz().font,
          lineHeight: Math.round(sz().font * 1.25),
          numberOfLines: 1,
          flexShrink: 1,
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

/**
 * A chip: a pill of a fixed height (sm 32, md 36 pt) with its label
 * centred both ways; `selected` fills it with the accent. Seasons, sub/dub,
 * filters. The label keeps its weight when selected, so the chip never
 * changes width. `dot`: a small state dot (a class like `bg-emerald-500`)
 * in its top right corner.
 */
export function Chip(props: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  onContextMenu?: (e: { pagePosition: { x: number; y: number } }) => void;
  size?: "sm" | "md";
  /** At least this wide (number chips of a grid line up). */
  minWidth?: number;
  dot?: string;
  accessibilityLabel?: string;
}) {
  const h = () => (props.size === "sm" ? 32 : 36);
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ selected: !!props.selected }}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      onContextMenu={props.onContextMenu}
      class={`relative cursor-pointer items-center justify-center rounded-full ${
        props.selected ? "bg-primary active:opacity-80" : "bg-white/10 hover:bg-white/15 active:bg-white/20"
      }`}
      style={{ height: h(), minWidth: props.minWidth ?? h(), paddingLeft: 14, paddingRight: 14 }}
    >
      <Text
        class={`font-semibold ${props.selected ? "text-primary-foreground" : "text-zinc-300"}`}
        allowFontScaling={false}
        style={{ fontSize: 14, lineHeight: 18, numberOfLines: 1, textAlign: "center" }}
      >
        {props.label}
      </Text>
      <If when={props.dot}>
        {(cls) => (
          <View class={`pointer-events-none absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${cls()}`} />
        )}
      </If>
    </View>
  );
}

/** A small label in a fixed-height box (24 pt), its text centred: a title's
 * type, year, rating, status. */
export function Badge(props: { text: string; accent?: boolean; green?: boolean }) {
  return (
    <View
      class={`items-center justify-center rounded-md px-2 ${
        props.accent ? "bg-primary" : props.green ? "bg-emerald-500/20" : "bg-white/10"
      }`}
      style={{ height: 24 }}
    >
      <Text
        class={`font-semibold ${
          props.accent
            ? "text-primary-foreground"
            : props.green
              ? "text-emerald-400"
              : "text-zinc-300"
        }`}
        allowFontScaling={false}
        style={{ fontSize: 12, lineHeight: 16, numberOfLines: 1 }}
      >
        {props.text}
      </Text>
    </View>
  );
}

/** A section heading (18 pt bold) over its content. */
export function Section(props: { title?: string; children: JSX.Element }) {
  return (
    <View class="gap-3">
      {props.title ? (
        <Text class="text-lg font-bold text-foreground" style={{ lineHeight: 24 }}>
          {props.title}
        </Text>
      ) : null}
      {props.children}
    </View>
  );
}

// --- Playback and the card menu ----------------------------------------------------

/** What a card stands for: enough to play it, list it and open it. */
export interface CardTarget {
  type: MediaType;
  /** TMDB id for movie/tv, AniList id for anime. */
  id: number;
  title: string;
  poster: string;
  year?: string;
  /** Set on Continue Watching cards: the progress entry the card shows. */
  progress?: Progress;
  /** The backdrop at the title page header's size ("" when the title has
   * none; unset when the list did not say). */
  backdrop?: string;
}

export function mediaTarget(m: Media, type?: "movie" | "tv"): CardTarget {
  return {
    type: type ?? (isMovie(m) ? "movie" : "tv"),
    id: m.id,
    title: mediaTitle(m),
    poster: imgUrl(m.poster_path, "w342"),
    year: year(m) || undefined,
    backdrop: m.backdrop_path === undefined ? undefined : imgUrl(m.backdrop_path, "w1280"),
  };
}

export function animeTarget(m: AniMedia): CardTarget {
  return {
    type: "anime",
    id: m.id,
    title: aniTitle(m),
    poster: m.coverImage.large,
    year: m.seasonYear ? String(m.seasonYear) : undefined,
    backdrop: animeBackdrop(m),
  };
}

/** An anime's header image on its title page: the banner, else the large
 * cover (the same choice the page makes from its details). */
export function animeBackdrop(m: AniMedia): string {
  return m.bannerImage || m.coverImage.extraLarge || "";
}

/** "S2E5" for a show, "E5" for anime (no seasons), "" for a movie. */
export function episodeLabel(p: { type: MediaType; season?: number; episode?: number }): string {
  if (p.type === "tv") return `S${p.season ?? 1}E${p.episode ?? 1}`;
  if (p.type === "anime") return `E${p.episode ?? 1}`;
  return "";
}

/** The player route that resumes a progress entry (sub/dub kept). */
export function resumeRoute(p: Progress): Route {
  // `lang` is only there once the player saves it with the progress.
  const lang = (p as Progress & { lang?: "sub" | "dub" }).lang;
  return {
    name: "player",
    type: p.type,
    id: p.id,
    season: p.type === "tv" ? p.season : undefined,
    episode: p.episode,
    title: p.title,
    poster: p.poster,
    lang: p.type === "anime" ? lang : undefined,
  };
}

/** Started and not finished: the same test as the store's
 * `continueWatching()`. */
function unfinished(p: Progress): boolean {
  return p.duration > 0 && p.position > 30 && p.position < p.duration * 0.95;
}

/** The progress entry Play would resume for a title, if any: the card's
 * own, else the title's most recent unfinished one. */
export function resumable(t: CardTarget): Progress | undefined {
  return (
    t.progress ??
    progress().find((x) => x.type === t.type && x.id === t.id && unfinished(x))
  );
}

/** Plays a title: resumes its latest unfinished progress, else starts it
 * from the beginning (episode 1 of season 1 for a show, episode 1 for
 * anime). */
export function playTarget(t: CardTarget) {
  const p = resumable(t);
  if (p) {
    navigate(resumeRoute(p));
    return;
  }
  navigate({
    name: "player",
    type: t.type,
    id: t.id,
    season: t.type === "tv" ? 1 : undefined,
    episode: t.type === "movie" ? undefined : 1,
    lang: t.type === "anime" ? "sub" : undefined,
    title: t.title,
    poster: t.poster,
  });
}

/** Long press (phone) / right click (desktop) on a card: Play, My List,
 * Details and, on Continue Watching cards, Remove from Continue Watching.
 * A context menu where desktop menus exist, an action sheet elsewhere. */
export async function openCardMenu(t: CardTarget, at?: { x: number; y: number }) {
  const listed = inWatchlist(t.type, t.id);
  const resume = resumable(t);
  const actions: { id: string; label: string; destructive?: boolean }[] = [
    { id: "play", label: resume ? `Resume ${episodeLabel(resume)}`.trim() : "Play" },
    { id: "list", label: listed ? "Remove from My List" : "Add to My List" },
    { id: "details", label: "Details" },
  ];
  if (t.progress) {
    actions.push({ id: "forget", label: "Remove from Continue Watching", destructive: true });
  }
  const run = (id: string | null | undefined) => {
    if (id === "play") playTarget(t);
    else if (id === "details") {
      if (t.backdrop) prefetchImages([t.backdrop]);
      goTitle(t.type, t.id, { image: t.poster || undefined, backdrop: t.backdrop, title: t.title });
    }
    else if (id === "list") {
      void toggleWatchlist({
        type: t.type,
        id: t.id,
        title: t.title,
        poster: t.poster,
        year: t.year,
      });
    } else if (id === "forget") void removeProgressForTitle(t.type, t.id);
  };
  if (hasMenu) {
    await Menu.popup(
      actions.flatMap((a, i) => [
        i === 3 ? ({ type: "separator" } as const) : null,
        { label: a.label, onSelect: () => run(a.id) },
      ]),
      at,
    );
    return;
  }
  try {
    const { action } = await AlertDialog.show({
      title: t.title,
      presentation: "actionSheet",
      actions: [
        ...actions.map((a) => ({
          id: a.id,
          label: a.label,
          role: a.destructive ? ("destructive" as const) : ("default" as const),
        })),
        { id: "cancel", label: "Cancel", role: "cancel" as const },
      ],
    });
    run(action);
  } catch (e) {
    console.warn("card menu failed", e);
    debug("ui: card menu failed", String(e));
  }
}

/** The press, long-press and right-click props every card shares. */
function cardPress(
  target: () => CardTarget,
  onPress?: () => void,
  art?: () => { view?: ViewRef; image: string; key?: string },
) {
  return {
    onPress: onPress ?? (() => openTitleFrom(target(), art?.())),
    onLongPress: desktop ? undefined : () => void openCardMenu(target()),
    onContextMenu: (e: { pagePosition: { x: number; y: number } }) =>
      void openCardMenu(target(), e.pagePosition),
  };
}

/** Each poster card's key for `hiddenCard`. */
let cardSeq = 0;

/** Opens a card's title page. The card's poster and the title's backdrop
 * (both at the sizes the page shows them, the URLs its details resolve
 * to) go along, and the backdrop starts loading now. On the desktop the
 * poster's frame goes too (measured now, one layout away): the poster
 * flies from it into the page's poster slot, and back on Back. */
function openTitleFrom(t: CardTarget, art?: { view?: ViewRef; image: string; key?: string }) {
  const image = art?.image || t.poster || undefined;
  const title = t.title;
  const backdrop = t.backdrop;
  if (backdrop) prefetchImages([backdrop]);
  if (!desktop || !art?.view) {
    goTitle(t.type, t.id, { image, backdrop, title });
    return;
  }
  const source = art.view;
  source
    .measure()
    .then((m) => {
      const from =
        m && m.bounds.size.width > 0
          ? {
              x: m.pagePosition.x,
              y: m.pagePosition.y,
              w: m.bounds.size.width,
              h: m.bounds.size.height,
            }
          : undefined;
      goTitle(t.type, t.id, { image, backdrop, title, from, source, sourceKey: art.key });
    })
    .catch(() => goTitle(t.type, t.id, { image, backdrop, title }));
}

// The poster frame: a primary ring under the pointer and on keyboard
// focus (desktop), from the card's `group` state.
const RING = desktop
  ? "group-hover:ring-2 group-hover:ring-primary group-focus-visible:ring-2 group-focus-visible:ring-ring"
  : "";

// --- Cards -------------------------------------------------------------------------

/** How long a loaded poster fades in over its frame's bg-muted placeholder.
 * None on the desktop: GPUI has no translucent sprites, so NSH's GPUI
 * backend fades an image by making up to 16 pre-multiplied copies of it on
 * worker threads and uploading each as a new atlas texture
 * (nsh-platform-gpui image.rs, `ALPHA_STEPS`), and redraws the window on
 * every frame of the fade: a row of posters arriving together is a burst
 * of texture uploads and full frames. Phones fade on the compositor. */
const fade = () => (desktop || motionReduced() ? 0 : 200);

const prefetched = new Set<string>();

/** Starts loading images ahead of showing them (`Image.prefetch`), each URL
 * once; failures are ignored. */
export function prefetchImages(urls: string[]) {
  for (const url of urls) {
    if (!url || prefetched.has(url)) continue;
    prefetched.add(url);
    try {
      void Image.prefetch(url).catch(() => {});
    } catch {}
  }
}

/** The first screenful of a Row's cards prefetch their images as soon as
 * the row's data arrives: a Row provides a counter, each card takes one. */
const ROW_PREFETCH_MAX = 8;
const RowPrefetch = context<{ n: number } | null>(null);

function prefetchInRow(url: string) {
  const slot = RowPrefetch();
  if (slot && slot.n < ROW_PREFETCH_MAX) {
    slot.n++;
    prefetchImages([url]);
  }
}

/** A tall poster card (140x210 by default) with a title and a subtitle. */
/** A poster grid for a width: three across on a phone, with the cards as
 * wide as fit, more as the screen widens. Every column is full: no strip
 * of unused width beside the last card. */
export function posterGrid(width: number): { cols: number; cardW: number; gap: number } {
  const phone = width < 520;
  const gap = phone ? 12 : 16;
  const min = phone ? 96 : 150;
  const cols = Math.max(phone ? 3 : 2, Math.floor((width + gap) / (min + gap)));
  return { cols, cardW: Math.max(60, Math.floor((width - (cols - 1) * gap) / cols)), gap };
}

export function PosterCard(props: {
  target: CardTarget;
  image: string;
  subtitle?: string;
  /** A small accent label over the poster's corner ("ANIME"). */
  badge?: string;
  width?: number;
  onPress?: () => void;
}) {
  // Read where used: a grid resizes its cards when the screen turns.
  const w = () => props.width ?? 140;
  // The artwork's view: its frame is where the title page zooms out of.
  let art: ViewRef | undefined;
  const cardKey = `card${++cardSeq}`;
  const press = cardPress(() => props.target, props.onPress, () => ({
    view: art,
    image: props.image,
    key: cardKey,
  }));
  prefetchInRow(props.image);
  return (
    <View
      role="button"
      accessibilityLabel={props.target.title}
      onPress={press.onPress}
      onLongPress={press.onLongPress}
      onContextMenu={press.onContextMenu}
      style={{ width: w() }}
      class="group cursor-pointer gap-1 active:opacity-70"
    >
      <View
        ref={(n: ViewRef) => (art = n)}
        class={`relative rounded-lg bg-muted ${RING}`}
        // Hidden while a poster flight stands for it (lib/hero.tsx).
        style={{ width: w(), height: w() * 1.5, opacity: hiddenCard() === cardKey ? 0 : 1 }}
      >
        <Image
          src={props.image}
          fadeDuration={fade()}
          style={{ width: w(), height: w() * 1.5, borderRadius: 8 }}
        />
        <If when={props.badge}>
          {(b) => (
            <View class="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5">
              <Text class="text-[10px] font-bold text-primary-foreground">{b()}</Text>
            </View>
          )}
        </If>
      </View>
      <Text class="text-xs font-medium text-foreground" style={{ numberOfLines: 1 }}>
        {props.target.title}
      </Text>
      <Text class="text-[11px] text-muted-foreground" style={{ numberOfLines: 1 }}>
        {props.subtitle ?? ""}
      </Text>
    </View>
  );
}

/** A poster card for a TMDB media object. */
export function MediaCard(props: {
  media: Media;
  /** Forces the kind (rows of one kind come without `media_type`). */
  type?: "movie" | "tv";
  width?: number;
  onPress?: () => void;
}) {
  // Read where used: in a virtualized row the cell is reused for another
  // item, and `props.media` follows it.
  const m = () => props.media;
  return (
    <PosterCard
      target={mediaTarget(m(), props.type)}
      image={imgUrl(m().poster_path, "w342")}
      subtitle={`${year(m())} ${m().vote_average ? `· ${m().vote_average!.toFixed(1)}` : ""}`.trim()}
      width={props.width}
      onPress={props.onPress}
    />
  );
}

/** A poster card for an AniList anime; opens its title page. */
export function AnimeCard(props: { anime: AniMedia; badge?: boolean; width?: number }) {
  const m = () => props.anime;
  return (
    <PosterCard
      target={animeTarget(m())}
      image={m().coverImage.large}
      subtitle={m().seasonYear ? String(m().seasonYear) : ""}
      badge={props.badge ? "ANIME" : undefined}
      width={props.width}
    />
  );
}

function fmtLeft(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}

/** A wide Continue Watching card: the image with a red progress bar, the
 * title and the episode label; a press resumes it in the player. */
export function ProgressCard(props: { progress: Progress; width?: number }) {
  const w = props.width ?? 240;
  const h = Math.round((w * 9) / 16);
  const p = computed(() => props.progress);
  const target = () => ({
    type: p().type,
    id: p().id,
    title: p().title,
    poster: p().poster,
    progress: p(),
  });
  const press = cardPress(target, () => navigate(resumeRoute(p())));
  prefetchInRow(p().poster);
  const pct = computed(() => Math.min(100, (p().position / Math.max(1, p().duration)) * 100));
  const sub = computed(() => {
    const ep = episodeLabel(p());
    const left = fmtLeft(p().duration - p().position);
    return ep ? `${ep} · ${left}` : left;
  });
  return (
    <View
      role="button"
      accessibilityLabel={`Resume ${p().title}`}
      onPress={press.onPress}
      onLongPress={press.onLongPress}
      onContextMenu={press.onContextMenu}
      style={{ width: w }}
      class="group cursor-pointer gap-1 active:opacity-70"
    >
      <View class={`relative rounded-lg bg-muted ${RING}`} style={{ width: w, height: h }}>
        <Image
          src={p().poster}
          fadeDuration={fade()}
          style={{ width: w, height: h, borderRadius: 8 }}
        />
        <View class="absolute inset-0 items-center justify-center">
          <View class="h-10 w-10 items-center justify-center rounded-full bg-background/60">
            <Text class="text-base text-foreground">▶</Text>
          </View>
        </View>
        <View class="absolute bottom-0 left-0 right-0 h-1 bg-background/70">
          <View class="h-1 bg-primary" style={{ width: `${pct()}%` }} />
        </View>
      </View>
      <Text class="text-xs font-medium text-foreground" style={{ numberOfLines: 1 }}>
        {/* Older builds saved "Untitled" when the name was not known yet:
            nothing rather than a placeholder (the next save repairs it). */}
        {p().title === "Untitled" ? "" : p().title}
      </Text>
      <Text class="text-[11px] text-muted-foreground" style={{ numberOfLines: 1 }}>
        {sub()}
      </Text>
    </View>
  );
}

// --- Skeletons ---------------------------------------------------------------------

// One shimmer drives every skeleton on screen, so they move in step. It
// runs while at least one skeleton is mounted.
const shimmer = createAnimatedValue(0);
let shimmerUsers = 0;

function startShimmer() {
  shimmer.set(0);
  void shimmer.keyframes([0, 1], {
    duration: 1400,
    easing: Easing.linear,
    iterations: "infinite",
  });
}

// With reduce motion on, skeletons drop the highlight (read reactively in
// Skeleton) and the sweep is not started.
function useShimmer() {
  if (shimmerUsers++ === 0 && !untracked(motionReduced)) startShimmer();
  cleanup(() => {
    if (--shimmerUsers === 0) void shimmer.stop();
  });
}

/** A grey placeholder block with a highlight sweeping across it. */
export function Skeleton(props: { width: number | string; height: number; radius?: number }) {
  useShimmer();
  const band = typeof props.width === "number" ? Math.max(60, props.width * 0.6) : 160;
  const travel = typeof props.width === "number" ? props.width : 600;
  return (
    <View
      class="overflow-hidden bg-muted"
      style={{ width: props.width, height: props.height, borderRadius: props.radius ?? 8 }}
    >
      <If when={!motionReduced()}>
        <View
          class="absolute bottom-0 top-0 bg-linear-to-r from-transparent via-foreground/10 to-transparent"
          style={{
            left: 0,
            width: band,
            translate: [shimmer.interpolate({ inputRange: [0, 1], outputRange: [-band, travel] }), 0],
          }}
        />
      </If>
    </View>
  );
}

/** A loading card: a poster block over two text lines. */
export function SkeletonCard(props: { width?: number; height?: number }) {
  const w = props.width ?? 140;
  const h = props.height ?? w * 1.5;
  return (
    <View class="gap-1.5" style={{ width: w }}>
      <Skeleton width={w} height={h} />
      <Skeleton width={w * 0.8} height={10} radius={4} />
      <Skeleton width={w * 0.45} height={8} radius={4} />
    </View>
  );
}

/** A row's worth of loading cards. */
export function SkeletonCards(props: { count?: number; width?: number; height?: number }) {
  const n = Array.from({ length: props.count ?? 7 }, (_, i) => i);
  return (
    <Each of={n} key="index">
      {() => <SkeletonCard width={props.width} height={props.height} />}
    </Each>
  );
}

// --- Empty and error states ----------------------------------------------------------

/** A row that failed to load: what happened and a Retry button. */
export function RowError(props: { message?: string; onRetry: () => void }) {
  return (
    <View class="flex-row items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <View class="flex-1 gap-0.5">
        <Text class="text-sm font-semibold text-foreground">This row did not load</Text>
        <If when={props.message}>
          {(m) => (
            <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 2 }}>
              {m()}
            </Text>
          )}
        </If>
      </View>
      <Button label="Retry" small onPress={props.onRetry} />
    </View>
  );
}

/** A centered message for an empty screen or section, with an optional
 * action. */
export function EmptyState(props: {
  title: string;
  body?: string;
  /** A large glyph above the title. */
  icon?: string;
  /** A drawn icon above the title (instead of `icon`). */
  glyph?: IconName;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View class="items-center gap-2 px-6 py-12">
      <If when={props.glyph}>
        {(g) => <Glyph d={g()} size={44} color="#a1a1aa" />}
      </If>
      <If when={!props.glyph && props.icon}>
        {(i) => <Text class="text-4xl text-muted-foreground">{i()}</Text>}
      </If>
      <Text class="text-center text-base font-bold text-foreground">{props.title}</Text>
      <If when={props.body}>
        {(b) => (
          <Text class="text-center text-sm text-muted-foreground" style={{ maxWidth: 420 }}>
            {b()}
          </Text>
        )}
      </If>
      <If when={props.actionLabel && props.onAction}>
        <View class="mt-2">
          <Button primary label={props.actionLabel ?? ""} onPress={() => props.onAction?.()} />
        </View>
      </If>
    </View>
  );
}

// --- Rows ----------------------------------------------------------------------------

/** The Scroll's horizontal padding (`px-4`), in points. */
const ROW_PAD = 16;

function RowArrow(props: { side: "left" | "right"; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.side === "left" ? "Scroll left" : "Scroll right"}
      onPress={props.onPress}
      class={`absolute bottom-2 top-1 w-10 cursor-pointer items-center justify-center bg-background/70 hover:bg-background/90 ${
        props.side === "left" ? "left-0 rounded-r-lg" : "right-0 rounded-l-lg"
      }`}
    >
      <Text class="text-3xl font-bold text-foreground">{props.side === "left" ? "‹" : "›"}</Text>
    </View>
  );
}

/** The rows on screen, in the order they were made (the perf scenario
 * scrolls them sideways: `scrollRowTo`). */
const rowScrolls: { scrollTo(x: number): void }[] = [];

function registerRow(scrollTo: (x: number) => void) {
  const handle = { scrollTo };
  rowScrolls.push(handle);
  cleanup(() => {
    const i = rowScrolls.indexOf(handle);
    if (i >= 0) rowScrolls.splice(i, 1);
  });
}

/** Scrolls row `index` (in the order rows were made) to `x`, animated. */
export function scrollRowTo(index: number, x: number) {
  rowScrolls[index]?.scrollTo(x);
}

/** A horizontal scrolling row of cards under a heading. On the desktop,
 * arrow buttons at each end page it sideways. */
export function Row(props: {
  title: string;
  children: JSX.Element;
}) {
  let ref: ScrollRef | undefined;
  registerRow((to) => ref?.scrollTo({ x: to, animated: true }));
  const x = signal(0);
  // The arrows exist only while the pointer is over the row: an invisible
  // arrow would still take the clicks meant for the cards under it.
  const hovered = signal(false);
  const viewW = signal(0);
  const contentW = signal(0);
  const maxX = computed(() => Math.max(0, contentW() - viewW()));
  const page = (dir: 1 | -1) => {
    const w = viewW() || 600;
    const to = Math.min(maxX(), Math.max(0, x() + dir * w * 0.85));
    x.set(to);
    ref?.scrollTo({ x: to, animated: true });
  };
  return (
    <View class="gap-2">
      <Text class="px-4 text-lg font-bold text-foreground">{props.title}</Text>
      <View
        class="relative"
        onMouseEnter={() => hovered.set(true)}
        onMouseLeave={() => hovered.set(false)}
      >
        <Scroll
          ref={(n: ScrollRef) => (ref = n)}
          horizontal
          class="px-4"
          // onScroll carries only `offset`: the sizes come from layout.
          // Only the desktop's arrows need it: elsewhere a sideways swipe
          // calls no JS at all.
          onLayout={(e) => viewW.set(e.bounds.size.width)}
          onScroll={desktop ? (e) => x.set(e.offset.x) : undefined}
          scrollEventThrottle={desktop ? 50 : undefined}
        >
          <View
            class="flex-row gap-3 pb-2 pt-1"
            // The scrollable width: the cards plus the Scroll's own px-4
            // on both sides.
            onLayout={(e) => contentW.set(e.bounds.size.width + 2 * ROW_PAD)}
          >
            <RowPrefetch.Provider value={{ n: 0 }}>{props.children}</RowPrefetch.Provider>
          </View>
        </Scroll>
        <If when={desktop && hovered() && x() > 4}>
          <RowArrow side="left" onPress={() => page(-1)} />
        </If>
        <If when={desktop && hovered() && maxX() - x() > 4}>
          <RowArrow side="right" onPress={() => page(1)} />
        </If>
      </View>
    </View>
  );
}

/** The gap between a ListRow's cards (`gap-3`). */
const LIST_GAP = 12;

/**
 * Row with a virtualized, recycling list (`<List horizontal>`): only the
 * cards near its viewport exist (NSH binds the visible ones at once and
 * the overscan, one viewport each side, over the next turns), and a card
 * scrolled far away is reused for another item. Looks and pages like
 * `Row`. Every card is `itemWidth` wide; the row is as tall as its tallest
 * card, measured (`itemHeight` until then). Cards must read their item
 * where they use it (`item()` in bindings), not copy it once.
 */
export function ListRow<T>(props: {
  title: string;
  items: readonly T[];
  itemWidth: number;
  itemHeight: number;
  children: (item: () => T) => JSX.Element;
}) {
  let ref: ScrollRef | undefined;
  registerRow((to) => ref?.scrollTo({ x: to, animated: true }));
  const x = signal(0);
  const hovered = signal(false);
  const viewW = signal(0);
  const cardH = signal(props.itemHeight);
  const contentW = computed(() => {
    const n = props.items.length;
    return n > 0 ? n * props.itemWidth + (n - 1) * LIST_GAP + 2 * ROW_PAD : 0;
  });
  const maxX = computed(() => Math.max(0, contentW() - viewW()));
  const page = (dir: 1 | -1) => {
    const w = viewW() || 600;
    const to = Math.min(maxX(), Math.max(0, x() + dir * w * 0.85));
    x.set(to);
    ref?.scrollTo({ x: to, animated: true });
  };
  // The first card measured sets the height (the estimate goes); a taller
  // one later raises it. Cards of a row are alike, so it settles at once.
  let measuredOnce = false;
  const measured = (h: number) => {
    if (!(h > 0)) return;
    if (!measuredOnce) {
      measuredOnce = true;
      if (Math.abs(h - untracked(cardH)) > 0.5) cardH.set(Math.ceil(h));
    } else if (h > untracked(cardH) + 0.5) cardH.set(Math.ceil(h));
  };
  return (
    <View class="gap-2">
      <Text class="px-4 text-lg font-bold text-foreground">{props.title}</Text>
      <View
        class="relative"
        onMouseEnter={desktop ? () => hovered.set(true) : undefined}
        onMouseLeave={desktop ? () => hovered.set(false) : undefined}
      >
        <List
          ref={(n: ScrollRef) => (ref = n)}
          horizontal
          each={props.items}
          estimatedItemSize={props.itemWidth + LIST_GAP}
          contentStyle={{ paddingHorizontal: ROW_PAD, paddingTop: 4, paddingBottom: 8, gap: LIST_GAP }}
          style={{ height: cardH() + 12 }}
          onLayout={(e: { bounds: { size: { width: number } } }) => viewW.set(e.bounds.size.width)}
          onScroll={desktop ? (e: { offset: { x: number } }) => x.set(e.offset.x) : undefined}
          scrollEventThrottle={desktop ? 50 : undefined}
        >
          {(item: () => T) => (
            <View
              style={{ alignSelf: "flex-start" }}
              onLayout={(e: { bounds: { size: { height: number } } }) => measured(e.bounds.size.height)}
            >
              {props.children(item)}
            </View>
          )}
        </List>
        <If when={desktop && hovered() && x() > 4}>
          <RowArrow side="left" onPress={() => page(-1)} />
        </If>
        <If when={desktop && hovered() && maxX() - x() > 4}>
          <RowArrow side="right" onPress={() => page(1)} />
        </If>
      </View>
    </View>
  );
}

// --- Downloads: the shared control, its menu and the delete confirmation -----------
//
// One control shows a title's/episode's download everywhere (episode
// picker, title page, player, Downloads page). Entries are always looked up
// again at press time: on iPhone an entry's `dlId` changes once right after
// it is created, so no handler keeps one.

const MAC = platform.os === "macos";

const GREEN = "#22c55e";
const AMBER = "#f59e0b";
const MUTED = "#a1a1aa";

// Artwork for entries saved without any (queued without it, or from before
// the queue engine): a poster already known on this device for the same
// title, resolved at render time — never written back into the engine.

/** Posters the title page loaded this session (`type:id` → URL). */
const seenPosters = signal<Record<string, string>>({});

/** The title page reports its poster once its details are in. */
export function rememberPoster(type: MediaType, id: number, url: string | null | undefined) {
  if (!url) return;
  const k = `${type}:${id}`;
  const cur = untracked(seenPosters);
  if (cur[k] === url) return;
  seenPosters.set({ ...cur, [k]: url });
}

/** Every known poster by `type:id`: the title page's, then My List's, then
 * watch progress's (memoised; rebuilt only when one of them changes). */
const knownPosters = computed<Record<string, string>>(() => {
  const m: Record<string, string> = { ...seenPosters() };
  for (const w of watchlist()) {
    const k = `${w.type}:${w.id}`;
    if (w.poster && !m[k]) m[k] = w.poster;
  }
  for (const p of progress()) {
    const k = `${p.type}:${p.id}`;
    if (p.poster && !m[k]) m[k] = p.poster;
  }
  return m;
});

/** A poster for a title from data already on this device, if any. */
export function knownPoster(type: MediaType, id: number): string | undefined {
  return knownPosters()[`${type}:${id}`];
}

/** A download's thumbnail: its still, else its poster, else a known poster
 * of its title, else (also when the image fails to load) a neutral block
 * with a drawn film mark — never an empty box. 16:9 for a still, 2:3
 * otherwise, `height` points tall (default 60). */
export function DownloadThumb(props: {
  still?: string;
  poster?: string;
  type: MediaType;
  id: number;
  height?: number;
}) {
  const failed = signal<string | null>(null);
  const src = computed(() => {
    const s = props.still || props.poster || knownPoster(props.type, props.id) || "";
    return s && s !== failed() ? s : "";
  });
  const h = props.height ?? 60;
  const w = computed(() => (props.still && src() === props.still ? Math.round((h * 16) / 9) : Math.round((h * 2) / 3)));
  return (
    <View
      class="items-center justify-center overflow-hidden rounded-md bg-muted"
      style={{ width: w(), height: h }}
    >
      <If
        when={src()}
        else={<Glyph d="film" size={Math.round(Math.min(w(), h) * 0.5)} color="#71717a" />}
      >
        {(s) => (
          <Image
            src={s()}
            style={{ width: w(), height: h }}
            onError={() => failed.set(s())}
          />
        )}
      </If>
    </View>
  );
}

/** The entry for a target right now (not tracked). */
function liveEntry(t: DlTarget): DlEntry | null {
  return untracked(() => downloadFor(t.type, t.id, t.season, t.episode));
}

function targetKey(t: DlTarget): string {
  return `${t.type}:${t.id}:${t.season ?? 0}:${t.episode ?? 0}`;
}

/** "Show · 4. Episode name", "Show · E4" or the movie title. */
export function downloadLabel(e: DlTarget): string {
  if (e.type === "movie") return e.title;
  const n = e.episode ?? 1;
  const ep = e.episodeName
    ? `${n}. ${e.episodeName}`
    : e.type === "tv"
      ? `S${e.season ?? 1} E${n}`
      : `E${n}${e.lang === "dub" ? " (dub)" : ""}`;
  return `${e.title} · ${ep}`;
}

/** The player route that plays an entry's episode (streams when it is not
 * downloaded: a needsPlay entry starts downloading once it plays). */
export function downloadRoute(e: DlTarget): Route {
  return {
    name: "player",
    type: e.type,
    id: e.id,
    season: e.type === "tv" ? (e.season ?? 1) : undefined,
    episode: e.type === "movie" ? undefined : (e.episode ?? 1),
    lang: e.type === "anime" ? (e.lang ?? "sub") : undefined,
    title: e.title,
    poster: e.poster,
  };
}

/** Plays an entry: the local copy when it is done, else the stream. */
export function playDownloadOf(t: DlTarget) {
  const e = liveEntry(t);
  if (e?.state === "done") playDownload(e.dlId);
  else navigate(downloadRoute(e ?? t));
}

/** Why a download failed, in plain words. */
export function downloadReason(e: DlEntry): string {
  switch (e.reason) {
    case "cancelled":
      return "You cancelled it.";
    case "expired":
      return "The video link expired before it finished.";
    case "space":
      return "There is not enough free space.";
    case "drm":
      return "This video is protected and can't be saved.";
    case "nolink":
      return e.message || "No video link could be found.";
    default:
      return e.message || "The download failed.";
  }
}

/** A running/resolving/queued entry's state in plain words. */
export function downloadStatus(e: DlEntry): string {
  if (e.waiting === "wifi") return "Waiting for Wi-Fi";
  if (e.waiting === "network") return "Waiting for a connection";
  if (e.state === "queued") return e.message || "Waiting";
  if (e.state === "resolving") return e.message || "Getting the link…";
  if (e.state === "running") {
    if (e.progress != null) {
      const pct = `${Math.round(e.progress)}%`;
      return e.bytes ? `${pct} · ${formatBytes(e.bytes)}` : pct;
    }
    return e.message || "Downloading…";
  }
  if (e.state === "needsPlay") return "Play once to download";
  if (e.state === "error") return downloadReason(e);
  return e.bytes ? formatBytes(e.bytes) : "Downloaded";
}

type Action = { id: string; label: string; destructive?: boolean };

let choosing = false;

/** A menu of actions: a popup menu at `at` (or the pointer) on the
 * desktop, an action sheet on phones; `onPick` runs with the chosen id.
 * One at a time (a second press while one is open does nothing). */
export async function chooseAction(
  title: string,
  actions: Action[],
  onPick: (id: string) => void,
  at?: { x: number; y: number },
): Promise<void> {
  if (choosing || actions.length === 0) return;
  choosing = true;
  try {
    if (hasMenu) {
      const firstDestructive = actions.findIndex((a) => a.destructive);
      await Menu.popup(
        actions.flatMap((a, i) => [
          i > 0 && i === firstDestructive ? ({ type: "separator" } as const) : null,
          { label: a.label, onSelect: () => onPick(a.id) },
        ]),
        at,
      );
      return;
    }
    const { action } = await AlertDialog.show({
      title,
      presentation: "actionSheet",
      actions: [
        ...actions.map((a) => ({
          id: a.id,
          label: a.label,
          role: a.destructive ? ("destructive" as const) : ("default" as const),
        })),
        { id: "cancel", label: "Cancel", role: "cancel" as const },
      ],
    });
    if (action && action !== "cancel") onPick(action);
  } catch (e) {
    debug("ui: action menu failed", String(e));
  } finally {
    choosing = false;
  }
}

const removing = new Set<string>();

/** Asks first (Settings → Downloads "Ask before deleting a download",
 * on by default), then deletes the download (its files: to the Trash on a
 * Mac) or drops a not-finished one from the list. */
export async function confirmRemoveDownload(t: DlTarget): Promise<void> {
  const k = targetKey(t);
  const e = liveEntry(t);
  if (!e || removing.has(k)) return;
  removing.add(k);
  try {
    if (settings().confirmDeleteDownload === false) {
      await removeDownload(e.dlId);
      void refreshDownloadSpace();
      return;
    }
    const done = e.state === "done";
    const where = MAC
      ? "The file moves to the Trash."
      : desktop
        ? "The file is deleted from this computer."
        : "It is removed from this device.";
    const { action } = await AlertDialog.show({
      title: done ? "Delete this download?" : "Remove from downloads?",
      description: done
        ? `${downloadLabel(e)}. ${where}`
        : `${downloadLabel(e)}. It stops and leaves the list.`,
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "delete", label: done ? "Delete" : "Remove", role: "destructive" },
      ],
    });
    if (action !== "delete") return;
    const cur = liveEntry(t);
    if (cur) await removeDownload(cur.dlId);
    void refreshDownloadSpace();
  } catch (err) {
    debug("ui: delete download failed", String(err));
  } finally {
    removing.delete(k);
  }
}

/** Optional overrides of the shared actions. */
export interface DownloadHooks {
  /** Instead of `enqueueDownload` for a title with no download (the
   * player: `downloadCurrent()`). */
  onDownload?: () => void;
  /** Instead of the default play (a done entry: its local copy; a
   * needsPlay one: the player). */
  onPlay?: (e: DlEntry) => void;
}

/** What a download's menu offers in its state. */
function downloadActions(e: DlEntry | null): Action[] {
  if (!e) return [{ id: "download", label: "Download" }];
  const remove: Action = { id: "delete", label: "Remove from downloads", destructive: true };
  switch (e.state) {
    case "done": {
      const list: Action[] = [{ id: "play", label: "Play" }];
      if (desktop && e.dir) list.push({ id: "reveal", label: MAC ? "Show in Finder" : "Show in folder" });
      list.push({ id: "delete", label: "Delete download", destructive: true });
      return list;
    }
    case "needsPlay":
      return [{ id: "play", label: "Play to start the download" }, remove];
    case "error":
      return [{ id: "retry", label: "Retry download" }, remove];
    default:
      return [{ id: "cancel", label: "Cancel download" }, remove];
  }
}

function runDownloadAction(id: string, t: DlTarget, hooks?: DownloadHooks) {
  const e = liveEntry(t);
  if (id === "download") {
    if (hooks?.onDownload) hooks.onDownload();
    else enqueueDownload(t);
  } else if (id === "play") {
    if (e && hooks?.onPlay) hooks.onPlay(e);
    else playDownloadOf(t);
  } else if (id === "reveal") {
    if (e) revealDownload(e.dlId);
  } else if (id === "retry") {
    if (e) retryDownload(e.dlId);
  } else if (id === "cancel") {
    if (e) cancelDownload(e.dlId);
  } else if (id === "delete") {
    void confirmRemoveDownload(t);
  }
}

/** The download menu (long press / right click on any download control or
 * row): the actions that apply to the entry's state. */
export async function openDownloadMenu(
  t: DlTarget,
  at?: { x: number; y: number },
  hooks?: DownloadHooks,
) {
  const e = liveEntry(t);
  await chooseAction(
    downloadLabel(e ?? t),
    downloadActions(e),
    (id) => runDownloadAction(id, t, hooks),
    at,
  );
}

/** The tap: none → download; waiting/getting the link/downloading →
 * cancel; failed → retry; needs a play → play it; done → the menu. */
function pressDownload(t: DlTarget, hooks?: DownloadHooks, at?: { x: number; y: number }) {
  const e = liveEntry(t);
  if (!e) return runDownloadAction("download", t, hooks);
  switch (e.state) {
    case "queued":
    case "resolving":
    case "running":
      return cancelDownload(e.dlId);
    case "error":
      return retryDownload(e.dlId);
    case "needsPlay":
      return runDownloadAction("play", t, hooks);
    case "done":
      return void openDownloadMenu(t, at, hooks);
  }
}

/** The state's spoken name (the control's accessibility label). */
function stateLabel(e: DlEntry | null): string {
  if (!e) return "Download";
  switch (e.state) {
    case "queued":
      return e.waiting === "wifi" ? "Waiting for Wi-Fi, tap to cancel" : "Waiting to download, tap to cancel";
    case "resolving":
      return "Getting the link, tap to cancel";
    case "running": {
      const w =
        e.waiting === "wifi" ? ", waiting for Wi-Fi" : e.waiting === "network" ? ", waiting for a connection" : "";
      return `Downloading${e.progress != null ? ` ${Math.round(e.progress)}%` : ""}${w}, tap to cancel`;
    }
    case "done":
      return "Downloaded";
    case "error":
      return "Download failed, tap to retry";
    case "needsPlay":
      return "Play once to download";
  }
}

/** The drawn mark of a download state, `s` points square. */
function DownloadMark(props: { entry: DlEntry | null; size: number }) {
  const s = props.size;
  const st = computed(() => props.entry?.state ?? "none");
  const pct = computed(() => {
    const p = props.entry?.progress;
    return p == null ? null : Math.max(0, Math.min(100, Math.round(p)));
  });
  return (
    <View class="items-center justify-center" style={{ width: s, height: s }}>
      <If when={st() === "none"}>
        <Glyph d="download" size={s} />
      </If>
      <If when={st() === "queued"}>
        <Glyph d="clock" size={s} color={MUTED} />
      </If>
      <If when={st() === "resolving"}>
        <Spinner size={Math.round(s * 0.85)} />
      </If>
      <If when={st() === "running" && pct() == null}>
        <Image
          src={icon(progressRing(null), s)}
          class="animate-spin"
          style={{ width: s, height: s }}
        />
      </If>
      <If when={st() === "running" && pct() != null}>
        <View style={{ width: s, height: s }}>
          <Image
            src={icon(progressRing((pct() ?? 0) / 100), s)}
            style={{ position: "absolute", left: 0, top: 0, width: s, height: s }}
          />
          <View class="pointer-events-none absolute inset-0 items-center justify-center">
            <Text
              class="font-bold text-white"
              allowFontScaling={false}
              style={{
                width: s,
                textAlign: "center",
                fontSize: Math.max(7, Math.round(s * 0.3)),
                lineHeight: Math.max(7, Math.round(s * 0.3)),
              }}
            >
              {`${pct() ?? 0}%`}
            </Text>
          </View>
        </View>
      </If>
      <If when={st() === "done"}>
        <Glyph d="checkCircle" size={s} color={GREEN} />
      </If>
      <If when={st() === "error"}>
        <Glyph d="alert" size={s} color={AMBER} />
      </If>
      <If when={st() === "needsPlay"}>
        <Glyph d="playCircle" size={s} />
      </If>
    </View>
  );
}

/** Taps closer together than this are one tap (no enqueue-then-cancel). */
const TAP_GAP_MS = 600;

/**
 * The download control for one title/episode: its state as a drawn mark,
 * tap for the state's action, long press (phone) / right click (desktop)
 * for the menu. Hidden where downloads are not available.
 *
 * `size`: the mark in points (default 24); the touch area is at least
 * 44 pt on phones. `compact`: a desktop title-bar button (28 pt).
 */
export function DownloadButton(props: {
  target: DlTarget | (() => DlTarget | null);
  size?: number;
  compact?: boolean;
  onDownload?: () => void;
  onPlay?: (e: DlEntry) => void;
  /** Called before any press is handled (the player keeps its chrome up). */
  onInteract?: () => void;
}) {
  const target = computed(() =>
    typeof props.target === "function" ? props.target() : props.target,
  );
  const entry = computed(() => {
    const t = target();
    return t ? downloadFor(t.type, t.id, t.season, t.episode) : null;
  });
  const s = props.size ?? 24;
  const hit = props.compact ? 28 : desktop ? s + 12 : Math.max(44, s + 12);
  const hooks: DownloadHooks = {
    get onDownload() {
      return props.onDownload;
    },
    get onPlay() {
      return props.onPlay;
    },
  };
  let lastTap = 0;
  return (
    <If when={canDownload() && target()}>
      <View
        role="button"
        accessibilityLabel={stateLabel(entry())}
        onPress={(e: { pagePosition?: { x: number; y: number } }) => {
          const now = Date.now();
          if (now - lastTap < TAP_GAP_MS) return;
          lastTap = now;
          props.onInteract?.();
          const t = target();
          if (t) pressDownload(t, hooks, desktop ? e?.pagePosition : undefined);
        }}
        onLongPress={
          desktop
            ? undefined
            : () => {
                props.onInteract?.();
                const t = target();
                if (t) void openDownloadMenu(t, undefined, hooks);
              }
        }
        onContextMenu={(e: { pagePosition: { x: number; y: number } }) => {
          props.onInteract?.();
          const t = target();
          if (t) void openDownloadMenu(t, e.pagePosition, hooks);
        }}
        class={`cursor-pointer items-center justify-center ${
          props.compact ? "rounded-md" : "rounded-full"
        } hover:bg-white/10 active:opacity-60`}
        style={{ width: hit, height: hit }}
      >
        <DownloadMark entry={entry()} size={props.compact ? 18 : s} />
      </View>
    </If>
  );
}

/** A movie's Download button (beside My List): a `Button` whose icon is the
 * state's mark (the progress ring while it runs) and whose label is the
 * state in a word — "Download", "Queued", "Preparing", "62%", "Downloaded",
 * "Play to save", "Retry" — short enough for half a phone's width, so the
 * button never changes size; the spoken label says it in full. The same
 * actions as DownloadButton. */
export function DownloadAction(props: {
  target: () => DlTarget | null;
  size?: ButtonSize;
  variant?: ButtonVariant;
  flex?: boolean;
  fullWidth?: boolean;
}) {
  const entry = computed(() => {
    const t = props.target();
    return t ? downloadFor(t.type, t.id, t.season, t.episode) : null;
  });
  const label = computed(() => {
    const e = entry();
    if (!e) return "Download";
    switch (e.state) {
      case "queued":
        return e.waiting === "wifi" ? "Wi-Fi only" : "Queued";
      case "resolving":
        return "Preparing";
      case "running":
        return e.progress != null ? `${Math.round(e.progress)}%` : "Downloading";
      case "done":
        return "Downloaded";
      case "needsPlay":
        return "Play to save";
      case "error":
        return "Retry";
    }
  });
  const markSize = () => BUTTON_SIZE[props.size ?? "md"].icon + 2;
  let lastTap = 0;
  return (
    <If when={canDownload() && props.target()}>
      <Button
        label={label()}
        accessibilityLabel={stateLabel(entry())}
        size={props.size}
        variant={props.variant ?? "secondary"}
        flex={props.flex}
        fullWidth={props.fullWidth}
        leading={<DownloadMark entry={entry()} size={markSize()} />}
        onPress={(e) => {
          const now = Date.now();
          if (now - lastTap < TAP_GAP_MS) return;
          lastTap = now;
          const t = props.target();
          if (t) pressDownload(t, undefined, desktop ? e?.pagePosition : undefined);
        }}
        onLongPress={
          desktop
            ? undefined
            : () => {
                const t = props.target();
                if (t) void openDownloadMenu(t);
              }
        }
        onContextMenu={(e) => {
          const t = props.target();
          if (t) void openDownloadMenu(t, e.pagePosition);
        }}
      />
    </If>
  );
}

/** A labelled button with a drawn icon: `Button` with `icon` (kept for
 * older call sites). */
export function IconLabelButton(props: {
  glyph: IconName;
  label: string;
  onPress: (e: { pagePosition?: { x: number; y: number } }) => void;
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <Button
      icon={props.glyph}
      label={props.label}
      onPress={props.onPress}
      variant={props.primary ? "primary" : "secondary"}
      size={props.small ? "sm" : "md"}
    />
  );
}
