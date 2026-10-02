"use client";

import { useState } from "react";
import { GROUP_LIMITS, type GroupState } from "@/core/group";
import { formatDateJa } from "@/core/time";
import { Button, cx } from "../ui";
import { Avatar } from "./Avatar";

/** 回答の一覧。回答の進み具合だけを見せる（中身は、本人の入力画面でだけ見える） */
export function GroupAnswers({
  group,
  onAnswer,
  onMakePlans,
  onReset,
}: {
  group: GroupState;
  onAnswer: (memberId: string) => void;
  onMakePlans: () => void;
  onReset: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const answered = group.members.filter((m) => group.inputs[m.id]);
  const pending = group.members.filter((m) => !group.inputs[m.id]);
  const pct = Math.round((answered.length / group.members.length) * 100);
  const organizer = group.members.find((m) => m.id === group.organizerId);

  return (
    <div className="space-y-3" data-testid="group-answers">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-bold text-slate-900">回答の進み具合</h2>
          <span className="text-sm font-bold text-brand-700" data-testid="group-progress">
            {answered.length}/{group.members.length}人が回答
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          候補日: {group.candidateDates.map(formatDateJa).join("・")}／主催者: {organizer?.name}
        </p>
      </section>

      <ul className="space-y-2">
        {group.members.map((m, i) => {
          const done = !!group.inputs[m.id];
          return (
            <li key={m.id} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" data-testid={`group-member-${m.id}`} data-answered={done}>
              <div className="flex items-center gap-3">
                <Avatar member={m} index={i} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-slate-900">
                    {m.name}
                    {m.id === group.organizerId && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">主催者</span>}
                  </div>
                  <div className={cx("text-xs font-semibold", done ? "text-emerald-700" : "text-slate-400")}>{done ? "✓ 回答済み" : "未回答"}</div>
                </div>
                {done ? (
                  <Button variant="secondary" size="sm" data-testid={`group-reanswer-${m.id}`} onClick={() => setConfirming(m.id)}>
                    回答を直す
                  </Button>
                ) : (
                  <Button size="sm" data-testid={`group-answer-${m.id}`} onClick={() => onAnswer(m.id)}>
                    回答する
                  </Button>
                )}
              </div>
              {confirming === m.id && (
                <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="reanswer-confirm">
                  <p className="font-semibold">{m.name}さんの回答（予算・苦手を含む）を表示します。{m.name}さん本人が操作してください。</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>
                      やめる
                    </Button>
                    <Button size="sm" data-testid={`group-reanswer-ok-${m.id}`} onClick={() => onAnswer(m.id)}>
                      表示する
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="space-y-2">
        <Button size="lg" className="w-full" disabled={answered.length < GROUP_LIMITS.minMembers} data-testid="group-make-plans" onClick={onMakePlans}>
          {pending.length ? `未回答（${pending.map((m) => m.name).join("・")}）を除いて案を作る` : "3つの案を作る"}
        </Button>
        {answered.length < GROUP_LIMITS.minMembers && <p className="text-center text-xs text-slate-500">2人以上が回答すると、案を作れます</p>}
        <Button variant="ghost" size="sm" className="w-full text-rose-700" data-testid="group-reset" onClick={onReset}>
          グループを最初からやり直す
        </Button>
      </div>
    </div>
  );
}
