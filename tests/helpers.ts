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

import { defaultMembers } from "@/core/fixed";
import { commitBaseline, DEFAULT_MARGIN_MIN, recomputeDay } from "@/core/schedule";
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
  return {
    version: 1,
    id: "test",
    createdAt: "",
    startDate: day.date,
    prefs,
    days: [day],
    closedSpotIds: [],
    members: defaultMembers(prefs.companions),
    settings: { marginMin: DEFAULT_MARGIN_MIN },
  };
}

import { fixedDeparture, FIXED_PRESETS } from "@/core/fixed";
import { replan } from "@/core/replan";
import type { FixedEvent } from "@/core/types";

/** 太宰府の1日（Must 2・標準 2・Optional 2）。固定時刻の逆算・削減の優先順位のテストに使う */
export function dazaifuDay(ctx = makeCtx()): Day {
  return makeDay(
    [
      { id: "s1", label: "must", spotId: "dazaifu-shrine", start: hm(10), end: hm(11) },
      { id: "s2", label: "must", spotId: "dazaifu-kyuhaku", start: hm(11, 15), end: hm(12, 45) },
      { id: "s3", label: "normal", spotId: "dazaifu-starbucks", start: hm(13), end: hm(13, 45) },
      { id: "s4", label: "normal", spotId: "dazaifu-komyozen", start: hm(14), end: hm(14, 30) },
      { id: "s5", label: "optional", spotId: "dazaifu-treasure", start: hm(14, 45), end: hm(15, 15) },
      { id: "s6", label: "optional", spotId: "dazaifu-kanzeonji", start: hm(15, 30), end: hm(16) },
    ],
    ctx,
  );
}

export const STATION = FIXED_PRESETS[0].place; // 太宰府駅

export function fixedEvent(timeMin: number, extra: Partial<FixedEvent> = {}): FixedEvent {
  return {
    id: "",
    kind: "last-transport",
    title: `太宰府駅 ${Math.floor(timeMin / 60)}:${String(timeMin % 60).padStart(2, "0")} の電車（最終）`,
    timeMin,
    dayIndex: 0,
    place: STATION,
    durationMin: 0,
    endsDay: true,
    memberIds: null,
    ...extra,
  };
}

/** 固定時刻を登録した旅程（再計画エンジンの提案をそのまま確定） */
export function withFixed(itin: Itinerary, timeMin: number, extra: Partial<FixedEvent> = {}, ctx = makeCtx()): Itinerary {
  return replan(itin, { type: "fixed-add", fixed: fixedEvent(timeMin, extra) }, ctx, { dayIndex: 0 }).after;
}

/** 固定時刻ブロックごとの「出発すべき時刻 − 直前の予定の終了時刻」の最小値。0 以上なら間に合う */
export function fixedSlack(itin: Itinerary, ctx = makeCtx(), dayIndex = 0): number {
  const day = itin.days[dayIndex];
  let slack = Number.POSITIVE_INFINITY;
  day.blocks.forEach((b, i) => {
    if (!b.fixed || b.skip) return;
    const d = fixedDeparture(day, i, ctx, itin.settings.marginMin)!;
    slack = Math.min(slack, d.departBy - (d.pred ? d.pred.endMin : day.startMin));
  });
  return slack;
}
