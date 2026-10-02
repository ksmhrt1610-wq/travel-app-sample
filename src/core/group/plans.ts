import { generateItinerary, missingMealCount } from "../planner";
import { dayWalking, WALK_LIMIT_KM } from "../walking";
import type { GenerateInput, InterestCategory, Itinerary, PlanningContext, Preferences, Spot } from "../types";
import { ALL_CATEGORIES } from "./aggregate";
import { estimateCostYen, memberSatisfaction, planTravel, scoreOf, satisfactionParts, spotAffinity } from "./satisfaction";
import {
  SPLIT_THRESHOLD,
  type GroupAggregate,
  type GroupMember,
  type GroupPlan,
  type GroupPlanKind,
  type GroupPlanSet,
  type MemberInput,
} from "./types";

/** 旅程生成の加点の大きさ。全員が「好き」(+2) のカテゴリで、interestPrimary（3.0）と同じくらい効く */
export const BIAS_SCALE = 1.5;
/** 「行きたい場所」（Must にならなかったもの）を、希望した人1人あたりこれだけ加点する */
export const SOFT_WISH_BONUS = 1.2;

const KIND_TITLE: Record<GroupPlanKind, string> = {
  balanced: "バランス案",
  "max-sum": "合計いちばん案",
  "least-travel": "移動いちばん少ない案",
};
const KIND_BLURB: Record<GroupPlanKind, string> = {
  balanced: "いちばん不満な人の満足度が、できるだけ高くなる案",
  "max-sum": "全員の満足度の合計が、いちばん高くなる案",
  "least-travel": "移動が、いちばん少なくなる案",
};

/** 旅程づくりに渡す条件（集約の結果から）。興味は、スポットごとの加点（spotBias）で表すので空にする */
export function groupPreferences(agg: GroupAggregate): Preferences {
  return {
    duration: "day",
    companions: agg.memberIds.length === 2 ? "couple" : "friends",
    budget: agg.budget,
    interests: [],
    pace: agg.pace,
    rainTolerance: agg.rainTolerance,
    mustSpotIds: agg.mustSpotIds,
    ...(agg.dietary.length ? { dietary: agg.dietary } : {}),
  };
}

/** 確定する旅程に入れる条件。興味は、全員の好みの合計が正のカテゴリ（再計画のスコアに使う） */
export function finalPreferences(agg: GroupAggregate): Preferences {
  return { ...groupPreferences(agg), interests: agg.likedCategories };
}

/** メンバーごとの重み（合計 1）で、スポットの加点を作る。食事の店は「苦手」の減点をしない（満足度の計算と同じ） */
export function makeBias(inputs: MemberInput[], weights: number[], agg: GroupAggregate, jitter?: (spot: Spot) => number): (spot: Spot) => number {
  const wishers = new Map(agg.softWishes.map((s) => [s.spotId, s.memberIds.length]));
  return (spot) => {
    let a = 0;
    inputs.forEach((inp, i) => {
      const v = spotAffinity(inp.interests, spot);
      a += weights[i] * (spot.mealSlots?.length ? Math.max(0, v) : v);
    });
    return BIAS_SCALE * a + SOFT_WISH_BONUS * (wishers.get(spot.id) ?? 0) + (jitter ? jitter(spot) : 0);
  };
}

/** 決まった乱数（同じ入力なら、いつも同じ案になる）。候補の幅を広げるための小さな揺らぎに使う */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** スポットごとの揺らぎ（±JITTER）。スポットのIDから決めるので、同じ候補の中では一定 */
export const JITTER = 1.0;
const JITTER_CANDIDATES = 8;
function jitterFor(seed: number): (spot: Spot) => number {
  return (spot) => {
    let h = seed;
    for (let i = 0; i < spot.id.length; i++) h = (Math.imul(h, 31) + spot.id.charCodeAt(i)) >>> 0;
    return (seeded(h)() * 2 - 1) * JITTER;
  };
}

interface Candidate {
  itinerary: Itinerary;
  sig: string;
  scores: number[];
  min: number;
  sum: number;
  travelMin: number;
  walkingM: number;
  costYen: number;
  /** 費用の目安が、決めた予算の上限以内 */
  within: boolean;
  /** 1日の歩行距離の見込みが、ペース別の目安（WALK_LIMIT_KM）以内 */
  walkOk: boolean;
  /** ランチ・ディナーが、入るはずの分だけ入っている */
  mealsOk: boolean;
}

