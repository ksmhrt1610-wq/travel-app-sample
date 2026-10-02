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
  /** 次に向かうスポットのブロック */
  next?: Block;
  nextSpot?: Spot;
  /** 次のスポットへ出発する時刻（開始時刻 − 移動時間） */
  departAtMin?: number;
  /** 出発までの残り分。出発時刻を過ぎていれば 0 */
  minutesUntilDeparture?: number;
  /** すでに出発していて、到着までの残り分（移動中のみ） */
  minutesUntilArrival?: number;
  /** 計画より何分遅れているか（遅延が出ているとき） */
  delayedByMin?: number;
}

/** 「次にやること」を決める。余白・スキップ済み・臨時休業のブロックは「次の予定」にならない */
export function getNextAction(day: Day, ctx: PlanningContext, nowMin: number): NextAction {
  const active = day.blocks.filter((b) => !isInert(b));
  if (!active.length) return { state: "empty" };

  const current = active.find((b) => b.startMin <= nowMin && nowMin < b.endMin);
  const next = active.find((b) => b.startMin > nowMin && b.spotId);
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

  if (next) {
    const departAt = next.startMin - next.travelMin;
    result.next = next;
    result.nextSpot = ctx.spotById.get(next.spotId!);
    result.departAtMin = departAt;
    result.minutesUntilDeparture = Math.max(0, departAt - nowMin);
    if (!current && nowMin >= departAt) result.minutesUntilArrival = Math.max(0, next.startMin - nowMin);
    const delayed = next.startMin - (next.plannedStartMin ?? next.startMin);
    if (delayed > 0) result.delayedByMin = delayed;
  }
  return result;
}
