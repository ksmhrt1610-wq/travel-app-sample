import { describe, expect, it } from "vitest";
import { createLocalGroupRepository, GROUP_BACKUP_KEY, GROUP_STORAGE_KEY } from "@/adapters/local/groupRepository";
import {
  aggregatePreferences,
  buildGroupPlans,
  decideDate,
  medianPace,
  memberSatisfaction,
  parseGroupState,
  scoreOf,
  satisfactionParts,
  SPLIT_THRESHOLD,
  tallyVotes,
  VOTE_WEIGHT,
  type GroupMember,
  type GroupPlanKind,
  type GroupState,
  type MemberInput,
} from "@/core/group";
import { CATEGORY_LABEL } from "@/core/labels";
import { dietOk } from "@/core/meals";
import { generateItinerary } from "@/core/planner";
import { replan } from "@/core/replan";
import { decodeItinerary, encodeItinerary } from "@/core/share";
import { parseItinerary } from "@/core/schema";
import type { DietaryRestriction, Itinerary, Pace } from "@/core/types";
import { DATES, MEMBERS, scenarioC } from "./groupFixtures";
import { demoPrefs, makeCtx, SATURDAY, spots } from "./helpers";

const ctx = makeCtx();

const base = (memberId: string, patch: Partial<MemberInput> = {}): MemberInput => ({
  memberId,
  availableDates: DATES,
  budgetCapYen: 10000,
  dietary: [],
  rainTolerance: "light-rain-ok",
  pace: "normal",
  interests: {},
  wantedSpotIds: [],
  ...patch,
});

const agg = (inputs: MemberInput[], members: GroupMember[] = MEMBERS, dates: string[] = DATES) =>
  aggregatePreferences({ members, inputs, candidateDates: dates, ctx });

const planSet = (inputs: MemberInput[], members: GroupMember[] = MEMBERS) => {
  const a = agg(inputs, members);
  return { a, set: buildGroupPlans({ members, inputs, agg: a, ctx }) };
};

const meals = (itin: Itinerary) => itin.days.flatMap((d) => d.blocks.filter((b) => b.meal && b.spotId));

describe("フェーズ5: 日程", () => {
  it("全員が参加できる日があれば、その日（複数あれば早い日）", () => {
    const inputs = [base("m1", { availableDates: ["2026-10-04", "2026-10-10"] }), base("m2", { availableDates: ["2026-10-10", "2026-10-04"] })];
    const d = decideDate(inputs, ["2026-10-10", "2026-10-04", "2026-10-17"]);
    expect(d).toMatchObject({ date: "2026-10-04", mode: "all", absentees: [] });
    expect(d.commonDates).toEqual(["2026-10-04", "2026-10-10"]);
  });

  it("全員が揃う日がないときは、参加者がいちばん多い日。欠席者を残す（同数なら早い日）", () => {
    const inputs = [
      base("m1", { availableDates: ["2026-10-03"] }),
      base("m2", { availableDates: ["2026-10-03", "2026-10-04"] }),
      base("m3", { availableDates: ["2026-10-04"] }),
      base("m4", { availableDates: ["2026-10-04"] }),
    ];
    const d = decideDate(inputs, ["2026-10-03", "2026-10-04"]);
    expect(d).toMatchObject({ date: "2026-10-04", mode: "most", attendeeCount: 3 });
    expect(d.absentees).toEqual(["m1"]);
    // 同数
    const tie = decideDate([base("m1", { availableDates: ["2026-10-03"] }), base("m2", { availableDates: ["2026-10-04"] })], ["2026-10-04", "2026-10-03"]);
    expect(tie.date).toBe("2026-10-03");
    expect(tie.absentees).toEqual(["m2"]);
  });

  it("共通の日が1日もなく、誰も参加できない候補日しかないときも、落ちずに仮の日を返す", () => {
    const d = decideDate([base("m1", { availableDates: [] }), base("m2", { availableDates: [] })], ["2026-10-03", "2026-10-04"]);
    expect(d.mode).toBe("none");
    expect(d.date).toBe("2026-10-03");
    expect(d.absentees).toEqual(["m1", "m2"]);
  });

  it("集約の調整ポイントに、日程の理由（欠席者の名前つき）が出る", () => {
    const inputs = [base("m1", { availableDates: ["2026-10-03"] }), base("m2", { availableDates: ["2026-10-04"] }), base("m3", { availableDates: ["2026-10-04"] })];
    const a = agg(inputs, MEMBERS.slice(0, 3));
    expect(a.adjustments.find((x) => x.kind === "date")?.text).toMatch(/3人中2人.*あおい/);
  });
});

