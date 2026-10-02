import { findOpenSlot } from "./availability";
import { haversineM } from "./geo";
import { minStayOf } from "./replan";
import { dayTravel, isInert, isStarted, placeOf } from "./schedule";
import type { Block, Itinerary, LatLng, PlanningContext, Spot } from "./types";

/** 寄り道の候補にする範囲（いまいる場所から。m） */
export const DETOUR_RADIUS_M = 1000;

export interface Here extends LatLng {
  name: string;
}

/** いまいる場所: 進行中（開始済みでまだ出発していない）の予定の場所。なければ最後に行った場所、なければ出発地 */
export function currentLocation(itin: Itinerary, ctx: PlanningContext, dayIndex: number, nowMin: number): Here {
  const day = itin.days[dayIndex];
  let at: Here = { name: day.origin.name, lat: day.origin.lat, lng: day.origin.lng };
  for (const b of day.blocks) {
    if (isInert(b) || !isStarted(b, nowMin)) continue;
    const p = placeOf(b, ctx);
    if (!p) continue;
    const name = b.spotId ? ctx.spotById.get(b.spotId)?.name : b.place?.name;
    at = { name: name ?? "いまの場所", lat: p.lat, lng: p.lng };
  }
  return at;
}

export interface DetourCandidate {
  spot: Spot;
  distanceM: number;
  /** 閉店までの時間（分）。長いほうが余裕がある */
  openUntilMin: number;
}

/**
 * 寄り道の候補: いまいる場所から1km以内で、いま営業中の、まだ旅程に入っていないスポット（近い順）。
 * 食事向けのスポットも選べる（食べ歩きや休憩に寄る人もいるため）。
 */
export function nearbyOpenSpots(
  itin: Itinerary,
  ctx: PlanningContext,
  opts: { dayIndex: number; nowMin: number; radiusM?: number; limit?: number },
): DetourCandidate[] {
  const day = itin.days[opts.dayIndex];
  const here = currentLocation(itin, ctx, opts.dayIndex, opts.nowMin);
  const travel = dayTravel(day, ctx);
  const used = new Set<string>(itin.closedSpotIds);
  for (const d of itin.days) for (const b of d.blocks) if (b.spotId && !isInert(b)) used.add(b.spotId);
  const out: DetourCandidate[] = [];
  for (const sp of ctx.spots) {
    if (used.has(sp.id)) continue;
    const d = haversineM(here, sp);
    if (d > (opts.radiusM ?? DETOUR_RADIUS_M)) continue;
    const arrive = opts.nowMin + travel(here, sp).minutes;
    const need = Math.min(sp.stayMin, minStayOf(sp));
    const slot = findOpenSlot(sp, day.date, arrive, need);
    if (!slot || slot.start - arrive > 10) continue; // いま営業中（10分以内に開く）
    out.push({ spot: sp, distanceM: Math.round(d), openUntilMin: slot.close - arrive });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, opts.limit ?? 12);
}

/** 「ここに寄る」の挿入位置になる、いま進行中の予定のブロック（なければ undefined） */
export function currentBlock(itin: Itinerary, dayIndex: number, nowMin: number): Block | undefined {
  const day = itin.days[dayIndex];
  return day.blocks.find((b) => !isInert(b) && !b.fixed && b.label !== "buffer" && isStarted(b, nowMin) && b.endMin > nowMin);
}
