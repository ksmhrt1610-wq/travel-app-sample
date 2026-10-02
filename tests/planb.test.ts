import { describe, expect, it } from "vitest";
import { isOpenDuring } from "@/core/availability";
import { haversineM } from "@/core/geo";
import { findPlanB, findPlanBCandidates, needsPlanB, PLAN_B_MAX_DISTANCE_M } from "@/core/planb";
import { generateItinerary } from "@/core/planner";
import type { Preferences } from "@/core/types";
import { demoPrefs, makeCtx, SATURDAY } from "./helpers";

const ctx = makeCtx();
const spot = (id: string) => ctx.spotById.get(id)!;

const prefsList: Preferences[] = [
  demoPrefs,
  { ...demoPrefs, duration: "overnight", pace: "normal", interests: ["history", "nature", "art"] },
  { ...demoPrefs, duration: "overnight", pace: "packed", interests: ["shopping", "nightview", "gourmet"], companions: "couple" },
  { ...demoPrefs, rainTolerance: "dont-care", interests: ["nature"], pace: "packed" },
  { ...demoPrefs, mustSpotIds: ["dazaifu-shrine", "dazaifu-komyozen", "dazaifu-kanzeonji"], duration: "overnight" },
];

describe("Plan B 選定", () => {
  it("すべての Plan B は屋内で、元スポットから2km以内で、その時間帯に営業している", () => {
    let checked = 0;
    for (const prefs of prefsList) {
      const itin = generateItinerary({ prefs, ctx, startDate: SATURDAY });
      for (const day of itin.days) {
        for (const b of day.blocks) {
          if (!b.planB) continue;
          const original = spot(b.spotId!);
          const alt = spot(b.planB.spotId);
          expect(alt.setting, `${original.name} → ${alt.name}`).toBe("indoor");
          expect(haversineM(original, alt)).toBeLessThanOrEqual(PLAN_B_MAX_DISTANCE_M);
          expect(b.planB.distanceM).toBeLessThanOrEqual(PLAN_B_MAX_DISTANCE_M);
          expect(isOpenDuring(alt, day.date, b.startMin, b.startMin + b.planB.durationMin)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("屋外・半屋外のブロックには Plan B が付く（見つからなければ null）。屋内・余白には付かない", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, pace: "packed", interests: ["nature", "history"] }, ctx, startDate: SATURDAY });
    for (const b of itin.days.flatMap((d) => d.blocks)) {
      if (needsPlanB(b, ctx)) expect(b.planB === null || typeof b.planB === "object").toBe(true);
      else expect(b.planB).toBeUndefined();
    }
  });

  it("Plan B は旅程内のスポット・他のブロックの Plan B と重複しない", () => {
    for (const prefs of prefsList) {
      const itin = generateItinerary({ prefs, ctx, startDate: SATURDAY });
      const main = new Set(itin.days.flatMap((d) => d.blocks.map((b) => b.spotId).filter(Boolean)));
      const planBs = itin.days.flatMap((d) => d.blocks.map((b) => b.planB?.spotId).filter(Boolean)) as string[];
      expect(new Set(planBs).size).toBe(planBs.length);
      for (const id of planBs) expect(main.has(id)).toBe(false);
    }
  });

  it("屋外スポットの Plan B は、同じカテゴリ・近いカテゴリが優先される（大濠公園 → 大濠周辺の屋内）", () => {
    const park = spot("ohori-park");
    const found = findPlanB(park, { date: SATURDAY, start: 14 * 60, end: 15 * 60 }, ctx);
    expect(found).not.toBeNull();
    expect(found!.spot.setting).toBe("indoor");
    expect(found!.distanceM).toBeLessThanOrEqual(2000);
    expect(["ohori-starbucks", "ohori-art", "ohori-bimi", "ohori-mukashi", "ohori-tsutaya"]).toContain(found!.spot.id);
  });

  it("2kmを超える候補・閉店後の候補・除外指定のスポットは選ばれない", () => {
    const shrine = spot("dazaifu-shrine");
    const cands = findPlanBCandidates(shrine, { date: SATURDAY, start: 16 * 60 + 15, end: 17 * 60 }, ctx);
    // 16:15開始: 宝物殿は16:30閉館で、滞在30分が収まらない
    expect(cands.map((c) => c.spot.id)).not.toContain("dazaifu-treasure");
    for (const c of cands) expect(c.distanceM).toBeLessThanOrEqual(2000);

    const excluded = findPlanBCandidates(shrine, { date: SATURDAY, start: 10 * 60, end: 11 * 60 }, ctx, {
      excludeIds: new Set(["dazaifu-starbucks"]),
    });
    expect(excluded.map((c) => c.spot.id)).not.toContain("dazaifu-starbucks");
  });

  it("近くに営業中の屋内スポットがなければ null（警告の対象）", () => {
    const park = spot("ohori-park");
    // 23時台は周辺の屋内スポットがすべて閉まっている
    expect(findPlanB(park, { date: SATURDAY, start: 23 * 60, end: 23 * 60 + 30 }, ctx)).toBeNull();
  });

  it("requireIndoor=false なら屋外の代わりも候補になる（臨時休業の代替用）", () => {
    const art = spot("ohori-art");
    const cands = findPlanBCandidates(art, { date: SATURDAY, start: 11 * 60, end: 12 * 60 + 30 }, ctx, { requireIndoor: false });
    expect(cands.some((c) => c.spot.setting !== "indoor")).toBe(true);
  });
});
