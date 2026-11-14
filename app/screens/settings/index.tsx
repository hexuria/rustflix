// Settings: one category at a time, from the schema (schema.ts).
//
// - Desktop: the category column on the left (icons and names, the chosen
//   one filled; ↑ / ↓ move it while no field has the keyboard), the
//   category's page on the right (at most 720 pt wide). Search is the title
//   bar's field (search.tsx `SettingsSearchField`, App.tsx).
// - Tablet held landscape (≥ ~700 pt wide): the same split, the column
//   300 pt wide with the search field on top.
// - Phones, and tablets in portrait: a grouped list (General; Playback;
//   Library; Help) with the search field on top; each category is pushed
//   as its own page on the Settings tab's stack (route `settingsPage`), so
//   the header's back, the swipe back and Android's back leave it. Rotating
//   a tablet switches layouts live.
//
// Debug: Storage `rustflix.opensettings` = {"page":"player"} opens a page at
// launch (also "query", "highlight", "devmode", "taps", "confirm", "key";
// removed after one run unless "keep").

import { computed, effect, platform, Scroll, Storage, Text, untracked, View, keymap, type ScrollRef, type ViewRef } from "nsh";
import { currentTab, goBack, navigate, route, selectTab, tabStack } from "../../lib/router";
import { saveSettings } from "../../lib/store";
import { AboutHeader, AcknowledgementsRow, tapVersion, VersionRow } from "./AboutPage";
import { settingsCtx } from "./ctx";
import { DebugLogRow, FpsRow, RecordingRow } from "./DiagnosticsRows";
import { DownloadFolderRow } from "./DownloadFolder";
import { GesturesList } from "./GesturesPage";
import { KeyboardPage } from "./KeyboardPage";
import { LanguagesList } from "./LanguagesPage";
import { closePicker, openPage, openResult } from "./nav";
import {
  askConfirm,
  CategoryIcon,
  Chevron,
  ConfirmHost,
  customRows,
  rowRefs,
  runAction,
  SectionView,
  setDebugKey,
} from "./rows";
import {
  categoryById,
  findRow,
  groupedCategories,
  visibleCategories,
  visibleSections,
  type CategoryDef,
  type Option,
  type SectionDef,
} from "./schema";

type ListGroup = ReturnType<typeof groupedCategories>[number];
import { SearchBox, SearchResults, SettingsSearchField } from "./search";
import { SourcesList } from "./SourcesPage";
import { CacheRow, LibraryCounts } from "./StoragePage";
import {
  flashRow,
  highlightRow,
  refreshKeyboard,
  selectedPage,
  setDevMode,
  settingsQuery,
  splitLayout,
} from "./state";

export { SettingsSearchField };

// --- Custom rows ---------------------------------------------------------------------

customRows.languages = () => <LanguagesList />;
customRows.downloadFolder = (row) => <DownloadFolderRow row={row} />;
customRows.keyboard = () => <KeyboardPage />;
customRows.gestures = () => <GesturesList />;
customRows.sources = () => <SourcesList />;
customRows["cache:images"] = (row) => <CacheRow row={row} kind="images" />;
customRows["cache:web"] = (row) => <CacheRow row={row} kind="web" />;
customRows["cache:site"] = (row) => <CacheRow row={row} kind="site" />;
customRows.libraryCounts = (row) => <LibraryCounts row={row} />;
customRows.fps = (row) => <FpsRow row={row} />;
customRows.recording = (row) => <RecordingRow row={row} />;
customRows.debugLog = (row) => <DebugLogRow row={row} />;
customRows.version = (row) => <VersionRow row={row} />;
customRows.acknowledgements = (row) => <AcknowledgementsRow row={row} />;

// --- Pages ------------------------------------------------------------------------------

const PAGE_MAX = 720;

/** A page's title: the category's name, or the picked row's label. */
export function settingsPageTitle(page: string): string {
  if (page.startsWith("pick:")) return findRow(page.slice(5))?.row.label ?? "";
  return categoryById(page)?.label ?? "Settings";
}

/** A value's list (a picker row): the choices, the current one checked;
 * a choice applies at once and goes back to the category. */
