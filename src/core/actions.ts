import { attachPlanBs, findPlanB, planBDuration, type PlanBCandidate } from "./planb";
import { commitBaseline, recomputeDay, settleDay } from "./schedule";
import type { Block, Day, Itinerary, PlanningContext } from "./types";

/**
 * 旅程に対する操作（並べ替え・Plan B 切替・遅延・臨時休業・スキップ）。
 * すべて純粋関数で、元の旅程は変更せず新しい旅程を返す。
 * nowMin / dayIndex を渡すと「当日モード」の操作になり、開始済みのブロックは動かさない。
 */

export interface LiveOptions {
  /** 現在時刻（0:00 からの分）。当日モードでのみ指定 */
  nowMin?: number;
}

export interface BlockRef {
  dayIndex: number;
  index: number;
  block: Block;
}

export function locateBlock(itin: Itinerary, blockId: string): BlockRef | null {
  for (const day of itin.days) {
    const index = day.blocks.findIndex((b) => b.id === blockId);
    if (index >= 0) return { dayIndex: day.index, index, block: day.blocks[index] };
  }
  return null;
}

const clone = <T>(x: T): T => structuredClone(x);

/** 指定した日の時刻を再計算し、Plan B を付け直す */
export function settle(
  itin: Itinerary,
  ctx: PlanningContext,
  dayIndex: number,
  opts: { nowMin?: number; delayMin?: number; mode?: "preserve" | "compact" } = {},
): Itinerary {
  const days = itin.days.map((d) => (d.index === dayIndex ? settleDay(d, ctx, { mode: "preserve", ...opts }) : d));
  return attachPlanBs({ ...itin, days }, ctx, { nowMin: opts.nowMin, dayIndex });
}

/* ---------- 並べ替え ---------- */

/** ブロックを並べ替え、先頭から時刻を詰め直す（計画上の時刻も更新する） */
export function reorderBlocks(
  itin: Itinerary,
  dayIndex: number,
  from: number,
  to: number,
  ctx: PlanningContext,
): Itinerary {
  const next = clone(itin);
  const day = next.days[dayIndex];
  if (!day || from === to || from < 0 || to < 0 || from >= day.blocks.length || to >= day.blocks.length) return itin;
  const [moved] = day.blocks.splice(from, 1);
  day.blocks.splice(to, 0, moved);
  day.blocks = day.blocks.map((b) => ({ ...b, skip: undefined, notBefore: undefined }));
  next.days[dayIndex] = commitBaseline(recomputeDay(day, ctx, { mode: "compact" }));
  return attachPlanBs(next, ctx);
}

/* ---------- Plan B 切替 ---------- */

function swapPlanB(block: Block, ctx: PlanningContext, nowMin?: number): Block {
  if (!block.planB || !block.spotId) return block;
  const original = ctx.spotById.get(block.spotId);
  const alt = ctx.spotById.get(block.planB.spotId);
  if (!original || !alt) return block;

  const wasSwitched = !!block.switched;
  const swapped: Block = {
    ...block,
    spotId: alt.id,
    durationMin: block.planB.durationMin,
    planB: {
      spotId: original.id,
      reason: wasSwitched ? "Plan B に切り替える" : "元の予定に戻す",
      distanceM: block.planB.distanceM,
      durationMin: block.durationMin,
    },
    switched: !wasSwitched,
    closed: false,
    skip: undefined,
  };

  // 進行中のブロックを切り替えるときは、今いる場所から Plan B へ移動してから始める
  if (nowMin !== undefined && block.startMin <= nowMin && nowMin < block.endMin) {
    const start = nowMin + ctx.travel(original, alt).minutes;
    swapped.startMin = start;
    swapped.endMin = start + swapped.durationMin;
    swapped.notBefore = start;
  }
  return swapped;
}

/** 複数ブロックを Plan B に切り替える（切替済みなら元に戻す）。時刻の再計算は最後に1回だけ行う */
export function switchBlocks(
  itin: Itinerary,
  blockIds: string[],
  ctx: PlanningContext,
  live: LiveOptions = {},
): Itinerary {
  const next = clone(itin);
  const touched = new Set<number>();
  for (const id of blockIds) {
    const ref = locateBlock(next, id);
    if (!ref || !ref.block.planB) continue;
    next.days[ref.dayIndex].blocks[ref.index] = swapPlanB(ref.block, ctx, live.nowMin);
    touched.add(ref.dayIndex);
  }
  if (!touched.size) return itin;
  let result = next;
  for (const di of touched) result = settle(result, ctx, di, { nowMin: live.nowMin });
  return result;
}

export function switchBlock(itin: Itinerary, blockId: string, ctx: PlanningContext, live: LiveOptions = {}): Itinerary {
  return switchBlocks(itin, [blockId], ctx, live);
}

/* ---------- 遅延・臨時休業 ---------- */