describe("フェーズ5: 予算・雨・ペース・食事制限・好みの集約", () => {
  it("予算は最小、雨はいちばん慎重、食事制限は和集合", () => {
    const a = agg([
      base("m1", { budgetCapYen: 12000, rainTolerance: "dont-care", dietary: ["no-pork"] }),
      base("m2", { budgetCapYen: 6000, rainTolerance: "light-rain-ok", dietary: ["vegetarian", "no-pork"] }),
      base("m3", { budgetCapYen: 9000, rainTolerance: "no-outdoor" }),
    ], MEMBERS.slice(0, 3));
    expect(a.budgetCapYen).toBe(6000);
    expect(a.budget).toBe("normal");
    expect(a.rainTolerance).toBe("no-outdoor");
    expect(a.dietary).toEqual(["no-pork", "vegetarian"]);
  });

  it("ペースは中央値。偶数人で割れたら、ゆったり寄り（遅いほう）", () => {
    const p = (...list: Pace[]) => medianPace(list);
    expect(p("relaxed", "packed")).toBe("relaxed");
    expect(p("normal", "packed")).toBe("normal");
    expect(p("relaxed", "normal", "packed")).toBe("normal");
    expect(p("packed", "packed", "relaxed", "relaxed")).toBe("relaxed");
    expect(p("packed", "packed", "normal", "relaxed")).toBe("normal"); // 真ん中の2人が normal と packed → 遅いほう
    expect(p("packed", "packed", "packed")).toBe("packed");
    const a = agg([base("m1", { pace: "packed" }), base("m2", { pace: "relaxed" })], MEMBERS.slice(0, 2));
    expect(a.pace).toBe("relaxed");
  });

  it("好みの重みは、好き +2・どちらでも 0・苦手 −3 の合計", () => {
    expect(VOTE_WEIGHT).toEqual({ like: 2, neutral: 0, dislike: -3 });
    const a = agg(scenarioC());
    // gourmet: A like(+2) / nature: A dislike(-3) + B like(+2) = -1
    expect(a.interestWeights.gourmet).toBe(2);
    expect(a.interestWeights.nature).toBe(-1);
    expect(a.likedCategories).toContain("gourmet");
    expect(a.likedCategories).not.toContain("nature");
  });

  it("入力の順番が違っても、同じ結果になる", () => {
    const inputs = scenarioC();
    const a1 = agg(inputs);
    const a2 = agg([...inputs].reverse());
    expect(a2).toEqual(a1);
  });

  it("未回答の人は集約に入れず、その旨を調整ポイントに出す", () => {
    const a = agg(scenarioC().slice(0, 3));
    expect(a.excludedMemberIds).toEqual(["m4"]);
    expect(a.adjustments.some((x) => x.kind === "excluded" && x.text.includes("けん"))).toBe(true);
  });
});

