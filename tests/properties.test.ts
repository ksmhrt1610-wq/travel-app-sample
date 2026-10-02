import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  aggregatePreferences,
  buildGroupPlans,
  decideDate,
  medianPace,
  memberSatisfaction,
  tallyVotes,
  type GroupMember,
  type GroupPlanKind,
  type MemberInput,
} from "@/core/group";
import { commitResult, undoLast } from "@/core/history";
import { dietOk, MEAL_ADJUST_WINDOW } from "@/core/meals";
import { generateItinerary } from "@/core/planner";
import { classifyChange } from "@/core/policy";
import { replan, type ReplanEvent } from "@/core/replan";
import { DAY_END_TOLERANCE_MIN, isInert } from "@/core/schedule";
import { parseItinerary } from "@/core/schema";
import { decodeItinerary, encodeItinerary } from "@/core/share";
import type { Block, DietaryRestriction, Itinerary, Pace, Preferences } from "@/core/types";
import { fixedEvent, makeCtx } from "./helpers";

/**
 * フェーズ6: プロパティテスト（fast-check）。
 * 手で選んだ入力ではなく、ランダムな入力に対しても成り立つはずのこと（不変条件）を確かめる。
 * 失敗したときは、fast-check が最小の反例（seed と path）を出す。
 */

// FC_RUNS を増やして回すと時間がかかるので、タイムアウトは長めにする
vi.setConfig({ testTimeout: 300_000 });

const ctx = makeCtx();
const NUM_RUNS = Number(process.env.FC_RUNS ?? 40);
const opts = { numRuns: NUM_RUNS };

/* ---------- 入力の生成 ---------- */

const CATEGORIES = ["gourmet", "cafe", "history", "nature", "shopping", "art", "nightview"] as const;
/** 土・日・月（九州国立博物館などが休み）・水 */
const DATES = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-07"];
const MUST_POOL = ["ohori-park", "ohori-art", "tenjin-parco", "hakata-kushida", "dazaifu-shrine", "dazaifu-kyuhaku", "momochi-tower", "nakasu-yatai", "tenjin-ippudo"];
const DIETS: DietaryRestriction[] = ["no-pork", "no-seafood", "no-wheat", "vegetarian"];

const prefsArb: fc.Arbitrary<Preferences> = fc.record({
  duration: fc.constantFrom("day" as const, "overnight" as const),
  companions: fc.constantFrom("solo" as const, "couple" as const, "friends" as const, "family" as const),
  budget: fc.constantFrom("saving" as const, "normal" as const, "luxury" as const),
  interests: fc.uniqueArray(fc.constantFrom(...CATEGORIES), { minLength: 1, maxLength: 4 }),
  pace: fc.constantFrom("relaxed" as const, "normal" as const, "packed" as const),
  rainTolerance: fc.constantFrom("no-outdoor" as const, "light-rain-ok" as const, "dont-care" as const),
  mustSpotIds: fc.uniqueArray(fc.constantFrom(...MUST_POOL), { maxLength: 2 }),
});

const dietArb = fc.uniqueArray(fc.constantFrom(...DIETS), { maxLength: 2 });
const dateArb = fc.constantFrom(...DATES);

/** 1日の旅程（日帰り）を作る */
const dayTrip = (prefs: Preferences, date: string): Itinerary => generateItinerary({ prefs: { ...prefs, duration: "day" }, ctx, startDate: date, id: "prop" });

const active = (b: Block) => !isInert(b);

/** 時刻が順番に並び、重ならない */
function expectOrdered(itin: Itinerary) {
  for (const d of itin.days) {
    const blocks = d.blocks.filter(active);
    for (const b of blocks) {
      expect(b.endMin, `${b.id} 終了≧開始`).toBeGreaterThanOrEqual(b.startMin);
      // 余白（buffer）は、遅れや空きを吸収して伸び縮みするので、滞在時間と一致しない。それ以外は一致する
      if (b.label !== "buffer") expect(b.endMin - b.startMin, `${b.id} 長さ`).toBe(b.durationMin);
    }
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].startMin, `${blocks[i - 1].id} → ${blocks[i].id}`).toBeGreaterThanOrEqual(blocks[i - 1].endMin);
  }
}

