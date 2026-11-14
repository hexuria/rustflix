// Downloads: what is downloading and what is next on top, what needs the
// user below it, finished downloads grouped by title last. Finished items
// play the local copy — no stream, no network.
//
// Every row has one anatomy, whatever its state: a 16:9 thumbnail (112 pt
// on phones) with the progress under it while it runs; the title (up to two
// lines) and one short status line in plain words, coloured by state
// (wrapping, never cut); ONE trailing 44 pt control for the state's main
// action. Everything else — the explanation, Remove, Cancel, reordering —
// is behind a tap on the row (an action sheet that says what happened) and
// on long press / right click (the download menu). Rows are separated by
// hairlines on the page's 16 pt gutter, not boxed.
//
// Sections: "Downloading · n", "Up next · n" (queued), "Needs attention ·
// n" (failed, cancelled and play-once-to-download, each saying what to do),
// "Downloaded · n" (by title, newest first). Every list is keyed by the
// entry's `key`: a progress tick updates its row instead of rebuilding the
// list (`dlId` can change once on the iPhone, `key` never does).
//
// Debug: Storage `rustflix.dlfixture` = "1" shows a fixed set of entries
// in every state instead of the real list (screenshots; its actions only
// say so).

import { computed, effect, Image, platform, Scroll, signal, Storage, Text, untracked, View } from "nsh";
import { AlertDialog } from "nsh/base";
import { formatBytes } from "../lib/cache";
import {
  canDownload,
  cancelDownload,
  downloadFor,
  downloadList,
  downloadQueue,
  downloadSpace,
  moveDownload,
  refreshDownloadSpace,
  removeWatchedDownloads,
  retryDownload,
  type DlEntry,
} from "../lib/downloads";
import { debug, notify } from "../lib/player";
import { itemKey, progress } from "../lib/store";
import { currentTab } from "../lib/router";
import {
  confirmRemoveDownload,
  ControlGlyph,
  downloadReason,
  EmptyState,
  knownPoster,
  openDownloadMenu,
  playDownloadOf,
  type ControlIcon,
} from "../lib/ui";
import { Glyph, icon, progressRing, Spinner } from "./PlayerControls";

const desktop = platform.desktop;

/** The page's gutter. */
const GUTTER = 16;
/** The thumbnail: 16:9. */
const THUMB_W = desktop ? 128 : 112;
const THUMB_H = Math.round((THUMB_W * 9) / 16);

const MUTED = "text-zinc-400";
const ATTENTION = "text-amber-400";
const ACTIVE = "text-sky-300";

// --- Debug fixture -------------------------------------------------------------------

const fixtureOn = signal(false);
/** "done": the fixture's finished and failed entries only (the lower
 * sections at the top of the screen). */
let fixtureDoneOnly = false;
void Storage.getItem("rustflix.dlfixture")
  .then((v) => {
    fixtureDoneOnly = v === "done";
    fixtureOn.set(v === "1" || v === "done");
  })
  .catch(() => {});

const FX_POSTER = "https://image.tmdb.org/t/p/w342/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg";
const FX_STILL = (p: string) => `https://image.tmdb.org/t/p/w300${p}`;

function fx(
  n: number,
  state: DlEntry["state"],
  extra: Partial<DlEntry> & { still?: string; name?: string },
): DlEntry {
  const base: DlEntry = {
    type: "tv",
    id: 1396,
    season: 1,
    episode: n,
    title: "Breaking Bad",
    episodeName: extra.name,
    poster: FX_POSTER,
    still: extra.still ? FX_STILL(extra.still) : undefined,
    dlId: 9000 + n,
    key: `fx:${n}:${state}`,
    name: "",
    state,
    progress: null,
    message: "",
    reason: null,
    bytes: null,
    waiting: null,
    source: "vidfast",
    createdAt: Date.now() - n * 60_000,
    finishedAt: state === "done" ? Date.now() - n * 60_000 : null,
  };
  return { ...base, ...extra, still: base.still };
}

