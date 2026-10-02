import { MEAL_ADJUST_WINDOW, MEAL_LABEL } from "./meals";
import { formatHHMM, parseHHMM } from "./time";
import type { FixedEvent, Itinerary, MealSlot, PlanningContext } from "./types";

/**
 * 組み直しで予定が変わった（削られた・短くなった・ずれた・入れ替わった）理由。
 * 構造化して持ち、画面に出す文章は ExplanationWriter が作る（いまはテンプレート。将来 LLM に差し替えられる）。
 */
export type Cause =
  /** 固定時刻（最終便・予約など）に間に合わせるため */
  | { kind: "fixed"; fixedId: string }
  /** スポットの閉館に間に合わないため */
  | { kind: "closing"; spotId: string }
  /** スポットが臨時休業のため */
  | { kind: "closure"; spotId: string }
  /** 食事の時間帯に収めるため */
  | { kind: "meal-window"; slot: MealSlot }
  /** 1日の終了予定時刻に収めるため */
  | { kind: "day-end"; endMin?: number }
  /** 休憩を入れたため（あとの予定が動いた） */
  | { kind: "rest" }
  /** 疲れたため（休憩そのもの・Optional を外す・近い順に並べ替える） */
  | { kind: "tired" }
  | { kind: "rain" }
  | { kind: "heat" }
  /** 遅れを反映したため */
  | { kind: "delay" }
  /** 寄り道を入れたため */
  | { kind: "detour" }
  /** ユーザー自身の操作 */
  | { kind: "user" };

export type CauseKind = Cause["kind"];

/** `fixed:<id>` のような識別子（保存・比較・テスト用） */
export function causeKey(c: Cause): string {
  switch (c.kind) {
    case "fixed":
      return `fixed:${c.fixedId}`;
    case "closing":
      return `closing:${c.spotId}`;
    case "closure":
      return `closure:${c.spotId}`;
    case "meal-window":
      return `meal-window:${c.slot}`;
    default:
      return c.kind;
  }
}

/** 変更理由を文章にするもの。いまはテンプレートだが、LLM などに差し替えられるよう interface にしている */
export interface ExplanationWriter {
  explain(cause: Cause, ctx: PlanningContext, itin: Itinerary): string;
}

function findFixed(itin: Itinerary, id: string): FixedEvent | undefined {
  for (const d of itin.days) {
    for (const b of d.blocks) if (b.fixed?.id === id) return b.fixed;
    for (const f of d.memberFixed ?? []) if (f.id === id) return f;
  }
  return undefined;
}

/** その日のうち、いちばん遅い閉館時刻（営業枠が複数あるときは最後）。「閉館（16:30）」と出すのに使う */
function closingTime(ctx: PlanningContext, spotId: string): string | undefined {
  const spot = ctx.spotById.get(spotId);
  if (!spot?.hours.length) return undefined;
  return formatHHMM(Math.max(...spot.hours.map((h) => parseHHMM(h.close))));
}

/** cause からのテンプレート文 */
export const templateWriter: ExplanationWriter = {
  explain(cause, ctx, itin) {
    const name = (id: string) => ctx.spotById.get(id)?.name ?? "予定";
    switch (cause.kind) {
      case "fixed": {
        const f = findFixed(itin, cause.fixedId);
        if (!f) return "固定時刻に間に合わせるため";
        return f.kind === "last-transport" ? `最終便（${f.title}）に間に合わせるため` : `固定時刻（${f.title}）に間に合わせるため`;
      }
      case "closing": {
        const t = closingTime(ctx, cause.spotId);
        return `「${name(cause.spotId)}」の閉館${t ? `（${t}）` : ""}に間に合わないため`;
      }
      case "closure":
        return `「${name(cause.spotId)}」が臨時休業のため`;
      case "meal-window": {
        const w = MEAL_ADJUST_WINDOW[cause.slot];
        return `${MEAL_LABEL[cause.slot]}の時間帯（${formatHHMM(w.earliest)}〜${formatHHMM(w.latest)}）に収めるため`;
      }
      case "day-end":
        return cause.endMin !== undefined ? `1日の終了予定（${formatHHMM(cause.endMin)}）に収めるため` : "1日の終了予定に収めるため";
      case "rest":
        return "休憩を入れたため";
      case "tired":
        return "疲れたため";
      case "rain":
        return "雨のため";
      case "heat":
        return "暑さのため";
      case "delay":
        return "遅れを反映したため";
      case "detour":
        return "寄り道を入れたため";
      case "user":
        return "操作したため";
    }
  },
};
