"use client";

import { useMemo, useState } from "react";
import {
  AREA_LABEL,
  BUDGET_LABEL,
  CATEGORY_ICON,
  CATEGORY_LABEL,
  COMPANIONS_LABEL,
  DURATION_LABEL,
  PACE_LABEL,
  RAIN_LABEL,
  SETTING_ICON,
  SETTING_LABEL,
} from "@/core/labels";
import type {
  Area,
  Budget,
  Companions,
  Duration,
  InterestCategory,
  Pace,
  Preferences,
  RainTolerance,
  Spot,
} from "@/core/types";
import { Button, cx } from "./ui";

export const DEMO_PREFERENCES: Preferences = {
  duration: "day",
  companions: "friends",
  budget: "normal",
  interests: ["gourmet", "cafe"],
  pace: "relaxed",
  rainTolerance: "light-rain-ok",
  mustSpotIds: [],
};

const INTERESTS = Object.keys(CATEGORY_LABEL) as InterestCategory[];
const AREAS = Object.keys(AREA_LABEL) as Area[];

function Question({ no, title, hint, children }: { no: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-0.5 flex items-center gap-2 text-[15px] font-bold text-slate-900">
        <span className="flex size-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">{no}</span>
        {title}
      </h2>
      {hint && <p className="mb-2 ml-8 text-xs text-slate-500">{hint}</p>}
      <div className={cx(!hint && "mt-2")}>{children}</div>
    </section>
  );
}

function Choice<T extends string>({
  name,
  value,
  options,
  onChange,
  columns = 2,
}: {
  name: string;
  value: T;
  options: Record<T, string>;
  onChange: (v: T) => void;
  columns?: 2 | 3 | 4;
}) {
  const keys = Object.keys(options) as T[];
  return (
    <div role="radiogroup" aria-label={name} className={cx("grid gap-2", columns === 2 && "grid-cols-2", columns === 3 && "grid-cols-3", columns === 4 && "grid-cols-4")}>
      {keys.map((k) => {
        const selected = value === k;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`${name}-${k}`}
            onClick={() => onChange(k)}
            className={cx(
              "min-h-11 rounded-xl border px-2 text-sm font-semibold transition-colors",
              selected ? "border-brand-600 bg-brand-50 text-brand-700 ring-1 ring-brand-600" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
            )}
          >
            {options[k]}
          </button>
        );
      })}
    </div>
  );
}

export function PreferenceForm({
  spots,
  initial,
  submitting,
  onSubmit,
}: {
  spots: Spot[];
  initial?: Preferences;
  submitting?: boolean;
  onSubmit: (prefs: Preferences) => void;
}) {
  const [prefs, setPrefs] = useState<Preferences>(initial ?? DEMO_PREFERENCES);
  const [mustOpen, setMustOpen] = useState((initial?.mustSpotIds.length ?? 0) > 0);
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  const toggleInterest = (c: InterestCategory) =>
    set("interests", prefs.interests.includes(c) ? prefs.interests.filter((x) => x !== c) : [...prefs.interests, c]);
  const toggleMust = (id: string) =>
    set("mustSpotIds", prefs.mustSpotIds.includes(id) ? prefs.mustSpotIds.filter((x) => x !== id) : [...prefs.mustSpotIds, id]);

  const byArea = useMemo(
    () => AREAS.map((a) => ({ area: a, spots: spots.filter((s) => s.area === a) })).filter((g) => g.spots.length),
    [spots],
  );
  const valid = prefs.interests.length > 0;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(prefs);
      }}
    >
      <Question no={1} title="日程">
        <Choice name="duration" value={prefs.duration} options={DURATION_LABEL} onChange={(v: Duration) => set("duration", v)} />
      </Question>

      <Question no={2} title="同行者">
        <Choice name="companions" value={prefs.companions} options={COMPANIONS_LABEL} onChange={(v: Companions) => set("companions", v)} columns={4} />
      </Question>

      <Question no={3} title="予算帯">
        <Choice name="budget" value={prefs.budget} options={BUDGET_LABEL} onChange={(v: Budget) => set("budget", v)} columns={3} />
      </Question>

      <Question no={4} title="興味" hint="複数選べます（1つ以上）">
        <div className="flex flex-wrap gap-2" role="group" aria-label="興味">
          {INTERESTS.map((c) => {
            const on = prefs.interests.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                data-testid={`interest-${c}`}
                onClick={() => toggleInterest(c)}
                className={cx(
                  "min-h-10 rounded-full border px-3.5 text-sm font-semibold transition-colors",
                  on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                )}
              >
                {CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}
              </button>
            );
          })}
        </div>
        {!valid && <p className="mt-2 text-xs text-rose-600">興味を1つ以上選んでください</p>}
      </Question>

      <Question no={5} title="ペース">
        <Choice name="pace" value={prefs.pace} options={PACE_LABEL} onChange={(v: Pace) => set("pace", v)} columns={3} />
        <p className="mt-2 text-xs text-slate-500">ゆったりほど「余白（休憩・自由時間）」が増え、予定が少なめになります。</p>
      </Question>

      <Question no={6} title="雨への許容度" hint="当日、雨の予報が出たときに Plan B への切り替えを提案する基準になります">
        <Choice name="rain" value={prefs.rainTolerance} options={RAIN_LABEL} onChange={(v: RainTolerance) => set("rainTolerance", v)} columns={3} />
      </Question>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={() => setMustOpen((o) => !o)}
          aria-expanded={mustOpen}
          className="flex w-full items-center justify-between text-left"
          data-testid="must-toggle"
        >
          <span>
            <span className="text-[15px] font-bold text-slate-900">絶対に行きたい場所</span>
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">任意</span>
            <span className="block text-xs text-slate-500">
              {prefs.mustSpotIds.length ? `${prefs.mustSpotIds.length}件を Must に指定中` : "選ぶと Must として必ず旅程に入ります"}
            </span>
          </span>
          <span className={cx("text-slate-400 transition-transform", mustOpen && "rotate-180")}>▾</span>
        </button>
        {mustOpen && (
          <div className="mt-3 space-y-3" data-testid="must-list">
            {byArea.map((g) => (
              <div key={g.area}>
                <h3 className="mb-1 text-xs font-bold text-slate-500">{AREA_LABEL[g.area]}</h3>
                <ul className="space-y-1">
                  {g.spots.map((s) => {
                    const on = prefs.mustSpotIds.includes(s.id);
                    return (
                      <li key={s.id}>
                        <label
                          className={cx(
                            "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-1.5 text-sm",
                            on ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleMust(s.id)}
                            className="size-4 accent-rose-600"
                            data-testid={`must-${s.id}`}
                          />
                          <span className="flex-1 font-medium text-slate-800">{s.name}</span>
                          <span className="text-xs text-slate-500">
                            {CATEGORY_ICON[s.category]} {SETTING_ICON[s.setting]}
                            <span className="sr-only">{SETTING_LABEL[s.setting]}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="sticky bottom-16 z-20 -mx-1 rounded-2xl bg-slate-50/90 p-1 backdrop-blur">
        <Button type="submit" size="lg" className="w-full" disabled={!valid || submitting} data-testid="generate">
          {submitting ? "つくっています…" : "旅程をつくる"}
        </Button>
      </div>
    </form>
  );
}
