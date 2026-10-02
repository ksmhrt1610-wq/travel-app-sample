import { describe, expect, it } from "vitest";
import { canReorder, reorderBlocks } from "@/core/actions";
import {
  absenceByBlock,
  allFixedDepartures,
  defaultMembers,
  departureNotices,
  FIXED_PRESETS,
  FIXED_PRESET_DISCLAIMER,
  fixedDeparture,
  isGroupWide,
  memberFixedStatuses,
  nextFixedCountdown,
} from "@/core/fixed";
import { FIXED_KIND_LABEL } from "@/core/labels";
import { generateItinerary } from "@/core/planner";
import { replan } from "@/core/replan";
import { DEFAULT_MARGIN_MIN } from "@/core/schedule";
import { decodeItinerary, encodeItinerary } from "@/core/share";
import { dazaifuDay, demoPrefs, fixedEvent, hm, makeCtx, SATURDAY, STATION, withFixed, wrapItinerary } from "./helpers";

const ctx = makeCtx();
const base = () => wrapItinerary(dazaifuDay(ctx), { ...demoPrefs, companions: "friends" });

describe("固定時刻の逆算（出発すべき時刻）", () => {
  it("出発すべき時刻 = 固定時刻 − 移動時間 − 余裕時間（初期値10分）", () => {
    const itin = withFixed(base(), hm(18, 5), {}, ctx);
    expect(itin.settings.marginMin).toBe(DEFAULT_MARGIN_MIN);
    expect(DEFAULT_MARGIN_MIN).toBe(10);
    const day = itin.days[0];
    const idx = day.blocks.findIndex((b) => b.fixed);
    const d = fixedDeparture(day, idx, ctx, itin.settings.marginMin)!;
    const lastSpot = day.blocks.slice(0, idx).reverse().find((b) => b.spotId && !b.skip)!;
    expect(d.pred?.id).toBe(lastSpot.id);
    const travel = ctx.travel(ctx.spotById.get(lastSpot.spotId!)!, STATION).minutes;
    expect(d.travelMin).toBe(travel);
    expect(d.departBy).toBe(hm(18, 5) - travel - 10);
  });

  it("余裕時間は設定で変えられ、逆算に反映される", () => {
    const itin = withFixed(base(), hm(18, 5), {}, ctx);
    const r = replan(itin, { type: "margin", marginMin: 25 }, ctx, { dayIndex: 0 });
    expect(r.after.settings.marginMin).toBe(25);
    const idx = r.after.days[0].blocks.findIndex((b) => b.fixed);
    const before = fixedDeparture(itin.days[0], idx, ctx, 10)!;
    const after = fixedDeparture(r.after.days[0], idx, ctx, 25)!;
    expect(before.departBy - after.departBy).toBe(15);
  });

  it("余裕時間を大きくして間に合わなくなるなら、再計画で組み直される", () => {
    const itin = withFixed(base(), hm(17), {}, ctx);
    const r = replan(itin, { type: "margin", marginMin: 90 }, ctx, { dayIndex: 0 });
    expect(r.steps.some((s) => s.phase === "reduce")).toBe(true);
  });

  it("固定時刻のブロックは、遅延などでも動かない（開始は固定時刻のまま）", () => {
    let itin = withFixed(base(), hm(17), {}, ctx);
    itin = replan(itin, { type: "delay", minutes: 40 }, ctx, { dayIndex: 0, nowMin: hm(12, 50) }).after;
    const fixed = itin.days[0].blocks.find((b) => b.fixed)!;
    expect(fixed.startMin).toBe(hm(17));
  });

  it("固定ブロックは鍵付きで動かせず、固定時刻をまたぐ並べ替えもできない", () => {
    const itin = withFixed(base(), hm(14, 30), {}, ctx);
    const day = itin.days[0];
    const fixedIdx = day.blocks.findIndex((b) => b.fixed);
    expect(canReorder(day, fixedIdx, 0).ok).toBe(false);
    expect(canReorder(day, 0, fixedIdx + 1).ok).toBe(false); // またぐ
    expect(canReorder(day, 0, fixedIdx).ok).toBe(false); // 固定ブロックの位置へ
    expect(canReorder(day, 0, 1).ok).toBe(true);
    expect(reorderBlocks(itin, 0, fixedIdx, 0, ctx)).toBe(itin);
  });

  it("最終便は、その日の予定の終わり（それ以降は実施できない）", () => {
    const itin = withFixed(base(), hm(17), {}, ctx);
    expect(itin.days[0].blocks.find((b) => b.fixed)!.fixed!.endsDay).toBe(true);
  });
});

