import { attachPlanBs, findPlanB, planBDuration, type PlanBCandidate } from "./planb";
import { commitBaseline, recomputeDay } from "./schedule";
import type { Block, Day, Itinerary, PlanningContext } from "./types";

/**
 * 旅程に対する部品的な操作（並べ替え・Plan B の入れ替え・代替スポット）。
 * 雨・遅延・臨時休業・疲れた・固定時刻の追加といった「組み直し」は core/replan.ts の replan() に集約している。
 * すべて純粋関数で、元の旅程は変更せず新しい旅程を返す。
 */

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

/* ---------- 並べ替え ---------- */

export interface MoveCheck {
  ok: boolean;
  reason?: string;
}

/**
 * ブロックの移動ができるか。固定時刻のブロックは動かせず、固定時刻をまたぐ並べ替えもできない
 * （またぐと、固定時刻より前後の予定が入れ替わってしまうため）。
 */
export function canReorder(day: Day, from: number, to: number): MoveCheck {
  if (from === to || from < 0 || to < 0 || from >= day.blocks.length || to >= day.blocks.length) return { ok: false };
  if (day.blocks[from].fixed) return { ok: false, reason: "固定時刻の予定は動かせません" };
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) {
    if (i !== from && day.blocks[i].fixed) return { ok: false, reason: "固定時刻をまたぐ並べ替えはできません" };
  }
  return { ok: true };
}

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
  if (!day || !canReorder(day, from, to).ok) return itin;
  const [moved] = day.blocks.splice(from, 1);
  day.blocks.splice(to, 0, moved);
  day.blocks = day.blocks.map((b) => ({ ...b, notBefore: undefined }));
  next.days[dayIndex] = commitBaseline(recomputeDay(day, ctx, { mode: "compact", marginMin: itin.settings.marginMin }));
  return attachPlanBs(next, ctx);
}

/* ---------- Plan B の入れ替え ---------- */

/** Plan B と元の予定を入れ替える（切替済みなら元に戻る）。進行中のブロックは、今いる場所から移動して始める */
export function swapPlanB(block: Block, ctx: PlanningContext, nowMin?: number): Block {
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

  if (nowMin !== undefined && block.startMin <= nowMin && nowMin < block.endMin) {
    const start = nowMin + ctx.travel(original, alt).minutes;
    swapped.startMin = start;
    swapped.endMin = start + swapped.durationMin;
    swapped.notBefore = start;
  }
  return swapped;
}

/* ---------- 臨時休業の代わり ---------- */

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

/** ブロックのスポットを別のスポットに置き換える（臨時休業の代替）。Plan B は付け直される */
export function replaceSpotOfBlock(block: Block, newSpotId: string, ctx: PlanningContext): Block {
  const alt = ctx.spotById.get(newSpotId);
  if (!alt) return block;
  return {
    ...block,
    spotId: alt.id,
    durationMin: planBDuration(alt, block.durationMin),
    closed: false,
    switched: false,
    skip: undefined,
    planB: undefined,
    issues: undefined,
  };
}
