import { describe, expect, it } from "vitest";
import { generateItinerary } from "@/core/planner";
import { keywordEventParser, parseMinutes, parseWithKeywords, findSpotMention, type ParseContext } from "@/core/parser";
import { replan } from "@/core/replan";
import { decodeItinerary, encodeItinerary } from "@/core/share";
import { eventParser } from "@/eventParser";
import { templateWriter } from "@/core/cause";
import { demoPrefs, fixedEvent, makeCtx, SATURDAY } from "./helpers";

const ctx = makeCtx();

/** プロパティテスト（tests/properties.test.ts）が見つけた不具合の、再現用の固定テスト */
describe("フェーズ6: プロパティテストが見つけた不具合の回帰テスト", () => {
  const prefs = { ...demoPrefs, interests: ["gourmet" as const], rainTolerance: "no-outdoor" as const, mustSpotIds: ["ohori-park"] };
  const itin = generateItinerary({ prefs, ctx, startDate: SATURDAY });

  it("共有リンクを往復しても、食事（ランチ・ディナー）の印が保たれる（旧: 落ちていた）", () => {
    const meals = (i: typeof itin) => i.days[0].blocks.map((b) => b.meal ?? "-");
    expect(meals(itin).some((m) => m !== "-")).toBe(true);
    const back = decodeItinerary(encodeItinerary(itin), ctx);
    expect(back).not.toBeNull();
    expect(meals(back!)).toEqual(meals(itin));
  });

  it("終わった予定は、Plan B の切り替えで書き換えない（旧: 行った場所の記録が変わっていた）", () => {
    const outdoor = itin.days[0].blocks.filter((b) => b.planB && !b.switched);
    expect(outdoor.length).toBeGreaterThan(0);
    const park = outdoor.find((b) => b.spotId === "ohori-park")!;
    // 大濠公園が終わったあと（その日の13:00）に、雨で「すべて切り替える」を押しても、行った記録は変わらない
    const r = replan(itin, { type: "plan-b", blockIds: outdoor.map((b) => b.id), cause: "rain" }, ctx, { dayIndex: 0, nowMin: park.endMin + 5 });
    const after = r.after.days[0].blocks.find((b) => b.id === park.id)!;
    expect(after.spotId).toBe("ohori-park");
    expect(after.switched).toBeFalsy();
    // これから先の屋外の予定は、切り替わる
    const future = outdoor.filter((b) => b.endMin > park.endMin + 5);
    for (const b of future) expect(r.after.days[0].blocks.find((x) => x.id === b.id)!.switched).toBe(true);
  });

  it("現在時刻より前の固定時刻は、追加しない（旧: 過去の時刻のブロックが予定に割り込んでいた）", () => {
    const r = replan(itin, { type: "fixed-add", fixed: fixedEvent(15 * 60) }, ctx, { dayIndex: 0, nowMin: 17 * 60 });
    expect(r.after.days[0].blocks.some((b) => b.fixed)).toBe(false);
    expect(r.notes.join("")).toContain("現在時刻");
    // 先の時刻なら、これまでどおり追加される
    const ok = replan(itin, { type: "fixed-add", fixed: fixedEvent(19 * 60) }, ctx, { dayIndex: 0, nowMin: 12 * 60 });
    expect(ok.after.days[0].blocks.some((b) => b.fixed)).toBe(true);
  });

  it("いま余白の最中に遅れが起きたら、余白の残りが吸収する（旧: 次の予定がそのまま遅れていた）", () => {
    const day = itin.days[0];
    const buffer = day.blocks.find((b) => b.label === "buffer" && b.endMin - b.startMin >= 120)!;
    const next = day.blocks[day.blocks.indexOf(buffer) + 1];
    expect(next).toBeDefined();
    // 余白の始まりにいて、90分遅れる → 余白が吸収して、次の予定は動かない
    const r = replan(itin, { type: "delay", minutes: 90 }, ctx, { dayIndex: 0, nowMin: buffer.startMin });
    expect(r.after.days[0].blocks.find((b) => b.id === next.id)!.startMin).toBe(next.startMin);
    // 余白の残りより長く遅れたら、足りない分だけ次の予定が遅れる
    const remain = buffer.endMin - buffer.startMin;
    const r2 = replan(itin, { type: "delay", minutes: remain + 20 }, ctx, { dayIndex: 0, nowMin: buffer.startMin });
    expect(r2.after.days[0].blocks.find((b) => b.id === next.id)!.startMin).toBeGreaterThan(next.startMin);
  });
});

