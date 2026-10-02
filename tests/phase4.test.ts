import { describe, expect, it } from "vitest";
import { commitResult, type Versioned } from "@/core/history";
import { findUnknownSpots, inferMeals, MAX_STORED_CHARS, parseStored, serializeTrip, STORAGE_KEYS, STORAGE_VERSION, validateForSave } from "@/core/persist";
import { generateItinerary } from "@/core/planner";
import { replan, type ReplanEvent } from "@/core/replan";
import { itinerarySchema, LIMITS, parseItinerary, parseTripState } from "@/core/schema";
import { decodeItineraryResult, encodeItinerary, encodeItineraryChecked, MAX_SHARE_TOKEN_CHARS } from "@/core/share";
import type { Itinerary, Preferences } from "@/core/types";
import { demoPrefs, fixedEvent, hm, makeCtx, SATURDAY, wrapItinerary, dazaifuDay } from "./helpers";

const ctx = makeCtx();
const demo = (p: Partial<Preferences> = {}) => generateItinerary({ prefs: { ...demoPrefs, ...p }, ctx, startDate: SATURDAY });

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tokenOf = (payload: unknown) => b64url(JSON.stringify(payload));
const payloadOf = (itin: Itinerary): any => JSON.parse(Buffer.from(encodeItinerary(itin).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

describe("フェーズ4: 旅程のスキーマ（zod）", () => {
  it("アプリが作るすべての旅程（ペース・同行者・興味・Must・日数）が、スキーマを通る", () => {
    const interests: Preferences["interests"][] = [["gourmet", "cafe"], ["history", "art"], ["nature", "nightview"], ["shopping"]];
    let n = 0;
    for (const pace of ["relaxed", "normal", "packed"] as const)
      for (const companions of ["solo", "couple", "friends", "family"] as const)
        for (const ints of interests)
          for (const duration of ["day", "overnight"] as const) {
            const itin = demo({ pace, companions, interests: ints, duration, mustSpotIds: n % 3 === 0 ? ["dazaifu-shrine"] : [] });
            const r = parseItinerary(itin);
            expect(r.ok, r.ok ? "" : r.reason).toBe(true);
            n++;
          }
    expect(n).toBe(96);
  });

  it("再計画・実績・寄り道・暑さなどで変わった旅程も、スキーマを通る（履歴つきの保存データ全体も）", () => {
    let state: Versioned = { itinerary: wrapItinerary(dazaifuDay(ctx)), history: [] };
    const events: [ReplanEvent, number | undefined][] = [
      [{ type: "fixed-add", fixed: fixedEvent(hm(18)) }, undefined],
      [{ type: "delay", minutes: 40 }, hm(11)],
      [{ type: "tired", level: "heavy" }, hm(12)],
      [{ type: "detour", stop: { name: "お土産を見る", durationMin: 20 }, afterBlockId: "s1" }, hm(10, 30)],
      [{ type: "heat-rest", blockIds: ["s1"], minutes: 15 }, hm(10, 30)],
      [{ type: "progress", blockId: "s1", kind: "departed", atMin: hm(11, 20) }, hm(11, 20)],
      [{ type: "margin", marginMin: 20 }, undefined],
      [{ type: "skip", blockIds: ["s6"] }, hm(11)],
    ];
    for (const [event, now] of events) {
      const r = replan(state.itinerary, event, ctx, { dayIndex: 0, nowMin: now });
      state = commitResult(state, r, { atMin: now ?? 0, title: event.type });
      const v = parseItinerary(state.itinerary);
      expect(v.ok, `${event.type}: ${v.ok ? "" : v.reason}`).toBe(true);
    }
    const trip = { prefs: demoPrefs, itinerary: state.itinerary, today: { itinerary: state.itinerary, dayIndex: 0, nowMin: hm(12), history: state.history, dismissed: ["walk:d1b2"] } };
    const t = parseTripState(trip);
    expect(t.ok, t.ok ? "" : t.reason).toBe(true);
  });

  it("型が違う・範囲外・列挙にない値・配列の長さの上限超過は、理由つきで拒否する", () => {
    const base = demo();
    const bad = (mutate: (i: any) => void) => {
      const copy: any = structuredClone(base);
      mutate(copy);
      return parseItinerary(copy);
    };
    const cases: [string, (i: any) => void][] = [
      ["時刻が文字列", (i) => (i.days[0].blocks[0].startMin = "10:00")],
      ["時刻が巨大", (i) => (i.days[0].blocks[0].startMin = 10 ** 9)],
      ["時刻が NaN", (i) => (i.days[0].blocks[0].endMin = Number.NaN)],
      ["時刻が Infinity", (i) => (i.days[0].blocks[0].endMin = Number.POSITIVE_INFINITY)],
      ["ラベルが不正", (i) => (i.days[0].blocks[0].label = "boss")],
      ["日付が不正", (i) => (i.startDate = "来週の土曜")],
      ["ペースが不正", (i) => (i.prefs.pace = "dash")],
      ["余裕時間が負", (i) => (i.settings.marginMin = -5)],
      ["日数が0", (i) => (i.days = [])],
      ["日数が上限超過", (i) => (i.days = Array.from({ length: LIMITS.days + 1 }, () => structuredClone(i.days[0])))],
      ["ブロック数が上限超過", (i) => (i.days[0].blocks = Array.from({ length: LIMITS.blocksPerDay + 1 }, () => structuredClone(i.days[0].blocks[0])))],
      ["メンバー数が上限超過", (i) => (i.members = Array.from({ length: LIMITS.members + 1 }, (_, k) => ({ id: `m${k}`, name: "x" })))],
      ["文字列が長すぎる", (i) => (i.days[0].warnings = ["あ".repeat(LIMITS.textLen + 1)])],
      ["spotId が配列", (i) => (i.days[0].blocks[0].spotId = ["a"])],
      ["null の旅程", (i) => Object.keys(i).forEach((k) => delete i[k])],
    ];
    for (const [label, mutate] of cases) {
      const r = bad(mutate);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.reason.length, label).toBeGreaterThan(0);
    }
    expect(parseItinerary(null).ok).toBe(false);
    expect(parseItinerary("x").ok).toBe(false);
    expect(parseItinerary([]).ok).toBe(false);
    expect(itinerarySchema.safeParse(base).success).toBe(true);
  });

  it("余計な項目（__proto__ など）は取り除かれ、データを汚さない", () => {
    const polluted: any = JSON.parse(JSON.stringify(demo()).replace('"version":1', '"version":1,"__proto__":{"polluted":true},"extra":1'));
    const r = parseItinerary(polluted);
    expect(r.ok).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
    if (r.ok) expect((r.value as any).extra).toBeUndefined();
  });
});

describe("フェーズ4: 共有リンクの検証", () => {
  const good = () => payloadOf(demo({ duration: "overnight" }));

  it("正しいリンクは読め、巨大なリンク（8KB超）は読み込まず、作ることもしない", () => {
    const itin = demo({ duration: "overnight", pace: "packed" });
    const token = encodeItinerary(itin);
    expect(token.length).toBeLessThan(MAX_SHARE_TOKEN_CHARS);
    expect(decodeItineraryResult(token, ctx).ok).toBe(true);
    const checked = encodeItineraryChecked(itin);
    expect(checked.ok).toBe(true);

    const tooLong = decodeItineraryResult("A".repeat(MAX_SHARE_TOKEN_CHARS + 1), ctx);
    expect(tooLong).toMatchObject({ ok: false, code: "too-long" });
    // 作る側も、上限を超える旅程はリンクにしない
    const huge: any = structuredClone(itin);
    huge.days = Array.from({ length: LIMITS.days }, (_, i) => ({ ...structuredClone(itin.days[0]), index: i, blocks: Array.from({ length: 70 }, (_, k) => ({ ...structuredClone(itin.days[0].blocks[1]), id: `x${i}-${k}` })) }));
    const r = encodeItineraryChecked(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("大きすぎ");
  });

  it("壊れたリンク（型違い・巨大な配列・存在しないスポット・深いネスト・版違い・不正な文字）で落ちず、理由が返る", () => {
    const cases: [string, string, string][] = [
      ["空", "", "empty"],
      ["使えない文字", "not a token!!", "malformed"],
      ["途中で切れた", encodeItinerary(demo()).slice(0, 80), "malformed"],
      ["base64 だが JSON でない", b64url("これはJSONではありません"), "malformed"],
      ["配列でない", tokenOf({ a: 1 }), "invalid"],
      ["版が違う", tokenOf([99, "2026-10-03"]), "version"],
      ["日付が文字列でない", tokenOf([2, 20261003, [], [], []]), "invalid"],
      ["深いネスト", b64url("[".repeat(2800) + "]".repeat(2800)), "version|invalid|malformed"],
      ["深すぎるネスト", b64url("[".repeat(20000) + "]".repeat(20000)), "too-long"],
    ];
    const g = good();
    const mutate = (fn: (p: any) => void) => {
      const p = structuredClone(g);
      fn(p);
      return tokenOf(p);
    };
    cases.push(
      ["時刻が文字列", mutate((p) => (p[4][0][3][0][2] = "10:00")), "invalid"],
      ["時刻が巨大", mutate((p) => (p[4][0][3][0][2] = 1e12)), "invalid"],
      ["ブロックが多すぎる", mutate((p) => (p[4][0][3] = Array.from({ length: LIMITS.blocksPerDay + 5 }, () => structuredClone(g[4][0][3][0])))), "invalid"],
      ["日数が多すぎる", mutate((p) => (p[4] = Array.from({ length: LIMITS.days + 1 }, () => structuredClone(g[4][0])))), "invalid"],
      ["Must が配列でない", mutate((p) => (p[2][6] = "dazaifu-shrine")), "invalid"],
      ["ペースが不正", mutate((p) => (p[2][4] = "dash")), "invalid"],
      ["存在しないスポット（ブロック）", mutate((p) => (p[4][0][3][0][1] = "no-such-spot")), "unknown-spot"],
      ["存在しないスポット（Must）", mutate((p) => (p[2][6] = ["no-such-spot"])), "unknown-spot"],
      ["存在しない Plan B", mutate((p) => { const b = p[4][0][3].find((x: any) => x[5]); if (b) b[5] = "no-such-spot"; else p[3] = ["no-such-spot"]; }), "unknown-spot"],
      ["固定時刻の情報がない", mutate((p) => (p[4][0][3][0][0] = "f")), "invalid"],
      ["メンバー名が長すぎる", mutate((p) => (p[5] = [["m1", "あ".repeat(100)]])), "invalid"],
      ["null だらけ", tokenOf([2, null, null, null, null]), "invalid"],
    );
    for (const [label, token, code] of cases) {
      let r: ReturnType<typeof decodeItineraryResult> | undefined;
      expect(() => (r = decodeItineraryResult(token, ctx)), label).not.toThrow();
      expect(r?.ok, label).toBe(false);
      if (r && !r.ok) {
        expect(r.code, label).toMatch(new RegExp(`^(${code})$`));
        expect(r.reason.length, label).toBeGreaterThan(5);
      }
    }
  });

  it("スポットのデータが空でも落ちない（存在しないスポットとして拒否）。旧版（v1）のリンクも読める", () => {
    expect(decodeItineraryResult(encodeItinerary(demo()), makeCtx([])).ok).toBe(false);
    const p = payloadOf(demo());
    const v1 = [1, p[1], p[2], p[3], p[4].map((d: any[]) => [d[0], d[1], d[2], d[3], d[4]])];
    const r = decodeItineraryResult(tokenOf(v1), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.itinerary.members.length).toBeGreaterThan(0);
  });

  it("読み込んだ旅程は、そのまま保存してよい形（検証を通る）", () => {
    const r = decodeItineraryResult(encodeItinerary(demo({ duration: "overnight" })), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(parseItinerary(r.itinerary).ok).toBe(true);
      expect(validateForSave({ prefs: r.itinerary.prefs, itinerary: r.itinerary }).ok).toBe(true);
    }
  });
});

describe("フェーズ4: 保存データの検証・版管理", () => {
  const trip = () => ({ prefs: demoPrefs, itinerary: demo() });

  it("保存する前に検証する: 不正なデータは拒否され、正しいデータは往復で変わらない", () => {
    const ok = serializeTrip(trip());
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const back = parseStored(ok.value, "current");
    expect(back.status).toBe("ok");
    if (back.status === "ok") expect(JSON.parse(JSON.stringify(back.state))).toEqual(JSON.parse(JSON.stringify(trip())));
    // 不正
    const bad: any = trip();
    bad.itinerary.days[0].blocks[0].startMin = "x";
    expect(serializeTrip(bad)).toMatchObject({ ok: false });
    expect(validateForSave({ itinerary: "x" })).toMatchObject({ ok: false });
    expect(serializeTrip({})).toMatchObject({ ok: true }); // 空の状態は保存できる
    // 大きすぎる
    const big: any = trip();
    big.today = { itinerary: big.itinerary, dayIndex: 0, nowMin: 0, history: [], dismissed: Array.from({ length: 500 }, () => "x".repeat(140)) };
    expect(serializeTrip(big).ok).toBe(true);
    expect(MAX_STORED_CHARS).toBeGreaterThan(1_000_000);
  });

  it("保存の入れ物は { version: 3, state }。読み込みでは、壊れた・古い・新しすぎる・大きすぎるデータを区別する", () => {
    expect(STORAGE_VERSION).toBe(3);
    expect(STORAGE_KEYS.current).toBe("replan-fukuoka:v3");
    expect(STORAGE_KEYS.v2).toBe("replan-fukuoka:v2");
    const state = trip();
    const kind = (text: string, source: "current" | "v2" | "legacy" = "current") => {
      const r = parseStored(text, source);
      return r.status === "unreadable" ? r.kind : r.status;
    };
    expect(kind(JSON.stringify({ version: 3, state }))).toBe("ok");
    expect(kind("{壊れたJSON")).toBe("corrupt");
    expect(kind("[]")).toBe("corrupt");
    expect(kind(JSON.stringify({ state }))).toBe("corrupt"); // version がない
    expect(kind(JSON.stringify({ version: 3, state: { itinerary: { version: 1 } } }))).toBe("corrupt");
    expect(kind(JSON.stringify({ version: 4, state }))).toBe("newer");
    expect(kind(JSON.stringify({ version: 2, state }))).toBe("legacy");
    expect(kind("x".repeat(MAX_STORED_CHARS + 1))).toBe("too-large");
    expect(kind("{}", "legacy")).toBe("legacy");
  });

  it("v2（版なしの TripState）→ v3 に変換できる。読めない v2 は『古い形式』として確認に回す", () => {
    const v2 = JSON.stringify(trip());
    const r = parseStored(v2, "v2");
    expect(r.status).toBe("migrated");
    if (r.status === "migrated") {
      expect(r.from).toBe(2);
      expect(r.state.itinerary?.days.length).toBe(1);
      // 変換後は v3 として保存できる
      expect(serializeTrip(r.state).ok).toBe(true);
    }
    expect(parseStored("{壊れ", "v2")).toMatchObject({ status: "unreadable", kind: "legacy" });
    expect(parseStored(JSON.stringify({ itinerary: { version: 1 } }), "v2")).toMatchObject({ status: "unreadable", kind: "legacy" });
  });

  it("旧版の旅程には食事の印（meal）がないので、スポットの情報から推定して補う（昼・夜）", () => {
    const itin = demo();
    const stripped: any = structuredClone(itin);
    for (const d of stripped.days) for (const b of d.blocks) delete b.meal;
    const had = itin.days[0].blocks.filter((b) => b.meal).map((b) => [b.id, b.meal]);
    expect(had.length).toBeGreaterThan(0);
    const fixed: any = inferMeals({ itinerary: stripped } as any, ctx.spotById);
    const got = fixed.itinerary.days[0].blocks.filter((b: any) => b.meal).map((b: any) => [b.id, b.meal]);
    expect(got).toEqual(had);
    // もともと meal があるものは変えない
    const twice: any = inferMeals(fixed, ctx.spotById);
    expect(twice.itinerary.days[0].blocks).toEqual(fixed.itinerary.days[0].blocks);
  });

  it("保存データが、いまのデータにないスポットを参照していたら見つける", () => {
    const itin: any = demo();
    expect(findUnknownSpots({ itinerary: itin } as any, ctx.spotById)).toEqual([]);
    itin.days[0].blocks[0].spotId = "gone-spot";
    itin.prefs.mustSpotIds = ["gone-spot-2"];
    const unknown = findUnknownSpots({ itinerary: itin } as any, ctx.spotById);
    expect(unknown.sort()).toEqual(["gone-spot", "gone-spot-2"]);
    expect(findUnknownSpots({ itinerary: itin } as any, new Map())).not.toEqual([]);
  });
});
