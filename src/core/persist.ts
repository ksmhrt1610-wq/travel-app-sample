import { parseTripState, type StoredTrip, type Validated } from "./schema";
import type { Itinerary, MealSlot, Spot } from "./types";

/**
 * 保存データ（localStorage）の形式とバージョン管理。
 *   v3（現在）: キー replan-fukuoka:v3 に { version: 3, state } を保存
 *   v2（旧）  : キー replan-fukuoka:v2 に TripState をそのまま保存（version なし）
 *   それ以前や、読めないデータ: 勝手には捨てず、確認を出してから削除する（またはバックアップとして残す）
 * 読み込み・保存の前に、必ずスキーマ検証（schema.ts）を通す。
 */

export const STORAGE_VERSION = 3;

export const STORAGE_KEYS = {
  current: "replan-fukuoka:v3",
  v2: "replan-fukuoka:v2",
  /** 過去に使っていた可能性のあるキー（読めないので、確認のうえで削除） */
  legacy: ["replan-fukuoka:v1", "replan-fukuoka"],
  /** 「バックアップとして残す」を選んだときの退避先 */
  backup: "replan-fukuoka:backup",
} as const;

/** 保存データの長さの上限（文字数）。localStorage の容量（約5MB）に収める */
export const MAX_STORED_CHARS = 3 * 1024 * 1024;

export type UnreadableKind =
  /** 壊れている（JSON として読めない・内容が不正） */
  | "corrupt"
  /** 大きすぎる */
  | "too-large"
  /** 古い形式で、読み込めない */
  | "legacy"
  /** このアプリより新しい版で保存されている */
  | "newer";

export type ParseOutcome =
  | { status: "ok"; state: StoredTrip }
  /** 旧版から変換した。意味の補正（食事の推定など）は、スポットの情報が読めてから finishMigration で行う */
  | { status: "migrated"; state: StoredTrip; from: number }
  | { status: "unreadable"; kind: UnreadableKind; reason: string };

const KIND_LABEL: Record<UnreadableKind | "unknown-spots", string> = {
  corrupt: "保存データが壊れていたため、読み込めませんでした",
  "too-large": "保存データが大きすぎて、読み込めませんでした",
  legacy: "古い形式の保存データが見つかりましたが、読み込めませんでした",
  newer: "このアプリより新しい版で保存されたデータのため、読み込めませんでした",
  "unknown-spots": "保存データに、いまのデータにないスポットが含まれていました",
};

export const unreadableTitle = (kind: UnreadableKind | "unknown-spots") => KIND_LABEL[kind];

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * 保存されていた文字列を読む。source は、どのキーから読んだか。
 *   "current": v3 の入れ物 { version, state } / "v2": 旧形式（TripState そのまま） / "legacy": それ以前
 */
export function parseStored(text: string, source: "current" | "v2" | "legacy"): ParseOutcome {
  if (text.length > MAX_STORED_CHARS) return { status: "unreadable", kind: "too-large", reason: `約${Math.ceil(text.length / 1024 / 1024)}MB（上限${MAX_STORED_CHARS / 1024 / 1024}MB）` };
  if (source === "legacy") return { status: "unreadable", kind: "legacy", reason: "対応していない古い形式です" };

  const json = tryJson(text);
  if (!json.ok) return { status: "unreadable", kind: source === "v2" ? "legacy" : "corrupt", reason: "JSON として読めません" };
  const raw = json.value;

  if (source === "current") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "unreadable", kind: "corrupt", reason: "形式が正しくありません" };
    const env = raw as { version?: unknown; state?: unknown };
    if (typeof env.version !== "number") return { status: "unreadable", kind: "corrupt", reason: "version がありません" };
    if (env.version > STORAGE_VERSION) return { status: "unreadable", kind: "newer", reason: `保存の版: ${env.version}（このアプリは ${STORAGE_VERSION} まで）` };
    if (env.version < STORAGE_VERSION) return { status: "unreadable", kind: "legacy", reason: `保存の版: ${env.version}` };
    const v = parseTripState(env.state);
    return v.ok ? { status: "ok", state: v.value } : { status: "unreadable", kind: "corrupt", reason: v.reason };
  }

  // v2: TripState そのまま
  const v = parseTripState(raw);
  return v.ok ? { status: "migrated", state: v.value, from: 2 } : { status: "unreadable", kind: "legacy", reason: v.reason };
}

/** 保存する文字列。保存前に検証し、不正なデータや大きすぎるデータは作らない */
export function serializeTrip(state: unknown): Validated<string> {
  const v = parseTripState(state);
  if (!v.ok) return { ok: false, reason: v.reason };
  const text = JSON.stringify({ version: STORAGE_VERSION, state: v.value });
  if (text.length > MAX_STORED_CHARS) return { ok: false, reason: `保存データが大きすぎます（約${Math.ceil(text.length / 1024 / 1024)}MB）` };
  return { ok: true, value: text };
}

/** 保存してよいか（検証だけ） */
export function validateForSave(state: unknown): Validated<StoredTrip> {
  const r = serializeTrip(state);
  if (!r.ok) return r;
  return parseTripState(state);
}

/* ---------- スポット情報が必要な、意味の補正と確認 ---------- */

type SpotLookup = ReadonlyMap<string, Pick<Spot, "mealSlots">>;

function mapItineraries(state: StoredTrip, fn: (i: Itinerary) => Itinerary): StoredTrip {
  const f = (i: unknown) => fn(i as Itinerary);
  return {
    ...state,
    itinerary: state.itinerary ? (f(state.itinerary) as StoredTrip["itinerary"]) : state.itinerary,
    today: state.today
      ? {
          ...state.today,
          itinerary: f(state.today.itinerary) as NonNullable<StoredTrip["today"]>["itinerary"],
          history: state.today.history.map((h) => ({ ...h, before: h.before ? (f(h.before) as typeof h.before) : h.before })),
        }
      : state.today,
    history: state.history?.map((h) => ({ ...h, before: h.before ? (f(h.before) as typeof h.before) : h.before })),
  };
}

/** 旧版の旅程には、食事ブロックの印（meal）がない。食事向けのスポットの予定に、時間帯から ランチ／ディナー を付ける */
export function inferMeals(state: StoredTrip, spotById: SpotLookup): StoredTrip {
  return mapItineraries(state, (itin) => ({
    ...itin,
    days: itin.days.map((d) => ({
      ...d,
      blocks: d.blocks.map((b) => {
        if (b.meal || !b.spotId || b.fixed || b.label === "buffer" || b.label === "rest") return b;
        const slots = spotById.get(b.spotId)?.mealSlots;
        if (!slots?.length) return b;
        const slot: MealSlot = slots.length === 1 ? slots[0] : b.startMin < 15 * 60 && slots.includes("lunch") ? "lunch" : slots.includes("dinner") ? "dinner" : slots[0];
        return { ...b, meal: slot };
      }),
    })),
  }));
}

/** 保存データが参照しているスポットのうち、いまのデータにないもの（重複なし） */
export function findUnknownSpots(state: StoredTrip, spotById: ReadonlyMap<string, unknown>): string[] {
  const unknown = new Set<string>();
  const check = (id?: string) => {
    if (id && !spotById.has(id)) unknown.add(id);
  };
  mapItineraries(state, (itin) => {
    itin.prefs.mustSpotIds.forEach(check);
    itin.closedSpotIds.forEach(check);
    for (const d of itin.days) {
      for (const b of d.blocks) {
        check(b.spotId);
        check(b.planB?.spotId);
      }
    }
    return itin;
  });
  return [...unknown];
}
