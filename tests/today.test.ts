import { describe, expect, it } from "vitest";
import { locateBlock, suggestReplacement } from "@/core/actions";
import { diffItineraries, summarizeDiff } from "@/core/diff";
import { generateItinerary } from "@/core/planner";
import { replan, type ReplanEvent } from "@/core/replan";
import { getNextAction } from "@/core/today";
import { detectRainImpact, exceedsRainRule, RAIN_RULES, RAIN_STRENGTH, rainMm, type HourlyWeather, type RainStrength } from "@/core/weather";
import type { Itinerary } from "@/core/types";
import { demoPrefs, hm, makeCtx, SATURDAY } from "./helpers";

const ctx = makeCtx();
const sunny: HourlyWeather[] = Array.from({ length: 24 }, (_, hour) => ({ hour, precipProb: 10 }));
const demo = (): Itinerary => generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
const settingOf = (id?: string) => (id ? ctx.spotById.get(id)!.setting : undefined);

/** 再計画エンジンの提案をそのまま確定した旅程 */
const apply = (itin: Itinerary, event: ReplanEvent, nowMin?: number) => replan(itin, event, ctx, { dayIndex: 0, nowMin }).after;

describe("デモシナリオ: 雨 → 屋外予定を切り替える", () => {
  it("13時に雨が降り出すと、残りの屋外ブロックが影響を受ける（デモが成立する）", () => {
    const itin = demo();
    const impact = detectRainImpact(itin.days[0], ctx, sunny, hm(13), "light-rain-ok", { startMin: hm(13), prob: 80 });
    expect(impact.switchable.length).toBeGreaterThanOrEqual(1);
    for (const b of impact.switchable) {
      expect(settingOf(b.spotId)).toBe("outdoor");
      expect(b.endMin).toBeGreaterThan(hm(13));
      expect(b.planB).toBeTruthy();
    }
  });

  it("『すべて切り替える』で、残りの屋外ブロックがすべて屋内になり、通知も消える", () => {
    const itin = demo();
    const rain = { startMin: hm(13), prob: 80 };
    const impact = detectRainImpact(itin.days[0], ctx, sunny, hm(13), "light-rain-ok", rain);
    const ids = impact.switchable.map((b) => b.id);
    const result = replan(itin, { type: "plan-b", blockIds: ids }, ctx, { dayIndex: 0, nowMin: hm(13) });
    const after = result.after;

    for (const b of impact.switchable) {
      const nb = locateBlock(after, b.id)!.block;
      expect(nb.switched).toBe(true);
      expect(settingOf(nb.spotId)).toBe("indoor");
      expect(nb.spotId).toBe(b.planB!.spotId);
      expect(nb.planB!.spotId).toBe(b.spotId); // 元の予定に戻せる
    }
    expect(detectRainImpact(after.days[0], ctx, sunny, hm(13), "light-rain-ok", rain).switchable).toHaveLength(0);

    const blocks = after.days[0].blocks;
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].startMin).toBeGreaterThanOrEqual(blocks[i - 1].endMin);
    expect(blocks.some((b) => b.issues?.includes("outside-hours"))).toBe(false);
    for (const b of itin.days[0].blocks.filter((x) => x.startMin <= hm(13))) expect(locateBlock(after, b.id)!.block.spotId).toBe(b.spotId);
    // 提案は確定するまで元の旅程を変えない
    expect(result.before).toBe(itin);
  });

  it("『1つだけ切り替える』と、ほかの屋外ブロックはそのまま", () => {
    const itin = demo();
    const impact = detectRainImpact(itin.days[0], ctx, sunny, hm(13), "light-rain-ok", { startMin: hm(13), prob: 80 });
    const first = impact.switchable[0];
    const after = apply(itin, { type: "plan-b", blockIds: [first.id] }, hm(13));
    expect(locateBlock(after, first.id)!.block.switched).toBe(true);
    for (const other of impact.switchable.slice(1)) expect(locateBlock(after, other.id)!.block.switched).toBeFalsy();
  });

  it("切り替えた予定は、もう一度切り替えると元の予定に戻る", () => {
    const itin = demo();
    const target = itin.days[0].blocks.find((b) => b.planB)!;
    const switched = apply(itin, { type: "plan-b", blockIds: [target.id] });
    expect(locateBlock(switched, target.id)!.block.spotId).not.toBe(target.spotId);
    const restored = locateBlock(apply(switched, { type: "plan-b", blockIds: [target.id] }), target.id)!.block;
    expect(restored.spotId).toBe(target.spotId);
    expect(restored.switched).toBeFalsy();
  });

  it("切替後の Plan B は別ブロックの Plan B と重複しない／旅程に重複スポットがない", () => {
    const itin = demo();
    const ids = itin.days[0].blocks.filter((b) => b.planB).map((b) => b.id);
    const after = apply(itin, { type: "plan-b", blockIds: ids });
    const spotIds = after.days[0].blocks.map((b) => b.spotId).filter(Boolean);
    expect(new Set(spotIds).size).toBe(spotIds.length);
  });
});

