import { findOpenSlot, overlapsCrowded } from "./availability";
import type { Block, BlockIssue, Day, LatLng, PlanningContext } from "./types";

/** 余白ブロックが遅れを吸収して縮められる下限（分） */
export const MIN_BUFFER_MIN = 10;
/** 開店まで待ってでも入れる上限（分）。これを超える待ちは営業時間外として扱う */
export const MAX_WAIT_FOR_OPENING_MIN = 90;

export type RecomputeMode =
  /** 計画上の開始時刻より早めない。遅延・スキップ・Plan B 切替向け */
  | "preserve"
  /** 先頭から詰め直す。並べ替え向け */
  | "compact";

export interface RecomputeOptions {
  mode?: RecomputeMode;
  /** 現在時刻（0:00 からの分）。指定すると、開始済みのブロックは動かさない */
  nowMin?: number;
  /** 遅延（分）。最初の未開始ブロックの開始に加算され、そのブロックの notBefore として残る */
  delayMin?: number;
}

export function isInert(b: Block): boolean {
  return b.skip === "skipped" || !!b.closed;
}

/**
 * 1日分のブロックの時刻を再計算する（純粋関数。入力は変更しない）。
 *
 * - 開始済み（startMin <= nowMin）のブロックは固定。
 * - 各ブロックの開始 = max(前の場所からの到着, 計画上の開始, notBefore)。営業開始まで待てる場合は待つ。
 * - 遅延は最初の未開始ブロックの開始を delayMin 遅らせる。後ろのブロックは、余白・空き時間に吸収されなかった分だけ押し出される。
 * - 余白ブロックは遅れを吸収する: 前の終了時刻から始まり、計画上の終了時刻まで続く（最短 MIN_BUFFER_MIN）。
 * - スキップ済み・臨時休業のブロックは時間を消費しない（表示用の元の時刻は残す）。
 * - 営業時間外・終了時刻超過は block.issues に付ける。
 */
export function recomputeDay(day: Day, ctx: PlanningContext, opts: RecomputeOptions = {}): Day {
  const mode = opts.mode ?? "preserve";
  const now = opts.nowMin;
  let pendingDelay = opts.delayMin ?? 0;
  let cursor = day.startMin;
  let loc: LatLng = day.origin;
  let carry = 0;
  const blocks: Block[] = [];

  for (const b of day.blocks) {
    const spot = b.spotId ? ctx.spotById.get(b.spotId) : undefined;

    if (isInert(b)) {
      if (b.notBefore !== undefined) carry = Math.max(carry, b.notBefore);
      blocks.push({ ...b, issues: b.closed ? ["closed"] : undefined, crowdedOverlap: false });
      continue;
    }

    const started = now !== undefined && b.startMin <= now;
    if (started) {
      blocks.push(b);
      cursor = Math.max(cursor, b.endMin);
      if (spot) loc = spot;
      continue;
    }

    const travel = spot ? ctx.travel(loc, spot) : undefined;
    const arrival = cursor + (travel?.minutes ?? 0);
    let notBefore = Math.max(b.notBefore ?? 0, carry);
    carry = 0;

    if (!spot) {
      // 余白: 前の終了時刻から始まり、遅れた分だけ縮んで計画上の終了時刻に合わせる
      let start = Math.max(cursor, notBefore);
      if (pendingDelay > 0) {
        start += pendingDelay;
        notBefore = start;
        pendingDelay = 0;
      }
      const end =
        mode === "compact"
          ? start + b.durationMin
          : Math.max(b.plannedEndMin ?? b.endMin, start + MIN_BUFFER_MIN);
      blocks.push({
        ...b,
        startMin: start,
        endMin: end,
        travelMin: 0,
        travelMode: "none",
        notBefore: notBefore > 0 ? notBefore : undefined,
        issues: undefined,
      });
      cursor = end;
      continue;
    }

    let start = Math.max(arrival, notBefore);
    if (mode === "preserve") start = Math.max(start, b.plannedStartMin ?? b.startMin);
    if (pendingDelay > 0) {
      // 遅延は、次の予定への到着を遅らせる（その後の再計算でも残るよう notBefore に記録する）
      start += pendingDelay;
      notBefore = start;
      pendingDelay = 0;
    }

    const issues: BlockIssue[] = [];
    const slot = findOpenSlot(spot, day.date, start, b.durationMin);
    if (slot && slot.start - start <= MAX_WAIT_FOR_OPENING_MIN) start = slot.start;
    else issues.push("outside-hours");

    const end = start + b.durationMin;
    if (end > day.endMin) issues.push("over-day-end");

    blocks.push({
      ...b,
      startMin: start,
      endMin: end,
      travelMin: travel!.minutes,
      travelMode: travel!.mode,
      notBefore: notBefore > 0 ? notBefore : undefined,
      issues: issues.length ? issues : undefined,
      crowdedOverlap: overlapsCrowded(spot, start, end),
    });
    cursor = end;
    loc = spot;
  }

  return { ...day, blocks };
}

