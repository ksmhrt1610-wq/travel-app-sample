import type { Area, BlockLabel, Budget, Companions, Duration, InterestCategory, Pace, PriceLevel, RainTolerance, Setting, TravelMode } from "./types";

export const CATEGORY_LABEL: Record<InterestCategory, string> = {
  gourmet: "グルメ",
  cafe: "カフェ",
  history: "歴史・文化",
  nature: "自然・公園",
  shopping: "ショッピング",
  art: "アート",
  nightview: "夜景",
};

export const CATEGORY_ICON: Record<InterestCategory, string> = {
  gourmet: "🍜",
  cafe: "☕",
  history: "⛩️",
  nature: "🌳",
  shopping: "🛍️",
  art: "🎨",
  nightview: "🌃",
};

export const SETTING_LABEL: Record<Setting, string> = {
  indoor: "屋内",
  outdoor: "屋外",
  semi: "半屋外",
};

export const SETTING_ICON: Record<Setting, string> = {
  indoor: "🏠",
  outdoor: "☀️",
  semi: "⛱️",
};

export const AREA_LABEL: Record<Area, string> = {
  tenjin: "天神",
  hakata: "博多",
  nakasu: "中洲",
  ohori: "大濠公園",
  momochi: "百道浜",
  dazaifu: "太宰府",
};

export const PRICE_LABEL: Record<PriceLevel, string> = {
  0: "無料",
  1: "〜1,000円",
  2: "〜3,000円",
  3: "3,000円〜",
};

export const BLOCK_LABEL: Record<BlockLabel, string> = {
  must: "Must",
  normal: "標準",
  optional: "Optional",
  buffer: "余白",
};

export const DURATION_LABEL: Record<Duration, string> = { day: "日帰り", overnight: "1泊2日" };
export const COMPANIONS_LABEL: Record<Companions, string> = { solo: "一人", couple: "カップル", friends: "友人", family: "家族" };
export const BUDGET_LABEL: Record<Budget, string> = { saving: "節約", normal: "普通", luxury: "ちょっと贅沢" };
export const PACE_LABEL: Record<Pace, string> = { relaxed: "ゆったり", normal: "普通", packed: "詰め込み" };
export const RAIN_LABEL: Record<RainTolerance, string> = {
  "no-outdoor": "屋外NG",
  "light-rain-ok": "小雨ならOK",
  "dont-care": "気にしない",
};

export function travelLabel(mode: TravelMode, minutes: number): string {
  if (mode === "walk") return `徒歩 約${minutes}分`;
  if (mode === "transit") return `電車・バス 約${minutes}分`;
  return "";
}
