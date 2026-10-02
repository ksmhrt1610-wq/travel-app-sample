import { isOpenOnDate } from "../availability";
import { CATEGORY_LABEL, PACE_LABEL, RAIN_LABEL } from "../labels";
import { DIET_LABEL, DIET_ORDER, mealDietOk } from "../meals";
import { formatDateJa } from "../time";
import type { Budget, DietaryRestriction, InterestCategory, Pace, PlanningContext, RainTolerance } from "../types";
import {
  VOTE_WEIGHT,
  type Adjustment,
  type DateDecision,
  type DroppedWish,
  type GroupAggregate,
  type GroupMember,
  type MemberInput,
  type MustReason,
} from "./types";

export const ALL_CATEGORIES: InterestCategory[] = ["gourmet", "cafe", "history", "nature", "shopping", "art", "nightview"];

const PACE_INDEX: Record<Pace, number> = { relaxed: 0, normal: 1, packed: 2 };
const PACE_BY_INDEX: Pace[] = ["relaxed", "normal", "packed"];
/** 雨への慎重さ（小さいほど慎重） */
const RAIN_STRICTNESS: Record<RainTolerance, number> = { "no-outdoor": 0, "light-rain-ok": 1, "dont-care": 2 };

/** 1人1日の予算の上限（円）→ 旅程生成の予算帯。境界はここで調整できる */
export const BUDGET_LEVEL_BOUNDS = { savingBelowYen: 4000, normalBelowYen: 9000 } as const;

export function budgetLevelOf(capYen: number): Budget {
  if (capYen < BUDGET_LEVEL_BOUNDS.savingBelowYen) return "saving";
  if (capYen < BUDGET_LEVEL_BOUNDS.normalBelowYen) return "normal";
  return "luxury";
}

