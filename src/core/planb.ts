import { findOpenSlot, overlapsCrowded } from "./availability";
import { haversineM } from "./geo";
import { CATEGORY_LABEL, travelLabel } from "./labels";
import { BUDGET_COMFORT, categoryAffinity } from "./scoring";
import type { Block, Itinerary, PlanB, PlanningContext, Preferences, Spot } from "./types";

export const PLAN_B_MAX_DISTANCE_M = 2000;
const MIN_AFFINITY = 0.3;

export interface PlanBWindow {
  date: string;
  start: number;
  /** 元ブロックの終了時刻。Plan B の滞在時間の目安に使う */
  end: number;
}

export interface PlanBOptions {
  maxDistanceM?: number;
  /** すでに旅程に入っている／別ブロックの Plan B になっている／臨時休業のスポット */
  excludeIds?: ReadonlySet<string>;
  /** false にすると屋外のスポットも代替候補にする（臨時休業の代わりを探すとき） */
  requireIndoor?: boolean;
  prefs?: Preferences;
}

export interface PlanBCandidate {
  spot: Spot;
  distanceM: number;
  durationMin: number;
  score: number;
  reason: string;
}

/** Plan B の説明文（例: 屋内で雨でも安心・徒歩 約8分・同じ「アート」系） */
export function describePlanBReason(original: Spot, alt: Spot, ctx: PlanningContext): string {
  const travel = ctx.travel(original, alt);
  const closeness =
    alt.category === original.category
      ? `同じ「${CATEGORY_LABEL[alt.category]}」系`
      : `「${CATEGORY_LABEL[alt.category]}」で近い雰囲気`;
  return [
    alt.setting === "indoor" ? "屋内で雨でも安心" : alt.setting === "semi" ? "半屋外" : "屋外",
    travelLabel(travel.mode, travel.minutes),
    closeness,
  ].join("・");
}

/** Plan B の滞在時間: そのスポットの標準滞在時間を、元の枠に合わせて少しだけ調整する */
export function planBDuration(candidate: Spot, originalDurationMin: number): number {
  return Math.min(candidate.stayMin, Math.max(30, originalDurationMin + 15));
}

/**
 * 元スポットの Plan B 候補を、良い順に返す。
 * 必須条件: 屋内 / 2km以内 / その時間帯に営業している / 興味カテゴリが近い
 */
export function findPlanBCandidates(
  original: Spot,
  window: PlanBWindow,
  ctx: PlanningContext,
  opts: PlanBOptions = {},
): PlanBCandidate[] {
  const maxDist = opts.maxDistanceM ?? PLAN_B_MAX_DISTANCE_M;
  const requireIndoor = opts.requireIndoor ?? true;
  const prefs = opts.prefs;
  const originalDuration = Math.max(0, window.end - window.start);
  const out: PlanBCandidate[] = [];

  for (const c of ctx.spots) {
    if (c.id === original.id) continue;
    if (opts.excludeIds?.has(c.id)) continue;
    if (requireIndoor && c.setting !== "indoor") continue;

    const distanceM = haversineM(original, c);
    if (distanceM > maxDist) continue;

    const duration = planBDuration(c, originalDuration || c.stayMin);
    const slot = findOpenSlot(c, window.date, window.start, duration);
    if (!slot || slot.start !== window.start) continue; // ブロックの開始時刻にそのまま入れること

    // 興味カテゴリが近いこと（必須条件）。ユーザーの興味に合うものはさらに加点する
    const affinity = categoryAffinity(original, c);
    if (affinity < MIN_AFFINITY) continue;
    const interestMatch = !!prefs?.interests.includes(c.category);

    let score = 3 * affinity;
    if (interestMatch) score += 1;
    score += 1.5 * (1 - distanceM / maxDist);
    score += 0.2 * c.popularity;
    score -= 0.3 * (Math.abs(duration - originalDuration) / 30);
    if (overlapsCrowded(c, window.start, window.start + duration)) score -= 0.5;
    if (prefs) {
      score -= 0.7 * Math.max(0, c.priceLevel - BUDGET_COMFORT[prefs.budget]);
    }
    if (!requireIndoor && c.setting === "indoor") score += 0.5;

    out.push({
      spot: c,
      distanceM: Math.round(distanceM),
      durationMin: duration,
      score,
      reason: describePlanBReason(original, c, ctx),
    });
  }

  return out.sort((a, b) => b.score - a.score || a.spot.id.localeCompare(b.spot.id));
}

