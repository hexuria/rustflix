// rustflix app shell: sidebar navigation + the routed screen.
// The whole UI is TSX; the GPUI host only provides the window.

import { computed, effect, mount, platform, safeAreaInsets, signal, Storage, Text, untracked, View } from "nsh";
import { isAvailable as hasWindow, titleBar, Window } from "nsh/desktop";
import { createNavStack, Dialog, NavPage, NavStack, Toast, ToastManager, ToastStack } from "nsh/base";
import { BackHandler, TabBar } from "nsh/mobile";
import { hasKey, loadKey } from "./lib/tmdb";
import { setNavButtonsHidden, setPlayerWindow } from "./lib/system";
import {
  canGoBack,
  canGoForward,
  currentTab,
  exitPlayer,
  goBack,
  goForward,
  navigate,
  pagePopped,
  route,
  selectTab,
  tabStack,
  toggleTab,
  type Route,
  type TabName,
} from "./lib/router";
import {
  choosePaletteIndex,
  closePalette,
  loadDownloads,
  nextEpisode,
  onNotify,
  prevEpisode,
  runAutotest,
  seekBy,
  showPalette,
  showSources,
  toggleFullscreen,
  toggleMute,
  togglePalette,
  togglePlay,
  volumeBy,
  playerPhase,
  nativeActive,
  type Notice,
} from "./lib/player";
import { loadLibrary, settings } from "./lib/store";
import { installShortcuts } from "./lib/shortcuts";
import { canDownload, downloadActiveCount, downloadCurrent } from "./lib/downloads";
import { DownloadButton, mediaTarget, playTarget, scrollRowTo } from "./lib/ui";
import { runPerfScript, savePerfRecording, toggleFpsMonitor, watchPerfRoute } from "./lib/perf";
import { isMovie } from "./lib/tmdb";
import { Downloads } from "./screens/Downloads";
import { firstHomeMedia, Home, scrollHomeInstant, scrollHomeTo } from "./screens/Home";
import { PerfFlood, setFlood } from "./screens/PerfFlood";
import { closePlayerPopups } from "./screens/AudioSubsPanel";
import { closeEpisodes, openEpisodes, showEpisodes } from "./screens/EpisodePicker";
import { openSources } from "./screens/SourcePicker";
import { Library, scrollLibraryTo } from "./screens/Library";
import { Player } from "./screens/Player";
import { ResolverHost } from "./screens/ResolverHost";
import { NativePlayerDebug, runNativeTest } from "./screens/NativePlayerDebug";
import { runResolveTest } from "./lib/resolver";
import { focusSearchField, Search } from "./screens/Search";
import {
  Settings as SettingsScreen,
  SettingsPage,
  settingsPageTitle,
  SettingsSearchField,
} from "./screens/Settings";
import { Setup } from "./screens/Setup";
import { runOpenTitleTest, scrollTitleTo, Title } from "./screens/Title";
import { HeroLayer } from "./lib/hero";
import {
  episodeLine,
  Glyph,
  playerDlTarget,
  titleLine,
  type IconName,
} from "./screens/PlayerControls";

function NavItem(props: {
  label: string;
  active: boolean;
  onPress: () => void;
  /** A small red count at the right; hidden at 0. */
  badge?: number;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.badge ? `${props.label}, ${props.badge} active` : props.label}
      onPress={props.onPress}
      class={
        props.active
          ? "cursor-pointer flex-row items-center rounded-lg bg-primary/15 px-3 py-2"
          : "cursor-pointer flex-row items-center rounded-lg px-3 py-2 hover:bg-muted active:bg-muted"
      }
    >
      <Text
        class={
          props.active
            ? "flex-1 text-sm font-bold text-primary"
            : "flex-1 text-sm font-medium text-muted-foreground"
        }
      >
        {props.label}
      </Text>
      <If when={(props.badge ?? 0) > 0}>
        <View class="h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5">
          <Text class="text-[11px] font-bold text-primary-foreground">{String(props.badge)}</Text>
        </View>
      </If>
    </View>
  );
}

