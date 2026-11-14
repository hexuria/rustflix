// Sources: every video source, the one plays start with (tap to choose),
// and where each plays on this device — the app's own player ("App") or
// the source's page ("Site"), from the source's seed (lib/sources.ts
// `playback`) and what this device learned (lib/playback/caps.ts
// `sourcePlayback`), under the Which player mode. Sources made for one
// language carry its badge. (No reordering: the list has no order of its
// own yet.)

import { Text, View } from "nsh";
import { nativeAvailable, nativeMode, sourcePlayback } from "../../lib/playback/caps";
import { PLAYER_SOURCES, type Source } from "../../lib/sources";
import { saveSettings, settings } from "../../lib/store";
import { Badge } from "../../lib/ui";
import { Glyph } from "../PlayerControls";
import { sourceLanguage } from "./schema";

/** Where `s` plays now: the mode, the platform and the learned capability. */
function playsIn(s: Source): "native" | "web" {
  const m = nativeMode();
  if (m === "0" || s.noNative) return "web";
  if (m === "1") return "native";
  return nativeAvailable() ? sourcePlayback(s.id) : "web";
}

/** Learned on this device (differs from the source's seed). */
function learned(s: Source): boolean {
  return !s.noNative && sourcePlayback(s.id) !== s.playback;
}

function SourceRow(props: { source: Source }) {
  const s = props.source;
  const chosen = () => settings().defaultSource === s.id;
  const lang = sourceLanguage(s.id);
  const where = () => playsIn(s);
  return (
    <View
      role="radio"
      accessibilityLabel={`${s.label}${lang ? `, ${lang}` : ""}, plays in the ${where() === "native" ? "app" : "site"} player`}
      accessibilityState={{ checked: chosen(), selected: chosen() }}
      onPress={() => void saveSettings({ defaultSource: s.id })}
      class="min-h-12 cursor-pointer flex-row items-center gap-3 px-4 py-2.5 hover:bg-muted/50 active:bg-muted"
    >
      <View class="w-5 items-center">
        <If when={chosen()}>
          <Glyph d="check" size={18} color="#e50914" />
        </If>
      </View>
      <View class="flex-1 gap-0.5">
        <View class="flex-row flex-wrap items-center gap-2">
          <Text class={chosen() ? "text-sm font-semibold text-foreground" : "text-sm font-medium text-foreground"}>
            {s.label}
          </Text>
          <If when={lang}>
            <Badge text={lang} />
          </If>
        </View>
        <Text class="text-xs text-muted-foreground">
          {[
            chosen() ? "Default" : "",
            s.movieOnly ? "Movies only" : "",
            s.supportsAnime ? "Anime" : "",
            learned(s) ? "Learned on this device" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <Badge text={where() === "native" ? "App" : "Site"} green={where() === "native"} />
    </View>
  );
}

/** The "sources" custom row: the list. */
export function SourcesList() {
  return (
    <View>
      <Each of={PLAYER_SOURCES} key={(s: Source) => s.id}>
        {(s, i) => (
          <>
            <If when={i() > 0}>
              <View class="ml-12 h-px bg-border" />
            </If>
            <SourceRow source={s()} />
          </>
        )}
      </Each>
    </View>
  );
}
