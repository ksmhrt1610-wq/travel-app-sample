"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { BlockDetailSheet } from "@/components/BlockDetailSheet";
import { Timeline } from "@/components/Timeline";
import { Button, cx } from "@/components/ui";
import { BUDGET_LABEL, COMPANIONS_LABEL, DURATION_LABEL, PACE_LABEL, RAIN_LABEL } from "@/core/labels";
import { planBWarnings } from "@/core/planner";
import { parseItinerary } from "@/core/schema";
import { decodeItineraryResult } from "@/core/share";
import { formatDateJa } from "@/core/time";
import { saveTrip } from "@/store/tripStore";
import { usePlanningContext } from "@/store/usePlanningContext";

function SharedView() {
  const params = useSearchParams();
  const router = useRouter();
  const ctx = usePlanningContext();
  const token = params.get("s") ?? "";
  const [dayIdx, setDayIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [saveError, setSaveError] = useState<string | null>(null);

  const decoded = useMemo(() => (ctx ? decodeItineraryResult(token, ctx) : null), [ctx, token]);
  const itinerary = decoded?.ok ? decoded.itinerary : null;

  if (!ctx) return <p className="py-16 text-center text-sm text-slate-500">読み込み中…</p>;

  if (!itinerary) {
    return (
      <div className="px-4 py-16 text-center" data-testid="share-error" data-code={decoded && !decoded.ok ? decoded.code : undefined}>
        <p className="text-4xl">🔗</p>
        <p className="mt-3 text-base font-bold text-slate-800">共有リンクを読み込めませんでした</p>
        <p className="mt-1 text-sm text-slate-500" data-testid="share-error-reason">
          {decoded && !decoded.ok ? decoded.reason : "リンクが途中で切れているか、古い形式の可能性があります。"}
        </p>
        <p className="mt-1 text-xs text-slate-400">もう一度共有してもらってください。</p>
        <Link href="/" className="mt-5 inline-flex min-h-12 items-center rounded-xl bg-brand-600 px-6 font-semibold text-white">
          自分の旅程をつくる
        </Link>
      </div>
    );
  }

  const day = itinerary.days[Math.min(dayIdx, itinerary.days.length - 1)];
  const p = itinerary.prefs;
  const selected = selectedId ? (day.blocks.find((b) => b.id === selectedId) ?? null) : null;
  const warnings = [...day.warnings, ...planBWarnings(day, ctx)];

  return (
    <div className="px-4 pb-6 pt-4">
      <div className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-900" data-testid="share-banner">
        🔗 共有された旅程です（閲覧のみ・編集はできません）
      </div>

      <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <p className="text-xs font-semibold text-brand-700">{DURATION_LABEL[p.duration]}の福岡旅行</p>
        <h1 className="text-lg font-extrabold text-slate-900" data-testid="share-title">
          {formatDateJa(itinerary.startDate)}
          {itinerary.days.length > 1 && ` 〜 ${formatDateJa(itinerary.days[itinerary.days.length - 1].date)}`}
        </h1>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold text-slate-600">
          {[COMPANIONS_LABEL[p.companions], BUDGET_LABEL[p.budget], PACE_LABEL[p.pace], `雨：${RAIN_LABEL[p.rainTolerance]}`].map((t, i) => (
            <span key={`${i}-${t}`} className="rounded-full bg-slate-100 px-2 py-0.5">
              {t}
            </span>
          ))}
        </div>
      </section>

      {itinerary.days.length > 1 && (
        <div className="mt-3 grid grid-cols-2 gap-2" role="tablist" aria-label="日付">
          {itinerary.days.map((d) => (
            <button
              key={d.index}
              role="tab"
              aria-selected={d.index === day.index}
              onClick={() => setDayIdx(d.index)}
              className={cx("min-h-11 rounded-xl border text-sm font-bold", d.index === day.index ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700")}
            >
              {d.index + 1}日目 <span className="text-xs font-medium opacity-80">{formatDateJa(d.date)}</span>
            </button>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-2xl border border-amber-300 bg-amber-50 p-3">
          {warnings.map((w) => (
            <p key={w} className="text-[13px] font-semibold leading-snug text-amber-900">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      <div className="mt-4">
        <Timeline day={day} ctx={ctx} onOpen={setSelectedId} members={itinerary.members} marginMin={itinerary.settings.marginMin} />
      </div>

      <div className="mt-4 grid gap-2">
        {saveError && (
          <p className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm font-semibold text-rose-900" role="alert" data-testid="save-shared-error">
            保存できませんでした（{saveError}）
          </p>
        )}
        <Button
          size="lg"
          data-testid="save-shared"
          onClick={() => {
            // 検証を通ったデータだけ保存する
            const checked = parseItinerary(itinerary);
            if (!checked.ok) {
              setSaveError(checked.reason);
              return;
            }
            const r = saveTrip({ prefs: itinerary.prefs, itinerary: checked.value });
            if (!r.ok) {
              setSaveError(r.reason);
              return;
            }
            router.push("/itinerary");
          }}
        >
          この旅程を自分の旅程として保存する
        </Button>
        <Link href="/" className="text-center text-sm font-semibold text-brand-700 underline">
          自分の条件で旅程をつくる
        </Link>
      </div>

      <BlockDetailSheet open={!!selected} onClose={() => setSelectedId(null)} block={selected} day={day} ctx={ctx} mode="view" marginMin={itinerary.settings.marginMin} />
    </div>
  );
}

export default function SharePage() {
  return (
    <Suspense fallback={<p className="py-16 text-center text-sm text-slate-500">読み込み中…</p>}>
      <SharedView />
    </Suspense>
  );
}
