// Settings as data: categories → sections → rows. The desktop's category
// column, the phone's grouped list, the tablet's split view and the search
// all render from this one list (screens/settings/index.tsx, rows.tsx).
//
// A row is { id, label, description, keywords, platforms, needs, control }:
// - `platforms`: the devices it exists on ("desktop" | "phone" | "tablet");
//   absent = all. Elsewhere it is not shown at all (not greyed out).
// - `needs`: what the device must have ("download" the downloader,
//   "cache" the cache ops, "fps" the FPS monitor, "devmode" Diagnostics
//   unlocked, "keyboard" a keyboard).
// - `control`: how it is edited — a switch, a segmented control (2–4
//   short values), a picker (a value and a chevron that opens a list), a
//   key field (saved on blur / Enter / a pause, with a Saved mark), an
//   action (a button; destructive ones ask first in a confirm dialog), or
//   a custom view the category's own file draws (`render` names it).
// Everything applies at once: there are no Save buttons.
//
// Only light modules are imported here (no player, no downloader), so the
// schema and its search run in tests with a fake `nsh`.

import { signal, Storage } from "nsh";
import { adblockOn, setAdblock } from "../../lib/adblock";
import { nativeAvailable, nativeMode, setNativeMode, type NativeMode } from "../../lib/playback/caps";
import { PLAYER_SOURCES } from "../../lib/sources";
import { clearProgress, LANGUAGES, languageName, saveSettings, settings } from "../../lib/store";
import { setDevMode } from "./state";

// --- Types ------------------------------------------------------------------------

export type Platform = "desktop" | "phone" | "tablet";
export type Need = "download" | "cache" | "fps" | "devmode" | "keyboard" | "android";

/** The device a list is made for. */
export interface Ctx {
  platform: Platform;
  /** The downloader exists (lib/downloads.ts `canDownload`). */
  download: boolean;
  /** The cache ops exist (lib/cache.ts `cacheAvailable`). */
  cache: boolean;
  /** The FPS monitor exists (lib/perf.ts `fpsMonitorAvailable`). */
  fps: boolean;
  /** Diagnostics are unlocked (Storage `rustflix.devmode`). */
  devmode: boolean;
  /** A keyboard: always on the desktop; an iPad with one attached. */
  keyboard: boolean;
  /** An Android device (its system navigation bar can be kept away). */
  android: boolean;
}

export interface Option {
  value: string;
  label: string;
}

export interface Confirm {
  title: string;
  /** The consequence, in plain words. */
  body: string;
  /** The confirm button's label. */
  confirm: string;
  /** A red confirm button (default true). */
  destructive?: boolean;
}

export type Control =
  | { kind: "switch"; get: () => boolean; set: (on: boolean) => void }
  | { kind: "segmented"; options: Option[]; get: () => string; set: (value: string) => void }
  | {
      kind: "picker";
      options: () => Option[];
      get: () => string;
      set: (value: string) => void;
      /** The value as the row shows it (short), when not its option's label. */
      display?: (value: string) => string;
    }
  | { kind: "key"; key: "tmdb" | "wyzie" | "subdl" }
  | {
      kind: "action";
      /** The button's label. */
      button: string;
      destructive?: boolean;
      /** Asked first, in the confirm dialog. */
      confirm?: Confirm;
      run: () => void | Promise<void>;
      /** A toast once it has run. */
      done?: string;
    }
  | { kind: "custom"; render: string };

export interface RowDef {
  id: string;
  label: string;
  /** One line under the label (and what search reads). */
  description?: string;
  /** More words search finds it by. */
  keywords?: string[];
  platforms?: Platform[];
  needs?: Need[];
  /** A changing line under the label (the current state). */
  detail?: () => string;
  /** Shown only while this holds (another setting turns it off). */
  visible?: () => boolean;
  control: Control;
}

export interface SectionDef {
  id: string;
  title?: string;
  /** Small print under the section. */
  footer?: string;
  platforms?: Platform[];
  needs?: Need[];
  /** Its rows draw their own cards (a whole page's custom view). */
  bare?: boolean;
  rows: RowDef[];
}

export type CategoryId =
  | "general"
  | "player"
  | "subtitles"
  | "downloads"
  | "keyboard"
  | "gestures"
  | "sources"
  | "storage"
  | "keys"
  | "diagnostics"
  | "about";

/** The phone list's groups (top: General, over the rest). */
export type Group = "top" | "playback" | "library" | "help";

