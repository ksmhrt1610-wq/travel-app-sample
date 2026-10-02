import { describe, expect, it } from "vitest";
import { locateBlock } from "@/core/actions";
import { currentLocation, DETOUR_RADIUS_M, nearbyOpenSpots } from "@/core/detour";
import { haversineM } from "@/core/geo";
import { attachPlanBs } from "@/core/planb";
import { decideApply, classifyChange } from "@/core/policy";
import { replan, type ReplanEvent } from "@/core/replan";
import { FREE_STOP_TRAVEL_MIN, isStarted, recomputeDay } from "@/core/schedule";
import { earlyProgress, EARLY_SUGGEST_MIN, suggestForEarly } from "@/core/suggest";
import { getNextAction } from "@/core/today";
import { detectHeatImpact, heatLevelOf, HEAT_RULES, wbgtAt, type HourlyWeather } from "@/core/weather";
import type { Itinerary } from "@/core/types";
import { demoPrefs, fixedSlack, hm, makeCtx, makeDay, withFixed, wrapItinerary } from "./helpers";

const ctx = makeCtx();

/**
 * 天神の4件。a→b→c→d の予定の開始は、前の終了 + 移動時間ちょうど（余裕なし）にして、
 * 遅れがそのまま後ろにずれることを確かめられるようにする。
 */
function tightDay(): Itinerary {
  const spots = ["tenjin-rec", "tenjin-chikagai", "tenjin-acros", "tenjin-gogo"];
  const stay = [45, 40, 30, 20];
  let t = hm(10);
  let prev: string | undefined;
  const specs = spots.map((spotId, i) => {
    if (prev) t += ctx.travel(ctx.spotById.get(prev)!, ctx.spotById.get(spotId)!).minutes;
    else t += ctx.travel({ lat: 33.5898, lng: 130.4207 }, ctx.spotById.get(spotId)!).minutes;
    const start = t;
    t += stay[i];
    prev = spotId;
    return { id: "abcd"[i], spotId, start, end: t };
  });
  return wrapItinerary(makeDay(specs, ctx));
}

const progress = (itin: Itinerary, blockId: string, kind: "arrived" | "departed", atMin: number) =>
  replan(itin, { type: "progress", blockId, kind, atMin }, ctx, { dayIndex: 0, nowMin: atMin });

