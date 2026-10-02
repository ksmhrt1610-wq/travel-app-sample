import { describe, expect, it } from "vitest";
import { locateBlock } from "@/core/actions";
import { MEAL_ADJUST_WINDOW } from "@/core/meals";
import { generateItinerary, PACE_CONFIG } from "@/core/planner";
import { replan, restKind, type ReplanEvent } from "@/core/replan";
import { areaRevisits, totalTravelMin } from "@/core/route";
import { BUFFER_FLOOR_MIN } from "@/core/meals";
import { isInert, recomputeDay } from "@/core/schedule";
import { lastTransportGap, suggestionsForDay } from "@/core/suggest";
import { dayWalking, suggestRestForWalking, WALK_LIMIT_KM } from "@/core/walking";
import type { Day, Itinerary, Pace, Preferences } from "@/core/types";
import { dazaifuDay, demoPrefs, fixedSlack, hm, makeCtx, makeDay, SATURDAY, withFixed, wrapItinerary } from "./helpers";

const ctx = makeCtx();

/** 指定したブロックを食事ブロックにする */
const withMeal = (day: Day, id: string, meal: "lunch" | "dinner"): Day => ({
  ...day,
  blocks: day.blocks.map((b) => (b.id === id ? { ...b, meal } : b)),
});

const dazaifuPrefs: Preferences = {
  ...demoPrefs,
  interests: ["gourmet", "cafe", "history"],
  pace: "normal",
  mustSpotIds: ["dazaifu-shrine", "dazaifu-kyuhaku"],
};