// A title bar button: a drawn icon, 28 pt square, highlighted on hover.
// Pressable, so it stays clickable inside the bar's drag region (a view
// with press handlers nearer than the `windowDrag` view wins).
function ChromeButton(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.disabled ? () => {} : props.onPress}
      class={
        props.disabled
          ? "h-7 w-7 items-center justify-center rounded-md opacity-30"
          : "h-7 w-7 items-center justify-center rounded-md hover:bg-muted active:bg-muted"
      }
    >
      <Glyph d={props.icon} size={18} />
    </View>
  );
}

// What the title bar and the window title show: the title being played
// (with its episode) or the app's name everywhere else.
function playingTitle(): string {
  const r = route();
  if (r.name !== "player" || !r.title) return "rustflix";
  const ep = r.season
    ? `S${r.season}E${r.episode ?? 1}`
    : r.episode
      ? `E${r.episode}`
      : "";
  return `${r.title}${ep ? ` — ${ep}` : ""}`;
}

// The window's own title bar (nsh.json `window.titleBar: hidden`): drag
// anywhere on it, traffic lights keep their place via `titleBar()` (0 in
// full screen, where they hide: the bar stays, its buttons move left).
// The title is centred over the whole bar, which spans the window, so it
// is centred in the window whatever the sides hold. On the player route
// it carries the player's back, title and episode, and the download
// button (sources are in the page's own bottom row).
function TitleBar() {
  return (
    <If when={hasWindow}>
      <View
        desktop={{ windowDrag: true }}
        class="flex-row items-center gap-1 border-b border-border bg-card px-2"
        style={{
          height: titleBar().height || 40,
          paddingLeft: titleBar().left + 8,
          paddingRight: titleBar().right + 8,
        }}
      >
        <If
          when={isPlayer()}
          else={
            <>
              <ChromeButton icon="back" label="Back" onPress={goBack} disabled={!canGoBack()} />
              <ChromeButton
                icon="forward"
                label="Forward"
                onPress={goForward}
                disabled={!canGoForward()}
              />
            </>
          }
        >
          <ChromeButton icon="back" label="Back" onPress={exitPlayer} />
        </If>
        <View class="flex-1" />
        <If when={isPlayer()}>
          {/* The playing video's download (the page's own controls have
              none on the desktop). */}
          <DownloadButton
            target={() => playerDlTarget()}
            compact
            onDownload={() => void downloadCurrent()}
          />
        </If>
        {/* Settings' search (screens/settings/search.tsx), while Settings
            shows: "/" or a click focuses it. */}
        <If when={!isPlayer() && currentTab() === "settings"}>
          <SettingsSearchField />
        </If>
        {/* Centred title overlay: ignores the pointer so it never blocks
            the buttons or window dragging. */}
        <View class="pointer-events-none absolute inset-0 items-center justify-center">
          <If
            when={isPlayer()}
            else={
              <Text class="text-sm font-extrabold text-foreground" style={{ numberOfLines: 1, maxWidth: "55%" }}>
                rustflix
              </Text>
            }
          >
            <Text class="text-sm text-foreground" style={{ numberOfLines: 1, maxWidth: "60%" }}>
              <Text class="font-semibold text-foreground">{titleLine() || playingTitle()}</Text>
              <Text class="text-muted-foreground">
                {episodeLine() ? `  ·  ${episodeLine()}` : ""}
              </Text>
            </Text>
          </If>
        </View>
      </View>
    </If>
  );
}

// Toasts: the player's notices (downloads and the like), bottom centre.
// One manager; a layer shows them where it is placed: the phone shell
// (above the tab bar), the phone player's dialog (a dialog is its own
// window layer, over anything the shell draws), the desktop window.
type ToastItem = { id: string; value: string; status: "starting" | "present" | "ending" };

const TOAST_MS = 3500;
const toasts = new ToastManager();
const notices = new Map<string, Notice>();
const shownToasts = signal<ToastItem[]>([]);
const toastsExpanded = signal(false);
let toastTimer: ReturnType<typeof setInterval> | undefined;
let toastCount = 0;

function syncToasts() {
  shownToasts.set(toasts.visible(3) as ToastItem[]);
}

