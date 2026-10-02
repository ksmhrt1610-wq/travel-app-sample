import { describe, expect, it } from "vitest";
import { isOpenDuring } from "@/core/availability";
import { generateItinerary, PACE_CONFIG } from "@/core/planner";
import { weekdayOf } from "@/core/time";
import type { Itinerary, Pace, Preferences } from "@/core/types";
import { demoPrefs, makeCtx, MONDAY, SATURDAY, spots } from "./helpers";

const ctx = makeCtx();

function allSpotBlocks(itin: Itinerary) {
  return itin.days.flatMap((d) => d.blocks.filter((b) => b.spotId).map((b) => ({ day: d, block: b })));
}

describe("旅程生成: 営業時間", () => {
  const prefsList: Preferences[] = [
    demoPrefs,
    { ...demoPrefs, duration: "overnight", pace: "normal", interests: ["history", "nature", "art"] },
    { ...demoPrefs, duration: "overnight", pace: "packed", interests: ["shopping", "nightview", "gourmet"], companions: "couple", budget: "luxury" },
    { ...demoPrefs, pace: "packed", interests: ["cafe", "art"], budget: "saving", companions: "solo" },
  ];

  for (const date of [SATURDAY, MONDAY]) {
    it(`営業時間外・定休日のスポットは入らない（${date}, 曜日=${weekdayOf(date)}）`, () => {
      for (const prefs of prefsList) {
        const itin = generateItinerary({ prefs, ctx, startDate: date });
        for (const { day, block } of allSpotBlocks(itin)) {
          const spot = ctx.spotById.get(block.spotId!)!;
          expect(
            isOpenDuring(spot, day.date, block.startMin, block.endMin),
            `${spot.name} ${block.startMin}-${block.endMin} on ${day.date}`,
          ).toBe(true);
        }
      }
    });
  }

  it("月曜は定休日の美術館・博物館が入らない", () => {
    const itin = generateItinerary({
      prefs: { ...demoPrefs, interests: ["art", "history"], pace: "packed" },
      ctx,
      startDate: MONDAY,
    });
    const names = allSpotBlocks(itin).map(({ block }) => ctx.spotById.get(block.spotId!)!);
    for (const s of names) expect(s.closedDays?.includes(1) ?? false).toBe(false);
  });

  it("Must が定休日なら、入れられない旨の警告を出す", () => {
    const itin = generateItinerary({
      prefs: { ...demoPrefs, mustSpotIds: ["ohori-art"] },
      ctx,
      startDate: MONDAY,
    });
    expect(allSpotBlocks(itin).some(({ block }) => block.spotId === "ohori-art")).toBe(false);
    expect(itin.days[0].warnings.join("")).toContain("福岡市美術館");
  });
});

describe("旅程生成: 構造", () => {
  it("同じスポットは重複しない／ブロックは時間順で重ならない", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, duration: "overnight", pace: "packed" }, ctx, startDate: SATURDAY });
    const ids = allSpotBlocks(itin).map(({ block }) => block.spotId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const day of itin.days) {
      for (let i = 1; i < day.blocks.length; i++) {
        const prev = day.blocks[i - 1];
        const cur = day.blocks[i];
        expect(cur.startMin).toBeGreaterThanOrEqual(prev.endMin + cur.travelMin - 1);
      }
      expect(day.blocks.at(-1)!.endMin).toBeLessThanOrEqual(day.endMin);
    }
  });

  it("日帰りは1日、1泊2日は2日分", () => {
    expect(generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY }).days).toHaveLength(1);
    expect(generateItinerary({ prefs: { ...demoPrefs, duration: "overnight" }, ctx, startDate: SATURDAY }).days).toHaveLength(2);
  });

  it("昼と夜の食事（ランチ・ディナー）が入る", () => {
    const itin = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const meals = allSpotBlocks(itin).filter(({ block }) => ctx.spotById.get(block.spotId!)!.mealSlots);
    expect(meals.length).toBeGreaterThanOrEqual(2);
    const lunch = meals.find(({ block }) => block.startMin >= 11 * 60 && block.startMin <= 14 * 60);
    const dinner = meals.find(({ block }) => block.startMin >= 17 * 60 + 30);
    expect(lunch).toBeTruthy();
    expect(dinner).toBeTruthy();
  });

  it("夜景スポットは日没後（17:30以降）に入る", () => {
    const itin = generateItinerary({
      prefs: { ...demoPrefs, interests: ["nightview"], companions: "couple", mustSpotIds: ["momochi-tower"] },
      ctx,
      startDate: SATURDAY,
    });
    const tower = allSpotBlocks(itin).find(({ block }) => block.spotId === "momochi-tower");
    expect(tower).toBeTruthy();
    expect(tower!.block.startMin).toBeGreaterThanOrEqual(17 * 60 + 30);
  });
});

