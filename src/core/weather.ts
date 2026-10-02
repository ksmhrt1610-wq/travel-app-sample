import { isInert } from "./schedule";
import type { Block, Day, PlanningContext, RainTolerance, Spot } from "./types";

/** 1時間ごとの降水確率（0〜100）・雨量（mm/h）・暑さ指数（WBGT）。WeatherProvider が返す形 */
export interface HourlyWeather {
  hour: number;
  precipProb: number;
  /** 雨量（mm/h）。省略時は 0 */
  mmPerHour?: number;
  /** 暑さ指数（WBGT、℃）。省略時は暑さの心配なし */
  wbgt?: number;
}

/** デモ操作の雨の強さ */
export type RainStrength = "light" | "moderate" | "heavy";

export const RAIN_STRENGTH: Record<RainStrength, { label: string; prob: number; mmPerHour: number }> = {
  light: { label: "小雨", prob: 60, mmPerHour: 1 },
  moderate: { label: "本降り", prob: 80, mmPerHour: 5 },
  heavy: { label: "強い雨", prob: 95, mmPerHour: 15 },
};

/** デモ用の「雨が降り出す」操作。startMin 以降は prob（%）・mmPerHour（mm/h）の雨になる */
export interface RainOverride {
  startMin: number;
  prob: number;
  /** 雨量（mm/h）。古い保存データには無いので、無いときは降水確率から見積もる */
  mmPerHour?: number;
  strength?: RainStrength;
}

/** 雨量が無い保存データ向けに、降水確率から雨量を見積もる */
export function rainMm(rain: RainOverride): number {
  if (rain.mmPerHour !== undefined) return rain.mmPerHour;
  return rain.prob >= 90 ? 15 : rain.prob >= 70 ? 5 : rain.prob >= 50 ? 1 : 0.2;
}

/**
 * 切り替えを提案する雨の基準（雨への許容度ごと）。ここ1か所で調整できる。
 *   mmPerHour: この雨量（mm/h）以上で提案
 *   precipProb: この降水確率（%）以上でも提案（省略すると、降水確率は見ない）
 */
export interface RainRule {
  mmPerHour: number;
  precipProb?: number;
}

export const RAIN_RULES: Record<RainTolerance, RainRule> = {
  /** 屋外NG: ほんの少しの雨・雨の可能性でも */
  "no-outdoor": { mmPerHour: 0.5, precipProb: 30 },
  /** 小雨ならOK: 小雨は気にしない。本降りから */
  "light-rain-ok": { mmPerHour: 3 },
  /** 気にしない: 強い雨のときだけ提案 */
  "dont-care": { mmPerHour: 10 },
};

export function exceedsRainRule(rule: RainRule, prob: number, mm: number): boolean {
  return mm >= rule.mmPerHour || (rule.precipProb !== undefined && prob >= rule.precipProb);
}

/** その時刻の降水確率と雨量（予報に、デモの「雨が降り出す」を上書きしたもの） */
export function rainAt(hourly: HourlyWeather[], min: number, rain?: RainOverride): { prob: number; mm: number } {
  const h = hourly.find((x) => x.hour === Math.floor(min / 60));
  const base = { prob: h?.precipProb ?? 0, mm: h?.mmPerHour ?? 0 };
  if (rain && min >= rain.startMin) return { prob: Math.max(base.prob, rain.prob), mm: Math.max(base.mm, rainMm(rain)) };
  return base;
}

export function precipProbAt(hourly: HourlyWeather[], min: number, rain?: RainOverride): number {
  return rainAt(hourly, min, rain).prob;
}

/** 雨の影響を受けるスポットか。屋外は常に、半屋外は「屋外NG」の人だけ */
export function isRainSensitive(spot: Spot, tolerance: RainTolerance): boolean {
  if (spot.setting === "outdoor") return true;
  return spot.setting === "semi" && tolerance === "no-outdoor";
}

export interface RainImpact {
  /** Plan B に切り替えられる、雨の影響を受ける予定（時刻順） */
  switchable: Block[];
  /** 雨の影響を受けるが Plan B が見つかっていない予定 */
  noPlanB: Block[];
}

/**
 * 雨の予報で影響を受ける、まだ終わっていない屋外ブロックを探す。
 * 進行中のブロックも含む。切替済み・スキップ済み・臨時休業のブロックは対象外。
 */
