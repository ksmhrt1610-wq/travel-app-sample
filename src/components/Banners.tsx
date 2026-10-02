"use client";

import type { DepartureNotice } from "@/core/fixed";
import { formatHHMM } from "@/core/time";
import type { RestSuggestion } from "@/core/walking";
import type { Block, PlanningContext } from "@/core/types";
import { RAIN_STRENGTH, rainMm, type RainImpact, type RainOverride } from "@/core/weather";
import type { PlanBCandidate } from "@/core/planb";
import { Button } from "./ui";

function Item({ block, ctx, showPlanB }: { block: Block; ctx: PlanningContext; showPlanB?: boolean }) {
  const spot = block.spotId ? ctx.spotById.get(block.spotId) : undefined;
  const planB = block.planB ? ctx.spotById.get(block.planB.spotId) : undefined;
  return (
    <li className="flex items-baseline gap-2 text-[13px]">
      <span className="w-[88px] shrink-0 font-bold tabular-nums text-slate-700">
        {formatHHMM(block.startMin)}–{formatHHMM(block.endMin)}
      </span>
      <span className="flex-1">
        <span className="font-semibold text-slate-900">{spot?.name}</span>
        {showPlanB &&
          (planB ? (
            <span className="text-emerald-800">
              {" "}
              → <strong>{planB.name}</strong>
            </span>
          ) : (
            <span className="text-amber-700"> （Plan Bなし）</span>
          ))}
      </span>
    </li>
  );
}

/** 手動モードで、バナーの代わりに出す小さなバッジ（タップすると、その対応の案を作る） */
export interface AttentionBadge {
  id: string;
  text: string;
  tone: "rain" | "closure" | "walk" | "departure";
  onClick: () => void;
}

const BADGE_TONE: Record<AttentionBadge["tone"], string> = {
  rain: "border-sky-300 bg-sky-50 text-sky-900",
  closure: "border-rose-300 bg-rose-50 text-rose-900",
  walk: "border-teal-300 bg-teal-50 text-teal-900",
  departure: "border-amber-400 bg-amber-50 text-amber-950",
};

export function AttentionBadges({ items }: { items: AttentionBadge[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="attention-badges">
      {items.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={b.onClick}
          data-testid={`badge-${b.tone}`}
          className={`min-h-8 rounded-full border px-3 py-1 text-xs font-bold ${BADGE_TONE[b.tone]}`}
        >
          {b.text}
        </button>
      ))}
    </div>
  );
}

/** 雨の通知バナー。影響する屋外ブロックを出し、「1つだけ」「残りすべて」の切り替えを選べる */
export function RainBanner({
  impact,
  rain,
  ctx,
  onSwitchOne,
  onSwitchAll,
  onDismiss,
}: {
  impact: RainImpact;
  rain: RainOverride;
  ctx: PlanningContext;
  onSwitchOne: () => void;
  onSwitchAll: () => void;
  onDismiss: () => void;
}) {
  const total = impact.switchable.length + impact.noPlanB.length;
  const first = impact.switchable[0];
  return (
    <section
      className="animate-pop-in rounded-2xl border-2 border-sky-400 bg-sky-50 p-4 shadow-md"
      role="alert"
      data-testid="rain-banner"
    >
      <h2 className="text-[15px] font-extrabold text-sky-950">
        ☔ {formatHHMM(rain.startMin)}から{rain.strength ? RAIN_STRENGTH[rain.strength].label : "雨"}（降水確率 {rain.prob}%・{rainMm(rain)}mm/h）— Plan Bに切り替えますか？
      </h2>
      <p className="mt-0.5 text-xs text-sky-900">屋外の予定 {total}件に影響します。</p>

      <ul className="mt-2 space-y-1 rounded-xl bg-white/80 p-2.5" data-testid="rain-affected">
        {impact.switchable.map((b) => (
          <Item key={b.id} block={b} ctx={ctx} showPlanB />
        ))}
        {impact.noPlanB.map((b) => (
          <Item key={b.id} block={b} ctx={ctx} showPlanB />
        ))}
      </ul>

      <div className="mt-3 grid gap-2">
        {first && (
          <Button variant="secondary" onClick={onSwitchOne} data-testid="rain-switch-one" className="h-auto flex-col gap-0 whitespace-normal border-sky-300 py-2 text-center">
            1つだけ切り替える
            <span className="text-xs font-medium text-slate-500">次の屋外予定：{ctx.spotById.get(first.spotId!)?.name}</span>
          </Button>
        )}
        {impact.switchable.length > 0 && (
          <Button onClick={onSwitchAll} data-testid="rain-switch-all" className="h-auto whitespace-normal py-2.5 text-center">
            今日の残りの屋外予定をすべて切り替える（{impact.switchable.length}件）
          </Button>
        )}
        <button type="button" onClick={onDismiss} className="min-h-9 text-xs font-semibold text-sky-800 underline" data-testid="rain-dismiss">
          あとで
        </button>
      </div>
    </section>
  );
}