const FIXTURE: DlEntry[] = [
  fx(4, "running", { name: "Cancer Man", still: "/i5BAJVhuIWfkoSqDID6FnQNCTVc.jpg", progress: 42, bytes: 310_000_000 }),
  fx(5, "queued", { name: "Gray Matter", still: "/82G3wZgEvZLKcte6yoZJahUWBtx.jpg" }),
  fx(6, "queued", { name: "Crazy Handful of Nothin'", still: "/rCCLuycNPL30W3BtuB8HafxEMYz.jpg", waiting: "wifi" }),
  fx(7, "resolving", { name: "A No Rough Stuff Type Deal", still: "/1dgFAsajUpUT7DLXgAxHb9GyXHH.jpg" }),
  fx(3, "needsPlay", { name: "...And the Bag's in the River", still: "/n8Dah3Tc1vlc4i7bQ9zYPWaFO0e.jpg" }),
  fx(8, "error", { name: "Seven Thirty-Seven", reason: "cancelled", bytes: 535_000_000, season: 2, episode: 1, still: "/1dgFAsajUpUT7DLXgAxHb9GyXHH.jpg" }),
  fx(9, "error", { name: "Grilled", reason: "expired", season: 2, episode: 2, still: "/82G3wZgEvZLKcte6yoZJahUWBtx.jpg" }),
  fx(1, "done", { name: "Pilot", still: "/ydlY3iPfeOAvu8gVqrxPoMvzNCn.jpg", bytes: 742_000_000 }),
  fx(2, "done", { name: "Cat's in the Bag...", still: "/AbMoecO0ZZio0LcgeLxlzdyGs6X.jpg", bytes: 690_000_000 }),
  {
    ...fx(0, "done", { bytes: 1_480_000_000 }),
    type: "movie",
    id: 550,
    season: undefined,
    episode: undefined,
    title: "Fight Club",
    poster: "https://image.tmdb.org/t/p/w342/jSziioSwPVrOy9Yow3XhWIBDjq1.jpg",
    key: "fx:movie",
  },
];

// --- Helpers ---------------------------------------------------------------------

/** How much of an entry was watched (0..1), from saved progress — the
 * engine's rule for "Delete watched" (season 1 / episode 1 also match the
 * older keys without them). */
function watched(e: DlEntry): number {
  const keys = new Set<string>([e.key]);
  if (e.type === "tv" && (e.season ?? 1) === 1) keys.add(itemKey("tv", e.id, 0, e.episode ?? 1));
  if (e.type === "anime" && (e.episode ?? 1) === 1) keys.add(itemKey("anime", e.id, 0, 0));
  let best = 0;
  for (const p of progress()) {
    if (keys.has(p.key) && p.duration > 0) best = Math.max(best, p.position / p.duration);
  }
  return best;
}

const isWatched = (e: DlEntry) => watched(e) >= 0.95;

/** "S1 · E3 · …And the Bag's in the River" (anime: "E3 · Name"). */
function episodeText(e: DlEntry): string {
  const n = e.episode ?? 1;
  const parts = [e.type === "tv" ? `S${e.season ?? 1}` : "", `E${n}`, e.episodeName ?? ""];
  if (e.type === "anime" && e.lang === "dub") parts.push("Dub");
  return parts.filter(Boolean).join(" · ");
}

/** A row's title: the movie, or the episode ("S1 · E3 · Name"); the show
 * is the small line above it outside its show's group (`showLine`). */
function rowTitle(e: DlEntry, _inGroup = false): string {
  return e.type === "movie" ? e.title : episodeText(e);
}

/** The show above an episode's title, outside its show's group. */
function showLine(e: DlEntry, inGroup = false): string {
  return e.type === "movie" || inGroup ? "" : e.title;
}

/** Bytes per second while running, from the row's own byte reports
 * (per entry key; nothing per frame). */
const rates = new Map<string, { at: number; bytes: number; rate: number }>();
function rateOf(e: DlEntry): number {
  const b = e.bytes ?? 0;
  const now = Date.now();
  const last = rates.get(e.key);
  if (!last || b < last.bytes) {
    rates.set(e.key, { at: now, bytes: b, rate: 0 });
    return 0;
  }
  const dt = (now - last.at) / 1000;
  if (dt < 1.5) return last.rate;
  const inst = (b - last.bytes) / dt;
  const rate = last.rate ? last.rate * 0.6 + inst * 0.4 : inst;
  rates.set(e.key, { at: now, bytes: b, rate });
  return rate;
}