describe("フェーズ5: 行きたい場所（Must）", () => {
  it("2人以上が希望した場所を先に Must にし、全員（希望のある人）が1件以上 Must に入る", () => {
    const a = agg(scenarioC());
    expect(a.mustSpotIds[0]).toBe("ohori-park"); // B と C の希望が重なった
    expect(a.mustReasons[0]).toMatchObject({ kind: "multi", memberIds: ["m2", "m3"] });
    // A の第1希望（一蘭）は、A の希望が1件も入っていないので足される
    expect(a.mustReasons[1]).toMatchObject({ spotId: "nakasu-ichiran", kind: "member-first", memberIds: ["m1"] });
    for (const inp of scenarioC().filter((i) => i.wantedSpotIds.length)) {
      expect(inp.wantedSpotIds.some((id) => a.mustSpotIds.includes(id))).toBe(true);
    }
  });

  it("重ならない希望は、各人の第1希望だけが Must。2件目は加点（softWishes）", () => {
    const inputs = [
      base("m1", { wantedSpotIds: ["tenjin-parco", "tenjin-rec"] }),
      base("m2", { wantedSpotIds: ["ohori-art", "ohori-teien"] }),
      base("m3", { wantedSpotIds: ["hakata-kushida"] }),
    ];
    const a = agg(inputs, MEMBERS.slice(0, 3));
    expect(a.mustSpotIds).toEqual(["tenjin-parco", "ohori-art", "hakata-kushida"]);
    expect(a.softWishes.map((s) => s.spotId).sort()).toEqual(["ohori-teien", "tenjin-rec"]);
    expect(a.mustReasons.every((r) => r.kind === "member-first")).toBe(true);
  });

  it("希望が重なった場所が複数あるときは、人数の多い順", () => {
    const inputs = [
      base("m1", { wantedSpotIds: ["tenjin-parco", "ohori-art"] }),
      base("m2", { wantedSpotIds: ["ohori-art", "tenjin-parco"] }),
      base("m3", { wantedSpotIds: ["ohori-art"] }),
    ];
    const a = agg(inputs, MEMBERS.slice(0, 3));
    expect(a.mustSpotIds).toEqual(["ohori-art", "tenjin-parco"]);
  });

  it("決めた日が定休日の希望は外し、その人の次の希望を第1希望として扱う。理由を残す", () => {
    // 九州国立博物館は月曜休み（2026-10-05 は月曜）
    const closedMonday = ctx.spotById.get("dazaifu-kyuhaku")!.closedDays;
    expect(closedMonday).toContain(1);
    const inputs = [
      base("m1", { availableDates: ["2026-10-05", "2026-10-06"], wantedSpotIds: ["dazaifu-kyuhaku", "tenjin-parco"] }),
      base("m2", { availableDates: ["2026-10-05", "2026-10-06"] }),
    ];
    const a = aggregatePreferences({ members: MEMBERS.slice(0, 2), inputs, candidateDates: ["2026-10-05", "2026-10-06"], ctx });
    expect(a.date.date).toBe("2026-10-05");
    expect(a.droppedWishes).toEqual([{ memberId: "m1", spotId: "dazaifu-kyuhaku", reason: "closed" }]);
    expect(a.mustSpotIds).toEqual(["tenjin-parco"]);
    expect(a.adjustments.some((x) => x.kind === "dropped" && x.text.includes("定休日"))).toBe(true);
  });

  it("食事制限に対応できない店の希望は、Must にしない（理由を残す）", () => {
    const inputs = [base("m1", { dietary: ["no-pork"], wantedSpotIds: ["tenjin-ippudo", "dazaifu-oishi"] }), base("m2")];
    const a = agg(inputs, MEMBERS.slice(0, 2));
    expect(a.droppedWishes).toEqual([{ memberId: "m1", spotId: "tenjin-ippudo", reason: "diet" }]);
    expect(a.mustSpotIds).toEqual(["dazaifu-oishi"]);
  });
});

