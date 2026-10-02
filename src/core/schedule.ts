import { findOpenSlot, isOpenOnDate, overlapsCrowded } from "./availability";
import { withWalkLimit } from "./geo";
import { parseHHMM } from "./time";
import type { Block, BlockIssue, Day, LatLng, PlanningContext, Spot, TravelEstimate, TravelEstimator } from "./types";

/** 余白ブロックが遅れを吸収して縮められる下限（分） */
export const MIN_BUFFER_MIN = 10;
/** 開店まで待ってでも入れる上限（分）。これを超える待ちは営業時間外として扱う */
export const MAX_WAIT_FOR_OPENING_MIN = 90;
/** 固定時刻の余裕時間の初期値（分） */
export const DEFAULT_MARGIN_MIN = 10;
/** 1日の終了予定時刻をこれだけ超えるまでは「許容範囲」とみなす（分） */
export const DAY_END_TOLERANCE_MIN = 30;

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
  /** 固定時刻の余裕時間（分） */
  marginMin?: number;
}

export function isInert(b: Block): boolean {
  return b.skip === "skipped" || !!b.closed;
}

/** ブロックの場所（スポット、または駅・宿など）。余白など場所のないブロックは undefined */
export function placeOf(b: Block, ctx: PlanningContext): LatLng | undefined {
  return b.spotId ? ctx.spotById.get(b.spotId) : b.place;
}

/** この日の移動見積もり。「かなり疲れた」以降は徒歩を短く見積もる */
export function dayTravel(day: Day, ctx: PlanningContext): TravelEstimator {
  return day.lowWalking ? withWalkLimit(ctx.travel) : ctx.travel;
}

/** 開店・閉店に合わせられなかったときの不足分（分）の目安 */
function hoursLateBy(spot: Spot, date: string, start: number, duration: number): number {
  if (!isOpenOnDate(spot, date)) return 600;
  let best = Number.POSITIVE_INFINITY;
  for (const r of spot.hours) {
    const open = parseHHMM(r.open);
    const close = parseHHMM(r.close);
    let late = 0;
    if (start + duration > close) late = Math.max(late, start + duration - close);
    if (start < open) late = Math.max(late, open - start - MAX_WAIT_FOR_OPENING_MIN);
    best = Math.min(best, Math.max(1, late));
  }
  return Number.isFinite(best) ? best : 1;
}

/**
 * 1日分のブロックの時刻を再計算する（純粋関数。入力は変更しない）。
 *
 * - 開始済み（startMin <= nowMin）のブロックは固定。
 * - 各ブロックの開始 = max(前の場所からの到着, 計画上の開始, notBefore)。営業開始まで待てる場合は待つ。
 * - 固定時刻ブロックの開始は固定時刻そのもの。手前のブロックは、固定時刻から逆算した最遅の開始時刻
 *   （固定時刻 − 余裕 − 移動時間 − 滞在）を超えないよう、計画上の開始より前倒しで動く。
 *   間に合わないときは fixed-missed（不足分は lateByMin）を付ける。
 * - 遅延は最初の未開始ブロックの開始を delayMin 遅らせる。余白ブロックが先に縮んで吸収する。
 * - 「疲れた」の休憩（label: rest）は保護され、長さを変えない。
 * - スキップ済み・臨時休業のブロックは時間を消費しない（表示用の元の時刻は残す）。
 */
