import { describe, expect, it } from "vitest";
import { locateBlock } from "@/core/actions";
import { replan, type ReplanEvent } from "@/core/replan";
import type { Itinerary } from "@/core/types";
import { dazaifuDay, fixedEvent, fixedSlack, hm, makeCtx, withFixed, wrapItinerary } from "./helpers";

const ctx = makeCtx();
const base = (): Itinerary => wrapItinerary(dazaifuDay(ctx));
const reduceKinds = (r: ReturnType<typeof replan>) => r.steps.filter((s) => s.phase === "reduce").map((s) => s.kind);

describe("再計画エンジン: 固定時刻を必ず守る", () => {
  it("固定時刻を登録すると、最終便に間に合わない予定は削られて間に合う旅程になる", () => {
    const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(15)) }, ctx, { dayIndex: 0 });
    expect(r.feasible).toBe(true);
    expect(fixedSlack(r.after, ctx)).toBeGreaterThanOrEqual(0);
    // 最終便の時刻は動かない
    const fixed = r.after.days[0].blocks.find((b) => b.fixed)!;
    expect([fixed.startMin, fixed.endMin]).toEqual([hm(15), hm(15)]);
  });

  it("遅延・休憩（少し／かなり）を重ねても、固定時刻に間に合う旅程になる", () => {
    let itin = withFixed(base(), hm(16, 30), {}, ctx);
    expect(fixedSlack(itin, ctx)).toBeGreaterThanOrEqual(0);
    const events: [ReplanEvent, number][] = [
      [{ type: "delay", minutes: 45 }, hm(13, 30)],
      [{ type: "tired", level: "light" }, hm(14)],
      [{ type: "delay", minutes: 30 }, hm(14, 30)],
      [{ type: "tired", level: "heavy" }, hm(15)],
    ];
    for (const [event, now] of events) {
      const r = replan(itin, event, ctx, { dayIndex: 0, nowMin: now });
      expect(r.feasible, `${event.type} @${now}: ${r.violations.map((v) => v.message).join(" / ")}`).toBe(true);
      itin = r.after;
      expect(fixedSlack(itin, ctx), `${event.type} @${now}`).toBeGreaterThanOrEqual(0);
      expect(itin.days[0].blocks.find((b) => b.fixed)!.startMin).toBe(hm(16, 30));
    }
  });

  it("固定時刻より前に出発すべき時刻を過ぎている場合は、間に合わないことを違反として返す", () => {
    // 15:50 に 16:00 の電車: 手前の予定は動かせない（開始済み）ので間に合わない
    const r = replan(withFixed(base(), hm(20), {}, ctx), { type: "fixed-add", fixed: fixedEvent(hm(16), { id: "fx9" }) }, ctx, {
      dayIndex: 0,
      nowMin: hm(15, 50),
    });
    expect(r.feasible).toBe(false);
    expect(r.violations.some((v) => v.kind === "fixed-missed" || v.kind === "after-last-transport")).toBe(true);
  });

  it("最終便のあとの予定は実施できないので削られ、あとの余白は片づけられる", () => {
    const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(13)) }, ctx, { dayIndex: 0 });
    const after = r.after.days[0].blocks;
    const fixedIdx = after.findIndex((b) => b.fixed);
    for (const b of after.slice(fixedIdx + 1)) expect(b.skip).toBe("skipped");
  });
});

describe("再計画エンジン: 時間が足りないときの削る順序", () => {
  it("Optional → 滞在短縮 → 標準 の順に処理される", () => {
    const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(12, 30)) }, ctx, { dayIndex: 0 });
    const kinds = reduceKinds(r);
    expect(kinds).toContain("drop-optional");
    expect(kinds).toContain("shorten");
    expect(kinds).toContain("drop-standard");
    const last = (k: string) => kinds.lastIndexOf(k as never);
    const first = (k: string) => kinds.indexOf(k as never);
    expect(last("drop-optional")).toBeLessThan(first("shorten"));
    expect(last("shorten")).toBeLessThan(first("drop-standard"));
    expect(r.feasible).toBe(true);
  });

  it("Optional を後ろから削る（後ろの Optional が先に削られる）", () => {
    const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(15)) }, ctx, { dayIndex: 0 });
    const dropped = r.steps.filter((s) => s.kind === "drop-optional").map((s) => s.blockIds[0]);
    expect(dropped[0]).toBe("s6");
  });

  it("滞在短縮は最低滞在時間（標準滞在時間の半分）までに限られる", () => {
    for (const t of [hm(12), hm(11, 30), hm(13, 30)]) {
      const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(t) }, ctx, { dayIndex: 0 });
      for (const b of r.after.days[0].blocks) {
        if (!b.spotId || b.skip) continue;
        const spot = ctx.spotById.get(b.spotId)!;
        expect(b.durationMin).toBeGreaterThanOrEqual(Math.max(15, Math.round(spot.stayMin / 2 / 5) * 5));
      }
    }
  });

  it("短縮したあとにスキップされたブロックは、短縮の記録に残らず、滞在時間も元に戻る", () => {
    for (const t of [hm(12), hm(12, 30), hm(13), hm(14)]) {
      const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(t) }, ctx, { dayIndex: 0 });
      const shortened = new Set(r.steps.filter((s) => s.kind === "shorten").flatMap((s) => s.blockIds));
      for (const b of r.after.days[0].blocks) {
        if (b.skip !== "skipped" || !b.spotId) continue;
        expect(shortened.has(b.id), `${b.id} @${t}`).toBe(false);
        expect(b.durationMin).toBe(locateBlock(r.before, b.id)!.block.durationMin);
      }
    }
  });

  it("優先度が低いものから削るので、先に Optional が尽きるまで標準・Must は削られない", () => {
    const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(15)) }, ctx, { dayIndex: 0 });
    const blocks = r.after.days[0].blocks;
    for (const id of ["s1", "s2", "s3", "s4"]) expect(locateBlock(r.after, id)!.block.skip).toBeUndefined();
    expect(blocks.filter((b) => b.skip).every((b) => b.label === "optional")).toBe(true);
  });
});