describe("フェーズ5: 食事制限は、食事の店選びで必ず守る", () => {
  const cases: DietaryRestriction[][] = [["no-pork"], ["no-wheat"], ["no-pork", "no-wheat"], ["vegetarian"], ["no-seafood", "no-pork"]];

  it("旅程の生成: どの食事ブロックも、すべての制限に対応できる店", () => {
    for (const dietary of cases) {
      for (const pace of ["relaxed", "normal", "packed"] as Pace[]) {
        const itin = generateItinerary({ prefs: { ...demoPrefs, pace, dietary }, ctx, startDate: SATURDAY });
        for (const b of meals(itin)) expect(dietOk(ctx.spotById.get(b.spotId!)!, dietary), `${dietary} ${pace} ${b.spotId}`).toBe(true);
      }
    }
  });

  it("対応できる店がないときは、守れない店を入れずに、警告を出す", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, dietary: ["vegetarian", "no-wheat"] }, ctx, startDate: SATURDAY });
    expect(meals(itin)).toHaveLength(0);
    expect(itin.days[0].warnings.some((w) => w.includes("ベジタリアン") && w.includes("見つかりませんでした"))).toBe(true);
  });

  it("行きたい店（Must）でも、制限に対応できなければ入れない", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, dietary: ["no-pork"], mustSpotIds: ["tenjin-ippudo"] }, ctx, startDate: SATURDAY });
    expect(itin.days[0].blocks.some((b) => b.spotId === "tenjin-ippudo")).toBe(false);
  });

  it("再計画: 食事の店が休業して差し替えるときも、制限に対応できる店だけ", () => {
    const dietary: DietaryRestriction[] = ["no-pork"];
    const itin = generateItinerary({ prefs: { ...demoPrefs, dietary }, ctx, startDate: SATURDAY });
    for (const b of meals(itin)) {
      const r = replan(itin, { type: "closure", spotId: b.spotId! }, ctx, { dayIndex: 0 });
      for (const m of meals(r.after)) expect(dietOk(ctx.spotById.get(m.spotId!)!, dietary), `${b.spotId} → ${m.spotId}`).toBe(true);
    }
  });

  it("行きたい店（Must）は、朝に寄るのではなく食事の枠で使い、同じ食事を2回入れない", () => {
    for (const must of ["nakasu-ichiran", "nakasu-yatai", "tenjin-ippudo", "nakasu-mizutaki"]) {
      for (const pace of ["relaxed", "normal", "packed"] as Pace[]) {
        const itin = generateItinerary({ prefs: { ...demoPrefs, pace, mustSpotIds: [must] }, ctx, startDate: SATURDAY });
        const blocks = itin.days[0].blocks;
        const b = blocks.find((x) => x.spotId === must);
        if (!b) continue;
        expect(b.meal, `${must} ${pace}`).toBeDefined();
        for (const slot of ["lunch", "dinner"] as const) expect(blocks.filter((x) => x.meal === slot).length, `${must} ${pace} ${slot}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("共有リンク: 食事制限が往復で保たれる。旧形式（食事制限なし）のリンクもそのまま読める", () => {
    const itin = generateItinerary({ prefs: { ...demoPrefs, dietary: ["no-pork", "vegetarian"] }, ctx, startDate: SATURDAY });
    const back = decodeItinerary(encodeItinerary(itin), ctx);
    expect(back?.prefs.dietary).toEqual(["no-pork", "vegetarian"]);
    const plain = generateItinerary({ prefs: demoPrefs, ctx, startDate: SATURDAY });
    const back2 = decodeItinerary(encodeItinerary(plain), ctx);
    expect(back2?.prefs.dietary).toBeUndefined();
    expect(parseItinerary(itin).ok).toBe(true);
  });
});

describe("フェーズ5: 3案と満足度", () => {
  const { a: aggC, set: setC } = planSet(scenarioC());

  it("3案（バランス・合計いちばん・移動いちばん少ない）が、決めた日付・予算・ペースで作られる", () => {
    expect(setC.plans.map((p) => p.kind)).toEqual(["balanced", "max-sum", "least-travel"]);
    for (const p of setC.plans) {
      expect(p.itinerary.startDate).toBe(aggC.date.date);
      expect(p.itinerary.prefs.pace).toBe(aggC.pace);
      expect(p.itinerary.prefs.budget).toBe(aggC.budget);
      expect(p.itinerary.days).toHaveLength(1);
      expect(parseItinerary(p.itinerary).ok).toBe(true);
    }
    expect(setC.candidateCount).toBeGreaterThan(3);
  });

  it("バランス案の最小満足度は、合計いちばん案の最小満足度以上（シナリオC）", () => {
    const bal = setC.plans.find((p) => p.kind === "balanced")!;
    const sum = setC.plans.find((p) => p.kind === "max-sum")!;
    expect(bal.minScore).toBeGreaterThanOrEqual(sum.minScore);
  });

  it("バランス案の最小満足度 ≧ 合計いちばん案の最小満足度（いろいろな4人組で）", () => {
    const interestsPool: MemberInput["interests"][] = [
      { gourmet: "like", nature: "dislike" },
      { nature: "like", history: "like", shopping: "dislike" },
      { cafe: "like", art: "like", gourmet: "dislike" },
      { shopping: "like", nightview: "like", history: "dislike" },
      {},
      { art: "dislike", cafe: "dislike" },
    ];
    const paces: Pace[] = ["relaxed", "normal", "packed"];
    for (let seed = 0; seed < 6; seed++) {
      const inputs = MEMBERS.map((m, i) =>
        base(m.id, {
          interests: interestsPool[(seed + i * 2) % interestsPool.length],
          pace: paces[(seed + i) % 3],
          rainTolerance: (["no-outdoor", "light-rain-ok", "dont-care"] as const)[(seed * 2 + i) % 3],
          budgetCapYen: 6000 + ((seed + i) % 4) * 3000,
          wantedSpotIds: i % 2 === 0 ? [["ohori-art", "tenjin-parco", "hakata-kushida", "ohori-park"][(seed + i) % 4]] : [],
        }),
      );
      const { set } = planSet(inputs);
      const bal = set.plans.find((p) => p.kind === "balanced")!;
      const sum = set.plans.find((p) => p.kind === "max-sum")!;
      expect(bal.minScore, `seed ${seed}`).toBeGreaterThanOrEqual(sum.minScore);
      for (const p of set.plans) for (const s of p.satisfaction) expect(s.score).toBeGreaterThanOrEqual(0), expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it("移動いちばん少ない案は、3案の中で移動時間が最小（同じ予算・食事の条件の中で）", () => {
    const lt = setC.plans.find((p) => p.kind === "least-travel")!;
    const others = setC.plans.filter((p) => p.kind !== "least-travel");
    // 他の案との同点・次点の案（note あり）を除いて比べる
    if (!lt.note) for (const o of others) expect(lt.travelMin).toBeLessThanOrEqual(o.travelMin);
    expect(lt.travelMin).toBeGreaterThan(0);
  });

  it("結果は決まった乱数だけを使うので、同じ入力なら、同じ3案になる", () => {
    const again = planSet(scenarioC()).set;
    const sig = (s: typeof setC) => s.plans.map((p) => p.itinerary.days[0].blocks.map((b) => `${b.spotId ?? b.label}@${b.startMin}`).join(","));
    expect(sig(again)).toEqual(sig(setC));
  });

  it("各予定に「誰の希望か」が付く（希望した人の ID）", () => {
    for (const p of setC.plans) {
      const spots = new Set(p.itinerary.days[0].blocks.map((b) => b.spotId));
      expect(Object.keys(p.requestedBy).every((id) => spots.has(id))).toBe(true);
      if (spots.has("ohori-park")) expect(p.requestedBy["ohori-park"].sort()).toEqual(["m2", "m3"]);
      if (spots.has("nakasu-ichiran")) expect(p.requestedBy["nakasu-ichiran"]).toEqual(["m1"]);
    }
    // Must は、すべての案に入る
    for (const p of setC.plans) for (const id of aggC.mustSpotIds) expect(p.itinerary.days[0].blocks.some((b) => b.spotId === id), `${p.kind} ${id}`).toBe(true);
  });

  it("グループの食事制限は、3案すべての食事で守られる", () => {
    const inputs = scenarioC().map((i, k) => (k === 1 ? { ...i, dietary: ["no-pork"] as DietaryRestriction[] } : k === 2 ? { ...i, dietary: ["no-wheat"] as DietaryRestriction[] } : i));
    const { a, set } = planSet(inputs);
    expect(a.dietary).toEqual(["no-pork", "no-wheat"]);
    for (const p of set.plans) for (const b of meals(p.itinerary)) expect(dietOk(ctx.spotById.get(b.spotId!)!, a.dietary), `${p.kind} ${b.spotId}`).toBe(true);
  });

  it("満足度: 行きたい場所が入ると上がり、好きなカテゴリが多いと上がる。値は 0〜100", () => {
    const itin = setC.plans[0].itinerary;
    const wanted = itin.days[0].blocks.find((b) => b.spotId && !b.meal)!.spotId!;
    const without = base("x", { wantedSpotIds: ["tenjin-parco"] });
    const withWish = base("x", { wantedSpotIds: [wanted] });
    const s1 = memberSatisfaction(without, itin, ctx).score;
    const s2 = memberSatisfaction(withWish, itin, ctx).score;
    expect(s2).toBeGreaterThan(s1);
    const lover = base("y", { interests: Object.fromEntries(Object.keys(CATEGORY_LABEL).map((c) => [c, "like"])) });
    const hater = base("z", { interests: Object.fromEntries(Object.keys(CATEGORY_LABEL).map((c) => [c, "dislike"])) });
    expect(memberSatisfaction(lover, itin, ctx).score).toBeGreaterThan(memberSatisfaction(hater, itin, ctx).score);
    for (const i of [lover, hater, without, withWish]) {
      const sc = memberSatisfaction(i, itin, ctx).score;
      expect(sc).toBeGreaterThanOrEqual(0);
      expect(sc).toBeLessThanOrEqual(100);
    }
    expect(scoreOf({ interest: 1, wish: 1, pace: 1, rain: 1, budget: 1 })).toBe(100);
    expect(scoreOf({ interest: 0, wish: 0, pace: 0, rain: 0, budget: 0 })).toBe(0);
    // 行きたい場所がない人は、その項目を使わない
    expect(scoreOf({ interest: 1, wish: null, pace: 1, rain: 1, budget: 1 })).toBe(100);
    expect(satisfactionParts(withWish, itin, ctx).wishHit).toBe(1);
  });

  it("「希望が大きく割れています」: どの案でも、誰かの満足度が 40 未満のときだけ立つ", () => {
    // 選べるスポットが、アートとショッピングだけの世界。あおいはその両方が苦手 → どの案でも満足度が低い
    const narrow = makeCtx(spots.filter((s) => s.category === "art" || s.category === "shopping"));
    const inputs = [
      base("m1", { interests: { art: "dislike", shopping: "dislike", gourmet: "like" } }),
      base("m2", { interests: { art: "like", shopping: "like" } }),
    ];
    const members = MEMBERS.slice(0, 2);
    const a = aggregatePreferences({ members, inputs, candidateDates: DATES, ctx: narrow });
    const set = buildGroupPlans({ members, inputs, agg: a, ctx: narrow });
    for (const p of set.plans) expect(p.satisfaction[0].score, p.kind).toBeLessThan(SPLIT_THRESHOLD);
    expect(set.split).toBe(true);
    // 揃った入力（シナリオC）や、同じ2人でも全スポットから選べるときは、立たない
    expect(planSet(scenarioC()).set.split).toBe(false);
    const wide = planSet(inputs, members).set;
    expect(wide.split).toBe(wide.plans.every((p) => p.minScore < SPLIT_THRESHOLD));
    expect(wide.split).toBe(false);
  });

  it("満足度の理由に、具体的な「苦手」（カテゴリ名）は出ない", () => {
    const inputs = scenarioC();
    const { set } = planSet(inputs);
    const text = JSON.stringify(set.plans.map((p) => p.satisfaction));
    // A（あおい）は「自然・公園」が苦手。それを示す言葉は理由に出ない
    expect(text).not.toContain(CATEGORY_LABEL.nature);
    expect(text).not.toMatch(/苦手|嫌い|dislike/);
  });
});

describe("フェーズ5: プライバシー（他の人の予算額と「苦手」は、集約・共有に出ない）", () => {
  it("集約の結果に、他の人の予算額（最小以外）や苦手の回答が含まれない", () => {
    const inputs = scenarioC();
    const a = agg(inputs);
    const json = JSON.stringify(a);
    for (const other of [10000, 12000, 15000]) expect(json).not.toContain(String(other));
    expect(json).not.toMatch(/dislike|budgetCapYen":(10000|12000|15000)/);
    expect(a.budgetCapYen).toBe(8000); // 決めた上限だけが出る
    // 調整ポイントの文にも、苦手なカテゴリや個別の予算額は出ない
    const text = a.adjustments.map((x) => x.text).join("\n");
    expect(text).not.toMatch(/15,000|12,000|10,000/);
    expect(text).not.toContain(CATEGORY_LABEL.nature);
  });

  it("確定した旅程を共有リンクにしても、他の人の予算額・苦手・回答は含まれない", () => {
    const { a, set } = planSet(scenarioC());
    const itin = set.plans[0].itinerary;
    const token = encodeItinerary(itin);
    const raw = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    for (const other of ["10000", "12000", "15000", "8000"]) expect(raw).not.toContain(other);
    expect(raw).not.toMatch(/dislike|like|budgetCap|availableDates|wantedSpot/);
    // 旅程そのものにも、個人の回答のフィールドはない
    expect(JSON.stringify(itin)).not.toMatch(/dislike|budgetCapYen|availableDates|wantedSpotIds/);
    expect(a.budgetCapYen).toBe(8000);
  });
});

describe("フェーズ5: 投票", () => {
  const ids = ["m1", "m2", "m3", "m4"];
  const v = (...k: GroupPlanKind[]) => Object.fromEntries(k.map((x, i) => [ids[i], x])) as Record<string, GroupPlanKind>;

  it("全員が投票するまで決まらない。過半数でなくても、最多票で決まる", () => {
    const t = tallyVotes(v("balanced", "balanced"), ids, "m1");
    expect(t).toMatchObject({ complete: false, winner: null, voted: 2, total: 4 });
    const done = tallyVotes(v("balanced", "balanced", "max-sum", "least-travel"), ids, "m1");
    expect(done).toMatchObject({ complete: true, winner: "balanced", decidedBy: "majority" });
  });

  it("同票なら主催者の票を優先する", () => {
    const t = tallyVotes(v("balanced", "max-sum", "max-sum", "balanced"), ids, "m2");
    expect(t).toMatchObject({ winner: "max-sum", decidedBy: "organizer-vote" });
    expect(tallyVotes(v("balanced", "max-sum", "max-sum", "balanced"), ids, "m1")).toMatchObject({ winner: "balanced", decidedBy: "organizer-vote" });
  });

  it("同票で主催者の票も同票の案に入っていないときは、主催者が同票の案から選ぶ", () => {
    const t = tallyVotes(v("balanced", "max-sum", "max-sum", "balanced"), ids, "m3");
    expect(t.winner).toBe("max-sum"); // m3 は max-sum に投票
    const t2 = tallyVotes({ m1: "balanced", m2: "max-sum", m3: "least-travel", m4: "least-travel" }, ids, "m1");
    expect(t2.winner).toBe("least-travel"); // 最多票
    const t3 = tallyVotes({ m1: "least-travel", m2: "balanced", m3: "max-sum", m4: "balanced" }, ["m1", "m2", "m3", "m4"], "m1");
    expect(t3.winner).toBe("balanced");
    const t4 = tallyVotes({ m1: "least-travel", m2: "balanced", m3: "max-sum", m4: "max-sum", m5: "balanced" }, ["m1", "m2", "m3", "m4", "m5"], "m1");
    expect(t4).toMatchObject({ winner: null, needsOrganizerChoice: ["balanced", "max-sum"] });
  });
});

describe("フェーズ5: グループの保存（GroupRepository）", () => {
  const mem = () => {
    const data = new Map<string, string>();
    return {
      data,
      store: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) },
    };
  };
  const state = (): GroupState => ({
    version: 1,
    id: "g1",
    createdAt: "2026-10-01T00:00:00Z",
    organizerId: "m1",
    members: MEMBERS,
    candidateDates: DATES,
    inputs: Object.fromEntries(scenarioC().map((i) => [i.memberId, i])),
    votes: { m1: "balanced" },
  });

  it("保存して読み込める。保存の前に検証し、不正なデータは保存しない", async () => {
    const { data, store } = mem();
    const repo = createLocalGroupRepository(() => store);
    expect((await repo.load()).state).toBeNull();
    expect(await repo.save(state())).toEqual({ ok: true });
    expect((await repo.load()).state).toEqual(state());
    const bad = { ...state(), members: [state().members[0]] } as GroupState; // 1人だけ
    const r = await repo.save(bad);
    expect(r.ok).toBe(false);
    expect(JSON.parse(data.get(GROUP_STORAGE_KEY)!).members).toHaveLength(4); // 前の状態のまま
  });

  it("壊れた保存データは issue として返し、勝手に消さない。バックアップを選べる", async () => {
    const { data, store } = mem();
    data.set(GROUP_STORAGE_KEY, "{壊れた");
    const repo = createLocalGroupRepository(() => store);
    const r = await repo.load();
    expect(r.state).toBeNull();
    expect(r.issue?.reason).toContain("JSON");
    expect(data.get(GROUP_STORAGE_KEY)).toBe("{壊れた");
    await repo.clear({ backup: true });
    expect(data.get(GROUP_BACKUP_KEY)).toBe("{壊れた");
    expect(data.has(GROUP_STORAGE_KEY)).toBe(false);
  });

  it("スキーマ: メンバーは2〜6人、候補日は2〜4日、希望は2件まで、主催者はメンバーの中", () => {
    const ok = state();
    expect(parseGroupState(ok).ok).toBe(true);
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, name: `n${i}` }));
    expect(parseGroupState({ ...ok, members: many, organizerId: "x0", inputs: {}, votes: {} }).ok).toBe(false);
    expect(parseGroupState({ ...ok, candidateDates: ["2026-10-03"] }).ok).toBe(false);
    expect(parseGroupState({ ...ok, candidateDates: ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"] }).ok).toBe(false);
    expect(parseGroupState({ ...ok, organizerId: "nobody" }).ok).toBe(false);
    const three = { ...ok, inputs: { ...ok.inputs, m1: { ...ok.inputs.m1, wantedSpotIds: ["a", "b", "c"] } } };
    expect(parseGroupState(three).ok).toBe(false);
    expect(parseGroupState({ ...ok, inputs: { ...ok.inputs, m1: { ...ok.inputs.m1, budgetCapYen: "8000" } } }).ok).toBe(false);
    expect(parseGroupState({ ...ok, votes: { m9: "balanced" } }).ok).toBe(false);
  });
});