/* ---------- EventParser ---------- */

const parseCtx = (over: Partial<ParseContext> = {}): ParseContext => {
  const itinerary = generateItinerary({ prefs: { ...demoPrefs, pace: "normal" }, ctx, startDate: SATURDAY });
  return { itinerary, ctx, dayIndex: 0, nowMin: 9 * 60 + 30, ...over };
};
const ok = (text: string, c = parseCtx()) => {
  const r = parseWithKeywords(text, c);
  if (!r.ok) throw new Error(`${text}: ${r.reason}`);
  return r.events;
};

describe("フェーズ6: EventParser（言葉 → 再計画のイベント。キーワード実装）", () => {
  it("疲れた: 「疲れた」は light、「かなり疲れた」「へとへと」は heavy", () => {
    expect(ok("ちょっと疲れた")[0].event).toEqual({ type: "tired", level: "light", source: "member" });
    expect(ok("少し休みたい")[0].event).toMatchObject({ type: "tired", level: "light" });
    expect(ok("かなり疲れた")[0].event).toMatchObject({ type: "tired", level: "heavy" });
    expect(ok("もうへとへと")[0].event).toMatchObject({ type: "tired", level: "heavy" });
    expect(ok("もう無理、歩けない")[0].event).toMatchObject({ type: "tired", level: "heavy" });
  });

  it("雨: これから先の屋外の予定（Plan B あり・未切替・終わっていない）を、雨を理由に切り替えるイベントにする", () => {
    const c = parseCtx();
    const [e] = ok("雨が降ってきた", c);
    expect(e.event.type).toBe("plan-b");
    if (e.event.type !== "plan-b") return;
    expect(e.event.cause).toBe("rain");
    const day = c.itinerary.days[0];
    for (const id of e.event.blockIds) {
      const b = day.blocks.find((x) => x.id === id)!;
      expect(b.planB).toBeTruthy();
      expect(b.endMin).toBeGreaterThan(c.nowMin);
    }
    // 終わった予定は含めない: 夜遅くに言うと、対象がない
    const late = parseWithKeywords("雨だ", parseCtx({ nowMin: 23 * 60 }));
    expect(late.ok).toBe(false);
  });

  it("雨が止んだ、は読み取らず、理由を返す", () => {
    const r = parseWithKeywords("雨が止んだ", parseCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("止んだ");
  });

  it("遅れ: 分・時間・半時間を読み取る。書かれていなければ15分と仮定して、仮定したことを返す", () => {
    expect(ok("電車が30分遅れてる")[0].event).toEqual({ type: "delay", minutes: 30 });
    expect(ok("電車が３０分遅延")[0].event).toEqual({ type: "delay", minutes: 30 }); // 全角
    expect(ok("1時間遅れる")[0].event).toEqual({ type: "delay", minutes: 60 });
    expect(ok("1時間半遅れ")[0].event).toEqual({ type: "delay", minutes: 90 });
    expect(ok("半時間遅れた")[0].event).toEqual({ type: "delay", minutes: 30 });
    const bare = ok("遅れそう")[0];
    expect(bare.event).toEqual({ type: "delay", minutes: 15 });
    expect(bare.assumed).toContain("15分と仮定");
    // 極端な値は丸める
    expect(ok("10時間遅れる")[0].event).toEqual({ type: "delay", minutes: 240 });
    expect(parseMinutes("45分")).toBe(45);
    expect(parseMinutes("遅れた")).toBeUndefined();
  });

  it("寄りたい: データにあるスポット名（別名も）はそのスポットに、ないものは自由入力の寄り道にする", () => {
    expect(findSpotMention("スタバに寄りたい", ctx)).toMatch(/starbucks/);
    expect(ok("櫛田神社に寄りたい")[0].event).toEqual({ type: "detour", stop: { spotId: "hakata-kushida" } });
    const free = ok("近くのパン屋さんに寄りたい")[0];
    expect(free.event).toEqual({ type: "detour", stop: { name: "パン屋さん", durationMin: 30 } });
    expect(free.assumed).toContain("自由入力");
    expect(ok("本屋に20分ほど寄り道したい")[0].event).toEqual({ type: "detour", stop: { name: "本屋", durationMin: 20 } });
    expect(parseWithKeywords("寄りたい", parseCtx()).ok).toBe(false);
  });

  it("複数の言葉は、複数のイベントになる（遅れ → 雨 → 寄り道 → 疲れた の順）", () => {
    const events = ok("電車が20分遅れて、雨も降ってきて、もう疲れた");
    expect(events.map((e) => e.event.type)).toEqual(["delay", "plan-b", "tired"]);
  });

  it("読み取れない言葉・空の入力は、理由を返す（落ちない）", () => {
    for (const text of ["", "   ", "おなかすいた", "こんにちは"]) {
      const r = parseWithKeywords(text, parseCtx());
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
    const r = parseWithKeywords("おなかすいた", parseCtx());
    if (!r.ok) expect(r.reason).toContain("疲れた・雨・遅れ・寄りたい");
  });

  it("差し替えポイント: eventParser は EventParser で、結果をそのまま再計画に渡せる（反映は提案を通す）", async () => {
    expect(eventParser).toBe(keywordEventParser);
    const c = parseCtx({ nowMin: 12 * 60 });
    const r = await eventParser.parse("電車が30分遅れてる", c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = replan(c.itinerary, r.events[0].event, c.ctx, { dayIndex: 0, nowMin: c.nowMin });
    expect(result.event).toEqual({ type: "delay", minutes: 30 });
    expect(result.before).toBe(c.itinerary); // 読み取っただけでは、旅程は変わらない
  });

  it("ExplanationWriter（理由の文章）も差し替えられる形で、テンプレートがある", () => {
    expect(typeof templateWriter.explain).toBe("function");
  });
});

/** 作業のチェックで見つけた4件の修正（回帰テスト） */
describe("フェーズ6のあと: チェックで見つけた不具合の修正", () => {
  it("食事制限で外れた行きたい店は、営業時間ではなく食事制限が理由だと警告する", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, dietary: ["no-pork"], mustSpotIds: ["tenjin-ippudo"] }, ctx, startDate: SATURDAY });
    const w = itin.days[0].warnings.join("\n");
    expect(w).toContain("「博多 一風堂 大名本店」は、食事制限（豚肉なし）に対応できないため");
    expect(w).not.toContain("「博多 一風堂 大名本店」を時間内に組み込めませんでした");
  });

  it("何も変わらない結果（過去の時刻の固定時刻）は、空振り（isNoOp）として扱い、重い変更にしない", async () => {
    const { classifyChange, isNoOp } = await import("@/core/policy");
    const itin = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const r = replan(itin, { type: "fixed-add", fixed: fixedEvent(10 * 60) }, ctx, { dayIndex: 0, nowMin: 17 * 60 });
    expect(isNoOp(r)).toBe(true);
    expect(classifyChange(r, ctx).weight).toBe("light");
    // 実際に変わる固定時刻の追加は、これまでどおり重い変更
    const real = replan(itin, { type: "fixed-add", fixed: fixedEvent(19 * 60) }, ctx, { dayIndex: 0 });
    expect(isNoOp(real)).toBe(false);
    expect(classifyChange(real, ctx).weight).toBe("heavy");
  });

  it("同じ名前のスポットが複数あるときは、文中のエリア名、なければいまいる場所に近いほうを選ぶ", () => {
    expect(findSpotMention("太宰府のスタバに寄りたい", ctx)).toBe("dazaifu-starbucks");
    expect(findSpotMention("大濠公園のスタバに寄りたい", ctx)).toBe("ohori-starbucks");
    const dazaifu = ctx.spotById.get("dazaifu-shrine")!;
    expect(findSpotMention("スタバに寄りたい", ctx, dazaifu)).toBe("dazaifu-starbucks");
  });

  it("「ラーメン」のような一般的な言葉は、特定の店に決め打ちせず、自由入力の寄り道にする", () => {
    expect(findSpotMention("ラーメン屋に寄りたい", ctx)).toBeUndefined();
    expect(ok("ラーメン屋に寄りたい")[0].event).toMatchObject({ type: "detour", stop: { name: "ラーメン屋" } });
  });

  it("「雨が止まって」は、遅れにも雨にも読まない。乗り物が止まったときだけ遅れと読む", () => {
    const r = parseWithKeywords("雨が止まって電車が動いた", parseCtx());
    expect(r.ok).toBe(false);
    expect(ok("電車が止まってる")[0].event).toEqual({ type: "delay", minutes: 15 });
  });
});