/** 電車などの遅延。次の予定への到着が delayMin 遅れ、後ろの予定を再計算する（余白が遅れを吸収する） */
export function applyDelay(
  itin: Itinerary,
  dayIndex: number,
  delayMin: number,
  nowMin: number,
  ctx: PlanningContext,
): Itinerary {
  return settle(itin, ctx, dayIndex, { nowMin, delayMin });
}

/** スポットの臨時休業。まだ終わっていない該当ブロックを休業扱いにして再計算する */
export function markSpotClosed(
  itin: Itinerary,
  spotId: string,
  dayIndex: number,
  nowMin: number,
  ctx: PlanningContext,
): Itinerary {
  const next = clone(itin);
  if (!next.closedSpotIds.includes(spotId)) next.closedSpotIds.push(spotId);
  const day = next.days[dayIndex];
  day.blocks = day.blocks.map((b) => (b.spotId === spotId && b.endMin > nowMin && !b.skip ? { ...b, closed: true } : b));
  return settle(next, ctx, dayIndex, { nowMin });
}

/** 休業したブロックの代わりの候補（Plan B があればそれ、なければ近い別のスポット） */
export function suggestReplacement(
  itin: Itinerary,
  blockId: string,
  ctx: PlanningContext,
): PlanBCandidate | null {
  const ref = locateBlock(itin, blockId);
  if (!ref || !ref.block.spotId) return null;
  const { block } = ref;
  const day = itin.days[ref.dayIndex];
  const original = ctx.spotById.get(block.spotId!);
  if (!original) return null;

  const exclude = new Set<string>(itin.closedSpotIds);
  for (const d of itin.days) for (const b of d.blocks) if (b.spotId) exclude.add(b.spotId);
  for (const d of itin.days) for (const b of d.blocks) if (b.planB && b.id !== blockId) exclude.add(b.planB.spotId);

  if (block.planB && !block.switched) {
    const alt = ctx.spotById.get(block.planB.spotId);
    if (alt && !itin.closedSpotIds.includes(alt.id)) {
      return { spot: alt, distanceM: block.planB.distanceM, durationMin: block.planB.durationMin, score: 0, reason: block.planB.reason };
    }
  }
  return findPlanB(original, { date: day.date, start: block.plannedStartMin ?? block.startMin, end: block.endMin }, ctx, {
    excludeIds: exclude,
    requireIndoor: false,
    prefs: itin.prefs,
  });
}

/** ブロックのスポットを別のスポットに置き換える（臨時休業の代替など）。置き換え後の Plan B は付け直す */
export function replaceBlockSpot(
  itin: Itinerary,
  blockId: string,
  newSpotId: string,
  ctx: PlanningContext,
  live: LiveOptions = {},
): Itinerary {
  const next = clone(itin);
  const ref = locateBlock(next, blockId);
  const alt = ctx.spotById.get(newSpotId);
  if (!ref || !alt) return itin;
  const b = ref.block;
  next.days[ref.dayIndex].blocks[ref.index] = {
    ...b,
    spotId: alt.id,
    durationMin: planBDuration(alt, b.durationMin),
    closed: false,
    switched: false,
    skip: undefined,
    planB: undefined,
    issues: undefined,
  };
  return settle(next, ctx, ref.dayIndex, { nowMin: live.nowMin });
}

/* ---------- スキップ ---------- */

function mapBlocks(itin: Itinerary, dayIndex: number, fn: (b: Block) => Block): Itinerary {
  const next = clone(itin);
  const day: Day = next.days[dayIndex];
  day.blocks = day.blocks.map(fn);
  return next;
}

export function skipBlocks(itin: Itinerary, dayIndex: number, blockIds: string[], nowMin: number, ctx: PlanningContext): Itinerary {
  const ids = new Set(blockIds);
  const next = mapBlocks(itin, dayIndex, (b) => (ids.has(b.id) ? { ...b, skip: "skipped", keepAnyway: false } : b));
  return settle(next, ctx, dayIndex, { nowMin });
}

/** スキップ候補になっているブロックをすべてスキップする */
export function skipAllCandidates(itin: Itinerary, dayIndex: number, nowMin: number, ctx: PlanningContext): Itinerary {
  const ids = itin.days[dayIndex].blocks.filter((b) => b.skip === "candidate").map((b) => b.id);
  return skipBlocks(itin, dayIndex, ids, nowMin, ctx);
}

/** 「それでも行く」: スキップ候補を外し、以後は候補にしない */
export function keepBlock(itin: Itinerary, dayIndex: number, blockId: string, nowMin: number, ctx: PlanningContext): Itinerary {
  const next = mapBlocks(itin, dayIndex, (b) => (b.id === blockId ? { ...b, skip: undefined, keepAnyway: true } : b));
  return settle(next, ctx, dayIndex, { nowMin });
}

/** スキップを取り消す */
export function restoreBlock(itin: Itinerary, dayIndex: number, blockId: string, nowMin: number, ctx: PlanningContext): Itinerary {
  const next = mapBlocks(itin, dayIndex, (b) => (b.id === blockId ? { ...b, skip: undefined, keepAnyway: true } : b));
  return settle(next, ctx, dayIndex, { nowMin });
}
