import { findOpenSlot } from "./availability";
import { earlierServices, fixedDeparture } from "./fixed";
import { haversineM } from "./geo";
import { dayTravel, DEFAULT_MARGIN_MIN, isInert, isStarted, placeOf } from "./schedule";
import { baseScore } from "./scoring";
import { formatHHMM } from "./time";
import type { ReplanEvent } from "./replan";
import type { Block, Day, Itinerary, LatLng, PlanningContext } from "./types";

/**
 * 最終便の前に長い空きができたときの提案。
 * どれも提案だけで、自動では反映しない（選んだら replan のイベントとして提案→確定の流れに乗る）。
 *   - 早い便で帰る（固定時刻を前倒し）
 *   - 近くで Optional を1件足す
 *   - 駅の近くの休める場所で待つ
 */

/** この長さ（分）以上の空きができたら提案する */
export const GAP_SUGGEST_MIN = 60;
/** 「近く」の範囲（m） */
const NEARBY_M = 1000;
const STATION_NEARBY_M = 800;
const MAX_WAIT_MIN = 90;
const MIN_WAIT_MIN = 30;

export interface Suggestion {
  id: string;
  kind: "earlier-transport" | "add-optional" | "wait-nearby" | "extend-stay" | "add-buffer";
  title: string;
  detail: string;
  /** 選んだときに replan へ渡すイベント */
  event: ReplanEvent;
}

export interface LastTransportGap {
  fixedBlockId: string;
  /** 空き（分）= 出発すべき時刻 − 直前の予定の終わり（いま以降） */
  gapMin: number;
  /** 空きが始まる時刻 */
  startMin: number;
  departBy: number;
  /** 空きの前の最後の予定（なければ undefined） */
  lastBlockId?: string;
  from: LatLng;
}

/** 最終便（その日を終える固定時刻）の前の空き。最終便がなければ null */
export function lastTransportGap(day: Day, ctx: PlanningContext, marginMin: number, nowMin?: number): LastTransportGap | null {
  const fi = day.blocks.findIndex((b) => b.fixed?.endsDay && !isInert(b) && (nowMin === undefined || b.fixed.timeMin > nowMin));
  if (fi < 0) return null;
  const dep = fixedDeparture(day, fi, ctx, marginMin);
  if (!dep) return null;

  let last: Block | undefined;
  for (let i = fi - 1; i >= 0; i--) {
    const b = day.blocks[i];
    if (isInert(b) || b.label === "buffer") continue;
    last = b;
    break;
  }
  const startMin = Math.max(last?.endMin ?? day.startMin, nowMin ?? 0);
  const from: LatLng = dep.pred ? placeOf(dep.pred, ctx)! : day.origin;
  return { fixedBlockId: day.blocks[fi].id, gapMin: dep.departBy - startMin, startMin, departBy: dep.departBy, lastBlockId: last?.id, from };
}