function tickToasts() {
  const a = toasts.advance(toastsExpanded());
  for (const gone of a.removed) notices.delete(gone.id);
  if (a.changed) syncToasts();
  if (toasts.isEmpty() && toastTimer !== undefined) {
    clearInterval(toastTimer);
    toastTimer = undefined;
  }
}

function showNotice(n: Notice) {
  const id = `n${++toastCount}`;
  notices.set(id, n);
  toasts.push(id, id, { timeout: TOAST_MS });
  syncToasts();
  toastTimer ??= setInterval(tickToasts, 50);
}

function dismissToast(id: string) {
  toasts.dismiss(id);
  syncToasts();
  toastTimer ??= setInterval(tickToasts, 50);
}

const NOTICE_DOT: Record<Notice["kind"], string> = {
  info: "bg-primary",
  success: "bg-emerald-500",
  error: "bg-red-500",
};

function ToastItemView(props: { item: ToastItem }) {
  const n = () => notices.get(props.item.id) ?? { text: "", kind: "info" as const };
  return (
    <Toast
      transitionStatus={props.item.status}
      accessibilityLabel={n().text}
      swipeDirection="down"
      onDismissRequest={() => dismissToast(props.item.id)}
      class="flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg transition-all duration-200 ease-out"
      startingClass="opacity-0 translate-y-4"
      endingClass="opacity-0 scale-95"
      swipingClass="transition-none"
    >
      {/* The kind as an accent: a small coloured dot. */}
      <View class={`h-2 w-2 rounded-full ${NOTICE_DOT[n().kind]}`} />
      <Text class="flex-1 text-sm font-medium text-foreground" style={{ numberOfLines: 2 }}>
        {n().text}
      </Text>
    </Toast>
  );
}

/** The toasts at the bottom centre of what holds it (`bottom`: extra room,
 * e.g. the safe area inside the player's dialog). */
function ToastLayer(props: { bottom?: number }) {
  return (
    <View
      class="absolute left-0 right-0 bottom-0 items-center px-4 pt-4"
      style={{ pointerEvents: "box-none", paddingBottom: 16 + (props.bottom ?? 0) }}
    >
      <ToastStack
        placement="bottomCenter"
        style={{ width: 340, maxWidth: "100%" }}
        onExpandedChange={({ expanded }) => toastsExpanded.set(expanded)}
        onCancel={() => {
          const newest = shownToasts().filter((t) => t.status !== "ending").at(-1);
          if (newest) dismissToast(newest.id);
        }}
      >
        <Each of={shownToasts()} key={(t: ToastItem) => t.id}>
          {(t) => <ToastItemView item={t()} />}
        </Each>
      </ToastStack>
    </View>
  );
}

/** The toast layer inside the phone player's dialog, clear of its safe area. */
function DialogToasts() {
  const insets = safeAreaInsets();
  return <ToastLayer bottom={insets().bottom} />;
}

// The pages: the router's stack (every route up to the current one but the
// player) in a native stack, so pages below the top stay mounted with
// their scroll position. On iOS a pushed page (title, setup) gets the
// system header's back button and the left-edge swipe back; a native pop
// removes the page itself, and `onDismiss` tells the router.
// One native stack per tab, all kept mounted once visited, the inactive
// ones hidden (as NSH's navigation guide has tabs keep
// their state (website/docs/navigation.md "Tabs and other layouts"):
// switching tabs shows a stack instead of building its root page again,
// and each page keeps its scroll position. The router keeps every tab's
// stack (lib/router.ts `tabStack`), so a tab shows its last page again.
const TAB_ORDER: TabName[] = ["home", "search", "library", "downloads", "settings"];
const navs = Object.fromEntries(
  TAB_ORDER.map((name) => [
    name,
    createNavStack<Route>(untracked(() => tabStack(name))),
  ]),
) as Record<TabName, ReturnType<typeof createNavStack>>;

/** Tabs whose stack exists: the current one, and (after the app has been
 * idle a moment) the rest, one at a time, so a first visit is as quick as
 * any other (the Search field's first native text field included). */
