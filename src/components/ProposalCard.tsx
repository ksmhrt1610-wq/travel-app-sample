"use client";

import { mapsDirectionsUrl } from "@/core/maps";
import type { ReplanResult, ReplanStep } from "@/core/replan";
import { formatDuration } from "@/core/time";
import type { Block, Itinerary, PlanningContext } from "@/core/types";
import { DiffList, DiffSummary } from "./DiffPanel";
import { Button, cx } from "./ui";

function blockOf(itin: Itinerary, id: string): Block | undefined {
  return itin.days.flatMap((d) => d.blocks).find((b) => b.id === id);
}

function nameOf(itin: Itinerary, ctx: PlanningContext, id: string): string {
  const b = blockOf(itin, id);
  if (!b) return "予定";
  if (b.fixed) return b.fixed.title;
  if (b.spotId) return ctx.spotById.get(b.spotId)?.name ?? "予定";
  return b.label === "rest" ? "休憩" : "余白";
}

/** 削減の優先順位（再計画エンジンが固定している順） */
const REDUCE_ORDER: { kind: ReplanStep["kind"]; no: string; label: string }[] = [
  { kind: "drop-optional", no: "①", label: "Optional を後ろから削除" },
  { kind: "shorten", no: "②", label: "滞在時間を短縮（最低滞在時間まで）" },
  { kind: "drop-standard", no: "③", label: "標準の予定を後ろから削除" },
];

function stepText(step: ReplanStep, r: ReplanResult, ctx: PlanningContext): string {
  const names = (ids: string[]) => ids.map((id) => `「${nameOf(r.after, ctx, id)}」`).join("、");
  switch (step.kind) {
    case "plan-b":
      return `Plan B に切り替え：${names(step.blockIds)}`;
    case "delay":
      return `遅延 ${step.detail} を反映して、後ろの予定を計算し直し`;
    case "closure":
      return `臨時休業を反映：${names(step.blockIds)}`;
    case "replace":
      return `代わりのスポットに切り替え：${names(step.blockIds)}`;
    case "insert-rest": {
      const b = blockOf(r.after, step.blockIds[0]);
      return `休憩を追加：${step.detail ? `「${step.detail}」` : "近くで"}（${formatDuration(b?.durationMin ?? 0)}）`;
    }
    case "fixed-add":
      return `固定時刻を追加：${step.detail}`;
    case "fixed-remove":
      return "固定時刻を外す";
    case "margin":
      return `余裕時間を ${step.detail} に変更`;
    case "skip":
      return `スキップ：${names(step.blockIds)}`;
    case "restore":
      return `スキップを取り消し：${names(step.blockIds)}`;
    case "drop-must":
      return `Must を外す（確認済み）：${names(step.blockIds)}`;
    case "drop-optional":
      return step.phase === "event" ? `残りの Optional をスキップ：${names(step.blockIds)}` : `Optional をスキップ：${names(step.blockIds)}`;
    case "shorten":
      return `滞在を短縮：${names(step.blockIds)} ${step.detail}`;
    case "drop-standard":
      return `標準の予定をスキップ：${names(step.blockIds)}`;
    case "reorder":
      return `近い順に並べ直し：${names(step.blockIds)}`;
    case "tidy":
      return `${step.detail}を片づけ`;
  }
}

interface Props {
  result: ReplanResult;
  ctx: PlanningContext;
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 確認したうえで、この Must を外した案にする */
  onRemoveMust: (blockId: string) => void;
}

/**
 * 再計画エンジンの提案を見せるカード。差分を確認し、確定ボタンで初めて旅程に反映する。
 */
