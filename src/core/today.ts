import { isInert } from "./schedule";
import type { Block, Day, PlanningContext, Spot } from "./types";

export type NextActionState =
  /** 最初の予定の前 */
  | "before-start"
  /** 予定の最中 */
  | "in-progress"
  /** 予定と予定のあいだ（出発前または移動中） */
  | "between"
  /** 今日の予定はすべて終わった */
  | "finished"
  | "empty";

export interface NextAction {
  state: NextActionState;
  /** いま進行中のブロック（余白を含む） */
  current?: Block;
  currentSpot?: Spot;
  /** 次に向かうスポット（または自由入力の寄り道）のブロック */
  next?: Block;
  nextSpot?: Spot;
  /** 次の行き先の名前（スポット名、または寄り道の名前） */
  nextName?: string;
  /** 次のスポットへ出発する時刻（開始時刻 − 移動時間） */
  departAtMin?: number;
  /** 出発までの残り分。出発時刻を過ぎていれば 0 */
  minutesUntilDeparture?: number;
  /** すでに出発していて、到着までの残り分（移動中のみ） */
  minutesUntilArrival?: number;
  /** 計画より何分遅れているか（遅延が出ているとき） */
  delayedByMin?: number;
  /**
   * 「着いた」を記録できる予定: いま時刻上で進行中なのに、まだ着いた記録がない予定。
   * いまが余白や移動中なら、次の予定（早く着いたときのため）。
   */
  arrivable?: Block;
  /**
   * 「出発した」を記録できる予定: 着いた記録のある予定にいまいるならその予定。
   * まだ着いた記録がなければ、直前の予定（遅れて出発するとき、計画上は次の予定が始まっていても、まだ前の予定にいる）。
   */
  departable?: Block;
  /** 上の2つの名前（ボタンに出す） */
  arrivableName?: string;
  departableName?: string;
}

/** 「次にやること」を決める。余白・スキップ済み・臨時休業のブロックは「次の予定」にならない */
export function getNextAction(day: Day, ctx: PlanningContext, nowMin: number): NextAction {
  const active = day.blocks.filter((b) => !isInert(b));
  if (!active.length) return { state: "empty" };

  const current = active.find((b) => b.startMin <= nowMin && nowMin < b.endMin);
  const next = active.find((b) => b.startMin > nowMin && (b.spotId || b.free));
  const currentSpot = current?.spotId ? ctx.spotById.get(current.spotId) : undefined;

  if (!current && !next) {
    const last = active[active.length - 1];
    return nowMin >= last.endMin ? { state: "finished" } : { state: "empty" };
  }

  const result: NextAction = {
    state: current ? "in-progress" : active[0].startMin > nowMin ? "before-start" : "between",
    current,
    currentSpot,
  };

  // 着いた・出発した の対象
  const spotLike = (b: Block) => !b.fixed && b.label !== "buffer" && b.label !== "rest" && (!!b.spotId || !!b.free);
  const curLike = current && spotLike(current) ? current : undefined;
  const nextLike = active.find((b) => b.startMin > nowMin && spotLike(b));
  if (curLike && curLike.actualStartMin !== undefined) {
    result.departable = curLike; // もうここに着いている
  } else {
    result.arrivable = curLike ?? nextLike;
    const target = result.arrivable;
    if (target) {
      const ti = active.indexOf(target);
      // 直前の予定（まだ出発した記録がない）にまだいるかもしれない
      for (let i = ti - 1; i >= 0; i--) {
        const p = active[i];
        if (!spotLike(p)) continue;
        if (p.actualEndMin === undefined && p.startMin <= nowMin) result.departable = p;
        break;
      }
      // 最初の予定は、前の予定がないので、時刻どおりここにいるとみなして出発を記録できる
      if (!result.departable && curLike) result.departable = curLike;
    }
  }

  const nameOfBlock = (b?: Block) => (b ? (b.free?.name ?? (b.spotId ? ctx.spotById.get(b.spotId)?.name : undefined)) : undefined);
  result.arrivableName = nameOfBlock(result.arrivable);
  result.departableName = nameOfBlock(result.departable);

  if (next) {
    const departAt = next.startMin - next.travelMin;
    result.next = next;
    result.nextSpot = next.spotId ? ctx.spotById.get(next.spotId) : undefined;
    result.nextName = result.nextSpot?.name ?? next.free?.name;
    result.departAtMin = departAt;
    result.minutesUntilDeparture = Math.max(0, departAt - nowMin);
    if (!current && nowMin >= departAt) result.minutesUntilArrival = Math.max(0, next.startMin - nowMin);
    const delayed = next.startMin - (next.plannedStartMin ?? next.startMin);
    if (delayed > 0) result.delayedByMin = delayed;
  }
  return result;
}