/** The status line: short, plain words, and its colour. */
function statusOf(e: DlEntry): { text: string; cls: string } {
  switch (e.state) {
    case "running": {
      if (e.waiting === "wifi") return { text: "Paused · waiting for Wi-Fi", cls: MUTED };
      if (e.waiting === "network") return { text: "Paused · waiting for a connection", cls: MUTED };
      const parts = ["Downloading"];
      const pct = e.progress;
      if (pct != null) parts.push(`${Math.round(pct)}%`);
      if (e.bytes) {
        const total = pct && pct > 1 ? (e.bytes * 100) / pct : 0;
        parts.push(total ? `${formatBytes(e.bytes)} of ${formatBytes(total)}` : formatBytes(e.bytes));
      }
      const r = rateOf(e);
      if (r > 1024) parts.push(`${formatBytes(r)}/s`);
      return { text: parts.join(" · "), cls: ACTIVE };
    }
    case "resolving":
      return { text: "Getting the video link…", cls: ACTIVE };
    case "queued":
      if (e.waiting === "wifi") return { text: "Waiting for Wi-Fi", cls: MUTED };
      if (e.waiting === "network") return { text: "Waiting for a connection", cls: MUTED };
      return { text: "Up next", cls: MUTED };
    case "needsPlay":
      return { text: "Play once to start the download", cls: ATTENTION };
    case "error":
      switch (e.reason) {
        case "cancelled":
          return { text: e.bytes ? `Cancelled · ${formatBytes(e.bytes)} kept` : "Cancelled", cls: MUTED };
        case "expired":
          return { text: "The link expired · retry to continue", cls: ATTENTION };
        case "space":
          return { text: "Not enough free space", cls: ATTENTION };
        case "drm":
          return { text: "Protected video · can't be saved", cls: ATTENTION };
        case "nolink":
          return { text: "No video link found · try again later", cls: ATTENTION };
        default:
          return { text: "Download failed · tap for details", cls: ATTENTION };
      }
    case "done": {
      const parts = [e.bytes ? formatBytes(e.bytes) : "Downloaded"];
      if (isWatched(e)) parts.push("Watched");
      return { text: parts.join(" · "), cls: MUTED };
    }
  }
}

/** What a tap on the row explains, in full. */
function detailOf(e: DlEntry): string {
  switch (e.state) {
    case "needsPlay":
      return "This site only hands out the video link to its player. Play the episode once and the download starts by itself — you can stop watching right away.";
    case "error":
      if (e.reason === "cancelled") {
        return e.bytes
          ? `You cancelled it. The ${formatBytes(e.bytes)} already saved are kept: resuming continues from there.`
          : "You cancelled it.";
      }
      return downloadReason(e);
    case "queued":
      return e.waiting === "wifi"
        ? "It starts once you are on Wi-Fi (Settings › Downloads › Wi-Fi only)."
        : "It starts when the download before it finishes.";
    case "running":
    case "resolving":
      return "One download runs at a time; the next one starts when this finishes.";
    default:
      return "";
  }
}

/** The finished downloads of one title. */
interface Group {
  key: string;
  title: string;
  poster?: string;
  still?: string;
  movie: boolean;
  entries: DlEntry[];
  bytes: number;
  newest: number;
}

function groupsOf(done: DlEntry[]): Group[] {
  const map = new Map<string, Group>();
  for (const e of done) {
    const k = `${e.type}:${e.id}`;
    let g = map.get(k);
    if (!g) {
      g = {
        key: k,
        title: e.title,
        poster: e.poster,
        still: e.still,
        movie: e.type === "movie",
        entries: [],
        bytes: 0,
        newest: 0,
      };
      map.set(k, g);
    }
    g.entries.push(e);
    g.bytes += e.bytes ?? 0;
    g.newest = Math.max(g.newest, e.finishedAt ?? e.createdAt);
    if (!g.poster && e.poster) g.poster = e.poster;
    if (!g.still && e.still) g.still = e.still;
  }
  const list = [...map.values()];
  for (const g of list) {
    g.entries.sort(
      (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0),
    );
  }
  return list.sort((a, b) => b.newest - a.newest);
}

/** Groups open in the Downloaded section (kept while the app runs). */
const expanded = signal<Record<string, true>>({});

function toggleGroup(key: string) {
  const cur = { ...untracked(expanded) };
  if (cur[key]) delete cur[key];
  else cur[key] = true;
  expanded.set(cur);
}