function PickerBody(props: { rowId: string; showBack: boolean }) {
  const found = findRow(props.rowId);
  if (!found || found.row.control.kind !== "picker") return <View />;
  const { category, row } = found;
  const c = found.row.control;
  return (
    <View class="gap-3">
      <If when={props.showBack}>
        <View
          role="button"
          accessibilityLabel={`Back to ${category.label}`}
          onPress={() => closePicker(category.id)}
          class="cursor-pointer flex-row items-center gap-1 self-start rounded-md py-1 pr-2 hover:bg-muted/50"
        >
          <Text class="text-sm font-medium text-primary">{`‹ ${category.label}`}</Text>
        </View>
      </If>
      <If when={row.description}>
        {(d) => <Text class="px-4 text-xs text-muted-foreground">{d()}</Text>}
      </If>
      <View class="overflow-hidden rounded-xl border border-border bg-card">
        <Each of={c.options()} key={(o: Option) => o.value}>
          {(o, i) => (
            <>
              <If when={i() > 0}>
                <View class="ml-4 h-px bg-border" />
              </If>
              <View
                role="radio"
                accessibilityLabel={o().label}
                accessibilityState={{ checked: c.get() === o().value, selected: c.get() === o().value }}
                onPress={() => {
                  c.set(o().value);
                  closePicker(category.id);
                }}
                class="min-h-12 cursor-pointer flex-row items-center gap-3 px-4 py-2.5 hover:bg-muted/50 active:bg-muted"
              >
                <Text class="flex-1 text-sm text-foreground">{o().label}</Text>
                <If when={c.get() === o().value}>
                  <Text class="text-sm font-bold text-primary">✓</Text>
                </If>
              </View>
            </>
          )}
        </Each>
      </View>
    </View>
  );
}

/** A category's sections (on this device). */
function CategoryBody(props: { category: CategoryDef }) {
  const sections = computed(() => visibleSections(props.category, settingsCtx()));
  return (
    <View class="gap-6">
      <If when={props.category.id === "about"}>
        <AboutHeader />
      </If>
      <Each of={sections()} key={(s: SectionDef) => s.id}>
        {(s) => <SectionView section={s()} />}
      </Each>
    </View>
  );
}

/** A page in its own scroll: a category or a picker. `title`: its name
 * over it (the split layouts; pushed pages have the system header's). */
function PageScroll(props: { page: string; title: boolean; split: boolean }) {
  let scroll: ScrollRef | undefined;
  const category = categoryById(props.page);
  // A highlighted row (a search result) scrolls into view.
  effect(() => {
    const id = highlightRow();
    if (!id) return;
    setTimeout(() => {
      const row = rowRefs.get(id);
      if (!row || !scroll) return;
      void Promise.all([row.measure(), (scroll as ViewRef).measure()]).then(([r, s]) => {
        if (!r || !s) return;
        const y = r.pagePosition.y - s.pagePosition.y - 96;
        if (y > 0) scroll?.scrollTo({ y, animated: true });
      });
    }, 80);
  });
  return (
    <Scroll ref={(r: ScrollRef) => (scroll = r)} class="flex-1">
      <View
        class={props.split ? "w-full gap-5 self-center px-6 pb-10 pt-6" : "w-full gap-5 self-center px-4 pb-10 pt-4"}
        style={{ maxWidth: PAGE_MAX }}
      >
        <If when={props.title}>
          <Text class="px-1 text-2xl font-bold text-foreground">{settingsPageTitle(props.page)}</Text>
        </If>
        <If
          when={category}
          else={<PickerBody rowId={props.page.startsWith("pick:") ? props.page.slice(5) : ""} showBack={props.split} />}
        >
          {(c) => <CategoryBody category={c()} />}
        </If>
      </View>
    </Scroll>
  );
}

/** A pushed category page (phones, tablets in portrait): App.tsx renders
 * it for the `settingsPage` route inside a NavPage titled
 * `settingsPageTitle(page)`. */
export function SettingsPage(props: { page: string }) {
  return <PageScroll page={props.page} title={false} split={false} />;
}

// --- The category list ----------------------------------------------------------------

/** The page's category ("pick:x" → x's category). */
function pageCategory(page: string): string {
  return page.startsWith("pick:") ? findRow(page.slice(5))?.category.id ?? "" : page;
}

