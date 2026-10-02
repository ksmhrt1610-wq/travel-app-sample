import { isInert } from "./schedule";
import type { Block, Day, PlanningContext, RainTolerance, Spot } from "./types";

/** 1時間ごとの降水確率（0〜100）。WeatherProvider が返す形 */
export interface HourlyWeather {
  hour: number;
  precipProb: number;
}

/** デモ用の「雨が降り出す」操作。startMin 以降は prob（%）の雨になる */
export interface RainOverride {
  startMin: number;
  prob: number;
}

/**
 * 雨への許容度ごとに「通知する降水確率」のしきい値。
 * 気にしない人には自動では提案しない（手動の切替は常に可能）。
 */
export const RAIN_THRESHOLD: Record<RainTolerance, number> = {
  "no-outdoor": 30,
  "light-rain-ok": 60,
  "dont-care": Number.POSITIVE_INFINITY,
};

export function precipProbAt(hourly: HourlyWeather[], min: number, rain?: RainOverride): number {
  const base = hourly.find((h) => h.hour === Math.floor(min / 60))?.precipProb ?? 0;
  return rain && min >= rain.startMin ? Math.max(base, rain.prob) : base;
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
  const threshold = RAIN_THRESHOLD[tolerance];
  const impact: RainImpact = { switchable: [], noPlanB: [] };
  if (!Number.isFinite(threshold)) return impact;

  for (const b of day.blocks) {
    if (isInert(b) || b.switched || !b.spotId || b.endMin <= nowMin) continue;
    const spot = ctx.spotById.get(b.spotId);
    if (!spot || !isRainSensitive(spot, tolerance)) continue;
    let wet = false;
    for (let t = Math.max(b.startMin, nowMin); t < b.endMin; t += 10) {
      if (precipProbAt(hourly, t, rain) >= threshold) {
        wet = true;
        break;
      }
    }
    if (!wet) continue;
    (b.planB ? impact.switchable : impact.noPlanB).push(b);
  }
  return impact;
}
