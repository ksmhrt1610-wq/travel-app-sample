import { isInert, placeOf, recomputeDay, type RecomputeOptions } from "./schedule";
import type { Block, Day, PlanningContext, Spot } from "./types";

/**
 * 動線の改善（2-opt）。
 * 旅程のスポット（食事・固定時刻・余白・休憩は元の位置のまま）の並び順を入れ替えて、移動時間の合計を減らす。
 * 営業時間・食事の窓・固定時刻・日の終了時刻を壊す並びは採用しない。
 *
 * 旅程の生成直後（貪欲法の結果）に使う。貪欲法は「次に一番よさそうな場所」を選ぶので、
 * エリアを行ったり来たりすることがある。
 */

const NIGHTVIEW_EARLIEST = 17 * 60 + 30;
const MIN_GAIN_MIN = 3;
/** エリアを行き来する1回を、移動時間に換算して何分ぶんの損とみなすか */
const REVISIT_COST_MIN = 8;
const MAX_PASSES = 20;

/** 並べ替えの対象にするブロック（食事・固定時刻・休憩・余白は動かさない） */
function isSlot(b: Block, ctx: PlanningContext): boolean {
  if (isInert(b) || b.fixed || b.meal) return false;
  if (b.label !== "must" && b.label !== "normal" && b.label !== "optional") return false;
  const spot = b.spotId ? ctx.spotById.get(b.spotId) : undefined;
  return !!spot && !spot.mealSlots;
}

/** 日の移動時間の合計（分） */
export function totalTravelMin(day: Day): number {
  return day.blocks.reduce((n, b) => n + (isInert(b) ? 0 : b.travelMin), 0);
}

/** 同じエリアに「戻る」回数（A → B → A の最後の A）。動線のぎくしゃく具合の目安 */
export function areaRevisits(day: Day, ctx: PlanningContext): number {
  const seen = new Set<Spot["area"]>();
  let prev: Spot["area"] | undefined;
  let n = 0;
  for (const b of day.blocks) {
    if (isInert(b) || !b.spotId) continue;
    const area = ctx.spotById.get(b.spotId)?.area;
    if (!area) continue;
    if (area !== prev && seen.has(area)) n++;
    seen.add(area);
    prev = area;
  }
  return n;
}

function issueCount(day: Day): number {
  return day.blocks.filter((b) => !isInert(b) && (b.issues?.length ?? 0) > 0).length;
}

function lastEnd(day: Day): number {
  return day.blocks.reduce((m, b) => (isInert(b) ? m : Math.max(m, b.endMin)), 0);
}

/** 夜景は日没後（17:30以降）にしか入れない */
function nightviewOk(day: Day, ctx: PlanningContext): boolean {
  return day.blocks.every((b) => {
    if (isInert(b) || !b.spotId) return true;
    const s = ctx.spotById.get(b.spotId);
    return !(s?.category === "nightview" && b.startMin < NIGHTVIEW_EARLIEST);
  });
}

export function improveRoute(day: Day, ctx: PlanningContext, opts: RecomputeOptions & { fit?: (b: Block) => number } = {}): Day {
  const rc = (d: Day) => recomputeDay(d, ctx, { mode: "preserve", ...opts });
  let cur = rc(day);
  const slotIdx = cur.blocks.map((b, i) => (isSlot(b, ctx) && placeOf(b, ctx) ? i : -1)).filter((i) => i >= 0);
  if (slotIdx.length < 2) return cur;

  const fitOf = (d: Day) => (opts.fit ? d.blocks.reduce((n, b) => n + (isInert(b) ? 0 : opts.fit!(b)), 0) : 0);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const baseRevisits = areaRevisits(cur, ctx);
    const baseScore = totalTravelMin(cur) + REVISIT_COST_MIN * baseRevisits;
    const baseIssues = issueCount(cur);
    const baseEnd = lastEnd(cur);
    const baseFit = fitOf(cur);
    let best: { day: Day; gain: number } | null = null;

    for (let a = 0; a < slotIdx.length - 1; a++) {
      for (let b = a + 1; b < slotIdx.length; b++) {
        // slotIdx[a..b] の中身の並びを逆順にする
        const contents = slotIdx.slice(a, b + 1).map((i) => cur.blocks[i]);
        const reversed = [...contents].reverse();
        const blocks = [...cur.blocks];
        slotIdx.slice(a, b + 1).forEach((slotI, k) => {
          const slot = cur.blocks[slotI];
          const blk = reversed[k];
          // 時刻の下限は「位置」に付く。入れ替わったスポットは、その位置の下限を引き継ぐ
          blocks[slotI] = {
            ...blk,
            startMin: slot.startMin,
            endMin: slot.startMin + blk.durationMin,
            plannedStartMin: slot.plannedStartMin ?? slot.startMin,
            plannedEndMin: undefined,
            notBefore: undefined,
          };
        });
        const trial = rc({ ...cur, blocks });
        if (issueCount(trial) > baseIssues) continue;
        if (!nightviewOk(trial, ctx)) continue;
        if (lastEnd(trial) > baseEnd + 20) continue;
        if (fitOf(trial) < baseFit - 0.3) continue;
        // エリアの行き来は増やさない
        const revisits = areaRevisits(trial, ctx);
        if (revisits > baseRevisits) continue;
        const gain = baseScore - (totalTravelMin(trial) + REVISIT_COST_MIN * revisits);
        if (gain >= MIN_GAIN_MIN && (!best || gain > best.gain)) best = { day: trial, gain };
      }
    }
    if (!best) break;
    cur = best.day;
  }
  return cur;
}