describe("フェーズ3: 実際の進み具合（着いた・出発した）", () => {
  it("開始済みの判定は、実績があれば実績を優先し、なければ時刻で判定する", () => {
    const itin = tightDay();
    const a = itin.days[0].blocks[0];
    expect(isStarted(a, undefined)).toBe(false);
    expect(isStarted(a, a.startMin)).toBe(true); // 時刻による判定
    expect(isStarted(a, a.startMin - 1)).toBe(false);
    expect(isStarted({ ...a, actualStartMin: a.startMin + 15 }, a.startMin - 60)).toBe(true); // 実績があれば、時刻に関係なく開始済み
    expect(isStarted({ ...a, actualEndMin: a.endMin }, undefined)).toBe(true);
  });

  it("「出発した」を予定より20分遅く押すと、後ろが20分ずれる（余裕のない旅程）", () => {
    const itin = tightDay();
    const [a, b, c] = itin.days[0].blocks;
    const r = progress(itin, "a", "departed", a.endMin + 20);
    const after = r.after.days[0].blocks;
    expect(after[0].actualEndMin).toBe(a.endMin + 20);
    expect(after[0].endMin).toBe(a.endMin + 20);
    expect(after[1].startMin - b.startMin).toBe(20);
    expect(after[2].startMin - c.startMin).toBeGreaterThanOrEqual(0);
    expect(r.feasible).toBe(true);
    // 遅れは「遅れ」として理由が付く
    const shifted = r.diff.filter((d) => d.kind === "shifted");
    expect(shifted.length).toBeGreaterThan(0);
    for (const d of r.diff) expect(d.cause?.kind === "delay" || d.cause?.kind === "progress").toBe(true);
    expect(r.diff.find((d) => d.blockId === "b")?.cause?.kind).toBe("delay");
  });

  it("余白があれば、遅れは余白が吸収する。小さな遅れ（10分未満）は『進み具合』として反映する", () => {
    // b の開始は、余白（40分）のあと + 移動時間
    const bStart = hm(11, 40) + ctx.travel(ctx.spotById.get("tenjin-rec")!, ctx.spotById.get("tenjin-chikagai")!).minutes;
    const day = makeDay(
      [
        { id: "a", spotId: "tenjin-rec", start: hm(10), end: hm(11) },
        { id: "buf", start: hm(11), end: hm(11, 40) },
        { id: "b", spotId: "tenjin-chikagai", start: bStart, end: bStart + 45 },
      ],
      ctx,
    );
    const itin = wrapItinerary(day, { ...demoPrefs, pace: "normal" }); // 余白の下限は10分
    const r = progress(itin, "a", "departed", hm(11, 25));
    const buf = locateBlock(r.after, "buf")!.block;
    expect(buf.endMin - buf.startMin).toBe(15); // 余白が 40分 → 15分に縮んで、25分の遅れを吸収
    expect(locateBlock(r.after, "b")!.block.startMin).toBe(bStart); // 後ろは動かない
    const small = progress(itin, "a", "departed", hm(11, 5));
    expect(small.diff.find((d) => d.blockId === "a")?.cause?.kind).toBe("progress");
  });

  it("「着いた」を遅く押すと、そこから予定の滞在時間ぶんが始まり、後ろがずれる。手前の予定は終わったことになる", () => {
    const itin = tightDay();
    const [a, b, c] = itin.days[0].blocks;
    const r = progress(itin, "b", "arrived", b.startMin + 20);
    const after = r.after.days[0].blocks;
    expect(after[1].actualStartMin).toBe(b.startMin + 20);
    expect(after[1].startMin).toBe(b.startMin + 20);
    expect(after[1].endMin).toBe(b.startMin + 20 + b.durationMin);
    expect(after[0].actualEndMin).toBeDefined(); // a は、b に着く前に終わっている
    expect(after[0].endMin).toBeLessThanOrEqual(a.endMin);
    expect(after[2].startMin - c.startMin).toBeGreaterThanOrEqual(15); // c は遅れの分ずれる
  });

  it("着いた先より手前の、まだ始めていない予定は『飛ばした』ことになる", () => {
    const itin = tightDay();
    const r = progress(itin, "c", "arrived", itin.days[0].blocks[1].startMin - 5);
    expect(locateBlock(r.after, "b")!.block.skip).toBe("skipped");
    expect(locateBlock(r.after, "c")!.block.actualStartMin).toBeDefined();
  });

  it("遅れで最終便に間に合わなくなるときは、規則どおり Optional → 滞在短縮 → 標準の順に削減し、理由が付く", () => {
    const base = tightDay();
    const itin = withFixed(base, base.days[0].blocks[3].endMin + 40, {}, ctx);
    expect(fixedSlack(itin, ctx)).toBeGreaterThanOrEqual(0);
    const r = progress(itin, "a", "departed", itin.days[0].blocks[0].endMin + 60);
    expect(r.feasible).toBe(true);
    const kinds = r.steps.filter((s) => s.phase === "reduce").map((s) => s.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(fixedSlack(r.after, ctx)).toBeGreaterThanOrEqual(0);
    for (const d of r.diff.filter((x) => x.kind === "skipped" || x.kind === "shortened")) {
      expect(d.reason).toMatch(/最終便|閉館/);
    }
  });

  it("同じ実績をもう一度記録しても、何も変わらない（冪等）", () => {
    const itin = tightDay();
    const first = progress(itin, "a", "departed", itin.days[0].blocks[0].endMin + 20);
    const second = progress(first.after, "a", "departed", itin.days[0].blocks[0].endMin + 20);
    expect(second.after.days[0].blocks.map((b) => [b.id, b.startMin, b.endMin])).toEqual(first.after.days[0].blocks.map((b) => [b.id, b.startMin, b.endMin]));
  });

  it("実績の記録は事実なので、軽い変更なら手動モードでも確認なしで記録する（重い変更は確認）", () => {
    const itin = tightDay();
    const r = progress(itin, "a", "departed", itin.days[0].blocks[0].endMin + 20);
    const c = classifyChange(r, ctx);
    expect(c.weight).toBe("light");
    expect(decideApply("manual", c.weight, { type: "progress" })).toBe("apply");
    expect(decideApply("manual", c.weight, { type: "delay" })).toBe("propose");
    expect(decideApply("manual", "heavy", { type: "progress" })).toBe("propose");
  });

  it("再計算しても、実績の時刻は保たれる（着いた時刻から始まり、出発した時刻に終わる）", () => {
    const itin = tightDay();
    const r = progress(itin, "a", "departed", itin.days[0].blocks[0].endMin + 20);
    const again = recomputeDay(r.after.days[0], ctx, { mode: "preserve", nowMin: itin.days[0].blocks[0].endMin + 20 });
    expect(again.blocks[0].startMin).toBe(itin.days[0].blocks[0].startMin);
    expect(again.blocks[0].endMin).toBe(itin.days[0].blocks[0].endMin + 20);
  });
});

describe("フェーズ3: 「着いた」「出発した」の対象", () => {
  it("遅れて出発するとき: 計画上は次の予定が始まっていても、前の予定を『出発した』にでき、次の予定は『着いた』にできる", () => {
    const itin = tightDay();
    const [a, b] = itin.days[0].blocks;
    const now = a.endMin + 20; // b の計画上の開始（a.end + 移動）を過ぎている
    expect(b.startMin).toBeLessThanOrEqual(now);
    const act = getNextAction(itin.days[0], ctx, now);
    expect(act.current?.id).toBe("b"); // 時刻上は b の最中
    expect(act.arrivable?.id).toBe("b");
    expect(act.departable?.id).toBe("a");
    expect(act.departableName).toBe("REC COFFEE 薬院店");

    // 出発した を記録 → b はまだ着いていない。着いた の対象のまま
    const r = progress(itin, "a", "departed", now);
    const after = getNextAction(r.after.days[0], ctx, now);
    expect(after.arrivable?.id).toBe("b");
    expect(after.departable).toBeUndefined();
  });

  it("着いた記録がある予定では『出発した』の対象はその予定。最初の予定は、前の予定がないのでその予定を出発できる", () => {
    const itin = tightDay();
    const b = itin.days[0].blocks[1];
    const arr = progress(itin, "b", "arrived", b.startMin + 5);
    const act = getNextAction(arr.after.days[0], ctx, b.startMin + 10);
    expect(act.departable?.id).toBe("b");
    expect(act.arrivable).toBeUndefined();

    const a = itin.days[0].blocks[0];
    const first = getNextAction(itin.days[0], ctx, a.startMin + 10);
    expect(first.arrivable?.id).toBe("a");
    expect(first.departable?.id).toBe("a");
  });

  it("次の予定へ移動中（余白や予定のあいだ）は、次の予定に『着いた』を押せる（早く着いたとき）", () => {
    const itin = tightDay();
    const [a, b] = itin.days[0].blocks;
    const act = getNextAction(itin.days[0], ctx, a.endMin);
    expect(act.arrivable?.id).toBe("b");
    expect(b.startMin).toBeGreaterThan(a.endMin);
  });
});

describe("フェーズ3: 早く進んだとき（30分以上）", () => {
  const eightyDay = () =>
    wrapItinerary(
      makeDay(
        [
          { id: "a", spotId: "tenjin-rec", start: hm(10), end: hm(11) },
          { id: "b", spotId: "tenjin-chikagai", start: hm(11, 30), end: hm(12, 30) },
          { id: "c", spotId: "ohori-bimi", start: hm(13, 15), end: hm(14) },
        ],
        ctx,
      ),
    );

  it("予定より40分早く出発すると、近くのスポット追加・余白を増やす提案が出る（まだいる場合は滞在延長も）", () => {
    const itin = eightyDay();
    const r = progress(itin, "a", "departed", hm(10, 20));
    const early = earlyProgress(r.after.days[0], ctx, hm(10, 20))!;
    expect(early.earlyByMin).toBe(40);
    expect(early.stillThere).toBe(false);
    const kinds = suggestForEarly(r.after, ctx, { dayIndex: 0, nowMin: hm(10, 20) }).map((s) => s.kind);
    expect(kinds).toContain("add-optional");
    expect(kinds).toContain("add-buffer");
    expect(kinds).not.toContain("extend-stay"); // もう出発している

    // 早く着いて、まだその予定にいる: 滞在延長も出る
    const arr = progress(itin, "b", "arrived", hm(10, 45));
    const kinds2 = suggestForEarly(arr.after, ctx, { dayIndex: 0, nowMin: hm(10, 45) }).map((s) => s.kind);
    expect(kinds2).toEqual(expect.arrayContaining(["extend-stay", "add-optional", "add-buffer"]));
  });

  it("提案だけで、自動では反映しない。選ぶと、新しい組み直しとして反映できる", () => {
    const itin = eightyDay();
    const r = progress(itin, "a", "departed", hm(10, 20));
    // 実績を記録しただけでは、予定は増えも延びもしない
    expect(r.after.days[0].blocks.length).toBe(itin.days[0].blocks.length);
    const sugg = suggestForEarly(r.after, ctx, { dayIndex: 0, nowMin: hm(10, 20) });
    for (const s of sugg) {
      const applied = replan(r.after, s.event, ctx, { dayIndex: 0, nowMin: hm(10, 20) });
      expect(applied.feasible, s.title).toBe(true);
      expect(applied.after.days[0].blocks.length, s.title).toBeGreaterThan(r.after.days[0].blocks.length - 0);
      expect(classifyChange(applied, ctx).weight, s.title).toBe("light");
    }
  });

  it("滞在の延長は、元の滞在時間にその分を足す。余白を増やすと、余白ブロックが入る", () => {
    const itin = eightyDay();
    const arr = progress(itin, "b", "arrived", hm(10, 45));
    const sugg = suggestForEarly(arr.after, ctx, { dayIndex: 0, nowMin: hm(10, 45) });
    const ext = sugg.find((s) => s.kind === "extend-stay")!;
    const ev = ext.event as Extract<ReplanEvent, { type: "extend-stay" }>;
    const r = replan(arr.after, ext.event, ctx, { dayIndex: 0, nowMin: hm(10, 45) });
    expect(locateBlock(r.after, "b")!.block.durationMin).toBe(locateBlock(arr.after, "b")!.block.durationMin + ev.minutes);
    const buf = sugg.find((s) => s.kind === "add-buffer")!;
    const r2 = replan(arr.after, buf.event, ctx, { dayIndex: 0, nowMin: hm(10, 45) });
    expect(r2.after.days[0].blocks.some((b) => b.label === "buffer")).toBe(true);
  });

  it("30分に満たない早まりでは、提案しない。早まりが解消すると提案は消える", () => {
    expect(EARLY_SUGGEST_MIN).toBe(30);
    const itin = eightyDay();
    const r = progress(itin, "a", "departed", hm(10, 45)); // 15分早い
    expect(earlyProgress(r.after.days[0], ctx, hm(10, 45))).toBeNull();
    expect(suggestForEarly(r.after, ctx, { dayIndex: 0, nowMin: hm(10, 45) })).toEqual([]);
    // 早く出発 → 次の予定に予定どおり着いた: 提案は消える
    const early = progress(itin, "a", "departed", hm(10, 20));
    const onTime = progress(early.after, "b", "arrived", hm(11, 30));
    expect(earlyProgress(onTime.after.days[0], ctx, hm(11, 30))).toBeNull();
  });
});

describe("フェーズ3: 寄り道（ここに寄る）", () => {
  const dayWithFixed = (fixedAt: number) => withFixed(tightDay(), fixedAt, {}, ctx);

  it("近くの候補は、いまいる場所から1km以内・営業中・旅程に入っていないスポットで、近い順", () => {
    const itin = tightDay();
    const now = hm(10, 30);
    const here = currentLocation(itin, ctx, 0, now);
    const list = nearbyOpenSpots(itin, ctx, { dayIndex: 0, nowMin: now });
    expect(list.length).toBeGreaterThan(0);
    const inPlan = new Set(itin.days[0].blocks.map((b) => b.spotId));
    for (const c of list) {
      expect(haversineM(here, c.spot)).toBeLessThanOrEqual(DETOUR_RADIUS_M);
      expect(inPlan.has(c.spot.id)).toBe(false);
    }
    expect(list.map((c) => c.distanceM)).toEqual([...list.map((c) => c.distanceM)].sort((x, y) => x - y));
    // 閉店後は候補に出ない（ほとんどの店が閉まっている深夜）
    expect(nearbyOpenSpots(itin, ctx, { dayIndex: 0, nowMin: hm(23, 40) }).filter((c) => c.spot.hours.every((h) => h.close < "23:00"))).toEqual([]);
  });

  it("自由入力の寄り道: 座標がないので、移動は10分と仮定し、そのことが旅程に残る", () => {
    const itin = tightDay();
    const r = replan(itin, { type: "detour", stop: { name: "気になっていたパン屋", durationMin: 25 }, afterBlockId: "a" }, ctx, { dayIndex: 0, nowMin: hm(10, 20) });
    const blocks = r.after.days[0].blocks;
    const i = blocks.findIndex((b) => b.free);
    expect(i).toBe(1);
    expect(blocks[i].free).toEqual({ name: "気になっていたパン屋", travelMin: FREE_STOP_TRAVEL_MIN });
    expect(blocks[i].travelMin).toBe(FREE_STOP_TRAVEL_MIN);
    expect(blocks[i].startMin).toBe(blocks[0].endMin + FREE_STOP_TRAVEL_MIN);
    expect(blocks[i].endMin - blocks[i].startMin).toBe(25);
    expect(blocks[i].detour).toBe(true);
    // 「次にやること」にも寄り道が出る
    const next = getNextAction(r.after.days[0], ctx, blocks[0].endMin);
    expect(next.nextName).toBe("気になっていたパン屋");
    expect(next.nextSpot).toBeUndefined();
  });

  it("寄り道を入れても固定時刻は守られ、削ったもの・縮めたものには理由が出る", () => {
    const base = tightDay();
    const itin = dayWithFixed(base.days[0].blocks[3].endMin + 15);
    const r = replan(itin, { type: "detour", stop: { name: "パン屋", durationMin: 40 }, afterBlockId: "a" }, ctx, { dayIndex: 0, nowMin: hm(10, 20) });
    expect(r.feasible).toBe(true);
    expect(fixedSlack(r.after, ctx)).toBeGreaterThanOrEqual(0);
    expect(r.after.days[0].blocks.find((b) => b.fixed)!.startMin).toBe(base.days[0].blocks[3].endMin + 15);
    expect(r.diff.find((d) => d.kind === "inserted")?.cause?.kind).toBe("detour");
    const changed = r.diff.filter((d) => d.kind === "skipped" || d.kind === "shortened");
    expect(changed.length).toBeGreaterThan(0);
    for (const d of changed) expect(d.reason).toBeTruthy();
    // ずれた予定の理由は「寄り道を入れたため」
    for (const d of r.diff.filter((x) => x.kind === "shifted")) expect(d.cause?.kind === "detour" || d.cause?.kind === "fixed" || d.cause?.kind === "closing").toBe(true);
  });

  it("寄り道は自動では削らない。Must が危うくなるときは、Must と寄り道を『削る候補』として確認する", () => {
    const day = makeDay(
      [
        { id: "m", label: "must", spotId: "tenjin-rec", start: hm(10), end: hm(10, 45) },
        { id: "n", label: "must", spotId: "tenjin-chikagai", start: hm(11, 5), end: hm(11, 50) },
      ],
      ctx,
    );
    const itin = withFixed(wrapItinerary(day), hm(12, 5), {}, ctx);
    expect(fixedSlack(itin, ctx)).toBeGreaterThanOrEqual(0);
    const r = replan(itin, { type: "detour", stop: { name: "ゆっくりしたい店", durationMin: 60 }, afterBlockId: "m" }, ctx, { dayIndex: 0, nowMin: hm(9, 30) });
    const detour = r.after.days[0].blocks.find((b) => b.free)!;
    expect(detour.skip).toBeUndefined(); // 自動では削らない
    expect(r.feasible).toBe(false);
    const kinds = r.mustCandidates.map((c) => c.kind);
    expect(kinds).toContain("detour");
    expect(kinds).toContain("must");
    expect(classifyChange(r, ctx).weight).toBe("heavy"); // 確認が必要
    // 寄り道をやめれば間に合う
    const cand = r.mustCandidates.find((c) => c.kind === "detour")!;
    expect(cand.fixesAll).toBe(true);
    const r2 = replan(itin, { type: "detour", stop: { name: "ゆっくりしたい店", durationMin: 60 }, afterBlockId: "m" }, ctx, { dayIndex: 0, nowMin: hm(9, 30), removeMustIds: [cand.blockId] });
    expect(r2.feasible).toBe(true);
  });

  it("スポットを選んだ寄り道は、そのスポットの標準の滞在時間で入る（Plan B も付く）", () => {
    const itin = tightDay();
    const target = nearbyOpenSpots(itin, ctx, { dayIndex: 0, nowMin: hm(10, 30) })[0].spot;
    const r = replan(itin, { type: "detour", stop: { spotId: target.id }, afterBlockId: "a" }, ctx, { dayIndex: 0, nowMin: hm(10, 30) });
    const b = r.after.days[0].blocks.find((x) => x.spotId === target.id)!;
    expect(b.detour).toBe(true);
    expect(b.durationMin).toBeLessThanOrEqual(target.stayMin);
    if (target.setting !== "indoor") expect(b.planB === undefined).toBe(false);
  });
});

describe("フェーズ3: 暑さ（WBGT）", () => {
  const outdoorDay = () => {
    const day = makeDay(
      [
        { id: "a", spotId: "hakata-kushida", start: hm(9, 30), end: hm(10, 15) }, // 11時より前（対象外）
        { id: "b", spotId: "ohori-maizuru", start: hm(11, 30), end: hm(12, 30) },
        { id: "c", spotId: "ohori-park", start: hm(13), end: hm(14) },
        { id: "d", spotId: "tenjin-chikagai", start: hm(14, 30), end: hm(15, 15) }, // 屋内（対象外）
        { id: "e", spotId: "tenjin-gogo", start: hm(17), end: hm(17, 20) }, // 16時より後（対象外）
      ],
      ctx,
    );
    return attachPlanBs(wrapItinerary(day), ctx);
  };
  const sunny: HourlyWeather[] = Array.from({ length: 24 }, (_, hour) => ({ hour, precipProb: 10, wbgt: 24 }));

  it("基準は定数1か所: 28以上=厳重警戒・31以上=危険。対象は11〜16時の屋外の予定", () => {
    expect(HEAT_RULES.warning).toBe(28);
    expect(HEAT_RULES.danger).toBe(31);
    expect(HEAT_RULES.windowStartMin).toBe(hm(11));
    expect(HEAT_RULES.windowEndMin).toBe(hm(16));
    expect(heatLevelOf(27.9)).toBe("none");
    expect(heatLevelOf(28)).toBe("warning");
    expect(heatLevelOf(31)).toBe("danger");
    expect(wbgtAt(sunny, hm(12), { startMin: hm(11), wbgt: 31 })).toBe(31);
    expect(wbgtAt(sunny, hm(10), { startMin: hm(11), wbgt: 31 })).toBe(24);
  });

  it("WBGT 31 で、昼（11〜16時）の屋外の予定がすべて Plan B 候補になる。時間外・屋内は対象外", () => {
    const itin = outdoorDay();
    const impact = detectHeatImpact(itin.days[0], ctx, sunny, hm(9), { startMin: hm(9), wbgt: 31 });
    expect(impact.level).toBe("danger");
    expect(impact.switchable.map((b) => b.id)).toEqual(["b", "c"]);
    expect(impact.noPlanB).toEqual([]);
    for (const b of impact.switchable) expect(b.planB).toBeTruthy();
    // 提案を実行すると、昼の屋外の予定がすべて屋内に替わる（軽い変更）
    const r = replan(itin, { type: "plan-b", blockIds: impact.switchable.map((b) => b.id), cause: "heat" }, ctx, { dayIndex: 0, nowMin: hm(9) });
    for (const id of ["b", "c"]) expect(ctx.spotById.get(locateBlock(r.after, id)!.block.spotId!)!.setting).toBe("indoor");
    expect(r.diff.filter((d) => d.kind === "replaced").every((d) => d.reason === "暑さのため")).toBe(true);
    expect(classifyChange(r, ctx).reasons.join("")).not.toContain("予算");
  });

  it("WBGT 28（厳重警戒）でも対象になる。27 では対象にならない。終わった予定は対象外", () => {
    const itin = outdoorDay();
    expect(detectHeatImpact(itin.days[0], ctx, sunny, hm(9), { startMin: hm(9), wbgt: 28 }).level).toBe("warning");
    expect(detectHeatImpact(itin.days[0], ctx, sunny, hm(9), { startMin: hm(9), wbgt: 27 }).switchable).toEqual([]);
    const later = detectHeatImpact(itin.days[0], ctx, sunny, hm(13, 30), { startMin: hm(9), wbgt: 31 });
    expect(later.switchable.map((b) => b.id)).toEqual(["c"]); // b はもう終わっている
  });

  it("暑さの予報が（デモ操作なしで）予報だけで WBGT 31 でも検知できる", () => {
    const hot = sunny.map((h) => (h.hour >= 11 && h.hour <= 16 ? { ...h, wbgt: 32 } : h));
    const impact = detectHeatImpact(outdoorDay().days[0], ctx, hot, hm(9));
    expect(impact.level).toBe("danger");
    expect(impact.switchable).toHaveLength(2);
  });

  it("厳重警戒のもう一つの対応: 屋外の予定の後に15分の休憩を挟む（軽い変更。理由は暑さ）", () => {
    const itin = outdoorDay();
    const r = replan(itin, { type: "heat-rest", blockIds: ["b", "c"], minutes: HEAT_RULES.restMin }, ctx, { dayIndex: 0, nowMin: hm(9) });
    const blocks = r.after.days[0].blocks;
    for (const id of ["b", "c"]) {
      const i = blocks.findIndex((x) => x.id === id);
      expect(blocks[i + 1].label).toBe("rest");
      expect(blocks[i + 1].durationMin).toBe(15);
    }
    expect(r.diff.filter((d) => d.kind === "inserted").every((d) => d.cause?.kind === "heat")).toBe(true);
    expect(classifyChange(r, ctx).weight).toBe("light");
    expect(r.feasible).toBe(true);
  });
});
