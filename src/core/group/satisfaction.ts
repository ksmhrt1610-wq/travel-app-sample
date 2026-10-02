import { RAIN_PENALTY } from "../scoring";
import { isInert } from "../schedule";
import { dayWalking } from "../walking";
import type { Block, InterestCategory, Itinerary, Pace, PlanningContext, PriceLevel, Spot } from "../types";
import { VOTE_WEIGHT, type MemberInput, type MemberSatisfaction } from "./types";

/**
 * 満足度（0〜100）。計算式（docs/decisions.md 5-4 にも書いてある）:
 *   満足度 = 100 × Σ(重み × 項目の点数) ÷ Σ(使った重み)   各項目は 0〜1
 *   interest（重み 0.65）: 予定ごとの好みの合い方の平均。
 *       予定の好み = 主カテゴリの答え + タグの答えの半分（−3〜+2 に収める）。
 *       0〜1 に直す: 好き+2→1.0、どちらでも0→0.5、苦手−3→0.0（途中は直線）。
 *       食事は重み 0.5、「苦手」の減点はしない（食事は誰でもとるので、0 を下限にする）。
 *   wish（重み 0.20）: その人が行きたい場所のうち、案に入っている割合。行きたい場所がない人は、この項目を使わない。
 *   pace（重み 0.06）: 1 − |本人の希望のペース − 案のペース| ÷ 2。
 *   rain（重み 0.05）: 1 − 屋外の予定の減点の合計 ÷ (2 × 予定数)。減点は雨への許容度ごと（scoring.ts の RAIN_PENALTY）。
 *   budget（重み 0.04）: 費用の目安が本人の上限以内なら 1。超えたら、超えた割合だけ下げる。
 */
export const SAT_WEIGHTS = { interest: 0.65, wish: 0.2, pace: 0.06, rain: 0.05, budget: 0.04 } as const;
const MEAL_WEIGHT = 0.5;

/** 価格帯 → 費用の目安（円/人。1つの予定あたり）。無料 / 〜1,000円 / 〜3,000円 / それ以上 の真ん中あたり。移動費は含めない */
export const PRICE_YEN: Record<PriceLevel, number> = { 0: 0, 1: 700, 2: 2000, 3: 4500 };

const PACE_INDEX: Record<Pace, number> = { relaxed: 0, normal: 1, packed: 2 };

type Votes = MemberInput["interests"];

const w = (v: Votes, c: InterestCategory) => VOTE_WEIGHT[v[c] ?? "neutral"];

/** その人にとっての、スポットの好みの合い方（−3〜+2） */
export function spotAffinity(votes: Votes, spot: Pick<Spot, "category" | "tags">): number {
  const raw = w(votes, spot.category) + 0.5 * (spot.tags ?? []).reduce((n, t) => n + w(votes, t), 0);
  return Math.min(2, Math.max(-3, raw));
}

/** −3〜+2 を 0〜1 に（0 が 0.5） */
function to01(a: number): number {
  return a >= 0 ? 0.5 + (0.5 * a) / 2 : 0.5 + (0.5 * a) / 3;
}

/** 案に入っている予定（スキップ・休業・余白・休憩を除く） */
export function plannedBlocks(itin: Itinerary): Block[] {
  return itin.days.flatMap((d) => d.blocks.filter((b) => !isInert(b) && !!b.spotId && b.label !== "buffer" && b.label !== "rest"));
}

export function estimateCostYen(itin: Itinerary, ctx: PlanningContext): number {
  let sum = 0;
  for (const b of plannedBlocks(itin)) {
    const sp = ctx.spotById.get(b.spotId!);
    if (sp) sum += PRICE_YEN[sp.priceLevel];
  }
  return sum;
}

export function planTravel(itin: Itinerary, ctx: PlanningContext): { travelMin: number; walkingM: number } {
  let travelMin = 0;
  let walkingM = 0;
  for (const d of itin.days) {
    for (const b of d.blocks) if (!isInert(b)) travelMin += b.travelMin;
    walkingM += dayWalking(d, ctx, itin.prefs.pace).totalM;
  }
  return { travelMin, walkingM };
}

