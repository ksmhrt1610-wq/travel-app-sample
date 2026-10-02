"use client";

import { formatHHMM } from "@/core/time";
import type { Block, PlanningContext } from "@/core/types";
import type { RainImpact, RainOverride } from "@/core/weather";
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
        ☔ {formatHHMM(rain.startMin)}から雨（降水確率 {rain.prob}%）— Plan Bに切り替えますか？
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

/** スキップ候補の通知 */
export function SkipBanner({
  blocks,
  ctx,
  onSkipAll,
  onKeep,
}: {
  blocks: Block[];
  ctx: PlanningContext;
  onSkipAll: () => void;
  onKeep: (id: string) => void;
}) {
  return (
    <section className="animate-pop-in rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 shadow-md" role="alert" data-testid="skip-banner">
      <h2 className="text-[15px] font-extrabold text-amber-950">⏭ 間に合わない予定があります（スキップ候補）</h2>
      <p className="mt-0.5 text-xs text-amber-900">Optional の予定を飛ばすと、残りの予定を守れます。</p>
      <ul className="mt-2 space-y-1.5 rounded-xl bg-white/80 p-2.5">
        {blocks.map((b) => (
          <li key={b.id} className="flex items-center gap-2 text-[13px]">
            <span className="flex-1">
              <span className="font-bold tabular-nums text-slate-700">{formatHHMM(b.startMin)}</span>{" "}
              <span className="font-semibold text-slate-900">{ctx.spotById.get(b.spotId!)?.name}</span>
              <span className="block text-[11px] text-amber-800">
                {b.issues?.includes("outside-hours") ? "営業時間に間に合いません" : "予定の終了時刻を超えます"}
              </span>
            </span>
            <button type="button" onClick={() => onKeep(b.id)} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
              それでも行く
            </button>
          </li>
        ))}
      </ul>
      <Button variant="amber" className="mt-3 h-auto w-full whitespace-normal py-2.5 text-center" onClick={onSkipAll} data-testid="skip-all">
        候補をすべてスキップして立て直す
      </Button>
    </section>
  );
}
