// Keyboard shortcuts: the registry of rebindable actions, the user's
// overrides (Storage `rustflix.shortcuts.v1`), clash checks, labels, key
// capture for Settings → Keyboard shortcuts, and the bindings themselves
// (`installShortcuts`, called once by App.tsx with the actions' handlers).
//
// Keystrokes are NSH keymap strings (nsh-core keymap.rs): modifiers and a
// key joined by `+`, matched exactly ("mod+shift+s" never also fires
// "mod+s"). Here they are kept canonical (`normalizeChord`): modifiers in
// the order mod, ctrl (Apple) / cmd (elsewhere), alt, shift, then the key
// by its unshifted US-layout character or its name ("space", "left").
//
// Fixed, not in the registry: the command palette's typing keys
// (lib/player.ts, bound while it is open) and ⌘1–⌘9 picking palette items
// (bound here with the global keys; ⌘1 is Home otherwise).

import { computed, effect, keymap, platform, signal, Storage, untracked } from "nsh";

export type ShortcutGroup = "Anywhere" | "In the player" | "Navigation";
export type ShortcutScope = "global" | "player";

/** A rebindable action, as declared (its handler comes from App.tsx). */
export interface ShortcutDecl {
  id: ShortcutId;
  group: ShortcutGroup;
  label: string;
  description?: string;
  /** One or more keystrokes, NSH syntax, canonical. */
  defaults: string[];
  /** "global": bound always. "player": bound while the player shows —
   * keystrokes with ⌘/Ctrl while it shows; plain keys (Space, letters,
   * arrows) only with no palette or picker open, never while typing. */
  scope: ShortcutScope;
  /** Keymap `when` for keystrokes with ⌘/Ctrl (plain player keys are
   * always "notEditing"). Default "auto". */
  when?: "auto" | "notEditing";
  /** Fires again while held. */
  repeat?: boolean;
}

/** A registry action with its handler. */
export interface ShortcutAction extends ShortcutDecl {
  run: () => void;
  enabled?: () => boolean;
}

export type ShortcutId =
  | "home"
  | "search"
  | "library"
  | "downloads"
  | "settings"
  | "back"
  | "forward"
  | "dismiss"
  | "fpsMonitor"
  | "saveRecording"
  | "palette"
  | "nextEpisode"
  | "prevEpisode"
  | "episodes"
  | "sources"
  | "download"
  | "playPause"
  | "seekBack"
  | "seekForward"
  | "volumeUp"
  | "volumeDown"
  | "mute"
  | "fullscreen";

/** Every rebindable action, in the order the settings page lists them. */
export const SHORTCUTS: readonly ShortcutDecl[] = [
  // Anywhere.
  {
    id: "dismiss",
    group: "Anywhere",
    label: "Close or go back",
    description: "Closes the palette, a picker or a popup; in the player, closes it; else goes back",
    defaults: ["escape"],
    scope: "global",
  },
  { id: "fpsMonitor", group: "Anywhere", label: "FPS monitor", description: "Shows or hides it", defaults: ["mod+shift+f"], scope: "global" },
  { id: "saveRecording", group: "Anywhere", label: "Save performance recording", defaults: ["mod+shift+r"], scope: "global" },
  // In the player.
  { id: "playPause", group: "In the player", label: "Play / pause", defaults: ["space"], scope: "player", when: "notEditing" },
  { id: "seekBack", group: "In the player", label: "Seek back", description: "By the seek step", defaults: ["left"], scope: "player", when: "notEditing", repeat: true },
  { id: "seekForward", group: "In the player", label: "Seek forward", description: "By the seek step", defaults: ["right"], scope: "player", when: "notEditing", repeat: true },
  { id: "volumeUp", group: "In the player", label: "Volume up", defaults: ["up", "mod+=", "mod+shift+="], scope: "player", repeat: true },
  { id: "volumeDown", group: "In the player", label: "Volume down", defaults: ["down", "mod+-"], scope: "player", repeat: true },
  { id: "mute", group: "In the player", label: "Mute", defaults: ["m"], scope: "player", when: "notEditing" },
  { id: "fullscreen", group: "In the player", label: "Full screen", defaults: ["f"], scope: "player", when: "notEditing" },
  {
    id: "palette",
    group: "In the player",
    label: "Command palette",
    description: "Episodes, play/pause, seek, speed, subtitles, download, source",
    defaults: ["mod+k"],
    scope: "global",
  },
  { id: "nextEpisode", group: "In the player", label: "Next episode", defaults: ["mod+n"], scope: "global" },
  { id: "prevEpisode", group: "In the player", label: "Previous episode", defaults: ["mod+p"], scope: "global" },
  { id: "episodes", group: "In the player", label: "Episodes", description: "Series", defaults: ["mod+e"], scope: "player" },
  { id: "sources", group: "In the player", label: "Sources", defaults: ["mod+shift+s"], scope: "player" },
  { id: "download", group: "In the player", label: "Download what is playing", defaults: ["mod+shift+d"], scope: "player" },
  // Navigation.
  { id: "home", group: "Navigation", label: "Home", description: "Again: back to where you were", defaults: ["mod+1"], scope: "global" },
  { id: "search", group: "Navigation", label: "Search", description: "With the field focused", defaults: ["mod+f"], scope: "global" },
  { id: "library", group: "Navigation", label: "My List", defaults: ["mod+l"], scope: "global" },
  { id: "downloads", group: "Navigation", label: "Downloads", defaults: ["mod+d"], scope: "global" },
  { id: "settings", group: "Navigation", label: "Settings", defaults: ["mod+,"], scope: "global" },
  { id: "back", group: "Navigation", label: "Back", description: "Through the places you visited", defaults: ["mod+["], scope: "global" },
  { id: "forward", group: "Navigation", label: "Forward", defaults: ["mod+]"], scope: "global" },
];