export interface CategoryDef {
  id: CategoryId;
  label: string;
  /** The icon's drawing: an SVG body on a 24-unit grid, white. */
  icon: string;
  /** The icon tile's colour. */
  color: string;
  group: Group;
  platforms?: Platform[];
  needs?: Need[];
  keywords?: string[];
  /** The value the phone list shows beside the name. */
  summary?: () => string;
  sections: SectionDef[];
}

// --- Values outside the settings record ---------------------------------------------

/** Block ads (Storage `rustflix.adblock`, lib/adblock.ts), as a signal. */
export const adsBlocked = signal(true);
void Storage.getItem("rustflix.adblock")
  .then((v) => adsBlocked.set(v !== "0"))
  .catch(() => adsBlocked.set(adblockOn()));

const PLAYER_MODES: Option[] = [
  { value: "auto", label: "Automatic" },
  { value: "1", label: "App" },
  { value: "0", label: "Site" },
];

function playerModeDetail(): string {
  const m = nativeMode();
  if (m === "auto") {
    return nativeAvailable()
      ? "The app's player where a source supports it, else the source's page."
      : "This device plays in the source's page for now.";
  }
  return m === "1"
    ? "Every source is tried in the app's player first."
    : "Every source plays in its own page.";
}

/** A source made for one language (its note is the language: DE, FR, RU). */
export function sourceLanguage(id: string): string {
  const n = PLAYER_SOURCES.find((s) => s.id === id)?.note ?? "";
  return /^[A-Z]{2}$/.test(n) ? n : "";
}

function sourceLabel(id: string): string {
  return PLAYER_SOURCES.find((s) => s.id === id)?.label ?? id;
}

const SOURCE_OPTIONS = (): Option[] =>
  PLAYER_SOURCES.map((s) => ({
    value: s.id,
    label: sourceLanguage(s.id) ? `${s.label} (${sourceLanguage(s.id)})` : s.label,
  }));

const AUDIO_OPTIONS = (): Option[] => [
  { value: "", label: "Original / follow my languages" },
  ...LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
];

export function audioLabel(code: string): string {
  return code ? languageName(code) : "Original";
}

/** Storage keys of what the player learned about the sources. */
export const LEARNED_KEYS = ["rustflix.playcaps.v1", "rustflix.playsources.v1"];

// --- Icons (24-unit grid, white) -----------------------------------------------------

const ST = `fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"`;
const ICON = {
  general: `<path d="M4 7h9M17 7h3M4 17h3M11 17h9" ${ST}/><circle cx="15" cy="7" r="2.2" ${ST}/><circle cx="9" cy="17" r="2.2" ${ST}/>`,
  player: `<path d="M8 5.5v13l10.5-6.5z" fill="#fff"/>`,
  subtitles: `<rect x="3" y="5.5" width="18" height="13" rx="2.5" ${ST}/><path d="M7 11h4M13 11h4M7 14.5h7" ${ST}/>`,
  downloads: `<path d="M12 4v10m0 0-4-4m4 4 4-4" ${ST}/><path d="M5 15.5v3.5h14v-3.5" ${ST}/>`,
  keyboard: `<rect x="2.5" y="6" width="19" height="12" rx="2" ${ST}/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8" ${ST}/>`,
  gestures: `<circle cx="12" cy="9" r="2.6" fill="#fff"/><circle cx="12" cy="9" r="6" ${ST}/><path d="M12 15v5" ${ST}/>`,
  sources: `<path d="M8 7h11m0 0-3-3m3 3-3 3M16 17H5m0 0 3-3m-3 3 3 3" ${ST}/>`,
  storage: `<ellipse cx="12" cy="6.5" rx="7" ry="2.8" ${ST}/><path d="M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" ${ST}/>`,
  keys: `<circle cx="8" cy="12" r="3.6" ${ST}/><path d="M11.6 12H21M17.5 12v3.2M20.5 12v2.4" ${ST}/>`,
  diagnostics: `<path d="M3 12.5h4l2.2-5.5 4.4 11 2.2-5.5H21" ${ST}/>`,
  about: `<circle cx="12" cy="12" r="8.5" ${ST}/><path d="M12 11v5.5" ${ST}/><circle cx="12" cy="7.8" r="1.25" fill="#fff"/>`,
} as const;

// --- The categories ------------------------------------------------------------------

