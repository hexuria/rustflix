// rustflix app shell: sidebar navigation + the routed screen.
// The whole UI is TSX; the GPUI host only provides the window.

import { computed, effect, keymap, mount, signal, Text, View } from "nsh";
import { isAvailable as hasWindow, titleBar, Window } from "nsh/desktop";
import { hasKey, loadKey } from "./lib/tmdb";
import { canGoBack, canGoForward, goBack, goForward, navigate, route } from "./lib/router";
import {
  choosePaletteIndex,
  closePalette,
  nextEpisode,
  prevEpisode,
  showPalette,
  showSources,
  togglePalette,
} from "./lib/player";
import { loadLibrary } from "./lib/store";
import { Home } from "./screens/Home";
import { Library } from "./screens/Library";
import { Player } from "./screens/Player";
import { Search } from "./screens/Search";
import { Settings as SettingsScreen } from "./screens/Settings";
import { Setup } from "./screens/Setup";
import { Title } from "./screens/Title";

function NavItem(props: { label: string; active: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      onPress={props.onPress}
      class={
        props.active
          ? "rounded-lg bg-primary/15 px-3 py-2"
          : "rounded-lg px-3 py-2 active:bg-muted"
      }
    >
      <Text
        class={
          props.active
            ? "text-sm font-bold text-primary"
            : "text-sm font-medium text-muted-foreground"
        }
      >
        {props.label}
      </Text>
    </View>
  );
}

function ChromeButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <View
      role="button"
      onPress={props.disabled ? () => {} : props.onPress}
      class={
        props.disabled
          ? "rounded-md px-2 py-1 opacity-30"
          : "rounded-md px-2 py-1 active:bg-muted"
      }
    >
      <Text class="text-sm font-bold text-foreground">{props.label}</Text>
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
// anywhere on it, traffic lights keep their place via `titleBar()`.
function TitleBar() {
  const r = computed(() => route());
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
        <ChromeButton label="‹" onPress={goBack} disabled={!canGoBack()} />
        <ChromeButton label="›" onPress={goForward} disabled={!canGoForward()} />
        <View class="flex-1" />
        <If when={r()?.name === "player"}>
          <View
            role="button"
            onPress={() => {
              showPalette.set(false);
              showSources.set(!showSources());
            }}
            class="rounded-md px-2 py-1 active:bg-muted"
          >
            <Text class="text-sm font-bold text-foreground">⇄</Text>
          </View>
        </If>
        {/* Centered title overlay: ignores pointer so it never blocks
            the nav buttons, the source button or window dragging. */}
        <View class="pointer-events-none absolute inset-0 items-center justify-center">
          <Text
            class="text-sm font-extrabold text-foreground"
            style={{ numberOfLines: 1, maxWidth: "55%" }}
          >
            {playingTitle()}
          </Text>
        </View>
      </View>
    </If>
  );
}

function Shell() {
  const r = computed(() => route());
  const needsSetup = computed(() => !hasKey());
  return (
    <View class="flex-1 flex-row bg-background">
      <If when={r()?.name !== "player"}>
        <View class="w-44 gap-1 border-r border-border p-3">
          <Text class="px-2 pb-3 text-xl font-extrabold text-foreground">rustflix</Text>
          <NavItem label="Home" active={r()?.name === "home"} onPress={() => nav("home")} />
          <NavItem label="Search" active={r()?.name === "search"} onPress={() => nav("search")} />
          <NavItem label="My List" active={r()?.name === "library"} onPress={() => nav("library")} />
          <NavItem label="Settings" active={r()?.name === "settings"} onPress={() => nav("settings")} />
          <View class="flex-1" />
          <If when={needsSetup()}>
            <View role="button" onPress={() => nav("setup")} class="rounded-lg px-3 py-2 active:bg-muted">
              <Text class="text-sm font-medium text-amber-500">⚠ Add TMDB key</Text>
            </View>
          </If>
        </View>
      </If>
      <View class="flex-1">
        <SwitchScreen />
      </View>
    </View>
  );
}

function nav(name: "home" | "search" | "library" | "settings" | "setup") {
  navigate({ name });
}

function SwitchScreen() {
  const r = computed(() => route());
  return (
    <>
      <If when={r()?.name === "home"}>
        <Home />
      </If>
      <If when={r()?.name === "search"}>
        <Search />
      </If>
      <If when={r()?.name === "library"}>
        <Library />
      </If>
      <If when={r()?.name === "settings"}>
        <SettingsScreen />
      </If>
      <If when={r()?.name === "setup"}>
        <Setup />
      </If>
      <If when={r()?.name === "title"}>
        <Title />
      </If>
      <If when={r()?.name === "player"}>
        <Player />
      </If>
    </>
  );
}

// Boot: restore the persisted key and library before any screen mounts,
// so the first fetch already carries the key.
const ready = signal(false);
void Promise.all([loadKey(), loadLibrary()]).then(() => ready.set(true));

export function App() {
  // The system title bar hides; TitleBar below draws our own (the
  // traffic lights stay, in the area `titleBar()` reports).
  Window.setTitleBar({ style: "hidden", height: 40 });

  // The native window title follows the route (movie name while playing).
  effect(() => {
    Window.setTitle(playingTitle());
  });

  // Keyboard shortcuts: mac-style back/forward everywhere, the player's
  // episode/palette keys while a video plays, and ⌘1–⌘9 to pick palette
  // items. Escape dismisses the palette or the source picker.
  effect(() => {
    const digits: Record<string, () => void> = {};
    for (let i = 1; i <= 9; i++) {
      digits[`mod+${i}`] = () => {
        if (showPalette()) choosePaletteIndex(i - 1);
      };
    }
    keymap.bind({
      "mod+[": () => goBack(),
      "mod+]": () => goForward(),
      escape: () => {
        if (showPalette()) closePalette();
        else if (showSources()) showSources.set(false);
      },
      "mod+k": () => {
        if (route().name === "player") togglePalette();
      },
      "mod+n": () => {
        if (route().name === "player") void nextEpisode();
      },
      "mod+p": () => {
        if (route().name === "player") void prevEpisode();
      },
      ...digits,
    });
  });

  return (
    <View class="flex-1 bg-background">
      <If when={ready()}>
        <TitleBar />
        <Shell />
      </If>
    </View>
  );
}

mount(App);
