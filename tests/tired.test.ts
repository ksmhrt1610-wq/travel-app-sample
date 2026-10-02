import { describe, expect, it } from "vitest";
import { locateBlock } from "@/core/actions";
import { haversineM } from "@/core/geo";
import { describeEvent, replan, REST_MINUTES } from "@/core/replan";
import { isInert, placeOf } from "@/core/schedule";
import { dayWalking, suggestRestForWalking, WALK_LIMIT_KM } from "@/core/walking";
import type { Itinerary } from "@/core/types";
import { dazaifuDay, fixedEvent, fixedSlack, hm, makeCtx, makeDay, withFixed, wrapItinerary } from "./helpers";

const ctx = makeCtx();
const spotOf = (id?: string) => (id ? ctx.spotById.get(id)! : undefined);

/** 博多と大濠を行き来するジグザグの1日（まだ誰も出発していない） */
function zigzag(): Itinerary {
  const day = makeDay(
    [
      { id: "a", spotId: "hakata-kushida", start: hm(10), end: hm(10, 30) },
      { id: "b", label: "must", spotId: "ohori-maizuru", start: hm(11, 15), end: hm(12, 15) },
      { id: "c", spotId: "hakata-machiya", start: hm(13), end: hm(13, 45) },
      { id: "d", spotId: "ohori-teien", start: hm(14, 45), end: hm(15, 30) },
      { id: "e", label: "optional", spotId: "ohori-tsutaya", start: hm(15, 50), end: hm(16, 50) },
    ],
    ctx,
  );
  return wrapItinerary(day);
}

/** 道のりの合計（残りの順番で、移動の道のりを足したもの） */
function pathLength(itin: Itinerary): number {
  const day = itin.days[0];
  let at: { lat: number; lng: number } = day.origin;
  let total = 0;
  for (const b of day.blocks) {
    if (isInert(b)) continue;
    const p = placeOf(b, ctx);
    if (!p) continue;
    total += ctx.travel(at, p).distanceM;
    at = p;
  }
  return total;
}

describe("疲れた: 少し休みたい", () => {
  const itin = () => withFixed(wrapItinerary(dazaifuDay(ctx)), hm(17), {}, ctx);

  it("次の予定の前に、近くの屋内カフェで30分の休憩を挟む", () => {
    const base = zigzag();
    // 大濠公園エリアの予定（舞鶴公園）の最中に押した
    const r = replan(base, { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(11, 40) });
    const rest = r.after.days[0].blocks.find((b) => b.label === "rest")!;
    expect(rest).toBeTruthy();
    expect(rest.durationMin).toBe(REST_MINUTES.light);
    expect(rest.endMin - rest.startMin).toBe(30);
    const spot = spotOf(rest.spotId)!;
    expect(spot.setting).toBe("indoor");
    expect(spot.category === "cafe" || spot.tags?.includes("cafe")).toBe(true);
    // 直前の場所から800m以内
    const blocks = r.after.days[0].blocks;
    const restIdx = blocks.indexOf(rest);
    const prev = placeOf(blocks[restIdx - 1], ctx)!;
    expect(haversineM(prev, spot)).toBeLessThanOrEqual(800);
    // 進行中の予定は動かず、休憩は進行中の予定のあと・次の予定の前に入る
    expect(blocks[restIdx - 1].id).toBe("b");
    expect(blocks[restIdx - 1].startMin).toBeLessThanOrEqual(hm(11, 40));
    expect(blocks[restIdx + 1].id).toBe("c");
  });

  it("近くに休憩できる屋内の場所がなければ、場所を決めない休憩を入れ、その旨を伝える", () => {
    // 観世音寺の周辺（800m以内）には、屋内の休める場所がない
    const day = makeDay(
      [
        { id: "a", spotId: "dazaifu-kanzeonji", start: hm(10), end: hm(10, 30) },
        { id: "b", spotId: "dazaifu-komyozen", start: hm(11), end: hm(11, 30) },
      ],
      ctx,
    );
    const r = replan(wrapItinerary(day), { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(10, 15) });
    const rest = r.after.days[0].blocks.find((b) => b.label === "rest")!;
    expect(rest.spotId).toBeUndefined();
    expect(rest.endMin - rest.startMin).toBe(30);
    expect(r.notes.join("")).toContain("休憩できる屋内の場所が見つからなかった");
  });

  it("カフェに限らず、博物館・商業施設などの屋内の休める場所も休憩場所になる", () => {
    // 博多の櫛田神社（屋外）の近くには、休める博物館・商業施設があり、カフェでなくても選ばれる
    const r = replan(zigzag(), { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(10, 15) });
    const rest = r.after.days[0].blocks.find((b) => b.label === "rest")!;
    const spot = spotOf(rest.spotId)!;
    expect(spot).toBeTruthy();
    expect(spot.restable).toBe(true);
    expect(spot.setting).toBe("indoor");
  });

  it("Must と固定時刻は守る。休憩を入れても固定時刻に間に合う", () => {
    const r = replan(itin(), { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(13, 20) });
    expect(r.feasible).toBe(true);
    expect(fixedSlack(r.after, ctx)).toBeGreaterThanOrEqual(0);
    for (const id of ["s1", "s2"]) expect(locateBlock(r.after, id)!.block.skip).toBeUndefined();
    expect(r.after.days[0].blocks.find((b) => b.fixed)!.startMin).toBe(hm(17));
  });

  it("休憩は保護される: そのあと時間が足りなくなっても、Optional が先に削られ、休憩は短くされない", () => {
    const first = replan(itin(), { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(13, 20) });
    const rest = first.after.days[0].blocks.find((b) => b.label === "rest")!;
    const r = replan(first.after, { type: "delay", minutes: 60 }, ctx, { dayIndex: 0, nowMin: hm(13, 30) });
    const after = locateBlock(r.after, rest.id)!.block;
    expect(after.skip).toBeUndefined();
    expect(after.durationMin).toBe(30);
    expect(r.steps.filter((s) => s.phase === "reduce").every((s) => s.blockIds.every((id) => id !== rest.id))).toBe(true);
  });

  it("グループの中の誰が押したかは表示しない（メンバーの1人が休憩を希望）", () => {
    const base = zigzag();
    for (const level of ["light", "heavy"] as const) {
      const event = { type: "tired", level } as const;
      const title = describeEvent(event, ctx, base);
      expect(title).toContain("メンバーの1人が休憩を希望");
      for (const m of base.members) expect(title).not.toContain(m.name);
      const r = replan(base, event, ctx, { dayIndex: 0, nowMin: hm(9) });
      expect(r.notes).toContain("メンバーの1人が休憩を希望しています。");
      const serialized = JSON.stringify(r.event);
      for (const m of base.members) expect(serialized).not.toContain(m.name);
    }
  });
});