export function recomputeDay(day: Day, ctx: PlanningContext, opts: RecomputeOptions = {}): Day {
  const mode = opts.mode ?? "preserve";
  const now = opts.nowMin;
  const margin = opts.marginMin ?? DEFAULT_MARGIN_MIN;
  const travelFn = dayTravel(day, ctx);
  const src = day.blocks;
  const n = src.length;
  const started = (b: Block) => now !== undefined && b.startMin <= now;

  // 1. 順序だけで決まる移動（前の場所 → この場所）
  const travelIn: (TravelEstimate | undefined)[] = new Array(n).fill(undefined);
  let loc: LatLng = day.origin;
  for (let i = 0; i < n; i++) {
    const b = src[i];
    if (isInert(b)) continue;
    const p = placeOf(b, ctx);
    if (!p) continue;
    travelIn[i] = travelFn(loc, p);
    loc = p;
  }

  // 2. 固定時刻からの逆算: 各ブロックの最遅の開始時刻
  const latestStart: (number | undefined)[] = new Array(n).fill(undefined);
  let nextLatest: number | undefined;
  let nextTravel = 0;
  for (let i = n - 1; i >= 0; i--) {
    const b = src[i];
    if (isInert(b)) continue;
    if (b.fixed) {
      nextLatest = b.fixed.timeMin - margin;
      nextTravel = travelIn[i]?.minutes ?? 0;
      latestStart[i] = nextLatest;
      continue;
    }
    if (nextLatest === undefined) continue;
    const duration = b.label === "buffer" ? MIN_BUFFER_MIN : b.durationMin;
    latestStart[i] = nextLatest - nextTravel - duration;
    nextLatest = latestStart[i];
    nextTravel = travelIn[i]?.minutes ?? 0;
  }

  // 3. 先頭から時刻を割り当てる
  let cursor = day.startMin;
  let carry = 0;
  let pending = opts.delayMin ?? 0;
  let afterEnd = false;
  const out: Block[] = [];

  for (let i = 0; i < n; i++) {
    const b = src[i];

    if (isInert(b)) {
      if (b.notBefore !== undefined) carry = Math.max(carry, b.notBefore);
      out.push({ ...b, issues: b.closed ? ["closed"] : undefined, lateByMin: undefined, crowdedOverlap: false });
      continue;
    }

    if (started(b)) {
      out.push(b);
      cursor = Math.max(cursor, b.endMin);
      if (b.fixed?.endsDay) afterEnd = true;
      continue;
    }

    const spot = b.spotId ? ctx.spotById.get(b.spotId) : undefined;
    const travel = travelIn[i];
    const arrival = cursor + (travel?.minutes ?? 0);
    let notBefore = Math.max(b.notBefore ?? 0, carry);
    carry = 0;
    const withTravel: Block = {
      ...b,
      travelMin: travel?.minutes ?? 0,
      travelMode: travel?.mode ?? "none",
      travelDistanceM: travel?.distanceM,
    };

    // 固定時刻ブロック: 開始は固定時刻のまま。手前から間に合うかだけを見る
    if (b.fixed) {
      const T = b.fixed.timeMin;
      let arr = Math.max(arrival, notBefore);
      if (pending > 0) {
        arr += pending;
        notBefore = arr;
        pending = 0;
      }
      const shortfall = Math.max(0, arr + margin - T);
      const issues: BlockIssue[] = [];
      if (shortfall > 0) issues.push("fixed-missed");
      if (afterEnd) issues.push("after-last-transport");
      out.push({
        ...withTravel,
        startMin: T,
        endMin: T + b.durationMin,
        notBefore: notBefore > 0 ? notBefore : undefined,
        issues: issues.length ? issues : undefined,
        lateByMin: shortfall > 0 ? shortfall : undefined,
        crowdedOverlap: false,
      });
      cursor = Math.max(T, arr) + b.durationMin;
      if (b.fixed.endsDay) afterEnd = true;
      continue;
    }

    // 場所のない時間ブロック（余白・場所を決めない休憩）
    if (!placeOf(b, ctx)) {
      let start = Math.max(cursor, notBefore);
      if (pending > 0) {
        start += pending;
        notBefore = start;
        pending = 0;
      }
      let end: number;
      if (b.label === "rest" || mode === "compact") {
        end = start + b.durationMin;
      } else {
        // 余白: 前の終了時刻から始まり、遅れた分だけ縮んで計画上の終了時刻に合わせる。固定時刻が近いときはさらに縮む
        end = Math.max(b.plannedEndMin ?? b.endMin, start + MIN_BUFFER_MIN);
        const ls = latestStart[i];
        if (ls !== undefined) end = Math.max(start + MIN_BUFFER_MIN, Math.min(end, ls + MIN_BUFFER_MIN));
      }
      out.push({
        ...withTravel,
        startMin: start,
        endMin: end,
        travelMin: 0,
        travelMode: "none",
        travelDistanceM: undefined,
        notBefore: notBefore > 0 ? notBefore : undefined,
        issues: undefined,
        lateByMin: undefined,
        crowdedOverlap: false,
      });
      cursor = end;
      continue;
    }

    // スポットのブロック
    const spotHere = spot!;
    let start = Math.max(arrival, notBefore);
    if (mode === "preserve") {
      const planned = b.plannedStartMin ?? b.startMin;
      const ls = latestStart[i];
      start = Math.max(start, ls !== undefined ? Math.min(planned, ls) : planned);
    }
    if (pending > 0) {
      start += pending;
      notBefore = start;
      pending = 0;
    }

    const issues: BlockIssue[] = [];
    let late: number | undefined;
    const slot = findOpenSlot(spotHere, day.date, start, b.durationMin);
    if (slot && slot.start - start <= MAX_WAIT_FOR_OPENING_MIN) start = slot.start;
    else {
      issues.push("outside-hours");
      late = hoursLateBy(spotHere, day.date, start, b.durationMin);
    }
    const end = start + b.durationMin;
    if (end > day.endMin) issues.push("over-day-end");
    if (afterEnd) issues.push("after-last-transport");

    out.push({
      ...withTravel,
      startMin: start,
      endMin: end,
      notBefore: notBefore > 0 ? notBefore : undefined,
      issues: issues.length ? issues : undefined,
      lateByMin: late,
      crowdedOverlap: overlapsCrowded(spotHere, start, end),
    });
    cursor = end;
  }

  return { ...day, blocks: out };
}

/** 現在の時刻を計画上の時刻として確定する（生成直後・並べ替え後・確定後に呼ぶ）。遅延の記録はクリアされる */
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