describe("プロパティ: 旅程の生成", () => {
  it("どんな入力でも、時刻は順番に並んで重ならず、同じスポットを2回入れない", () => {
    fc.assert(
      fc.property(prefsArb, dateArb, (prefs, date) => {
        const itin = generateItinerary({ prefs, ctx, startDate: date });
        expectOrdered(itin);
        const ids = itin.days.flatMap((d) => d.blocks.filter(active).map((b) => b.spotId).filter(Boolean));
        expect(new Set(ids).size).toBe(ids.length);
        expect(parseItinerary(itin).ok).toBe(true);
      }),
      opts,
    );
  });

  it("営業時間・休業日・終了予定時刻の問題（issues）がない。食事は食事向けの店で、食事の窓に収まる", () => {
    fc.assert(
      fc.property(prefsArb, dateArb, (prefs, date) => {
        const itin = generateItinerary({ prefs, ctx, startDate: date });
        for (const d of itin.days) {
          for (const b of d.blocks.filter(active)) {
            expect(b.issues ?? [], `${b.spotId}`).toEqual([]);
            if (b.meal) {
              const sp = ctx.spotById.get(b.spotId!)!;
              expect(sp.mealSlots).toContain(b.meal);
              expect(b.startMin).toBeGreaterThanOrEqual(MEAL_ADJUST_WINDOW[b.meal].earliest);
              expect(b.endMin).toBeLessThanOrEqual(MEAL_ADJUST_WINDOW[b.meal].latest);
            }
          }
          // 同じ食事（ランチ・ディナー）は1日に1回まで
          for (const slot of ["lunch", "dinner"] as const) expect(d.blocks.filter((b) => b.meal === slot && active(b)).length).toBeLessThanOrEqual(1);
        }
      }),
      opts,
    );
  });

  it("行きたい場所（Must）は、入れられなかったときに警告が出る（黙って落とさない）", () => {
    fc.assert(
      fc.property(prefsArb, dateArb, (prefs, date) => {
        const itin = generateItinerary({ prefs, ctx, startDate: date });
        const inPlan = new Set(itin.days.flatMap((d) => d.blocks.filter(active).map((b) => b.spotId)));
        const warnings = itin.days.flatMap((d) => d.warnings).join("\n");
        for (const id of prefs.mustSpotIds) {
          if (inPlan.has(id)) continue;
          expect(warnings, `${id} が入らないのに警告がない`).toContain(ctx.spotById.get(id)!.name);
        }
      }),
      opts,
    );
  });

  it("食事制限があるとき、どの食事の店も、すべての制限に対応できる", () => {
    fc.assert(
      fc.property(prefsArb, dateArb, dietArb, (prefs, date, dietary) => {
        const itin = generateItinerary({ prefs: { ...prefs, dietary }, ctx, startDate: date });
        for (const d of itin.days) for (const b of d.blocks.filter((x) => active(x) && x.meal)) expect(dietOk(ctx.spotById.get(b.spotId!)!, dietary)).toBe(true);
      }),
      opts,
    );
  });

  it("同じ入力なら、同じ旅程（決定的）。共有リンクで往復しても、予定が変わらない", () => {
    fc.assert(
      fc.property(prefsArb, dateArb, (prefs, date) => {
        const a = generateItinerary({ prefs, ctx, startDate: date, id: "x", createdAt: "t" });
        const b = generateItinerary({ prefs, ctx, startDate: date, id: "x", createdAt: "t" });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        const back = decodeItinerary(encodeItinerary(a), ctx);
        expect(back).not.toBeNull();
        const sig = (it: Itinerary) => it.days.map((d) => d.blocks.map((x) => `${x.label}:${x.spotId ?? ""}:${x.startMin}-${x.endMin}:${x.meal ?? ""}`));
        expect(sig(back!)).toEqual(sig(a));
      }),
      opts,
    );
  });
});

/* ---------- 再計画 ---------- */

/** 旅程のブロックの中から、イベントを作る（fast-check の整数で選ぶ） */
function eventFrom(itin: Itinerary, kind: number, pick: number, amount: number): ReplanEvent | null {
  const blocks = itin.days[0].blocks.filter((b) => active(b) && !b.fixed);
  const spots = blocks.filter((b) => b.spotId && b.label !== "buffer" && b.label !== "rest");
  const nth = <T,>(list: T[]) => (list.length ? list[pick % list.length] : undefined);
  switch (kind % 6) {
    case 0:
      return { type: "delay", minutes: 5 + (amount % 116) };
    case 1: {
      // Must・食事でない予定の臨時休業
      const b = nth(spots.filter((x) => x.label !== "must" && !x.meal));
      return b ? { type: "closure", spotId: b.spotId! } : null;
    }
    case 2:
      return { type: "tired", level: amount % 2 ? "heavy" : "light" };
    case 3: {
      const outdoor = spots.filter((x) => x.planB && !x.switched).map((x) => x.id);
      return outdoor.length ? { type: "plan-b", blockIds: outdoor, cause: "rain" } : null;
    }
    case 4: {
      const b = nth(spots.filter((x) => x.label === "optional" || x.label === "normal"));
      return b ? { type: "skip", blockIds: [b.id] } : null;
    }
    default:
      // 帰りの最終便（15:00〜19:00）
      return { type: "fixed-add", fixed: fixedEvent(15 * 60 + (amount % 241), { id: "" }) };
  }
}