export function detectRainImpact(
  day: Day,
  ctx: PlanningContext,
  hourly: HourlyWeather[],
  nowMin: number,
  tolerance: RainTolerance,
  rain?: RainOverride,
): RainImpact {
  const rule = RAIN_RULES[tolerance];
  const impact: RainImpact = { switchable: [], noPlanB: [] };

  for (const b of day.blocks) {
    if (isInert(b) || b.switched || !b.spotId || b.endMin <= nowMin) continue;
    const spot = ctx.spotById.get(b.spotId);
    if (!spot || !isRainSensitive(spot, tolerance)) continue;
    let wet = false;
    for (let t = Math.max(b.startMin, nowMin); t < b.endMin; t += 10) {
      const r = rainAt(hourly, t, rain);
      if (exceedsRainRule(rule, r.prob, r.mm)) {
        wet = true;
        break;
      }
    }
    if (!wet) continue;
    (b.planB ? impact.switchable : impact.noPlanB).push(b);
  }
  return impact;
}

/* ---------- 暑さ（WBGT） ---------- */

/**
 * 暑さへの対応の基準。環境省の暑さ指数の区分に合わせている（28以上=厳重警戒、31以上=危険）。ここ1か所で調整できる。
 *   warning: 11〜16時の屋外の予定を Plan B に替える、または屋外の予定の後に休憩を挟む提案
 *   danger: 11〜16時の屋外の予定をすべて Plan B に替える提案
 */
export const HEAT_RULES = {
  warning: 28,
  danger: 31,
  /** 対象の時間帯（0:00 からの分）。この間に重なる屋外の予定が対象 */
  windowStartMin: 11 * 60,
  windowEndMin: 16 * 60,
  /** 「屋外の予定の後に休憩を挟む」ときの休憩の長さ（分） */
  restMin: 15,
} as const;

export type HeatLevel = "none" | "warning" | "danger";

/** デモ用の「暑くなる」操作。startMin 以降は wbgt（℃）になる */
export interface HeatOverride {
  startMin: number;
  wbgt: number;
}

export function heatLevelOf(wbgt: number): HeatLevel {
  return wbgt >= HEAT_RULES.danger ? "danger" : wbgt >= HEAT_RULES.warning ? "warning" : "none";
}

export const HEAT_LEVEL_LABEL: Record<HeatLevel, string> = { none: "", warning: "厳重警戒", danger: "危険" };

export function wbgtAt(hourly: HourlyWeather[], min: number, heat?: HeatOverride): number {
  const base = hourly.find((h) => h.hour === Math.floor(min / 60))?.wbgt ?? 0;
  return heat && min >= heat.startMin ? Math.max(base, heat.wbgt) : base;
}

export interface HeatImpact {
  /** 影響する予定の中で最も高い暑さのレベル */
  level: HeatLevel;
  wbgt: number;
  /** Plan B に切り替えられる、暑さの影響を受ける屋外の予定（時刻順） */
  switchable: Block[];
  /** 影響を受けるが Plan B がない屋外の予定 */
  noPlanB: Block[];
}

/**
 * 暑さの影響を受ける、まだ終わっていない屋外ブロックを探す（11〜16時に重なり、その時間帯の WBGT が28以上）。
 * 切替済み・スキップ済み・休業のブロックは対象外。
 */
export function detectHeatImpact(day: Day, ctx: PlanningContext, hourly: HourlyWeather[], nowMin: number, heat?: HeatOverride): HeatImpact {
  const impact: HeatImpact = { level: "none", wbgt: 0, switchable: [], noPlanB: [] };
  for (const b of day.blocks) {
    if (isInert(b) || b.switched || !b.spotId || b.endMin <= nowMin) continue;
    const spot = ctx.spotById.get(b.spotId);
    if (!spot || spot.setting !== "outdoor") continue;
    let peak = 0;
    const from = Math.max(b.startMin, nowMin, HEAT_RULES.windowStartMin);
    const to = Math.min(b.endMin, HEAT_RULES.windowEndMin);
    for (let t = from; t < to; t += 10) peak = Math.max(peak, wbgtAt(hourly, t, heat));
    if (peak < HEAT_RULES.warning) continue;
    impact.wbgt = Math.max(impact.wbgt, peak);
    (b.planB ? impact.switchable : impact.noPlanB).push(b);
  }
  impact.level = heatLevelOf(impact.wbgt);
  return impact;
}
