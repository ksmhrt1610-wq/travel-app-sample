import { isInert } from "./schedule";
import type { Block, Day, Pace, PlanningContext, Spot, TravelEstimate } from "./types";

/** 1日の歩行距離の目安（km）。ペースごと */
export const WALK_LIMIT_KM: Record<Pace, number> = { relaxed: 5, normal: 8, packed: 12 };

/** 公共交通を使う移動でも、乗り場までの徒歩がある（片道あたり。m） */
export const TRANSIT_ACCESS_WALK_M = 600;

/** 移動1回あたりの推定歩行距離（m） */
export function legWalkingM(t: Pick<TravelEstimate, "mode" | "distanceM">): number {
  if (t.mode === "walk") return t.distanceM;
  if (t.mode === "transit") return Math.min(t.distanceM, TRANSIT_ACCESS_WALK_M);
  return 0;
}

/** 滞在中の歩行（m/分）。屋外の散策は多く、座って過ごす飲食・カフェはほぼ歩かない */
function onSiteRate(spot: Spot): number {
  if (spot.category === "gourmet" || spot.category === "cafe") return 3;
  if (spot.setting === "outdoor") return spot.category === "nature" || spot.category === "history" ? 40 : 30;
  if (spot.setting === "semi") return 25;
  return spot.category === "nightview" ? 8 : 20;
}

/** 滞在中の推定歩行距離（m） */
export function onSiteWalkingM(spot: Spot, durationMin: number): number {
  return Math.round(onSiteRate(spot) * durationMin);
}

export interface BlockWalking {
  legM: number;
  siteM: number;
}

export function blockWalking(b: Block, ctx: PlanningContext): BlockWalking {
  if (isInert(b) || b.label === "buffer") return { legM: 0, siteM: 0 };
  const spot = b.spotId ? ctx.spotById.get(b.spotId) : undefined;
  const legM = b.travelMin > 0 ? legWalkingM({ mode: b.travelMode === "none" ? "transit" : b.travelMode, distanceM: b.travelDistanceM ?? 0 }) : 0;
  const siteM = spot && b.label !== "fixed" && b.label !== "rest" ? onSiteWalkingM(spot, b.endMin - b.startMin) : 0;
  return { legM, siteM };
}

export interface DayWalking {
  /** 1日の見込み合計（m） */
  totalM: number;
  /** 現在時刻までに歩いた推定距離（m） */
  doneM: number;
  /** これから歩く推定距離（m） */
  remainingM: number;
  limitM: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** その日の推定歩行距離。nowMin を渡すと、現在時刻までの累計と残りを出す */
export function dayWalking(day: Day, ctx: PlanningContext, pace: Pace, nowMin?: number): DayWalking {
  let total = 0;
  let done = 0;
  for (const b of day.blocks) {
    const w = blockWalking(b, ctx);
    total += w.legM + w.siteM;
    if (nowMin === undefined) continue;
    const legStart = b.startMin - b.travelMin;
    done += w.legM * (b.travelMin > 0 ? clamp01((nowMin - legStart) / b.travelMin) : 1);
    done += w.siteM * (b.endMin > b.startMin ? clamp01((nowMin - b.startMin) / (b.endMin - b.startMin)) : 1);
  }
  const limitM = WALK_LIMIT_KM[pace] * 1000;
  return { totalM: Math.round(total), doneM: Math.round(done), remainingM: Math.round(total - done), limitM };
}

export interface RestSuggestion {
  /** この予定の前に休憩を入れませんか、という対象ブロック */
  beforeBlockId: string;
  /** その予定までに歩く見込み（累計）。目安を超える */
  projectedM: number;
  limitM: number;
}

/**
 * 「次の予定の前に休憩を入れますか？」の判定。
 * いままでの歩行 + 進行中の予定の残り + 次の予定への移動と滞在 が目安を超えそうなときに返す。
 * すでに次の予定の前に休憩があるときは出さない。
 */
export function suggestRestForWalking(day: Day, ctx: PlanningContext, pace: Pace, nowMin: number): RestSuggestion | null {
  const active = day.blocks.filter((b) => !isInert(b));
  const idx = active.findIndex((b) => b.startMin > nowMin && b.label !== "buffer" && b.label !== "rest");
  if (idx < 0) return null;
  // 次の予定までの間にすでに休憩・余白がある
  if (active.slice(0, idx).some((b) => b.startMin > nowMin && (b.label === "rest" || b.label === "buffer"))) return null;
  if (active.slice(0, idx).some((b) => b.label === "rest" && b.endMin > nowMin)) return null;

  const next = active[idx];
  const w = blockWalking(next, ctx);
  const current = active.find((b) => b.startMin <= nowMin && nowMin < b.endMin);
  let currentRest = 0;
  if (current) {
    const cw = blockWalking(current, ctx);
    const frac = clamp01((nowMin - current.startMin) / Math.max(1, current.endMin - current.startMin));
    currentRest = cw.siteM * (1 - frac);
  }
  const walked = dayWalking(day, ctx, pace, nowMin);
  const projected = walked.doneM + currentRest + w.legM + w.siteM;
  if (projected <= walked.limitM) return null;
  return { beforeBlockId: next.id, projectedM: Math.round(projected), limitM: walked.limitM };
}
