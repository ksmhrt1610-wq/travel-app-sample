import { haversineM } from "./geo";
import { describePlanBReason } from "./planb";
import { DAY_ORIGINS } from "./planner";
import type {
  Block,
  BlockLabel,
  Budget,
  Companions,
  Day,
  Duration,
  InterestCategory,
  Itinerary,
  LatLng,
  Pace,
  PlanningContext,
  Preferences,
  RainTolerance,
} from "./types";

/**
 * 旅程の共有。状態をコンパクトな配列にして JSON → UTF-8 → base64url にし、URL のクエリに載せる。
 * 受け取った側はサーバーなしで同じ旅程を再現できる（閲覧専用）。
 * スポットは id だけを載せ、名前や座標は受け取り側の SpotProvider から引く。
 */

const VERSION = 1;

const LABEL_CODE: Record<BlockLabel, string> = { must: "m", normal: "n", optional: "o", buffer: "b" };
const CODE_LABEL: Record<string, BlockLabel> = { m: "must", n: "normal", o: "optional", b: "buffer" };

const FLAG = { switched: 1, skipped: 2, candidate: 4, closed: 8, keep: 16 } as const;

type BlockTuple = [string, string, number, number, number, string, number, number];
type DayTuple = [number, number, number, BlockTuple[], string[]];
type Payload = [
  number, // version
  string, // startDate
  [Duration, Companions, Budget, InterestCategory[], Pace, RainTolerance, string[]],
  string[], // closedSpotIds
  DayTuple[],
];

/* ---------- base64url ---------- */

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): string {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---------- encode ---------- */

export function encodeItinerary(itin: Itinerary): string {
  const p = itin.prefs;
  const payload: Payload = [
    VERSION,
    itin.startDate,
    [p.duration, p.companions, p.budget, p.interests, p.pace, p.rainTolerance, p.mustSpotIds],
    itin.closedSpotIds,
    itin.days.map((d): DayTuple => [
      d.startMin,
      d.endMin,
      Math.max(0, DAY_ORIGINS.findIndex((o) => o.name === d.origin.name)),
      d.blocks.map((b): BlockTuple => {
        const flags =
          (b.switched ? FLAG.switched : 0) |
          (b.skip === "skipped" ? FLAG.skipped : 0) |
          (b.skip === "candidate" ? FLAG.candidate : 0) |
          (b.closed ? FLAG.closed : 0) |
          (b.keepAnyway ? FLAG.keep : 0);
        return [
          LABEL_CODE[b.label],
          b.spotId ?? "",
          b.startMin,
          b.endMin,
          b.durationMin,
          b.planB?.spotId ?? "",
          b.planB?.durationMin ?? 0,
          flags,
        ];
      }),
      d.warnings,
    ]),
  ];
  return toBase64Url(JSON.stringify(payload));
}

/** 共有URL。origin は location.origin、path はアプリ内の共有ページのパス */
export function buildShareUrl(origin: string, itin: Itinerary, path = "/share"): string {
  return `${origin}${path}?s=${encodeItinerary(itin)}`;
}

/* ---------- decode ---------- */

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";

/** 不正なトークン・存在しないスポットを含む場合は null */
export function decodeItinerary(token: string, ctx: PlanningContext): Itinerary | null {
  try {
    const payload = JSON.parse(fromBase64Url(token)) as Payload;
    if (!Array.isArray(payload) || payload[0] !== VERSION) return null;
    const [, startDate, pref, closedSpotIds, dayTuples] = payload;
    if (!isStr(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
    if (!Array.isArray(pref) || !Array.isArray(dayTuples) || dayTuples.length === 0 || dayTuples.length > 7) return null;

    const prefs: Preferences = {
      duration: pref[0],
      companions: pref[1],
      budget: pref[2],
      interests: pref[3],
      pace: pref[4],
      rainTolerance: pref[5],
      mustSpotIds: pref[6],
    };

    const days: Day[] = [];
    for (let i = 0; i < dayTuples.length; i++) {
      const [startMin, endMin, originIdx, blockTuples, warnings] = dayTuples[i];
      if (!isNum(startMin) || !isNum(endMin) || !Array.isArray(blockTuples)) return null;
      const origin = DAY_ORIGINS[originIdx] ?? DAY_ORIGINS[0];

      let loc: LatLng = origin;
      const blocks: Block[] = [];
      for (let j = 0; j < blockTuples.length; j++) {
        const [code, spotId, start, end, duration, planBId, planBDuration, flags] = blockTuples[j];
        const label = CODE_LABEL[code];
        if (!label || !isNum(start) || !isNum(end) || !isNum(duration) || !isNum(flags)) return null;

        const spot = spotId ? ctx.spotById.get(spotId) : undefined;
        if (label === "buffer") {
          blocks.push({ id: `d${i + 1}b${j + 1}`, label, durationMin: duration, startMin: start, endMin: end, plannedStartMin: start, plannedEndMin: end, travelMin: 0, travelMode: "none" });
          continue;
        }
        if (!spot) return null;
        const travel = ctx.travel(loc, spot);
        loc = spot;

        let planB: Block["planB"] = undefined;
        if (planBId) {
          const alt = ctx.spotById.get(planBId);
          if (!alt) return null;
          const switched = !!(flags & FLAG.switched);
          planB = {
            spotId: alt.id,
            reason: switched ? "元の予定に戻す" : describePlanBReason(spot, alt, ctx),
            distanceM: Math.round(haversineM(spot, alt)),
            durationMin: planBDuration,
          };
        } else if (spot.setting !== "indoor") {
          planB = null;
        }

        blocks.push({
          id: `d${i + 1}b${j + 1}`,
          label,
          spotId: spot.id,
          durationMin: duration,
          startMin: start,
          endMin: end,
          plannedStartMin: start,
          plannedEndMin: end,
          travelMin: travel.minutes,
          travelMode: travel.mode,
          planB,
          switched: !!(flags & FLAG.switched) || undefined,
          skip: flags & FLAG.skipped ? "skipped" : flags & FLAG.candidate ? "candidate" : undefined,
          closed: !!(flags & FLAG.closed) || undefined,
          keepAnyway: !!(flags & FLAG.keep) || undefined,
        });
      }

      days.push({
        index: i,
        date: addDaysLocal(startDate, i),
        startMin,
        endMin,
        origin,
        blocks,
        warnings: Array.isArray(warnings) ? warnings.filter(isStr) : [],
      });
    }

    return {
      version: 1,
      id: `shared-${token.slice(0, 8)}`,
      createdAt: new Date(0).toISOString(),
      startDate,
      prefs,
      days,
      closedSpotIds: Array.isArray(closedSpotIds) ? closedSpotIds.filter(isStr) : [],
    };
  } catch {
    return null;
  }
}

function addDaysLocal(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