const GROUP_ORDER: ShortcutGroup[] = ["Anywhere", "In the player", "Navigation"];

const STORAGE_KEY = "rustflix.shortcuts.v1";

// --- Keystrokes ---------------------------------------------------------------

const os = (): string => String(platform.os ?? "");
/** Apple keys: `mod` is Command, labels are glyphs. */
export const appleKeys = (): boolean => os() === "macos" || os() === "ios";

const NAMED: Record<string, string> = {
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  up: "up",
  arrowup: "up",
  down: "down",
  arrowdown: "down",
  left: "left",
  arrowleft: "left",
  right: "right",
  arrowright: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  plus: "=",
  minus: "-",
};
const SHIFTED = "~!@#$%^&*()_+{}|:\"<>?";

/** A keystroke in canonical form ("mod+shift+s", "space", "mod+="), or
 * null when NSH would not parse it. */
export function normalizeChord(text: string): string | null {
  const lower = String(text ?? "").trim().toLowerCase();
  if (!lower || /\s/.test(lower) || lower === "+" || lower.endsWith("++")) return null;
  const cut = lower.lastIndexOf("+");
  const mods = cut < 0 ? [] : lower.slice(0, cut).split("+");
  let key = cut < 0 ? lower : lower.slice(cut + 1);
  if (!key) return null;
  const apple = appleKeys();
  const on = { mod: false, other: false, alt: false, shift: false };
  for (const m of mods) {
    let flag: keyof typeof on;
    if (m === "mod" || m === "cmdorctrl" || m === "commandorcontrol") flag = "mod";
    else if (m === "ctrl" || m === "control") flag = apple ? "other" : "mod";
    else if (m === "cmd" || m === "command" || m === "meta" || m === "super" || m === "win") flag = apple ? "mod" : "other";
    else if (m === "alt" || m === "option" || m === "opt") flag = "alt";
    else if (m === "shift") flag = "shift";
    else return null;
    if (on[flag]) return null;
    on[flag] = true;
  }
  if (NAMED[key]) key = NAMED[key];
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    // F1–F24.
  } else if (key.length !== 1 || SHIFTED.includes(key) || key < "!" || key > "~") return null;
  const parts: string[] = [];
  if (on.mod) parts.push("mod");
  if (on.other) parts.push(apple ? "ctrl" : "cmd");
  if (on.alt) parts.push("alt");
  if (on.shift) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

function splitChord(chord: string): { mods: string[]; key: string } {
  const c = normalizeChord(chord) ?? chord;
  const cut = c.lastIndexOf("+");
  return cut < 0 ? { mods: [], key: c } : { mods: c.slice(0, cut).split("+"), key: c.slice(cut + 1) };
}

/** Whether a keystroke has ⌘ (Ctrl elsewhere) or the other of the two:
 * else it is a plain key (Space, a letter, an arrow; Shift and Option
 * allowed), which types or moves in a field. */
export function hasCommandKey(chord: string): boolean {
  const { mods } = splitChord(chord);
  return mods.includes("mod") || mods.includes("ctrl") || mods.includes("cmd");
}

