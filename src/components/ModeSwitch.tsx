"use client";

import { MODE_HELP, MODE_LABEL } from "@/core/policy";
import type { ResponseMode } from "@/core/types";
import { cx } from "./ui";

const MODES: ResponseMode[] = ["manual", "suggest", "auto"];
const ICON: Record<ResponseMode, string> = { manual: "✋", suggest: "💡", auto: "🤖" };

/** 当日の対応のしかた（手動／提案／おまかせ）の切り替え。旅程ごとに保存される */
export function ModeSwitch({ mode, onChange, compact }: { mode: ResponseMode; onChange: (m: ResponseMode) => void; compact?: boolean }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3" data-testid="mode-switch" data-mode={mode}>
      <h2 className="text-xs font-bold text-slate-600">当日の対応のしかた</h2>
      <div className="mt-1.5 grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="当日の対応のしかた">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => onChange(m)}
            data-testid={`mode-${m}`}
            className={cx(
              "min-h-10 rounded-xl border text-sm font-bold",
              mode === m ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
            )}
          >
            {ICON[m]} {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {!compact && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600" data-testid="mode-help">
          {MODE_HELP[mode]}
        </p>
      )}
    </section>
  );
}