export function findPlanB(
  original: Spot,
  window: PlanBWindow,
  ctx: PlanningContext,
  opts: PlanBOptions = {},
): PlanBCandidate | null {
  return findPlanBCandidates(original, window, ctx, opts)[0] ?? null;
}

export function toPlanB(c: PlanBCandidate): PlanB {
  return { spotId: c.spot.id, reason: c.reason, distanceM: c.distanceM, durationMin: c.durationMin };
}

/** Plan B が必要なブロックか（屋外・半屋外の予定） */
export function needsPlanB(block: Block, ctx: PlanningContext): boolean {
  if (block.label === "buffer" || !block.spotId) return false;
  const spot = ctx.spotById.get(block.spotId);
  return !!spot && spot.setting !== "indoor";
}

function isPlanBStillValid(block: Block, planB: PlanB, date: string, ctx: PlanningContext, exclude: ReadonlySet<string>): boolean {
  const original = block.spotId ? ctx.spotById.get(block.spotId) : undefined;
  const c = ctx.spotById.get(planB.spotId);
  if (!original || !c || exclude.has(c.id) || c.setting !== "indoor") return false;
  if (haversineM(original, c) > PLAN_B_MAX_DISTANCE_M) return false;
  const slot = findOpenSlot(c, date, block.startMin, planB.durationMin);
  return !!slot && slot.start === block.startMin;
}

export interface AttachOptions {
  /** 指定すると、すでに始まったブロックは付け直さない（dayIndex の日にだけ適用） */
  nowMin?: number;
  dayIndex?: number;
}

/**
 * 旅程全体の屋外ブロックに Plan B を付ける（付け直す）。
 * - 旅程内の他のスポット・他ブロックの Plan B とは重複させない
 * - すでに付いている Plan B が今の時刻でも有効ならそのまま残す
 * - 切替済み（switched）のブロックは「元に戻す」参照をそのまま残す
 */
export function attachPlanBs(itin: Itinerary, ctx: PlanningContext, opts: AttachOptions = {}): Itinerary {
  const closed = new Set(itin.closedSpotIds);
  const inItinerary = new Set<string>();
  for (const d of itin.days) for (const b of d.blocks) if (b.spotId) inItinerary.add(b.spotId);

  const reserved = new Set<string>();
  const exclude = () => new Set<string>([...inItinerary, ...reserved, ...closed]);

  const days = itin.days.map((day) => ({
    ...day,
    blocks: day.blocks.map((block): Block => {
      if (!needsPlanB(block, ctx) && !block.switched) return block.label === "buffer" ? block : { ...block, planB: undefined };
      if (block.switched) return block;
      const started =
        opts.nowMin !== undefined && (opts.dayIndex === undefined || opts.dayIndex === day.index) && block.startMin <= opts.nowMin;
      if (block.skip === "skipped" || block.closed || started) {
        if (block.planB) reserved.add(block.planB.spotId);
        return block;
      }

      const ex = exclude();
      if (block.planB && isPlanBStillValid(block, block.planB, day.date, ctx, ex)) {
        reserved.add(block.planB.spotId);
        return block;
      }

      const original = ctx.spotById.get(block.spotId!)!;
      const found = findPlanB(original, { date: day.date, start: block.startMin, end: block.endMin }, ctx, {
        excludeIds: ex,
        prefs: itin.prefs,
      });
      if (found) {
        reserved.add(found.spot.id);
        return { ...block, planB: toPlanB(found) };
      }
      return { ...block, planB: null };
    }),
  }));

  return { ...itin, days };
}
