import type { Budget, DietaryRestriction, InterestCategory, Itinerary, Pace, RainTolerance } from "../types";

/**
 * グループ（2〜6人）の希望を、1台の端末で集める。
 * 個人の入力（MemberInput）は、本人の入力画面でだけ見せる。集約結果（GroupAggregate）には、他の人の予算額や「苦手」の回答を含めない。
 */

export const GROUP_LIMITS = { minMembers: 2, maxMembers: 6, minDates: 2, maxDates: 4, maxWanted: 2 } as const;

/** 興味カテゴリへの答え。好き +2／どちらでも 0／苦手 −3（苦手は、好きより強く効かせる） */
export type InterestVote = "like" | "neutral" | "dislike";
export const VOTE_WEIGHT: Record<InterestVote, number> = { like: 2, neutral: 0, dislike: -3 };

export interface GroupMember {
  id: string;
  name: string;
}

export interface MemberInput {
  memberId: string;
  /** 参加できる日（候補日のうち） */
  availableDates: string[];
  /** 1人あたり1日の予算の上限（円）。本人の入力画面でだけ見える */
  budgetCapYen: number;
  dietary: DietaryRestriction[];
  rainTolerance: RainTolerance;
  pace: Pace;
  /** 書かれていないカテゴリは「どちらでも」 */
  interests: Partial<Record<InterestCategory, InterestVote>>;
  /** 行きたい場所（最大2件。1件目が第1希望） */
  wantedSpotIds: string[];
}

/* ---------- 集約の結果 ---------- */

export interface DateDecision {
  /** 決めた日（YYYY-MM-DD） */
  date: string;
  /** all: 全員が参加できる日 / most: 全員が揃う日がなく、参加者がいちばん多い日 / none: 参加できる人が誰もいない日しかない */
  mode: "all" | "most" | "none";
  /** 全員が参加できる日（mode が all のとき。早い順） */
  commonDates: string[];
  /** 決めた日に参加できない人 */
  absentees: string[];
  attendeeCount: number;
}

export type WishKind = "multi" | "member-first";

export interface MustReason {
  spotId: string;
  /** multi: 2人以上が希望した場所 / member-first: その人の希望が1件も入っていなかったので、第1希望を入れた */
  kind: WishKind;
  /** その場所を希望した人（「誰の希望か」は隠さない） */
  memberIds: string[];
}

export interface DroppedWish {
  memberId: string;
  spotId: string;
  /** closed: 決めた日が定休日 / diet: 食事制限に対応できない店 / unknown: データにない場所 */
  reason: "closed" | "diet" | "unknown";
}

export interface Adjustment {
  kind: "date" | "budget" | "dietary" | "rain" | "pace" | "must" | "dropped" | "interest" | "excluded";
  /** 1行の理由 */
  text: string;
}

export interface GroupAggregate {
  date: DateDecision;
  /** 決めた予算の上限（円/人/日）。全員の上限のうち最小 */
  budgetCapYen: number;
  budget: Budget;
  /** 食事制限（全員分の和集合） */
  dietary: DietaryRestriction[];
  /** いちばん慎重な人に合わせる */
  rainTolerance: RainTolerance;
  /** 中央値（偶数人で割れたら、ゆったり寄り） */
  pace: Pace;
  /** カテゴリごとの合計の重み */
  interestWeights: Record<InterestCategory, number>;
  /** 合計の重みが正のカテゴリ（重い順） */
  likedCategories: InterestCategory[];
  /** 必ず行く場所 */
  mustSpotIds: string[];
  mustReasons: MustReason[];
  /** Must 以外の希望（旅程づくりで加点する） */
  softWishes: { spotId: string; memberIds: string[] }[];
  droppedWishes: DroppedWish[];
  /** 集約に入れた人 / 未回答で入れなかった人 */
  memberIds: string[];
  excludedMemberIds: string[];
  adjustments: Adjustment[];
}

/* ---------- 案 ---------- */

/** balanced: 全員の満足度の最小値が最大 / max-sum: 満足度の合計が最大 / least-travel: 移動が最も少ない */
export type GroupPlanKind = "balanced" | "max-sum" | "least-travel";

export interface MemberSatisfaction {
  memberId: string;
  /** 0〜100 */
  score: number;
  /** 理由（具体的な「苦手」は書かない） */
  reasons: string[];
}

export interface GroupPlan {
  kind: GroupPlanKind;
  title: string;
  /** この案の目的の1行説明 */
  blurb: string;
  itinerary: Itinerary;
  satisfaction: MemberSatisfaction[];
  minScore: number;
  sumScore: number;
  /** 移動時間の合計（分）／ 徒歩の推定（m）／ 費用の目安（円/人） */
  travelMin: number;
  walkingM: number;
  estimatedCostYen: number;
  withinBudget: boolean;
  /** 1日の歩行距離の見込みが、ペース別の目安以内 */
  withinWalkLimit: boolean;
  /** 予定ごとの、その場所を希望した人 */
  requestedBy: Record<string, string[]>;
  /** 他の案と同じ内容だったため、この目的で次に良い案を出したとき */
  note?: string;
}

export interface GroupPlanSet {
  plans: GroupPlan[];
  /** どの案でも、誰かの満足度が SPLIT_THRESHOLD 未満 */
  split: boolean;
  candidateCount: number;
}

export const SPLIT_THRESHOLD = 40;

/* ---------- 投票・保存 ---------- */

export type DecidedBy = "majority" | "organizer-vote" | "organizer-choice";

export interface GroupDecision {
  kind: GroupPlanKind;
  decidedBy: DecidedBy;
  /** 確定した旅程のID */
  itineraryId: string;
}

export interface GroupState {
  version: 1;
  id: string;
  createdAt: string;
  organizerId: string;
  members: GroupMember[];
  candidateDates: string[];
  /** 回答済みの人の入力（memberId → 入力） */
  inputs: Record<string, MemberInput>;
  /** 1人1票（memberId → 案） */
  votes: Record<string, GroupPlanKind>;
  decision?: GroupDecision;
}