describe("疲れた: かなり疲れた", () => {
  const now = hm(9, 30);
  const run = () => replan(zigzag(), { type: "tired", level: "heavy" }, ctx, { dayIndex: 0, nowMin: now });

  it("休憩を60分挟み、残りの Optional を削る。Must は残る", () => {
    const r = run();
    const blocks = r.after.days[0].blocks;
    const rest = blocks.find((b) => b.label === "rest")!;
    expect(rest.durationMin).toBe(REST_MINUTES.heavy);
    expect(rest.endMin - rest.startMin).toBe(60);
    expect(locateBlock(r.after, "e")!.block.skip).toBe("skipped"); // Optional
    expect(locateBlock(r.after, "b")!.block.skip).toBeUndefined(); // Must
    expect(r.notes.join("")).toContain("Must・食事と固定時刻は守ります");
  });

  it("残りの総歩行距離が減る", () => {
    const r = run();
    expect(r.walkingAfterM).toBeLessThan(r.walkingBeforeM);
    // 旅程全体で見ても、組み直し後の合計は減っている
    const pace = r.before.prefs.pace;
    expect(dayWalking(r.after.days[0], ctx, pace).totalM).toBeLessThan(dayWalking(r.before.days[0], ctx, pace).totalM);
  });

  it("スポットを近い順に並べ直して、移動の道のりが短くなる（博多と大濠がまとまる）", () => {
    const r = run();
    expect(r.steps.some((s) => s.kind === "reorder")).toBe(true);
    expect(pathLength(r.after)).toBeLessThan(pathLength(r.before));
    const areas = r.after.days[0].blocks
      .filter((b) => b.spotId && !b.skip && b.label !== "rest")
      .map((b) => spotOf(b.spotId)!.area);
    // エリアの切り替わりは1回以下（ジグザグではない）
    const changes = areas.filter((a, i) => i > 0 && a !== areas[i - 1]).length;
    expect(changes).toBeLessThanOrEqual(1);
  });

  it("徒歩20分以上かかる移動には、公共交通・タクシーを提案する", () => {
    const r = run();
    expect(r.travelSuggestions.length).toBeGreaterThan(0);
    for (const s of r.travelSuggestions) {
      expect(s.walkMin).toBeGreaterThanOrEqual(20);
      expect(s.transitMin).toBeLessThan(s.walkMin);
      expect(s.taxiMin).toBeLessThan(s.walkMin);
    }
  });

  it("以降の移動は徒歩を短く見積もる（600m超は公共交通）", () => {
    const r = run();
    expect(r.after.days[0].lowWalking).toBe(true);
    for (const b of r.after.days[0].blocks) {
      if (b.travelMode === "walk") expect(b.travelDistanceM ?? 0).toBeLessThanOrEqual(600);
    }
  });

  it("Must と固定時刻を守ったまま、最終便に間に合う", () => {
    const itin = withFixed(zigzag(), hm(19), { place: { name: "博多駅", lat: 33.5898, lng: 130.4207 } }, ctx);
    const r = replan(itin, { type: "tired", level: "heavy" }, ctx, { dayIndex: 0, nowMin: now });
    expect(r.feasible).toBe(true);
    expect(fixedSlack(r.after, ctx)).toBeGreaterThanOrEqual(0);
    expect(locateBlock(r.after, "b")!.block.skip).toBeUndefined();
  });

  it("少し休みたいより、かなり疲れたのほうが休憩が長く、歩行が少ない", () => {
    const light = replan(zigzag(), { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: now });
    const heavy = run();
    expect(heavy.after.days[0].blocks.find((b) => b.label === "rest")!.durationMin).toBeGreaterThan(
      light.after.days[0].blocks.find((b) => b.label === "rest")!.durationMin,
    );
    expect(heavy.walkingAfterM).toBeLessThanOrEqual(light.walkingAfterM);
  });
});