const enumSet =
  <K extends string>(key: K, parse: (v: string) => unknown) =>
  (v: string) =>
    void saveSettings({ [key]: parse(v) } as never);

export const CATEGORIES: CategoryDef[] = [
  {
    id: "general",
    label: "General",
    icon: ICON.general,
    color: "#8e8e93",
    group: "top",
    summary: () => sourceLabel(settings().defaultSource),
    sections: [
      {
        id: "general.main",
        rows: [
          {
            id: "general.defaultSource",
            label: "Default source",
            description: "The source a play starts with.",
            keywords: ["player source", "provider", "server", "embed", "vidsrc", "vidfast"],
            control: {
              kind: "picker",
              options: SOURCE_OPTIONS,
              get: () => settings().defaultSource,
              set: (v) => void saveSettings({ defaultSource: v }),
            },
          },
        ],
      },
      {
        id: "general.motion",
        title: "Motion",
        rows: [
          {
            id: "general.reduceMotion",
            label: "Reduce motion",
            description:
              "Plain cuts and short fades instead of the poster flight and page animations. On by itself when the system asks for less motion.",
            keywords: ["animation", "animations", "accessibility", "poster", "transition", "fade"],
            control: {
              kind: "switch",
              get: () => settings().reduceMotion,
              set: (on) => void saveSettings({ reduceMotion: on }),
            },
          },
        ],
      },
      {
        id: "general.android",
        title: "Screen",
        needs: ["android"],
        rows: [
          {
            id: "general.hideNavButtons",
            label: "Hide Android's navigation buttons",
            description:
              "Keeps the back, home and recents buttons off the screen. Swipe up from the bottom edge to show them. Does nothing with gesture navigation.",
            keywords: ["navigation bar", "buttons", "back", "home", "recents", "immersive", "full screen", "bottom bar"],
            control: {
              kind: "switch",
              get: () => settings().hideNavButtons,
              set: (on) => void saveSettings({ hideNavButtons: on }),
            },
          },
        ],
      },
    ],
  },
  {
    id: "player",
    label: "Player",
    icon: ICON.player,
    color: "#e50914",
    group: "playback",
    summary: () => PLAYER_MODES.find((m) => m.value === nativeMode())?.label ?? "Automatic",
    sections: [
      {
        id: "player.which",
        rows: [
          {
            id: "player.which",
            label: "Which player",
            description: "The app's own player, or the source's page.",
            keywords: ["native", "app player", "site player", "embed", "automatic", "backend"],
            detail: playerModeDetail,
            control: {
              kind: "segmented",
              options: PLAYER_MODES,
              get: () => nativeMode(),
              set: (v) => setNativeMode(v as NativeMode),
            },
          },
          {
            id: "player.adblock",
            label: "Block ads in the player",
            description:
              "Ad requests, pop-ups and everything a source page draws over the video. Turn off only if a source stops playing.",
            keywords: ["ads", "adblock", "popups", "pop-ups", "advert"],
            control: {
              kind: "switch",
              get: () => adsBlocked(),
              set: (on) => {
                adsBlocked.set(on);
                setAdblock(on);
              },
            },
          },
        ],
      },
      {
        id: "player.playback",
        title: "Playback",
        rows: [
          {
            id: "player.seekStep",
            label: "Skip back / forward by",
            description: "The arrow keys and the skip buttons.",
            keywords: ["seek", "seek step", "jump", "rewind", "fast forward", "seconds", "arrows"],
            control: {
              kind: "segmented",
              options: [5, 10, 15, 30].map((n) => ({ value: String(n), label: `${n} s` })),
              get: () => String(settings().seekStep),
              set: enumSet("seekStep", Number),
            },
          },
          {
            id: "player.rememberSpeed",
            label: "Remember playback speed",
            description: "Off: every video starts at 1×.",
            keywords: ["speed", "rate", "playback rate", "1x", "2x", "faster", "slower"],
            control: {
              kind: "switch",
              get: () => settings().rememberSpeed,
              set: (on) => void saveSettings({ rememberSpeed: on }),
            },
          },
        ],
      },
      {
        id: "player.next",
        title: "Next episode",
        rows: [
          {
            id: "player.autoplayNext",
            label: "Play the next episode automatically",
            description: "When an episode ends, after a countdown you can cancel.",
            keywords: ["autoplay", "auto play", "next episode", "binge", "continue"],
            control: {
              kind: "switch",
              get: () => settings().autoplayNext,
              set: (on) => void saveSettings({ autoplayNext: on }),
            },
          },
          {
            id: "player.autoplayCountdown",
            label: "Countdown",
            description: "How long before the next episode plays.",
            keywords: ["autoplay", "timer", "seconds", "next episode"],
            visible: () => settings().autoplayNext,
            control: {
              kind: "segmented",
              options: [5, 10, 15].map((n) => ({ value: String(n), label: `${n} s` })),
              get: () => String(settings().autoplayCountdown),
              set: enumSet("autoplayCountdown", Number),
            },
          },
        ],
      },
      {
        id: "player.skip",
        title: "Intros and credits",
        rows: [
          {
            id: "player.skipSegments",
            label: "Intros and credits",
            description: "Where their times are known (anime).",
            keywords: ["skip intro", "skip credits", "opening", "ending", "outro", "aniskip", "recap"],
            control: {
              kind: "segmented",
              options: [
                { value: "button", label: "Show a Skip button" },
                { value: "auto", label: "Skip automatically" },
              ],
              get: () => settings().skipSegments,
              set: enumSet("skipSegments", String),
            },
          },
        ],
      },
    ],
  },
  {
    id: "subtitles",
    label: "Subtitles & audio",
    icon: ICON.subtitles,
    color: "#0a84ff",
    group: "playback",
    keywords: ["captions", "cc"],
    summary: () => {
      const l = settings().myLanguages;
      return languageName((l && l[0]) || "en");
    },
    sections: [
      {
        id: "subtitles.languages",
        title: "My languages",
        footer: "Subtitles and audio in these languages are shown first and picked for you.",
        rows: [
          {
            id: "subtitles.languages",
            label: "My languages",
            description: "In order: the first match is picked.",
            keywords: ["language", "languages", "subtitle language", "audio language", "english", "order"],
            control: { kind: "custom", render: "languages" },
          },
        ],
      },
      {
        id: "subtitles.subs",
        title: "Subtitles",
        rows: [
          {
            id: "subtitles.auto",
            label: "Subtitles turn on by themselves",
            description: "When a title is not in one of your languages.",
            keywords: ["captions", "automatic", "foreign", "cc"],
            control: {
              kind: "switch",
              get: () => settings().subtitleAuto,
              set: (on) => void saveSettings({ subtitleAuto: on }),
            },
          },
          {
            id: "subtitles.size",
            label: "Subtitle size",
            keywords: ["captions", "text size", "font", "small", "medium", "large", "bigger"],
            control: {
              kind: "segmented",
              options: [
                { value: "s", label: "Small" },
                { value: "m", label: "Medium" },
                { value: "l", label: "Large" },
              ],
              get: () => settings().subtitleSize || "m",
              set: enumSet("subtitleSize", String),
            },
          },
        ],
      },
      {
        id: "subtitles.audio",
        title: "Audio",
        rows: [
          {
            id: "subtitles.preferredAudio",
            label: "Preferred audio language",
            description: "The dub or the original picked first, where a title has more than one.",
            keywords: ["audio", "dub", "dubbed", "original", "language", "track", "sub", "voice"],
            control: {
              kind: "picker",
              options: AUDIO_OPTIONS,
              display: audioLabel,
              get: () => settings().preferredAudio,
              set: (v) => void saveSettings({ preferredAudio: v }),
            },
          },
        ],
      },
    ],
  },
  {
    id: "downloads",
    label: "Downloads",
    icon: ICON.downloads,
    color: "#34c759",
    group: "library",
    needs: ["download"],
    summary: () => (settings().downloadWifiOnly ? "Wi-Fi only" : ""),
    sections: [
      {
        id: "downloads.main",
        rows: [
          {
            id: "downloads.folder",
            label: "Download folder",
            description: "Where downloads are kept. Changing it moves them.",
            keywords: ["folder", "location", "path", "directory", "disk", "move"],
            platforms: ["desktop"],
            control: { kind: "custom", render: "downloadFolder" },
          },
          {
            id: "downloads.autoNext",
            label: "Download the next episode by itself",
            description: "When you finish a downloaded episode.",
            keywords: ["next episode", "automatic", "queue", "offline"],
            control: {
              kind: "switch",
              get: () => settings().downloadAutoNext,
              set: (on) => void saveSettings({ downloadAutoNext: on }),
            },
          },
          {
            id: "downloads.wifiOnly",
            label: "Wi-Fi only",
            description: "Never download over mobile data.",
            keywords: ["cellular", "mobile data", "wifi", "data"],
            platforms: ["phone", "tablet"],
            control: {
              kind: "switch",
              get: () => settings().downloadWifiOnly,
              set: (on) => void saveSettings({ downloadWifiOnly: on }),
            },
          },
          {
            id: "downloads.confirmDelete",
            label: "Ask before deleting a download",
            description: "One confirm before a download is deleted or removed.",
            keywords: ["delete", "remove", "confirm", "trash"],
            control: {
              kind: "switch",
              get: () => settings().confirmDeleteDownload,
              set: (on) => void saveSettings({ confirmDeleteDownload: on }),
            },
          },
        ],
      },
    ],
  },
  {
    id: "keyboard",
    label: "Keyboard shortcuts",
    icon: ICON.keyboard,
    color: "#ff9f0a",
    group: "help",
    platforms: ["desktop", "tablet"],
    needs: ["keyboard"],
    sections: [
      {
        id: "keyboard.main",
        bare: true,
        rows: [
          {
            id: "keyboard.shortcuts",
            label: "Keyboard shortcuts",
            description: "Change a shortcut, or reset them all.",
            keywords: ["keys", "hotkeys", "bindings", "rebind", "command", "shortcut", "keymap"],
            control: { kind: "custom", render: "keyboard" },
          },
        ],
      },
    ],
  },
  {
    id: "gestures",
    label: "Gestures",
    icon: ICON.gestures,
    color: "#ff9f0a",
    group: "help",
    platforms: ["phone", "tablet"],
    sections: [
      {
        id: "gestures.main",
        title: "In the player",
        rows: [
          {
            id: "gestures.list",
            label: "Player gestures",
            description: "Tap, double tap, hold, slide, pinch.",
            keywords: ["touch", "tap", "double tap", "hold", "swipe", "pinch", "brightness", "volume", "2x"],
            control: { kind: "custom", render: "gestures" },
          },
        ],
      },
    ],
  },
  {
    id: "sources",
    label: "Sources",
    icon: ICON.sources,
    color: "#bf5af2",
    group: "playback",
    summary: () => sourceLabel(settings().defaultSource),
    sections: [
      {
        id: "sources.list",
        title: "Sources",
        footer:
          "Tap a source to start plays with it. App: it plays in Rustflix's own player. Site: its own page plays it. Each device learns which sources work in the app's player.",
        rows: [
          {
            id: "sources.list",
            label: "Sources",
            description: "Which play in the app's player, and the default.",
            keywords: [
              "default source",
              "provider",
              "server",
              "app player",
              "site player",
              ...PLAYER_SOURCES.map((s) => s.label.toLowerCase()),
            ],
            control: { kind: "custom", render: "sources" },
          },
        ],
      },
    ],
  },
  {
    id: "storage",
    label: "Storage & privacy",
    icon: ICON.storage,
    color: "#64d2ff",
    group: "library",
    keywords: ["privacy", "data"],
    sections: [
      {
        id: "storage.device",
        title: "On this device",
        needs: ["cache"],
        rows: [
          {
            id: "storage.images",
            label: "Images",
            description: "Posters and artwork saved on this device so they load instantly.",
            keywords: ["cache", "posters", "artwork", "clear", "space", "size"],
            control: { kind: "custom", render: "cache:images" },
          },
          {
            id: "storage.web",
            label: "Video pages",
            description: "Temporary files from the video sources.",
            keywords: ["cache", "web", "temporary", "clear", "space", "size"],
            control: { kind: "custom", render: "cache:web" },
          },
          {
            id: "storage.site",
            label: "Site data",
            description: "Cookies and saved state of the video sources. Clearing it resets them.",
            keywords: ["cookies", "logins", "clear", "website data", "reset"],
            control: { kind: "custom", render: "cache:site" },
          },
        ],
      },
      {
        id: "storage.history",
        title: "Watch history",
        rows: [
          {
            id: "storage.clearHistory",
            label: "Clear watch history",
            description: "Empties Continue Watching and every resume point. My List stays.",
            keywords: ["history", "continue watching", "progress", "resume", "privacy", "delete"],
            control: {
              kind: "action",
              button: "Clear…",
              destructive: true,
              confirm: {
                title: "Clear watch history?",
                body: "Continue Watching empties and every title starts from the beginning again. My List stays as it is. This cannot be undone.",
                confirm: "Clear history",
              },
              run: () => clearProgress(),
              done: "Watch history cleared",
            },
          },
          {
            id: "storage.library",
            label: "Library data",
            keywords: ["my list", "watchlist", "progress", "count", "entries"],
            control: { kind: "custom", render: "libraryCounts" },
          },
        ],
      },
    ],
  },
  {
    id: "keys",
    label: "API keys",
    icon: ICON.keys,
    color: "#ffd60a",
    group: "library",
    keywords: ["api", "token"],
    sections: [
      {
        id: "keys.tmdb",
        title: "Titles",
        footer:
          "Movie and show details come from TMDB. Paste a TMDB Read Access Token (v4) or v3 API key (themoviedb.org → Settings → API). It stays on this device.",
        rows: [
          {
            id: "keys.tmdb",
            label: "TMDB",
            keywords: ["tmdb", "themoviedb", "key", "token", "api key", "metadata"],
            control: { kind: "key", key: "tmdb" },
          },
        ],
      },
      {
        id: "keys.subs",
        title: "More subtitle languages (optional)",
        footer:
          "Rustflix already finds missing subtitles online. Keys for Wyzie Subs and SubDL add more results and languages.",
        rows: [
          {
            id: "keys.wyzie",
            label: "Wyzie Subs",
            keywords: ["wyzie", "subtitles", "key", "api key"],
            control: { kind: "key", key: "wyzie" },
          },
          {
            id: "keys.subdl",
            label: "SubDL",
            keywords: ["subdl", "subtitles", "key", "api key"],
            control: { kind: "key", key: "subdl" },
          },
        ],
      },
    ],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: ICON.diagnostics,
    color: "#ff375f",
    group: "help",
    needs: ["devmode"],
    keywords: ["debug", "developer"],
    sections: [
      {
        id: "diagnostics.perf",
        title: "Performance",
        needs: ["fps"],
        rows: [
          {
            id: "diagnostics.fps",
            label: "Show FPS monitor",
            description: "Frame rate and frame times over the app.",
            keywords: ["fps", "frame rate", "performance", "monitor", "debug"],
            control: { kind: "custom", render: "fps" },
          },
          {
            id: "diagnostics.recording",
            label: "Save performance recording",
            description: "The monitor records while it shows; this saves it.",
            keywords: ["perf", "recording", "trace", "export", "performance"],
            control: { kind: "custom", render: "recording" },
          },
        ],
      },
      {
        id: "diagnostics.log",
        title: "Player",
        rows: [
          {
            id: "diagnostics.log",
            label: "Diagnostics log",
            description: "Records player bridge events to storage for troubleshooting.",
            keywords: ["debug", "log", "logging", "bridge", "events"],
            control: { kind: "custom", render: "debugLog" },
          },
          {
            id: "diagnostics.resetLearned",
            label: "Reset what the player learned",
            description: "Which sources played, and which worked in the app's player, on this device.",
            keywords: ["reset", "learned", "capabilities", "sources", "cache", "native"],
            control: {
              kind: "action",
              button: "Reset…",
              destructive: true,
              confirm: {
                title: "Reset what the player learned?",
                body: "Rustflix forgets which sources played on this device and which worked in its own player. It learns again from the next plays; the change is complete the next time Rustflix starts.",
                confirm: "Reset",
              },
              run: async () => {
                for (const k of LEARNED_KEYS) await Storage.removeItem(k).catch(() => {});
              },
              done: "The player starts learning again",
            },
          },
        ],
      },
      {
        id: "diagnostics.hide",
        rows: [
          {
            id: "diagnostics.hide",
            label: "Hide diagnostics",
            description: "Tap the version in About seven times to show them again.",
            keywords: ["hide", "developer", "lock"],
            control: {
              kind: "action",
              button: "Hide",
              run: () => setDevMode(false),
              done: "Diagnostics hidden",
            },
          },
        ],
      },
    ],
  },
  {
    id: "about",
    label: "About",
    icon: ICON.about,
    color: "#8e8e93",
    group: "help",
    sections: [
      {
        id: "about.main",
        rows: [
          {
            id: "about.version",
            label: "Version",
            keywords: ["version", "build", "number", "release", "update"],
            control: { kind: "custom", render: "version" },
          },
          {
            id: "about.acknowledgements",
            label: "Acknowledgements",
            keywords: ["credits", "licences", "licenses", "nsh", "gpui", "tmdb", "anilist", "streambert"],
            control: { kind: "custom", render: "acknowledgements" },
          },
        ],
      },
    ],
  },
];

