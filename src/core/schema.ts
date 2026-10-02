import { z } from "zod";
import type { ChangeSet } from "./diff";
import type { Itinerary } from "./types";

/**
 * 外から入ってくるデータ（共有リンク・localStorage・「自分の旅程として保存」）の検証。
 * 不正なデータは、読み込み・保存の前に拒否する（アプリが落ちたり、壊れたデータで動かなくならないように）。
 * 配列の長さ・文字列の長さ・数値の範囲に上限を付けている（巨大なデータや極端な値を弾く）。
 */

/** 上限（まとめて調整できる） */
export const LIMITS = {
  days: 7,
  blocksPerDay: 80,
  warnings: 60,
  members: 8,
  fixedPerDay: 30,
  closedSpots: 300,
  mustSpots: 30,
  history: 30,
  diffItems: 200,
  idLen: 100,
  textLen: 400,
  nameLen: 60,
  /** 時刻（0:00 からの分）の上限。日をまたいで 48 時間まで */
  maxMinute: 48 * 60,
} as const;

const id = z.string().min(1).max(LIMITS.idLen);
const text = (max: number = LIMITS.textLen) => z.string().max(max);
const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const minute = num(-LIMITS.maxMinute, LIMITS.maxMinute);
const duration = num(0, 24 * 60);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ---------- 列挙 ---------- */

const category = z.enum(["gourmet", "cafe", "history", "nature", "shopping", "art", "nightview"]);
const blockLabel = z.enum(["fixed", "must", "normal", "optional", "buffer", "rest"]);
const travelMode = z.enum(["walk", "transit", "none"]);
const blockIssue = z.enum(["outside-hours", "over-day-end", "closed", "fixed-missed", "after-last-transport", "outside-meal-window"]);
const fixedKind = z.enum(["last-transport", "checkin", "reservation", "car-return", "meetup"]);
const mealSlot = z.enum(["lunch", "dinner"]);
const dietary = z.enum(["no-pork", "no-seafood", "no-wheat", "vegetarian"]);

/* ---------- 部品 ---------- */

const origin = z.object({ name: text(LIMITS.nameLen), lat: num(-90, 90), lng: num(-180, 180) });

const fixedEvent = z.object({
  id,
  kind: fixedKind,
  title: text(),
  timeMin: minute,
  dayIndex: z.number().int().min(0).max(LIMITS.days - 1),
  place: origin,
  spotId: id.optional(),
  durationMin: duration,
  endsDay: z.boolean(),
  memberIds: z.array(id).max(LIMITS.members).nullable(),
});

const planB = z.object({
  spotId: id,
  reason: text(),
  distanceM: num(0, 1_000_000),
  durationMin: duration,
});

const block = z.object({
  id,
  label: blockLabel,
  spotId: id.optional(),
  durationMin: duration,
  startMin: minute,
  endMin: minute,
  plannedStartMin: minute.optional(),
  plannedEndMin: minute.optional(),
  travelMin: num(0, 24 * 60),
  travelMode,
  travelDistanceM: num(0, 1_000_000).optional(),
  planB: planB.nullable().optional(),
  switched: z.boolean().optional(),
  skip: z.literal("skipped").optional(),
  meal: mealSlot.optional(),
  actualStartMin: minute.optional(),
  actualEndMin: minute.optional(),
  detour: z.boolean().optional(),
  free: z.object({ name: text(LIMITS.nameLen), travelMin: num(0, 24 * 60) }).optional(),
  closed: z.boolean().optional(),
  notBefore: minute.optional(),
  issues: z.array(blockIssue).max(6).optional(),
  lateByMin: num(0, 24 * 60 * 2).optional(),
  crowdedOverlap: z.boolean().optional(),
  fixed: fixedEvent.optional(),
  place: origin.optional(),
});

const day = z.object({
  index: z.number().int().min(0).max(LIMITS.days - 1),
  date: dateStr,
  startMin: minute,
  endMin: minute,
  origin,
  blocks: z.array(block).max(LIMITS.blocksPerDay),
  warnings: z.array(text()).max(LIMITS.warnings),
  memberFixed: z.array(fixedEvent).max(LIMITS.fixedPerDay).optional(),
  lowWalking: z.boolean().optional(),
});

const preferences = z.object({
  duration: z.enum(["day", "overnight"]),
  companions: z.enum(["solo", "couple", "friends", "family"]),
  budget: z.enum(["saving", "normal", "luxury"]),
  interests: z.array(category).max(7),
  pace: z.enum(["relaxed", "normal", "packed"]),
  rainTolerance: z.enum(["no-outdoor", "light-rain-ok", "dont-care"]),
  mustSpotIds: z.array(id).max(LIMITS.mustSpots),
  dietary: z.array(dietary).max(4).optional(),
});