/** The live entry for a row's target (its `dlId` may have changed). */
function live(e: DlEntry): DlEntry | null {
  return downloadFor(e.type, e.id, e.season, e.episode);
}

// --- Actions -------------------------------------------------------------------------

let sheetOpen = false;

/** A tap on a row: what happened in full, and what can be done. */
async function openRowSheet(e: DlEntry) {
  if (sheetOpen) return;
  if (untracked(fixtureOn)) {
    notify(`Fixture row: ${statusOf(e).text}`, "info");
    return;
  }
  const actions: { id: string; label: string; role?: "destructive" | "cancel" | "default" }[] = [];
  const queue = downloadQueue();
  switch (e.state) {
    case "needsPlay":
      actions.push({ id: "play", label: "Play now" });
      actions.push({ id: "remove", label: "Remove", role: "destructive" });
      break;
    case "error":
      actions.push({ id: "retry", label: e.reason === "cancelled" ? "Resume download" : "Retry" });
      actions.push({ id: "remove", label: "Remove", role: "destructive" });
      break;
    case "queued": {
      const first = queue.findIndex((x) => x.state === "queued");
      const at = queue.findIndex((x) => x.key === e.key);
      if (at > first) actions.push({ id: "next", label: "Download next" });
      actions.push({ id: "cancel", label: "Cancel download", role: "destructive" });
      break;
    }
    case "running":
    case "resolving":
      actions.push({ id: "cancel", label: "Cancel download", role: "destructive" });
      break;
    case "done":
      actions.push({ id: "play", label: "Play" });
      actions.push({ id: "remove", label: "Delete download", role: "destructive" });
      break;
  }
  sheetOpen = true;
  try {
    const { action } = await AlertDialog.show({
      title: rowTitle(e),
      description: detailOf(e) || undefined,
      presentation: desktop ? undefined : "actionSheet",
      actions: [...actions, { id: "close", label: "Close", role: "cancel" }],
    });
    const cur = live(e);
    if (action === "play") playDownloadOf(e);
    else if (action === "retry" && cur) retryDownload(cur.dlId);
    else if (action === "cancel" && cur) cancelDownload(cur.dlId);
    else if (action === "remove") void confirmRemoveDownload(e);
    else if (action === "next" && cur) {
      const first = downloadQueue().findIndex((x) => x.state === "queued");
      if (first >= 0) moveDownload(cur.dlId, first);
    }
  } catch (err) {
    debug("downloads: row sheet failed", String(err));
  } finally {
    sheetOpen = false;
  }
}

function rowMenu(e: DlEntry, at?: { x: number; y: number }) {
  if (untracked(fixtureOn)) return;
  void openDownloadMenu(e, at);
}

// --- Pieces ----------------------------------------------------------------------

/** "Downloading · 1": sentence case with the count; an optional action at
 * the right. */
function SectionHeader(props: { text: string; count: number; action?: { label: string; onPress: () => void } }) {
  return (
    <View class="flex-row items-center pt-6" style={{ minHeight: 44 }}>
      <Text class="flex-1 font-bold text-foreground" style={{ fontSize: 17, lineHeight: 22 }}>
        {`${props.text} · ${props.count}`}
      </Text>
      <If when={props.action}>
        {(a) => (
          <View
            role="button"
            accessibilityLabel={a().label}
            onPress={a().onPress}
            class="cursor-pointer justify-center active:opacity-60"
            style={{ height: 44 }}
          >
            <Text class="font-semibold text-primary" style={{ fontSize: 14, lineHeight: 18 }}>
              {a().label}
            </Text>
          </View>
        )}
      </If>
    </View>
  );
}

/** The 16:9 thumbnail: the episode's still, else the poster centred on a
 * dark frame (never stretched), else a drawn film mark; a progress bar
 * along its bottom while it runs. */
