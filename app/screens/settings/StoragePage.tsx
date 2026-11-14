// Storage & privacy: the caches' sizes with Clear (site data asks first, in
// the confirm dialog: it signs the sources out), and the library's counts.
// Clear watch history is a schema action (store.ts `clearProgress`).

import { signal, Text, View } from "nsh";
import { cacheInfo, clearCache, formatBytes, type CacheKind, type CacheSizes } from "../../lib/cache";
import { notify } from "../../lib/player";
import { libraryReady, progress, watchlist } from "../../lib/store";
import { DestructiveRow, Row } from "./rows";
import type { RowDef } from "./schema";

/** What a toast calls each cache once it is cleared. */
const CLEARED_NAME: Record<CacheKind, string> = {
  images: "images",
  web: "video page files",
  site: "site data",
};

const sizes = signal<CacheSizes | null>(null);
const busy = signal<CacheKind | null>(null);
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    sizes.set(null);
    sizes.set(await cacheInfo());
  } catch {
    sizes.set({ images: 0, web: 0, site: 0 });
  } finally {
    refreshing = false;
  }
}

async function clear(what: CacheKind) {
  if (busy()) return;
  busy.set(what);
  try {
    const freed = await clearCache(what);
    notify(`Cleared ${formatBytes(freed)} of ${CLEARED_NAME[what]}`, "success");
  } finally {
    busy.set(null);
  }
  await refresh();
}

/** A cache row ("cache:images" | "cache:web" | "cache:site"). */
export function CacheRow(props: { row: RowDef; kind: CacheKind }) {
  // The sizes are asked again each time the page shows.
  void refresh();
  const size = () => {
    const s = sizes();
    return s ? formatBytes(s[props.kind]) : "Calculating…";
  };
  return (
    <DestructiveRow
      row={props.row}
      button={busy() === props.kind ? "Clearing…" : props.kind === "site" ? "Clear…" : "Clear"}
      busy={busy() === props.kind}
      value={
        <Text class="text-sm text-muted-foreground" style={{ numberOfLines: 1 }}>
          {size()}
        </Text>
      }
      confirm={
        props.kind === "site"
          ? {
              title: "Clear site data?",
              body: "The video sources forget their cookies and saved settings, and any sign-in on them. Your library and downloads stay.",
              confirm: "Clear site data",
            }
          : undefined
      }
      onConfirm={() => clear(props.kind)}
    />
  );
}

/** "libraryCounts": how much the library holds. */
export function LibraryCounts(props: { row: RowDef }) {
  return (
    <Row
      row={props.row}
      control={
        <Text class="text-sm text-muted-foreground" style={{ numberOfLines: 2, textAlign: "right" }}>
          {libraryReady()
            ? `${watchlist().length} in My List · ${progress().length} watched`
            : "Loading…"}
        </Text>
      }
    />
  );
}