const KEY_NAMES: Record<string, [string, string]> = {
  // [Apple, elsewhere]
  space: ["Space", "Space"],
  enter: ["↩", "Enter"],
  escape: ["Esc", "Esc"],
  tab: ["⇥", "Tab"],
  backspace: ["⌫", "Backspace"],
  delete: ["⌦", "Del"],
  insert: ["Help", "Ins"],
  up: ["↑", "↑"],
  down: ["↓", "↓"],
  left: ["←", "←"],
  right: ["→", "→"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  pageup: ["Page Up", "PgUp"],
  pagedown: ["Page Down", "PgDn"],
  "-": ["−", "−"],
};

/** The keys of a keystroke as caps, one per key: ["⌘", "⇧", "S"] on Apple
 * platforms, ["Ctrl", "Shift", "S"] elsewhere. */
export function chordCaps(chord: string): string[] {
  const { mods, key } = splitChord(chord);
  const apple = appleKeys();
  const caps: string[] = [];
  const glyph: Record<string, [string, string]> = {
    mod: ["⌘", "Ctrl"],
    ctrl: ["⌃", "Ctrl"],
    cmd: ["⌘", os() === "windows" ? "Win" : "Super"],
    alt: ["⌥", "Alt"],
    shift: ["⇧", "Shift"],
  };
  for (const m of mods) caps.push(glyph[m]?.[apple ? 0 : 1] ?? m);
  const named = KEY_NAMES[key];
  caps.push(named ? named[apple ? 0 : 1] : /^f\d+$/.test(key) ? key.toUpperCase() : key.toUpperCase());
  return caps;
}

/** A keystroke as the docs write it: "⌘⇧S", "Space", "←", "Esc", "⌘,";
 * "Ctrl+Shift+S" off Apple platforms. */
export function formatChord(chord: string): string {
  const caps = chordCaps(chord);
  if (appleKeys()) return caps.join("");
  return caps.join("+");
}

// --- Overrides ------------------------------------------------------------------

type Overrides = Partial<Record<ShortcutId, string[]>>;
const overrides = signal<Overrides>({});
let loaded = false;

const declById = new Map<string, ShortcutDecl>(SHORTCUTS.map((s) => [s.id, s]));

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Loads the saved overrides (once; called by `installShortcuts`). */
export async function loadShortcuts(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await Storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const next: Overrides = {};
    for (const [id, list] of Object.entries(data ?? {})) {
      if (!declById.has(id) || !Array.isArray(list)) continue;
      const chords: string[] = [];
      for (const c of list) {
        const n = typeof c === "string" ? normalizeChord(c) : null;
        if (n && !chords.includes(n)) chords.push(n);
      }
      next[id as ShortcutId] = chords;
    }
    overrides.set(next);
  } catch {}
}

function save(next: Overrides) {
  // Only what differs from the defaults is kept.
  const clean: Overrides = {};
  for (const [id, list] of Object.entries(next) as [ShortcutId, string[]][]) {
    const d = declById.get(id);
    if (d && list && !sameList(list, d.defaults)) clean[id] = list;
  }
  overrides.set(clean);
  void Storage.setItem(STORAGE_KEY, JSON.stringify(clean)).catch(() => {});
}

/** The keystrokes an action has now (its defaults unless changed). */
export function chordsFor(id: ShortcutId): string[] {
  const o = overrides()[id];
  return [...(o ?? declById.get(id)?.defaults ?? [])];
}

/** Whether no action was changed. */
export const allDefault = computed(() => Object.keys(overrides()).length === 0);

export interface ShortcutRow {
  id: ShortcutId;
  label: string;
  description?: string;
  scope: ShortcutScope;
  chords: string[];
  isDefault: boolean;
}

/** For the settings page: the groups, their actions and current keys. */
export const shortcutGroups = computed(() => {
  const o = overrides();
  return GROUP_ORDER.map((group) => ({
    group,
    actions: SHORTCUTS.filter((s) => s.group === group).map(
      (s): ShortcutRow => ({
        id: s.id,
        label: s.label,
        description: s.description,
        scope: s.scope,
        chords: [...(o[s.id] ?? s.defaults)],
        isDefault: !o[s.id],
      }),
    ),
  }));
});

function setChords(id: ShortcutId, chords: string[], also?: Overrides) {
  const next: Overrides = { ...untracked(overrides), ...also };
  const unique: string[] = [];
  for (const c of chords) if (!unique.includes(c)) unique.push(c);
  next[id] = unique;
  save(next);
}