function Thumb(props: { e?: DlEntry; still?: string; poster?: string; type?: DlEntry["type"]; id?: number }) {
  const failed = signal(false);
  const still = computed(() => props.still ?? props.e?.still ?? "");
  const poster = computed(
    () =>
      props.poster ??
      props.e?.poster ??
      ((props.type ?? props.e?.type) && (props.id ?? props.e?.id)
        ? knownPoster((props.type ?? props.e?.type)!, (props.id ?? props.e?.id)!)
        : "") ??
      "",
  );
  const running = computed(() => props.e?.state === "running" && props.e.progress != null);
  return (
    <View
      class="items-center justify-center overflow-hidden bg-white/5"
      style={{ width: THUMB_W, height: THUMB_H, borderRadius: 6 }}
    >
      <If
        when={!failed() && (still() || poster())}
        else={<Glyph d="film" size={24} color="#71717a" />}
      >
        <If
          when={still()}
          else={
            <Image
              src={poster()}
              onError={() => failed.set(true)}
              style={{ width: Math.round((THUMB_H * 2) / 3), height: THUMB_H, objectFit: "cover" }}
            />
          }
        >
          <Image
            src={still()}
            onError={() => failed.set(true)}
            style={{ width: THUMB_W, height: THUMB_H, objectFit: "cover" }}
          />
        </If>
      </If>
      <If when={running()}>
        <View class="absolute bottom-0 left-0 right-0 bg-black/60" style={{ height: 3 }}>
          <View class="bg-primary" style={{ height: 3, width: `${props.e?.progress ?? 0}%` }} />
        </View>
      </If>
    </View>
  );
}

/** A 44 pt icon button: the row's one control. */
function TrailBtn(props: { icon: ControlIcon; label: string; color?: string; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class="cursor-pointer items-center justify-center rounded-full hover:bg-white/10 active:opacity-60"
      style={{ width: 44, height: 44, marginRight: -10 }}
    >
      <ControlGlyph name={props.icon} size={24} color={props.color} />
    </View>
  );
}

/** One row, every state: thumbnail, title + status, one control. A tap
 * explains (done: plays); long press / right click: the download menu. */
function Row(props: { e: DlEntry; inGroup?: boolean }) {
  const e = computed(() => props.e);
  const status = computed(() => statusOf(e()));
  const fixture = () => untracked(fixtureOn);
  const primary = () => {
    const x = e();
    if (fixture()) return void notify(`Fixture row: ${status().text}`, "info");
    if (x.state === "done" || x.state === "needsPlay") return playDownloadOf(x);
    const cur = live(x);
    if (x.state === "error" && cur) retryDownload(cur.dlId);
  };
  return (
    <View
      role="button"
      accessibilityLabel={`${[showLine(e(), props.inGroup), rowTitle(e(), props.inGroup)].filter(Boolean).join(", ")}, ${status().text}`}
      onPress={() => (e().state === "done" && !fixture() ? playDownloadOf(e()) : void openRowSheet(e()))}
      onLongPress={desktop ? undefined : () => rowMenu(e())}
      onContextMenu={(ev: { pagePosition: { x: number; y: number } }) => rowMenu(e(), ev.pagePosition)}
      class="cursor-pointer flex-row items-center gap-3 border-b border-white/5 hover:bg-white/5 active:bg-white/10"
      style={{
        marginLeft: -GUTTER,
        marginRight: -GUTTER,
        paddingLeft: GUTTER,
        paddingRight: GUTTER,
        paddingTop: 10,
        paddingBottom: 10,
      }}
    >
      <Thumb e={e()} />
      <View class="flex-1 gap-1">
        <If when={showLine(e(), props.inGroup)}>
          <Text class={MUTED} style={{ fontSize: 12, lineHeight: 16, numberOfLines: 1 }}>
            {showLine(e(), props.inGroup)}
          </Text>
        </If>
        <Text class="font-semibold text-foreground" style={{ fontSize: 15, lineHeight: 20, numberOfLines: 2 }}>
          {rowTitle(e(), props.inGroup)}
        </Text>
        <Text class={status().cls} style={{ fontSize: 13, lineHeight: 18, numberOfLines: 2 }}>
          {status().text}
        </Text>
      </View>
      <If when={e().state === "running" || e().state === "resolving" || e().state === "queued"}>
        {/* The state's mark — the progress ring while it runs, a spinner
            while it gets the link, a clock while it waits: a tap cancels,
            as everywhere else (the sheet says so first on a tap of the
            row). */}
        <View
          role="button"
          accessibilityLabel={`Cancel ${rowTitle(e(), props.inGroup)}`}
          onPress={() => {
            if (fixture()) return void notify("Fixture row: cancel", "info");
            const cur = live(e());
            if (cur) cancelDownload(cur.dlId);
          }}
          class="cursor-pointer items-center justify-center rounded-full hover:bg-white/10 active:opacity-60"
          style={{ width: 44, height: 44, marginRight: -10 }}
        >
          <If when={e().state === "running"}>
            <Image
              src={icon(progressRing(e().progress == null ? null : e().progress! / 100), 28)}
              class={e().progress == null ? "animate-spin" : ""}
              style={{ width: 28, height: 28 }}
            />
          </If>
          <If when={e().state === "resolving"}>
            <Spinner size={24} />
          </If>
          <If when={e().state === "queued"}>
            <Glyph d="clock" size={24} color="#a1a1aa" />
          </If>
        </View>
      </If>
      <If when={e().state === "needsPlay"}>
        <TrailBtn icon="play" label="Play once to start the download" onPress={primary} />
      </If>
      <If when={e().state === "error"}>
        <TrailBtn
          icon="retry"
          label={e().reason === "cancelled" ? "Resume download" : "Retry download"}
          onPress={primary}
        />
      </If>
      <If when={e().state === "done"}>
        <TrailBtn icon="playCircle" label={`Play ${rowTitle(e(), props.inGroup)}`} onPress={primary} />
      </If>
    </View>
  );
}

