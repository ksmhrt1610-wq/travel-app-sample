import { findOpenSlot, isOpenOnDate, overlapsCrowded } from "./availability";
import { WALK_M_PER_MIN, withWalkLimit } from "./geo";
import { MEAL_ADJUST_WINDOW } from "./meals";
import { parseHHMM } from "./time";
import type { Block, BlockIssue, Day, LatLng, PlanningContext, Spot, TravelEstimate, TravelEstimator } from "./types";

/** 余白ブロックが遅れを吸収して縮められる下限（分）の初期値。ペース別の下限は meals.ts の BUFFER_FLOOR_MIN */
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
  /** 余白が縮められる下限（分）。ペース別（meals.ts の BUFFER_FLOOR_MIN）。省略時は MIN_BUFFER_MIN */
  minBufferMin?: number;
}

export function isInert(b: Block): boolean {
  return b.skip === "skipped" || !!b.closed;
}

/** 座標のない自由入力の寄り道で、直前の場所から移動にかかると仮定する時間（分）の初期値 */
export const FREE_STOP_TRAVEL_MIN = 10;

/**
 * 開始済みか。実績（着いた・出発した）があれば実績を優先し、なければ時刻（開始時刻 <= 現在時刻）で判定する。
 */
export function isStarted(b: Block, now: number | undefined): boolean {
  if (b.actualStartMin !== undefined || b.actualEndMin !== undefined) return true;
  return now !== undefined && b.startMin <= now;
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
 * - 開始済みのブロックは固定（実績の着いた・出発した時刻があれば、その時刻。なければ startMin <= nowMin）。
 * - 各ブロックの開始 = max(前の場所からの到着, 計画上の開始, notBefore)。営業開始まで待てる場合は待つ。
 * - 固定時刻ブロックの開始は固定時刻そのもの。手前のブロックは、固定時刻から逆算した最遅の開始時刻
 *   （固定時刻 − 余裕 − 移動時間 − 滞在）を超えないよう、計画上の開始より前倒しで動く。
 *   間に合わないときは fixed-missed（不足分は lateByMin）を付ける。
 * - 遅延は最初の未開始ブロックの開始を delayMin 遅らせる。余白ブロックが先に縮んで吸収する。
 * - 「疲れた」の休憩（label: rest）は保護され、長さを変えない。
 * - 食事ブロック（meal）は、食事の窓（MEAL_ADJUST_WINDOW）より前には始めない。窓の終わりを超えるときは outside-meal-window。
 * - 余白は、元の長さと minBufferMin のうち短いほうまで縮められる。
 * - スキップ済み・臨時休業のブロックは時間を消費しない（表示用の元の時刻は残す）。
 */
export function recomputeDay(day: Day, ctx: PlanningContext, opts: RecomputeOptions = {}): Day {
  const mode = opts.mode ?? "preserve";
  const now = opts.nowMin;
  const margin = opts.marginMin ?? DEFAULT_MARGIN_MIN;
  const bufferFloor = (b: Block) => Math.min(opts.minBufferMin ?? MIN_BUFFER_MIN, Math.max(1, b.durationMin));
  const travelFn = dayTravel(day, ctx);
  const src = day.blocks;
  const n = src.length;
  // 実績（着いた・出発した）を記録した予定より後ろの予定は、「着いた」の記録があるまで開始していない
  // （出発が遅れたとき、次の予定の計画上の開始時刻が過ぎていても、まだ着いていないため）
  let lastActual = -1;
  src.forEach((b, i) => {
    if (!isInert(b) && (b.actualStartMin !== undefined || b.actualEndMin !== undefined)) lastActual = i;
  });
  const started = (b: Block, i: number) => {
    if (b.actualStartMin !== undefined || b.actualEndMin !== undefined) return true;
    if (lastActual >= 0 && i > lastActual) return false;
    return isStarted(b, now);
  };

  // 1. 順序だけで決まる移動（前の場所 → この場所）
  const travelIn: (TravelEstimate | undefined)[] = new Array(n).fill(undefined);
  let loc: LatLng = day.origin;
  for (let i = 0; i < n; i++) {
    const b = src[i];
    if (isInert(b)) continue;
    if (b.free) {
      // 座標のない寄り道: 移動は仮定の時間。場所は動かさない（次の移動は、その前の場所から数える）
      travelIn[i] = { minutes: b.free.travelMin, mode: "walk", distanceM: Math.round(b.free.travelMin * WALK_M_PER_MIN) };
      continue;
    }
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
    const duration = b.label === "buffer" ? bufferFloor(b) : b.durationMin;
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

    if (started(b, i)) {
      let blk = b;
      if (b.actualEndMin !== undefined) {
        // 出発した: 実績の時刻で終わっている
        const s = b.actualStartMin ?? b.startMin;
        blk = { ...b, startMin: s, endMin: Math.max(s, b.actualEndMin) };
      } else if (b.actualStartMin !== undefined) {
        // 着いた: 実績の時刻から、予定の滞在時間ぶん（まだ出発していなければ、いまの時刻まではここにいる）
        blk = { ...b, startMin: b.actualStartMin, endMin: Math.max(b.actualStartMin + b.durationMin, now ?? 0) };
      }
      // いま余白の最中なら、その残りの時間が遅れを吸収する（余白は、遅れのための自由時間。吸収しきれない分だけが、次の予定にかかる）
      if (pending > 0 && mode !== "compact" && b.label === "buffer" && b.actualStartMin === undefined && b.actualEndMin === undefined && now !== undefined) {
        pending -= Math.min(pending, Math.max(0, blk.endMin - Math.max(now, blk.startMin)));
      }
      out.push(blk);
      cursor = Math.max(cursor, blk.endMin);
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

    // 場所のない時間ブロック（余白・場所を決めない休憩・自由入力の寄り道）
    if (!placeOf(b, ctx)) {
      const freeTravel = b.free?.travelMin ?? 0;
      let start = Math.max(cursor + freeTravel, notBefore);
      if (pending > 0) {
        start += pending;
        notBefore = start;
        pending = 0;
      }
      let end: number;
      if (b.label !== "buffer" || mode === "compact") {
        end = start + b.durationMin;
      } else {
        // 余白: 前の終了時刻から始まり、遅れた分だけ縮んで計画上の終了時刻に合わせる。固定時刻が近いときはさらに縮む
        const floor = bufferFloor(b);
        end = Math.max(b.plannedEndMin ?? b.endMin, start + floor);
        const ls = latestStart[i];
        if (ls !== undefined) end = Math.max(start + floor, Math.min(end, ls + floor));
      }
      out.push({
        ...withTravel,
        startMin: start,
        endMin: end,
        travelMin: freeTravel,
        travelMode: b.free ? "walk" : "none",
        travelDistanceM: b.free ? Math.round(freeTravel * WALK_M_PER_MIN) : undefined,
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

    if (b.meal) start = Math.max(start, MEAL_ADJUST_WINDOW[b.meal].earliest);

    const issues: BlockIssue[] = [];
    let late: number | undefined;
    const slot = findOpenSlot(spotHere, day.date, start, b.durationMin);
    if (slot && slot.start - start <= MAX_WAIT_FOR_OPENING_MIN) start = slot.start;
    else {
      issues.push("outside-hours");
      late = hoursLateBy(spotHere, day.date, start, b.durationMin);
    }
    const end = start + b.durationMin;
    if (b.meal && end > MEAL_ADJUST_WINDOW[b.meal].latest) {
      issues.push("outside-meal-window");
      late = Math.max(late ?? 0, end - MEAL_ADJUST_WINDOW[b.meal].latest);
    }
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