/** 臨時休業の通知。代わりの候補への切り替え、またはスキップを選べる */
export function ClosureBanner({
  block,
  suggestion,
  ctx,
  onReplace,
  onSkip,
}: {
  block: Block;
  suggestion: PlanBCandidate | null;
  ctx: PlanningContext;
  onReplace: () => void;
  onSkip: () => void;
}) {
  const spot = ctx.spotById.get(block.spotId!);
  return (
    <section className="animate-pop-in rounded-2xl border-2 border-rose-400 bg-rose-50 p-4 shadow-md" role="alert" data-testid="closure-banner">
      <h2 className="text-[15px] font-extrabold text-rose-950">⛔ 「{spot?.name}」が臨時休業です</h2>
      <p className="mt-0.5 text-xs text-rose-900">
        {formatHHMM(block.plannedStartMin ?? block.startMin)}の予定は実施できません。後ろの予定の時刻は計算し直しました。
      </p>
      <div className="mt-3 grid gap-2">
        {suggestion ? (
          <Button variant="danger" onClick={onReplace} data-testid="closure-replace">
            「{suggestion.spot.name}」に切り替える
          </Button>
        ) : (
          <p className="rounded-lg bg-white p-2 text-xs text-slate-600">代わりに行ける近くのスポットが見つかりませんでした。</p>
        )}
        {suggestion && (
          <p className="-mt-1 text-xs text-rose-900">
            {suggestion.reason}（直線 約{(suggestion.distanceM / 1000).toFixed(1)}km）
          </p>
        )}
        <Button variant="secondary" onClick={onSkip} data-testid="closure-skip">
          この予定をスキップする
        </Button>
      </div>
    </section>
  );
}

/** 出発すべき時刻の30分前・10分前の通知（固定時刻） */
export function DepartureBanner({ notice, onDismiss }: { notice: DepartureNotice; onDismiss: () => void }) {
  const urgent = notice.level !== "before30";
  const over = notice.level === "over";
  return (
    <section
      className={`animate-pop-in rounded-2xl border-2 p-4 shadow-md ${over ? "border-rose-500 bg-rose-50" : urgent ? "border-orange-500 bg-orange-50" : "border-amber-400 bg-amber-50"}`}
      role="alert"
      data-testid="departure-banner"
      data-level={notice.level}
    >
      <h2 className="text-[15px] font-extrabold text-slate-900" data-testid="departure-banner-title">
        {over ? "🚨 出発すべき時刻を過ぎています" : notice.level === "before10" ? "⏰ 出発の10分前になりました" : "⏰ 出発の30分前になりました"}
      </h2>
      <p className="mt-0.5 text-[13px] text-slate-800">
        {notice.who ? `${notice.who}は ` : ""}
        <strong>{formatHHMM(notice.departBy)}</strong> までに出発しないと、{notice.title} に間に合いません
        {!over && `（あと${notice.minutesLeft}分）`}
      </p>
      <button type="button" onClick={onDismiss} className="mt-2 min-h-9 text-xs font-semibold text-slate-600 underline" data-testid="departure-dismiss">
        確認しました
      </button>
    </section>
  );
}

/** 歩行距離が目安を超えそうなときの休憩の提案 */
export function WalkBanner({
  suggestion,
  nextName,
  onAccept,
  onDismiss,
}: {
  suggestion: RestSuggestion;
  nextName: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="animate-pop-in rounded-2xl border-2 border-teal-400 bg-teal-50 p-4 shadow-md" role="alert" data-testid="walk-banner">
      <h2 className="text-[15px] font-extrabold text-teal-950">🚶 歩行距離が目安を超えそうです</h2>
      <p className="mt-0.5 text-xs text-teal-900">
        「{nextName}」まで行くと、今日の推定歩行は約{(suggestion.projectedM / 1000).toFixed(1)}km（目安 {(suggestion.limitM / 1000).toFixed(0)}km）になります。
      </p>
      <p className="mt-1 text-[13px] font-bold text-slate-900">次の予定の前に休憩を入れますか？</p>
      <div className="mt-3 grid gap-2">
        <Button onClick={onAccept} data-testid="walk-accept" className="bg-teal-600 hover:bg-teal-700">
          休憩を入れる案を見る（30分）
        </Button>
        <button type="button" onClick={onDismiss} className="min-h-9 text-xs font-semibold text-teal-800 underline" data-testid="walk-dismiss">
          あとで
        </button>
      </div>
    </section>
  );
}