describe("歩行距離の累計と休憩の提案", () => {
  it("ペースごとの目安は ゆったり5km・普通8km・詰め込み12km", () => {
    expect(WALK_LIMIT_KM).toEqual({ relaxed: 5, normal: 8, packed: 12 });
    expect(dayWalking(zigzag().days[0], ctx, "relaxed").limitM).toBe(5000);
    expect(dayWalking(zigzag().days[0], ctx, "normal").limitM).toBe(8000);
    expect(dayWalking(zigzag().days[0], ctx, "packed").limitM).toBe(12000);
  });

  it("現在時刻までの歩行距離は累計され、時間とともに増えて、最後に合計と一致する", () => {
    const day = zigzag().days[0];
    const samples = [hm(9), hm(10, 15), hm(12), hm(14), hm(17, 30)].map((t) => dayWalking(day, ctx, "normal", t));
    for (let i = 1; i < samples.length; i++) expect(samples[i].doneM).toBeGreaterThanOrEqual(samples[i - 1].doneM);
    expect(samples[0].doneM).toBe(0);
    const last = samples.at(-1)!;
    expect(last.doneM).toBe(last.totalM);
    expect(last.remainingM).toBe(0);
    for (const s of samples) expect(s.doneM + s.remainingM).toBe(s.totalM);
  });

  it("目安を超えそうなときは「次の予定の前に休憩を入れますか？」の提案が出る", () => {
    const day = makeDay(
      [
        { id: "p", spotId: "ohori-park", start: hm(10), end: hm(11) },
        { id: "q", spotId: "ohori-maizuru", start: hm(11, 10), end: hm(12, 10) },
        { id: "r", spotId: "ohori-teien", start: hm(12, 20), end: hm(13, 5) },
      ],
      ctx,
    );
    const s = suggestRestForWalking(day, ctx, "relaxed", hm(11, 30));
    expect(s).not.toBeNull();
    expect(s!.beforeBlockId).toBe("r");
    expect(s!.projectedM).toBeGreaterThan(s!.limitM);
    // 目安に余裕があれば出さない（詰め込みは12km）
    expect(suggestRestForWalking(day, ctx, "packed", hm(11, 30))).toBeNull();
  });

  it("提案を受けて休憩を入れると、同じ予定の前では提案されなくなる", () => {
    const itin = wrapItinerary(
      makeDay(
        [
          { id: "p", spotId: "ohori-park", start: hm(10), end: hm(11) },
          { id: "q", spotId: "ohori-maizuru", start: hm(11, 10), end: hm(12, 10) },
          { id: "r", spotId: "ohori-teien", start: hm(12, 20), end: hm(13, 5) },
        ],
        ctx,
      ),
      { ...zigzag().prefs, pace: "relaxed" },
    );
    const s = suggestRestForWalking(itin.days[0], ctx, "relaxed", hm(11, 30))!;
    const r = replan(itin, { type: "tired", level: "light", source: "walk-limit" }, ctx, { dayIndex: 0, nowMin: hm(11, 30) });
    expect(r.notes.join("")).toContain("歩行距離が目安を超えそう");
    expect(r.notes).not.toContain("メンバーの1人が休憩を希望しています。");
    expect(r.after.days[0].blocks.some((b) => b.label === "rest")).toBe(true);
    expect(suggestRestForWalking(r.after.days[0], ctx, "relaxed", hm(11, 30))).toBeNull();
    expect(s.beforeBlockId).toBe("r");
  });

  it("休憩・固定時刻は歩行距離に数えない（座って過ごす）", () => {
    const itin = withFixed(wrapItinerary(dazaifuDay(ctx)), hm(17), {}, ctx);
    const withRest = replan(itin, { type: "tired", level: "light" }, ctx, { dayIndex: 0, nowMin: hm(13, 20) }).after;
    const rest = withRest.days[0].blocks.find((b) => b.label === "rest")!;
    const w = dayWalking({ ...withRest.days[0], blocks: [rest] }, ctx, "normal");
    expect(w.totalM).toBe(0);
    void fixedEvent;
  });
});