const replanCase = fc.tuple(prefsArb, dateArb, fc.nat(), fc.nat(), fc.nat(), fc.option(fc.integer({ min: 9 * 60, max: 18 * 60 }), { nil: undefined }));

describe("プロパティ: 再計画エンジン", () => {
  it("問題が解消できた（feasible）組み直しは、時刻が順番に並んで重ならない。解消できなければ violations に出る", () => {
    fc.assert(
      fc.property(replanCase, ([prefs, date, kind, pick, amount, now]) => {
        const itin = dayTrip(prefs, date);
        const ev = eventFrom(itin, kind, pick, amount);
        if (!ev) return;
        const r = replan(itin, ev, ctx, { dayIndex: 0, nowMin: now });
        // 解消できない問題（始まっている予定が固定時刻に重なる、など）があるときは、重なりが残ってよい（violations に出す）
        if (r.feasible) expectOrdered(r.after);
        // 問題（営業時間・固定時刻・食事の窓・最終便・終了予定時刻の大幅な超過）が残っているのは、始まっていない予定についてだけ数える
        const day = r.after.days[0];
        const issues = day.blocks
          .filter((b) => active(b) && (now === undefined || b.startMin > now))
          .flatMap((b) => (b.issues ?? []).filter((i) => i !== "over-day-end" || b.endMin > day.endMin + DAY_END_TOLERANCE_MIN));
        // feasible ⇔ 問題がない
        expect(r.feasible, `${ev.type}`).toBe(issues.length === 0);
        if (!r.feasible) expect(r.violations.length).toBeGreaterThan(0);
      }),
      opts,
    );
  });

  it("終わった予定は書き換えない。始まっている予定の開始時刻も動かさない（進行中の予定を Plan B に替えるときだけ例外）", () => {
    fc.assert(
      fc.property(replanCase, ([prefs, date, kind, pick, amount, now]) => {
        const itin = dayTrip(prefs, date);
        const at = now ?? 13 * 60;
        const ev = eventFrom(itin, kind, pick, amount);
        if (!ev) return;
        const r = replan(itin, ev, ctx, { dayIndex: 0, nowMin: at });
        const after = new Map(r.after.days[0].blocks.map((b) => [b.id, b]));
        const switching = ev.type === "plan-b" ? new Set(ev.blockIds) : new Set<string>();
        for (const b of itin.days[0].blocks.filter((x) => active(x) && x.startMin <= at)) {
          const a = after.get(b.id);
          expect(a, `${b.id} が消えた`).toBeDefined();
          const finished = b.endMin <= at;
          if (finished || !switching.has(b.id)) {
            expect(a!.startMin, `${ev.type}: ${b.id} 開始`).toBe(b.startMin);
            expect(a!.spotId, `${ev.type}: ${b.id} スポット`).toBe(b.spotId);
          }
          if (finished) expect(a!.endMin, `${ev.type}: ${b.id} 終了`).toBe(b.endMin);
        }
      }),
      opts,
    );
  });

  it("行きたい場所（Must）と食事は、確認なしには削らない（休業した店は、差し替えか確認）", () => {
    fc.assert(
      fc.property(replanCase, ([prefs, date, kind, pick, amount, now]) => {
        const itin = dayTrip(prefs, date);
        const ev = eventFrom(itin, kind, pick, amount);
        if (!ev) return;
        const r = replan(itin, ev, ctx, { dayIndex: 0, nowMin: now });
        const after = new Map(r.after.days[0].blocks.map((b) => [b.id, b]));
        const asked = ev.type === "skip" ? new Set(ev.blockIds) : new Set<string>(); // ユーザー自身の「スキップ」は、外すことが操作そのもの
        for (const b of itin.days[0].blocks.filter((x) => active(x) && !x.fixed && (x.label === "must" || x.meal) && !asked.has(x.id))) {
          const a = after.get(b.id);
          expect(a && active(a), `${ev.type}: ${b.spotId}（${b.label}${b.meal ? "・" + b.meal : ""}）が確認なしに外れた`).toBe(true);
        }
      }),
      opts,
    );
  });

  it("何かを削ったり替えたりしたら、必ず理由（cause）が付く", () => {
    fc.assert(
      fc.property(replanCase, ([prefs, date, kind, pick, amount, now]) => {
        const itin = dayTrip(prefs, date);
        const ev = eventFrom(itin, kind, pick, amount);
        if (!ev) return;
        const r = replan(itin, ev, ctx, { dayIndex: 0, nowMin: now });
        for (const d of r.diff.filter((x) => ["removed", "skipped", "shortened", "replaced", "closed"].includes(x.kind))) {
          expect(d.cause ?? d.reason, `${ev.type}: ${d.kind} ${d.blockId} に理由がない`).toBeDefined();
        }
      }),
      opts,
    );
  });

  it("「軽い」と分類された変更は、Must・標準・食事の予定を外さない", () => {
    fc.assert(
      fc.property(replanCase, ([prefs, date, kind, pick, amount, now]) => {
        const itin = dayTrip(prefs, date);
        const ev = eventFrom(itin, kind, pick, amount);
        if (!ev) return;
        const r = replan(itin, ev, ctx, { dayIndex: 0, nowMin: now });
        if (classifyChange(r, ctx).weight !== "light") return;
        const after = new Map(r.after.days[0].blocks.map((b) => [b.id, b]));
        for (const b of itin.days[0].blocks.filter((x) => active(x) && !x.fixed && (x.label === "must" || x.label === "normal" || x.meal))) {
          const a = after.get(b.id);
          // ユーザー自身の「スキップ」は、外すことが操作そのもの
          if (ev.type === "skip" && ev.blockIds.includes(b.id)) continue;
          expect(a && active(a), `${ev.type}: ${b.spotId} が軽い変更で外れた`).toBe(true);
        }
      }),
      opts,
    );
  });

  it("反映したあとに「元に戻す」と、反映前の旅程にぴったり戻る", () => {
    fc.assert(
      fc.property(replanCase, ([prefs, date, kind, pick, amount, now]) => {
        const itin = dayTrip(prefs, date);
        const ev = eventFrom(itin, kind, pick, amount);
        if (!ev) return;
        const r = replan(itin, ev, ctx, { dayIndex: 0, nowMin: now });
        const state = { itinerary: itin, history: [] as never[] };
        const next = commitResult(state, r, { atMin: now ?? 0, title: ev.type });
        const back = undoLast(next);
        expect(JSON.stringify(back.itinerary)).toBe(JSON.stringify(itin));
        expect(back.history).toHaveLength(0);
      }),
      opts,
    );
  });

  it("食事制限があるとき、再計画で食事の店が変わっても、対応できる店のまま", () => {
    fc.assert(
      fc.property(prefsArb, dateArb, dietArb, fc.nat(), fc.nat(), (prefs, date, dietary, pick, amount) => {
        const itin = dayTrip({ ...prefs, dietary }, date);
        const meals = itin.days[0].blocks.filter((b) => active(b) && b.meal);
        if (!meals.length) return;
        const target = meals[pick % meals.length];
        const events: ReplanEvent[] = [
          { type: "closure", spotId: target.spotId! },
          { type: "delay", minutes: 30 + (amount % 90) },
          { type: "tired", level: "heavy" },
        ];
        for (const ev of events) {
          const r = replan(itin, ev, ctx, { dayIndex: 0 });
          for (const b of r.after.days[0].blocks.filter((x) => active(x) && x.meal)) expect(dietOk(ctx.spotById.get(b.spotId!)!, dietary), `${ev.type} → ${b.spotId}`).toBe(true);
        }
      }),
      opts,
    );
  });
});

