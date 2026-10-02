import { createFixedBlock, defaultMembers } from "./fixed";
import { withWalkLimit } from "./geo";
import { haversineM } from "./geo";
import { describePlanBReason } from "./planb";
import { DAY_ORIGINS } from "./planner";
import { DEFAULT_MARGIN_MIN } from "./schedule";
import { itinerarySchema, LIMITS } from "./schema";
import { z } from "zod";
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

export type ShareEncodeResult = { ok: true; token: string } | { ok: false; reason: string };

/** 長さの上限（MAX_SHARE_TOKEN_CHARS）を超えるときは、リンクにせず理由を返す */
export function encodeItineraryChecked(itin: Itinerary): ShareEncodeResult {
  const token = encodeItinerary(itin);
  if (token.length > MAX_SHARE_TOKEN_CHARS) {
    return { ok: false, reason: `旅程が大きすぎて、共有リンクにできません（上限${MAX_SHARE_TOKEN_CHARS / 1024}KB、いまは約${Math.ceil(token.length / 1024)}KB）` };
  }
  return { ok: true, token };
}

/** 共有URL。origin は location.origin、path はアプリ内の共有ページのパス。上限を超えるときは null */
export function buildShareUrl(origin: string, itin: Itinerary, path = "/share"): string | null {
  const r = encodeItineraryChecked(itin);
  return r.ok ? `${origin}${path}?s=${r.token}` : null;
}

/* ---------- decode ---------- */

/** 共有リンクの長さの上限（クエリ文字列。8KB）。これを超えるものは読み込まない */
export const MAX_SHARE_TOKEN_CHARS = 8 * 1024;
/** デコード後の JSON の長さの上限 */
const MAX_PAYLOAD_JSON_CHARS = 64 * 1024;

export type ShareErrorCode = "empty" | "too-long" | "malformed" | "version" | "invalid" | "unknown-spot";

export type ShareDecodeResult = { ok: true; itinerary: Itinerary } | { ok: false; code: ShareErrorCode; reason: string };

const idS = z.string().min(1).max(LIMITS.idLen);
const idOrEmpty = z.string().max(LIMITS.idLen);
const minuteS = z.number().finite().min(-LIMITS.maxMinute).max(LIMITS.maxMinute);
const durationS = z.number().finite().min(0).max(24 * 60);
const flagS = z.number().int().min(0).max(15);
const bitS = z.number().int().min(0).max(1);

const fixedTupleS = z.tuple([
  idS,
  z.enum(["last-transport", "checkin", "reservation", "car-return", "meetup"]),
  z.string().max(LIMITS.textLen),
  minuteS,
  z.number().int().min(0).max(LIMITS.days - 1),
  z.string().max(LIMITS.nameLen),
  z.number().finite().min(-90).max(90),
  z.number().finite().min(-180).max(180),
  idOrEmpty,
  durationS,
  bitS,
  z.array(idS).max(LIMITS.members).nullable(),
]);

const blockTupleS = z.tuple([
  z.string().min(1).max(1),
  idOrEmpty,
  minuteS,
  minuteS,
  durationS,
  idOrEmpty,
  durationS,
  flagS,
  fixedTupleS.optional(),
]);

const dayTupleS = z.tuple([
  minuteS,
  minuteS,
  z.number().int().min(0).max(9),
  z.array(blockTupleS).max(LIMITS.blocksPerDay),
  z.array(z.string().max(LIMITS.textLen)).max(LIMITS.warnings),
  z.array(fixedTupleS).max(LIMITS.fixedPerDay).optional(),
  bitS.optional(),
]);

const payloadS = z.tuple([
  z.union([z.literal(1), z.literal(VERSION)]),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.tuple([
    z.enum(["day", "overnight"]),
    z.enum(["solo", "couple", "friends", "family"]),
    z.enum(["saving", "normal", "luxury"]),
    z.array(z.enum(["gourmet", "cafe", "history", "nature", "shopping", "art", "nightview"])).max(7),
    z.enum(["relaxed", "normal", "packed"]),
    z.enum(["no-outdoor", "light-rain-ok", "dont-care"]),
    z.array(idS).max(LIMITS.mustSpots),
  ]),
  z.array(idS).max(LIMITS.closedSpots),
  z.array(dayTupleS).min(1).max(LIMITS.days),
  z.array(z.tuple([idS, z.string().max(30)])).max(LIMITS.members).optional(),
  z.number().finite().min(0).max(180).optional(),
]);

function tupleToFixed(t: z.infer<typeof fixedTupleS>): FixedEvent {
  const [id, kind, title, timeMin, dayIndex, placeName, lat, lng, spotId, durationMin, endsDay, memberIds] = t;
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
    memberIds,
  };
}

const fail = (code: ShareErrorCode, reason: string): ShareDecodeResult => ({ ok: false, code, reason });

/**
 * 共有リンクのトークンを旅程に戻す。例外は投げず、失敗は理由つきで返す。
 * 長さの上限 → base64url/JSON → スキーマ検証（型・範囲・配列の長さ）→ スポットIDの存在確認 → 組み立てた旅程のスキーマ検証。
 */
