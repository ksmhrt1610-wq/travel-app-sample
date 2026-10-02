"use client";

import { useMemo, useState } from "react";
import { ALL_CATEGORIES, GROUP_LIMITS, type InterestVote, type MemberInput } from "@/core/group";
import { AREA_LABEL, CATEGORY_ICON, CATEGORY_LABEL, PACE_LABEL, RAIN_LABEL } from "@/core/labels";
import { DIET_LABEL, DIET_ORDER } from "@/core/meals";
import { formatDateJa } from "@/core/time";
import type { Area, DietaryRestriction, Pace, RainTolerance, Spot } from "@/core/types";
import { Button, cx } from "../ui";

const VOTE_LABEL: Record<InterestVote, string> = { like: "好き", neutral: "どちらでも", dislike: "苦手" };
const BUDGETS = [3000, 5000, 8000, 10000, 12000, 15000, 20000];
const AREAS = Object.keys(AREA_LABEL) as Area[];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-[15px] font-bold text-slate-900">{title}</h3>
      {hint && <p className="mb-2 text-xs text-slate-500">{hint}</p>}
      <div className={cx(!hint && "mt-2")}>{children}</div>
    </section>
  );
}

function Pick<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={name} className="grid grid-cols-3 gap-2">
      {(Object.keys(options) as T[]).map((k) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          data-testid={`member-${name}-${k}`}
          onClick={() => onChange(k)}
          className={cx(
            "min-h-11 rounded-xl border px-1 text-sm font-semibold",
            value === k ? "border-brand-600 bg-brand-50 text-brand-700 ring-1 ring-brand-600" : "border-slate-300 bg-white text-slate-700",
          )}
        >
          {options[k]}
        </button>
      ))}
    </div>
  );
}

/**
 * 1人ぶんの入力。予算の金額と「苦手」の回答は、この画面でだけ見える（集約結果には出ない）。
 * 入力したあとは、必ず回答の一覧に戻る（次の人に、前の人の入力を見せないため）。
 */