export const itinerarySchema = z.object({
  version: z.literal(1),
  id,
  createdAt: text(60),
  startDate: dateStr,
  prefs: preferences,
  days: z.array(day).min(1).max(LIMITS.days),
  closedSpotIds: z.array(id).max(LIMITS.closedSpots),
  members: z.array(z.object({ id, name: text(30) })).max(LIMITS.members),
  settings: z.object({
    marginMin: num(0, 180),
    mode: z.enum(["manual", "suggest", "auto"]).optional(),
  }),
});

/* ---------- 履歴・当日の状態 ---------- */

const cause = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), fixedId: id }),
  z.object({ kind: z.literal("closing"), spotId: id }),
  z.object({ kind: z.literal("closure"), spotId: id }),
  z.object({ kind: z.literal("meal-window"), slot: mealSlot }),
  z.object({ kind: z.literal("day-end"), endMin: minute.optional() }),
  z.object({ kind: z.literal("rest") }),
  z.object({ kind: z.literal("tired") }),
  z.object({ kind: z.literal("rain") }),
  z.object({ kind: z.literal("heat") }),
  z.object({ kind: z.literal("delay") }),
  z.object({ kind: z.literal("detour") }),
  z.object({ kind: z.literal("progress") }),
  z.object({ kind: z.literal("user") }),
]);

const diffSide = z.object({ spotId: id.optional(), startMin: minute, endMin: minute });

const diffItem = z.object({
  kind: z.enum(["replaced", "shortened", "moved", "shifted", "buffer-changed", "inserted", "removed", "skipped", "closed", "restored"]),
  dayIndex: z.number().int().min(0).max(LIMITS.days - 1),
  blockId: id,
  before: diffSide,
  after: diffSide,
  deltaMin: num(-LIMITS.maxMinute, LIMITS.maxMinute),
  label: blockLabel.optional(),
  durationFrom: duration.optional(),
  durationTo: duration.optional(),
  cause: cause.optional(),
  reason: text().optional(),
});

const changeSet = z.object({
  id,
  atMin: minute,
  title: text(),
  items: z.array(diffItem).max(LIMITS.diffItems),
  before: itinerarySchema.optional(),
  weight: z.enum(["light", "heavy"]).optional(),
  auto: z.boolean().optional(),
  notes: z.array(text()).max(20).optional(),
  travel: z
    .array(z.object({ fromName: text(LIMITS.nameLen), toName: text(LIMITS.nameLen), walkMin: num(0, 1000), transitMin: num(0, 1000), taxiMin: num(0, 1000) }))
    .max(30)
    .optional(),
});

const rainOverride = z.object({
  startMin: minute,
  prob: num(0, 100),
  mmPerHour: num(0, 500).optional(),
  strength: z.enum(["light", "moderate", "heavy"]).optional(),
});

const heatOverride = z.object({ startMin: minute, wbgt: num(0, 60) });

const todayState = z.object({
  itinerary: itinerarySchema,
  dayIndex: z.number().int().min(0).max(LIMITS.days - 1),
  nowMin: minute,
  rain: rainOverride.optional(),
  rainDismissed: text(60).optional(),
  heat: heatOverride.optional(),
  heatDismissed: text(60).optional(),
  dismissed: z.array(text(LIMITS.idLen + 40)).max(500).optional(),
  history: z.array(changeSet).max(LIMITS.history),
});

export const tripStateSchema = z.object({
  prefs: preferences.optional(),
  itinerary: itinerarySchema.optional(),
  today: todayState.optional(),
  history: z.array(changeSet).max(LIMITS.history).optional(),
});

/* ---------- 結果の形と、読みやすい理由 ---------- */

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

/** zod のエラーを、最初の1〜2件の短い理由にする（例: 「days.0.blocks.2.startMin: 数値ではありません」） */
export function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 2).map((i) => {
    const path = i.path.length ? i.path.join(".") : "(全体)";
    return `${path}: ${i.message}`;
  });
  const more = error.issues.length > 2 ? `（ほか${error.issues.length - 2}件）` : "";
  return parts.join(" / ") + more;
}

function run<T>(schema: z.ZodType<T>, input: unknown): Validated<T> {
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, reason: describeIssues(r.error) };
}

export const parseItinerary = (input: unknown): Validated<Itinerary> => run(itinerarySchema as unknown as z.ZodType<Itinerary>, input);

/** 保存形式の TripState。型は store の TripState と同じ形（ここでは core に store の型を持ち込まない） */
export type StoredTrip = z.infer<typeof tripStateSchema>;
export const parseTripState = (input: unknown): Validated<StoredTrip> => run(tripStateSchema, input);

export type { ChangeSet };