/* ---------- グループ ---------- */

const MEMBER_NAMES = ["あおい", "ゆうと", "みさき", "けん", "ひなた", "りく"];
const groupArb = fc
  .integer({ min: 2, max: 6 })
  .chain((n) =>
    fc.tuple(
      fc.constant(n),
      fc.array(
        fc.record({
          dates: fc.subarray(DATES.slice(0, 3), { minLength: 0 }),
          budget: fc.constantFrom(3000, 5000, 8000, 10000, 15000),
          diet: fc.uniqueArray(fc.constantFrom(...DIETS), { maxLength: 1 }),
          rain: fc.constantFrom("no-outdoor" as const, "light-rain-ok" as const, "dont-care" as const),
          pace: fc.constantFrom("relaxed" as const, "normal" as const, "packed" as const),
          votes: fc.array(fc.constantFrom("like" as const, "neutral" as const, "dislike" as const), { minLength: 7, maxLength: 7 }),
          wishes: fc.uniqueArray(fc.constantFrom(...MUST_POOL, "ohori-teien", "tenjin-rec"), { maxLength: 2 }),
        }),
        { minLength: n, maxLength: n },
      ),
    ),
  )
  .map(([n, list]) => {
    const members: GroupMember[] = Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, name: MEMBER_NAMES[i] }));
    const inputs: MemberInput[] = list.map((m, i) => ({
      memberId: members[i].id,
      availableDates: m.dates,
      budgetCapYen: m.budget,
      dietary: m.diet,
      rainTolerance: m.rain,
      pace: m.pace,
      interests: Object.fromEntries(CATEGORIES.map((c, k) => [c, m.votes[k]])),
      wantedSpotIds: m.wishes,
    }));
    return { members, inputs };
  });

