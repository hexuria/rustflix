// Settings' own state: the hidden Diagnostics switch, the search query,
// the category shown in the split layouts, the row to highlight, and
// which layout fits the window. No imports beyond nsh, so the schema and
// the tests can read it.

import { computed, host, platform, signal, Storage, windowSize } from "nsh";

// --- Diagnostics: hidden until the version is tapped seven times ----------------

export const DEVMODE_KEY = "rustflix.devmode";

/** The Diagnostics category shows (Storage `rustflix.devmode` = "1"). */
export const devMode = signal(false);
void Storage.getItem(DEVMODE_KEY)
  .then((v) => devMode.set(v === "1"))
  .catch(() => {});

export function setDevMode(on: boolean) {
  devMode.set(on);
  void Storage.setItem(DEVMODE_KEY, on ? "1" : "0").catch(() => {});
}

// --- Navigation inside Settings ---------------------------------------------------

/** What the search field holds (desktop: the title bar's; phones and
 * tablets: the field over the category list). */
export const settingsQuery = signal("");

/** The page shown in the split layouts (desktop, tablet landscape): a
 * category id, or "pick:<row id>" for a value's picker. */
export const selectedPage = signal("general");

/** A row to highlight once its page shows (a search result picked). */
export const highlightRow = signal("");
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

/** Highlights `id` for a moment (its page scrolls it into view). */
export function flashRow(id: string) {
  highlightRow.set(id);
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => highlightRow.set(""), 2600);
}

// --- Layout -----------------------------------------------------------------------

/** Debug: Storage `rustflix.settingslayout` = "tablet" | "phone" treats the
 * device as that (the headless probe, a simulator of the other idiom). */
export const forcedIdiom = signal<"" | "tablet" | "phone">("");
void Storage.getItem("rustflix.settingslayout")
  .then((v) => forcedIdiom.set(v === "tablet" || v === "phone" ? v : ""))
  .catch(() => {});

/** A touch device with a tablet's screen (iPad, an Android tablet). */
export const isTablet = computed(() => {
  if (platform.desktop) return false;
  const f = forcedIdiom();
  if (f) return f === "tablet";
  if (platform.idiom === "pad") return true;
  const w = windowSize();
  return Math.min(w.width, w.height) >= 600;
});

/** A phone (a touch device that is not a tablet). */
export const isPhone = computed(() => !platform.desktop && !isTablet());

/** Categories in a column beside the page: the desktop, and a tablet held
 * landscape at least ~700 pt wide. Else a list that pushes one page per
 * category (phones, tablets in portrait). Follows rotation. */
export const splitLayout = computed(() => {
  if (platform.desktop) return true;
  if (!isTablet()) return false;
  const w = windowSize();
  return w.width >= 700 && w.width > w.height;
});

/** Rows put their control under the label (phones, narrow windows). */
export const stackedRows = computed(() => !platform.desktop && windowSize().width < 600);

// --- iPad hardware keyboard ----------------------------------------------------------

/** A hardware keyboard is attached (iPad: GameController's `GCKeyboard`,
 * through `sys.hardwareKeyboard`); false where it cannot be told. */
export const keyboardAttached = signal(false);
let askingKeyboard = false;

/** Asks the host again (Settings shows). */
export function refreshKeyboard() {
  if (platform.desktop || askingKeyboard) return;
  try {
    if (!host.available()) return;
  } catch {
    return;
  }
  askingKeyboard = true;
  void Promise.resolve(host.call("sys.hardwareKeyboard", {} as never))
    .then((r) => keyboardAttached.set(!!(r as { connected?: unknown } | null)?.connected))
    .catch(() => keyboardAttached.set(false))
    .finally(() => {
      askingKeyboard = false;
    });
}