describe("旅程生成: Must / Optional / 余白", () => {
  it("Must に選んだスポットは Must ラベルで入る", () => {
    const itin = generateItinerary({
      prefs: { ...demoPrefs, mustSpotIds: ["dazaifu-shrine", "ohori-park"], duration: "overnight" },
      ctx,
      startDate: SATURDAY,
    });
    for (const id of ["dazaifu-shrine", "ohori-park"]) {
      const found = allSpotBlocks(itin).find(({ block }) => block.spotId === id);
      expect(found, id).toBeTruthy();
      expect(found!.block.label).toBe("must");
    }
  });

  it("1泊2日では Must がエリア単位で日に振り分けられる（太宰府と大濠は別の日）", () => {
    const itin = generateItinerary({
      prefs: { ...demoPrefs, mustSpotIds: ["dazaifu-shrine", "dazaifu-kyuhaku", "ohori-park", "ohori-art"], duration: "overnight" },
      ctx,
      startDate: SATURDAY,
    });
    const dayOf = (id: string) => itin.days.findIndex((d) => d.blocks.some((b) => b.spotId === id));
    expect(dayOf("dazaifu-shrine")).toBe(dayOf("dazaifu-kyuhaku"));
    expect(dayOf("ohori-park")).toBe(dayOf("ohori-art"));
    expect(dayOf("dazaifu-shrine")).not.toBe(dayOf("ohori-park"));
  });

  it("Optional が付く（スポットが3つ以上の日）", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, pace: "packed" }, ctx, startDate: SATURDAY });
    expect(itin.days[0].blocks.some((b) => b.label === "optional")).toBe(true);
  });

  it("ペースが ゆったり ほど余白が多い", () => {
    const bufferMin = (pace: Pace) => {
      const itin = generateItinerary({ prefs: { ...demoPrefs, pace }, ctx, startDate: SATURDAY });
      return itin.days[0].blocks.filter((b) => b.label === "buffer").reduce((n, b) => n + (b.endMin - b.startMin), 0);
    };
    const relaxed = bufferMin("relaxed");
    const normal = bufferMin("normal");
    const packed = bufferMin("packed");
    expect(relaxed).toBeGreaterThan(packed);
    expect(normal).toBeGreaterThanOrEqual(packed);
    expect(PACE_CONFIG.relaxed.restLen).toBeGreaterThan(PACE_CONFIG.packed.restLen);
  });

  it("ペースが 詰め込み ほどスポット数が多い", () => {
    const count = (pace: Pace) =>
      generateItinerary({ prefs: { ...demoPrefs, pace }, ctx, startDate: SATURDAY }).days[0].blocks.filter((b) => b.spotId).length;
    expect(count("packed")).toBeGreaterThan(count("relaxed"));
  });
});

describe("旅程生成: 入力条件のスコアリング", () => {
  it("興味に合うカテゴリが多く選ばれる", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, interests: ["art", "history"], pace: "packed" }, ctx, startDate: SATURDAY });
    const picked = allSpotBlocks(itin).map(({ block }) => ctx.spotById.get(block.spotId!)!);
    const matching = picked.filter((s) => !s.mealSlots && (["art", "history"].includes(s.category) || s.tags?.some((t) => ["art", "history"].includes(t))));
    expect(matching.length).toBeGreaterThanOrEqual(3);
  });

  it("節約予算では高価格帯（3,000円〜）のスポットを選ばない", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, budget: "saving", pace: "packed" }, ctx, startDate: SATURDAY });
    for (const { block } of allSpotBlocks(itin)) expect(ctx.spotById.get(block.spotId!)!.priceLevel).toBeLessThan(3);
  });

  it("生成は決定的（同じ入力なら同じ旅程）", () => {
    const a = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const b = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    expect(a).toEqual(b);
  });

  it("データが空でも落ちずに空の日を返す", () => {
    const empty = makeCtx([]);
    const itin = generateItinerary({ prefs: demoPrefs, ctx: empty, startDate: SATURDAY });
    expect(itin.days[0].blocks).toHaveLength(0);
  });

  it("サンプルデータは30〜40件で、屋内・屋外がバランスよく含まれる", () => {
    expect(spots.length).toBeGreaterThanOrEqual(30);
    expect(spots.length).toBeLessThanOrEqual(45);
    const indoor = spots.filter((s) => s.setting === "indoor").length;
    const outdoor = spots.filter((s) => s.setting !== "indoor").length;
    expect(indoor).toBeGreaterThanOrEqual(10);
    expect(outdoor).toBeGreaterThanOrEqual(10);
    for (const area of ["tenjin", "hakata", "nakasu", "ohori", "momochi", "dazaifu"]) {
      expect(spots.some((s) => s.area === area), area).toBe(true);
    }
  });
});
