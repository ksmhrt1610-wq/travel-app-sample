import { describe, expect, it } from "vitest";
import { replan } from "@/core/replan";
import { generateItinerary } from "@/core/planner";
import { buildShareUrl, decodeItinerary, encodeItinerary } from "@/core/share";
import { demoPrefs, hm, makeCtx, SATURDAY } from "./helpers";

const ctx = makeCtx();

describe("共有URL", () => {
  it("エンコードしたトークンから、同じ旅程が再現できる（日帰り）", () => {
    const itin = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const decoded = decodeItinerary(encodeItinerary(itin), ctx)!;
    expect(decoded).not.toBeNull();
    expect(decoded.startDate).toBe(itin.startDate);
    expect(decoded.prefs).toEqual(itin.prefs);
    expect(decoded.days).toHaveLength(itin.days.length);
    decoded.days.forEach((d, i) => {
      const o = itin.days[i];
      expect(d.date).toBe(o.date);
      expect(d.blocks.map((b) => [b.label, b.spotId, b.startMin, b.endMin, b.planB?.spotId ?? null])).toEqual(
        o.blocks.map((b) => [b.label, b.spotId, b.startMin, b.endMin, b.planB?.spotId ?? null]),
      );
    });
  });

  it("1泊2日・Plan B 切替済み・遅延後の状態も再現できる", () => {
    let itin = generateItinerary({ prefs: { ...demoPrefs, duration: "overnight", mustSpotIds: ["dazaifu-shrine"] }, ctx, startDate: SATURDAY });
    const target = itin.days[0].blocks.find((b) => b.planB);
    if (target) itin = replan(itin, { type: "plan-b", blockIds: [target.id] }, ctx, { dayIndex: 0 }).after;
    itin = replan(itin, { type: "delay", minutes: 40 }, ctx, { dayIndex: 0, nowMin: hm(9, 30) }).after;
    const decoded = decodeItinerary(encodeItinerary(itin), ctx)!;
    expect(decoded.days).toHaveLength(2);
    expect(decoded.days[0].blocks.map((b) => [b.spotId, b.startMin, b.switched ?? false, b.skip ?? null])).toEqual(
      itin.days[0].blocks.map((b) => [b.spotId, b.startMin, b.switched ?? false, b.skip ?? null]),
    );
    expect(decoded.days[1].origin.name).toBe(itin.days[1].origin.name);
  });

  it("URLに載る文字だけでできている（base64url）", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, duration: "overnight", pace: "packed" }, ctx, startDate: SATURDAY });
    const url = buildShareUrl("https://example.test", itin)!;
    expect(url).toMatch(/^https:\/\/example\.test\/share\?s=[A-Za-z0-9_-]+$/);
    expect(url.length).toBeLessThan(6000);
  });

  it("壊れたトークンや存在しないスポットは null（落ちない）", () => {
    expect(decodeItinerary("", ctx)).toBeNull();
    expect(decodeItinerary("not-a-token!!", ctx)).toBeNull();
    expect(decodeItinerary("e30", ctx)).toBeNull();
    const itin = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const token = encodeItinerary(itin);
    expect(decodeItinerary(token.slice(0, token.length - 20), ctx)).toBeNull();
    const withoutSpots = makeCtx([]);
    expect(decodeItinerary(token, withoutSpots)).toBeNull();
  });
});