/** The phone list's groups, in order, with their headings. */
export const GROUPS: { id: Group; title: string }[] = [
  { id: "top", title: "" },
  { id: "playback", title: "Playback" },
  { id: "library", title: "Library" },
  { id: "help", title: "Help" },
];

/** The order inside the phone list's Help group. */
const HELP_ORDER: CategoryId[] = ["gestures", "keyboard", "about", "diagnostics"];
/** The order inside the phone list's Playback group. */
const PLAYBACK_ORDER: CategoryId[] = ["player", "subtitles", "sources"];
/** The order inside the phone list's Library group. */
const LIBRARY_ORDER: CategoryId[] = ["downloads", "storage", "keys"];

// --- Filtering -----------------------------------------------------------------------

function allowed(x: { platforms?: Platform[]; needs?: Need[] }, ctx: Ctx): boolean {
  if (x.platforms && !x.platforms.includes(ctx.platform)) return false;
  for (const n of x.needs ?? []) if (!ctx[n]) return false;
  return true;
}

/** The row exists on this device (its runtime `visible` aside). */
export function rowAllowed(r: RowDef, ctx: Ctx): boolean {
  return allowed(r, ctx);
}

/** The sections of `c` on this device, each with only its rows that exist
 * here; sections left empty are dropped. */