const mountedTabs = signal<Record<string, boolean>>({ [untracked(currentTab)]: true });
/** The current tab's stack is mounted (called from App). */
function followTabs() {
  effect(() => {
    const tab = currentTab();
    if (!untracked(mountedTabs)[tab]) mountedTabs.set({ ...untracked(mountedTabs), [tab]: true });
  });
}
/** Mounts the stacks not visited yet, one every `gap` ms. */
function premountTabs(gap: number) {
  const next = () => {
    const todo = TAB_ORDER.find(
      (t) => !untracked(mountedTabs)[t] && (t !== "downloads" || canDownload()),
    );
    if (!todo) return;
    mountedTabs.set({ ...untracked(mountedTabs), [todo]: true });
    setTimeout(next, gap);
  };
  setTimeout(next, gap);
}

// The system header of pushed pages (iOS, Android), in the dark theme.
const HEADER_CLASS = "bg-background text-foreground tint-foreground";

const TAB_TITLES: Record<TabName, string> = {
  home: "Home",
  search: "Search",
  library: "My List",
  downloads: "Downloads",
  settings: "Settings",
};

function TabPage(props: { name: TabName; route: Route; children: any }) {
  return (
    // The tab's title is the back button's label on the page above it.
    <NavPage
      title={TAB_TITLES[props.name]}
      headerVisible={false}
      animation="none"
      onDismiss={() => pagePopped(props.route)}
    >
      {/* Below the status bar: the shell no longer pads the stack, so
          pages that want to reach under it (the title page) can. */}
      <View class="flex-1 bg-background" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        {props.children}
      </View>
    </NavPage>
  );
}

function renderPage(r: Route) {
  switch (r.name) {
    case "home":
      return (
        <TabPage name="home" route={r}>
          <Home />
        </TabPage>
      );
    case "search":
      return (
        <TabPage name="search" route={r}>
          <Search />
        </TabPage>
      );
    case "library":
      return (
        <TabPage name="library" route={r}>
          <Library />
        </TabPage>
      );
    case "downloads":
      return (
        <TabPage name="downloads" route={r}>
          <Downloads />
        </TabPage>
      );
    case "settings":
      return (
        <TabPage name="settings" route={r}>
          <SettingsScreen />
        </TabPage>
      );
    case "settingsPage":
      // Phones and tablets in portrait: one Settings category, with the
      // system header's back (screens/settings/index.tsx).
      return (
        <NavPage title={settingsPageTitle(r.page)} headerClass={HEADER_CLASS} onDismiss={() => pagePopped(r)}>
          <View class="flex-1 bg-background">
            <SettingsPage page={r.page} />
          </View>
        </NavPage>
      );
    case "setup":
      return (
        <NavPage title="TMDB key" headerClass={HEADER_CLASS} onDismiss={() => pagePopped(r)}>
          <View class="flex-1 bg-background">
            <Setup />
          </View>
        </NavPage>
      );
    case "title":
      return (
        // Phones: the header is transparent and the page reaches the top of
        // the screen (its image runs under the status bar and the floating
        // back button); the platform's own push and pop. Desktop: a fade,
        // with the page's content veiled and the card's poster flying into
        // its slot (screens/Title.tsx, lib/hero.tsx).
        <NavPage
          title=""
          headerClass={HEADER_CLASS}
          headerTransparent={!platform.desktop}
          animation={platform.desktop ? "fade" : undefined}
          onDismiss={() => pagePopped(r)}
        >
          <View class="flex-1 bg-background">
            <Title route={r} />
          </View>
        </NavPage>
      );
    default:
      // The player never is a page of the stack (it shows over it).
      return (
        <NavPage headerVisible={false}>
          <View class="flex-1 bg-background" />
        </NavPage>
      );
  }
}

/** Tab `name`'s stack: the router's stack of that tab, kept while another
 * tab shows (switching tabs changes no stack). Same route objects keep
 * their pages. */