describe("フェーズ1: 食事の保護", () => {
  it("旅程の生成では、食事ブロックに meal（lunch / dinner）が付き、食事向けスポットだけが食事になる", () => {
    for (const pace of ["relaxed", "normal", "packed"] as Pace[]) {
      const itin = generateItinerary({ prefs: { ...demoPrefs, pace }, ctx, startDate: SATURDAY });
      for (const b of itin.days[0].blocks) {
        const sp = b.spotId ? ctx.spotById.get(b.spotId) : undefined;
        if (b.meal) expect(sp?.mealSlots).toContain(b.meal);
        else if (sp) expect(sp.mealSlots).toBeUndefined();
      }
      expect(itin.days[0].blocks.filter((b) => b.meal).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("太宰府: かさの家は軽食扱いでランチにならず、ランチは食事向けのスポットになる", () => {
    const kasanoya = ctx.spotById.get("dazaifu-kasanoya")!;
    expect(kasanoya.snack).toBe(true);
    expect(kasanoya.mealSlots).toBeUndefined();
    const meals = ctx.spots.filter((s) => s.area === "dazaifu" && s.mealSlots?.includes("lunch"));
    expect(meals.length).toBeGreaterThanOrEqual(2);
    for (const m of meals) expect(m.dataNote).toBeTruthy(); // 概算の旨をデータにも持つ

    const itin = generateItinerary({ prefs: dazaifuPrefs, ctx, startDate: SATURDAY });
    const lunch = itin.days[0].blocks.find((b) => b.meal === "lunch");
    expect(lunch).toBeTruthy();
    expect(ctx.spotById.get(lunch!.spotId!)!.area).toBe("dazaifu");
    expect(lunch!.spotId).not.toBe("dazaifu-kasanoya");
  });

  it("遅延・休業・疲れた・固定時刻をどう重ねても、食事は確認なしに削除されない", () => {
    const meals = (d: Day) => d.blocks.filter((b) => b.meal);
    let itin = wrapItinerary(withMeal(withMeal(dazaifuDay(ctx), "s3", "lunch"), "s5", "dinner"));
    const mealIds = meals(itin.days[0]).map((b) => b.id);
    expect(mealIds.length).toBe(2);
    const events: [ReplanEvent, number][] = [
      [{ type: "fixed-add", fixed: { ...fixedEvent16() } }, hm(9)],
      [{ type: "delay", minutes: 60 }, hm(11)],
      [{ type: "tired", level: "heavy" }, hm(12)],
      [{ type: "delay", minutes: 90 }, hm(13)],
      [{ type: "tired", level: "light" }, hm(13, 30)],
    ];
    for (const [event, now] of events) {
      const r = replan(itin, event, ctx, { dayIndex: 0, nowMin: event.type === "fixed-add" ? undefined : now });
      for (const id of mealIds) expect(locateBlock(r.after, id)!.block.skip).toBeUndefined();
      itin = r.after;
    }
  });

  it("時間が足りないときは、標準を先に削り、食事は削らない", () => {
    // 標準 → 食事 → 標準。最終便（12:00）を早めて詰める
    const day = withMeal(
      makeDay(
        [
          { id: "a", spotId: "dazaifu-komyozen", start: hm(10), end: hm(10, 30) },
          { id: "m", spotId: "dazaifu-oishi", start: hm(11, 15), end: hm(12) },
          { id: "b", spotId: "dazaifu-starbucks", start: hm(12, 30), end: hm(13, 15) },
        ],
        ctx,
      ),
      "m",
      "lunch",
    );
    const r = replan(wrapItinerary(day), { type: "fixed-add", fixed: fixedEvent16(hm(12)) }, ctx, { dayIndex: 0 });
    expect(locateBlock(r.after, "m")!.block.skip).toBeUndefined();
    expect(locateBlock(r.after, "b")!.block.skip).toBe("skipped");
    const kinds = r.steps.filter((s) => s.phase === "reduce").map((s) => s.kind);
    expect(kinds).toContain("drop-standard");
    expect(kinds).not.toContain("drop-must");
  });

  it("食事が遅れて窓（〜14:30）にかかるときは、まず滞在を最低滞在まで短縮して窓に収める", () => {
    const day = withMeal(
      makeDay(
        [
          { id: "m", spotId: "dazaifu-oishi", start: hm(12, 30), end: hm(13, 15) },
          { id: "n", spotId: "dazaifu-kyuhaku", start: hm(13, 30), end: hm(15) },
        ],
        ctx,
      ),
      "m",
      "lunch",
    );
    const r = replan(wrapItinerary(day), { type: "delay", minutes: 90 }, ctx, { dayIndex: 0, nowMin: hm(11) });
    const meal = locateBlock(r.after, "m")!.block;
    expect(meal.skip).toBeUndefined();
    expect(meal.endMin).toBeLessThanOrEqual(MEAL_ADJUST_WINDOW.lunch.latest);
    expect(meal.endMin - meal.startMin).toBeLessThan(45);
    expect(r.steps.map((s) => s.kind)).toContain("meal-shorten");
    expect(r.feasible).toBe(true);
  });

  it("食事の店が営業できないときは、近く（1km以内）の別の食事向けスポットに差し替える", () => {
    // 2026-10-06 は火曜。さいふうどんは火曜定休
    const day = withMeal(makeDay([{ id: "m", spotId: "dazaifu-saifu-udon", start: hm(12), end: hm(12, 40) }], ctx, "2026-10-06"), "m", "lunch");
    const r = replan(wrapItinerary(day), { type: "margin", marginMin: 10 }, ctx, { dayIndex: 0 });
    const meal = locateBlock(r.after, "m")!.block;
    expect(meal.skip).toBeUndefined();
    expect(meal.spotId).toBe("dazaifu-oishi");
    expect(meal.meal).toBe("lunch");
    expect(r.steps.map((s) => s.kind)).toContain("meal-replace");
    expect(r.feasible).toBe(true);
  });

  it("それでも収まらないときは、食事を Must と同じ「削る候補」として提示するだけで、勝手に削らない", () => {
    const day = withMeal(makeDay([{ id: "m", spotId: "dazaifu-oishi", start: hm(12, 30), end: hm(13, 15) }], ctx), "m", "lunch");
    const r = replan(wrapItinerary(day), { type: "delay", minutes: 150 }, ctx, { dayIndex: 0, nowMin: hm(11) });
    expect(r.feasible).toBe(false);
    expect(r.violations.some((v) => v.kind === "outside-meal-window")).toBe(true);
    expect(locateBlock(r.after, "m")!.block.skip).toBeUndefined();
    const cand = r.mustCandidates.find((c) => c.blockId === "m");
    expect(cand?.kind).toBe("meal");
    // ユーザーが確認して外したときだけ外れる
    const r2 = replan(wrapItinerary(day), { type: "delay", minutes: 150 }, ctx, { dayIndex: 0, nowMin: hm(11), removeMustIds: ["m"] });
    expect(locateBlock(r2.after, "m")!.block.skip).toBe("skipped");
    expect(r2.feasible).toBe(true);
  });
});

/** 太宰府駅の最終便（既定 18:05 は helpers の fixedEvent と同じ形） */
function fixedEvent16(timeMin = hm(16)) {
  return {
    id: "",
    kind: "last-transport" as const,
    title: `太宰府駅 ${Math.floor(timeMin / 60)}:${String(timeMin % 60).padStart(2, "0")} の電車（最終）`,
    timeMin,
    dayIndex: 0,
    place: { name: "太宰府駅", lat: 33.5206, lng: 130.5304 },
    durationMin: 0,
    endsDay: true,
    memberIds: null,
  };
}

describe("フェーズ1: 余白の下限（ペース別）", () => {
  const longDelay = (pace: Pace) => {
    const day = makeDay(
      [
        { id: "a", spotId: "tenjin-rec", start: hm(10), end: hm(10, 45) },
        { id: "buf", start: hm(10, 45), end: hm(12, 15) },
        { id: "b", spotId: "tenjin-gogo", start: hm(12, 30), end: hm(12, 50) },
      ],
      ctx,
    );
    const itin = wrapItinerary(day, { ...demoPrefs, pace });
    return replan(itin, { type: "delay", minutes: 200 }, ctx, { dayIndex: 0, nowMin: hm(10, 15) });
  };

  it("余白が縮む下限は、ゆったり20分・普通10分・詰め込み5分", () => {
    expect(BUFFER_FLOOR_MIN).toEqual({ relaxed: 20, normal: 10, packed: 5 });
    for (const pace of ["relaxed", "normal", "packed"] as Pace[]) {
      const r = longDelay(pace);
      const buf = locateBlock(r.after, "buf")!.block;
      expect(buf.endMin - buf.startMin).toBe(BUFFER_FLOOR_MIN[pace]);
    }
  });

  it("余白は元の長さより短い下限は無理に延ばさない（短い待ち時間の余白は、そのまま）", () => {
    const day = makeDay(
      [
        { id: "a", spotId: "tenjin-rec", start: hm(10), end: hm(10, 45) },
        { id: "buf", start: hm(10, 45), end: hm(10, 55) },
        { id: "b", spotId: "tenjin-gogo", start: hm(11), end: hm(11, 20) },
      ],
      ctx,
    );
    const out = recomputeDay(day, ctx, { mode: "preserve", minBufferMin: 20 });
    const buf = out.blocks[1];
    expect(buf.endMin - buf.startMin).toBe(10);
  });
});

describe("フェーズ1: 休憩の場所と位置", () => {
  const dazaifu = () => withFixed(generateItinerary({ prefs: dazaifuPrefs, ctx, startDate: SATURDAY }), hm(18, 5), {}, ctx);

  it("今いる場所が屋内の休める場所なら、そこでの休憩の延長が提案される（使用済みのスポットでも可）", () => {
    const itin = dazaifu();
    const starbucks = itin.days[0].blocks.find((b) => b.spotId === "dazaifu-starbucks")!;
    const now = hm(15);
    expect(starbucks.startMin).toBeLessThanOrEqual(now);
    expect(starbucks.endMin).toBeGreaterThan(now);

    const r = replan(itin, { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: now });
    const blocks = r.after.days[0].blocks;
    const i = blocks.findIndex((b) => b.label === "rest");
    expect(blocks[i].spotId).toBe("dazaifu-starbucks");
    expect(blocks[i - 1].id).toBe(starbucks.id);
    expect(restKind(r.after.days[0], i, ctx)).toBe("extend");
    expect(r.notes.join("")).toContain("今いる場所");
    expect(r.feasible).toBe(true);
  });

  it("休憩は、失う予定の重みが最小になる位置に入れる（閉館が近い予定を先に回してから休む）", () => {
    // 15:30 にスターバックス滞在中。ここで休むと、16:30 閉館の光明禅寺に間に合わなくなる
    const day = makeDay(
      [
        { id: "a", spotId: "dazaifu-starbucks", start: hm(14, 45), end: hm(15, 45) },
        { id: "b", spotId: "dazaifu-komyozen", start: hm(15, 54), end: hm(16, 24) },
      ],
      ctx,
    );
    const itin = withFixed(wrapItinerary(day), hm(18, 5), {}, ctx);
    for (const level of ["light", "heavy"] as const) {
      const r = replan(itin, { type: "tired", level }, ctx, { dayIndex: 0, nowMin: hm(15, 30) });
      const blocks = r.after.days[0].blocks;
      const rest = blocks.findIndex((b) => b.label === "rest");
      const komyozen = blocks.findIndex((b) => b.id === "b");
      expect(blocks[komyozen].skip).toBeUndefined(); // 削られない
      expect(rest).toBeGreaterThan(komyozen); // 休憩は光明禅寺のあと
      expect(blocks[rest].endMin - blocks[rest].startMin).toBe(level === "light" ? 30 : 60);
      expect(r.feasible).toBe(true);
      expect(r.notes.join("")).toContain("のあとに入れます");
    }
  });

  it("休憩場所は、これから行くスポットや休業のスポットを選ばない", () => {
    // 次に行くのがスターバックスなら、手前の休憩にそこを使わない
    const day = makeDay(
      [
        { id: "a", spotId: "dazaifu-shrine", start: hm(10), end: hm(11) },
        { id: "b", spotId: "dazaifu-starbucks", start: hm(11, 15), end: hm(12) },
      ],
      ctx,
    );
    const r = replan(wrapItinerary(day), { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(10, 30) });
    for (const b of r.after.days[0].blocks) {
      if (b.label !== "rest") continue;
      const idx = r.after.days[0].blocks.indexOf(b);
      const later = r.after.days[0].blocks.slice(idx + 1).filter((x) => !isInert(x)).map((x) => x.spotId);
      expect(later).not.toContain(b.spotId);
    }
  });
});

describe("フェーズ1: 最終便の前の長い空き", () => {
  const itinWithFixed = () => withFixed(generateItinerary({ prefs: dazaifuPrefs, ctx, startDate: SATURDAY }), hm(18, 5), {}, ctx);

  it("空きの大きさ: 出発すべき時刻 − 直前の予定の終わり", () => {
    const itin = itinWithFixed();
    const gap = lastTransportGap(itin.days[0], ctx, 10)!;
    expect(gap.departBy - gap.startMin).toBe(gap.gapMin);
    expect(gap.gapMin).toBeGreaterThanOrEqual(60);
  });

  it("60分以上空くなら『早い便で帰る』が提案され、選ぶと固定時刻が前倒しされて間に合う", () => {
    const r = replan(
      generateItinerary({ prefs: dazaifuPrefs, ctx, startDate: SATURDAY }),
      { type: "fixed-add", fixed: fixedEvent16(hm(18, 5)) },
      ctx,
      { dayIndex: 0 },
    );
    const earlier = r.suggestions.filter((s) => s.kind === "earlier-transport");
    expect(earlier.length).toBeGreaterThanOrEqual(1);
    for (const s of earlier) {
      expect(s.event.type).toBe("fixed-move");
      if (s.event.type === "fixed-move") expect(s.event.timeMin).toBeLessThan(hm(18, 5));
    }
    // 自動では反映されない
    expect(r.after.days[0].blocks.find((b) => b.fixed)!.startMin).toBe(hm(18, 5));

    const ev = earlier[0].event;
    const r2 = replan(r.after, ev, ctx, { dayIndex: 0 });
    const fixed = r2.after.days[0].blocks.find((b) => b.fixed)!;
    if (ev.type === "fixed-move") expect(fixed.startMin).toBe(ev.timeMin);
    expect(r2.feasible).toBe(true);
    expect(fixedSlack(r2.after, ctx)).toBeGreaterThanOrEqual(0);
  });

  it("『かなり疲れた』のあとに空きができたときも提案される。60分未満なら提案しない", () => {
    const itin = itinWithFixed();
    const gapNow = lastTransportGap(itin.days[0], ctx, 10)!;
    expect(gapNow.gapMin).toBeGreaterThanOrEqual(60);
    const suggestions = suggestionsForDay(itin, ctx, { dayIndex: 0 });
    expect(suggestions.length).toBeGreaterThan(0);

    // 休憩で空きを埋めると、提案は出ない
    const r = replan(itin, { type: "tired", level: "heavy" }, ctx, { dayIndex: 0, nowMin: hm(15) });
    const g = lastTransportGap(r.after.days[0], ctx, 10)!;
    if (g.gapMin < 60) expect(r.suggestions).toEqual([]);
  });

  it("駅の近くの休める場所で待つ提案は、最終便に間に合う", () => {
    const itin = itinWithFixed();
    const wait = suggestionsForDay(itin, ctx, { dayIndex: 0 }).find((s) => s.kind === "wait-nearby");
    expect(wait).toBeTruthy();
    const r = replan(itin, wait!.event, ctx, { dayIndex: 0 });
    expect(r.feasible).toBe(true);
    expect(fixedSlack(r.after, ctx)).toBeGreaterThanOrEqual(0);
  });
});

describe("フェーズ1: 旅程生成の質", () => {
  const prefsFor = (pace: Pace): Preferences => ({ ...demoPrefs, pace });

  it("生成直後の歩行距離は、ペース別の目安の85%以内（全ペース・デモ設定）で、歩行距離の休憩提案が出ない", () => {
    for (const pace of ["relaxed", "normal", "packed"] as Pace[]) {
      const itin = generateItinerary({ prefs: prefsFor(pace), ctx, startDate: SATURDAY });
      const day = itin.days[0];
      const walk = dayWalking(day, ctx, pace);
      expect(walk.totalM).toBeLessThanOrEqual(WALK_LIMIT_KM[pace] * 1000 * 0.85);
      for (let now = day.startMin; now <= day.endMin; now += 5) {
        expect(suggestRestForWalking(day, ctx, pace, now)).toBeNull();
      }
    }
  });

  it("目安に収まるよう調整しても、食事（ランチ・ディナー）と余白は入っている", () => {
    for (const pace of ["relaxed", "normal", "packed"] as Pace[]) {
      const day = generateItinerary({ prefs: prefsFor(pace), ctx, startDate: SATURDAY }).days[0];
      expect(day.blocks.some((b) => b.meal === "lunch")).toBe(true);
      expect(day.blocks.some((b) => b.meal === "dinner")).toBe(true);
    }
  });

  it("行きたい場所（Must）は、歩行距離の目安のために落とされない", () => {
    const itin = generateItinerary({ prefs: dazaifuPrefs, ctx, startDate: SATURDAY });
    const ids = itin.days[0].blocks.map((b) => b.spotId);
    expect(ids).toContain("dazaifu-shrine");
    expect(ids).toContain("dazaifu-kyuhaku");
  });

  it("動線の改善（2-opt）で、移動時間の合計とエリアの行き来が増えない", () => {
    const interests: Preferences["interests"][] = [["gourmet", "cafe"], ["history", "art"], ["shopping", "gourmet"], ["nature", "cafe"]];
    let strictlyBetter = 0;
    for (const pace of ["relaxed", "normal", "packed"] as Pace[]) {
      for (const ints of interests) {
        const prefs: Preferences = { ...demoPrefs, pace, interests: ints };
        const raw = generateItinerary({ prefs, ctx, startDate: SATURDAY, options: { optimizeRoute: false } }).days[0];
        const opt = generateItinerary({ prefs, ctx, startDate: SATURDAY }).days[0];
        expect(totalTravelMin(opt)).toBeLessThanOrEqual(totalTravelMin(raw));
        expect(areaRevisits(opt, ctx)).toBeLessThanOrEqual(areaRevisits(raw, ctx));
        if (totalTravelMin(opt) < totalTravelMin(raw)) strictlyBetter++;
        // 食事の窓・営業時間は壊さない
        for (const b of opt.blocks) {
          expect(b.issues ?? []).toEqual([]);
          if (b.meal) {
            expect(b.startMin).toBeGreaterThanOrEqual(MEAL_ADJUST_WINDOW[b.meal].earliest);
            expect(b.endMin).toBeLessThanOrEqual(MEAL_ADJUST_WINDOW[b.meal].latest);
          }
        }
      }
    }
    expect(strictlyBetter).toBeGreaterThanOrEqual(1); // 実際に改善している
  });

  it("デモ旅程（ゆったり）で、エリアを行き来する回数が1回以下", () => {
    const day = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY }).days[0];
    expect(areaRevisits(day, ctx)).toBeLessThanOrEqual(1);
  });

  it("日の終わりを超えず、時刻が重ならない（生成後の不変条件）", () => {
    for (const pace of ["relaxed", "normal", "packed"] as Pace[]) {
      const day = generateItinerary({ prefs: prefsFor(pace), ctx, startDate: SATURDAY }).days[0];
      let prevEnd = 0;
      for (const b of day.blocks) {
        expect(b.startMin).toBeGreaterThanOrEqual(prevEnd);
        prevEnd = b.endMin;
      }
      expect(prevEnd).toBeLessThanOrEqual(PACE_CONFIG[pace].dayEndMin + 30);
    }
  });
});
