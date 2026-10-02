import { findOpenSlot } from "./availability";
import { replaceSpotOfBlock, swapPlanB } from "./actions";
import { templateWriter, type Cause, type ExplanationWriter } from "./cause";
import { diffItineraries, type DiffItem } from "./diff";
import { createFixedBlock, isGroupWide, nextId } from "./fixed";
import { haversineM, taxiMinutesFor, transitMinutesFor, walkMinutesFor } from "./geo";
import { BUFFER_FLOOR_MIN, dietOk, MEAL_ADJUST_WINDOW, MEAL_LABEL } from "./meals";
import { attachPlanBs } from "./planb";
import { MEAL_WINDOW } from "./planner";
import {
  commitBaseline,
  DAY_END_TOLERANCE_MIN,
  DEFAULT_MARGIN_MIN,
  dayTravel,
  FREE_STOP_TRAVEL_MIN,
  isInert,
  isStarted,
  placeOf,
  recomputeDay,
  type RecomputeOptions,
} from "./schedule";
import { suggestForGap, type Suggestion } from "./suggest";
import { dayWalking } from "./walking";
import type { Block, BlockIssue, Day, DietaryRestriction, FixedEvent, Itinerary, LatLng, MealSlot, PlanningContext, Spot } from "./types";

/**
 * 再計画エンジン。
 * 雨（Plan B 切替）・遅延・臨時休業・疲れた・固定時刻の追加などを、すべてこの1つの関数で扱う。
 *
 * 結果は「提案」で、元の旅程は変えない。UI は差分を見せ、確定ボタンで result.after を反映する。
 *
 * 保護の優先順位（高い順）: 固定時刻 > Must > 食事 > 休憩（「疲れた」で入れたもの）> 標準 > Optional
 * 余白は「遅れの吸収材」として最初に縮む（ペース別の下限まで。ゆったり20分／普通10分／詰め込み5分）。
 *
 * 時間が足りないときは、次の順で削る・調整する。
 *   0. 余白を下限まで縮める（時刻の再計算の中で自動で行われる）
 *   1. Optional を、違反に近い後ろ側から削除
 *   2. 食事以外のスポットの滞在時間を、最低滞在時間まで短縮
 *   3. 標準を、後ろから削除（食事は削除しない）
 *   4. 食事の調整: 食事の窓の中で時刻をずらす（再計算で自動）→ 滞在を最低滞在まで短縮 → 近く（1km以内）の別の店に差し替え
 *   5. それでも足りなければ Must と食事を「削る候補」として提示する（勝手には削らない）
 */

export type ReplanEvent =
  /** Plan B への切り替え（雨など）。切替済みなら元に戻る */
  | { type: "plan-b"; blockIds: string[]; /** 切り替える理由（雨・暑さ）。省略すると、ユーザー自身の操作 */ cause?: "rain" | "heat" }
  | { type: "delay"; minutes: number }
  | { type: "closure"; spotId: string; replacementSpotId?: string }
  | { type: "tired"; level: "light" | "heavy"; source?: "member" | "walk-limit" }
  | { type: "fixed-add"; fixed: FixedEvent }
  | { type: "fixed-remove"; fixedId: string }
  /** 固定時刻を別の時刻に変える（早い便で帰るなど） */
  | { type: "fixed-move"; fixedId: string; timeMin: number; title?: string }
  | { type: "margin"; marginMin: number }
  | { type: "skip"; blockIds: string[] }
  | { type: "restore"; blockId: string }
  /** スポットを1件足す（空きができたときの提案など）。afterBlockId が null なら、これから行く予定の先頭に入れる */
  | { type: "add-spot"; spotId: string; afterBlockId: string | null; label?: "optional" | "normal"; cause?: "detour" }
  /** 休憩を1件足す（駅の近くで待つなど）。spotId を省くと場所を決めない休憩 */
  | { type: "add-rest"; afterBlockId: string | null; minutes: number; spotId?: string }
  /** 実績: 着いた／出発した（時刻は atMin）。遅れや早まりを後ろの予定に反映する */
  | { type: "progress"; blockId: string; kind: "arrived" | "departed"; atMin: number }
  /** 寄り道。スポット、または名前と滞在時間の自由入力（座標がないので移動は10分と仮定）。afterBlockId を省くと、いまの予定の後ろ */
  | { type: "detour"; stop: { spotId: string } | { name: string; durationMin: number }; afterBlockId?: string | null }
  /** 暑さ対策: 屋外の予定の後に休憩（屋内の休める場所があればそこ）を挟む */
  | { type: "heat-rest"; blockIds: string[]; minutes: number }
  /** いまの場所での滞在を延長する（早く進んだとき） */
  | { type: "extend-stay"; blockId: string; minutes: number }
  /** 余白を足す（早く進んだとき） */
  | { type: "add-buffer"; afterBlockId: string | null; minutes: number };

export interface ReplanOptions {
  /** 操作の対象の日 */
  dayIndex: number;
  /** 現在時刻（0:00 からの分）。当日モードでのみ指定する。開始済みの予定は動かさない */
  nowMin?: number;
  /** ユーザーが確認して「削ってよい」とした Must・食事・寄り道のブロック ID */
  removeMustIds?: string[];
  /** 変更理由を文章にするもの（省略するとテンプレート） */
  writer?: ExplanationWriter;
}

export type StepKind =
  | "plan-b"
  | "delay"
  | "closure"
  | "replace"
  | "insert-rest"
  | "fixed-add"
  | "fixed-remove"
  | "fixed-move"
  | "margin"
  | "skip"
  | "restore"
  | "add-spot"
  | "progress"
  | "detour"
  | "extend-stay"
  | "add-buffer"
  | "drop-must"
  | "drop-optional"
  | "shorten"
  | "drop-standard"
  | "meal-shorten"
  | "meal-replace"
  | "reorder"
  | "tidy";

export interface ReplanStep {
  /** event: イベントそのものの適用 / reduce: 時間が足りないときの削減（順序固定） / tidy: 後始末 */
  phase: "event" | "reduce" | "tidy";
  kind: StepKind;
  blockIds: string[];
  detail?: string;
  /** この手順の理由（削減は、解消した問題から求める） */
  cause?: Cause;
}

export interface Violation {
  blockId: string;
  kind: BlockIssue;
  lateByMin?: number;
  message: string;
}

export interface MustCandidate {
  blockId: string;
  spotId?: string;
  name: string;
  /** must: 絶対に行きたい場所 / meal: 食事 / detour: 当日に入れた寄り道（いずれも自動では削らない） */
  kind: "must" | "meal" | "detour";
  /** これを外せば、すべての違反が解消する */
  fixesAll: boolean;
}

export interface TravelSuggestion {
  blockId: string;
  fromName: string;
  toName: string;
  /** 徒歩だとかかる時間（分） */
  walkMin: number;
  transitMin: number;
  taxiMin: number;
}

export interface ReplanResult {
  event: ReplanEvent;
  dayIndex: number;
  before: Itinerary;
  /** 組み直した旅程（提案）。確定するまで反映されない */
  after: Itinerary;
  steps: ReplanStep[];
  diff: DiffItem[];
  /** 提案でも解消できなかった問題 */
  violations: Violation[];
  /** 固定時刻・営業時間・食事の窓・終了予定時刻に問題がない */
  feasible: boolean;
  /** 足りないとき、削る候補として提示する Must・食事（自動では削っていない） */
  mustCandidates: MustCandidate[];
  /** 徒歩20分以上かかる移動への、公共交通・タクシーの提案（かなり疲れたのとき） */
  travelSuggestions: TravelSuggestion[];
  /** 最終便の前に長い空きができたときの提案（早い便・Optional の追加・駅の近くで待つ）。自動では反映しない */
  suggestions: Suggestion[];
  /** 残りの推定歩行距離（m）の変化 */
  walkingBeforeM: number;
  walkingAfterM: number;
  notes: string[];
}

