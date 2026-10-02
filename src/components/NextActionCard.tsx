"use client";

import { mapsDirectionsUrl, mapsSearchUrl } from "@/core/maps";
import { travelLabel } from "@/core/labels";
import { formatDuration, formatHHMM } from "@/core/time";
import type { NextAction } from "@/core/today";
import { Chip, cx } from "./ui";

/** 画面上部の「次にやること」カード。出発までの残り時間を大きく出す */
export function NextActionCard({ action, nowMin }: { action: NextAction; nowMin: number }) {
  const { state, current, currentSpot, next, nextSpot } = action;

  if (state === "finished" || state === "empty") {
    return (
      <section className="rounded-3xl bg-slate-900 p-5 text-white shadow-lg" data-testid="next-card" data-state={state}>
        <p className="text-xs font-bold text-slate-300">次にやること</p>
        <p className="mt-1 text-xl font-extrabold">{state === "finished" ? "🎉 今日の予定はすべて終わりました" : "予定がありません"}</p>
        <p className="mt-1 text-sm text-slate-300">おつかれさまでした。</p>
      </section>
    );
  }

  const moving = action.minutesUntilArrival !== undefined;
  const departNow = !current && (action.minutesUntilDeparture ?? 1) === 0 && !moving;

  return (
    <section className="rounded-3xl bg-gradient-to-br from-slate-900 to-slate-800 p-5 text-white shadow-lg" data-testid="next-card" data-state={state}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-slate-300">次にやること</p>
        {action.delayedByMin ? <Chip className="bg-amber-400 text-amber-950">⏱ 遅延 +{action.delayedByMin}分</Chip> : null}
      </div>

      {current && (
        <p className="mt-2 rounded-xl bg-white/10 px-3 py-1.5 text-[13px] text-slate-100" data-testid="next-current">
          いま：<strong>{currentSpot ? currentSpot.name : "余白（休憩・自由時間）"}</strong>
          <span className="text-slate-300">（{formatHHMM(current.endMin)} まで・あと{formatDuration(current.endMin - nowMin)}）</span>
        </p>
      )}

      {next && nextSpot ? (
        <>
          <p className="mt-3 text-lg font-extrabold leading-snug" data-testid="next-destination">
            {moving ? "移動中 → " : "→ "}
            {nextSpot.name}
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
            <div>
              <p className="text-[11px] font-semibold text-slate-300">{moving ? "到着まで" : "出発まで"}</p>
              <p
                className={cx(
                  "whitespace-nowrap font-black tabular-nums leading-none",
                  (action.minutesUntilDeparture ?? 0) >= 60 && !moving ? "text-3xl" : "text-4xl",
                  departNow && "text-amber-300",
                )}
                data-testid="next-countdown"
              >
                {moving ? formatDuration(action.minutesUntilArrival!) : departNow ? "今すぐ" : formatDuration(action.minutesUntilDeparture!)}
              </p>
            </div>
            <div className="pb-0.5 text-[13px] text-slate-200">
              <p>
                {formatHHMM(action.departAtMin!)} 出発 → {formatHHMM(next.startMin)} 着
              </p>
              {next.travelMin > 0 && <p className="text-slate-300">{travelLabel(next.travelMode, next.travelMin)}</p>}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <a
              href={mapsDirectionsUrl(nextSpot, next.travelMode === "none" ? "transit" : next.travelMode, currentSpot)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-10 items-center justify-center rounded-xl bg-white text-sm font-bold text-slate-900 hover:bg-slate-100"
            >
              🧭 経路を開く
            </a>
            <a
              href={mapsSearchUrl(nextSpot)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-10 items-center justify-center rounded-xl bg-white/15 text-sm font-bold text-white hover:bg-white/25"
            >
              📍 Google Maps
            </a>
          </div>
        </>
      ) : (
        <p className="mt-3 text-lg font-extrabold">これが今日の最後の予定です</p>
      )}
    </section>
  );
}