describe("再計画エンジン: Must は確認なしに削除されない", () => {
  const tight = () => replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(11, 15)) }, ctx, { dayIndex: 0 });

  it("足りないときは Must を削る候補として提示するだけで、Must は残る", () => {
    const r = tight();
    expect(r.feasible).toBe(false);
    expect(r.mustCandidates.length).toBeGreaterThan(0);
    expect(r.steps.some((s) => s.kind === "drop-must")).toBe(false);
    for (const id of ["s1", "s2"]) expect(locateBlock(r.after, id)!.block.skip).toBeUndefined();
    // 候補は Must のブロックだけ
    for (const c of r.mustCandidates) expect(locateBlock(r.after, c.blockId)!.block.label).toBe("must");
  });

  it("ユーザーが確認して選んだ Must だけが削られ、解消できる候補なら間に合う", () => {
    const first = tight();
    const candidate = first.mustCandidates.find((c) => c.fixesAll)!;
    expect(candidate).toBeTruthy();
    const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(11, 15)) }, ctx, { dayIndex: 0, removeMustIds: [candidate.blockId] });
    expect(r.steps.some((s) => s.kind === "drop-must" && s.blockIds[0] === candidate.blockId)).toBe(true);
    expect(locateBlock(r.after, candidate.blockId)!.block.skip).toBe("skipped");
    expect(r.feasible).toBe(true);
    // 選ばなかった Must は残る
    const others = ["s1", "s2"].filter((id) => id !== candidate.blockId);
    for (const id of others) expect(locateBlock(r.after, id)!.block.skip).toBeUndefined();
  });

  it("遅延でも同じ: 足りなくても Must は勝手に削らない", () => {
    const itin = withFixed(base(), hm(16, 30), {}, ctx);
    const r = replan(itin, { type: "delay", minutes: 180 }, ctx, { dayIndex: 0, nowMin: hm(10, 30) });
    expect(r.steps.some((s) => s.kind === "drop-must")).toBe(false);
    for (const id of ["s1", "s2"]) expect(locateBlock(r.after, id)!.block.skip).toBeUndefined();
  });
});

describe("再計画エンジン: 警告の整理", () => {
  it("最終便で締まる日は、その時刻より後のディナーの警告を外す", () => {
    const itin = base();
    itin.days[0].warnings = ["ディナーに使える営業中の店が見つかりませんでした。", "ランチに使える営業中の店が見つかりませんでした。"];
    const r = replan(itin, { type: "fixed-add", fixed: fixedEvent(hm(18, 5)) }, ctx, { dayIndex: 0 });
    expect(r.after.days[0].warnings).toEqual(["ランチに使える営業中の店が見つかりませんでした。"]);
  });
});

describe("再計画エンジン: 提案と確定", () => {
  it("提案は元の旅程を変更しない（確定するまで反映されない）", () => {
    const itin = base();
    const snapshot = JSON.stringify(itin);
    const r = replan(itin, { type: "fixed-add", fixed: fixedEvent(hm(13)) }, ctx, { dayIndex: 0 });
    expect(JSON.stringify(itin)).toBe(snapshot);
    expect(r.before).toBe(itin);
    expect(r.after).not.toBe(itin);
    expect(r.diff.length).toBeGreaterThan(0);
  });

  it("雨・遅延・臨時休業・疲れた・固定時刻の追加が、同じ関数・同じ結果の形で扱える", () => {
    const itin = withFixed(base(), hm(17), {}, ctx);
    const events: ReplanEvent[] = [
      { type: "plan-b", blockIds: itin.days[0].blocks.filter((b) => b.planB).map((b) => b.id) },
      { type: "delay", minutes: 20 },
      { type: "closure", spotId: "dazaifu-komyozen" },
      { type: "tired", level: "light" },
      { type: "tired", level: "heavy" },
    ];
    for (const e of events) {
      const r = replan(itin, e, ctx, { dayIndex: 0, nowMin: hm(12, 50) });
      expect(r.event).toBe(e);
      expect(Array.isArray(r.steps)).toBe(true);
      expect(Array.isArray(r.diff)).toBe(true);
      expect(typeof r.feasible).toBe("boolean");
      expect(r.after.days).toHaveLength(itin.days.length);
    }
  });
});
