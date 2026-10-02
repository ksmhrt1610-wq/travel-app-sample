"use client";

import type { EarlyProgress, Suggestion } from "@/core/suggest";
import { Button } from "./ui";

/** 予定より早く進んでいるときの提案（モードに関係なく提案のみ。選ぶと、新しい組み直しになる） */
export function EarlyCard({
  early,
  suggestions,
  onApply,
  onDismiss,
}: {
  early: EarlyProgress;
  suggestions: Suggestion[];
  onApply: (s: Suggestion) => void;
  onDismiss: () => void;
}) {
  return (
    <section className="animate-pop-in rounded-2xl border-2 border-emerald-400 bg-emerald-50 p-4 shadow-md" role="status" data-testid="early-card">
      <h2 className="text-[15px] font-extrabold text-emerald-950">🏃 予定より{early.earlyByMin}分早く進んでいます</h2>
      <p className="mt-0.5 text-xs text-emerald-900">次の予定まで、約{early.idleMin}分の余裕があります。使い方を選べます（自動では変わりません）。</p>
      <ul className="mt-2 space-y-1.5">
        {suggestions.map((s) => (
          <li key={s.id} className="rounded-lg bg-white p-2 text-[13px]" data-suggestion-kind={s.kind}>
            <strong>{s.title}</strong>
            <span className="block text-[11px] text-slate-600">{s.detail}</span>
            <Button variant="secondary" size="sm" className="mt-1.5" onClick={() => onApply(s)} data-testid={`early-${s.kind}`}>
              これにする
            </Button>
          </li>
        ))}
        {suggestions.length === 0 && <li className="text-xs text-slate-600">いまの場所の近くで足せる予定は見つかりませんでした。</li>}
      </ul>
      <button type="button" onClick={onDismiss} className="mt-2 min-h-9 text-xs font-semibold text-emerald-900 underline" data-testid="early-dismiss">
        このままにする
      </button>
    </section>
  );
}
