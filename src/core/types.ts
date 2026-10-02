/**
 * ドメイン型。UI・ブラウザAPIに依存しない（core 配下は純粋関数のみ）。
 * 時刻はすべて「その日の 0:00 からの経過分」で持つ。
 */

export type InterestCategory =
  | "gourmet"
  | "cafe"
  | "history"
  | "nature"
  | "shopping"
  | "art"
  | "nightview";

export type Setting = "indoor" | "outdoor" | "semi";
export type PriceLevel = 0 | 1 | 2 | 3; // 0:無料 1:〜1,000円 2:〜3,000円 3:それ以上
export type Area = "tenjin" | "hakata" | "nakasu" | "ohori" | "momochi" | "dazaifu";
export type MealSlot = "lunch" | "dinner";

/** "HH:MM"（閉店が日付をまたぐ場合は "24:00" まで許容） */
export interface TimeRange {
  open: string;
  close: string;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Spot extends LatLng {
  id: string;
  name: string;
  area: Area;
  category: InterestCategory;
  /** 主カテゴリ以外で満たす興味（スコアリングと Plan B の「カテゴリが近い」判定に使う） */
  tags?: InterestCategory[];
  setting: Setting;
  hours: TimeRange[];
  /** 定休日（0=日 … 6=土） */
  closedDays?: number[];
  stayMin: number;
  priceLevel: PriceLevel;
  crowded?: TimeRange[];
  /** 1〜3。知名度。興味に合わなくても定番を混ぜるために使う */
  popularity: 1 | 2 | 3;
  /** 食事として扱えるスポット（ランチ／ディナー）。未指定は食事枠に使わない */
  mealSlots?: MealSlot[];
  description: string;
}

/* ---------- 入力 ---------- */

export type Duration = "day" | "overnight";
export type Companions = "solo" | "couple" | "friends" | "family";
export type Budget = "saving" | "normal" | "luxury";
export type Pace = "relaxed" | "normal" | "packed";
export type RainTolerance = "no-outdoor" | "light-rain-ok" | "dont-care";

export interface Preferences {
  duration: Duration;
  companions: Companions;
  budget: Budget;
  interests: InterestCategory[];
  pace: Pace;
  rainTolerance: RainTolerance;
  /** 「絶対に行きたい場所」 */
  mustSpotIds: string[];
}

/* ---------- 旅程 ---------- */

/** must: 絶対に行きたい / normal: 標準 / optional: 余力があれば / buffer: 余白（休憩・自由時間） */
export type BlockLabel = "must" | "normal" | "optional" | "buffer";
export type TravelMode = "walk" | "transit" | "none";

export interface PlanB {
  spotId: string;
  reason: string;
  distanceM: number;
  /** 切り替えたときの滞在時間（分） */
  durationMin: number;
}

export type BlockIssue = "outside-hours" | "over-day-end" | "closed";

export interface Block {
  id: string;
  label: BlockLabel;
  /** 余白ブロックでは undefined */
  spotId?: string;
  /** 滞在（余白は休憩）時間（分） */
  durationMin: number;
  /** 現在の開始・終了時刻（遅延などで再計算された値） */
  startMin: number;
  endMin: number;
  /** もともとの計画上の開始・終了時刻。再計算で「これより早くは始めない」基準にする */
  plannedStartMin?: number;
  plannedEndMin?: number;
  /** 直前の場所からの移動時間（分） */
  travelMin: number;
  travelMode: TravelMode;
  /**
   * Plan B。
   * undefined: 不要（屋内・余白） / null: 探したが見つからない / PlanB: あり。
   * 切替後（switched=true）は「元の予定に戻す」ための参照を指す。
   */
  planB?: PlanB | null;
  switched?: boolean;
  skip?: "candidate" | "skipped";
  /** スキップ候補になっても「それでも行く」を選んだ */
  keepAnyway?: boolean;
  /** 臨時休業 */
  closed?: boolean;
  /** 進行中ブロックを切り替えたとき、これより前には始められない */
  notBefore?: number;
  issues?: BlockIssue[];
  /** 混雑しやすい時間帯に重なっている */
  crowdedOverlap?: boolean;
}

export interface Origin extends LatLng {
  name: string;
}

export interface Day {
  index: number;
  /** YYYY-MM-DD */
  date: string;
  startMin: number;
  endMin: number;
  origin: Origin;
  blocks: Block[];
  warnings: string[];
}

export interface Itinerary {
  version: 1;
  id: string;
  createdAt: string;
  startDate: string;
  prefs: Preferences;
  days: Day[];
  closedSpotIds: string[];
}

/* ---------- 外部データ（adapter から注入） ---------- */

export interface TravelEstimate {
  minutes: number;
  mode: Exclude<TravelMode, "none">;
  distanceM: number;
}

/** 2点間の移動時間の見積もり。実APIに差し替える場合は事前取得した行列を引く同期関数にして渡す */
export type TravelEstimator = (from: LatLng, to: LatLng) => TravelEstimate;

export interface PlanningContext {
  spots: Spot[];
  spotById: Map<string, Spot>;
  travel: TravelEstimator;
}

export interface GenerateInput {
  prefs: Preferences;
  ctx: PlanningContext;
  /** YYYY-MM-DD（1日目） */
  startDate: string;
  /** テスト・再現用に旅程IDを固定したいとき */
  id?: string;
  createdAt?: string;
}

/** 旅程生成を差し替え可能にするための関数型（ルールベース → LLM など） */
export type ItineraryGenerator = (input: GenerateInput) => Itinerary;