export function decodeItineraryResult(token: string, ctx: PlanningContext): ShareDecodeResult {
  if (!token) return fail("empty", "リンクにデータがありません");
  if (token.length > MAX_SHARE_TOKEN_CHARS) return fail("too-long", `リンクが長すぎます（${MAX_SHARE_TOKEN_CHARS / 1024}KB以内。いまは約${Math.ceil(token.length / 1024)}KB）`);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return fail("malformed", "リンクに使えない文字が含まれています");

  let raw: unknown;
  try {
    const json = fromBase64Url(token);
    if (json.length > MAX_PAYLOAD_JSON_CHARS) return fail("too-long", "リンクの内容が大きすぎます");
    raw = JSON.parse(json);
  } catch {
    return fail("malformed", "リンクの形式が壊れています（途中で切れている可能性があります）");
  }
  if (Array.isArray(raw) && raw[0] !== 1 && raw[0] !== VERSION) return fail("version", "対応していない形式のリンクです（古い、または新しすぎる可能性があります）");

  const parsed = payloadS.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return fail("invalid", `リンクの内容が正しくありません（${i.path.join(".") || "全体"}: ${i.message}）`);
  }

  try {
    const [, startDate, pref, closedSpotIds, dayTuples, memberTuples, marginMin] = parsed.data;
    const prefs: Preferences = {
      duration: pref[0],
      companions: pref[1],
      budget: pref[2],
      interests: pref[3],
      pace: pref[4],
      rainTolerance: pref[5],
      mustSpotIds: pref[6],
    };
    for (const sid of [...prefs.mustSpotIds, ...closedSpotIds]) {
      if (!ctx.spotById.has(sid)) return fail("unknown-spot", `存在しないスポットが含まれています（${sid}）`);
    }

    const days: Day[] = [];
    for (let i = 0; i < dayTuples.length; i++) {
      const [startMin, endMin, originIdx, blockTuples, warnings, memberFixedTuples, lowWalking] = dayTuples[i];
      const origin = DAY_ORIGINS[originIdx] ?? DAY_ORIGINS[0];
      const travelFn = lowWalking ? withWalkLimit(ctx.travel) : ctx.travel;

      let loc: LatLng = origin;
      const blocks: Block[] = [];
      for (let j = 0; j < blockTuples.length; j++) {
        const [code, spotId, start, end, duration, planBId, planBDuration, flags, fixedTuple] = blockTuples[j];
        const label = CODE_LABEL[code];
        if (!label) return fail("invalid", `リンクの内容が正しくありません（ブロックの種類 ${code}）`);
        const id = `d${i + 1}b${j + 1}`;

        if (label === "fixed") {
          if (!fixedTuple) return fail("invalid", "リンクの内容が正しくありません（固定時刻の情報がありません）");
          const ev = tupleToFixed(fixedTuple);
          const block = createFixedBlock({ ...ev, memberIds: null });
          const travel = travelFn(loc, ev.place);
          loc = ev.place;
          blocks.push({ ...block, id: ev.id, startMin: start, endMin: end, plannedStartMin: start, plannedEndMin: end, travelMin: travel.minutes, travelMode: travel.mode, travelDistanceM: travel.distanceM });
          continue;
        }

        const spot = spotId ? ctx.spotById.get(spotId) : undefined;
        if (!spot) {
          if (spotId) return fail("unknown-spot", `存在しないスポットが含まれています（${spotId}）`);
          // 余白、または場所を決めない休憩
          if (label !== "buffer" && label !== "rest") return fail("invalid", "リンクの内容が正しくありません（場所のない予定）");
          blocks.push({ id, label, durationMin: duration, startMin: start, endMin: end, plannedStartMin: start, plannedEndMin: end, travelMin: 0, travelMode: "none" });
          continue;
        }
        const travel = travelFn(loc, spot);
        loc = spot;

        let planB: Block["planB"] = undefined;
        if (planBId) {
          const alt = ctx.spotById.get(planBId);
          if (!alt) return fail("unknown-spot", `存在しないスポットが含まれています（${planBId}）`);
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

      const memberFixed = (memberFixedTuples ?? []).map(tupleToFixed);
      days.push({
        index: i,
        date: addDaysLocal(startDate, i),
        startMin,
        endMin,
        origin,
        blocks,
        warnings,
        memberFixed: memberFixed.length ? memberFixed : undefined,
        lowWalking: lowWalking ? true : undefined,
      });
    }

    const members = memberTuples?.length ? memberTuples.map(([id, name]) => ({ id, name })) : defaultMembers(prefs.companions);
    const itinerary: Itinerary = {
      version: 1,
      id: `shared-${token.slice(0, 8)}`,
      createdAt: new Date(0).toISOString(),
      startDate,
      prefs,
      days,
      closedSpotIds,
      members,
      settings: { marginMin: marginMin ?? DEFAULT_MARGIN_MIN },
    };
    // 組み立てた旅程が、アプリの保存形式として正しいことを最後に確かめる
    const final = itinerarySchema.safeParse(itinerary);
    if (!final.success) return fail("invalid", `リンクの内容が正しくありません（${final.error.issues[0].path.join(".")}: ${final.error.issues[0].message}）`);
    return { ok: true, itinerary };
  } catch {
    return fail("invalid", "リンクの内容を読み込めませんでした");
  }
}

/** 不正なトークン・存在しないスポットを含む場合は null（理由が要るときは decodeItineraryResult） */
export function decodeItinerary(token: string, ctx: PlanningContext): Itinerary | null {
  const r = decodeItineraryResult(token, ctx);
  return r.ok ? r.itinerary : null;
}

function addDaysLocal(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