const GROUP_DATES = DATES.slice(0, 3);

describe("プロパティ: グループの集約", () => {
  it("集約は、入力の順番に依存しない。予算は最小・食事制限は和集合・ペースは最小と最大の間・日付は候補日の中", () => {
    fc.assert(
      fc.property(groupArb, ({ members, inputs }) => {
        const a = aggregatePreferences({ members, inputs, candidateDates: GROUP_DATES, ctx });
        const b = aggregatePreferences({ members, inputs: [...inputs].reverse(), candidateDates: GROUP_DATES, ctx });
        expect(b).toEqual(a);
        expect(a.budgetCapYen).toBe(Math.min(...inputs.map((i) => i.budgetCapYen)));
        expect(new Set(a.dietary)).toEqual(new Set(inputs.flatMap((i) => i.dietary)));
        const idx = { relaxed: 0, normal: 1, packed: 2 } as const;
        const paces = inputs.map((i) => idx[i.pace]);
        expect(idx[a.pace]).toBeGreaterThanOrEqual(Math.min(...paces));
        expect(idx[a.pace]).toBeLessThanOrEqual(Math.max(...paces));
        expect(GROUP_DATES).toContain(a.date.date);
        // 全員が参加できる日があるなら、その日になる
        const common = GROUP_DATES.filter((d) => inputs.every((i) => i.availableDates.includes(d)));
        if (common.length) expect(a.date).toMatchObject({ mode: "all", date: common[0] });
        // 決めた日に参加できない人は、欠席者に出る
        for (const id of a.date.absentees) expect(inputs.find((i) => i.memberId === id)!.availableDates).not.toContain(a.date.date);
      }),
      opts,
    );
  });

  it("希望を出した人（食事制限・定休日で外れていない）は、全員が1件以上 Must に入る。集約に個人の予算・苦手は出ない", () => {
    fc.assert(
      fc.property(groupArb, ({ members, inputs }) => {
        const a = aggregatePreferences({ members, inputs, candidateDates: GROUP_DATES, ctx });
        const dropped = new Set(a.droppedWishes.map((d) => `${d.memberId}:${d.spotId}`));
        for (const inp of inputs) {
          const ok = inp.wantedSpotIds.filter((id) => !dropped.has(`${inp.memberId}:${id}`));
          if (ok.length) expect(ok.some((id) => a.mustSpotIds.includes(id)), `${inp.memberId}`).toBe(true);
        }
        expect(a.mustSpotIds.length).toBe(new Set(a.mustSpotIds).size);
        expect(JSON.stringify(a)).not.toMatch(/dislike/);
        // 決めた上限以外の予算額は出ない
        for (const other of new Set(inputs.map((i) => i.budgetCapYen))) if (other !== a.budgetCapYen) expect(JSON.stringify(a)).not.toContain(String(other));
      }),
      { numRuns: Math.max(10, Math.floor(NUM_RUNS / 2)) },
    );
  });

  it("3案: 満足度は 0〜100 の整数。バランス案の最小満足度 ≧ 合計いちばん案の最小満足度。食事制限は守られる", () => {
    fc.assert(
      fc.property(groupArb, ({ members, inputs }) => {
        const a = aggregatePreferences({ members, inputs, candidateDates: GROUP_DATES, ctx });
        const set = buildGroupPlans({ members, inputs, agg: a, ctx });
        expect(set.plans).toHaveLength(3);
        const bal = set.plans.find((p) => p.kind === "balanced")!;
        const sum = set.plans.find((p) => p.kind === "max-sum")!;
        expect(bal.minScore).toBeGreaterThanOrEqual(sum.minScore);
        for (const p of set.plans) {
          expect(p.satisfaction).toHaveLength(members.length);
          for (const s of p.satisfaction) {
            expect(Number.isInteger(s.score)).toBe(true);
            expect(s.score).toBeGreaterThanOrEqual(0);
            expect(s.score).toBeLessThanOrEqual(100);
            // 理由の文に、苦手の言葉は出ない
            expect(s.reasons.join("")).not.toMatch(/苦手|嫌い/);
          }
          expectOrdered(p.itinerary);
          for (const b of p.itinerary.days[0].blocks.filter((x) => active(x) && x.meal)) expect(dietOk(ctx.spotById.get(b.spotId!)!, a.dietary)).toBe(true);
          // 案の満足度は、いつでも同じ旅程から再計算できる
          const again = memberSatisfaction(inputs[0], p.itinerary, ctx);
          expect(again.score).toBe(p.satisfaction[0].score);
        }
      }),
      { numRuns: Math.max(8, Math.floor(NUM_RUNS / 3)) },
    );
  });
});

