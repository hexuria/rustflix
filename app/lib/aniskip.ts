// AniSkip (api.aniskip.com): community opening/ending/recap timestamps
// per MyAnimeList id and episode. No key needed.

export interface SkipSegment {
  kind: "op" | "ed" | "recap";
  start: number;
  end: number;
}

interface SkipResponse {
  found?: boolean;
  results?: {
    interval?: { startTime?: number; endTime?: number };
    skipType?: string;
  }[];
}

/** Opening/ending/recap segments for `episode` of MAL title `idMal`, in
 * seconds (mixed-op/mixed-ed count as op/ed). `durationSec` lets AniSkip
 * match timestamps to this cut of the episode. Empty when none are known
 * (404); throws on network and server errors so the caller can retry. */
export async function skipTimes(
  idMal: number,
  episode: number,
  durationSec: number,
): Promise<SkipSegment[]> {
  const url =
    `https://api.aniskip.com/v2/skip-times/${idMal}/${episode}` +
    `?types=op&types=ed&types=mixed-op&types=mixed-ed&types=recap&episodeLength=${Math.round(durationSec)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  // 404 means "no timestamps for this episode"; anything else is a
  // failure worth retrying.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`AniSkip ${res.status}`);
  const body = (await res.json()) as SkipResponse;
  if (!body?.found || !Array.isArray(body.results)) return [];
  const out: SkipSegment[] = [];
  for (const r of body.results) {
    const start = r.interval?.startTime;
    const end = r.interval?.endTime;
    const kind =
      r.skipType === "op" || r.skipType === "mixed-op"
        ? "op"
        : r.skipType === "ed" || r.skipType === "mixed-ed"
          ? "ed"
          : r.skipType === "recap"
            ? "recap"
            : null;
    if (!kind) continue;
    if (typeof start !== "number" || typeof end !== "number" || end <= start) continue;
    out.push({ kind, start, end });
  }
  return out;
}
