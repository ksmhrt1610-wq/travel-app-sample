"use client";

import { useState } from "react";
import { GROUP_LIMITS, type GroupMember } from "@/core/group";
import { addDays, formatDateJa, nextSaturday } from "@/core/time";
import { Button, cx } from "../ui";
import type { NewGroup } from "@/store/groupStore";

const defaultDates = (): string[] => {
  const sat = nextSaturday(new Date());
  return [sat, addDays(sat, 1)];
};

/** 準備: メンバー（2〜6人）・主催者・候補日（2〜4日） */
export function GroupSetup({ onCreate, error }: { onCreate: (g: NewGroup) => void; error?: string | null }) {
  const [names, setNames] = useState<string[]>(["", ""]);
  const [organizer, setOrganizer] = useState(0);
  const [dates, setDates] = useState<string[]>(defaultDates);

  const trimmed = names.map((n) => n.trim());
  const namesOk = trimmed.every((n) => n.length > 0 && n.length <= 30) && new Set(trimmed).size === trimmed.length;
  const datesOk = dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) && new Set(dates).size === dates.length;
  const valid = namesOk && datesOk;

  const submit = () => {
    if (!valid) return;
    const members: GroupMember[] = trimmed.map((name, i) => ({ id: `m${i + 1}`, name }));
    onCreate({ members, organizerId: members[organizer].id, candidateDates: [...dates].sort() });
  };

  return (
    <form
      className="space-y-3"
      data-testid="group-setup"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-[15px] font-bold text-slate-900">メンバー（{GROUP_LIMITS.minMembers}〜{GROUP_LIMITS.maxMembers}人）</h2>
        <p className="mb-2 text-xs text-slate-500">1台のスマホを順番に回して、1人ずつ希望を入力します。主催者は、同票のときに決める人です。</p>
        <ul className="space-y-2">
          {names.map((n, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                value={n}
                maxLength={30}
                placeholder={`メンバー${i + 1}の名前`}
                aria-label={`メンバー${i + 1}の名前`}
                data-testid={`group-name-${i}`}
                onChange={(e) => setNames((a) => a.map((x, k) => (k === i ? e.target.value : x)))}
                className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 text-[15px]"
              />
              <label className="flex shrink-0 items-center gap-1 text-xs font-semibold text-slate-600">
                <input type="radio" name="organizer" checked={organizer === i} data-testid={`group-organizer-${i}`} onChange={() => setOrganizer(i)} />
                主催者
              </label>
              {names.length > GROUP_LIMITS.minMembers && (
                <button
                  type="button"
                  aria-label={`メンバー${i + 1}を外す`}
                  className="size-8 shrink-0 rounded-full text-slate-400 hover:bg-slate-100"
                  onClick={() => {
                    setNames((a) => a.filter((_, k) => k !== i));
                    setOrganizer((o) => (o === i ? 0 : o > i ? o - 1 : o));
                  }}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        {names.length < GROUP_LIMITS.maxMembers && (
          <Button variant="ghost" size="sm" className="mt-2" data-testid="group-add-member" onClick={() => setNames((a) => [...a, ""])}>
            ＋ メンバーを追加
          </Button>
        )}
        {!namesOk && names.some((n) => n.trim()) && <p className="mt-2 text-xs text-rose-600">名前は、全員ぶん入力し、重ならないようにしてください</p>}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-[15px] font-bold text-slate-900">候補日（{GROUP_LIMITS.minDates}〜{GROUP_LIMITS.maxDates}日）</h2>
        <p className="mb-2 text-xs text-slate-500">主催者が決めた候補日から、各自が参加できる日を選びます。</p>
        <ul className="space-y-2">
          {dates.map((d, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                type="date"
                value={d}
                aria-label={`候補日${i + 1}`}
                data-testid={`group-date-${i}`}
                onChange={(e) => setDates((a) => a.map((x, k) => (k === i ? e.target.value : x)))}
                className="min-h-11 flex-1 rounded-xl border border-slate-300 px-3 text-[15px]"
              />
              <span className="w-20 shrink-0 text-xs text-slate-500">{/^\d{4}-\d{2}-\d{2}$/.test(d) ? formatDateJa(d) : ""}</span>
              {dates.length > GROUP_LIMITS.minDates && (
                <button type="button" aria-label={`候補日${i + 1}を外す`} className="size-8 shrink-0 rounded-full text-slate-400 hover:bg-slate-100" onClick={() => setDates((a) => a.filter((_, k) => k !== i))}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        {dates.length < GROUP_LIMITS.maxDates && (
          <Button variant="ghost" size="sm" className="mt-2" data-testid="group-add-date" onClick={() => setDates((a) => [...a, addDays(a[a.length - 1] ?? nextSaturday(new Date()), 1)])}>
            ＋ 候補日を追加
          </Button>
        )}
        {!datesOk && <p className="mt-2 text-xs text-rose-600">候補日は、重ならないように入力してください</p>}
      </section>

      {error && <p className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900" role="alert">{error}</p>}
      <Button type="submit" size="lg" className={cx("w-full")} disabled={!valid} data-testid="group-create">
        希望を集めはじめる
      </Button>
    </form>
  );
}
