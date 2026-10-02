import { itineraryChanged } from "./history";
import type { ReplanResult } from "./replan";
import { isInert } from "./schedule";
import { BUDGET_COMFORT } from "./scoring";
import type { Block, Itinerary, PlanningContext, ResponseMode } from "./types";

/**
 * 変更の重さ（軽い／重い）と、モードごとの確定のしかた。
 *
 * 軽い変更（元に戻せる）: 時刻のずれ・余白の伸縮、Plan B への入れ替え、Optional の削除・スキップ、
 *                          休憩の挿入、滞在の延長・短縮（最低滞在まで）
 * 重い変更（必ず確認）: 標準・食事・Must の削除、Must の入れ替え、固定時刻・予約が絡む変更、
 *                        追加の費用（予算を超えるスポット）、予定の半分以上が変わる変更、
 *                        間に合わない予定が残る・Must／食事を削る候補が出る案
 * 軽いものと重いものが混ざる組み直しは、全体を重い変更として扱う。
 */

export type ChangeWeight = "light" | "heavy";

export interface Classification {
  weight: ChangeWeight;
  /** 重い変更とした理由（画面に出す。軽いときは空） */
  reasons: string[];
}

export const DEFAULT_MODE: ResponseMode = "suggest";

export const MODE_LABEL: Record<ResponseMode, string> = { manual: "手動", suggest: "提案", auto: "おまかせ" };
export const MODE_HELP: Record<ResponseMode, string> = {
  manual: "出来事は自分で入力。変更はすべて、差分を見て確定します。",
  suggest: "アプリが気づいて知らせます。軽い変更はワンタップ、重い変更は差分を見て確定します。",
  auto: "軽い変更はアプリが自動で反映して知らせます（元に戻せます）。重い変更は必ず確認します。",
};

export function modeOf(itin: Pick<Itinerary, "settings"> | undefined): ResponseMode {
  return itin?.settings?.mode ?? DEFAULT_MODE;
}

/** 「予定の半分以上が変わる」とみなす、内容が変わった予定の割合と、最小の件数 */
export const LARGE_CHANGE_RATIO = 0.5;
export const LARGE_CHANGE_MIN_COUNT = 2;

const isPlanBlock = (b: Block) => !isInert(b) && !b.fixed && b.label !== "buffer" && b.label !== "rest" && !!b.spotId;

/**
 * 何も変わらない結果（例: 現在時刻より前の固定時刻は追加しない）。確認の画面は出さず、notes の理由だけを知らせる。
 * 削る候補（mustCandidates）があるときは、選んでもらう必要があるので、何も変わらなくても空振りとはみなさない。
 */
export function isNoOp(result: ReplanResult): boolean {
  return !itineraryChanged(result.before, result.after) && result.mustCandidates.length === 0;
}

export function classifyChange(result: ReplanResult, ctx: PlanningContext): Classification {
  const reasons: string[] = [];
  if (isNoOp(result)) return { weight: "light", reasons };
  const before = result.before.days[result.dayIndex];
  const after = result.after.days[result.dayIndex];
  const nameOf = (id?: string) => (id ? ctx.spotById.get(id)?.name : undefined) ?? "予定";
  if (!before || !after) return { weight: "light", reasons };

  const now = new Map(after.blocks.map((b) => [b.id, b]));

  // 1. 標準・食事・Must を外す／Must を別のスポットに入れ替える
  const lost: string[] = [];
  const swappedMust: string[] = [];
  for (const b of before.blocks) {
    if (isInert(b) || b.fixed) continue;
    const a = now.get(b.id);
    const gone = !a || isInert(a);
    if (gone && (b.label === "must" || b.label === "normal" || b.meal)) lost.push(nameOf(b.spotId));
    else if (a && b.label === "must" && a.spotId !== b.spotId) swappedMust.push(nameOf(b.spotId));
  }
  if (lost.length) reasons.push(`Must・標準・食事の予定を外す案です（${lost.join("、")}）`);
  if (swappedMust.length) reasons.push(`Must を別のスポットに入れ替える案です（${swappedMust.join("、")}）`);

  // 2. 固定時刻・予約が絡む変更
  const t = result.event.type;
  if (t === "fixed-add" || t === "fixed-remove" || t === "fixed-move") reasons.push("固定時刻・予約が絡む変更です");

  // 3. 追加の費用（予算を超える価格帯のスポットが新しく入る）
  const comfort = BUDGET_COMFORT[result.after.prefs.budget];
  const priceOf = (id?: string) => (id ? ctx.spotById.get(id)?.priceLevel ?? 0 : 0);
  const pricey: string[] = [];
  const wasById = new Map(before.blocks.map((b) => [b.id, b]));
  for (const a of after.blocks) {
    if (isInert(a) || !a.spotId || a.fixed) continue;
    const b = wasById.get(a.id);
    if (b && b.spotId === a.spotId && !isInert(b)) continue; // 変わっていない
    const p = priceOf(a.spotId);
    if (p > comfort && p > priceOf(b?.spotId)) pricey.push(nameOf(a.spotId));
  }
  if (pricey.length) reasons.push(`予算を超える価格帯のスポットが入ります（${pricey.join("、")}）`);

  // 4. 予定の半分以上が変わる（時刻が動くだけのものは数えない）
  const planBlocks = before.blocks.filter(isPlanBlock);
  const changed = new Set<string>();
  for (const item of result.diff) {
    if (item.dayIndex !== result.dayIndex) continue;
    if (!["replaced", "skipped", "closed", "removed", "moved", "shortened"].includes(item.kind)) continue;
    if (planBlocks.some((b) => b.id === item.blockId)) changed.add(item.blockId);
  }
  if (planBlocks.length > 0 && changed.size >= LARGE_CHANGE_MIN_COUNT && changed.size / planBlocks.length >= LARGE_CHANGE_RATIO) {
    reasons.push(`予定の半分以上（${changed.size}/${planBlocks.length}件）が変わります`);
  }

  // 5. 間に合わない予定が残る・Must／食事を削る候補が出る（このまま自動では確定しない）
  if (!result.feasible) reasons.push("間に合わない予定が残ります");
  if (result.mustCandidates.length) reasons.push("Must・食事を外すかどうかの確認が必要です");

  return { weight: reasons.length ? "heavy" : "light", reasons };
}

export type ApplyAction = "apply" | "propose";

/**
 * 組み直しを、そのまま反映するか（元に戻すトースト付き）、差分を見せて確定を求めるか。
 *   重い変更: どのモードでも必ず確認
 *   軽い変更: 手動なら確認、提案・おまかせならそのまま反映（提案はユーザーのタップ、おまかせはアプリが自動で）
 *   例外: 実績（着いた・出発した）の記録は事実なので、軽い変更なら手動モードでも確認なしで記録する
 */
export function decideApply(mode: ResponseMode, weight: ChangeWeight, event?: { type: string }): ApplyAction {
  if (weight === "heavy") return "propose";
  if (event?.type === "progress") return "apply";
  return mode === "manual" ? "propose" : "apply";
}

/** アプリが気づいたことを、タップなしで自動反映してよいか（おまかせモードの軽い変更だけ） */
export function canAutoApply(mode: ResponseMode, weight: ChangeWeight): boolean {
  return mode === "auto" && weight === "light";
}