describe("プロパティ: 日程・ペース・投票", () => {
  it("決める日は候補日のどれか。参加者が最多の日が選ばれる", () => {
    fc.assert(
      fc.property(fc.array(fc.subarray(GROUP_DATES), { minLength: 1, maxLength: 6 }), (avail) => {
        const inputs = avail.map((dates, i) => ({ memberId: `m${i}`, availableDates: dates } as MemberInput));
        const d = decideDate(inputs, GROUP_DATES);
        expect(GROUP_DATES).toContain(d.date);
        const count = (x: string) => inputs.filter((i) => i.availableDates.includes(x)).length;
        for (const x of GROUP_DATES) expect(count(d.date)).toBeGreaterThanOrEqual(count(x));
        expect(d.attendeeCount).toBe(count(d.date));
        expect(d.absentees.length).toBe(inputs.length - d.attendeeCount);
      }),
      { numRuns: 100 },
    );
  });

  it("ペースの中央値: 偶数人で割れたら、遅いほう。順番に依存しない", () => {
    const paceArb = fc.constantFrom("relaxed" as Pace, "normal" as Pace, "packed" as Pace);
    fc.assert(
      fc.property(fc.array(paceArb, { minLength: 1, maxLength: 8 }), (list) => {
        const idx = { relaxed: 0, normal: 1, packed: 2 } as const;
        const sorted = list.map((p) => idx[p]).sort((a, b) => a - b);
        const expected = sorted[Math.floor((sorted.length - 1) / 2)];
        expect(idx[medianPace(list)]).toBe(expected);
        expect(medianPace([...list].reverse())).toBe(medianPace(list));
      }),
      { numRuns: 200 },
    );
  });

  it("投票: 全員が投票したときだけ決まる。勝った案は最多票（同票なら主催者の票）", () => {
    const kindArb = fc.constantFrom("balanced" as GroupPlanKind, "max-sum" as GroupPlanKind, "least-travel" as GroupPlanKind);
    fc.assert(
      fc.property(fc.array(fc.option(kindArb, { nil: undefined }), { minLength: 2, maxLength: 6 }), fc.nat(), (picks, orgPick) => {
        const ids = picks.map((_, i) => `m${i}`);
        const votes: Record<string, GroupPlanKind> = {};
        picks.forEach((p, i) => p && (votes[ids[i]] = p));
        const organizer = ids[orgPick % ids.length];
        const t = tallyVotes(votes, ids, organizer);
        expect(t.complete).toBe(picks.every(Boolean));
        if (!t.complete) {
          expect(t.winner).toBeNull();
          return;
        }
        if (t.winner) {
          expect(t.counts[t.winner]).toBe(Math.max(...Object.values(t.counts)));
          if (t.decidedBy === "organizer-vote") expect(votes[organizer]).toBe(t.winner);
        } else {
          // 同票で、主催者の票も同票の案に入っていない
          expect(t.needsOrganizerChoice!.length).toBeGreaterThan(1);
          expect(t.needsOrganizerChoice).not.toContain(votes[organizer]);
        }
      }),
      { numRuns: 300 },
    );
  });
});
