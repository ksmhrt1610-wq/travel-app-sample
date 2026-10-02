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
/** 食事制限。豚肉なし／魚介なし／小麦なし／ベジタリアン */
export type DietaryRestriction = "no-pork" | "no-seafood" | "no-wheat" | "vegetarian";

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
  /** 時間が足りないときに短縮できる下限（分）。未指定は stayMin の半分（15分未満にはしない） */
  minStayMin?: number;
  priceLevel: PriceLevel;
  crowded?: TimeRange[];
  /** 1〜3。知名度。興味に合わなくても定番を混ぜるために使う */
  popularity: 1 | 2 | 3;
  /** 食事として扱えるスポット（ランチ／ディナー）。未指定は食事枠に使わない */
  mealSlots?: MealSlot[];
  /** 軽食（梅ヶ枝餅など）。食事枠には使わない。通常のスポットとして立ち寄る */
  snack?: boolean;
  /** 屋内で座って休める場所（カフェ・商業施設・博物館など）。「疲れた」の休憩場所の候補になる */
  restable: boolean;
  /** 食事向けのスポットが対応できる食事制限（サンプルの仮データ。実際の対応は店に確認）。未指定は、どの制限にも対応しない */
  accommodates?: DietaryRestriction[];
  /** データについての補足（店名・営業時間・位置が概算など）。画面にも出す */
  dataNote?: string;
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
  /** 食事制限（グループの全員分の和集合）。あれば、食事はすべての制限に対応できる店だけから選ぶ */
  dietary?: DietaryRestriction[];
}

/* ---------- 旅程 ---------- */

/**
 * 再計画のときの保護の優先順位（高い順）: 固定時刻 > Must > 食事 > 休憩 > 標準 > Optional。
 * 余白（buffer）は遅れの吸収材として最初に縮む（ペース別の下限まで）。
 *   fixed: 固定時刻（終電・予約など。動かせない）/ must: 絶対に行きたい / normal: 標準
 *   optional: 余力があれば / buffer: 余白（遅れを吸収する自由時間）/ rest: 「疲れた」で入れた休憩（保護される）
 * 食事はラベルとは別に `meal` 属性で表す（食事の店が Must のこともあるため）。
 */
export type BlockLabel = "fixed" | "must" | "normal" | "optional" | "buffer" | "rest";
export type TravelMode = "walk" | "transit" | "none";

export interface PlanB {
  spotId: string;
  reason: string;
  distanceM: number;
  /** 切り替えたときの滞在時間（分） */
  durationMin: number;
}

/**
 * outside-hours: 営業時間に収まらない / over-day-end: 1日の終了予定時刻を超える / closed: 臨時休業
 * fixed-missed: 固定時刻に間に合わない / after-last-transport: 最終便のあとに予定が残っている
 * outside-meal-window: 食事が食事の時間帯に収まらない
 */
export type BlockIssue =
  | "outside-hours"
  | "over-day-end"
  | "closed"
  | "fixed-missed"
  | "after-last-transport"
  /** 食事が、食事の時間帯（ランチ 11:00〜14:30／ディナー 17:00〜21:00）に収まらない */
  | "outside-meal-window";

/* ---------- 固定時刻・メンバー ---------- */

export type FixedKind = "last-transport" | "checkin" | "reservation" | "car-return" | "meetup";

export interface Member {
  id: string;
  name: string;
}

/** 固定時刻（絶対に守る時刻）。全員に効くものは旅程のブロックに、特定メンバーだけのものは Day.memberFixed に入る */
export interface FixedEvent {
  id: string;
  kind: FixedKind;
  /** 例: 「太宰府駅 18:05 の電車（最終）」 */
  title: string;
  /** 固定時刻（0:00 からの分）。この時刻にその場所にいる／出発する */
  timeMin: number;
  dayIndex: number;
  place: Origin;
  /** 場所がスポットのとき（予約など） */
  spotId?: string;
  /** その場所での所要時間（交通は 0） */
  durationMin: number;
  /** 帰りの最終便など。これに乗ったらその日の予定は終わり */
  endsDay: boolean;
  /** 対象メンバー。null は全員 */
  memberIds: string[] | null;
}

