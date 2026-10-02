import { describe, expect, it } from "vitest";
import {
  applyDelay,
  keepBlock,
  locateBlock,
  markSpotClosed,
  replaceBlockSpot,
  skipBlocks,
  suggestReplacement,
  switchBlock,
  switchBlocks,
} from "@/core/actions";
import { diffItineraries, summarizeDiff } from "@/core/diff";
import { generateItinerary } from "@/core/planner";
import { getNextAction } from "@/core/today";
import { detectRainImpact, type HourlyWeather } from "@/core/weather";
import type { Itinerary } from "@/core/types";
import { demoPrefs, hm, makeCtx, SATURDAY } from "./helpers";

const ctx = makeCtx();
const sunny: HourlyWeather[] = Array.from({ length: 24 }, (_, hour) => ({ hour, precipProb: 10 }));
const demo = (): Itinerary => generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
const settingOf = (id?: string) => (id ? ctx.spotById.get(id)!.setting : undefined);

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
    const after = switchBlocks(itin, impact.switchable.map((b) => b.id), ctx, { nowMin: hm(13) });

    for (const b of impact.switchable) {
      const nb = locateBlock(after, b.id)!.block;
      expect(nb.switched).toBe(true);
      expect(settingOf(nb.spotId)).toBe("indoor");
      expect(nb.spotId).toBe(b.planB!.spotId);
      expect(nb.planB!.spotId).toBe(b.spotId); // 元の予定に戻せる
    }
    const remaining = detectRainImpact(after.days[0], ctx, sunny, hm(13), "light-rain-ok", rain);
    expect(remaining.switchable).toHaveLength(0);

    // 時系列は崩れていない（重なり・営業時間外がない）
    const blocks = after.days[0].blocks;
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].startMin).toBeGreaterThanOrEqual(blocks[i - 1].endMin);
    expect(blocks.some((b) => b.issues?.includes("outside-hours"))).toBe(false);
    // 13時より前のブロックは変わらない
    const before = itin.days[0].blocks.filter((b) => b.startMin <= hm(13));
    for (const b of before) expect(locateBlock(after, b.id)!.block.spotId).toBe(b.spotId);
  });

  it("『1つだけ切り替える』と、ほかの屋外ブロックはそのまま", () => {
    const itin = demo();
    const rain = { startMin: hm(13), prob: 80 };
    const impact = detectRainImpact(itin.days[0], ctx, sunny, hm(13), "light-rain-ok", rain);
    const first = impact.switchable[0];
    const after = switchBlock(itin, first.id, ctx, { nowMin: hm(13) });
    expect(locateBlock(after, first.id)!.block.switched).toBe(true);
    for (const other of impact.switchable.slice(1)) {
      expect(locateBlock(after, other.id)!.block.switched).toBeFalsy();
    }
  });

  it("切り替えた予定は、もう一度切り替えると元の予定に戻る", () => {
    const itin = demo();
    const target = itin.days[0].blocks.find((b) => b.planB)!;
    const switched = switchBlock(itin, target.id, ctx);
    expect(locateBlock(switched, target.id)!.block.spotId).not.toBe(target.spotId);
    const back = switchBlock(switched, target.id, ctx);
    const restored = locateBlock(back, target.id)!.block;
    expect(restored.spotId).toBe(target.spotId);
    expect(restored.switched).toBeFalsy();
  });

  it("切替後の Plan B は別ブロックの Plan B と重複しない／旅程に重複スポットがない", () => {
    const itin = demo();
    const ids = itin.days[0].blocks.filter((b) => b.planB).map((b) => b.id);
    const after = switchBlocks(itin, ids, ctx);
    const spotIds = after.days[0].blocks.map((b) => b.spotId).filter(Boolean);
    expect(new Set(spotIds).size).toBe(spotIds.length);
  });
});