export function ProposalCard({ result, ctx, title, onConfirm, onCancel, onRemoveMust }: Props) {
  const events = result.steps.filter((s) => s.phase === "event" || s.phase === "tidy");
  const reduce = result.steps.filter((s) => s.phase === "reduce");
  const walkDiff = result.walkingBeforeM - result.walkingAfterM;
  const unchanged = result.diff.length === 0 && result.mustCandidates.length === 0;

  return (
    <section className="animate-pop-in rounded-2xl border-2 border-indigo-400 bg-indigo-50 p-4 shadow-md" role="region" aria-label="組み直し案" data-testid="proposal-card">
      <h2 className="text-[15px] font-extrabold text-indigo-950">🧩 組み直し案（まだ反映されていません）</h2>
      <p className="mt-0.5 text-[13px] font-bold text-slate-800" data-testid="proposal-title">
        {title}
      </p>

      {result.feasible ? (
        <p className="mt-2 rounded-lg bg-emerald-100 px-3 py-1.5 text-xs font-bold text-emerald-900" data-testid="proposal-ok">
          ✅ 固定時刻・営業時間に間に合います
        </p>
      ) : (
        <div className="mt-2 rounded-lg bg-rose-100 px-3 py-2 text-xs font-bold text-rose-900" data-testid="proposal-ng">
          <p>⚠ このままでは間に合わない予定が残ります</p>
          <ul className="mt-1 list-disc pl-4 font-semibold">
            {result.violations.map((v) => (
              <li key={`${v.blockId}-${v.kind}`}>{v.message}</li>
            ))}
          </ul>
        </div>
      )}

      {result.notes.map((n) => (
        <p key={n} className="mt-2 text-xs leading-relaxed text-indigo-900" data-testid="proposal-note">
          {n}
        </p>
      ))}

      {(events.length > 0 || reduce.length > 0) && (
        <div className="mt-3 rounded-xl bg-white/80 p-2.5 text-[13px]" data-testid="proposal-steps">
          <p className="mb-1 text-[11px] font-bold text-slate-500">組み直しの手順</p>
          <ul className="space-y-0.5">
            {events.map((s, i) => (
              <li key={`e${i}`} data-step-kind={s.kind}>
                ・{stepText(s, result, ctx)}
              </li>
            ))}
          </ul>
          {reduce.length > 0 && (
            <>
              <p className="mb-1 mt-2 text-[11px] font-bold text-slate-500">時間が足りないため、優先度の低い順に削減（固定時刻 → Must → 休憩・余白 → Optional）</p>
              <ul className="space-y-0.5">
                {REDUCE_ORDER.map((o) => {
                  const hits = reduce.filter((s) => s.kind === o.kind);
                  if (!hits.length) return null;
                  return (
                    <li key={o.kind} data-step-kind={o.kind}>
                      <span className="font-bold">
                        {o.no} {o.label}
                      </span>
                      <ul className="pl-4 text-slate-700">
                        {hits.map((s, i) => (
                          <li key={i}>・{stepText(s, result, ctx)}</li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}

      {result.walkingBeforeM > 0 && (result.event.type === "tired" || walkDiff !== 0) && (
        <p className="mt-2 text-xs font-semibold text-slate-800" data-testid="proposal-walking">
          🚶 残りの推定歩行距離：{(result.walkingBeforeM / 1000).toFixed(1)}km → <strong className={cx(walkDiff > 0 ? "text-emerald-700" : "")}>{(result.walkingAfterM / 1000).toFixed(1)}km</strong>
          {walkDiff > 0 && `（約${(walkDiff / 1000).toFixed(1)}km 減）`}
        </p>
      )}

      {result.travelSuggestions.length > 0 && (
        <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-950" data-testid="proposal-travel">
          <p className="font-bold">徒歩20分以上かかる移動は、公共交通かタクシーがおすすめです</p>
          <ul className="mt-1 space-y-1">
            {result.travelSuggestions.map((t) => {
              const to = blockOf(result.after, t.blockId);
              const spot = to?.spotId ? ctx.spotById.get(to.spotId) : undefined;
              return (
                <li key={t.blockId}>
                  {t.fromName} → <strong>{t.toName}</strong>：徒歩だと約{t.walkMin}分 → 電車・バス 約{t.transitMin}分 / タクシー 約{t.taxiMin}分
                  {spot && (
                    <a className="ml-1 font-semibold text-brand-700 underline" href={mapsDirectionsUrl(spot, "transit")} target="_blank" rel="noopener noreferrer">
                      経路
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {result.diff.length > 0 && (
        <div className="mt-3" data-testid="proposal-diff">
          <p className="text-[11px] font-bold text-slate-500">変更前との差分</p>
          <DiffSummary items={result.diff} />
          <div className="mt-1.5 rounded-xl bg-white/80 p-2.5">
            <DiffList items={result.diff} ctx={ctx} itin={result.after} />
          </div>
        </div>
      )}
      {unchanged && <p className="mt-2 text-xs text-slate-600">旅程への影響はありません。</p>}

      {result.mustCandidates.length > 0 && (
        <div className="mt-3 rounded-xl border-2 border-rose-300 bg-rose-50 p-3" data-testid="must-candidates">
          <p className="text-[13px] font-extrabold text-rose-950">Must を削る候補があります（確認が必要です）</p>
          <p className="mt-0.5 text-xs text-rose-900">Must は自動では削りません。外してよい予定があれば選んでください。固定時刻は守ります。</p>
          <ul className="mt-2 space-y-1.5">
            {result.mustCandidates.map((c) => (
              <li key={c.blockId} className="flex items-center gap-2 rounded-lg bg-white p-2 text-[13px]">
                <span className="flex-1">
                  <strong>{c.name}</strong>
                  <span className={cx("block text-[11px] font-semibold", c.fixesAll ? "text-emerald-700" : "text-amber-700")}>
                    {c.fixesAll ? "外すと間に合います" : "外しても、まだ足りない予定が残ります"}
                  </span>
                </span>
                <Button variant="danger" size="sm" onClick={() => onRemoveMust(c.blockId)} data-testid={`remove-must-${c.blockId}`}>
                  これを外した案にする
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 grid gap-2">
        <Button onClick={onConfirm} variant={result.feasible ? "primary" : "amber"} className="h-auto whitespace-normal py-2.5 text-center" data-testid="proposal-confirm">
          {result.feasible ? "この内容で確定" : "間に合わない予定が残るまま確定"}
        </Button>
        <Button variant="secondary" onClick={onCancel} data-testid="proposal-cancel">
          やめる（元の旅程のまま）
        </Button>
      </div>
    </section>
  );
}
