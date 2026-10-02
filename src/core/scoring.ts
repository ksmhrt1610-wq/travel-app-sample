import type { Budget, Companions, InterestCategory, PriceLevel, Preferences, RainTolerance, Setting, Spot } from "./types";

/** 予算帯ごとに「気にせず選べる」上限の価格帯 */
export const BUDGET_COMFORT: Record<Budget, PriceLevel> = { saving: 1, normal: 2, luxury: 3 };

const COMPANION_BONUS: Record<Companions, Partial<Record<InterestCategory, number>>> = {
  solo: { history: 0.4, art: 0.4, cafe: 0.4 },
  couple: { nightview: 1.0, cafe: 0.5, art: 0.4, gourmet: 0.2 },
  friends: { gourmet: 0.4, shopping: 0.4, nightview: 0.3 },
  family: { nature: 0.8, history: 0.3, nightview: -0.5 },
};

/** 雨への許容度による屋外スポットの減点（屋外NGでも「除外」はせず、Plan B 前提で入れられる） */
export const RAIN_PENALTY: Record<RainTolerance, Record<Setting, number>> = {
  "no-outdoor": { indoor: 0, semi: 1.0, outdoor: 2.0 },
  "light-rain-ok": { indoor: 0, semi: 0, outdoor: 0.5 },
  "dont-care": { indoor: 0, semi: 0, outdoor: 0 },
};

export const SCORE_WEIGHTS = {
  interestPrimary: 3.0,
  interestTag: 1.2,
  popularity: 0.8,
  overBudgetPerLevel: 1.5,
  /** 同じ日に同カテゴリを選ぶたびにかかる減点 */
  categoryRepeat: 1.5,
  /** Must スポットの加点。他の条件より優先して選ばせる */
  must: 50,
} as const;

/** 時間・場所に依存しない、スポット単体の入力条件に対するスコア */
export function baseScore(spot: Spot, prefs: Preferences): number {
  const w = SCORE_WEIGHTS;
  let s = 0;

  if (prefs.interests.includes(spot.category)) s += w.interestPrimary;
  else if (spot.tags?.some((t) => prefs.interests.includes(t))) s += w.interestTag;

  s += w.popularity * spot.popularity;

  const over = Math.max(0, spot.priceLevel - BUDGET_COMFORT[prefs.budget]);
  s -= w.overBudgetPerLevel * over;
  if (prefs.budget === "luxury" && spot.priceLevel >= 2) s += 0.4;
  if (prefs.budget === "saving" && spot.priceLevel === 0) s += 0.4;

  s += COMPANION_BONUS[prefs.companions][spot.category] ?? 0;
  s -= RAIN_PENALTY[prefs.rainTolerance][spot.setting];

  return s;
}

/** カテゴリ同士の近さ（0〜1）。Plan B の「興味カテゴリが近い」判定に使う */
const AFFINITY: Partial<Record<InterestCategory, Partial<Record<InterestCategory, number>>>> = {
  history: { art: 0.6, nature: 0.3, cafe: 0.2, shopping: 0.2, gourmet: 0.15 },
  nature: { cafe: 0.5, nightview: 0.5, art: 0.35, history: 0.3 },
  art: { history: 0.6, cafe: 0.4, shopping: 0.3, nature: 0.35 },
  cafe: { gourmet: 0.6, nature: 0.5, shopping: 0.4, art: 0.4, history: 0.2 },
  gourmet: { cafe: 0.6, shopping: 0.4, nightview: 0.3, history: 0.15 },
  shopping: { cafe: 0.4, gourmet: 0.4, art: 0.3, history: 0.2 },
  nightview: { nature: 0.5, gourmet: 0.3, shopping: 0.2 },
};

export function categoryAffinity(a: Spot, b: Spot): number {
  if (a.category === b.category) return 1;
  const direct = AFFINITY[a.category]?.[b.category] ?? AFFINITY[b.category]?.[a.category] ?? 0.1;
  const tagsA = new Set<InterestCategory>([a.category, ...(a.tags ?? [])]);
  const tagsB = new Set<InterestCategory>([b.category, ...(b.tags ?? [])]);
  const shared = [...tagsA].some((t) => tagsB.has(t));
  return shared ? Math.max(direct, 0.6) : direct;
}