describe("次にやること: 固定時刻までの逆算と通知", () => {
  const itin = withFixed(base(), hm(18, 5), {}, ctx);
  const day = itin.days[0];

  it("直近の固定時刻までの出発時刻と残り時間を出す。直前のスポットにいれば『ここ』", () => {
    const idx = day.blocks.findIndex((b) => b.fixed);
    const pred = fixedDeparture(day, idx, ctx, 10)!.pred!;
    const during = nextFixedCountdown(day, ctx, pred.startMin + 5, 10)!;
    expect(during.here).toBe(true);
    expect(during.minutesLeft).toBe(during.departBy - (pred.startMin + 5));
    expect(during.fixed.fixed!.timeMin).toBe(hm(18, 5));
    const earlier = nextFixedCountdown(day, ctx, hm(10, 30), 10)!;
    expect(earlier.here).toBe(false);
    expect(earlier.predName).toBeTruthy();
  });

  it("固定時刻を過ぎたら出さない", () => {
    expect(nextFixedCountdown(day, ctx, hm(18, 6), 10)).toBeNull();
  });

  it("出発すべき時刻の30分前・10分前・過ぎたときに通知する", () => {
    const idx = day.blocks.findIndex((b) => b.fixed);
    const departBy = fixedDeparture(day, idx, ctx, 10)!.departBy;
    const at = (now: number) => departureNotices(day, ctx, now, 10, itin.members).map((n) => n.level);
    expect(at(departBy - 31)).toEqual([]);
    expect(at(departBy - 30)).toEqual(["before30"]);
    expect(at(departBy - 11)).toEqual(["before30"]);
    expect(at(departBy - 10)).toEqual(["before10"]);
    expect(at(departBy - 1)).toEqual(["before10"]);
    expect(at(departBy)).toEqual(["over"]);
    expect(at(hm(18, 6))).toEqual([]);
    expect(departureNotices(day, ctx, departBy - 25, 10, itin.members)[0].id).toMatch(/:before30$/);
  });

  it("全固定時刻の出発時刻をまとめて取れる", () => {
    expect(allFixedDepartures(day, ctx, 10).size).toBe(1);
  });
});

describe("サンプルの固定時刻（帰りの最終便）", () => {
  it("太宰府・糸島エリアの例が2〜3件あり、実在の時刻表でないことを明記している", () => {
    expect(FIXED_PRESETS.length).toBeGreaterThanOrEqual(2);
    expect(FIXED_PRESETS.length).toBeLessThanOrEqual(3);
    expect(FIXED_PRESETS.some((p) => p.place.name.includes("太宰府"))).toBe(true);
    expect(FIXED_PRESETS.some((p) => p.place.name.includes("前原") || p.note.includes("糸島"))).toBe(true);
    for (const p of FIXED_PRESETS) expect(p.kind).toBe("last-transport");
    expect(FIXED_PRESET_DISCLAIMER).toContain("実在の時刻表ではありません");
  });

  it("選ぶだけで固定時刻として登録できる", () => {
    const p = FIXED_PRESETS[0];
    const r = replan(base(), { type: "fixed-add", fixed: { id: "", kind: p.kind, title: p.title, timeMin: p.timeMin, dayIndex: 0, place: p.place, durationMin: 0, endsDay: true, memberIds: null } }, ctx, { dayIndex: 0 });
    expect(r.after.days[0].blocks.some((b) => b.fixed?.title === p.title)).toBe(true);
  });

  it("固定時刻の種類は5つ", () => {
    expect(Object.keys(FIXED_KIND_LABEL).sort()).toEqual(["car-return", "checkin", "last-transport", "meetup", "reservation"]);
  });
});

