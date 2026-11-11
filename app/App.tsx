// rustflix app shell: sidebar navigation + the routed screen.
// The whole UI is TSX; the GPUI host only provides the window.

import { computed, mount, Text, View } from "nsh";
import { hasKey, loadKey } from "./lib/tmdb";
import { navigate, route } from "./lib/router";
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

export function App() {
  // Boot: load the persisted key and library once.
  void loadKey();
  void loadLibrary();
  return (
    <View class="flex-1 bg-background">
      <Shell />
    </View>
  );
}

mount(App);