describe("雨の通知条件（雨への許容度と雨の強さ）", () => {
  const itin = demo();
  const rain = (strength: RainStrength) => ({
    startMin: hm(9),
    prob: RAIN_STRENGTH[strength].prob,
    mmPerHour: RAIN_STRENGTH[strength].mmPerHour,
    strength,
  });
  const count = (tol: Parameters<typeof detectRainImpact>[4], strength: RainStrength) =>
    detectRainImpact(itin.days[0], ctx, sunny, hm(9), tol, rain(strength)).switchable.length;

  it("基準は定数1か所にまとまっている（屋外NG 0.5mm/h または30%・小雨OK 3mm/h・気にしない 10mm/h）", () => {
    expect(RAIN_RULES["no-outdoor"]).toEqual({ mmPerHour: 0.5, precipProb: 30 });
    expect(RAIN_RULES["light-rain-ok"].mmPerHour).toBe(3);
    expect(RAIN_RULES["dont-care"].mmPerHour).toBe(10);
  });

  it("屋外NG: 小雨（1mm/h）でも通知する。降水確率が30%以上でも、雨量が少なくても通知する", () => {
    expect(count("no-outdoor", "light")).toBeGreaterThan(0);
    expect(exceedsRainRule(RAIN_RULES["no-outdoor"], 30, 0)).toBe(true);
    expect(exceedsRainRule(RAIN_RULES["no-outdoor"], 20, 0.4)).toBe(false);
    expect(exceedsRainRule(RAIN_RULES["no-outdoor"], 10, 0.5)).toBe(true);
  });

  it("小雨ならOK: 小雨（1mm/h）は通知せず、本降り（5mm/h）から通知する。降水確率だけでは通知しない", () => {
    expect(count("light-rain-ok", "light")).toBe(0);
    expect(count("light-rain-ok", "moderate")).toBeGreaterThan(0);
    expect(exceedsRainRule(RAIN_RULES["light-rain-ok"], 100, 2.9)).toBe(false);
  });

  it("気にしない: 強い雨（15mm/h）のときだけ提案する", () => {
    expect(count("dont-care", "light")).toBe(0);
    expect(count("dont-care", "moderate")).toBe(0);
    expect(count("dont-care", "heavy")).toBeGreaterThan(0);
  });

  it("強い雨ほど、通知される許容度の範囲が広い（屋外NG ⊇ 小雨OK ⊇ 気にしない）", () => {
    for (const s of ["light", "moderate", "heavy"] as RainStrength[]) {
      expect(count("no-outdoor", s)).toBeGreaterThanOrEqual(count("light-rain-ok", s));
      expect(count("light-rain-ok", s)).toBeGreaterThanOrEqual(count("dont-care", s));
    }
  });

  it("雨量が無い古い保存データ（降水確率だけ）でも、降水確率から雨量を見積もって判定できる", () => {
    expect(rainMm({ startMin: 0, prob: 95 })).toBe(15);
    expect(rainMm({ startMin: 0, prob: 80 })).toBe(5);
    expect(rainMm({ startMin: 0, prob: 60 })).toBe(1);
    expect(rainMm({ startMin: 0, prob: 20 })).toBeLessThan(0.5);
  });

  it("雨の開始時刻より前に終わる予定は対象外", () => {
    const late = detectRainImpact(itin.days[0], ctx, sunny, hm(9), "light-rain-ok", { startMin: hm(23), prob: 90, mmPerHour: 15 });
    expect(late.switchable).toHaveLength(0);
  });
});

describe("遅延と差分表示", () => {
  it("遅延すると、ずれた予定・余白の縮みが差分に出る。開始済みの予定は動かない", () => {
    const itin = demo();
    const r = replan(itin, { type: "delay", minutes: 90 }, ctx, { dayIndex: 0, nowMin: hm(13) });
    expect(r.diff.length).toBeGreaterThan(0);
    const summary = summarizeDiff(r.diff);
    expect(summary.maxShiftMin).toBeGreaterThan(0);
    expect(summary.maxShiftMin).toBeLessThanOrEqual(90);
    for (const d of r.diff) expect(d.before.startMin).toBeGreaterThan(hm(13) - 1);
    // diff は旅程どうしの比較と一致する
    expect(r.diff.map(({ cause: _c, reason: _r, ...rest }) => rest)).toEqual(diffItineraries(itin, r.after));
  });

  it("Plan B 切替の差分は replaced として、元と切替後のスポットを持つ", () => {
    const itin = demo();
    const target = itin.days[0].blocks.find((b) => b.planB)!;
    const r = replan(itin, { type: "plan-b", blockIds: [target.id] }, ctx, { dayIndex: 0 });
    const item = r.diff.find((d) => d.blockId === target.id)!;
    expect(item.kind).toBe("replaced");
    expect(item.before.spotId).toBe(target.spotId);
    expect(item.after.spotId).toBe(target.planB!.spotId);
    expect(summarizeDiff(r.diff).replaced).toBe(1);
  });

  it("変更がなければ差分は空", () => {
    const itin = demo();
    expect(diffItineraries(itin, itin)).toEqual([]);
  });
});

