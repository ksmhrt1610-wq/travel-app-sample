import { findOpenSlot } from "./availability";
import { replaceSpotOfBlock, swapPlanB } from "./actions";
import { diffItineraries, type DiffItem } from "./diff";
import { createFixedBlock, isGroupWide, nextId } from "./fixed";
import { haversineM, taxiMinutesFor, transitMinutesFor, walkMinutesFor } from "./geo";
import { attachPlanBs } from "./planb";
import { MEAL_WINDOW } from "./planner";
import {
  commitBaseline,
  DAY_END_TOLERANCE_MIN,
  DEFAULT_MARGIN_MIN,
  dayTravel,
  isInert,
  placeOf,
  recomputeDay,
  type RecomputeOptions,
} from "./schedule";
import { dayWalking } from "./walking";
import type { Block, BlockIssue, Day, FixedEvent, Itinerary, LatLng, PlanningContext, Spot } from "./types";

/**
 * 再計画エンジン。
 * 雨（Plan B 切替）・遅延・臨時休業・疲れた・固定時刻の追加などを、すべてこの1つの関数で扱う。
 *
 * 結果は「提案」で、元の旅程は変えない。UI は差分を見せ、確定ボタンで result.after を反映する。
 *
 * 組み直しの優先順位（高い順）: 固定時刻 > Must > 休憩・余白 > Optional
 * （「標準」は Optional と Must の中間として扱う。余白は遅れの吸収材として先に縮む。
 *   「疲れた」で入れた休憩は保護され、Optional より先に削られない）
 *
 * 時間が足りないときは、次の順で削る。
 *   1. Optional を、違反に近い後ろ側から削除
 *   2. 各スポットの滞在時間を、最低滞在時間まで短縮
 *   3. 標準を、後ろから削除
 *   4. それでも足りなければ Must を「削る候補」として提示する（勝手には削らない）
 */

export type ReplanEvent =
  /** Plan B への切り替え（雨など）。切替済みなら元に戻る */
  | { type: "plan-b"; blockIds: string[] }
  | { type: "delay"; minutes: number }
  | { type: "closure"; spotId: string; replacementSpotId?: string }
  | { type: "tired"; level: "light" | "heavy"; source?: "member" | "walk-limit" }
  | { type: "fixed-add"; fixed: FixedEvent }
  | { type: "fixed-remove"; fixedId: string }
  | { type: "margin"; marginMin: number }
  | { type: "skip"; blockIds: string[] }
  | { type: "restore"; blockId: string };

export interface ReplanOptions {
  /** 操作の対象の日 */
  dayIndex: number;
  /** 現在時刻（0:00 からの分）。当日モードでのみ指定する。開始済みの予定は動かさない */
  nowMin?: number;
  /** ユーザーが確認して「削ってよい」とした Must のブロック ID */
  removeMustIds?: string[];
}

export type StepKind =
  | "plan-b"
  | "delay"
  | "closure"
  | "replace"
  | "insert-rest"
  | "fixed-add"
  | "fixed-remove"
  | "margin"
  | "skip"
  | "restore"
  | "drop-must"
  | "drop-optional"
  | "shorten"
  | "drop-standard"
  | "reorder"
  | "tidy";