export function visibleSections(c: CategoryDef, ctx: Ctx): SectionDef[] {
  return c.sections
    .filter((s) => allowed(s, ctx))
    .map((s) => ({ ...s, rows: s.rows.filter((r) => allowed(r, ctx)) }))
    .filter((s) => s.rows.length > 0);
}

/** The categories on this device, in the column's order (desktop and the
 * split views). A category with no row here is not listed. */
export function visibleCategories(ctx: Ctx): CategoryDef[] {
  return CATEGORIES.filter((c) => allowed(c, ctx) && visibleSections(c, ctx).length > 0);
}

/** The phone list: `visibleCategories` in its groups (General on top;
 * Playback; Library; Help). */
export function groupedCategories(ctx: Ctx): { group: Group; title: string; items: CategoryDef[] }[] {
  const cats = visibleCategories(ctx);
  const order: Record<Group, CategoryId[]> = {
    top: ["general"],
    playback: PLAYBACK_ORDER,
    library: LIBRARY_ORDER,
    help: HELP_ORDER,
  };
  return GROUPS.map((g) => ({
    group: g.id,
    title: g.title,
    items: order[g.id]
      .map((id) => cats.find((c) => c.id === id))
      .filter((c): c is CategoryDef => !!c),
  })).filter((g) => g.items.length > 0);
}

