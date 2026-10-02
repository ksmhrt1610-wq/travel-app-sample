"use client";

import type { FixedCountdown } from "@/core/fixed";
import { mapsDirectionsUrl, mapsSearchUrl } from "@/core/maps";
import { travelLabel } from "@/core/labels";
import { formatDuration, formatHHMM } from "@/core/time";
import type { NextAction } from "@/core/today";
import { Button, Chip, cx } from "./ui";

export interface MemberDeparture {
  who: string;
  title: string;
  departBy: number;
  timeMin: number;
}

/** 直近の固定時刻までの逆算。例: 17:42 までにここを出ないと、太宰府駅 18:05 の電車に間に合いません */
function FixedCountdownBlock({ fixed, members, nowMin }: { fixed: FixedCountdown | null; members: MemberDeparture[]; nowMin: number }) {
  if (!fixed && members.length === 0) return null;
  return (
    <div className="mt-3 space-y-1.5 rounded-xl border border-amber-300/50 bg-amber-400/10 px-3 py-2" data-testid="fixed-countdown">
      <p className="text-[11px] font-bold text-amber-200">🔒 固定時刻</p>
      {fixed &&
        (fixed.minutesLeft >= 0 ? (
          <>
            <p className="text-[13px] font-bold leading-snug" data-testid="fixed-departby">
              {formatHHMM(fixed.departBy)} までに{fixed.here ? "ここ" : fixed.pred ? `「${fixed.predName}」` : fixed.predName}を出ないと、{fixed.fixed.fixed!.title} に間に合いません
            </p>
            <p className="text-[11px] text-slate-300">
              あと <strong className="text-amber-200">{formatDuration(fixed.minutesLeft)}</strong>（移動 約{fixed.travelMin}分＋余裕{fixed.marginMin}分）
            </p>
          </>
        ) : (
          <p className="text-[13px] font-bold leading-snug text-rose-300" data-testid="fixed-departby">
            出発すべき時刻（{formatHHMM(fixed.departBy)}）を{formatDuration(-fixed.minutesLeft)}過ぎています。{fixed.fixed.fixed!.title} に間に合わない可能性があります
          </p>
        ))}
      {members.map((m) => (
        <p key={m.title} className="text-[12px] text-fuchsia-200" data-testid="fixed-member-departby">
          {m.who}は {formatHHMM(m.departBy)} までにグループを出ないと、{m.title} に間に合いません
          {m.departBy < nowMin ? "（過ぎています）" : `（あと${formatDuration(m.departBy - nowMin)}）`}
        </p>
      ))}
    </div>
  );
}

/** 画面上部の「次にやること」カード。出発までの残り時間を大きく出す */
export function NextActionCard({
  action,
  nowMin,
  fixed = null,
  memberDepartures = [],
  onArrived,
  onDeparted,
}: {
  action: NextAction;
  nowMin: number;
  fixed?: FixedCountdown | null;
  memberDepartures?: MemberDeparture[];
  /** 「着いた」「出発した」を押した（その時刻が実績になる） */
  onArrived?: () => void;
  onDeparted?: () => void;
}) {
  const { state, current, currentSpot, next, nextSpot, nextName } = action;

  if (state === "finished" || state === "empty") {
    return (
      <section className="rounded-3xl bg-slate-900 p-5 text-white shadow-lg" data-testid="next-card" data-state={state}>
        <p className="text-xs font-bold text-slate-300">次にやること</p>
        <p className="mt-1 text-xl font-extrabold">
          {state === "finished" ? (fixed ? "🚉 予定はすべて終わりました" : "🎉 今日の予定はすべて終わりました") : "予定がありません"}
        </p>
        <p className="mt-1 text-sm text-slate-300">{fixed ? "あとは固定時刻に間に合うよう、出発するだけです。" : "おつかれさまでした。"}</p>
        <FixedCountdownBlock fixed={fixed} members={memberDepartures} nowMin={nowMin} />
      </section>
    );
  }

  const moving = action.minutesUntilArrival !== undefined;
  const currentName = currentSpot?.name ?? current?.free?.name ?? (current?.label === "rest" ? "休憩" : "余白（休憩・自由時間）");
  // 着いた・出発した: 予定の最中なら「出発した」、次の予定へ向かっているなら「着いた」
  const departing = action.departable;
  const arriving = action.arrivable;
  const canDepart = !!departing && !!onDeparted;
  const canArrive = !!arriving && !!onArrived;
  const departNow = !current && (action.minutesUntilDeparture ?? 1) === 0 && !moving;

  return (
    <section className="rounded-3xl bg-gradient-to-br from-slate-900 to-slate-800 p-5 text-white shadow-lg" data-testid="next-card" data-state={state}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-slate-300">次にやること</p>
        {action.delayedByMin ? <Chip className="bg-amber-400 text-amber-950">⏱ 遅延 +{action.delayedByMin}分</Chip> : null}
      </div>

      {current && (
        <p className="mt-2 rounded-xl bg-white/10 px-3 py-1.5 text-[13px] text-slate-100" data-testid="next-current">
          いま：<strong>{currentName}</strong>
          <span className="text-slate-300">（{formatHHMM(current.endMin)} まで・あと{formatDuration(current.endMin - nowMin)}）</span>
        </p>
      )}

      {next && nextName ? (
        <>
          <p className="mt-3 text-lg font-extrabold leading-snug" data-testid="next-destination">
            {moving ? "移動中 → " : "→ "}
            {nextName}
            {next.detour && <span className="ml-2 align-middle text-xs font-bold text-amber-300">寄り道</span>}
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
          {nextSpot ? (
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
          ) : (
            <p className="mt-2 text-[11px] text-slate-300" data-testid="free-assumption">
              ※ 場所が決まっていない寄り道なので、移動は約{next.travelMin}分と仮定しています。
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 text-lg font-extrabold">これが今日の最後の予定です</p>
      )}
      {(canDepart || canArrive) && (
        <div className="mt-3 grid gap-2" data-testid="progress-buttons">
          {canDepart && (
            <Button variant="amber" onClick={onDeparted} data-testid="progress-departed" className="w-full">
              🚪 {action.departableName ? `「${action.departableName}」を` : ""}出発した（{formatHHMM(nowMin)}）
            </Button>
          )}
          {canArrive && (
            <Button variant="emerald" onClick={onArrived} data-testid="progress-arrived" className="w-full">
              📍 {action.arrivableName ? `「${action.arrivableName}」に` : ""}着いた（{formatHHMM(nowMin)}）
            </Button>
          )}
          <p className="text-[11px] text-slate-300">押した時刻が実績になり、遅れや早まりが後ろの予定に反映されます。</p>
        </div>
      )}
      <FixedCountdownBlock fixed={fixed} members={memberDepartures} nowMin={nowMin} />
    </section>
  );
}