/** Sets an action's `index`th keystroke (past the end: adds one). */
export function rebind(id: ShortcutId, index: number, chord: string): boolean {
  const c = normalizeChord(chord);
  if (!c || !declById.has(id)) return false;
  const list = chordsFor(id);
  if (index >= 0 && index < list.length) list[index] = c;
  else list.push(c);
  setChords(id, list);
  return true;
}

/** Adds a keystroke to an action. */
export function addChord(id: ShortcutId, chord: string): boolean {
  return rebind(id, Number.MAX_SAFE_INTEGER, chord);
}

/** Removes an action's `index`th keystroke (none left: it is unbound). */
export function removeChord(id: ShortcutId, index: number) {
  if (!declById.has(id)) return;
  const list = chordsFor(id);
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  setChords(id, list);
}

/** Sets the keystroke and takes it from whichever other action had it. */
export function replaceChord(id: ShortcutId, index: number, chord: string): boolean {
  const c = normalizeChord(chord);
  if (!c || !declById.has(id)) return false;
  const also: Overrides = {};
  for (const s of SHORTCUTS) {
    if (s.id === id) continue;
    const list = chordsFor(s.id);
    if (list.includes(c)) also[s.id] = list.filter((x) => x !== c);
  }
  const list = chordsFor(id);
  if (index >= 0 && index < list.length) list[index] = c;
  else list.push(c);
  setChords(id, list, also);
  return true;
}

/** Back to the action's default keys. */
export function resetShortcut(id: ShortcutId) {
  const next: Overrides = { ...untracked(overrides) };
  delete next[id];
  save(next);
}

/** Every action back to its default keys. */
export function resetAllShortcuts() {
  save({});
}

// --- Clashes ------------------------------------------------------------------

export interface Clash {
  /** The action holding the keystroke; null when it is reserved. */
  id: ShortcutId | null;
  /** The action's label, or what the reserved keystroke does. */
  label: string;
  /** Reserved keystrokes: why it cannot be used ("it copies text"). */
  reason?: string;
}

/** Keystrokes no action may take, everywhere. */
function reservedEverywhere(): Record<string, string> {
  const r: Record<string, string> = {
    "mod+c": "it copies text",
    "mod+v": "it pastes",
    "mod+x": "it cuts text",
    "mod+a": "it selects all",
    "mod+z": "it undoes",
    "mod+shift+z": "it redoes",
    "mod+q": "it quits the app",
    "mod+w": "it closes the window",
    "mod+h": "it hides the app",
    "mod+m": "it minimizes the window",
    "mod+backspace": "it clears the command palette's filter",
    "alt+backspace": "it deletes a word in the command palette's filter",
  };
  if (appleKeys()) {
    r["mod+alt+h"] = "it hides the other apps";
    r["mod+ctrl+f"] = "it toggles full screen";
  } else {
    r["mod+y"] = "it redoes";
    r["alt+f4"] = "it closes the window";
    r["f11"] = "it toggles full screen";
  }
  return r;
}

/** Why `chord` cannot be used by an action of `scope`, or null. */
export function reservedReason(chord: string, scope: ShortcutScope): string | null {
  const c = normalizeChord(chord);
  if (!c) return "it is not a keystroke the app can use";
  const all = reservedEverywhere()[c];
  if (all) return all;
  if (scope === "global") {
    // Global keys stay bound while the palette is open: its typing keys
    // must stay free (plain letters, digits, Space, -, ⌫, ↩).
    if (/^([a-z0-9-]|space|backspace|enter)$/.test(c)) return "it types in the command palette's filter";
  } else {
    // Player keys with ⌘ stay bound while the palette is open, over the
    // global ⌘1–⌘9 that pick its items.
    if (/^mod\+[1-9]$/.test(c)) return "it picks a command palette item";
  }
  return null;
}

/** What `chord` would clash with for an action of `scope` (other than
 * `exceptId`): a reserved keystroke, or another action using it — in the
 * same scope, or across global and player (the player's key would hide the
 * global one while it shows). */
export function findClash(chord: string, scope: ShortcutScope, exceptId?: ShortcutId | null): Clash | null {
  const c = normalizeChord(chord);
  const why = reservedReason(chord, scope);
  if (why || !c) return { id: null, label: formatChord(c ?? chord), reason: why ?? "it is not a keystroke" };
  for (const s of SHORTCUTS) {
    if (s.id === exceptId) continue;
    if (chordsFor(s.id).includes(c)) return { id: s.id, label: s.label };
  }
  return null;
}

