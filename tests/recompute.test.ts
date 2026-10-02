import { describe, expect, it } from "vitest";
import { applyDelay, reorderBlocks, skipAllCandidates } from "@/core/actions";
import { MIN_BUFFER_MIN, recomputeDay, settleDay } from "@/core/schedule";
import { hm, makeCtx, makeDay, wrapItinerary } from "./helpers";

const ctx = makeCtx();
const travel = (a: string, b: string) => ctx.travel(ctx.spotById.get(a)!, ctx.spotById.get(b)!).minutes;

/** 公園(10:00-11:00) → 余白(11:00-11:30) → スタバ(11:40-12:25) → 美術館(13:00-14:30, Optional) */
function sampleDay() {
  return makeDay([
    { id: "a", label: "must", spotId: "ohori-park", start: hm(10), end: hm(11) },
    { id: "buf", start: hm(11), end: hm(11, 30) },
    { id: "b", spotId: "ohori-starbucks", start: hm(11, 40), end: hm(12, 25) },
    { id: "c", label: "optional", spotId: "ohori-art", start: hm(13), end: hm(14, 30) },
  ]);
}

describe("時刻の再計算", () => {
  it("変更がなければ時刻は変わらない（再計算は冪等）", () => {
    const day = sampleDay();
    const again = recomputeDay(day, ctx, { mode: "preserve" });
    expect(again.blocks.map((b) => [b.startMin, b.endMin])).toEqual(day.blocks.map((b) => [b.startMin, b.endMin]));
    const midway = recomputeDay(day, ctx, { mode: "preserve", nowMin: hm(10, 30) });
    expect(midway.blocks.map((b) => [b.startMin, b.endMin])).toEqual(day.blocks.map((b) => [b.startMin, b.endMin]));
  });

  it("小さな遅延は余白ブロックが吸収し、後ろの予定は動かない", () => {
    const day = sampleDay();
    const out = settleDay(day, ctx, { mode: "preserve", nowMin: hm(10, 30), delayMin: 20 });
    const [a, buf, b, c] = out.blocks;
    expect(a.startMin).toBe(hm(10)); // 進行中のブロックは固定
    expect(buf.startMin).toBe(hm(11, 20));
    expect(buf.endMin).toBe(hm(11, 30)); // 30分 → 10分に縮む
    expect(buf.endMin - buf.startMin).toBeGreaterThanOrEqual(MIN_BUFFER_MIN);
    expect(b.startMin).toBe(hm(11, 40));
    expect(c.startMin).toBe(hm(13));
  });

  it("大きな遅延は余白で吸収しきれず、後ろの予定が押し出される（移動時間も加味）", () => {
    const day = sampleDay();
    const out = settleDay(day, ctx, { mode: "preserve", nowMin: hm(10, 30), delayMin: 60 });
    const [, buf, b, c] = out.blocks;
    expect(buf.startMin).toBe(hm(12)); // 11:00 + 60分
    expect(buf.endMin).toBe(hm(12, 10)); // 最短 10 分まで縮む
    const bStart = hm(12, 10) + travel("ohori-park", "ohori-starbucks");
    expect(b.startMin).toBe(bStart);
    expect(b.endMin).toBe(bStart + 45);
    const cStart = Math.max(hm(13), b.endMin + travel("ohori-starbucks", "ohori-art"));
    expect(c.startMin).toBe(cStart);
    expect(c.endMin).toBe(cStart + 90);
  });

  it("遅延は累積し、後続ブロックは必ず『前の終了＋移動時間』以降に始まる", () => {
    let itin = wrapItinerary(sampleDay());
    itin = applyDelay(itin, 0, 30, hm(10, 30), ctx);
    itin = applyDelay(itin, 0, 30, hm(10, 30), ctx);
    const blocks = itin.days[0].blocks;
    for (let i = 1; i < blocks.length; i++) {
      const prev = blocks[i - 1];
      expect(blocks[i].startMin).toBeGreaterThanOrEqual(prev.endMin + blocks[i].travelMin);
    }
    // 合計60分の遅延と同じ結果になる
    const once = applyDelay(wrapItinerary(sampleDay()), 0, 60, hm(10, 30), ctx).days[0].blocks;
    expect(blocks.map((b) => b.startMin)).toEqual(once.map((b) => b.startMin));
  });

  it("開始済みのブロックは、遅延が発生しても動かない", () => {
    const itin = applyDelay(wrapItinerary(sampleDay()), 0, 45, hm(11, 45), ctx);
    const [a, buf, b] = itin.days[0].blocks;
    expect([a.startMin, a.endMin]).toEqual([hm(10), hm(11)]);
    expect([buf.startMin, buf.endMin]).toEqual([hm(11), hm(11, 30)]);
    expect([b.startMin, b.endMin]).toEqual([hm(11, 40), hm(12, 25)]); // 進行中（11:45時点）なので固定
  });

  it("遅延で営業時間に間に合わなくなる Optional は『スキップ候補』になる", () => {
    const out = applyDelay(wrapItinerary(sampleDay()), 0, 300, hm(10, 30), ctx).days[0].blocks;
    const c = out[3];
    expect(c.issues).toContain("outside-hours"); // 福岡市美術館は 17:30 閉館
    expect(c.skip).toBe("candidate");
    expect(out[2].skip).toBeUndefined(); // 営業中の標準ブロックは候補にならない
  });

  it("営業時間内に収まる Optional は、遅延しても候補にならない", () => {
    const out = applyDelay(wrapItinerary(sampleDay()), 0, 60, hm(10, 30), ctx).days[0].blocks;
    expect(out[3].skip).toBeUndefined();
    expect(out[3].issues).toBeUndefined();
  });

  it("手前の Optional を飛ばせば間に合う場合、Optional をスキップ候補にして、スキップで立て直せる", () => {
    const day = makeDay([
      { id: "opt", label: "optional", spotId: "ohori-tsutaya", start: hm(14), end: hm(15) },
      { id: "norm", spotId: "ohori-art", start: hm(15, 20), end: hm(16, 50) }, // 17:30 閉館
    ]);
    const delayed = applyDelay(wrapItinerary(day), 0, 60, hm(13), ctx).days[0].blocks;
    expect(delayed[1].issues).toContain("outside-hours"); // 手前が遅れて美術館が間に合わない
    expect(delayed[0].skip).toBe("candidate");

    const skipped = skipAllCandidates(applyDelay(wrapItinerary(day), 0, 60, hm(13), ctx), 0, hm(13), ctx).days[0].blocks;
    expect(skipped[0].skip).toBe("skipped");
    expect(skipped[1].issues).toBeUndefined();
    expect(skipped[1].startMin).toBeLessThanOrEqual(hm(15, 40));
  });

  it("営業時間外のブロックは issues に記録される（閉店後に到着）", () => {
    const out = settleDay(
      makeDay([{ id: "x", spotId: "ohori-art", start: hm(16), end: hm(17, 30) }]),
      ctx,
      { mode: "preserve", nowMin: hm(9), delayMin: 90 },
    );
    expect(out.blocks[0].issues).toContain("outside-hours");
  });

  it("開店前に着く場合は開店まで待つ", () => {
    const day = makeDay([{ id: "x", spotId: "ohori-art", start: hm(9, 40), end: hm(11, 10) }]);
    expect(day.blocks[0].startMin).toBeGreaterThanOrEqual(hm(9, 30));
  });
});

