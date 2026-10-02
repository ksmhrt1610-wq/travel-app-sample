"use client";

import { PACE_LABEL } from "@/core/labels";
import type { Pace } from "@/core/types";
import type { DayWalking } from "@/core/walking";
import { cx } from "./ui";

/** その日の推定歩行距離の累計と、ペースごとの目安 */
export function WalkMeter({ walking, pace }: { walking: DayWalking; pace: Pace }) {
  const km = (m: number) => (m / 1000).toFixed(1);
  const donePct = Math.min(100, (walking.doneM / walking.limitM) * 100);
  const totalPct = Math.min(100, (walking.totalM / walking.limitM) * 100);
  const overNow = walking.doneM > walking.limitM;
  const overTotal = walking.totalM > walking.limitM;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" data-testid="walk-meter">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-bold text-slate-800">🚶 今日の推定歩行距離</h2>
        <span className="text-[11px] text-slate-500">
          目安 {km(walking.limitM)}km（{PACE_LABEL[pace]}）
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-700">
        いままで <strong className={cx("text-lg tabular-nums", overNow ? "text-rose-600" : "text-slate-900")} data-testid="walk-done">{km(walking.doneM)}km</strong>
        <span className={cx("ml-2 text-xs", overTotal ? "font-bold text-amber-700" : "text-slate-500")} data-testid="walk-total">
          今日の見込み {km(walking.totalM)}km
        </span>
      </p>
      <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={walking.limitM} aria-valuenow={walking.doneM}>
        <div className="absolute inset-y-0 left-0 rounded-full bg-slate-300" style={{ width: `${totalPct}%` }} />
        <div className={cx("absolute inset-y-0 left-0 rounded-full", overNow ? "bg-rose-500" : "bg-teal-500")} style={{ width: `${donePct}%` }} />
      </div>
      {overTotal && !overNow && <p className="mt-1 text-[11px] font-semibold text-amber-700">このままだと目安を超えそうです。休憩を入れるのがおすすめです。</p>}
    </section>
  );
}