// --- Capture ------------------------------------------------------------------

/** True while `captureChord` waits for a key: the registry's bindings are
 * off then, so the key pressed never runs the action being changed. */
export const capturing = signal(false);

let captureDone: ((r: string | null) => void) | null = null;
let captureUnbind: (() => void) | null = null;

const CAPTURE_KEYS: string[] = [
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "space", "enter", "escape", "tab", "backspace", "delete",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];

/** The modifier sets, canonical order. */
function modifierSets(): string[][] {
  const other = appleKeys() ? "ctrl" : "cmd";
  const out: string[][] = [];
  for (let bits = 0; bits < 16; bits++) {
    const m: string[] = [];
    if (bits & 1) m.push("mod");
    if (bits & 2) m.push(other);
    if (bits & 4) m.push("alt");
    if (bits & 8) m.push("shift");
    out.push(m);
  }
  return out;
}

/** The keystrokes the platform keeps (keymap.bind throws on them). */
function platformKept(c: string): boolean {
  return appleKeys()
    ? ["mod+q", "mod+h", "mod+alt+h", "mod+m", "mod+ctrl+f"].includes(c)
    : ["mod+q", "alt+f4", "f11"].includes(c);
}

/** Every keystroke `captureChord` listens for: the keys × modifier sets,
 * less the platform's own and plain Tab / ⇧Tab (they keep moving focus). */
export function captureGrid(): string[] {
  const out: string[] = [];
  for (const mods of modifierSets()) {
    for (const key of CAPTURE_KEYS) {
      if (key === "tab" && !mods.some((m) => m !== "shift")) continue;
      const c = [...mods, key].join("+");
      if (!platformKept(c)) out.push(c);
    }
  }
  return out;
}

/** What a captured keystroke means: Esc cancels (null), ⌫ / ⌦ clear (""),
 * anything else is the keystroke. */
export function captureResult(keystroke: string): string | null {
  const c = normalizeChord(keystroke);
  if (!c || c === "escape") return null;
  if (c === "backspace" || c === "delete") return "";
  return c;
}

function endCapture(result: string | null) {
  const done = captureDone;
  captureDone = null;
  const unbind = captureUnbind;
  captureUnbind = null;
  try {
    unbind?.();
  } catch {}
  capturing.set(false);
  done?.(result);
}

/** Waits for the next key press (NSH has no catch-all key event: every
 * keystroke of `captureGrid` is bound for the wait, `when: "always"`, newest
 * so it wins). Resolves to the keystroke (canonical), "" for ⌫ / ⌦ (clear
 * the binding), or null for Esc or `cancelCapture`. */
export function captureChord(): Promise<string | null> {
  if (captureDone) endCapture(null);
  return new Promise<string | null>((resolve) => {
    captureDone = resolve;
    capturing.set(true);
    const fire = (e: { keystroke: string }) => endCapture(captureResult(e.keystroke));
    const grid = captureGrid();
    const unbinds: (() => void)[] = [];
    const bindAll = (keys: string[]) => {
      const map: Record<string, (e: { keystroke: string }) => void> = {};
      for (const k of keys) map[k] = fire;
      unbinds.push(keymap.bind(map, { when: "always" }));
    };
    try {
      bindAll(grid);
    } catch {
      // One keystroke the platform refuses: bind one at a time.
      for (const k of grid) {
        try {
          bindAll([k]);
        } catch {}
      }
    }
    captureUnbind = () => {
      for (const u of unbinds) u();
    };
  });
}

/** Stops a capture in progress (it resolves to null). */
export function cancelCapture() {
  if (captureDone) endCapture(null);
}

// --- Bindings -----------------------------------------------------------------

export interface InstallOptions {
  /** The actions' handlers (and when each does something). */
  handlers: Record<ShortcutId, { run: () => void; enabled?: () => boolean } | (() => void)>;
  /** The player shows (its ⌘ keys are bound). */
  playerShows: () => boolean;
  /** The palette, the source picker or the episode picker is open (the
   * plain player keys are off). */
  pickerOpen: () => boolean;
  /** The palette is open: ⌘1–⌘9 pick its items. */
  paletteOpen: () => boolean;
  /** Picks the palette's item `index` (0-based). */
  choosePaletteItem: (index: number) => void;
}