/* ---------- 定数 ---------- */

export const REST_MINUTES = { light: 30, heavy: 60 } as const;
const REST_RADIUS_M = { light: 800, heavy: 500 } as const;
const SHORTEN_STEP_MIN = 5;
const WALK_SUGGEST_MIN = 20;
const BAD_WEIGHT = 10000;
/** 食事の差し替えで探す範囲（元の店から。m） */
const MEAL_REPLACE_RADIUS_M = 1000;
/** 休憩の位置を選ぶときの、失う予定の重み（重いほど守りたい） */
export const LOSS_WEIGHT = { optional: 1, normal: 3, meal: 10, must: 100 } as const;
/** 予定より何分以上遅れたら「遅れ」として扱うか（実績の記録） */
export const PROGRESS_LATE_MIN = 10;
/** 休憩を入れる位置の候補数: 次の予定の手前／次の予定の後／次の次の予定の後 */
const REST_POSITIONS = 3;

/** 最低滞在時間（分）。スポットの指定があればそれ、なければ標準滞在時間の半分（15分未満にはしない） */
export function minStayOf(spot: Spot): number {
  return spot.minStayMin ?? Math.max(15, Math.round((spot.stayMin * 0.5) / 5) * 5);
}

/* ---------- 補助 ---------- */

const startedAt = (b: Block, now: number | undefined) => isStarted(b, now);
const movable = (b: Block, now: number | undefined) => !isInert(b) && !startedAt(b, now);

function blockName(b: Block, ctx: PlanningContext): string {
  if (b.fixed) return b.fixed.title;
  if (b.free) return b.free.name;
  if (b.spotId) return ctx.spotById.get(b.spotId)?.name ?? "予定";
  return b.label === "rest" ? "休憩" : b.label === "buffer" ? "余白" : "予定";
}

/** 問題の大きさ。0 なら問題なし。固定時刻・営業時間・食事の窓の違反は重く、終了予定時刻の超過は超過分（分） */
function badness(day: Day, now: number | undefined): number {
  let n = 0;
  for (const b of day.blocks) {
    if (!movable(b, now) && !(b.fixed && !isInert(b) && !startedAt(b, now))) continue;
    for (const issue of b.issues ?? []) {
      if (issue === "fixed-missed" || issue === "outside-hours" || issue === "outside-meal-window") n += BAD_WEIGHT + (b.lateByMin ?? 1);
      else if (issue === "after-last-transport") n += BAD_WEIGHT;
      else if (issue === "over-day-end") n += Math.max(0, b.endMin - (day.endMin + DAY_END_TOLERANCE_MIN));
    }
  }
  return n;
}

function collectViolations(day: Day, ctx: PlanningContext, now: number | undefined): Violation[] {
  const out: Violation[] = [];
  for (const b of day.blocks) {
    if (isInert(b) || startedAt(b, now)) continue;
    const name = blockName(b, ctx);
    for (const issue of b.issues ?? []) {
      if (issue === "fixed-missed") {
        out.push({ blockId: b.id, kind: issue, lateByMin: b.lateByMin, message: `${name} に間に合いません（あと${b.lateByMin ?? 0}分足りません）` });
      } else if (issue === "outside-hours") {
        out.push({ blockId: b.id, kind: issue, lateByMin: b.lateByMin, message: `「${name}」が営業時間に間に合いません` });
      } else if (issue === "outside-meal-window" && b.meal) {
        const w = MEAL_ADJUST_WINDOW[b.meal];
        out.push({
          blockId: b.id,
          kind: issue,
          lateByMin: b.lateByMin,
          message: `${MEAL_LABEL[b.meal]}「${name}」が食事の時間帯（${hm(w.earliest)}〜${hm(w.latest)}）に収まりません`,
        });
      } else if (issue === "after-last-transport") {
        out.push({ blockId: b.id, kind: issue, message: `「${name}」は最終便のあとになるため実施できません` });
      } else if (issue === "over-day-end" && b.endMin > day.endMin + DAY_END_TOLERANCE_MIN) {
        out.push({ blockId: b.id, kind: issue, message: `「${name}」が終了予定時刻（${hm(day.endMin)}）を大きく超えます` });
      }
    }
  }
  return out;
}

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function allBlockIds(itin: Itinerary): string[] {
  return itin.days.flatMap((d) => [...d.blocks.map((b) => b.id), ...(d.memberFixed ?? []).map((f) => f.id)]);
}

/** 失う予定の重み。Must ＞ 食事 ＞ 標準 ＞ Optional */
function lossWeight(b: Block): number {
  if (b.label === "must") return LOSS_WEIGHT.must;
  if (b.meal) return LOSS_WEIGHT.meal;
  if (b.label === "normal") return LOSS_WEIGHT.normal;
  if (b.label === "optional") return LOSS_WEIGHT.optional;
  return 0;
}

/** 組み直しで失ったもの（削られた予定の重みの合計。短縮は分あたりごく小さく足して、同点のときに短縮が少ないほうを選ぶ） */
function lossOf(before: Day, after: Day): number {
  const was = new Map(before.blocks.map((b) => [b.id, b]));
  let loss = 0;
  for (const b of after.blocks) {
    const w = was.get(b.id);
    const gone = b.skip === "skipped" || !!b.closed;
    if (!gone) {
      if (w && !isInert(w) && b.durationMin < w.durationMin) loss += 0.01 * (w.durationMin - b.durationMin);
      continue;
    }
    if (w && isInert(w)) continue; // もともと外れていた
    loss += lossWeight(b);
  }
  return loss;
}

/* ---------- 休憩の挿入 ---------- */

export type RestMode =
  /** いまいる（直前の）場所で休憩を延長する */
  | "extend"
  /** 近くの屋内の休める場所へ移動して休む */
  | "nearby"
  /** 場所を決めない休憩 */
  | "generic";

interface RestPlacement {
  day: Day;
  blockId: string;
  spot?: Spot;
  mode: RestMode;
  /** 候補の順番（0=次の予定の手前）。同点のときは小さいほうを選ぶ */
  order: number;
  /** この休憩の直前のブロック（先頭なら undefined） */
  afterBlockId?: string;
}

/** 休憩のブロックを作る（時刻は再計算で決まる） */
function makeRestBlock(id: string, minutes: number, startMin: number, spotId?: string): Block {
  return spotId
    ? { id, label: "rest", spotId, durationMin: minutes, startMin, endMin: startMin + minutes, plannedStartMin: 0, travelMin: 0, travelMode: "none" }
    : { id, label: "rest", durationMin: minutes, startMin, endMin: startMin + minutes, travelMin: 0, travelMode: "none" };
}