/** One category in the split layouts' column. */
function ColumnItem(props: { category: CategoryDef }) {
  const chosen = () => !settingsQuery().trim() && pageCategory(selectedPage()) === props.category.id;
  return (
    <View
      role="tab"
      accessibilityLabel={props.category.label}
      accessibilityState={{ selected: chosen() }}
      onPress={() => {
        settingsQuery.set("");
        selectedPage.set(props.category.id);
      }}
      class={
        chosen()
          ? "min-h-9 cursor-pointer flex-row items-center gap-2.5 rounded-lg bg-white/10 px-2.5 py-1.5"
          : "min-h-9 cursor-pointer flex-row items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-white/5 active:bg-white/10"
      }
    >
      <CategoryIcon category={props.category} size={platform.desktop ? 22 : 28} />
      <Text
        class={chosen() ? "flex-1 text-sm font-semibold text-foreground" : "flex-1 text-sm text-foreground"}
        style={{ numberOfLines: 1 }}
      >
        {props.category.label}
      </Text>
    </View>
  );
}

/** Desktop and tablet landscape: the column and the page. */
function SplitView() {
  const cats = computed(() => visibleCategories(settingsCtx()));
  // Desktop: ↑ / ↓ move through the categories while Settings shows and no
  // field has the keyboard.
  effect(() => {
    if (!platform.desktop || currentTab() !== "settings" || route().name === "player") return;
    const move = (d: 1 | -1) => {
      const list = untracked(cats);
      const at = list.findIndex((c) => c.id === pageCategory(untracked(selectedPage)));
      const next = list[Math.max(0, Math.min(list.length - 1, (at < 0 ? 0 : at) + d))];
      if (next) {
        settingsQuery.set("");
        selectedPage.set(next.id);
      }
    };
    keymap.bind({ up: () => move(-1), down: () => move(1) }, { when: "notEditing" });
  });
  return (
    <View class="flex-1 flex-row">
      <View class="border-r border-border" style={{ width: platform.desktop ? 236 : 300 }}>
        <Scroll class="flex-1">
          <View class="gap-0.5 px-3 pb-6 pt-4">
            <If when={!platform.desktop}>
              <View class="pb-3">
                <Text class="px-1 pb-3 text-3xl font-bold text-foreground">Settings</Text>
                <SearchBox />
              </View>
            </If>
            <Each of={cats()} key={(c: CategoryDef) => c.id}>
              {(c) => <ColumnItem category={c()} />}
            </Each>
          </View>
        </Scroll>
      </View>
      <View class="flex-1">
        <If
          when={settingsQuery().trim()}
          else={
            <Each of={[selectedPage()]} key={(p: string) => p}>
              {(p) => <PageScroll page={p()} title split />}
            </Each>
          }
        >
          <Scroll class="flex-1">
            <View class="w-full self-center px-6 pb-10 pt-6" style={{ maxWidth: PAGE_MAX }}>
              <Text class="px-1 pb-4 text-2xl font-bold text-foreground">Search</Text>
              <SearchResults />
            </View>
          </Scroll>
        </If>
      </View>
    </View>
  );
}

/** Phones and tablets in portrait: the grouped list. */
function ListRoot() {
  const groups = computed(() => groupedCategories(settingsCtx()));
  return (
    <Scroll class="flex-1">
      <View class="w-full gap-5 self-center px-4 pb-10 pt-2" style={{ maxWidth: PAGE_MAX }}>
        <Text class="px-1 text-3xl font-bold text-foreground">Settings</Text>
        <SearchBox />
        <If
          when={settingsQuery().trim()}
          else={
            <Each of={groups()} key={(g: ListGroup) => g.group}>
              {(g) => (
                <View class="gap-1.5">
                  <If when={g().title}>
                    <Text class="px-4 text-xs font-semibold uppercase text-muted-foreground" style={{ letterSpacing: 0.4 }}>
                      {g().title}
                    </Text>
                  </If>
                  <View class="overflow-hidden rounded-xl border border-border bg-card">
                    <Each of={g().items} key={(c: CategoryDef) => c.id}>
                      {(c, i) => (
                        <>
                          <If when={i() > 0}>
                            <View class="ml-[56px] h-px bg-border" />
                          </If>
                          <View
                            role="button"
                            accessibilityLabel={c().label}
                            onPress={() => openPage(c().id)}
                            class="min-h-12 cursor-pointer flex-row items-center gap-3 px-4 py-2 active:bg-muted"
                          >
                            <CategoryIcon category={c()} size={28} />
                            <Text class="flex-1 text-[15px] text-foreground" style={{ numberOfLines: 1 }}>
                              {c().label}
                            </Text>
                            <Text class="text-sm text-muted-foreground" style={{ numberOfLines: 1, maxWidth: 140 }}>
                              {c().summary?.() ?? ""}
                            </Text>
                            <Chevron />
                          </View>
                        </>
                      )}
                    </Each>
                  </View>
                </View>
              )}
            </Each>
          }
        >
          <SearchResults />
        </If>
      </View>
    </Scroll>
  );
}

