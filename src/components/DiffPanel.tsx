"use client";

import { useState } from "react";
import { summarizeDiff, type ChangeSet, type DiffItem } from "@/core/diff";
import { formatDuration, formatHHMM } from "@/core/time";
import type { PlanningContext } from "@/core/types";
import { cx } from "./ui";

const range = (s: { startMin: number; endMin: number }) => `${formatHHMM(s.startMin)}–${formatHHMM(s.endMin)}`;

function DiffLine({ item, ctx }: { item: DiffItem; ctx: PlanningContext }) {
  const name = (id?: string) => (id ? ctx.spotById.get(id)?.name : undefined) ?? "予定";
  switch (item.kind) {
    case "replaced":
      return (
        <li data-testid="diff-replaced">
          <span className="mr-1">🔁</span>
          <span className="text-slate-500 line-through">{name(item.before.spotId)}</span>
          <span className="mx-1 text-slate-400">→</span>
          <strong className="text-emerald-800">{name(item.after.spotId)}</strong>
          <span className="block pl-6 text-[11px] tabular-nums text-slate-500">
            {range(item.before)} → {range(item.after)}
          </span>
        </li>
      );
    case "shifted":
      return (
        <li data-testid="diff-shifted">
          <span className="mr-1">⏱</span>
          <strong>{name(item.after.spotId)}</strong>
          <span className="block pl-6 text-[11px] tabular-nums text-slate-500">
            {range(item.before)} → {range(item.after)}
            <span className={cx("ml-1 font-bold", item.deltaMin > 0 ? "text-amber-700" : "text-emerald-700")}>
              （{item.deltaMin > 0 ? "+" : ""}
              {item.deltaMin}分）
            </span>
          </span>
        </li>
      );
    case "buffer-changed":
      return (
        <li data-testid="diff-buffer">
          <span className="mr-1">☕</span>
          <strong>余白</strong>
          <span className="ml-1 text-[11px] tabular-nums text-slate-500">
            {formatDuration(item.before.endMin - item.before.startMin)} → {formatDuration(item.after.endMin - item.after.startMin)}（遅れを吸収）
          </span>
        </li>
      );
    case "skip-candidate":
      return (
        <li data-testid="diff-skip-candidate">
          <span className="mr-1">⏭</span>
          <strong>{name(item.after.spotId)}</strong>
          <span className="ml-1 text-[11px] text-amber-700">スキップ候補に</span>
        </li>
      );
    case "skipped":
      return (
        <li>
          <span className="mr-1">⏭</span>
          <strong>{name(item.after.spotId)}</strong>
          <span className="ml-1 text-[11px] text-slate-500">をスキップ</span>
        </li>
      );
    case "closed":
      return (
        <li>
          <span className="mr-1">⛔</span>
          <strong>{name(item.after.spotId)}</strong>
          <span className="ml-1 text-[11px] text-rose-700">臨時休業</span>
        </li>
      );
    default:
      return (
        <li>
          <span className="mr-1">↩️</span>
          <strong>{name(item.after.spotId)}</strong>
          <span className="ml-1 text-[11px] text-slate-500">を元に戻しました</span>
        </li>
      );
  }
}

function Summary({ items }: { items: DiffItem[] }) {
  const s = summarizeDiff(items);
  const chips = [
    s.replaced && `切替 ${s.replaced}件`,
    s.shifted && `時刻変更 ${s.shifted}件`,
    s.maxShiftMin > 0 && `最大 +${s.maxShiftMin}分`,
    s.bufferAbsorbedMin > 0 && `余白が ${s.bufferAbsorbedMin}分 吸収`,
    s.skipCandidates && `スキップ候補 ${s.skipCandidates}件`,
    s.skipped && `スキップ ${s.skipped}件`,
    s.closed && `休業 ${s.closed}件`,
  ].filter(Boolean) as string[];
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c} className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-slate-700 ring-1 ring-slate-200">
          {c}
        </span>
      ))}
    </div>
  );
}

/** 切り替え・遅延の前後で何が変わったかを見せる差分表示 */
export function DiffPanel({ history, ctx }: { history: ChangeSet[]; ctx: PlanningContext }) {
  const [showAll, setShowAll] = useState(false);
  if (!history.length) return null;
  const [latest, ...older] = history;

  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50/70 p-3" data-testid="diff-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-extrabold text-amber-950">🧾 変更内容（{formatHHMM(latest.atMin)}時点）</h2>
          <p className="text-[13px] font-semibold text-slate-800" data-testid="diff-title">
            {latest.title}
          </p>
        </div>
      </div>
      <Summary items={latest.items} />
      <ul className="mt-2 space-y-1.5 text-[13px] text-slate-800">
        {latest.items.map((it) => (
          <DiffLine key={`${it.blockId}-${it.kind}`} item={it} ctx={ctx} />
        ))}
      </ul>

      {older.length > 0 && (
        <div className="mt-2 border-t border-amber-200 pt-2">
          <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs font-semibold text-amber-900 underline" data-testid="diff-history-toggle">
            {showAll ? "過去の変更を閉じる" : `過去の変更を見る（${older.length}件）`}
          </button>
          {showAll && (
            <ol className="mt-2 space-y-2">
              {older.map((cs) => (
                <li key={cs.id} className="rounded-xl bg-white/70 p-2">
                  <p className="text-xs font-bold text-slate-700">
                    {formatHHMM(cs.atMin)} {cs.title}
                  </p>
                  <Summary items={cs.items} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