function TabStack(props: { name: TabName }) {
  const nav = navs[props.name];
  const shown = computed(() => currentTab() === props.name);
  effect(() => {
    nav.setRoutes(tabStack(props.name));
  });
  return (
    // Hidden by opacity, not `display: none`: a virtualized list (Home's
    // rows) under `display: none` loses its cells and does not bind them
    // again when shown (nsh 0.4.0 on iOS). An invisible view is neither
    // drawn (GPUI skips opacity 0; Core Animation does not composite it)
    // nor hit-tested (pointerEvents) nor read out (accessibility), and it
    // keeps its layout, so showing it again lays out nothing.
    <View
      class="absolute inset-0"
      accessibilityElementsHidden={!shown()}
      style={{ opacity: shown() ? 1 : 0, pointerEvents: shown() ? "auto" : "none", zIndex: shown() ? 1 : 0 }}
    >
      <NavStack state={nav} class="flex-1">
        {(r) => renderPage(r)}
      </NavStack>
    </View>
  );
}

function Pages() {
  return (
    <View class="flex-1">
      <Each of={TAB_ORDER}>
        {(name) => (
          <If when={mountedTabs()[name()]}>
            <TabStack name={name()} />
          </If>
        )}
      </Each>
    </View>
  );
}

const isPlayer = computed(() => route().name === "player");

/** Desktop: the player screen (and its one web view) exists. Set at idle
 * after launch, or by the first play if that comes sooner; never unset. */
const playerMounted = signal(false);

// The phone/tablet shell: the system tab bar (UITabBar on iOS) under the
// page stack instead of the desktop sidebar. The player is immersive and
// brings its own controls.
// `icon`: SF Symbols (iOS); `android`: drawables in android/app/src/main/res.
const TABS = [
  { title: "Home", icon: "house", android: "tab_home", route: "home" },
  { title: "Search", icon: "magnifyingglass", android: "tab_search", route: "search" },
  { title: "My List", icon: "bookmark", android: "tab_library", route: "library" },
  { title: "Downloads", icon: "arrow.down.circle", android: "tab_downloads", route: "downloads" },
  { title: "Settings", icon: "gearshape", android: "tab_settings", route: "settings" },
] as const;

/** Android: when the player's dialog last heard the back button. */
let lastPlayerBack = 0;

/** The orientations the phone player allows (iOS; Android's player window
 * is SystemControls.java's): as the device is held, like Android —
 * portrait upright, landscape turned (iPad: every way). For a player that
 * is always landscape on iPhone, make the phone list
 * `["landscape-left", "landscape-right"]`. */