/** 現在の時刻を計画上の時刻として確定する（生成直後・並べ替え後に呼ぶ）。遅延の記録はクリアされる */
export function commitBaseline(day: Day): Day {
  return {
    ...day,
    blocks: day.blocks.map((b) => ({
      ...b,
      plannedStartMin: b.startMin,
      plannedEndMin: b.endMin,
      notBefore: undefined,
    })),
  };
}

/** 営業時間（または臨時休業）に間に合わない＝実行できない見込みのブロックか */
function failsHours(b: Block): boolean {
  return !isInert(b) && !!b.issues?.includes("outside-hours");
}

function failsAny(b: Block): boolean {
  return !isInert(b) && !!b.issues?.some((i) => i === "outside-hours" || i === "over-day-end");
}

/** 1日の終了予定時刻をこれだけ超えるまでは「許容範囲」とみなす（分） */
export const DAY_END_TOLERANCE_MIN = 30;

export interface SkipAnalysisOptions {
  nowMin: number;
}

/**
 * スキップ候補の判定（当日モード用）。再計算済みの Day を渡す。
 *
 * 1. 営業時間や終了時刻に間に合わない Optional ブロック → スキップ候補
 * 2. 営業時間に間に合わない、または終了予定時刻を大きく（30分超）超える Must / 標準ブロックがあるときは、
 *    手前の Optional を飛ばせば改善するかを試算し、改善する Optional を（近い順に）スキップ候補にする
 * 「それでも行く」（keepAnyway）が付いたブロックは候補にしない。
 */
export function markSkipCandidates(day: Day, ctx: PlanningContext, opts: SkipAnalysisOptions): Day {
  const started = (b: Block) => b.startMin <= opts.nowMin;
  let blocks = day.blocks.map((b): Block => (b.skip === "candidate" ? { ...b, skip: undefined } : b));
  const candidates = new Set<string>();

  // 1. それ自体が間に合わない Optional
  for (const b of blocks) {
    if (b.label === "optional" && !b.keepAnyway && !started(b) && failsAny(b)) candidates.add(b.id);
  }

  // 2. 手前の Optional を飛ばせば、後ろの Must / 標準が間に合うようになるか
  const simulate = (skipIds: Set<string>): Day =>
    recomputeDay(
      {
        ...day,
        blocks: blocks.map((b) => (skipIds.has(b.id) ? { ...b, skip: "skipped" as const } : b)),
      },
      ctx,
      { mode: "preserve", nowMin: opts.nowMin },
    );
  const overrun = (b: Block) => Math.max(0, b.endMin - (day.endMin + DAY_END_TOLERANCE_MIN));
  const isCore = (b: Block) => b.label !== "optional" && !started(b) && !isInert(b);
  /** 大きいほど悪い: 営業時間に間に合わない予定は重く、終了予定時刻の超過は超過分（分）で数える */
  const badness = (d: Day) =>
    d.blocks.filter(isCore).reduce((n, b) => n + (failsHours(b) ? 10000 : 0) + overrun(b), 0);

  let sim = simulate(candidates);
  let bad = badness(sim);
  while (bad > 0) {
    const firstBadIdx = sim.blocks.findIndex((b) => isCore(b) && (failsHours(b) || overrun(b) > 0));
    const pool = blocks
      .map((b, i) => ({ b, i }))
      .filter(
        ({ b, i }) =>
          i < firstBadIdx && b.label === "optional" && !b.keepAnyway && !started(b) && !isInert(b) && !candidates.has(b.id),
      )
      .reverse(); // 問題のブロックに近いものから
    let improved = false;
    for (const { b } of pool) {
      const trial = simulate(new Set([...candidates, b.id]));
      if (badness(trial) < bad) {
        candidates.add(b.id);
        sim = trial;
        bad = badness(trial);
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }

  blocks = blocks.map((b) => (candidates.has(b.id) ? { ...b, skip: "candidate" as const } : b));
  return { ...day, blocks };
}

/** 再計算＋スキップ候補判定。today モードなら nowMin を渡す */
export function settleDay(day: Day, ctx: PlanningContext, opts: RecomputeOptions = {}): Day {
  const recomputed = recomputeDay(day, ctx, opts);
  if (opts.nowMin === undefined) return recomputed;
  return markSkipCandidates(recomputed, ctx, { nowMin: opts.nowMin });
}