type Bound = { chord: string; fire: () => void; when: "auto" | "notEditing"; repeat: boolean };

/** Binds `list` grouped by options; a keystroke the platform refuses is
 * skipped (the others still bind). */
function bindList(list: Bound[]) {
  const groups = new Map<string, { when: "auto" | "notEditing"; repeat: boolean; map: Record<string, () => void> }>();
  for (const b of list) {
    const k = `${b.when}|${b.repeat}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { when: b.when, repeat: b.repeat, map: {} }));
    g.map[b.chord] = b.fire;
  }
  for (const g of groups.values()) {
    const opts = { ...(g.when === "notEditing" ? { when: "notEditing" as const } : {}), ...(g.repeat ? { repeat: true } : {}) };
    const hasOpts = g.when === "notEditing" || g.repeat;
    try {
      if (hasOpts) keymap.bind(g.map, opts);
      else keymap.bind(g.map);
    } catch {
      for (const [chord, fire] of Object.entries(g.map)) {
        try {
          if (hasOpts) keymap.bind(chord, fire, opts);
          else keymap.bind(chord, fire);
        } catch {}
      }
    }
  }
}

let installed: InstallOptions | null = null;

/** The handler of an action. */
function handlerOf(id: ShortcutId): () => void {
  const h = installed?.handlers[id];
  if (!h) return () => {};
  if (typeof h === "function") return h;
  return () => {
    if (!h.enabled || h.enabled()) h.run();
  };
}

/** The registry's bindings: three effects (global; the player's ⌘ keys
 * while it shows; its plain keys on the desktop while it shows with no
 * palette or picker open), bound again whenever the keys change, and none
 * while a key is being captured. Call once, inside the app's root. */
export function installShortcuts(opts: InstallOptions) {
  installed = opts;
  void loadShortcuts();

  // Global: always (⌘1–⌘9 pick palette items while it is open; ⌘1 is
  // Home otherwise, by default). Default `when` ("auto"): keystrokes that
  // edit no text also fire while a text field has the keyboard.
  effect(() => {
    if (capturing()) return;
    overrides();
    const list: Bound[] = [];
    const taken = new Set<string>();
    for (const s of SHORTCUTS) {
      if (s.scope !== "global") continue;
      for (const chord of chordsFor(s.id)) {
        if (taken.has(chord)) continue;
        taken.add(chord);
        list.push({ chord, fire: handlerOf(s.id), when: s.when ?? "auto", repeat: !!s.repeat });
      }
    }
    // ⌘1–⌘9: the palette's items while it is open, else whatever has the key.
    for (let i = 1; i <= 9; i++) {
      const chord = `mod+${i}`;
      const prior = list.find((b) => b.chord === chord);
      const otherwise = prior?.fire;
      const fire = () => {
        if (opts.paletteOpen()) opts.choosePaletteItem(i - 1);
        else otherwise?.();
      };
      if (prior) prior.fire = fire;
      else list.push({ chord, fire, when: "auto", repeat: false });
    }
    bindList(list);
  });

  // The player's keys with ⌘ (Ctrl), bound only while it shows (bound keys
  // are consumed, so elsewhere these keystrokes stay free). The volume keys
  // repeat while held, as the arrows do.
  effect(() => {
    if (capturing()) return;
    if (!opts.playerShows()) return;
    overrides();
    const list: Bound[] = [];
    for (const s of SHORTCUTS) {
      if (s.scope !== "player") continue;
      for (const chord of chordsFor(s.id)) {
        if (!hasCommandKey(chord)) continue;
        list.push({ chord, fire: handlerOf(s.id), when: s.when ?? "auto", repeat: !!s.repeat });
      }
    }
    bindList(list);
  });

  // Desktop: the player's plain keys, bound only while it shows with the
  // palette and the pickers closed (bound keys are consumed, so Space and
  // the arrows keep scrolling elsewhere), never while typing.
  effect(() => {
    if (!platform.desktop) return;
    if (capturing()) return;
    if (!opts.playerShows() || opts.pickerOpen()) return;
    overrides();
    const list: Bound[] = [];
    for (const s of SHORTCUTS) {
      if (s.scope !== "player") continue;
      for (const chord of chordsFor(s.id)) {
        if (hasCommandKey(chord)) continue;
        list.push({ chord, fire: handlerOf(s.id), when: "notEditing", repeat: !!s.repeat });
      }
    }
    bindList(list);
  });
}