describe("臨時休業とスキップ", () => {
  it("臨時休業にすると、該当ブロックは休業扱いになり、代わりの候補が出る", () => {
    const itin = demo();
    const target = itin.days[0].blocks.find((b) => b.spotId && b.startMin > hm(13))!;
    const after = apply(itin, { type: "closure", spotId: target.spotId! }, hm(13));
    const nb = locateBlock(after, target.id)!.block;
    expect(nb.closed).toBe(true);
    expect(after.closedSpotIds).toContain(target.spotId);
    for (const b of after.days[0].blocks) expect(b.planB?.spotId).not.toBe(target.spotId);

    const suggestion = suggestReplacement(after, target.id, ctx);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.spot.id).not.toBe(target.spotId);

    const replaced = apply(itin, { type: "closure", spotId: target.spotId!, replacementSpotId: suggestion!.spot.id }, hm(13));
    const rb = locateBlock(replaced, target.id)!.block;
    expect(rb.spotId).toBe(suggestion!.spot.id);
    expect(rb.closed).toBeFalsy();
  });

  it("休業ブロックの後ろの予定は、休業で早まることはない（計画上の時刻を保つ）", () => {
    const itin = demo();
    const idx = itin.days[0].blocks.findIndex((b) => b.spotId && b.startMin > hm(13));
    const after = apply(itin, { type: "closure", spotId: itin.days[0].blocks[idx].spotId! }, hm(13));
    for (let i = idx + 1; i < itin.days[0].blocks.length; i++) {
      const b = itin.days[0].blocks[i];
      if (b.label === "buffer") continue;
      expect(after.days[0].blocks[i].startMin).toBeGreaterThanOrEqual(b.startMin);
    }
  });

  it("スキップした予定は時間を消費せず、取り消すと元に戻る", () => {
    const itin = demo();
    const opt = itin.days[0].blocks.find((b) => b.label === "optional")!;
    const skipped = apply(itin, { type: "skip", blockIds: [opt.id] });
    expect(locateBlock(skipped, opt.id)!.block.skip).toBe("skipped");
    const restored = apply(skipped, { type: "restore", blockId: opt.id });
    expect(locateBlock(restored, opt.id)!.block.skip).toBeUndefined();
  });
});

describe("次にやること", () => {
  const itin = demo();
  const day = itin.days[0];
  const firstSpot = day.blocks.find((b) => b.spotId)!;

  it("最初の予定の前: 出発までの残り時間を出す（出発 = 開始 − 移動時間）", () => {
    const now = firstSpot.startMin - firstSpot.travelMin - 25;
    const next = getNextAction(day, ctx, now);
    expect(next.state).toBe("before-start");
    expect(next.next?.id).toBe(firstSpot.id);
    expect(next.departAtMin).toBe(firstSpot.startMin - firstSpot.travelMin);
    expect(next.minutesUntilDeparture).toBe(25);
  });

  it("予定の最中は、いまの予定と次の予定の出発までの時間を出す", () => {
    const now = firstSpot.startMin + 10;
    const next = getNextAction(day, ctx, now);
    expect(next.state).toBe("in-progress");
    expect(next.current?.id).toBe(firstSpot.id);
    expect(next.next && next.next.startMin > now).toBe(true);
  });

  it("出発時刻を過ぎて移動中なら、到着までの残りを出す", () => {
    const next = getNextAction(day, ctx, firstSpot.startMin - 1);
    expect(next.minutesUntilDeparture).toBe(0);
    expect(next.minutesUntilArrival).toBe(1);
  });

  it("最後の予定が終わったら finished", () => {
    expect(getNextAction(day, ctx, day.blocks.at(-1)!.endMin + 1).state).toBe("finished");
  });

  it("スキップした予定は『次の予定』にならない", () => {
    const second = day.blocks.filter((b) => b.spotId)[1];
    const skipped = apply(itin, { type: "skip", blockIds: [second.id] }).days[0];
    const next = getNextAction(skipped, ctx, firstSpot.endMin + 1);
    expect(next.next?.id).not.toBe(second.id);
  });
});