/** 空きがあるとき（GAP_SUGGEST_MIN 以上）の提案。空きがなければ空 */
export function suggestionsForDay(itin: Itinerary, ctx: PlanningContext, opts: { dayIndex: number; nowMin?: number }): Suggestion[] {
  const day = itin.days[opts.dayIndex];
  if (!day) return [];
  const margin = itin.settings?.marginMin ?? DEFAULT_MARGIN_MIN;
  const gap = lastTransportGap(day, ctx, margin, opts.nowMin);
  if (!gap || gap.gapMin < GAP_SUGGEST_MIN) return [];

  const fixedBlock = day.blocks.find((b) => b.id === gap.fixedBlockId)!;
  const fixed = fixedBlock.fixed!;
  const station = fixedBlock.place ?? fixed.place;
  const travel = dayTravel(day, ctx);
  const out: Suggestion[] = [];

  // 1. 早い便で帰る
  const travelToStation = travel(gap.from, station).minutes;
  const fits = earlierServices(station.name, fixed.timeMin).filter(
    (t) => fixed.timeMin - t >= 30 && t >= gap.startMin + travelToStation + margin,
  );
  const picks = fits.length <= 2 ? fits : [fits[fits.length - 1], fits[0]];
  for (const t of picks) {
    const title = `${station.name} ${formatHHMM(t)} の便（早い便）`;
    out.push({
      id: `earlier:${fixed.id}:${t}`,
      kind: "earlier-transport",
      title: `早い便で帰る：${formatHHMM(t)} 発`,
      detail: `${fixed.title} を ${formatHHMM(t)} の便に変えると、${fixed.timeMin - t}分早く帰れます。`,
      event: { type: "fixed-move", fixedId: fixed.id, timeMin: t, title },
    });
  }

  // 2. 近くで Optional を1件足す
  const used = new Set<string>(itin.closedSpotIds);
  for (const d of itin.days) for (const b of d.blocks) if (b.spotId) used.add(b.spotId);
  let bestSpot: { id: string; name: string; stay: number; score: number } | null = null;
  for (const sp of ctx.spots) {
    if (used.has(sp.id) || sp.mealSlots) continue;
    const d = haversineM(gap.from, sp);
    if (d > NEARBY_M) continue;
    const slot = findOpenSlot(sp, day.date, gap.startMin + travel(gap.from, sp).minutes, sp.stayMin);
    if (!slot) continue;
    const end = slot.start + sp.stayMin;
    if (end + travel(sp, station).minutes + margin > fixed.timeMin) continue;
    const score = baseScore(sp, itin.prefs) - d / 1000;
    if (!bestSpot || score > bestSpot.score) bestSpot = { id: sp.id, name: sp.name, stay: sp.stayMin, score };
  }
  if (bestSpot) {
    out.push({
      id: `add:${bestSpot.id}`,
      kind: "add-optional",
      title: `近くの「${bestSpot.name}」に寄る`,
      detail: `${bestSpot.stay}分の Optional として追加します。最終便には間に合います。`,
      event: { type: "add-spot", spotId: bestSpot.id, afterBlockId: gap.lastBlockId ?? null, label: "optional" },
    });
  }

  // 3. 駅の近くの休める場所で待つ
  let bestRest: { id: string; name: string; minutes: number; dist: number } | null = null;
  for (const sp of ctx.spots) {
    if (!sp.restable || sp.setting !== "indoor" || itin.closedSpotIds.includes(sp.id)) continue;
    const dist = haversineM(station, sp);
    if (dist > STATION_NEARBY_M) continue;
    const avail = fixed.timeMin - margin - gap.startMin - travel(gap.from, sp).minutes - travel(sp, station).minutes;
    const minutes = Math.floor(Math.min(MAX_WAIT_MIN, avail) / 5) * 5;
    if (minutes < MIN_WAIT_MIN) continue;
    const slot = findOpenSlot(sp, day.date, gap.startMin + travel(gap.from, sp).minutes, minutes);
    if (!slot) continue;
    if (!bestRest || dist < bestRest.dist) bestRest = { id: sp.id, name: sp.name, minutes, dist };
  }
  if (bestRest) {
    out.push({
      id: `wait:${bestRest.id}`,
      kind: "wait-nearby",
      title: `駅の近くの「${bestRest.name}」で待つ`,
      detail: `最終便まで${bestRest.minutes}分、屋内で休んで待ちます。`,
      event: { type: "add-rest", afterBlockId: gap.lastBlockId ?? null, minutes: bestRest.minutes, spotId: bestRest.id },
    });
  }
  return out;
}

/**
 * 組み直しの結果として空きができた（GAP_SUGGEST_MIN 以上になり、組み直す前より広がった）ときだけ提案を返す。
 */
export function suggestForGap(before: Itinerary, after: Itinerary, ctx: PlanningContext, opts: { dayIndex: number; nowMin?: number }): Suggestion[] {
  const margin = after.settings?.marginMin ?? DEFAULT_MARGIN_MIN;
  const gapAfter = after.days[opts.dayIndex] ? lastTransportGap(after.days[opts.dayIndex], ctx, margin, opts.nowMin) : null;
  if (!gapAfter || gapAfter.gapMin < GAP_SUGGEST_MIN) return [];
  const bDay = before.days[opts.dayIndex];
  const gapBefore = bDay ? lastTransportGap(bDay, ctx, before.settings?.marginMin ?? DEFAULT_MARGIN_MIN, opts.nowMin) : null;
  if (gapBefore && gapBefore.gapMin >= gapAfter.gapMin) return [];
  return suggestionsForDay(after, ctx, opts);
}

/* ---------- 早く進んだとき（実績: 着いた・出発した） ---------- */

/** 予定より何分以上早く進んだら提案するか */
export const EARLY_SUGGEST_MIN = 30;

export interface EarlyProgress {
  /** 実績を記録した、いちばん新しい予定 */
  anchorBlockId: string;
  /** 予定より何分早く進んでいるか */
  earlyByMin: number;
  /** 次の予定までに使える空き（分） */
  idleMin: number;
  /** まだその予定にいる（着いたが、まだ出発していない） */
  stillThere: boolean;
  nextBlockId: string;
}

/**
 * 実績（着いた・出発した）から、予定より早く進んでいるかを求める。
 * 確定済みの旅程から毎回導出するので、どのモードで記録しても、同じ提案が出る（提案のみで、自動では反映しない）。
 */
