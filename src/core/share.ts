import { createFixedBlock, defaultMembers } from "./fixed";
import { withWalkLimit } from "./geo";
import { haversineM } from "./geo";
import { describePlanBReason } from "./planb";
import { DAY_ORIGINS } from "./planner";
import { DEFAULT_MARGIN_MIN } from "./schedule";
import type {
  Block,
  BlockLabel,
  Budget,
  Companions,
  Day,
  Duration,
  FixedEvent,
  FixedKind,
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
 * 固定時刻（駅などスポットでない場所を含む）とメンバーは、その内容をそのまま載せる。
 */

const VERSION = 2;

const LABEL_CODE: Record<BlockLabel, string> = { fixed: "f", must: "m", normal: "n", optional: "o", buffer: "b", rest: "r" };
const CODE_LABEL: Record<string, BlockLabel> = { f: "fixed", m: "must", n: "normal", o: "optional", b: "buffer", r: "rest" };

const FLAG = { switched: 1, skipped: 2, closed: 8 } as const;

type FixedTuple = [string, FixedKind, string, number, number, string, number, number, string, number, number, string[] | null];
type BlockTuple = [string, string, number, number, number, string, number, number, FixedTuple?];
type DayTuple = [number, number, number, BlockTuple[], string[], FixedTuple[], number];
type Payload = [
  number, // version
  string, // startDate
  [Duration, Companions, Budget, InterestCategory[], Pace, RainTolerance, string[]],
  string[], // closedSpotIds
  DayTuple[],
  [string, string][], // members
  number, // marginMin
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

const fixedToTuple = (f: FixedEvent): FixedTuple => [
  f.id,
  f.kind,
  f.title,
  f.timeMin,
  f.dayIndex,
  f.place.name,
  f.place.lat,
  f.place.lng,
  f.spotId ?? "",
  f.durationMin,
  f.endsDay ? 1 : 0,
  f.memberIds,
];

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
        const flags = (b.switched ? FLAG.switched : 0) | (b.skip === "skipped" ? FLAG.skipped : 0) | (b.closed ? FLAG.closed : 0);
        const tuple: BlockTuple = [
          LABEL_CODE[b.label],
          b.spotId ?? "",
          b.startMin,
          b.endMin,
          b.durationMin,
          b.planB?.spotId ?? "",
          b.planB?.durationMin ?? 0,
          flags,
        ];
        if (b.fixed) tuple.push(fixedToTuple(b.fixed));
        return tuple;
      }),
      d.warnings,
      (d.memberFixed ?? []).map(fixedToTuple),
      d.lowWalking ? 1 : 0,
    ]),
    itin.members.map((m) => [m.id, m.name]),
    itin.settings.marginMin,
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

function tupleToFixed(t: FixedTuple): FixedEvent | null {
  const [id, kind, title, timeMin, dayIndex, placeName, lat, lng, spotId, durationMin, endsDay, memberIds] = t;
  if (!isStr(id) || !isStr(kind) || !isStr(title) || !isNum(timeMin) || !isNum(dayIndex) || !isStr(placeName) || !isNum(lat) || !isNum(lng) || !isNum(durationMin)) return null;
  return {
    id,
    kind,
    title,
    timeMin,
    dayIndex,
    place: { name: placeName, lat, lng },
    spotId: spotId || undefined,
    durationMin,
    endsDay: !!endsDay,
    memberIds: Array.isArray(memberIds) ? memberIds.filter(isStr) : null,
  };
}

/** 不正なトークン・存在しないスポットを含む場合は null */
export function decodeItinerary(token: string, ctx: PlanningContext): Itinerary | null {
  try {
    const payload = JSON.parse(fromBase64Url(token)) as Payload;
    if (!Array.isArray(payload) || (payload[0] !== 1 && payload[0] !== VERSION)) return null;
    const [, startDate, pref, closedSpotIds, dayTuples, memberTuples, marginMin] = payload;
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
      const [startMin, endMin, originIdx, blockTuples, warnings, memberFixedTuples, lowWalking] = dayTuples[i];
      if (!isNum(startMin) || !isNum(endMin) || !Array.isArray(blockTuples)) return null;
      const origin = DAY_ORIGINS[originIdx] ?? DAY_ORIGINS[0];
      const travelFn = lowWalking ? withWalkLimit(ctx.travel) : ctx.travel;

      let loc: LatLng = origin;
      const blocks: Block[] = [];
      for (let j = 0; j < blockTuples.length; j++) {
        const [code, spotId, start, end, duration, planBId, planBDuration, flags, fixedTuple] = blockTuples[j];
        const label = CODE_LABEL[code];
        if (!label || !isNum(start) || !isNum(end) || !isNum(duration) || !isNum(flags)) return null;
        const id = `d${i + 1}b${j + 1}`;

        if (label === "fixed") {
          const ev = fixedTuple ? tupleToFixed(fixedTuple) : null;
          if (!ev) return null;
          const block = createFixedBlock({ ...ev, memberIds: null });
          const travel = travelFn(loc, ev.place);
          loc = ev.place;
          blocks.push({ ...block, id: ev.id, startMin: start, endMin: end, plannedStartMin: start, plannedEndMin: end, travelMin: travel.minutes, travelMode: travel.mode, travelDistanceM: travel.distanceM });
          continue;
        }

        const spot = spotId ? ctx.spotById.get(spotId) : undefined;
        if (!spot) {
          // 余白、または場所を決めない休憩
          if (label !== "buffer" && label !== "rest") return null;
          blocks.push({ id, label, durationMin: duration, startMin: start, endMin: end, plannedStartMin: start, plannedEndMin: end, travelMin: 0, travelMode: "none" });
          continue;
        }
        const travel = travelFn(loc, spot);
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
        } else if (spot.setting !== "indoor" && label !== "rest") {
          planB = null;
        }

        blocks.push({
          id,
          label,
          spotId: spot.id,
          durationMin: duration,
          startMin: start,
          endMin: end,
          plannedStartMin: start,
          plannedEndMin: end,
          travelMin: travel.minutes,
          travelMode: travel.mode,
          travelDistanceM: travel.distanceM,
          planB,
          switched: !!(flags & FLAG.switched) || undefined,
          skip: flags & FLAG.skipped ? "skipped" : undefined,
          closed: !!(flags & FLAG.closed) || undefined,
        });
      }

      const memberFixed = (Array.isArray(memberFixedTuples) ? memberFixedTuples : [])
        .map(tupleToFixed)
        .filter((f): f is FixedEvent => !!f);
      days.push({
        index: i,
        date: addDaysLocal(startDate, i),
        startMin,
        endMin,
        origin,
        blocks,
        warnings: Array.isArray(warnings) ? warnings.filter(isStr) : [],
        memberFixed: memberFixed.length ? memberFixed : undefined,
        lowWalking: lowWalking ? true : undefined,
      });
    }

    const members =
      Array.isArray(memberTuples) && memberTuples.length
        ? memberTuples.filter((m) => Array.isArray(m) && isStr(m[0]) && isStr(m[1])).map(([id, name]) => ({ id, name }))
        : defaultMembers(prefs.companions);

    return {
      version: 1,
      id: `shared-${token.slice(0, 8)}`,
      createdAt: new Date(0).toISOString(),
      startDate,
      prefs,
      days,
      closedSpotIds: Array.isArray(closedSpotIds) ? closedSpotIds.filter(isStr) : [],
      members,
      settings: { marginMin: isNum(marginMin) ? marginMin : DEFAULT_MARGIN_MIN },
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
