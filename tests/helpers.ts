import spotsJson from "@/data/spots.json";
import { createPlanningContext } from "@/core/context";
import { estimateTravel } from "@/core/geo";
import type { Preferences, PlanningContext, Spot } from "@/core/types";

export const spots = spotsJson as Spot[];

export function makeCtx(list: Spot[] = spots): PlanningContext {
  return createPlanningContext(list, estimateTravel);
}

/** デモシナリオ: 友人・普通の予算・グルメとカフェ・ゆったり・小雨OK・日帰り */
export const demoPrefs: Preferences = {
  duration: "day",
  companions: "friends",
  budget: "normal",
  interests: ["gourmet", "cafe"],
  pace: "relaxed",
  rainTolerance: "light-rain-ok",
  mustSpotIds: [],
};

/** 2026-10-03 は土曜日 */
export const SATURDAY = "2026-10-03";
export const MONDAY = "2026-10-05";

import { commitBaseline, recomputeDay } from "@/core/schedule";
import type { Block, Day, Itinerary } from "@/core/types";
import { DAY_ORIGINS } from "@/core/planner";

export const hm = (h: number, m = 0) => h * 60 + m;

export interface BlockSpec {
  id: string;
  label?: Block["label"];
  spotId?: string;
  start: number;
  end: number;
}

/** 手組みの1日。時刻は recompute で整えて計画上の時刻（baseline）として確定する */
export function makeDay(specs: BlockSpec[], ctx = makeCtx(), date = SATURDAY, startMin = hm(9), endMin = hm(20)): Day {
  const blocks: Block[] = specs.map((s) => ({
    id: s.id,
    label: s.label ?? (s.spotId ? "normal" : "buffer"),
    spotId: s.spotId,
    durationMin: s.end - s.start,
    startMin: s.start,
    endMin: s.end,
    travelMin: 0,
    travelMode: "none",
  }));
  const day: Day = { index: 0, date, startMin, endMin, origin: DAY_ORIGINS[0], blocks, warnings: [] };
  return commitBaseline(recomputeDay(day, ctx, { mode: "preserve" }));
}

export function wrapItinerary(day: Day, prefs: Preferences = demoPrefs): Itinerary {
  return { version: 1, id: "test", createdAt: "", startDate: day.date, prefs, days: [day], closedSpotIds: [] };
}