const PLAYER_ORIENTATIONS: ("portrait" | "portrait-upside-down" | "landscape-left" | "landscape-right")[] =
  platform.idiom === "pad"
    ? ["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]
    : ["portrait", "landscape-left", "landscape-right"];

function MobileShell() {
  // The downloads tab only exists where the platform can actually
  // fetch media (iOS native downloader; not on Android).
  const tabs = computed(() =>
    TABS.filter((t) => t.route !== "downloads" || canDownload()),
  );
  const tabIndex = computed(() => tabs().findIndex((t) => t.route === currentTab()));
  // Android: the player's window (landscape, immersive, screen on) while
  // it shows; iOS gets that from the dialog's orientation mask and AVKit.
  // The page under the controls only gets touches when it is "blind"
  // (its own controls are then the transport), as on iOS where the
  // native overlay takes them.
  if (platform.os === "android") {
    effect(() => setPlayerWindow(isPlayer(), playerPhase() === "blind"));
    // The three-button bar stays out of the app while the setting is on.
    effect(() => setNavButtonsHidden(settings().hideNavButtons));
  }
  return (
    <View class="flex-1 flex-col bg-background">
      {/* Keep interactive content clear of the notch and the home
          indicator (0 everywhere they do not apply). The status bar is
          each page's: tab pages pad below it, pages with a system header
          get it from the header, the title page draws under it. */}
      <View
        class="flex-1"
        style={{
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        <Pages />
        {/* Over the pages, right above the tab bar. */}
        <ToastLayer />
      </View>
      <TabBar
        items={tabs().map((t) => ({
          title: t.title,
          icon: platform.select({ ios: t.icon, android: t.android }),
        }))}
        selectedIndex={tabIndex() >= 0 ? tabIndex() : tabs().length}
        onChange={({ index }) => {
          const t = tabs()[index];
          if (t) selectTab(t.route);
        }}
      />
      {/* On touch devices the player lives in a fullscreen dialog over the
          stack: its layer sits above the tab bar and gives the video the
          whole screen. It follows the device (PLAYER_ORIENTATIONS):
          upright it is the portrait player, turned it is the landscape
          one; the full screen button is AVKit's, which goes landscape. */}
      <If when={isPlayer()}>
        <Dialog
          open
          class="absolute inset-0 bg-black"
          presentation="fullScreen"
          ios={{ supportedOrientations: PLAYER_ORIENTATIONS }}
          closeOnEscape={false}
          closeOnBackdropPress={false}
          closeOnSwipe={false}
          // Every close attempt (Android back, a hardware keyboard's
          // Escape) reaches the dialog before the page stack or any back
          // listener; with the closeOn* flags off it stays open, so leave
          // the player here.
          onCancel={() => {
            // Android's back button: the pickers (sources, episodes) and
            // popups close first, as Escape does on the desktop (back()).
            // NSH 0.4.0's Android dialog can report one press twice (its
            // key listener and its OnBackInvokedCallback): one per 400 ms.
            if (platform.os === "android") {
              const now = Date.now();
              if (now - lastPlayerBack < 400) return;
              lastPlayerBack = now;
              return back();
            }
            if (!closePlayerPopups()) exitPlayer();
          }}
        >
          <Player />
          <DialogToasts />
        </Dialog>
      </If>
    </View>
  );
}

function Shell() {
  const r = computed(() => route());
  const needsSetup = computed(() => !hasKey());
  // The sidebar stays laid out under the player (the player covers the
  // whole shell): removing it on open re-laid out every page at the new
  // width (~320 frame updates per open, then again on close).
  const tab = (name: TabName) => currentTab() === name;
  if (!platform.desktop) return <MobileShell />;
  return (
    <View class="flex-1 bg-background">
      <View class="flex-1 flex-row">
        <View class="w-44 gap-1 border-r border-border p-3">
          <Text class="px-2 pb-3 text-xl font-extrabold text-foreground">rustflix</Text>
          <NavItem label="Home" active={tab("home")} onPress={() => selectTab("home")} />
          <NavItem label="Search" active={tab("search")} onPress={() => selectTab("search")} />
          <NavItem label="My List" active={tab("library")} onPress={() => selectTab("library")} />
          <If when={canDownload()}>
            <NavItem
              label="Downloads"
              active={tab("downloads")}
              onPress={() => selectTab("downloads")}
              badge={downloadActiveCount()}
            />
          </If>
          <NavItem label="Settings" active={tab("settings")} onPress={() => selectTab("settings")} />
          <View class="flex-1" />
          <If when={needsSetup()}>
            <View
              role="button"
              onPress={() => navigate({ name: "setup" })}
              class="rounded-lg px-3 py-2 active:bg-muted"
            >
              <Text class="text-sm font-medium text-amber-500">⚠ Add TMDB key</Text>
            </View>
          </If>
        </View>
        <View class="flex-1">
          <Pages />
        </View>
      </View>
        {/* The player shows in place, over the shell (whose pages stay
            mounted), under the title bar. It is mounted once, at idle after launch
            (or by the first play, whichever comes first), and kept: hidden
            by opacity between plays (not drawn, its web view's native view
            hidden by NSH, no hit testing), so opening a play mounts almost
            nothing and never makes a web view (screens/Player.tsx). */}
        <If when={playerMounted()}>
          <View
            class="absolute inset-0 bg-black"
            accessibilityElementsHidden={!isPlayer()}
            style={{
              opacity: isPlayer() ? 1 : 0,
              pointerEvents: isPlayer() ? "auto" : "none",
            }}
          >
            <Player />
          </View>
        </If>
    </View>
  );
}

// Boot: restore the persisted key and library before any screen mounts,
// so the first fetch already carries the key. A failing store must not
// leave a blank window: the app shows with whatever loaded.
const ready = signal(false);
const settle = (load: () => unknown) =>
  Promise.resolve()
    .then(load)
    .catch(() => {});
void Promise.all([settle(loadKey), settle(loadLibrary), settle(loadDownloads)]).then(async () => {
  ready.set(true);
  // The other tabs' stacks, once the first screen has settled.
  setTimeout(() => premountTabs(600), 2500);
  // Desktop: the player screen and its web view (the WKWebView, its
  // process pool and web content process cost 100–300 ms of main thread
  // to make), at idle after the first screen and before the tab premount.
  if (platform.desktop) setTimeout(() => playerMounted.set(true), 1800);
  // Headless verification hook: `rustflix.autotest` in storage drives
  // the player through scripted actions (removed after one run).
  try {
    const raw = await Storage.getItem("rustflix.autotest");
    if (raw) {
      await Storage.removeItem("rustflix.autotest");
      void runAutotest(JSON.parse(raw));
    }
  } catch {}
  // Spike: `rustflix.resolvetest` runs hidden-web-view stream resolves
  // (lib/resolver.ts; removed after one run).
  void runResolveTest().catch(() => {});
  // Debug start route: `rustflix.opentitle` opens a title page
  // (screens/Title.tsx `runOpenTitleTest`).
  void runOpenTitleTest().catch(() => {});
  // Spike: `rustflix.nativetest` plays a resolved stream in the app's own
  // player through the local proxy (screens/NativePlayerDebug.tsx; needs
  // `rustflix.nativeplayer` = "1"; removed after one run).
  void runNativeTest().catch(() => {});
  // Perf scenario: `rustflix.perfscript` scrolls Home, opens and closes a
  // title, switches tabs, with the recorder on (lib/perf.ts; removed
  // after one run).
  void runPerfScript({
    scrollHome: scrollHomeTo,
    scrollHomeInstant,
    flood: setFlood,
    scrollRow: scrollRowTo,
    openFirstTitle: () => {
      const m = firstHomeMedia();
      if (!m) return false;
      navigate({ name: "title", type: isMovie(m) ? "movie" : "tv", id: m.id });
      return true;
    },
    openTitle: (type, id) => navigate({ name: "title", type: type as "movie" | "tv" | "anime", id }),
    scrollTitle: scrollTitleTo,
    scrollLibrary: scrollLibraryTo,
    back: () => back(),
    tab: (name) => selectTab(name as TabName),
    play: () => {
      const m = firstHomeMedia();
      if (!m) return false;
      playTarget(mediaTarget(m));
      return true;
    },
    exitPlayer,
  }).catch(() => {});
});

// Escape and the platform's back (desktop: Alt+Left, the mouse's back
// button): close the palette or the source picker, else go back.
function back() {
  if (closePlayerPopups()) return;
  if (showEpisodes()) closeEpisodes();
  else if (showPalette()) closePalette();
  else if (showSources()) showSources.set(false);
  else if (route().name === "player") exitPlayer();
  else goBack();
}

export function App() {
  // The first play mounts the player screen if idle has not yet.
  effect(() => {
    if (isPlayer() && !untracked(playerMounted)) playerMounted.set(true);
  });
  // The system title bar hides; TitleBar below draws our own (the
  // traffic lights stay, in the area `titleBar()` reports). Desktop only.
  if (hasWindow) {
    Window.setTitleBar({ style: "hidden", height: 40 });
    // The native window title follows the route (movie name while playing).
    effect(() => {
      Window.setTitle(playingTitle());
    });
  }

  // Keyboard shortcuts (lib/shortcuts.ts: the registry, rebindable in
  // Settings → Keyboard shortcuts): mac-style back/forward everywhere, the
  // player's episode/palette keys while a video plays, and ⌘1–⌘9 to pick
  // palette items (fixed). Escape dismisses the palette or the source
  // picker, else goes back (not while typing: there it leaves the field).
  // Screens: ⌘1 Home (palette item 1 while the palette is open), ⌘F Search
  // (its field focused), ⌘L My List, ⌘D Downloads, ⌘, Settings — from any
  // screen; from the player through the router, whose leave hook saves
  // and stops it (the play stays on the trail, resumable). Each toggles
  // (router `toggleTab`): the same shortcut again while its tab shows goes
  // back to where the shortcuts started (the player resumes). The player's
  // ⌘ keys are bound while it shows; its plain keys (Space, F, M, arrows)
  // on the desktop while it shows with no palette or picker open, never
  // while typing. The arrows and the volume keys repeat while held.
  // Keystrokes match exactly: ⌘⇧F never also fires ⌘F, nor the plain F
  // (nsh-core keymap.rs `Keymap::find`).
  {
    const screen = (name: TabName) => {
      if (name === "downloads" && !canDownload()) return;
      if (route().name === "player") closePlayerPopups();
      toggleTab(name);
    };
    // Settings → Player → Seek step (5 / 10 / 15 / 30 s).
    const seekStep = () => settings().seekStep || 10;
    installShortcuts({
      playerShows: () => isPlayer(),
      pickerOpen: () => showPalette() || showSources() || showEpisodes(),
      paletteOpen: () => showPalette(),
      choosePaletteItem: (i) => choosePaletteIndex(i),
      handlers: {
        home: () => screen("home"),
        search: () => {
          screen("search");
          if (currentTab() === "search" && route().name === "search") focusSearchField();
        },
        library: () => screen("library"),
        downloads: () => screen("downloads"),
        settings: () => screen("settings"),
        back: () => goBack(),
        forward: () => goForward(),
        dismiss: () => back(),
        // The FPS monitor, on every screen (the player too).
        fpsMonitor: () => toggleFpsMonitor(),
        // Saves the recording the monitor keeps (the files get timestamped
        // names; a toast says where).
        saveRecording: () => void savePerfRecording(),
        palette: { run: () => togglePalette(), enabled: () => route().name === "player" },
        nextEpisode: { run: () => void nextEpisode(), enabled: () => route().name === "player" },
        prevEpisode: { run: () => void prevEpisode(), enabled: () => route().name === "player" },
        sources: () => openSources(),
        download: { run: () => void downloadCurrent(), enabled: () => route().name === "player" },
        episodes: {
          run: () => openEpisodes(),
          enabled: () => {
            const r = route();
            return r.name === "player" && r.type !== "movie";
          },
        },
        playPause: () => togglePlay(),
        fullscreen: () => toggleFullscreen(),
        mute: () => toggleMute(),
        seekBack: () => seekBy(-seekStep()),
        seekForward: () => seekBy(seekStep()),
        volumeUp: () => volumeBy(0.1),
        volumeDown: () => volumeBy(-0.1),
      },
    });
  }

  // The player's notices as toasts.
  effect(() => onNotify(showNotice));

  followTabs();

  // The perf recorder hears the route (nothing while it is off).
  watchPerfRoute(effect);

  // Desktop: the platform's back (Alt+Left, the Back key, the mouse's
  // back button; Escape when no binding took it) comes to the app before
  // the page stack, so the player and the router's history stay in step.
  effect(() => {
    if (!platform.desktop) return;
    BackHandler.on("press", () => {
      back();
      return true;
    });
  });

  return (
    <View class="flex-1 bg-background">
      <If when={ready()}>
        <TitleBar />
        <Shell />
        {/* Desktop toasts (the phone shell places its own). While the
            player shows a page, the page shows them over the video; over
            the app's own player they are drawn here. */}
        <If when={platform.desktop && (!isPlayer() || nativeActive())}>
          <ToastLayer bottom={isPlayer() ? 96 : 0} />
        </If>
        {/* The desktop's poster flights, over everything. */}
        <If when={platform.desktop}>
          <HeroLayer />
        </If>
      </If>
      {/* The perf self-test's views (nothing unless a `flood` step runs). */}
      <PerfFlood />
      {/* Spike: hidden web view for lib/resolver.ts (nothing unless active). */}
      <ResolverHost />
      {/* Spike: the native player's debug screen (nothing unless its hook runs). */}
      <NativePlayerDebug />
    </View>
  );
}

mount(App);