export function categoryById(id: string): CategoryDef | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** A row by id, with its category. */
export function findRow(id: string): { category: CategoryDef; row: RowDef } | undefined {
  for (const c of CATEGORIES) {
    for (const s of c.sections) {
      const row = s.rows.find((r) => r.id === id);
      if (row) return { category: c, row };
    }
  }
  return undefined;
}

// --- Search --------------------------------------------------------------------------

export interface SearchHit {
  category: CategoryDef;
  /** The category's own name matches the query. */
  categoryMatch: boolean;
  /** Its rows that match, in page order. */
  rows: RowDef[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9×]+/g, " ").trim();
}

function matches(hay: string, terms: string[]): boolean {
  return terms.every((t) => hay.includes(t));
}

/** Every setting on this device whose label, description or keywords (or
 * its section's title) hold every word of `query`, grouped by category in
 * the column's order. Diagnostics stay out while hidden. */
export function searchSettings(query: string, ctx: Ctx): SearchHit[] {
  const terms = norm(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const c of visibleCategories(ctx)) {
    const categoryMatch = matches(norm([c.label, ...(c.keywords ?? [])].join(" ")), terms);
    const rows: RowDef[] = [];
    for (const s of visibleSections(c, ctx)) {
      for (const r of s.rows) {
        const hay = norm(
          [r.label, r.description ?? "", s.title ?? "", ...(r.keywords ?? [])].join(" "),
        );
        if (matches(hay, terms)) rows.push(r);
      }
    }
    if (categoryMatch || rows.length) hits.push({ category: c, categoryMatch, rows });
  }
  return hits;
}