export function earlyProgress(day: Day, ctx: PlanningContext, nowMin: number): EarlyProgress | null {
  let anchorIdx = -1;
  day.blocks.forEach((b, i) => {
    if (!isInert(b) && (b.actualStartMin !== undefined || b.actualEndMin !== undefined)) anchorIdx = i;
  });
  if (anchorIdx < 0) return null;
  const anchor = day.blocks[anchorIdx];
  const departed = anchor.actualEndMin !== undefined;
  const planned = departed ? (anchor.plannedEndMin ?? anchor.endMin) : (anchor.plannedStartMin ?? anchor.startMin);
  const actual = departed ? anchor.actualEndMin! : anchor.actualStartMin!;
  const earlyByMin = planned - actual;
  if (earlyByMin < EARLY_SUGGEST_MIN) return null;

  const next = day.blocks.find(
    (b, i) => i > anchorIdx && !isInert(b) && !isStarted(b, nowMin) && b.label !== "buffer" && b.label !== "rest" && (!!placeOf(b, ctx) || !!b.free || !!b.fixed),
  );
  if (!next) return null;
  const idleMin = next.startMin - (anchor.endMin + next.travelMin);
  if (idleMin < 15) return null;
  return { anchorBlockId: anchor.id, earlyByMin, idleMin, stillThere: !departed, nextBlockId: next.id };
}

/**
 * 早く進んだときの提案（モードに関係なく、提案のみ）。
 *   - いまの場所での滞在延長（まだその予定にいるとき）
 *   - 近く（1km以内）の、まだ旅程に入っていないスポットを1件追加
 *   - 余白を増やす
 */
export function suggestForEarly(itin: Itinerary, ctx: PlanningContext, opts: { dayIndex: number; nowMin: number }): Suggestion[] {
  const day = itin.days[opts.dayIndex];
  if (!day) return [];
  const early = earlyProgress(day, ctx, opts.nowMin);
  if (!early) return [];
  const anchor = day.blocks.find((b) => b.id === early.anchorBlockId)!;
  const next = day.blocks.find((b) => b.id === early.nextBlockId)!;
  const travel = dayTravel(day, ctx);
  const out: Suggestion[] = [];
  const free = Math.floor(early.idleMin / 5) * 5;

  // 1. いまの場所での滞在延長
  const here = anchor.spotId ? ctx.spotById.get(anchor.spotId) : undefined;
  if (early.stillThere && here) {
    const minutes = Math.floor(Math.min(free, 60) / 5) * 5;
    const ok = minutes >= 15 && findOpenSlot(here, day.date, anchor.startMin, anchor.durationMin + minutes)?.start === anchor.startMin;
    if (ok) {
      out.push({
        id: `extend:${anchor.id}`,
        kind: "extend-stay",
        title: `「${here.name}」での滞在を${minutes}分延長`,
        detail: `予定より${early.earlyByMin}分早く進んでいます。ここでゆっくりできます。`,
        event: { type: "extend-stay", blockId: anchor.id, minutes },
      });
    }
  }

  // 2. 近くのスポットを1件追加
  const from: LatLng = placeOf(anchor, ctx) ?? day.origin;
  const nextPlace = placeOf(next, ctx) ?? (next.fixed?.place as LatLng | undefined);
  const used = new Set<string>(itin.closedSpotIds);
  for (const d of itin.days) for (const b of d.blocks) if (b.spotId) used.add(b.spotId);
  let best: { id: string; name: string; stay: number; score: number } | null = null;
  for (const sp of ctx.spots) {
    if (used.has(sp.id) || sp.mealSlots) continue;
    const d = haversineM(from, sp);
    if (d > NEARBY_M) continue;
    const arrive = anchor.endMin + travel(from, sp).minutes;
    const slot = findOpenSlot(sp, day.date, arrive, sp.stayMin);
    if (!slot) continue;
    const end = slot.start + sp.stayMin;
    const back = nextPlace ? travel(sp, nextPlace).minutes : next.travelMin;
    if (end + back > next.startMin) continue;
    const score = baseScore(sp, itin.prefs) - d / 1000;
    if (!best || score > best.score) best = { id: sp.id, name: sp.name, stay: sp.stayMin, score };
  }
  if (best) {
    out.push({
      id: `add:${best.id}`,
      kind: "add-optional",
      title: `近くの「${best.name}」にも寄る`,
      detail: `${best.stay}分の Optional として追加します。次の予定には間に合います。`,
      event: { type: "add-spot", spotId: best.id, afterBlockId: anchor.id, label: "optional" },
    });
  }

  // 3. 余白を増やす
  if (free >= 15) {
    out.push({
      id: `buffer:${anchor.id}`,
      kind: "add-buffer",
      title: `余白を${free}分増やす`,
      detail: "予定を足さず、ゆっくり休んだり移動したりする時間にします。",
      event: { type: "add-buffer", afterBlockId: anchor.id, minutes: free },
    });
  }
  return out;
}