/** 日程: 全員が参加できる日。なければ参加者がいちばん多い日（同数なら早い日）。欠席者を残す */
export function decideDate(inputs: MemberInput[], candidateDates: string[]): DateDecision {
  const dates = [...new Set(candidateDates)].sort();
  if (!dates.length) throw new Error("候補日がありません");
  const attendees = (d: string) => inputs.filter((i) => i.availableDates.includes(d));
  const common = dates.filter((d) => attendees(d).length === inputs.length);
  if (common.length) return { date: common[0], mode: "all", commonDates: common, absentees: [], attendeeCount: inputs.length };

  let best = dates[0];
  let bestCount = attendees(best).length;
  for (const d of dates.slice(1)) {
    const n = attendees(d).length;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  const present = new Set(attendees(best).map((i) => i.memberId));
  return {
    date: best,
    mode: bestCount === 0 ? "none" : "most",
    commonDates: [],
    absentees: inputs.filter((i) => !present.has(i.memberId)).map((i) => i.memberId),
    attendeeCount: bestCount,
  };
}

/** ペースの中央値。偶数人で真ん中が割れたら、ゆったり寄り（遅いほう） */
export function medianPace(paces: Pace[]): Pace {
  const sorted = paces.map((p) => PACE_INDEX[p]).sort((a, b) => a - b);
  return PACE_BY_INDEX[sorted[Math.floor((sorted.length - 1) / 2)]];
}

export function strictestRain(list: RainTolerance[]): RainTolerance {
  return list.reduce((a, b) => (RAIN_STRICTNESS[b] < RAIN_STRICTNESS[a] ? b : a));
}

export function unionDietary(list: DietaryRestriction[][]): DietaryRestriction[] {
  const set = new Set(list.flat());
  return DIET_ORDER.filter((d) => set.has(d));
}

/** 全員の好み（好き +2／どちらでも 0／苦手 −3）の合計 */
export function interestWeights(inputs: MemberInput[]): Record<InterestCategory, number> {
  const out = {} as Record<InterestCategory, number>;
  for (const c of ALL_CATEGORIES) out[c] = inputs.reduce((n, i) => n + VOTE_WEIGHT[i.interests[c] ?? "neutral"], 0);
  return out;
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

interface Params {
  members: GroupMember[];
  /** 回答済みの人の入力 */
  inputs: MemberInput[];
  candidateDates: string[];
  ctx: PlanningContext;
}

/**
 * 全員の入力から、旅程づくりの条件を決める（純粋関数）。
 *   日程: 全員の共通日 → なければ最多人数の日（欠席者を残す）
 *   予算: 最小 / 食事制限: 和集合 / 雨: いちばん慎重 / ペース: 中央値（偶数で割れたら遅いほう）
 *   好み: 好き+2・どちらでも0・苦手−3 の合計
 *   行きたい場所: 2人以上が希望した場所を先に Must に。全員が1件以上 Must に入るよう、足りない人の第1希望を足す
 * 結果には、他の人の予算額と「苦手」の回答を含めない。
 */
export function aggregatePreferences({ members, inputs: rawInputs, candidateDates, ctx }: Params): GroupAggregate {
  const order = new Map(members.map((m, i) => [m.id, i]));
  const inputs = rawInputs.filter((i) => order.has(i.memberId)).sort((a, b) => order.get(a.memberId)! - order.get(b.memberId)!);
  if (!inputs.length) throw new Error("回答が1件もありません");
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? "（不明）";
  const answered = new Set(inputs.map((i) => i.memberId));
  const excluded = members.filter((m) => !answered.has(m.id));

  const date = decideDate(inputs, candidateDates);
  const budgetCapYen = Math.min(...inputs.map((i) => i.budgetCapYen));
  const dietary = unionDietary(inputs.map((i) => i.dietary));
  const rainTolerance = strictestRain(inputs.map((i) => i.rainTolerance));
  const pace = medianPace(inputs.map((i) => i.pace));
  const weights = interestWeights(inputs);
  const likedCategories = ALL_CATEGORIES.filter((c) => weights[c] > 0).sort((a, b) => weights[b] - weights[a] || ALL_CATEGORIES.indexOf(a) - ALL_CATEGORIES.indexOf(b));

  /* ---- 行きたい場所 ---- */
  const dropped: DroppedWish[] = [];
  const okWishes = new Map<string, string[]>();
  for (const inp of inputs) {
    const list: string[] = [];
    for (const id of [...new Set(inp.wantedSpotIds)].slice(0, 2)) {
      const sp = ctx.spotById.get(id);
      if (!sp) dropped.push({ memberId: inp.memberId, spotId: id, reason: "unknown" });
      else if (!isOpenOnDate(sp, date.date)) dropped.push({ memberId: inp.memberId, spotId: id, reason: "closed" });
      else if (!mealDietOk(sp, dietary)) dropped.push({ memberId: inp.memberId, spotId: id, reason: "diet" });
      else list.push(id);
    }
    okWishes.set(inp.memberId, list);
  }
  const wanters = new Map<string, string[]>();
  for (const inp of inputs) for (const id of okWishes.get(inp.memberId)!) wanters.set(id, [...(wanters.get(id) ?? []), inp.memberId]);

  const reasons: MustReason[] = [];
  const multi = [...wanters.entries()]
    .filter(([, ms]) => ms.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || order.get(a[1][0])! - order.get(b[1][0])! || a[0].localeCompare(b[0]));
  for (const [spotId, memberIds] of multi) reasons.push({ spotId, kind: "multi", memberIds });
  const mustSet = new Set(reasons.map((r) => r.spotId));
  for (const inp of inputs) {
    const list = okWishes.get(inp.memberId)!;
    if (!list.length || list.some((id) => mustSet.has(id))) continue;
    const first = list[0];
    reasons.push({ spotId: first, kind: "member-first", memberIds: wanters.get(first)! });
    mustSet.add(first);
  }
  const mustSpotIds = reasons.map((r) => r.spotId);
  const softWishes = [...wanters.entries()].filter(([id]) => !mustSet.has(id)).map(([spotId, memberIds]) => ({ spotId, memberIds }));

  /* ---- 調整ポイント（1行の理由つき） ---- */
  const adj: Adjustment[] = [];
  const spotName = (id: string) => ctx.spotById.get(id)?.name ?? id;
  if (excluded.length) {
    adj.push({ kind: "excluded", text: `回答がまだの ${excluded.map((m) => m.name).join("・")} さんを除いて、${inputs.length}人の希望でまとめました` });
  }
  if (date.mode === "all") {
    adj.push({
      kind: "date",
      text:
        date.commonDates.length > 1
          ? `日程: 全員が参加できる日のうち、いちばん早い ${formatDateJa(date.date)} にしました（ほかの共通日: ${date.commonDates.slice(1).map(formatDateJa).join("、")}）`
          : `日程: 全員が参加できる ${formatDateJa(date.date)} にしました`,
    });
  } else if (date.mode === "most") {
    adj.push({
      kind: "date",
      text: `日程: 全員が揃う日がないため、参加できる人がいちばん多い ${formatDateJa(date.date)}（${inputs.length}人中${date.attendeeCount}人）にしました。参加できない人: ${date.absentees.map(name).join("・")} さん`,
    });
  } else {
    adj.push({ kind: "date", text: `日程: どの候補日にも参加できる人がいません。仮に ${formatDateJa(date.date)} で作りました。候補日を見直してください` });
  }
  if (new Set(inputs.map((i) => i.budgetCapYen)).size > 1) {
    adj.push({ kind: "budget", text: `予算: 1人1日 ${yen(budgetCapYen)} までに合わせました（全員の上限のうち、いちばん低い額）` });
  } else {
    adj.push({ kind: "budget", text: `予算: 全員の上限が同じ ${yen(budgetCapYen)} です` });
  }
  if (dietary.length) {
    adj.push({ kind: "dietary", text: `食事: ${dietary.map((d) => DIET_LABEL[d]).join("・")} の希望があるため、食事は全部に対応できる店だけから選びます` });
  }
  if (new Set(inputs.map((i) => i.rainTolerance)).size > 1) {
    adj.push({ kind: "rain", text: `雨: いちばん慎重な人に合わせて「${RAIN_LABEL[rainTolerance]}」にしました` });
  }
  if (new Set(inputs.map((i) => i.pace)).size > 1) {
    adj.push({
      kind: "pace",
      text: `ペース: 希望の真ん中の「${PACE_LABEL[pace]}」にしました${inputs.length % 2 === 0 ? "（人数が偶数で割れたときは、ゆったりのほうに寄せます）" : ""}`,
    });
  }
  for (const r of reasons) {
    adj.push({
      kind: "must",
      text:
        r.kind === "multi"
          ? `行きたい場所: 「${spotName(r.spotId)}」は ${r.memberIds.map(name).join("・")} さんの希望が重なったので、必ず行く場所にしました`
          : `行きたい場所: 「${spotName(r.spotId)}」は ${r.memberIds.map(name).join("・")} さんの第1希望。${name(r.memberIds[0])}さんの希望が入るよう、必ず行く場所にしました`,
    });
  }
  const dropText: Record<DroppedWish["reason"], string> = {
    closed: "決めた日が定休日のため",
    diet: "食事制限に対応できないため",
    unknown: "データにない場所のため",
  };
  for (const d of dropped) adj.push({ kind: "dropped", text: `行きたい場所: ${name(d.memberId)}さんの「${spotName(d.spotId)}」は、${dropText[d.reason]}入れられません` });
  if (likedCategories.length) {
    adj.push({ kind: "interest", text: `好み: 全員の好みを合計して、${likedCategories.slice(0, 3).map((c) => CATEGORY_LABEL[c]).join("・")} を多めにします` });
  }

  return {
    date,
    budgetCapYen,
    budget: budgetLevelOf(budgetCapYen),
    dietary,
    rainTolerance,
    pace,
    interestWeights: weights,
    likedCategories,
    mustSpotIds,
    mustReasons: reasons,
    softWishes,
    droppedWishes: dropped,
    memberIds: inputs.map((i) => i.memberId),
    excludedMemberIds: excluded.map((m) => m.id),
    adjustments: adj,
  };
}