const signature = (itin: Itinerary) => itin.days.map((d) => d.blocks.map((b) => `${b.spotId ?? b.label}@${b.startMin}`).join(",")).join("|");

function evaluate(itin: Itinerary, inputs: MemberInput[], ctx: PlanningContext, agg: GroupAggregate): Candidate {
  const scores = inputs.map((inp) => scoreOf(satisfactionParts(inp, itin, ctx)));
  const { travelMin, walkingM } = planTravel(itin, ctx);
  const costYen = estimateCostYen(itin, ctx);
  return {
    itinerary: itin,
    sig: signature(itin),
    scores,
    min: Math.min(...scores),
    sum: scores.reduce((a, b) => a + b, 0),
    travelMin,
    walkingM,
    costYen,
    within: costYen <= agg.budgetCapYen,
    mealsOk: itin.days.every((d) => missingMealCount(d) === 0),
    walkOk: itin.days.every((d) => dayWalking(d, ctx, itin.prefs.pace).totalM <= WALK_LIMIT_KM[itin.prefs.pace] * 1000),
  };
}

const uniform = (n: number) => Array.from({ length: n }, () => 1 / n);
const normalize = (w: number[]) => {
  const s = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / s);
};

/**
 * 候補の旅程を、重みや移動の減点を変えて十数件作る。
 *   全員均等 → 満足度の低い人の重みを上げて作り直す（数回）／ 1人を重視する案 ／ 移動を強く減点する案
 * 同じ旅程は1つにまとめる。
 */
export function buildCandidates(
  agg: GroupAggregate,
  inputs: MemberInput[],
  ctx: PlanningContext,
  generate: (input: GenerateInput) => Itinerary = generateItinerary,
): Candidate[] {
  const n = inputs.length;
  const prefs = groupPreferences(agg);
  const out = new Map<string, Candidate>();
  const add = (weights: number[], travelScale = 1, seed?: number, limitWalking = true): Candidate => {
    const itin = generate({
      prefs,
      ctx,
      startDate: agg.date.date,
      id: "group-draft",
      options: { spotBias: makeBias(inputs, weights, agg, seed === undefined ? undefined : jitterFor(seed)), travelPenaltyScale: travelScale, limitWalking },
    });
    const c = evaluate(itin, inputs, ctx, agg);
    if (!out.has(c.sig)) out.set(c.sig, c);
    return out.get(c.sig)!;
  };

  // 1. 全員均等 → 満足度の低い人の重みを上げていく
  let w = uniform(n);
  let cur = add(w);
  for (const gamma of [1.5, 1.5, 3, 3]) {
    const mean = cur.scores.reduce((a, b) => a + b, 0) / n;
    w = normalize(w.map((x, i) => x * Math.exp((-gamma * (cur.scores[i] - mean)) / 20)));
    cur = add(w);
  }
  // 2. 1人を重視する案（その人の重み 0.5、残りで 0.5 を分ける）
  for (let i = 0; i < n; i++) add(normalize(Array.from({ length: n }, (_, j) => (j === i ? 0.5 : 0.5 / Math.max(1, n - 1)))));
  // 3. 移動を強く減点する案（均等・バランス寄り）
  for (const scale of [2, 4]) {
    add(uniform(n), scale);
    add(w, scale);
  }
  // 4. 小さな揺らぎを入れた案（決まった乱数。同じ入力なら同じ結果）。選べる旅程の幅を広げる
  for (let seed = 1; seed <= JITTER_CANDIDATES; seed++) {
    add(seed % 2 ? uniform(n) : w, seed % 3 === 0 ? 2 : 1, seed);
  }
  // 5. 歩行距離の目安にこだわらない案（予定が多めで、空きの少ない1日になりやすい）
  add(uniform(n), 1, undefined, false);
  add(w, 1, undefined, false);
  for (let seed = 1; seed <= JITTER_CANDIDATES / 2; seed++) add(seed % 2 ? uniform(n) : w, 1, seed, false);
  return [...out.values()];
}