/** A title with downloaded episodes: "Breaking Bad" on its own line,
 * "3 episodes · 1.4 GB"; a tap opens it to its episodes. */
function GroupRow(props: { g: Group }) {
  const g = computed(() => props.g);
  const open = computed(() => !!expanded()[g().key]);
  const sub = computed(() => {
    const n = g().entries.length;
    const parts = [`${n} episode${n === 1 ? "" : "s"}`];
    if (g().bytes > 0) parts.push(formatBytes(g().bytes));
    return parts.join(" · ");
  });
  return (
    <View>
      <View
        role="button"
        accessibilityLabel={`${g().title}, ${sub()}`}
        onPress={() => toggleGroup(g().key)}
        class="cursor-pointer flex-row items-center gap-3 border-b border-white/5 hover:bg-white/5 active:bg-white/10"
        style={{
          marginLeft: -GUTTER,
          marginRight: -GUTTER,
          paddingLeft: GUTTER,
          paddingRight: GUTTER,
          paddingTop: 10,
          paddingBottom: 10,
        }}
      >
        <Thumb still={g().still} poster={g().poster} type={g().entries[0].type} id={g().entries[0].id} />
        <View class="flex-1 gap-1">
          <Text class="font-semibold text-foreground" style={{ fontSize: 15, lineHeight: 20, numberOfLines: 2 }}>
            {g().title}
          </Text>
          <Text class={MUTED} style={{ fontSize: 13, lineHeight: 18 }}>
            {sub()}
          </Text>
        </View>
        <View class="items-center justify-center" style={{ width: 44, height: 44, marginRight: -10 }}>
          <Glyph d={open() ? "chevUp" : "chevDown"} size={22} color="#a1a1aa" />
        </View>
      </View>
      <If when={open()}>
        <Each of={g().entries} key={(x: DlEntry) => x.key}>
          {(x) => <Row e={x()} inGroup />}
        </Each>
      </If>
    </View>
  );
}

// --- Screen ----------------------------------------------------------------------

let deletingWatched = false;

async function deleteWatched(n: number) {
  if (deletingWatched) return;
  deletingWatched = true;
  try {
    const { action } = await AlertDialog.show({
      title: n === 1 ? "Delete 1 watched download?" : `Delete ${n} watched downloads?`,
      description: platform.os === "macos"
        ? "Downloads you have watched to the end. The files move to the Trash."
        : "Downloads you have watched to the end are removed from this device.",
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "delete", label: "Delete", role: "destructive" },
      ],
    });
    if (action !== "delete") return;
    const gone = await removeWatchedDownloads();
    if (gone > 0) notify(gone === 1 ? "Deleted 1 download" : `Deleted ${gone} downloads`, "success");
    void refreshDownloadSpace();
  } catch (e) {
    debug("downloads: delete watched failed", String(e));
  } finally {
    deletingWatched = false;
  }
}