export interface SatisfactionParts {
  interest: number;
  wish: number | null;
  pace: number;
  rain: number;
  budget: number;
}

export function satisfactionParts(input: MemberInput, itin: Itinerary, ctx: PlanningContext): SatisfactionParts & { liked: number; wishHit: number } {
  const blocks = plannedBlocks(itin);
  let num = 0;
  let den = 0;
  let liked = 0;
  let outdoorPenalty = 0;
  let activities = 0;
  for (const b of blocks) {
    const sp = ctx.spotById.get(b.spotId!);
    if (!sp) continue;
    const isMeal = !!b.meal;
    const aff = spotAffinity(input.interests, sp);
    const weight = isMeal ? MEAL_WEIGHT : 1;
    num += weight * to01(isMeal ? Math.max(0, aff) : aff);
    den += weight;
    if (!isMeal) {
      activities++;
      if (aff > 0) liked++;
      outdoorPenalty += RAIN_PENALTY[input.rainTolerance][sp.setting];
    }
  }
  const interest = den > 0 ? num / den : 0.5;

  const wanted = [...new Set(input.wantedSpotIds)];
  const inPlan = new Set(blocks.map((b) => b.spotId!));
  const wishHit = wanted.filter((id) => inPlan.has(id)).length;
  const wish = wanted.length ? wishHit / wanted.length : null;

  const pace = 1 - Math.abs(PACE_INDEX[input.pace] - PACE_INDEX[itin.prefs.pace]) / 2;
  const rain = activities > 0 ? Math.max(0, 1 - outdoorPenalty / (2 * activities)) : 1;
  const cost = estimateCostYen(itin, ctx);
  const budget = cost <= input.budgetCapYen ? 1 : Math.max(0, 1 - (cost - input.budgetCapYen) / Math.max(1, input.budgetCapYen));
  return { interest, wish, pace, rain, budget, liked, wishHit };
}

export function scoreOf(p: SatisfactionParts): number {
  let sum = SAT_WEIGHTS.interest * p.interest + SAT_WEIGHTS.pace * p.pace + SAT_WEIGHTS.rain * p.rain + SAT_WEIGHTS.budget * p.budget;
  let den = SAT_WEIGHTS.interest + SAT_WEIGHTS.pace + SAT_WEIGHTS.rain + SAT_WEIGHTS.budget;
  if (p.wish !== null) {
    sum += SAT_WEIGHTS.wish * p.wish;
    den += SAT_WEIGHTS.wish;
  }
  return Math.round((100 * sum) / den);
}

/**
 * 満足度と、その理由。理由には、具体的な「苦手」を書かない
 * （「好みに合う予定が少なめ」のように、誰かが苦手と答えたカテゴリが分からない言い方にする）。
 */
export function memberSatisfaction(input: MemberInput, itin: Itinerary, ctx: PlanningContext): MemberSatisfaction {
  const p = satisfactionParts(input, itin, ctx);
  const reasons: string[] = [];
  const wantedCount = new Set(input.wantedSpotIds).size;
  if (wantedCount > 0) {
    if (p.wishHit === wantedCount) reasons.push(`行きたい場所が${wantedCount === 1 ? "入っています" : `${wantedCount}件とも入っています`}`);
    else if (p.wishHit > 0) reasons.push(`行きたい場所のうち${p.wishHit}件が入っています`);
    else reasons.push("行きたい場所は入りませんでした");
  }
  if (p.liked > 0) reasons.push(`好みに合う予定が${p.liked}件あります`);
  else if (p.interest < 0.5) reasons.push("好みに合う予定が少なめです");
  if (p.pace < 1) reasons.push("ペースが希望と少し違います");
  if (p.rain < 0.75) reasons.push("屋外の予定が、希望より多めです");
  if (p.budget < 1) reasons.push("費用の目安が、上限を超えています");
  return { memberId: input.memberId, score: scoreOf(p), reasons: reasons.slice(0, 3) };
}