/** The Settings tab's root page. */
export function Settings() {
  refreshKeyboard();
  effect(() => {
    if (currentTab() === "settings") refreshKeyboard();
  });
  // The split's page must be a category this device lists (Diagnostics
  // hidden again, a category gone with the window's size).
  effect(() => {
    const cats = visibleCategories(settingsCtx());
    const cat = pageCategory(selectedPage());
    if (!cats.some((c) => c.id === cat)) {
      selectedPage.set(cats.some((c) => c.id === "about") && cat === "diagnostics" ? "about" : cats[0]?.id ?? "general");
    }
  });
  // Pushed pages: a tablet turned to landscape shows the page in the split
  // instead; a page this device no longer lists (Diagnostics hidden) goes.
  effect(() => {
    if (platform.desktop || currentTab() !== "settings") return;
    const stack = tabStack("settings");
    const top = stack[stack.length - 1];
    if (!top || top.name !== "settingsPage") return;
    const cat = pageCategory(top.page);
    const listed = visibleCategories(settingsCtx()).some((c) => c.id === cat);
    if (splitLayout()) {
      if (listed) selectedPage.set(top.page);
      navigate({ name: "settings" });
    } else if (!listed) {
      goBack();
    }
  });
  return (
    <View class="flex-1">
      <If when={splitLayout()} else={<ListRoot />}>
        <SplitView />
      </If>
      <ConfirmHost />
    </View>
  );
}

// --- Debug start -------------------------------------------------------------------------

const OPEN_KEY = "rustflix.opensettings";

type OpenReq = {
  /** A category id, or "pick:<row id>". */
  page?: string;
  /** Types into the search field. */
  query?: string;
  /** A row to highlight (with its category opened). */
  highlight?: string;
  /** Diagnostics unlocked (true) or hidden (false) first. */
  devmode?: boolean;
  /** Taps the version this many times (the unlock). */
  taps?: number;
  /** A destructive row whose confirm dialog opens ("storage.clearHistory",
   * "storage.site", "diagnostics.resetLearned"). */
  confirm?: string;
  /** Types a key into a key field, which then saves by itself. */
  key?: { id: "tmdb" | "wyzie" | "subdl"; value: string };
  /** Settings to set first. */
  set?: Record<string, unknown>;
  delay?: number;
  keep?: boolean;
};

async function runOpenSettings() {
  let raw: string | null = null;
  try {
    raw = await Storage.getItem(OPEN_KEY);
  } catch {}
  if (!raw) return;
  let req: OpenReq;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req.keep) await Storage.removeItem(OPEN_KEY).catch(() => {});
  setTimeout(() => {
    if (req.set) void saveSettings(req.set as never);
    if (typeof req.devmode === "boolean") setDevMode(req.devmode);
    selectTab("settings");
    setTimeout(() => {
      if (req.highlight) {
        const f = findRow(req.highlight);
        if (f) openResult(f.category.id, f.row.id);
      } else if (req.page) openPage(req.page);
      if (req.query) settingsQuery.set(req.query);
      for (let i = 0; i < (req.taps ?? 0); i++) tapVersion();
      if (req.key) setDebugKey(req.key.id, req.key.value);
      if (req.confirm) {
        const f = findRow(req.confirm);
        const c = f?.row.control;
        setTimeout(() => {
          if (c?.kind === "action") void runAction(c);
          else if (req.confirm === "storage.site") {
            void askConfirm({
              title: "Clear site data?",
              body: "The video sources forget their cookies and saved settings, and any sign-in on them. Your library and downloads stay.",
              confirm: "Clear site data",
            });
          }
        }, 600);
      }
      if (req.highlight) flashRow(req.highlight);
    }, 400);
  }, req.delay ?? 1500);
}
void runOpenSettings();
