import { describe, expect, it } from "vitest";
import { locateBlock, reorderBlocks } from "@/core/actions";
import { causeKey, templateWriter } from "@/core/cause";
import { commitItinerary, commitResult, HISTORY_LIMIT, itineraryChanged, undoLast, type Versioned } from "@/core/history";
import { generateItinerary } from "@/core/planner";
import { canAutoApply, classifyChange, decideApply, DEFAULT_MODE, modeOf } from "@/core/policy";
import { replan, type ReplanEvent, type ReplanResult } from "@/core/replan";
import type { Day, Itinerary, ResponseMode } from "@/core/types";
import { dazaifuDay, demoPrefs, fixedEvent, hm, makeCtx, makeDay, SATURDAY, withFixed, wrapItinerary } from "./helpers";

const ctx = makeCtx();
const dazaifu = () => wrapItinerary(dazaifuDay(ctx));
const withMeal = (day: Day, id: string, meal: "lunch" | "dinner"): Day => ({ ...day, blocks: day.blocks.map((b) => (b.id === id ? { ...b, meal } : b)) });
const modes: ResponseMode[] = ["manual", "suggest", "auto"];

/** 天神の2件だけの日（スポットを足しても、削られずに残る）。予算を変えて使う */
const tenjinDay = (budget: "saving" | "normal" | "luxury") =>
  wrapItinerary(
    makeDay(
      [
        { id: "a", spotId: "tenjin-gogo", start: hm(10), end: hm(10, 20) },
        { id: "b", spotId: "tenjin-chikagai", start: hm(12), end: hm(13) },
      ],
      ctx,
    ),
    { ...demoPrefs, budget },
  );