/** from の近く（radiusM 以内）の、屋内の休める場所で、休憩の時間に営業しているもの。いちばん近い（次の場所に近い）もの */
function pickRestSpot(
  ctx: PlanningContext,
  day: Day,
  from: LatLng,
  next: LatLng | undefined,
  t0: number,
  minutes: number,
  radiusM: number,
  exclude: ReadonlySet<string>,
): Spot | undefined {
  const travel = dayTravel(day, ctx);
  let best: { spot: Spot; score: number } | null = null;
  for (const sp of ctx.spots) {
    if (exclude.has(sp.id) || !sp.restable || sp.setting !== "indoor") continue;
    const d = haversineM(from, sp);
    if (d > radiusM) continue;
    if (!findOpenSlot(sp, day.date, t0 + travel(from, sp).minutes, minutes)) continue;
    const score = d + (next ? 0.5 * haversineM(sp, next) : 0);
    if (!best || score < best.score) best = { spot: sp, score };
  }
  return best?.spot;
}

/**
 * 休憩を入れる位置と場所の候補。
 * 位置: 次の予定の手前／次の予定の後／次の次の予定の後（最終便のあとには入れない）。
 * 場所: その位置の直前の場所の近く（radiusM 以内）の、屋内の休める場所（restable）。旅程に入っているスポットも使える
 *       （いま滞在中の場所なら、距離0で選ばれて「ここで延長」になる）。ただし、これから行くスポットは使わない。
 *       見つからなければ場所を決めない休憩。
 */
function restPlacements(itin: Itinerary, day: Day, ctx: PlanningContext, now: number | undefined, minutes: number, radiusM: number): RestPlacement[] {
  const first = day.blocks.findIndex((b) => movable(b, now));
  const at0 = first < 0 ? day.blocks.length : first;
  const endIdx = day.blocks.findIndex((b, i) => i >= at0 && b.fixed?.endsDay && !isInert(b));
  const limit = endIdx < 0 ? day.blocks.length : endIdx;
  const spotLike = (b: Block) => movable(b, now) && !b.fixed && b.label !== "buffer" && b.label !== "rest" && !!placeOf(b, ctx);

  const upcoming: number[] = [];
  day.blocks.forEach((b, i) => {
    if (i >= at0 && spotLike(b)) upcoming.push(i);
  });
  const positions = [at0];
  for (let k = 0; k < Math.min(upcoming.length, REST_POSITIONS - 1); k++) positions.push(upcoming[k] + 1);
  const unique = [...new Set(positions)].filter((p) => p <= limit);

  const travel = dayTravel(day, ctx);
  const id = nextId(allBlockIds(itin), "r");

  return unique.map((pos, order): RestPlacement => {
    let prevPlace: LatLng = day.origin;
    let prevSpotId: string | undefined;
    let prevEnd = day.startMin;
    let afterBlockId: string | undefined;
    for (let i = 0; i < pos; i++) {
      const b = day.blocks[i];
      if (isInert(b)) continue;
      prevEnd = Math.max(prevEnd, b.endMin);
      afterBlockId = b.id;
      const p = placeOf(b, ctx);
      if (p) {
        prevPlace = p;
        prevSpotId = b.spotId;
      }
    }
    let nextPlace: LatLng | undefined;
    for (let i = pos; i < day.blocks.length && !nextPlace; i++) if (!isInert(day.blocks[i])) nextPlace = placeOf(day.blocks[i], ctx);

    const t0 = Math.max(prevEnd, now ?? 0);
    // これから行くスポット（この休憩より後ろ）と休業のスポットは、休憩場所にしない
    const later = new Set<string>(itin.closedSpotIds);
    day.blocks.forEach((b, i) => {
      if (i >= pos && !isInert(b) && b.spotId) later.add(b.spotId);
    });

    const found = pickRestSpot(ctx, day, prevPlace, nextPlace, t0, minutes, radiusM, later);
    const block = makeRestBlock(id, minutes, t0, found?.id);
    const blocks = [...day.blocks];
    blocks.splice(pos, 0, block);
    const mode: RestMode = !found ? "generic" : found.id === prevSpotId ? "extend" : "nearby";
    return { day: { ...day, blocks }, blockId: id, spot: found, mode, order, afterBlockId };
  });
}

/** この休憩ブロックが、直前の場所での休憩の延長か（UI の表示用） */
export function restKind(day: Day, index: number, ctx: PlanningContext): RestMode | null {
  const b = day.blocks[index];
  if (!b || b.label !== "rest") return null;
  if (!b.spotId) return "generic";
  for (let i = index - 1; i >= 0; i--) {
    const p = day.blocks[i];
    if (isInert(p) || !placeOf(p, ctx)) continue;
    return p.spotId === b.spotId ? "extend" : "nearby";
  }
  return "nearby";
}

/* ---------- 近い順への並べ替え（かなり疲れた） ---------- */

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((it, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([it, ...rest]);
  });
  return out;
}

/**
 * 残りの予定を、移動の道のりの合計が短くなるよう（近い順に）並べ直す。
 * 動かすのは、これから行く Must / 標準 のスポットだけ。食事・余白・休憩・固定時刻は元の位置のまま、
 * その間にあるスポット同士を入れ替える。営業時間や固定時刻に新たな問題が出る並びは採用しない。
 */