export function MemberForm({
  memberName,
  candidateDates,
  spots,
  initial,
  onSubmit,
  onCancel,
}: {
  memberName: string;
  candidateDates: string[];
  spots: Spot[];
  initial?: MemberInput;
  onSubmit: (input: Omit<MemberInput, "memberId">) => void;
  onCancel: () => void;
}) {
  const [dates, setDates] = useState<string[]>(initial?.availableDates ?? candidateDates);
  const [budget, setBudget] = useState<number>(initial?.budgetCapYen ?? 10000);
  const [dietary, setDietary] = useState<DietaryRestriction[]>(initial?.dietary ?? []);
  const [rain, setRain] = useState<RainTolerance>(initial?.rainTolerance ?? "light-rain-ok");
  const [pace, setPace] = useState<Pace>(initial?.pace ?? "normal");
  const [interests, setInterests] = useState<MemberInput["interests"]>(initial?.interests ?? {});
  const [wish, setWish] = useState<string[]>([initial?.wantedSpotIds[0] ?? "", initial?.wantedSpotIds[1] ?? ""]);

  const byArea = useMemo(() => AREAS.map((a) => ({ area: a, spots: spots.filter((s) => s.area === a) })).filter((g) => g.spots.length), [spots]);
  const budgetValid = Number.isFinite(budget) && budget >= 0 && budget <= 1_000_000;

  const submit = () => {
    if (!budgetValid) return;
    const wanted = [...new Set(wish.filter(Boolean))].slice(0, GROUP_LIMITS.maxWanted);
    onSubmit({ availableDates: dates, budgetCapYen: budget, dietary, rainTolerance: rain, pace, interests, wantedSpotIds: wanted });
  };

  return (
    <form
      className="space-y-3"
      data-testid="member-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
        <strong>{memberName}さん</strong>の入力画面です。予算の金額と「苦手」は、<strong>ここだけ</strong>で見えます。ほかの人の画面や、まとめの結果には出ません。
      </p>

      <Section title="参加できる日" hint="候補日から、参加できる日をすべて選んでください">
        <div className="space-y-1.5">
          {candidateDates.map((d) => (
            <label key={d} className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 px-3 text-sm">
              <input
                type="checkbox"
                checked={dates.includes(d)}
                data-testid={`member-date-${d}`}
                onChange={() => setDates((a) => (a.includes(d) ? a.filter((x) => x !== d) : [...a, d]))}
              />
              {formatDateJa(d)}
            </label>
          ))}
        </div>
      </Section>

      <Section title="予算の上限（1人1日・円）" hint="食事・入場料などの目安。全員の上限のうち、いちばん低い額に合わせます">
        <div className="flex flex-wrap gap-2">
          {BUDGETS.map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={budget === b}
              data-testid={`member-budget-${b}`}
              onClick={() => setBudget(b)}
              className={cx("min-h-10 rounded-full border px-3 text-sm font-semibold", budget === b ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700")}
            >
              ¥{b.toLocaleString("ja-JP")}
            </button>
          ))}
        </div>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={1000000}
          step={500}
          value={Number.isFinite(budget) ? budget : ""}
          aria-label="予算の上限（円）"
          data-testid="member-budget"
          onChange={(e) => setBudget(e.target.value === "" ? NaN : Number(e.target.value))}
          className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-[15px]"
        />
        {!budgetValid && <p className="mt-1 text-xs text-rose-600">0〜1,000,000 の数字を入れてください</p>}
      </Section>

      <Section title="食事制限" hint="あてはまるものを選ぶと、食事は全員の制限に対応できる店だけから選びます（対応は仮のデータ。実際は店に確認してください）">
        <div className="flex flex-wrap gap-2">
          {DIET_ORDER.map((d) => {
            const on = dietary.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                data-testid={`member-diet-${d}`}
                onClick={() => setDietary((a) => (on ? a.filter((x) => x !== d) : [...a, d]))}
                className={cx("min-h-10 rounded-full border px-3.5 text-sm font-semibold", on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700")}
              >
                {DIET_LABEL[d]}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="雨への許容度">
        <Pick name="rain" value={rain} options={RAIN_LABEL} onChange={setRain} />
      </Section>

      <Section title="ペース">
        <Pick name="pace" value={pace} options={PACE_LABEL} onChange={setPace} />
      </Section>

      <Section title="好み" hint="カテゴリごとに「好き／どちらでも／苦手」。苦手は、まとめの結果には出ません">
        <ul className="space-y-2">
          {ALL_CATEGORIES.map((c) => {
            const v = interests[c] ?? "neutral";
            return (
              <li key={c} className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-sm font-semibold text-slate-700">
                  {CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}
                </span>
                <div role="radiogroup" aria-label={CATEGORY_LABEL[c]} className="grid flex-1 grid-cols-3 gap-1">
                  {(Object.keys(VOTE_LABEL) as InterestVote[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={v === k}
                      data-testid={`member-interest-${c}-${k}`}
                      onClick={() => setInterests((cur) => ({ ...cur, [c]: k }))}
                      className={cx(
                        "min-h-9 rounded-lg border px-1 text-xs font-semibold",
                        v === k
                          ? k === "like"
                            ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                            : k === "dislike"
                              ? "border-rose-600 bg-rose-50 text-rose-800"
                              : "border-slate-500 bg-slate-100 text-slate-800"
                          : "border-slate-200 bg-white text-slate-500",
                      )}
                    >
                      {VOTE_LABEL[k]}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={`行きたい場所（最大${GROUP_LIMITS.maxWanted}件・任意）`} hint="1件目が第1希望。2人以上の希望が重なった場所は、必ず行く場所になります">
        {[0, 1].map((i) => (
          <select
            key={i}
            value={wish[i]}
            aria-label={`行きたい場所 ${i + 1}`}
            data-testid={`member-wish-${i}`}
            onChange={(e) => setWish((w) => w.map((x, k) => (k === i ? e.target.value : x)))}
            className="mb-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-[15px]"
          >
            <option value="">{i === 0 ? "（指定しない）" : "（もう1件は指定しない）"}</option>
            {byArea.map((g) => (
              <optgroup key={g.area} label={AREA_LABEL[g.area]}>
                {g.spots.map((s) => (
                  <option key={s.id} value={s.id} disabled={wish.some((w, k) => k !== i && w === s.id)}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ))}
      </Section>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" size="lg" onClick={onCancel} data-testid="member-cancel">
          やめる
        </Button>
        <Button type="submit" size="lg" disabled={!budgetValid} data-testid="member-submit">
          回答を保存
        </Button>
      </div>
    </form>
  );
}