describe("フェーズ2: 変更の重さ（軽い／重い）", () => {
  it("軽い変更: 遅れの反映・Plan B の入れ替え・Optional のスキップ・休憩の挿入・余裕時間の変更", () => {
    const itin = withFixed(dazaifu(), hm(18), {}, ctx);
    const light = (event: ReplanEvent, now?: number) => classifyChange(replan(itin, event, ctx, { dayIndex: 0, nowMin: now }), ctx);

    expect(light({ type: "delay", minutes: 20 }, hm(10)).weight).toBe("light");
    expect(light({ type: "skip", blockIds: ["s6"] }).weight).toBe("light"); // Optional
    expect(light({ type: "tired", level: "light" }, hm(10, 30)).weight).toBe("light");
    expect(light({ type: "margin", marginMin: 15 }).weight).toBe("light");

    const demo = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const outdoor = demo.days[0].blocks.find((b) => b.planB)!;
    const r = replan(demo, { type: "plan-b", blockIds: [outdoor.id], cause: "rain" }, ctx, { dayIndex: 0, nowMin: hm(9) });
    expect(classifyChange(r, ctx)).toEqual({ weight: "light", reasons: [] });
  });

  it("重い変更: 標準・食事・Must を外す案", () => {
    const itin = withFixed(dazaifu(), hm(18), {}, ctx);
    // 標準を外す
    const std = replan(itin, { type: "skip", blockIds: ["s3"] }, ctx, { dayIndex: 0 });
    expect(classifyChange(std, ctx).weight).toBe("heavy");
    // Must を（確認したうえで）外す
    const must = replan(itin, { type: "margin", marginMin: 10 }, ctx, { dayIndex: 0, removeMustIds: ["s2"] });
    const c = classifyChange(must, ctx);
    expect(c.weight).toBe("heavy");
    expect(c.reasons.join("")).toContain("Must");
    // 食事を外す
    const mealDay = wrapItinerary(withMeal(dazaifuDay(ctx), "s3", "lunch"));
    const meal = replan(mealDay, { type: "skip", blockIds: ["s3"] }, ctx, { dayIndex: 0 });
    expect(classifyChange(meal, ctx).weight).toBe("heavy");
  });

  it("重い変更: 削減で標準が削られる組み直し（軽い削減と混ざるので全体が重い）", () => {
    const r = replan(dazaifu(), { type: "fixed-add", fixed: fixedEvent(hm(13)) }, ctx, { dayIndex: 0 });
    expect(r.steps.some((s) => s.kind === "drop-optional")).toBe(true);
    expect(r.steps.some((s) => s.kind === "drop-standard")).toBe(true);
    expect(classifyChange(r, ctx).weight).toBe("heavy");
  });

  it("重い変更: Must を別のスポットに入れ替える（Plan B・休業の代替）", () => {
    const day = makeDay([{ id: "a", label: "must", spotId: "ohori-park", start: hm(10), end: hm(11) }], ctx);
    const itin = wrapItinerary(day);
    const r = replan(itin, { type: "closure", spotId: "ohori-park", replacementSpotId: "ohori-starbucks" }, ctx, { dayIndex: 0 });
    const c = classifyChange(r, ctx);
    expect(c.weight).toBe("heavy");
    expect(c.reasons.join("")).toContain("Must を別のスポット");
  });

  it("重い変更: 固定時刻・予約が絡む（追加・変更・削除）", () => {
    const add = replan(dazaifu(), { type: "fixed-add", fixed: fixedEvent(hm(19)) }, ctx, { dayIndex: 0 });
    expect(classifyChange(add, ctx).reasons.join("")).toContain("固定時刻");
    const base = withFixed(dazaifu(), hm(19), {}, ctx);
    const id = base.days[0].blocks.find((b) => b.fixed)!.id;
    for (const event of [{ type: "fixed-move", fixedId: id, timeMin: hm(18) }, { type: "fixed-remove", fixedId: id }] as ReplanEvent[]) {
      expect(classifyChange(replan(base, event, ctx, { dayIndex: 0 }), ctx).weight).toBe("heavy");
    }
  });

  it("重い変更: 予算を超える価格帯のスポットが入る（追加の費用）", () => {
    const itin = tenjinDay("saving");
    const r = replan(itin, { type: "add-spot", spotId: "tenjin-parco", afterBlockId: "a" }, ctx, { dayIndex: 0 });
    expect(locateBlock(r.after, r.steps[0].blockIds[0])!.block.skip).toBeUndefined(); // 追加したスポットが残っている
    const c = classifyChange(r, ctx);
    expect(c.weight).toBe("heavy");
    expect(c.reasons.join("")).toContain("予算");
    // 予算内（無料）なら、費用の理由では重くならない
    const free = replan(tenjinDay("saving"), { type: "add-spot", spotId: "tenjin-acros", afterBlockId: "a" }, ctx, { dayIndex: 0 });
    expect(classifyChange(free, ctx).reasons.join("")).not.toContain("予算");
    // 予算が贅沢なら、同じスポットでも費用の理由にならない
    const luxury = replan(tenjinDay("luxury"), { type: "add-spot", spotId: "tenjin-parco", afterBlockId: "a" }, ctx, { dayIndex: 0 });
    expect(classifyChange(luxury, ctx).reasons.join("")).not.toContain("予算");
  });

  it("重い変更: 予定の半分以上が変わる（時刻が動くだけの変更は数えない）", () => {
    const day = makeDay(
      [
        { id: "a", spotId: "tenjin-gogo", start: hm(10), end: hm(10, 20) },
        { id: "b", spotId: "hakata-kushida", start: hm(11), end: hm(11, 30) },
        { id: "c", spotId: "ohori-park", start: hm(12, 30), end: hm(13, 30) },
        { id: "d", spotId: "momochi-seaside", start: hm(14, 30), end: hm(15, 15) },
      ],
      ctx,
    );
    // 屋外の4件に Plan B を付ける
    const itin = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    void itin;
    const planned = wrapItinerary({ ...day, blocks: day.blocks.map((b) => ({ ...b })) });
    const withPlanB = replan(planned, { type: "margin", marginMin: 10 }, ctx, { dayIndex: 0 }).after; // Plan B を付け直す
    const ids = withPlanB.days[0].blocks.filter((b) => b.planB).map((b) => b.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const one = classifyChange(replan(withPlanB, { type: "plan-b", blockIds: [ids[0]] }, ctx, { dayIndex: 0, nowMin: hm(9) }), ctx);
    expect(one.reasons.join("")).not.toContain("半分以上");
    const many = classifyChange(replan(withPlanB, { type: "plan-b", blockIds: ids }, ctx, { dayIndex: 0, nowMin: hm(9) }), ctx);
    expect(many.weight).toBe("heavy");
    expect(many.reasons.join("")).toContain("半分以上");
    // 大きな遅れでも、時刻が動くだけなら半分ルールにはならない
    const delay = classifyChange(replan(withPlanB, { type: "delay", minutes: 30 }, ctx, { dayIndex: 0, nowMin: hm(9) }), ctx);
    expect(delay.reasons.join("")).not.toContain("半分以上");
  });

  it("重い変更: 間に合わない予定が残る案・Must を外す候補が出る案は、自動では確定しない", () => {
    const r = replan(dazaifu(), { type: "fixed-add", fixed: fixedEvent(hm(10, 30)) }, ctx, { dayIndex: 0 });
    expect(r.feasible).toBe(false);
    const c = classifyChange(r, ctx);
    expect(c.weight).toBe("heavy");
    expect(c.reasons.join("")).toContain("間に合わない");
  });
});

describe("フェーズ2: 3つのモード", () => {
  it("確定のしかた: 重い変更はどのモードでも確認。軽い変更は、手動なら確認・提案とおまかせはそのまま反映", () => {
    for (const m of modes) expect(decideApply(m, "heavy")).toBe("propose");
    expect(decideApply("manual", "light")).toBe("propose");
    expect(decideApply("suggest", "light")).toBe("apply");
    expect(decideApply("auto", "light")).toBe("apply");
  });

  it("アプリが気づいて自動で反映するのは、おまかせモードの軽い変更だけ", () => {
    expect(canAutoApply("auto", "light")).toBe(true);
    expect(canAutoApply("auto", "heavy")).toBe(false);
    expect(canAutoApply("suggest", "light")).toBe(false);
    expect(canAutoApply("manual", "light")).toBe(false);
  });

  it("初期値は『提案』。旅程のモード設定を読める（古い旅程は設定がなくても提案）", () => {
    expect(DEFAULT_MODE).toBe("suggest");
    expect(modeOf({ settings: { marginMin: 10 } })).toBe("suggest");
    expect(modeOf({ settings: { marginMin: 10, mode: "auto" } })).toBe("auto");
    expect(modeOf(undefined)).toBe("suggest");
  });

  it("おまかせでも、Must・食事・固定時刻・費用の変更は自動反映されない", () => {
    const base = withFixed(dazaifu(), hm(18), {}, ctx);
    const fixedId = base.days[0].blocks.find((b) => b.fixed)!.id;
    const mealDay = wrapItinerary(withMeal(dazaifuDay(ctx), "s3", "lunch"));
    const cases: [string, ReplanResult][] = [
      ["Must を外す", replan(base, { type: "margin", marginMin: 10 }, ctx, { dayIndex: 0, removeMustIds: ["s1"] })],
      ["食事を外す", replan(mealDay, { type: "skip", blockIds: ["s3"] }, ctx, { dayIndex: 0 })],
      ["固定時刻の前倒し", replan(base, { type: "fixed-move", fixedId, timeMin: hm(17) }, ctx, { dayIndex: 0 })],
      ["固定時刻の追加", replan(dazaifu(), { type: "fixed-add", fixed: fixedEvent(hm(18)) }, ctx, { dayIndex: 0 })],
      ["予算を超えるスポット", replan(tenjinDay("saving"), { type: "add-spot", spotId: "tenjin-parco", afterBlockId: "a" }, ctx, { dayIndex: 0 })],
    ];
    for (const [label, result] of cases) {
      const c = classifyChange(result, ctx);
      expect(c.weight, label).toBe("heavy");
      expect(canAutoApply("auto", c.weight), label).toBe(false);
      for (const m of modes) expect(decideApply(m, c.weight), `${label}（${m}）`).toBe("propose");
    }
  });
});

describe("フェーズ2: 元に戻す", () => {
  const events: [ReplanEvent, number | undefined][] = [
    [{ type: "delay", minutes: 40 }, hm(11)],
    [{ type: "tired", level: "light" }, hm(12, 30)],
    [{ type: "closure", spotId: "dazaifu-komyozen" }, hm(12)],
    [{ type: "fixed-add", fixed: fixedEvent(hm(17, 30)) }, undefined],
    [{ type: "margin", marginMin: 20 }, undefined],
    [{ type: "tired", level: "heavy" }, hm(13)],
    [{ type: "skip", blockIds: ["s6"] }, hm(11)],
  ];

  it("反映した変更は、直前の状態に完全に戻る（深い比較）", () => {
    let state: Versioned = { itinerary: dazaifu(), history: [] };
    for (const [event, now] of events) {
      const before = structuredClone(state);
      const result = replan(state.itinerary, event, ctx, { dayIndex: 0, nowMin: now });
      const after = commitResult(state, result, { atMin: now ?? 0, title: event.type });
      if (after === state) {
        // 旅程が変わらない組み直しは、何も反映せず、履歴にも残さない
        expect(itineraryChanged(state.itinerary, result.after)).toBe(false);
        continue;
      }
      expect(after.itinerary).toEqual(result.after);
      const undone = undoLast(after);
      expect(undone.itinerary).toEqual(before.itinerary);
      expect(undone.history).toEqual(before.history);
      state = after;
    }
  });

  it("続けて何度でも戻せて、最初の状態に戻る", () => {
    const first = dazaifu();
    let state: Versioned = { itinerary: first, history: [] };
    let n = 0;
    for (const [event, now] of events) {
      const result = replan(state.itinerary, event, ctx, { dayIndex: 0, nowMin: now });
      if (!result.diff.length) continue;
      state = commitResult(state, result, { atMin: now ?? 0, title: event.type });
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < n; i++) state = undoLast(state);
    expect(state.itinerary).toEqual(first);
    expect(state.history).toEqual([]);
  });

  it("履歴は最大10件。11件目からは古いものが落ちる", () => {
    expect(HISTORY_LIMIT).toBe(10);
    let state: Versioned = { itinerary: dazaifu(), history: [] };
    for (let i = 0; i < 12; i++) {
      const result = replan(state.itinerary, { type: "delay", minutes: 5 }, ctx, { dayIndex: 0, nowMin: hm(9) });
      state = commitResult(state, result, { atMin: i, title: `d${i}` });
    }
    expect(state.history).toHaveLength(HISTORY_LIMIT);
    expect(state.history[0].title).toBe("d11");
    expect(state.history[HISTORY_LIMIT - 1].title).toBe("d2");
    for (let i = 0; i < HISTORY_LIMIT; i++) state = undoLast(state);
    expect(undoLast(state)).toEqual(state); // 戻せるものがなければ何も起きない
  });

  it("並べ替えなど、組み直しではない編集も元に戻せる", () => {
    const itin = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const next = reorderBlocks(itin, 0, 0, 1, ctx);
    expect(next).not.toEqual(itin);
    const state = commitItinerary({ itinerary: itin, history: [] } as Versioned, next, { atMin: 0, title: "並べ替え" });
    expect(state.itinerary).toEqual(next);
    expect(undoLast(state).itinerary).toEqual(itin);
  });

  it("履歴は反映前の旅程の複製を持ち、あとから元の旅程を変えても影響されない", () => {
    const itin = dazaifu();
    const result = replan(itin, { type: "delay", minutes: 30 }, ctx, { dayIndex: 0, nowMin: hm(11) });
    const state = commitResult({ itinerary: itin, history: [] } as Versioned, result, { atMin: hm(11), title: "遅延" });
    const snapshot = structuredClone(itin);
    itin.days[0].blocks[0].durationMin += 99; // 元のオブジェクトを書き換える
    expect(state.history[0].before).toEqual(snapshot);
  });
});

describe("フェーズ2: 変更の理由（cause）", () => {
  const checkAllHaveReasons = (r: ReplanResult, label: string) => {
    for (const d of r.diff) {
      expect(d.cause, `${label}: ${d.kind}`).toBeTruthy();
      expect(d.reason?.length ?? 0, `${label}: ${d.kind}`).toBeGreaterThan(3);
    }
  };

  it("差分のすべての削除・変更に、理由が付く（遅延・休業・疲れた・固定時刻・Plan B・余裕時間・スキップ）", () => {
    const base = withFixed(dazaifu(), hm(18), {}, ctx);
    const demo = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const rainBlock = demo.days[0].blocks.find((b) => b.planB)!;
    const scenarios: [string, ReplanResult][] = [
      ["遅延", replan(base, { type: "delay", minutes: 90 }, ctx, { dayIndex: 0, nowMin: hm(12) })],
      ["休業", replan(base, { type: "closure", spotId: "dazaifu-komyozen" }, ctx, { dayIndex: 0, nowMin: hm(10) })],
      ["少し休みたい", replan(base, { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(13) })],
      ["かなり疲れた", replan(base, { type: "tired", level: "heavy" }, ctx, { dayIndex: 0, nowMin: hm(13) })],
      ["固定時刻の追加", replan(dazaifu(), { type: "fixed-add", fixed: fixedEvent(hm(13)) }, ctx, { dayIndex: 0 })],
      ["余裕時間", replan(base, { type: "margin", marginMin: 40 }, ctx, { dayIndex: 0 })],
      ["スキップ", replan(base, { type: "skip", blockIds: ["s4"] }, ctx, { dayIndex: 0 })],
      ["Plan B（雨）", replan(demo, { type: "plan-b", blockIds: [rainBlock.id], cause: "rain" }, ctx, { dayIndex: 0, nowMin: hm(9) })],
      ["固定時刻の前倒し", replan(base, { type: "fixed-move", fixedId: base.days[0].blocks.find((b) => b.fixed)!.id, timeMin: hm(16) }, ctx, { dayIndex: 0 })],
    ];
    for (const [label, r] of scenarios) checkAllHaveReasons(r, label);
    // 差分が出たシナリオが十分あること（空の差分で素通りしていない）
    expect(scenarios.filter(([, r]) => r.diff.length > 0).length).toBeGreaterThanOrEqual(8);
  });

  it("理由の種類: 最終便・閉館・遅れ・休憩・雨", () => {
    // 最終便に間に合わせるために削った
    const fx = replan(dazaifu(), { type: "fixed-add", fixed: fixedEvent(hm(14)) }, ctx, { dayIndex: 0 });
    const dropped = fx.diff.filter((d) => d.kind === "skipped");
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((d) => d.cause?.kind === "fixed")).toBe(true);
    expect(dropped[0].reason).toContain("最終便");

    // 閉館に間に合わない Optional を削った
    const late = replan(dazaifu(), { type: "delay", minutes: 90 }, ctx, { dayIndex: 0, nowMin: hm(13) });
    const closing = late.diff.find((d) => d.kind === "skipped")!;
    expect(closing.cause?.kind).toBe("closing");
    expect(closing.reason).toContain("閉館");
    expect(closing.reason).toContain(`「${ctx.spotById.get(closing.after.spotId!)!.name}」`);

    // 遅れ・休憩・雨
    const shifted = late.diff.find((d) => d.kind === "shifted");
    if (shifted) expect(shifted.cause?.kind === "delay" || shifted.cause?.kind === "closing" || shifted.cause?.kind === "fixed").toBe(true);
    const rest = replan(dazaifu(), { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(13) });
    expect(rest.diff.find((d) => d.kind === "inserted")?.reason).toContain("疲れ");
    const demo = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const b = demo.days[0].blocks.find((x) => x.planB)!;
    const rain = replan(demo, { type: "plan-b", blockIds: [b.id], cause: "rain" }, ctx, { dayIndex: 0, nowMin: hm(9) });
    expect(rain.diff.find((d) => d.kind === "replaced")?.reason).toBe("雨のため");
  });

  it("休憩を入れたことで後ろの予定がずれたら、理由は『休憩を入れたため』", () => {
    const r = replan(dazaifu(), { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(13) });
    const shifted = r.diff.filter((d) => d.kind === "shifted");
    expect(shifted.length).toBeGreaterThan(0);
    for (const d of shifted) expect(d.reason).toBe("休憩を入れたため");
  });

  it("理由の識別子と文章（テンプレート）。差し替え用の ExplanationWriter を渡せる", () => {
    expect(causeKey({ kind: "fixed", fixedId: "fx1" })).toBe("fixed:fx1");
    expect(causeKey({ kind: "closing", spotId: "dazaifu-komyozen" })).toBe("closing:dazaifu-komyozen");
    expect(causeKey({ kind: "closure", spotId: "x" })).toBe("closure:x");
    expect(causeKey({ kind: "day-end" })).toBe("day-end");
    const itin = withFixed(dazaifu(), hm(18, 5), {}, ctx);
    const id = itin.days[0].blocks.find((b) => b.fixed)!.fixed!.id;
    expect(templateWriter.explain({ kind: "fixed", fixedId: id }, ctx, itin)).toContain("最終便");
    expect(templateWriter.explain({ kind: "closing", spotId: "dazaifu-komyozen" }, ctx, itin)).toBe("「光明禅寺」の閉館（16:30）に間に合わないため");
    expect(templateWriter.explain({ kind: "closure", spotId: "dazaifu-komyozen" }, ctx, itin)).toBe("「光明禅寺」が臨時休業のため");
    expect(templateWriter.explain({ kind: "meal-window", slot: "lunch" }, ctx, itin)).toContain("11:00〜14:30");

    const custom = { explain: () => "テスト用の文章" };
    const r = replan(itin, { type: "delay", minutes: 10 }, ctx, { dayIndex: 0, nowMin: hm(9), writer: custom });
    for (const d of r.diff) expect(d.reason).toBe("テスト用の文章");
  });

  it("食事の窓に収めるための短縮は、理由が『食事の時間帯』", () => {
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
    const meal = r.diff.find((d) => d.blockId === "m" && d.kind === "shortened")!;
    expect(meal.cause?.kind).toBe("meal-window");
    expect(meal.reason).toContain("ランチの時間帯");
    expect(locateBlock(r.after, "m")!.block.skip).toBeUndefined();
  });
});

describe("フェーズ2: 生成した旅程にもモードの設定を持てる", () => {
  it("設定は旅程ごとに持つ。共有・保存の対象（settings）に入っていて、省略しても動く", () => {
    const itin: Itinerary = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    expect(itin.settings.mode).toBeUndefined();
    expect(modeOf(itin)).toBe("suggest");
    const auto: Itinerary = { ...itin, settings: { ...itin.settings, mode: "auto" } };
    expect(modeOf(auto)).toBe("auto");
    // 再計画しても設定は保たれる
    const r = replan(auto, { type: "margin", marginMin: 15 }, ctx, { dayIndex: 0 });
    expect(r.after.settings.mode).toBe("auto");
    expect(r.after.settings.marginMin).toBe(15);
  });
});
