"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEMO_PREFERENCES, PreferenceForm } from "@/components/PreferenceForm";
import { generate } from "@/generator";
import { nextSaturday } from "@/core/time";
import type { Preferences } from "@/core/types";
import { saveTrip, useTrip } from "@/store/tripStore";
import { usePlanningContext } from "@/store/usePlanningContext";

export default function HomePage() {
  const router = useRouter();
  const ctx = usePlanningContext();
  const { ready, trip } = useTrip();
  const [submitting, setSubmitting] = useState(false);
  const [formKey, setFormKey] = useState(0);

  const handleSubmit = (prefs: Preferences) => {
    if (!ctx) return;
    setSubmitting(true);
    const now = new Date();
    const itinerary = generate({
      prefs,
      ctx,
      startDate: nextSaturday(now),
      id: `trip-${now.getTime().toString(36)}`,
      createdAt: now.toISOString(),
    });
    saveTrip({ prefs, itinerary });
    router.push("/itinerary");
  };

  return (
    <div className="px-4 pb-6 pt-4">
      <section className="mb-4 overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 to-indigo-600 p-5 text-white shadow-md">
        <p className="text-xs font-semibold text-blue-100">福岡市内・国内旅行のプロトタイプ</p>
        <h1 className="mt-1 text-xl font-extrabold leading-snug">崩れても、立て直せる旅程。</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-blue-50">
          旅程を作る時点で、屋外の予定ごとに<strong>屋内の Plan B</strong>を用意。当日に雨や遅延が起きたら通知して、ワンタップで切り替えます。
        </p>
      </section>

      <Link
        href="/group"
        data-testid="group-entry"
        className="mb-3 flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm hover:bg-emerald-100"
      >
        <span className="text-2xl" aria-hidden>👥</span>
        <span className="flex-1">
          <span className="block text-[15px] font-bold text-emerald-900">グループで計画する</span>
          <span className="block text-xs text-emerald-800">2〜6人の希望を集めて、3つの案から投票で決めます</span>
        </span>
        <span className="text-emerald-700" aria-hidden>›</span>
      </Link>

      {ready && ctx ? (
        <>
          <div className="mb-3 flex items-center justify-between rounded-xl border border-blue-200 bg-blue-50 px-3 py-2">
            <p className="text-xs leading-snug text-blue-900">
              デモ設定：<strong>友人・普通・グルメ&カフェ・ゆったり・小雨OK・日帰り</strong>
            </p>
            <button
              type="button"
              data-testid="apply-demo"
              onClick={() => setFormKey((k) => k + 1)}
              className="ml-2 shrink-0 rounded-lg bg-white px-2.5 py-1.5 text-xs font-bold text-brand-700 shadow-sm ring-1 ring-blue-200 hover:bg-blue-50"
            >
              この設定に戻す
            </button>
          </div>
          <PreferenceForm
            key={formKey}
            spots={ctx.spots}
            initial={formKey === 0 ? (trip.prefs ?? DEMO_PREFERENCES) : DEMO_PREFERENCES}
            submitting={submitting}
            onSubmit={handleSubmit}
          />
        </>
      ) : (
        <p className="py-10 text-center text-sm text-slate-500">読み込み中…</p>
      )}
    </div>
  );
}