describe("特定メンバーだけの固定時刻", () => {
  const members = defaultMembers("friends");
  const cId = members.find((m) => m.name === "Cさん")!.id;
  const withC = () =>
    replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(15), { id: "fxc", title: "Cさん 太宰府駅 15:00 の電車", memberIds: [cId] }) }, ctx, { dayIndex: 0 });

  it("Cさんだけの固定時刻は、グループの旅程の時刻を変えない", () => {
    const r = withC();
    expect(r.steps.filter((s) => s.phase === "reduce")).toHaveLength(0);
    expect(r.after.days[0].blocks.map((b) => [b.id, b.startMin, b.endMin])).toEqual(base().days[0].blocks.map((b) => [b.id, b.startMin, b.endMin]));
    expect(r.after.days[0].memberFixed).toHaveLength(1);
  });

  it("Cさんが抜けたあとの予定が『Cさん不在』になり、抜ける前の予定は不在にならない", () => {
    const itin = withC().after;
    const [status] = memberFixedStatuses(itin.days[0], ctx, itin.settings.marginMin, itin.members);
    expect(status.memberNames).toEqual(["Cさん"]);
    expect(status.absentBlockIds.length).toBeGreaterThan(0);
    const blocks = itin.days[0].blocks;
    const leaveIdx = blocks.findIndex((b) => b.id === status.leaveAfterBlockId);
    expect(leaveIdx).toBeGreaterThanOrEqual(0);
    // 抜けたあとの予定がすべて不在
    expect(status.absentBlockIds).toEqual(blocks.slice(leaveIdx + 1).map((b) => b.id));
    const absence = absenceByBlock([status]);
    for (const b of blocks.slice(leaveIdx + 1)) expect(absence.get(b.id)).toEqual(["Cさん"]);
    for (const b of blocks.slice(0, leaveIdx + 1)) expect(absence.has(b.id)).toBe(false);
    // 抜けるブロックの後から向かって、固定時刻に間に合う
    const last = blocks[leaveIdx];
    expect(last.endMin).toBeLessThanOrEqual(status.departBy);
  });

  it("メンバー限定の固定時刻でも、出発時刻の通知が出る（対象者つき）", () => {
    const itin = withC().after;
    const [status] = memberFixedStatuses(itin.days[0], ctx, 10, itin.members);
    const notices = departureNotices(itin.days[0], ctx, status.departBy - 20, 10, itin.members);
    expect(notices[0].who).toBe("Cさん");
    expect(notices[0].level).toBe("before30");
  });

  it("全メンバーを対象にした固定時刻は、全員に効く固定時刻（ブロック）になる", () => {
    const all = members.map((m) => m.id);
    expect(isGroupWide(fixedEvent(hm(15), { memberIds: all }), members)).toBe(true);
    expect(isGroupWide(fixedEvent(hm(15), { memberIds: [cId] }), members)).toBe(false);
    const r = replan(base(), { type: "fixed-add", fixed: fixedEvent(hm(17), { memberIds: all }) }, ctx, { dayIndex: 0 });
    expect(r.after.days[0].blocks.some((b) => b.fixed)).toBe(true);
    expect(r.after.days[0].memberFixed ?? []).toHaveLength(0);
  });

  it("メンバー数が1人のときは、全員に効く固定時刻になる", () => {
    const solo = defaultMembers("solo");
    expect(solo).toHaveLength(1);
    expect(isGroupWide(fixedEvent(hm(15), { memberIds: [solo[0].id] }), solo)).toBe(true);
  });
});

describe("固定時刻・メンバーの共有", () => {
  it("固定時刻・メンバー限定の固定時刻・余裕時間・メンバー名が共有URLで往復できる", () => {
    const members = defaultMembers("friends");
    let itin = generateItinerary({ prefs: { ...demoPrefs, mustSpotIds: ["dazaifu-shrine"] }, ctx, startDate: SATURDAY });
    itin = withFixed(itin, hm(18, 5), {}, ctx);
    itin = replan(itin, { type: "fixed-add", fixed: fixedEvent(hm(15), { id: "fxm", title: "Cさんの電車", memberIds: [members[2].id] }) }, ctx, { dayIndex: 0 }).after;
    itin = replan(itin, { type: "margin", marginMin: 15 }, ctx, { dayIndex: 0 }).after;
    itin = { ...itin, members: itin.members.map((m) => (m.id === "m3" ? { ...m, name: "ケンタ" } : m)) };
    const decoded = decodeItinerary(encodeItinerary(itin), ctx)!;
    expect(decoded).not.toBeNull();
    expect(decoded.settings.marginMin).toBe(15);
    expect(decoded.members.map((m) => m.name)).toEqual(["Aさん", "Bさん", "ケンタ"]);
    const fixed = decoded.days[0].blocks.find((b) => b.fixed)!;
    expect(fixed.fixed!.timeMin).toBe(hm(18, 5));
    expect(fixed.fixed!.place.name).toBe("太宰府駅");
    expect(fixed.fixed!.endsDay).toBe(true);
    expect(decoded.days[0].memberFixed?.[0].memberIds).toEqual(["m3"]);
    expect(decoded.days[0].blocks.map((b) => [b.label, b.startMin, b.endMin])).toEqual(itin.days[0].blocks.map((b) => [b.label, b.startMin, b.endMin]));
  });
});
