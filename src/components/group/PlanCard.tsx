"use client";

import { SPLIT_THRESHOLD, type GroupMember, type GroupPlan } from "@/core/group";
import { CATEGORY_ICON } from "@/core/labels";
import { MEAL_LABEL } from "@/core/meals";
import { isInert } from "@/core/schedule";
import { formatDuration, formatHHMM } from "@/core/time";
import type { PlanningContext } from "@/core/types";
import { cx } from "../ui";
import { Avatar, memberIndex } from "./Avatar";

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

function SatBar({ score }: { score: number }) {
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
      <div className={cx("h-full rounded-full", score < SPLIT_THRESHOLD ? "bg-rose-500" : score < 60 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${score}%` }} />
    </div>
  );
}

/** 3案のうちの1案。満足度（メンバーごと）・予定・「誰の希望か」・移動と費用の目安 */
export function PlanCard({
  plan,
  members,
  ctx,
  voteCount,
  children,
}: {
  plan: GroupPlan;
  members: GroupMember[];
  ctx: PlanningContext;
  voteCount?: number;
  children?: React.ReactNode;
}) {
  const blocks = plan.itinerary.days[0].blocks.filter((b) => !isInert(b));
  const warnings = plan.itinerary.days[0].warnings;
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-testid={`plan-card-${plan.kind}`}>
      <header>
        <h3 className="text-base font-extrabold text-slate-900">{plan.title}</h3>
        <p className="text-xs text-slate-500">{plan.blurb}</p>
        {plan.note && <p className="mt-1 text-[11px] text-amber-700">※ {plan.note}</p>}
        {voteCount !== undefined && <p className="mt-1 text-xs font-bold text-brand-700" data-testid={`plan-votes-${plan.kind}`}>{voteCount}票</p>}
      </header>

      <section className="mt-3" aria-label="メンバーごとの満足度">
        <h4 className="mb-1 text-xs font-bold text-slate-600">
          満足度（最低 <span data-testid={`plan-min-${plan.kind}`}>{plan.minScore}</span>／合計 <span data-testid={`plan-sum-${plan.kind}`}>{plan.sumScore}</span>）
        </h4>
        <ul className="space-y-1.5">
          {plan.satisfaction.map((s) => {
            const m = members.find((x) => x.id === s.memberId)!;
            return (
              <li key={s.memberId} data-testid={`sat-${plan.kind}-${s.memberId}`}>
                <div className="flex items-center gap-2">
                  <Avatar member={m} index={memberIndex(members, m.id)} size="sm" />
                  <span className="w-14 shrink-0 truncate text-xs font-semibold text-slate-700">{m.name}</span>
                  <SatBar score={s.score} />
                  <span className={cx("w-8 shrink-0 text-right text-xs font-bold", s.score < SPLIT_THRESHOLD ? "text-rose-700" : "text-slate-700")}>{s.score}</span>
                </div>
                {s.reasons.length > 0 && <p className="ml-7 text-[11px] leading-4 text-slate-500">{s.reasons.join("・")}</p>}
              </li>
            );
          })}
        </ul>
      </section>

      <ol className="mt-3 space-y-1.5 border-t border-slate-100 pt-3" aria-label="予定">
        {blocks.map((b) => {
          if (b.label === "buffer" || b.label === "rest") {
            return (
              <li key={b.id} className="flex items-center gap-2 text-xs text-teal-700">
                <span className="w-11 shrink-0 font-mono">{formatHHMM(b.startMin)}</span>
                <span>余白 {formatDuration(b.durationMin)}</span>
              </li>
            );
          }
          const sp = b.spotId ? ctx.spotById.get(b.spotId) : undefined;
          const by = b.spotId ? (plan.requestedBy[b.spotId] ?? []) : [];
          return (
            <li key={b.id} className="flex items-center gap-2 text-sm" data-testid={`plan-block-${plan.kind}`}>
              <span className="w-11 shrink-0 font-mono text-xs text-slate-500">{formatHHMM(b.startMin)}</span>
              <span className="min-w-0 flex-1 truncate">
                {b.meal ? "🍽 " : sp ? `${CATEGORY_ICON[sp.category]} ` : ""}
                <span className="font-semibold text-slate-900">{sp?.name ?? b.place?.name ?? "予定"}</span>
                {b.meal && <span className="ml-1 text-[11px] text-slate-500">{MEAL_LABEL[b.meal]}</span>}
                {b.label === "must" && <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] font-bold text-rose-700">必ず</span>}
              </span>
              <span className="flex shrink-0 -space-x-1" data-testid={b.spotId ? `requested-${plan.kind}-${b.spotId}` : undefined} aria-label={by.length ? "希望した人" : undefined}>
                {by.map((id) => {
                  const m = members.find((x) => x.id === id);
                  return m ? <Avatar key={id} member={m} index={memberIndex(members, id)} size="sm" /> : null;
                })}
              </span>
            </li>
          );
        })}
      </ol>

      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-center text-[11px] text-slate-500">
        <div>
          <dt>移動</dt>
          <dd className="text-sm font-bold text-slate-800">{plan.travelMin}分</dd>
        </div>
        <div>
          <dt>歩く目安</dt>
          <dd className={cx("text-sm font-bold", plan.withinWalkLimit ? "text-slate-800" : "text-amber-700")}>{(plan.walkingM / 1000).toFixed(1)}km</dd>
        </div>
        <div>
          <dt>費用の目安</dt>
          <dd className={cx("text-sm font-bold", plan.withinBudget ? "text-slate-800" : "text-rose-700")}>{yen(plan.estimatedCostYen)}</dd>
        </div>
      </dl>
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-amber-800" data-testid={`plan-warnings-${plan.kind}`}>
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {children}
    </article>
  );
}