function reorderNearest(day: Day, ctx: PlanningContext, now: number | undefined, rc: (d: Day) => Day): { day: Day; moved: string[] } {
  const travel = dayTravel(day, ctx);
  const isMovable = (b: Block) =>
    movable(b, now) && !b.fixed && !b.meal && (b.label === "must" || b.label === "normal") && !!b.spotId;

  let cur = day;
  const moved: string[] = [];
  let i = 0;
  while (i < cur.blocks.length) {
    if (!isMovable(cur.blocks[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < cur.blocks.length && isMovable(cur.blocks[j + 1])) j++;
    const seg = cur.blocks.slice(i, j + 1);
    if (seg.length >= 2) {
      let prev: LatLng = cur.origin;
      for (let k = i - 1; k >= 0; k--) {
        const p = !isInert(cur.blocks[k]) ? placeOf(cur.blocks[k], ctx) : undefined;
        if (p) {
          prev = p;
          break;
        }
      }
      let next: LatLng | undefined;
      for (let k = j + 1; k < cur.blocks.length && !next; k++) if (!isInert(cur.blocks[k])) next = placeOf(cur.blocks[k], ctx);

      const place = (b: Block) => placeOf(b, ctx)!;
      const length = (order: Block[]) => {
        let total = travel(prev, place(order[0])).distanceM;
        for (let k = 1; k < order.length; k++) total += travel(place(order[k - 1]), place(order[k])).distanceM;
        if (next) total += travel(place(order[order.length - 1]), next).distanceM;
        return total;
      };

      let orders: Block[][];
      if (seg.length <= 6) orders = permutations(seg);
      else {
        // 多いときは、いまの場所から最も近いものを順に選ぶ
        const left = [...seg];
        const order: Block[] = [];
        let at: LatLng = prev;
        while (left.length) {
          left.sort((a, b) => travel(at, place(a)).distanceM - travel(at, place(b)).distanceM);
          const nextBlock = left.shift()!;
          order.push(nextBlock);
          at = place(nextBlock);
        }
        orders = [order];
      }
      const baseline = length(seg);
      const baselineBad = badness(rc(cur), now);
      const ranked = orders
        .map((o) => ({ o, len: length(o) }))
        .filter((x) => x.len < baseline - 1)
        .sort((a, b) => a.len - b.len)
        .slice(0, 60);
      for (const { o } of ranked) {
        const blocks = [...cur.blocks];
        o.forEach((blk, k) => {
          const slot = seg[k];
          // 時刻の下限は「位置」に付く。入れ替わったスポットは、その位置の下限を引き継ぐ
          blocks[i + k] = {
            ...blk,
            plannedStartMin: slot.plannedStartMin,
            plannedEndMin: slot.plannedEndMin,
            startMin: slot.startMin,
            endMin: slot.startMin + blk.durationMin,
            notBefore: undefined,
          };
        });
        const trial = rc({ ...cur, blocks });
        if (badness(trial, now) <= baselineBad) {
          cur = trial;
          for (const blk of o) if (!moved.includes(blk.id)) moved.push(blk.id);
          break;
        }
      }
    }
    i = j + 1;
  }
  return { day: cur, moved };
}

/* ---------- 理由（cause）の特定 ---------- */

const ISSUE_WEIGHT: Record<BlockIssue, number> = {
  "fixed-missed": 5,
  "after-last-transport": 4,
  "outside-hours": 3,
  "outside-meal-window": 3,
  "over-day-end": 1,
  closed: 0,
};

function causeOfIssue(b: Block, issue: BlockIssue, day: Day): Cause | null {
  const endsDay = day.blocks.find((x) => x.fixed?.endsDay && !isInert(x))?.fixed;
  switch (issue) {
    case "fixed-missed":
      return b.fixed ? { kind: "fixed", fixedId: b.fixed.id } : null;
    case "after-last-transport":
      return endsDay ? { kind: "fixed", fixedId: endsDay.id } : null;
    case "outside-hours":
      return b.spotId ? { kind: "closing", spotId: b.spotId } : null;
    case "outside-meal-window":
      return b.meal ? { kind: "meal-window", slot: b.meal } : null;
    case "over-day-end":
      return { kind: "day-end", endMin: day.endMin };
    default:
      return null;
  }
}

/**
 * 削減の理由。この手順で解消した（または軽くなった）問題のうち、最も重いものを理由にする。
 * 例: 光明禅寺（閉館 16:30）に間に合わせるために手前の予定を削ったなら、closing:光明禅寺。
 */
function resolveCause(before: Day, after: Day): Cause {
  const aMap = new Map(after.blocks.map((b) => [b.id, b]));
  let best: { w: number; cause: Cause } | null = null;
  let fallback: { w: number; cause: Cause } | null = null;
  for (const b of before.blocks) {
    for (const issue of b.issues ?? []) {
      const cause = causeOfIssue(b, issue, before);
      if (!cause) continue;
      const w = ISSUE_WEIGHT[issue] * 10000 + (b.lateByMin ?? 0);
      if (!fallback || w > fallback.w) fallback = { w, cause };
      const a = aMap.get(b.id);
      const still = !!a && !isInert(a) && !!a.issues?.includes(issue);
      const lighter = still && (a!.lateByMin ?? 0) < (b.lateByMin ?? 0);
      if (still && !lighter) continue;
      if (!best || w > best.w) best = { w, cause };
    }
  }
  return (best ?? fallback)?.cause ?? { kind: "day-end", endMin: before.endMin };
}

/* ---------- 時間が足りないときの調整（削減の順序はここで固定） ---------- */

interface SettleEnv {
  ctx: PlanningContext;
  now: number | undefined;
  rc: (d: Day, extra?: Partial<RecomputeOptions>) => Day;
  /** 同じ旅程の他の日のスポット（食事の差し替えで重複させない） */
  otherUsed: Set<string>;
  closed: Set<string>;
  /** 「かなり疲れた」: 近い順への並べ替えをする */
  reorder: boolean;
  /** 食事制限。食事の店を差し替えるときも、すべての制限に対応できる店だけを選ぶ */
  dietary?: readonly DietaryRestriction[];
}

interface Settled {
  day: Day;
  steps: ReplanStep[];
  /** 残った問題の大きさ（0 なら解消） */
  bad: number;
  mustCandidates: MustCandidate[];
}

function settle(start: Day, env: SettleEnv): Settled {
  const { ctx, now, rc } = env;
  const steps: ReplanStep[] = [];
  let day = start;
  const dropIds = (d: Day, ids: string[]): Day =>
    rc({ ...d, blocks: d.blocks.map((b) => (ids.includes(b.id) ? { ...b, skip: "skipped" as const } : b)) });

  // 最終便のあとの余白は意味がないので片づける
  const endIdx = day.blocks.findIndex((b) => b.fixed?.endsDay && !isInert(b));
  if (endIdx >= 0) {
    const tidy = day.blocks.slice(endIdx + 1).filter((b) => b.label === "buffer" && !isInert(b)).map((b) => b.id);
    if (tidy.length) {
      day = dropIds(day, tidy);
      const endFixed = day.blocks[endIdx].fixed!;
      steps.push({ phase: "tidy", kind: "tidy", blockIds: tidy, detail: "最終便のあとの余白", cause: { kind: "fixed", fixedId: endFixed.id } });
    }
  }

  // かなり疲れた: 近い順に並べ直す
  if (env.reorder) {
    const r = reorderNearest(day, ctx, now, rc);
    day = r.day;
    if (r.moved.length) steps.push({ phase: "event", kind: "reorder", blockIds: r.moved, detail: "近い順", cause: { kind: "tired" } });
  }

  let cur = badness(day, now);

  // 1. Optional を、違反に近い後ろ側から削除
  while (cur > 0) {
    const pool = day.blocks.filter((b) => b.label === "optional" && !b.meal && !b.detour && movable(b, now)).reverse();
    let hit: { b: Block; trial: Day; bad: number } | null = null;
    for (const b of pool) {
      const trial = dropIds(day, [b.id]);
      const bad = badness(trial, now);
      if (bad < cur) {
        hit = { b, trial, bad };
        break;
      }
    }
    if (!hit) break;
    const cause = resolveCause(day, hit.trial);
    day = hit.trial;
    cur = hit.bad;
    steps.push({ phase: "reduce", kind: "drop-optional", blockIds: [hit.b.id], cause });
  }

  /** 滞在時間を、最低滞在時間まで 5 分刻みで短縮する。対象は pick が true のブロック。余裕が最大のものから */
  type ShortenRec = { from: number; to: number; cause: Cause };
  const shortenLoop = (pick: (b: Block) => boolean, record: Map<string, ShortenRec>) => {
    for (let guard = 0; cur > 0 && guard < 400; guard++) {
      let best: { id: string; trial: Day; bad: number; room: number; idx: number } | null = null;
      day.blocks.forEach((b, idx) => {
        if (!movable(b, now) || b.fixed || b.label === "buffer" || b.label === "rest" || !b.spotId || !pick(b)) return;
        const spot = ctx.spotById.get(b.spotId);
        if (!spot) return;
        const room = b.durationMin - minStayOf(spot);
        if (room <= 0) return;
        const step = Math.min(SHORTEN_STEP_MIN, room);
        const trial = rc({ ...day, blocks: day.blocks.map((x) => (x.id === b.id ? { ...x, durationMin: x.durationMin - step } : x)) });
        const bad = badness(trial, now);
        if (bad < cur && (!best || room > best.room || (room === best.room && idx > best.idx))) best = { id: b.id, trial, bad, room, idx };
      });
      if (!best) break;
      const chosen: { id: string; trial: Day; bad: number } = best;
      const before = day.blocks.find((b) => b.id === chosen.id)!.durationMin;
      const after = chosen.trial.blocks.find((b) => b.id === chosen.id)!.durationMin;
      const prevRec = record.get(chosen.id);
      record.set(chosen.id, { from: prevRec?.from ?? before, to: after, cause: resolveCause(day, chosen.trial) });
      day = chosen.trial;
      cur = chosen.bad;
    }
  };

  // 2. 食事以外のスポットの滞在時間を短縮
  const shortenAt = steps.length; // 短縮の記録は、Optional の削除のあと・標準の削除の前に入れる
  const shortened = new Map<string, ShortenRec>();
  shortenLoop((b) => !b.meal, shortened);

  // 3. 標準を、後ろから削除（食事は削除しない）
  while (cur > 0) {
    const pool = day.blocks.filter((b) => b.label === "normal" && !b.meal && !b.detour && movable(b, now)).reverse();
    let hit: { b: Block; trial: Day; bad: number } | null = null;
    for (const b of pool) {
      const trial = dropIds(day, [b.id]);
      const bad = badness(trial, now);
      if (bad < cur) {
        hit = { b, trial, bad };
        break;
      }
    }
    if (!hit) break;
    const cause = resolveCause(day, hit.trial);
    day = hit.trial;
    cur = hit.bad;
    steps.push({ phase: "reduce", kind: "drop-standard", blockIds: [hit.b.id], cause });
  }

  // 4. 食事の調整。窓の中で時刻をずらす（再計算で自動）→ 滞在を最低滞在まで短縮 → 近くの別の店に差し替え
  const mealShortened = new Map<string, ShortenRec>();
  shortenLoop((b) => !!b.meal, mealShortened);
  const mealSteps: ReplanStep[] = [];
  for (const [id, r] of mealShortened) mealSteps.push({ phase: "reduce", kind: "meal-shorten", blockIds: [id], detail: `${r.from}分 → ${r.to}分`, cause: r.cause });

  const used = new Set<string>([...env.otherUsed, ...env.closed]);
  for (const b of day.blocks) if (b.spotId) used.add(b.spotId);
  while (cur > 0) {
    let hit: { id: string; trial: Day; bad: number; from: string; to: string } | null = null;
    for (const b of [...day.blocks].reverse()) {
      if (!b.meal || !b.spotId || !movable(b, now)) continue;
      const orig = ctx.spotById.get(b.spotId);
      if (!orig) continue;
      for (const c of ctx.spots) {
        if (used.has(c.id) || !c.mealSlots?.includes(b.meal) || haversineM(orig, c) > MEAL_REPLACE_RADIUS_M) continue;
        if (!dietOk(c, env.dietary)) continue;
        const durationMin = Math.max(minStayOf(c), Math.min(b.durationMin, c.stayMin));
        const trial = rc({
          ...day,
          blocks: day.blocks.map((x) => (x.id === b.id ? { ...x, spotId: c.id, durationMin, planB: undefined, switched: false } : x)),
        });
        const bad = badness(trial, now);
        if (bad < cur && (!hit || bad < hit.bad)) hit = { id: b.id, trial, bad, from: orig.name, to: c.name };
      }
      if (hit) break;
    }
    if (!hit) break;
    const cause = resolveCause(day, hit.trial);
    day = hit.trial;
    cur = hit.bad;
    used.add(day.blocks.find((x) => x.id === hit!.id)!.spotId!);
    mealSteps.push({ phase: "reduce", kind: "meal-replace", blockIds: [hit.id], detail: `${hit.from} → ${hit.to}`, cause });
  }

  // 結局スキップされたブロックは、短縮の記録から外して元の滞在時間に戻す（あとで取り消したときに短いままにならないように）
  const shortenSteps: ReplanStep[] = [];
  day = {
    ...day,
    blocks: day.blocks.map((b) => {
      const r = shortened.get(b.id) ?? mealShortened.get(b.id);
      if (!r) return b;
      if (b.skip === "skipped") return { ...b, durationMin: r.from };
      if (shortened.has(b.id)) shortenSteps.push({ phase: "reduce", kind: "shorten", blockIds: [b.id], detail: `${r.from}分 → ${r.to}分`, cause: r.cause });
      return b;
    }),
  };
  steps.splice(shortenAt, 0, ...shortenSteps);
  steps.push(...mealSteps);

  // 5. それでも足りなければ、Must と食事を削る候補として提示する（削らない）
  const mustCandidates: MustCandidate[] = [];
  if (cur > 0) {
    for (const b of [...day.blocks].reverse()) {
      if ((b.label !== "must" && !b.meal && !b.detour) || !movable(b, now)) continue;
      const bad = badness(dropIds(day, [b.id]), now);
      if (bad < cur) {
        mustCandidates.push({
          blockId: b.id,
          spotId: b.spotId,
          name: blockName(b, ctx),
          kind: b.label === "must" ? "must" : b.meal ? "meal" : "detour",
          fixesAll: bad === 0,
        });
      }
    }
  }
  return { day, steps, bad: cur, mustCandidates };
}

/* ---------- 本体 ---------- */

export function replan(itin: Itinerary, event: ReplanEvent, ctx: PlanningContext, opts: ReplanOptions): ReplanResult {
  const work: Itinerary = structuredClone(itin);
  work.members ??= [];
  work.settings ??= { marginMin: DEFAULT_MARGIN_MIN };
  let margin = work.settings.marginMin;
  const minBufferMin = BUFFER_FLOOR_MIN[work.prefs.pace];
  const steps: ReplanStep[] = [];
  const notes: string[] = [];

  let di = event.type === "fixed-add" ? event.fixed.dayIndex : opts.dayIndex;
  if (event.type === "fixed-remove" || event.type === "fixed-move") {
    const fid = event.fixedId;
    const found = work.days.find((d) => d.blocks.some((b) => b.id === fid) || d.memberFixed?.some((f) => f.id === fid));
    if (found) di = found.index;
  }
  let now = di === opts.dayIndex ? opts.nowMin : undefined;
  // 実績（着いた・出発した）の記録は、その時刻が現在時刻
  if (event.type === "progress" && now === undefined) now = event.atMin;
  let day: Day = work.days[di];
  const walkingBeforeM = dayWalking(itin.days[di], ctx, itin.prefs.pace, now).remainingM;

  const rc = (d: Day, extra: Partial<RecomputeOptions> = {}): Day =>
    recomputeDay(d, ctx, { mode: "preserve", nowMin: now, marginMin: margin, minBufferMin, ...extra });

  /* ---- 1. イベントを適用する ---- */
  /** 時刻がずれる・入れ替わるなど、イベントそのものによる変更の理由 */
  let eventCause: Cause = { kind: "user" };
  let delayMin = 0;
  let tiredPlan: { minutes: number; radiusM: number; heavy: boolean; source?: "member" | "walk-limit" } | null = null;

  switch (event.type) {
    case "plan-b": {
      const ids = new Set(event.blockIds);
      const changed: string[] = [];
      day = {
        ...day,
        blocks: day.blocks.map((b) => {
          if (!ids.has(b.id) || !b.planB) return b;
          changed.push(b.id);
          return swapPlanB(b, ctx, now);
        }),
      };
      eventCause = { kind: event.cause ?? "user" };
      steps.push({ phase: "event", kind: "plan-b", blockIds: changed, cause: eventCause });
      break;
    }
    case "delay":
      delayMin = event.minutes;
      eventCause = { kind: "delay" };
      steps.push({ phase: "event", kind: "delay", blockIds: [], detail: `${event.minutes}分`, cause: eventCause });
      break;
    case "closure": {
      if (!work.closedSpotIds.includes(event.spotId)) work.closedSpotIds.push(event.spotId);
      const hit: string[] = [];
      day = {
        ...day,
        blocks: day.blocks.map((b) => {
          if (b.spotId !== event.spotId || b.skip || (now !== undefined && b.endMin <= now)) return b;
          hit.push(b.id);
          return event.replacementSpotId ? replaceSpotOfBlock(b, event.replacementSpotId, ctx) : { ...b, closed: true };
        }),
      };
      eventCause = { kind: "closure", spotId: event.spotId };
      steps.push({ phase: "event", kind: event.replacementSpotId ? "replace" : "closure", blockIds: hit, cause: eventCause });
      break;
    }
    case "tired":
      eventCause = { kind: "rest" };
      tiredPlan = {
        minutes: REST_MINUTES[event.level],
        radiusM: REST_RADIUS_M[event.level],
        heavy: event.level === "heavy",
        source: event.source,
      };
      break;
    case "fixed-add": {
      const ev: FixedEvent = { ...event.fixed, id: event.fixed.id || nextId(allBlockIds(work), "fx") };
      const target = work.days[ev.dayIndex];
      if (isGroupWide(ev, work.members)) {
        const block = createFixedBlock({ ...ev, memberIds: null });
        const floor = target.blocks.findIndex((b) => movable(b, now));
        let pos = target.blocks.findIndex((b) => !isInert(b) && b.startMin >= ev.timeMin);
        if (pos < 0) pos = target.blocks.length;
        if (floor >= 0) pos = Math.max(pos, floor);
        else pos = target.blocks.length;
        const blocks = [...target.blocks];
        blocks.splice(pos, 0, block);
        day = { ...target, blocks };
      } else {
        day = { ...target, memberFixed: [...(target.memberFixed ?? []), ev] };
      }
      eventCause = { kind: "fixed", fixedId: ev.id };
      steps.push({ phase: "event", kind: "fixed-add", blockIds: [ev.id], detail: ev.title, cause: eventCause });
      break;
    }
    case "fixed-remove": {
      day = {
        ...day,
        blocks: day.blocks.filter((b) => b.id !== event.fixedId),
        memberFixed: (day.memberFixed ?? []).filter((f) => f.id !== event.fixedId),
      };
      steps.push({ phase: "event", kind: "fixed-remove", blockIds: [event.fixedId], cause: { kind: "user" } });
      break;
    }
    case "fixed-move": {
      const move = (f: FixedEvent): FixedEvent => ({ ...f, timeMin: event.timeMin, title: event.title ?? f.title });
      day = {
        ...day,
        blocks: day.blocks.map((b) =>
          b.id === event.fixedId && b.fixed
            ? { ...b, fixed: move(b.fixed), startMin: event.timeMin, endMin: event.timeMin + b.durationMin, plannedStartMin: event.timeMin, plannedEndMin: event.timeMin + b.durationMin, notBefore: undefined }
            : b,
        ),
        memberFixed: (day.memberFixed ?? []).map((f) => (f.id === event.fixedId ? move(f) : f)),
      };
      eventCause = { kind: "fixed", fixedId: event.fixedId };
      steps.push({ phase: "event", kind: "fixed-move", blockIds: [event.fixedId], detail: `${hm(event.timeMin)} に変更`, cause: eventCause });
      break;
    }
    case "margin":
      margin = event.marginMin;
      work.settings.marginMin = margin;
      const fixedBlock = day.blocks.find((b) => b.fixed && !isInert(b));
      eventCause = fixedBlock?.fixed ? { kind: "fixed", fixedId: fixedBlock.fixed.id } : { kind: "user" };
      steps.push({ phase: "event", kind: "margin", blockIds: [], detail: `${margin}分`, cause: eventCause });
      break;
    case "skip": {
      const ids = new Set(event.blockIds);
      day = { ...day, blocks: day.blocks.map((b) => (ids.has(b.id) ? { ...b, skip: "skipped" as const } : b)) };
      steps.push({ phase: "event", kind: "skip", blockIds: [...ids], cause: { kind: "user" } });
      break;
    }
    case "restore":
      day = { ...day, blocks: day.blocks.map((b) => (b.id === event.blockId ? { ...b, skip: undefined } : b)) };
      steps.push({ phase: "event", kind: "restore", blockIds: [event.blockId], cause: { kind: "user" } });
      break;
    case "add-spot": {
      const sp = ctx.spotById.get(event.spotId);
      if (!sp) break;
      const id = nextId(allBlockIds(work), "a");
      const block: Block = {
        id,
        label: event.label ?? "optional",
        spotId: sp.id,
        durationMin: sp.stayMin,
        startMin: 0,
        endMin: sp.stayMin,
        travelMin: 0,
        travelMode: "none",
      };
      day = insertAfter(day, ctx, now, event.afterBlockId, block);
      eventCause = { kind: event.cause ?? "detour" };
      steps.push({ phase: "event", kind: "add-spot", blockIds: [id], detail: sp.name, cause: eventCause });
      break;
    }
    case "add-rest": {
      const id = nextId(allBlockIds(work), "r");
      const sp = event.spotId ? ctx.spotById.get(event.spotId) : undefined;
      day = insertAfter(day, ctx, now, event.afterBlockId, makeRestBlock(id, event.minutes, 0, sp?.id));
      eventCause = { kind: "rest" };
      steps.push({ phase: "event", kind: "insert-rest", blockIds: [id], detail: sp?.name, cause: { kind: "user" } });
      break;
    }
    case "progress": {
      const idx = day.blocks.findIndex((b) => b.id === event.blockId);
      if (idx < 0) break;
      const blocks = [...day.blocks];
      const target = blocks[idx];
      const passed: string[] = [];
      const touched: string[] = [target.id];
      let lateBy: number;
      if (event.kind === "arrived") {
        lateBy = event.atMin - (target.plannedStartMin ?? target.startMin);
        // この予定に着いたので、手前の予定はもう終わっている（まだ始めていなかったものは、飛ばしたとみなす）
        for (let i = 0; i < idx; i++) {
          const p = blocks[i];
          if (isInert(p) || p.fixed || p.actualEndMin !== undefined) continue;
          if (isStarted(p, event.atMin)) {
            const st = p.actualStartMin ?? p.startMin;
            const end = Math.max(st, Math.min(p.endMin, event.atMin - target.travelMin));
            blocks[i] = { ...p, actualStartMin: st, actualEndMin: end, startMin: st, endMin: end, durationMin: Math.max(1, end - st) };
            touched.push(p.id);
          } else if (p.label !== "buffer" && p.label !== "rest") {
            blocks[i] = { ...p, skip: "skipped" as const };
            passed.push(p.id);
          }
        }
        blocks[idx] = {
          ...target,
          actualStartMin: event.atMin,
          startMin: event.atMin,
          endMin: event.atMin + target.durationMin,
          notBefore: undefined,
        };
      } else {
        const st = target.actualStartMin ?? target.startMin;
        const end = Math.max(st, event.atMin);
        lateBy = event.atMin - (target.endMin);
        blocks[idx] = { ...target, actualStartMin: st, actualEndMin: end, startMin: st, endMin: end, durationMin: Math.max(1, end - st) };
      }
      day = { ...day, blocks };
      // 遅れが10分以上なら「遅れ」、そうでなければ進み具合の反映
      eventCause = lateBy >= PROGRESS_LATE_MIN ? { kind: "delay" } : { kind: "progress" };
      steps.push({
        phase: "event",
        kind: "progress",
        blockIds: touched,
        detail: `${event.kind === "arrived" ? "着いた" : "出発した"} ${hm(event.atMin)}（予定より${lateBy >= 0 ? `${lateBy}分遅れ` : `${-lateBy}分早い`}）`,
        cause: eventCause,
      });
      if (passed.length) steps.push({ phase: "event", kind: "skip", blockIds: passed, detail: "飛ばした予定", cause: { kind: "progress" } });
      break;
    }
    case "detour": {
      const id = nextId(allBlockIds(work), "dt");
      let block: Block;
      let label: string;
      if ("spotId" in event.stop) {
        const sp = ctx.spotById.get(event.stop.spotId);
        if (!sp) break;
        label = sp.name;
        block = { id, label: "normal", spotId: sp.id, detour: true, durationMin: sp.stayMin, startMin: 0, endMin: sp.stayMin, travelMin: 0, travelMode: "none" };
      } else {
        const dur = Math.max(5, Math.round(event.stop.durationMin));
        label = event.stop.name;
        block = {
          id,
          label: "normal",
          detour: true,
          free: { name: event.stop.name, travelMin: FREE_STOP_TRAVEL_MIN },
          durationMin: dur,
          startMin: 0,
          endMin: dur,
          travelMin: FREE_STOP_TRAVEL_MIN,
          travelMode: "walk",
        };
      }
      const after = event.afterBlockId === undefined ? currentBlockId(day, now) : event.afterBlockId;
      day = insertAfter(day, ctx, now, after, block);
      eventCause = { kind: "detour" };
      steps.push({ phase: "event", kind: "detour", blockIds: [id], detail: label, cause: eventCause });
      break;
    }
    case "heat-rest": {
      eventCause = { kind: "heat" };
      const added: string[] = [];
      for (const bid of event.blockIds) {
        const idx = day.blocks.findIndex((b) => b.id === bid);
        if (idx < 0) continue;
        const b = day.blocks[idx];
        const from = placeOf(b, ctx) ?? day.origin;
        const later = new Set<string>(work.closedSpotIds);
        day.blocks.forEach((x, i) => {
          if (i > idx && !isInert(x) && x.spotId) later.add(x.spotId);
        });
        const found = pickRestSpot(ctx, day, from, undefined, b.endMin, event.minutes, REST_RADIUS_M.heavy, later);
        const id = nextId([...allBlockIds(work), ...added], "r");
        added.push(id);
        day = insertAfter(day, ctx, now, bid, makeRestBlock(id, event.minutes, 0, found?.id));
      }
      steps.push({ phase: "event", kind: "insert-rest", blockIds: added, detail: "暑さ対策の休憩", cause: eventCause });
      break;
    }
    case "extend-stay": {
      day = {
        ...day,
        blocks: day.blocks.map((b) => (b.id === event.blockId ? { ...b, durationMin: b.durationMin + event.minutes, endMin: b.endMin + event.minutes } : b)),
      };
      eventCause = { kind: "user" };
      steps.push({ phase: "event", kind: "extend-stay", blockIds: [event.blockId], detail: `${event.minutes}分延長`, cause: eventCause });
      break;
    }
    case "add-buffer": {
      const id = nextId(allBlockIds(work), "bf");
      const block: Block = { id, label: "buffer", durationMin: event.minutes, startMin: 0, endMin: event.minutes, travelMin: 0, travelMode: "none" };
      day = insertAfter(day, ctx, now, event.afterBlockId, block);
      eventCause = { kind: "user" };
      steps.push({ phase: "event", kind: "add-buffer", blockIds: [id], detail: `${event.minutes}分`, cause: eventCause });
      break;
    }
  }

  const otherUsed = new Set<string>();
  for (const d of work.days) if (d.index !== di) for (const b of d.blocks) if (b.spotId) otherUsed.add(b.spotId);
  const env: SettleEnv = {
    ctx,
    now,
    rc,
    otherUsed,
    closed: new Set(work.closedSpotIds),
    reorder: tiredPlan?.heavy === true,
    dietary: work.prefs.dietary,
  };

  /** イベントを適用した日を、再計算 → 調整 まで進める。ユーザーが確認して外すことにした Must・食事もここで外す */
  const finish = (d0: Day): { settled: Settled; pre: ReplanStep[] } => {
    let d = d0;
    const pre: ReplanStep[] = [];
    if (opts.removeMustIds?.length) {
      const ids = opts.removeMustIds.filter((id) => d.blocks.some((b) => b.id === id && (b.label === "must" || b.meal || b.detour)));
      d = { ...d, blocks: d.blocks.map((b) => (ids.includes(b.id) ? { ...b, skip: "skipped" as const } : b)) };
      if (ids.length) pre.push({ phase: "event", kind: "drop-must", blockIds: ids, detail: "確認済み", cause: { kind: "user" } });
    }
    return { settled: settle(rc(d, { delayMin }), env), pre };
  };

  let settled: Settled;
  let pre: ReplanStep[];
  if (tiredPlan) {
    const heavy = tiredPlan.heavy;
    const base: Day = heavy ? { ...day, lowWalking: true } : day;
    const placements = restPlacements(work, base, ctx, now, tiredPlan.minutes, tiredPlan.radiusM);
    const candidates = placements.map((pl) => {
      let d = pl.day;
      const eventSteps: ReplanStep[] = [{ phase: "event", kind: "insert-rest", blockIds: [pl.blockId], detail: pl.spot?.name, cause: { kind: "tired" } }];
      if (heavy) {
        // かなり疲れた: 残りの Optional は削る
        const optionals = d.blocks.filter((b) => b.label === "optional" && !b.meal && movable(b, now)).map((b) => b.id);
        d = { ...d, blocks: d.blocks.map((b) => (optionals.includes(b.id) ? { ...b, skip: "skipped" as const } : b)) };
        if (optionals.length) eventSteps.push({ phase: "event", kind: "drop-optional", blockIds: optionals, detail: "かなり疲れた", cause: { kind: "tired" } });
      }
      const r = finish(d);
      return { pl, eventSteps, ...r, loss: lossOf(itin.days[di], r.settled.day) };
    });
    // 解消できる案を優先し、そのなかで失うものが最小の案。同点なら早い位置（今いる場所での延長を含む）
    candidates.sort((a, b) => Number(a.settled.bad > 0) - Number(b.settled.bad > 0) || a.loss - b.loss || a.pl.order - b.pl.order);
    const chosen = candidates[0];
    day = chosen.pl.day;
    settled = chosen.settled;
    pre = [...chosen.eventSteps, ...chosen.pre];

    const { spot, mode, order, afterBlockId } = chosen.pl;
    if (mode === "extend" && spot) notes.push(`今いる場所（${spot.name}）で、休憩を${tiredPlan.minutes}分延長します。`);
    else if (mode === "generic") notes.push("近くに休憩できる屋内の場所が見つからなかったため、場所を決めない休憩を入れました。");
    if (order > 0 && afterBlockId) {
      const after = chosen.pl.day.blocks.find((b) => b.id === afterBlockId);
      if (after) notes.push(`休憩は「${blockName(after, ctx)}」のあとに入れます（予定を最も失わずに済む位置です）。`);
    }
    notes.push(
      tiredPlan.source === "walk-limit"
        ? "歩行距離が目安を超えそうなため、次の予定の前に休憩を入れる案です。"
        : "メンバーの1人が休憩を希望しています。",
    );
    notes.push("Must・食事と固定時刻は守ります。");
  } else {
    const r = finish(day);
    settled = r.settled;
    pre = r.pre;
  }

  day = settled.day;
  steps.push(...pre, ...settled.steps);
  const mustCandidates = settled.mustCandidates;

  /* ---- 3. まとめる ---- */
  // 最終便で締まる日は、その時刻より後の食事の「店が見つからない」警告は意味がないので外す
  const lastBoat = day.blocks.find((b) => b.fixed?.endsDay && !isInert(b));
  if (lastBoat?.fixed) {
    const t = lastBoat.fixed.timeMin;
    day = {
      ...day,
      warnings: day.warnings.filter(
        (w) => !((w.includes("ディナー") && t <= MEAL_WINDOW.dinner.latest) || (w.includes("ランチ") && t <= MEAL_WINDOW.lunch.earliest)),
      ),
    };
  }
  const finalDay = now === undefined ? commitBaseline(day) : day;
  work.days[di] = finalDay;
  const after = attachPlanBs(work, ctx, { nowMin: now, dayIndex: di });
  const finalized = after.days[di];

  const travelSuggestions: TravelSuggestion[] = [];
  if (event.type === "tired" && event.level === "heavy") {
    let from = finalized.origin.name;
    for (const b of finalized.blocks) {
      if (isInert(b)) continue;
      if (movable(b, now) && b.travelDistanceM) {
        const walkMin = walkMinutesFor(b.travelDistanceM);
        if (walkMin >= WALK_SUGGEST_MIN) {
          travelSuggestions.push({
            blockId: b.id,
            fromName: from,
            toName: blockName(b, ctx),
            walkMin,
            transitMin: transitMinutesFor(b.travelDistanceM),
            taxiMin: taxiMinutesFor(b.travelDistanceM),
          });
        }
      }
      if (placeOf(b, ctx)) from = blockName(b, ctx);
    }
  }

  const violations = collectViolations(finalized, ctx, now);
  const suggestions = suggestForGap(itin, after, ctx, { dayIndex: di, nowMin: now });

  // 差分のすべての変更に、理由（cause）とその文章を付ける
  const writer = opts.writer ?? templateWriter;
  const blockCause = new Map<string, Cause>();
  for (const st of steps) if (st.cause) for (const id of st.blockIds) blockCause.set(id, st.cause);
  const diff = diffItineraries(itin, after).map((item): DiffItem => {
    const cause = blockCause.get(item.blockId) ?? eventCause;
    return { ...item, cause, reason: writer.explain(cause, ctx, after) };
  });
  return {
    event,
    dayIndex: di,
    before: itin,
    after,
    steps,
    diff,
    violations,
    feasible: violations.length === 0,
    mustCandidates,
    travelSuggestions,
    suggestions,
    walkingBeforeM,
    walkingAfterM: dayWalking(finalized, ctx, itin.prefs.pace, now).remainingM,
    notes,
  };
}

/** いま進行中（開始済みで、まだ出発していない）のブロック。なければ、最後に開始した予定。どれもなければ null */
function currentBlockId(day: Day, now: number | undefined): string | null {
  let last: Block | undefined;
  for (const b of day.blocks) {
    if (isInert(b) || b.label === "buffer" || b.fixed) continue;
    if (isStarted(b, now)) last = b;
  }
  return last?.id ?? null;
}

/** afterBlockId のブロックの次に block を入れる。null なら、これから行く予定（開始前）の先頭に入れる */
function insertAfter(day: Day, ctx: PlanningContext, now: number | undefined, afterBlockId: string | null, block: Block): Day {
  let pos: number;
  if (afterBlockId === null) {
    const first = day.blocks.findIndex((b) => movable(b, now));
    pos = first < 0 ? day.blocks.length : first;
  } else {
    const i = day.blocks.findIndex((b) => b.id === afterBlockId);
    pos = i < 0 ? day.blocks.length : i + 1;
  }
  const prevEnd = day.blocks.slice(0, pos).reduce((m, b) => (isInert(b) ? m : Math.max(m, b.endMin)), day.startMin);
  const blocks = [...day.blocks];
  blocks.splice(pos, 0, { ...block, startMin: prevEnd, endMin: prevEnd + block.durationMin });
  return { ...day, blocks };
}

/** 提案のタイトル。「疲れた」はメンバーを特定しない書き方にする */
export function describeEvent(event: ReplanEvent, ctx: PlanningContext, itin: Itinerary): string {
  const nameOf = (id?: string) => (id ? ctx.spotById.get(id)?.name : undefined) ?? "予定";
  switch (event.type) {
    case "plan-b": {
      const first = itin.days.flatMap((d) => d.blocks).find((b) => b.id === event.blockIds[0]);
      return event.blockIds.length === 1
        ? `「${nameOf(first?.spotId)}」を${first?.switched ? "元の予定に戻す" : "Plan B に切り替え"}`
        : `屋外の予定 ${event.blockIds.length}件を Plan B に切り替え`;
    }
    case "delay":
      return `電車が${event.minutes}分遅延`;
    case "closure":
      return `「${nameOf(event.spotId)}」が臨時休業${event.replacementSpotId ? ` → 「${nameOf(event.replacementSpotId)}」に切り替え` : ""}`;
    case "tired":
      if (event.source === "walk-limit") return "歩行距離が目安を超えそう → 休憩を入れる";
      return `メンバーの1人が休憩を希望（${event.level === "light" ? "少し休みたい" : "かなり疲れた"}）`;
    case "fixed-add":
      return `固定時刻を追加：${event.fixed.title}`;
    case "fixed-remove": {
      const found = itin.days.flatMap((d) => [...d.blocks.map((b) => b.fixed), ...(d.memberFixed ?? [])]).find((f) => f?.id === event.fixedId);
      return `固定時刻を外す：${found?.title ?? ""}`;
    }
    case "fixed-move": {
      const found = itin.days.flatMap((d) => [...d.blocks.map((b) => b.fixed), ...(d.memberFixed ?? [])]).find((f) => f?.id === event.fixedId);
      return `固定時刻を ${hm(event.timeMin)} に変更：${event.title ?? found?.title ?? ""}`;
    }
    case "add-spot":
      return `「${nameOf(event.spotId)}」を予定に追加`;
    case "add-rest":
      return event.spotId ? `「${nameOf(event.spotId)}」で${event.minutes}分休む` : `休憩を${event.minutes}分入れる`;
    case "progress": {
      const b = itin.days.flatMap((d) => d.blocks).find((x) => x.id === event.blockId);
      const name = b?.free?.name ?? nameOf(b?.spotId);
      return `「${name}」に${event.kind === "arrived" ? "着いた" : "出発した"}（${hm(event.atMin)}）`;
    }
    case "detour":
      return "name" in event.stop ? `寄り道：${event.stop.name}（${event.stop.durationMin}分）` : `寄り道：「${nameOf(event.stop.spotId)}」`;
    case "heat-rest":
      return `暑さ対策：屋外の予定の後に${event.minutes}分休憩（${event.blockIds.length}件）`;
    case "extend-stay":
      return `滞在を${event.minutes}分延長`;
    case "add-buffer":
      return `余白を${event.minutes}分増やす`;
    case "margin":
      return `固定時刻の余裕時間を${event.marginMin}分に変更`;
    case "skip":
      return `予定をスキップ`;
    case "restore":
      return `スキップを取り消す`;
  }
}