export interface ReplanStep {
  /** event: イベントそのものの適用 / reduce: 時間が足りないときの削減（順序固定） / tidy: 後始末 */
  phase: "event" | "reduce" | "tidy";
  kind: StepKind;
  blockIds: string[];
  detail?: string;
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
  /** 固定時刻・営業時間・終了予定時刻に問題がない */
  feasible: boolean;
  /** 足りないとき、削る候補として提示する Must（自動では削っていない） */
  mustCandidates: MustCandidate[];
  /** 徒歩20分以上かかる移動への、公共交通・タクシーの提案（かなり疲れたのとき） */
  travelSuggestions: TravelSuggestion[];
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

/** 最低滞在時間（分）。スポットの指定があればそれ、なければ標準滞在時間の半分（15分未満にはしない） */
export function minStayOf(spot: Spot): number {
  return spot.minStayMin ?? Math.max(15, Math.round((spot.stayMin * 0.5) / 5) * 5);
}

/* ---------- 補助 ---------- */

const startedAt = (b: Block, now: number | undefined) => now !== undefined && b.startMin <= now;
const movable = (b: Block, now: number | undefined) => !isInert(b) && !startedAt(b, now);

function blockName(b: Block, ctx: PlanningContext): string {
  if (b.fixed) return b.fixed.title;
  if (b.spotId) return ctx.spotById.get(b.spotId)?.name ?? "予定";
  return b.label === "rest" ? "休憩" : b.label === "buffer" ? "余白" : "予定";
}

/** 問題の大きさ。0 なら問題なし。固定時刻・営業時間の違反は重く、終了予定時刻の超過は超過分（分） */
function badness(day: Day, now: number | undefined): number {
  let n = 0;
  for (const b of day.blocks) {
    if (!movable(b, now) && !(b.fixed && !isInert(b) && !startedAt(b, now))) continue;
    for (const issue of b.issues ?? []) {
      if (issue === "fixed-missed" || issue === "outside-hours") n += BAD_WEIGHT + (b.lateByMin ?? 1);
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

/* ---------- 休憩の挿入 ---------- */

interface RestPlacement {
  day: Day;
  blockId: string;
  spot?: Spot;
}

/**
 * 次の予定の前に休憩を入れる。近くの屋内カフェ（休憩できる施設）があればそこで、なければ場所を決めない休憩にする。
 * 休憩は保護され、Optional より先には削られない。
 */
function insertRest(itin: Itinerary, day: Day, ctx: PlanningContext, now: number | undefined, minutes: number, radiusM: number): RestPlacement {
  const upcoming = day.blocks.findIndex((b) => movable(b, now));
  const at = upcoming < 0 ? day.blocks.length : upcoming;

  let prevPlace: LatLng = day.origin;
  let prevEnd = day.startMin;
  for (let i = 0; i < at; i++) {
    const b = day.blocks[i];
    if (isInert(b)) continue;
    prevEnd = Math.max(prevEnd, b.endMin);
    const p = placeOf(b, ctx);
    if (p) prevPlace = p;
  }
  let nextPlace: LatLng | undefined;
  for (let i = at; i < day.blocks.length && !nextPlace; i++) if (!isInert(day.blocks[i])) nextPlace = placeOf(day.blocks[i], ctx);

  const t0 = Math.max(prevEnd, now ?? 0);
  const travel = dayTravel(day, ctx);
  const used = new Set<string>(itin.closedSpotIds);
  for (const d of itin.days) for (const b of d.blocks) if (b.spotId) used.add(b.spotId);

  let best: { spot: Spot; score: number } | null = null;
  for (const s of ctx.spots) {
    if (used.has(s.id) || s.setting !== "indoor") continue;
    if (s.category !== "cafe" && !s.tags?.includes("cafe")) continue;
    const d = haversineM(prevPlace, s);
    if (d > radiusM) continue;
    const slot = findOpenSlot(s, day.date, t0 + travel(prevPlace, s).minutes, minutes);
    if (!slot) continue;
    const score = d + (nextPlace ? 0.5 * haversineM(s, nextPlace) : 0);
    if (!best || score < best.score) best = { spot: s, score };
  }

  const id = nextId(allBlockIds(itin), "r");
  const block: Block = best
    ? {
        id,
        label: "rest",
        spotId: best.spot.id,
        durationMin: minutes,
        startMin: t0,
        endMin: t0 + minutes,
        plannedStartMin: 0,
        travelMin: 0,
        travelMode: "none",
      }
    : { id, label: "rest", durationMin: minutes, startMin: t0, endMin: t0 + minutes, travelMin: 0, travelMode: "none" };
  const blocks = [...day.blocks];
  blocks.splice(at, 0, block);
  return { day: { ...day, blocks }, blockId: id, spot: best?.spot };
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
    movable(b, now) &&
    !b.fixed &&
    (b.label === "must" || b.label === "normal") &&
    !!b.spotId &&
    !ctx.spotById.get(b.spotId)?.mealSlots;

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

/* ---------- 本体 ---------- */

export function replan(itin: Itinerary, event: ReplanEvent, ctx: PlanningContext, opts: ReplanOptions): ReplanResult {
  const work: Itinerary = structuredClone(itin);
  work.members ??= [];
  work.settings ??= { marginMin: DEFAULT_MARGIN_MIN };
  let margin = work.settings.marginMin;
  const steps: ReplanStep[] = [];
  const notes: string[] = [];

  let di = event.type === "fixed-add" ? event.fixed.dayIndex : opts.dayIndex;
  if (event.type === "fixed-remove") {
    const found = work.days.find((d) => d.blocks.some((b) => b.id === event.fixedId) || d.memberFixed?.some((f) => f.id === event.fixedId));
    if (found) di = found.index;
  }
  const now = di === opts.dayIndex ? opts.nowMin : undefined;
  let day: Day = work.days[di];
  const walkingBeforeM = dayWalking(itin.days[di], ctx, itin.prefs.pace, now).remainingM;

  const rc = (d: Day, extra: Partial<RecomputeOptions> = {}): Day => recomputeDay(d, ctx, { mode: "preserve", nowMin: now, marginMin: margin, ...extra });
  const dropIds = (d: Day, ids: string[]): Day =>
    rc({ ...d, blocks: d.blocks.map((b) => (ids.includes(b.id) ? { ...b, skip: "skipped" as const } : b)) });

  /* ---- 1. イベントを適用する ---- */
  let delayMin = 0;
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
      steps.push({ phase: "event", kind: "plan-b", blockIds: changed });
      break;
    }
    case "delay":
      delayMin = event.minutes;
      steps.push({ phase: "event", kind: "delay", blockIds: [], detail: `${event.minutes}分` });
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
      steps.push({ phase: "event", kind: event.replacementSpotId ? "replace" : "closure", blockIds: hit });
      break;
    }
    case "tired": {
      const light = event.level === "light";
      if (!light) day = { ...day, lowWalking: true };
      const rest = insertRest(work, day, ctx, now, REST_MINUTES[event.level], REST_RADIUS_M[event.level]);
      day = rest.day;
      steps.push({ phase: "event", kind: "insert-rest", blockIds: [rest.blockId], detail: rest.spot?.name });
      if (!rest.spot) notes.push("近くに休憩できる屋内カフェが見つからなかったため、場所を決めない休憩を入れました。");
      if (!light) {
        const optionals = day.blocks.filter((b) => b.label === "optional" && movable(b, now)).map((b) => b.id);
        day = {
          ...day,
          blocks: day.blocks.map((b) => (optionals.includes(b.id) ? { ...b, skip: "skipped" as const } : b)),
        };
        if (optionals.length) steps.push({ phase: "event", kind: "drop-optional", blockIds: optionals, detail: "かなり疲れた" });
      }
      notes.push(
        event.source === "walk-limit"
          ? "歩行距離が目安を超えそうなため、次の予定の前に休憩を入れる案です。"
          : "メンバーの1人が休憩を希望しています。",
      );
      notes.push("Must と固定時刻は守ります。");
      break;
    }
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
      steps.push({ phase: "event", kind: "fixed-add", blockIds: [ev.id], detail: ev.title });
      break;
    }
    case "fixed-remove": {
      day = {
        ...day,
        blocks: day.blocks.filter((b) => b.id !== event.fixedId),
        memberFixed: (day.memberFixed ?? []).filter((f) => f.id !== event.fixedId),
      };
      steps.push({ phase: "event", kind: "fixed-remove", blockIds: [event.fixedId] });
      break;
    }
    case "margin":
      margin = event.marginMin;
      work.settings.marginMin = margin;
      steps.push({ phase: "event", kind: "margin", blockIds: [], detail: `${margin}分` });
      break;
    case "skip": {
      const ids = new Set(event.blockIds);
      day = { ...day, blocks: day.blocks.map((b) => (ids.has(b.id) ? { ...b, skip: "skipped" as const } : b)) };
      steps.push({ phase: "event", kind: "skip", blockIds: [...ids] });
      break;
    }
    case "restore":
      day = { ...day, blocks: day.blocks.map((b) => (b.id === event.blockId ? { ...b, skip: undefined } : b)) };
      steps.push({ phase: "event", kind: "restore", blockIds: [event.blockId] });
      break;
  }

  // ユーザーが確認して外すことにした Must
  if (opts.removeMustIds?.length) {
    const ids = opts.removeMustIds.filter((id) => day.blocks.some((b) => b.id === id && b.label === "must"));
    day = { ...day, blocks: day.blocks.map((b) => (ids.includes(b.id) ? { ...b, skip: "skipped" as const } : b)) };
    if (ids.length) steps.push({ phase: "event", kind: "drop-must", blockIds: ids, detail: "確認済み" });
  }

  day = rc(day, { delayMin });

  // 最終便のあとの余白は意味がないので片づける
  const endIdx = day.blocks.findIndex((b) => b.fixed?.endsDay && !isInert(b));
  if (endIdx >= 0) {
    const tidy = day.blocks.slice(endIdx + 1).filter((b) => b.label === "buffer" && !isInert(b)).map((b) => b.id);
    if (tidy.length) {
      day = dropIds(day, tidy);
      steps.push({ phase: "tidy", kind: "tidy", blockIds: tidy, detail: "最終便のあとの余白" });
    }
  }

  // かなり疲れた: 近い順に並べ直す
  if (event.type === "tired" && event.level === "heavy") {
    const r = reorderNearest(day, ctx, now, rc);
    day = r.day;
    if (r.moved.length) steps.push({ phase: "event", kind: "reorder", blockIds: r.moved, detail: "近い順" });
  }

  /* ---- 2. 時間が足りなければ、優先順位の低いものから削る ---- */
  let cur = badness(day, now);

  // (1) Optional を、違反に近い後ろ側から削除
  while (cur > 0) {
    const pool = day.blocks.filter((b) => b.label === "optional" && movable(b, now)).reverse();
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
    day = hit.trial;
    cur = hit.bad;
    steps.push({ phase: "reduce", kind: "drop-optional", blockIds: [hit.b.id] });
  }

  // (2) 各スポットの滞在時間を、最低滞在時間まで短縮
  const shortenAt = steps.length; // 短縮の記録は、Optional の削除のあと・標準の削除の前に入れる
  const shortened = new Map<string, { from: number; to: number }>();
  for (let guard = 0; cur > 0 && guard < 400; guard++) {
    let best: { id: string; trial: Day; bad: number; room: number; idx: number } | null = null;
    day.blocks.forEach((b, idx) => {
      if (!movable(b, now) || b.fixed || b.label === "buffer" || b.label === "rest" || !b.spotId) return;
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
    const prevRec = shortened.get(chosen.id);
    shortened.set(chosen.id, { from: prevRec?.from ?? before, to: after });
    day = chosen.trial;
    cur = chosen.bad;
  }

  // (3) 標準を、後ろから削除
  while (cur > 0) {
    const pool = day.blocks.filter((b) => b.label === "normal" && movable(b, now)).reverse();
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
    day = hit.trial;
    cur = hit.bad;
    steps.push({ phase: "reduce", kind: "drop-standard", blockIds: [hit.b.id] });
  }

  // 結局スキップされたブロックは、短縮の記録から外して元の滞在時間に戻す（あとで取り消したときに短いままにならないように）
  const shortenSteps: ReplanStep[] = [];
  day = {
    ...day,
    blocks: day.blocks.map((b) => {
      const r = shortened.get(b.id);
      if (!r) return b;
      if (b.skip === "skipped") return { ...b, durationMin: r.from };
      shortenSteps.push({ phase: "reduce", kind: "shorten", blockIds: [b.id], detail: `${r.from}分 → ${r.to}分` });
      return b;
    }),
  };
  steps.splice(shortenAt, 0, ...shortenSteps);

  // (4) それでも足りなければ、Must を削る候補として提示する（削らない）
  const mustCandidates: MustCandidate[] = [];
  if (cur > 0) {
    for (const b of [...day.blocks].reverse()) {
      if (b.label !== "must" || !movable(b, now)) continue;
      const bad = badness(dropIds(day, [b.id]), now);
      if (bad < cur) mustCandidates.push({ blockId: b.id, spotId: b.spotId, name: blockName(b, ctx), fixesAll: bad === 0 });
    }
  }

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
  return {
    event,
    dayIndex: di,
    before: itin,
    after,
    steps,
    diff: diffItineraries(itin, after),
    violations,
    feasible: violations.length === 0,
    mustCandidates,
    travelSuggestions,
    walkingBeforeM,
    walkingAfterM: dayWalking(finalized, ctx, itin.prefs.pace, now).remainingM,
    notes,
  };
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
    case "margin":
      return `固定時刻の余裕時間を${event.marginMin}分に変更`;
    case "skip":
      return `予定をスキップ`;
    case "restore":
      return `スキップを取り消す`;
  }
}

/**
 * 確認なしでそのまま反映してよい変更か。
 * 余裕時間の変更・固定時刻を外すだけで、何も削らず、問題も出ないとき。
 * それ以外（雨・遅延・休業・疲れた・固定時刻の追加など）は、必ず差分を見せて確定ボタンで反映する。
 */
export function isQuietChange(result: ReplanResult): boolean {
  return (
    (result.event.type === "margin" || result.event.type === "fixed-remove") &&
    result.feasible &&
    result.mustCandidates.length === 0 &&
    result.steps.every((s) => s.phase === "event")
  );
}