describe("雨の通知条件（雨への許容度）", () => {
  const itin = demo();
  const rain = (prob: number) => ({ startMin: hm(9), prob });
  const count = (tol: Parameters<typeof detectRainImpact>[4], prob: number) =>
    detectRainImpact(itin.days[0], ctx, sunny, hm(9), tol, rain(prob)).switchable.length;

  it("小雨ならOK: 降水確率が60%未満なら通知しない／60%以上なら通知する", () => {
    expect(count("light-rain-ok", 40)).toBe(0);
    expect(count("light-rain-ok", 80)).toBeGreaterThan(0);
  });

  it("屋外NG: 30%以上で通知。半屋外も対象になる", () => {
    expect(count("no-outdoor", 20)).toBe(0);
    expect(count("no-outdoor", 40)).toBeGreaterThanOrEqual(count("light-rain-ok", 80));
  });

  it("気にしない: 自動の通知は出さない", () => {
    expect(count("dont-care", 100)).toBe(0);
  });

  it("雨の開始時刻より前に終わる予定は対象外", () => {
    const late = detectRainImpact(itin.days[0], ctx, sunny, hm(9), "light-rain-ok", { startMin: hm(23), prob: 90 });
    expect(late.switchable).toHaveLength(0);
  });
});

describe("遅延と差分表示", () => {
  it("遅延すると、ずれた予定・余白の縮み・スキップ候補が差分に出る", () => {
    const itin = demo();
    const after = applyDelay(itin, 0, 90, hm(13), ctx);
    const diff = diffItineraries(itin, after);
    const summary = summarizeDiff(diff);
    expect(diff.length).toBeGreaterThan(0);
    expect(summary.maxShiftMin).toBeGreaterThan(0);
    expect(summary.maxShiftMin).toBeLessThanOrEqual(90);
    // 開始済みのブロックは差分に出ない
    for (const d of diff) expect(d.before.startMin).toBeGreaterThan(hm(13) - 1);
  });

  it("Plan B 切替の差分は replaced として、元と切替後のスポットを持つ", () => {
    const itin = demo();
    const target = itin.days[0].blocks.find((b) => b.planB)!;
    const after = switchBlock(itin, target.id, ctx);
    const diff = diffItineraries(itin, after);
    const item = diff.find((d) => d.blockId === target.id)!;
    expect(item.kind).toBe("replaced");
    expect(item.before.spotId).toBe(target.spotId);
    expect(item.after.spotId).toBe(target.planB!.spotId);
    expect(summarizeDiff(diff).replaced).toBe(1);
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
    const after = markSpotClosed(itin, target.spotId!, 0, hm(13), ctx);
    const nb = locateBlock(after, target.id)!.block;
    expect(nb.closed).toBe(true);
    expect(after.closedSpotIds).toContain(target.spotId);
    // 休業のスポットが他のブロックの Plan B になることはない
    for (const b of after.days[0].blocks) expect(b.planB?.spotId).not.toBe(target.spotId);

    const suggestion = suggestReplacement(after, target.id, ctx);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.spot.id).not.toBe(target.spotId);

    const replaced = replaceBlockSpot(after, target.id, suggestion!.spot.id, ctx, { nowMin: hm(13) });
    const rb = locateBlock(replaced, target.id)!.block;
    expect(rb.spotId).toBe(suggestion!.spot.id);
    expect(rb.closed).toBeFalsy();
  });

  it("休業ブロックの後ろの予定は、休業で早まることはない（計画上の時刻を保つ）", () => {
    const itin = demo();
    const idx = itin.days[0].blocks.findIndex((b) => b.spotId && b.startMin > hm(13));
    const after = markSpotClosed(itin, itin.days[0].blocks[idx].spotId!, 0, hm(13), ctx);
    for (let i = idx + 1; i < itin.days[0].blocks.length; i++) {
      const b = itin.days[0].blocks[i];
      if (b.label === "buffer") continue;
      expect(after.days[0].blocks[i].startMin).toBeGreaterThanOrEqual(b.startMin);
    }
  });

  it("スキップした予定は時間を消費せず、「それでも行く」で候補から外せる", () => {
    const itin = demo();
    const opt = itin.days[0].blocks.find((b) => b.label === "optional")!;
    const skipped = skipBlocks(itin, 0, [opt.id], hm(9), ctx);
    expect(locateBlock(skipped, opt.id)!.block.skip).toBe("skipped");
    const kept = keepBlock(skipped, 0, opt.id, hm(9), ctx);
    const kb = locateBlock(kept, opt.id)!.block;
    expect(kb.skip).toBeUndefined();
    expect(kb.keepAnyway).toBe(true);
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
    const skipped = skipBlocks(itin, 0, [second.id], 0, ctx).days[0];
    const next = getNextAction(skipped, ctx, firstSpot.endMin + 1);
    expect(next.next?.id).not.toBe(second.id);
  });
});