describe("並べ替え", () => {
  it("並べ替えると先頭から時刻を詰め直す", () => {
    const itin = wrapItinerary(sampleDay());
    const out = reorderBlocks(itin, 0, 3, 0, ctx).days[0].blocks; // 美術館を先頭へ
    expect(out.map((b) => b.id)).toEqual(["c", "a", "buf", "b"]);
    expect(out[0].startMin).toBeGreaterThanOrEqual(hm(9, 30)); // 開館(9:30)を待つ
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startMin).toBeGreaterThanOrEqual(out[i - 1].endMin + out[i].travelMin);
    }
    // 計画上の時刻も更新される
    expect(out.every((b) => b.plannedStartMin === b.startMin)).toBe(true);
  });

  it("並べ替えても余白の長さは元の長さに戻る／ブロックの内容は保たれる", () => {
    const itin = wrapItinerary(sampleDay());
    const out = reorderBlocks(itin, 0, 0, 2, ctx).days[0].blocks;
    const buf = out.find((b) => b.id === "buf")!;
    expect(buf.endMin - buf.startMin).toBe(30);
    expect(out.map((b) => b.spotId).sort()).toEqual(["ohori-art", "ohori-park", "ohori-starbucks", undefined].sort());
  });

  it("範囲外・同じ位置への移動は何もしない", () => {
    const itin = wrapItinerary(sampleDay());
    expect(reorderBlocks(itin, 0, 1, 1, ctx)).toBe(itin);
    expect(reorderBlocks(itin, 0, 9, 0, ctx)).toBe(itin);
  });
});
