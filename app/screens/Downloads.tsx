// Downloads: every download the app has started, persisted across
// launches. Finished items play the local file — no stream, no server.

import { computed, Scroll, Text, View } from "nsh";
import {
  canDownload,
  cancelDownload,
  downloads,
  playDownload,
  removeDownload,
  revealDownload,
  type DownloadItem,
} from "../lib/player";

function statusLabel(d: DownloadItem): { text: string; cls: string } {
  if (d.status === "running") {
    return {
      text: `Downloading${d.progress != null ? ` ${d.progress}%` : "…"}`,
      cls: "text-sky-400",
    };
  }
  if (d.status === "done") return { text: "Ready · plays offline", cls: "text-green-500" };
  return { text: d.message || "Failed", cls: "text-red-400" };
}

function Row(props: { d: DownloadItem }) {
  const d = computed(() => props.d);
  const st = computed(() => statusLabel(d()));
  return (
    <View class="flex-row items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <View class="flex-1 flex-col gap-1">
        <Text class="text-sm font-semibold text-zinc-100" style={{ numberOfLines: 1 }}>
          {d().title ?? d().name}
        </Text>
        <Text class={st().cls}>{st().text}</Text>
        <If when={d().status === "running" && d().progress != null}>
          <View class="mt-1 h-1 w-48 rounded bg-zinc-800">
            <View class="h-1 rounded bg-sky-500" style={{ width: `${d().progress ?? 0}%` }} />
          </View>
        </If>
      </View>
      <If when={d().status === "done"}>
        <View
          role="button"
          onPress={() => playDownload(d())}
          class="rounded-lg bg-red-600 px-3 py-1.5 active:opacity-70"
        >
          <Text class="text-xs font-bold text-white">Play</Text>
        </View>
      </If>
      <If when={d().status === "running"}>
        <View
          role="button"
          onPress={() => cancelDownload(d().id)}
          class="rounded-lg border border-zinc-700 px-3 py-1.5 active:bg-zinc-800"
        >
          <Text class="text-xs font-medium text-zinc-300">Cancel</Text>
        </View>
      </If>
      <If when={d().dir}>
        <View
          role="button"
          onPress={() => revealDownload(d())}
          class="rounded-lg border border-zinc-700 px-3 py-1.5 active:bg-zinc-800"
        >
          <Text class="text-xs font-medium text-zinc-300">Show</Text>
        </View>
      </If>
      <View role="button" onPress={() => removeDownload(d())} class="rounded-lg px-2 py-1.5 active:bg-zinc-800">
        <Text class="text-xs text-zinc-500">Remove</Text>
      </View>
    </View>
  );
}

export function Downloads() {
  const list = computed(() =>
    downloads()
      .slice()
      .sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") ||
          (b.createdAt ?? 0) - (a.createdAt ?? 0),
      ),
  );
  return (
    <Scroll class="flex-1">
      <View class="gap-3 p-4">
        <Text class="text-xl font-extrabold text-foreground">Downloads</Text>
        <If when={!canDownload()}>
          <Text class="text-sm text-muted-foreground">
            Downloads need the desktop app — they aren't available on this platform.
          </Text>
        </If>
        <If when={canDownload() && list().length === 0}>
          <Text class="text-sm text-muted-foreground">
            Nothing yet. Open a title, let it play, then use ⬇ Download — finished files play
            here without touching the network.
          </Text>
        </If>
        <Each of={list()}>{(d) => <Row d={d()} />}</Each>
      </View>
    </Scroll>
  );
}
