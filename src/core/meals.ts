import type { MealSlot, Pace } from "./types";

/**
 * 食事の時間帯の窓。食事ブロックは、この窓の中で時刻をずらしてよい（開始が earliest 以降、終了が latest 以前）。
 * 旅程を生成するときの目標の時間帯（planner.ts の MEAL_WINDOW）より広い。
 */
export const MEAL_ADJUST_WINDOW: Record<MealSlot, { earliest: number; latest: number }> = {
  lunch: { earliest: 11 * 60, latest: 14 * 60 + 30 },
  dinner: { earliest: 17 * 60, latest: 21 * 60 },
};

/** 余白が遅れを吸収して縮められる下限（分）。ゆったりほど余白を守る */
export const BUFFER_FLOOR_MIN: Record<Pace, number> = { relaxed: 20, normal: 10, packed: 5 };

export const MEAL_LABEL: Record<MealSlot, string> = { lunch: "ランチ", dinner: "ディナー" };