export function Downloads() {
  // The page stays mounted while other tabs show: it follows the queue
  // only while it shows (a running download changes it every second),
  // and catches up, free space included, each time it shows again.
  const shown = computed(() => currentTab() === "downloads");
  const list = signal<DlEntry[]>(untracked(downloadList));
  const queued = signal<DlEntry[]>(untracked(downloadQueue));
  effect(() => {
    if (!shown()) return;
    if (fixtureOn()) {
      list.set(FIXTURE);
      queued.set(
        fixtureDoneOnly ? [] : FIXTURE.filter((e) => e.state !== "done" && e.state !== "error"),
      );
      if (!untracked(expanded)["tv:1396"]) toggleGroup("tv:1396");
      return;
    }
    list.set(downloadList());
    queued.set(downloadQueue());
  });
  effect(() => {
    if (shown()) void refreshDownloadSpace();
  });

  const refreshing = signal(false);
  const refresh = async () => {
    if (refreshing()) return;
    refreshing.set(true);
    try {
      await refreshDownloadSpace();
    } finally {
      refreshing.set(false);
    }
  };

  const queue = computed(() => queued());
  const active = computed(() =>
    queue().filter((e) => e.state === "running" || e.state === "resolving"),
  );
  const upNext = computed(() => queue().filter((e) => e.state === "queued"));
  // Needs the user: play once to download, then the failed and cancelled.
  const attention = computed(() => [
    ...queue().filter((e) => e.state === "needsPlay"),
    ...list().filter((e) => e.state === "error"),
  ]);
  const doneList = computed(() => list().filter((e) => e.state === "done"));
  const groups = computed(() => groupsOf(doneList()));
  const watchedCount = computed(() => doneList().filter((e) => isWatched(e)).length);
  const space = computed(() => {
    const s = downloadSpace();
    return s ? `${formatBytes(s.used)} used · ${formatBytes(s.free)} free` : "";
  });

  return (
    <Scroll class="flex-1" refreshing={refreshing()} onRefresh={() => void refresh()}>
      <View
        class="w-full self-center"
        style={{ maxWidth: 900, paddingLeft: GUTTER, paddingRight: GUTTER, paddingTop: 12, paddingBottom: 40 }}
      >
        <View class="gap-1">
          <Text class="font-extrabold text-foreground" style={{ fontSize: 28, lineHeight: 34 }}>
            Downloads
          </Text>
          <If when={canDownload() && space()}>
            <Text class={MUTED} style={{ fontSize: 13, lineHeight: 18 }}>
              {space()}
            </Text>
          </If>
        </View>

        <If when={!canDownload()}>
          <Text class="pt-4 text-sm text-muted-foreground">
            Downloads aren't available on this device.
          </Text>
        </If>

        <If when={canDownload() && list().length === 0}>
          <EmptyState
            glyph="download"
            title="No downloads yet"
            body="Use the download button on a movie, an episode or in the player. Downloads play here without the internet."
          />
        </If>

        <If when={active().length > 0}>
          <SectionHeader text="Downloading" count={active().length} />
          <Each of={active()} key={(e: DlEntry) => e.key}>
            {(e) => <Row e={e()} />}
          </Each>
        </If>

        <If when={upNext().length > 0}>
          <SectionHeader text="Up next" count={upNext().length} />
          <Each of={upNext()} key={(e: DlEntry) => e.key}>
            {(e) => <Row e={e()} />}
          </Each>
        </If>

        <If when={attention().length > 0}>
          <SectionHeader text="Needs attention" count={attention().length} />
          <Each of={attention()} key={(e: DlEntry) => e.key}>
            {(e) => <Row e={e()} />}
          </Each>
        </If>

        <If when={groups().length > 0}>
          <SectionHeader
            text="Downloaded"
            count={doneList().length}
            action={
              watchedCount() > 0
                ? { label: `Delete watched (${watchedCount()})`, onPress: () => void deleteWatched(watchedCount()) }
                : undefined
            }
          />
          <Each of={groups()} key={(g: Group) => g.key}>
            {(g) => (
              <If when={g().movie} else={<GroupRow g={g()} />}>
                <Each of={g().entries} key={(x: DlEntry) => x.key}>
                  {(x) => <Row e={x()} />}
                </Each>
              </If>
            )}
          </Each>
        </If>
      </View>
    </Scroll>
  );
}