const tieBreak = (a: Candidate, b: Candidate, ...keys: ((c: Candidate) => number)[]) => {
  for (const k of keys) {
    const d = k(a) - k(b);
    if (d !== 0) return d;
  }
  return a.sig.localeCompare(b.sig);
};

/** 候補から3案を選ぶ。バランス案は、合計最大案も含む候補全体の最小値で選ぶので、最小満足度が合計最大案を下回らない */
export function selectPlans(cands: Candidate[]): { kind: GroupPlanKind; cand: Candidate; note?: string }[] {
  // 食事が揃っている → 予算の上限以内 → 歩行距離の目安以内 の順に絞る（絞った結果が空なら、その条件は外す）
  const narrow = (list: Candidate[], ok: (c: Candidate) => boolean) => (list.some(ok) ? list.filter(ok) : list);
  const pool = narrow(narrow(narrow(cands, (c) => c.mealsOk), (c) => c.within), (c) => c.walkOk);
  const better: Record<GroupPlanKind, (a: Candidate, b: Candidate) => number> = {
    // 小さいほうが先（ソート用）
    balanced: (a, b) => tieBreak(b, a, (c) => c.min, (c) => c.sum, (c) => -c.travelMin),
    "max-sum": (a, b) => tieBreak(b, a, (c) => c.sum, (c) => c.min, (c) => -c.travelMin),
    "least-travel": (a, b) => tieBreak(a, b, (c) => c.travelMin, (c) => -c.sum, (c) => -c.min),
  };
  const taken = new Set<string>();
  const out: { kind: GroupPlanKind; cand: Candidate; note?: string }[] = [];
  for (const kind of ["balanced", "max-sum", "least-travel"] as GroupPlanKind[]) {
    const ranked = [...pool].sort(better[kind]);
    const fresh = ranked.find((c) => !taken.has(c.sig));
    const cand = fresh ?? ranked[0];
    const note = !fresh
      ? "候補が少なく、ほかの案と同じ内容になりました"
      : ranked[0].sig !== fresh.sig
        ? "この目的でいちばん良い案が、ほかの案と同じ内容だったため、次に良い案です"
        : undefined;
    taken.add(cand.sig);
    out.push({ kind, cand, note });
  }
  return out;
}

export interface BuildOptions {
  members: GroupMember[];
  inputs: MemberInput[];
  agg: GroupAggregate;
  ctx: PlanningContext;
  generate?: (input: GenerateInput) => Itinerary;
}

/** 3案（バランス／合計最大／移動最少）を作る。満足度と、予定ごとの「誰の希望か」も付ける */
export function buildGroupPlans({ inputs, agg, ctx, generate }: BuildOptions): GroupPlanSet {
  const cands = buildCandidates(agg, inputs, ctx, generate);
  const picked = selectPlans(cands);
  const wishers = new Map<string, string[]>();
  for (const inp of inputs) for (const id of new Set(inp.wantedSpotIds)) wishers.set(id, [...(wishers.get(id) ?? []), inp.memberId]);

  const plans: GroupPlan[] = picked.map(({ kind, cand, note }) => {
    const itinerary: Itinerary = { ...cand.itinerary, id: `group-${kind}`, prefs: finalPreferences(agg) };
    const satisfaction = inputs.map((inp) => memberSatisfaction(inp, itinerary, ctx));
    const requestedBy: Record<string, string[]> = {};
    for (const d of itinerary.days) for (const b of d.blocks) if (b.spotId && wishers.has(b.spotId)) requestedBy[b.spotId] = wishers.get(b.spotId)!;
    const scores = satisfaction.map((s) => s.score);
    return {
      kind,
      title: KIND_TITLE[kind],
      blurb: KIND_BLURB[kind],
      itinerary,
      satisfaction,
      minScore: Math.min(...scores),
      sumScore: scores.reduce((a, b) => a + b, 0),
      travelMin: cand.travelMin,
      walkingM: cand.walkingM,
      estimatedCostYen: cand.costYen,
      withinBudget: cand.within,
      withinWalkLimit: cand.walkOk,
      requestedBy,
      note,
    };
  });
  return { plans, split: plans.every((p) => p.minScore < SPLIT_THRESHOLD), candidateCount: cands.length };
}

export type { InterestCategory };
export { ALL_CATEGORIES };