export interface Block {
  id: string;
  label: BlockLabel;
  /** 余白ブロックでは undefined */
  spotId?: string;
  /** 滞在（余白は休憩）時間（分）。時間が足りないときは最低滞在時間まで短縮される */
  durationMin: number;
  /** 現在の開始・終了時刻（遅延などで再計算された値） */
  startMin: number;
  endMin: number;
  /** もともとの計画上の開始・終了時刻。再計算で「これより早くは始めない」基準にする */
  plannedStartMin?: number;
  plannedEndMin?: number;
  /** 直前の場所からの移動時間（分）と道のり（m） */
  travelMin: number;
  travelMode: TravelMode;
  travelDistanceM?: number;
  /**
   * Plan B。
   * undefined: 不要（屋内・余白） / null: 探したが見つからない / PlanB: あり。
   * 切替後（switched=true）は「元の予定に戻す」ための参照を指す。
   */
  planB?: PlanB | null;
  switched?: boolean;
  skip?: "skipped";
  /** 食事ブロック（ランチ／ディナー）。削除せず、時刻・滞在・店の差し替えで調整する */
  meal?: MealSlot;
  /** 実績: 実際に着いた時刻・出発した時刻（0:00 からの分）。あれば、時刻による「開始済み」の判定より優先する */
  actualStartMin?: number;
  actualEndMin?: number;
  /** ユーザーが当日に入れた寄り道。エンジンが自動では削らない（Must が危うくなるときは「削る候補」として確認する） */
  detour?: boolean;
  /** 座標のない自由入力の寄り道。移動は travelMin 分と仮定する */
  free?: FreeStop;
  /** 臨時休業 */
  closed?: boolean;
  /** 進行中ブロックを切り替えたとき、これより前には始められない */
  notBefore?: number;
  issues?: BlockIssue[];
  /** issues があるときの不足分（分）。固定時刻に何分足りないか、閉店を何分超えるか */
  lateByMin?: number;
  /** 混雑しやすい時間帯に重なっている */
  crowdedOverlap?: boolean;
  /** 固定時刻ブロック（label が fixed）。全員に効く固定時刻 */
  fixed?: FixedEvent;
  /** スポットではない場所（駅・宿など）。固定時刻ブロックや、場所を決めない休憩で使う */
  place?: Origin;
}

export interface FreeStop {
  name: string;
  /** 直前の場所からの移動時間（分）。座標がないので、仮定の値 */
  travelMin: number;
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
  /** 特定のメンバーだけの固定時刻（旅程全体の時刻には影響しない） */
  memberFixed?: FixedEvent[];
  /** 「かなり疲れた」以降は、徒歩を短く見積もる */
  lowWalking?: boolean;
}

/** 当日の対応のしかた。手動: 変更はすべて差分→確定 / 提案: 軽い変更はワンタップ・重い変更は差分→確定 / おまかせ: 軽い変更は自動で反映 */
export type ResponseMode = "manual" | "suggest" | "auto";

export interface ItinerarySettings {
  /** 固定時刻の余裕時間（分）。出発すべき時刻 = 固定時刻 − 移動時間 − 余裕時間 */
  marginMin: number;
  /** 当日の対応のしかた（旅程ごとに保存）。省略時は「提案」 */
  mode?: ResponseMode;
}

export interface Itinerary {
  version: 1;
  id: string;
  createdAt: string;
  startDate: string;
  prefs: Preferences;
  days: Day[];
  closedSpotIds: string[];
  members: Member[];
  settings: ItinerarySettings;
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
  /** 生成の調整（テストで効果を比べるために切り替えられる。省略時はどちらも有効） */
  options?: {
    /** 動線の改善（2-opt）をする */
    optimizeRoute?: boolean;
    /** 1日の歩行距離をペース別の目安の85%以内に収める */
    limitWalking?: boolean;
    /** スポットごとの加点・減点（グループの好みなど）。省略時は 0。食事の店選びにも効く */
    spotBias?: (spot: Spot) => number;
    /** 移動・エリアの行き来にかかる減点の倍率（省略時 1）。大きいほど、近場でまとまる */
    travelPenaltyScale?: number;
  };
}

/** 旅程生成を差し替え可能にするための関数型（ルールベース → LLM など） */
export type ItineraryGenerator = (input: GenerateInput) => Itinerary;
