"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { adapters } from "@/adapters";
import { BlockDetailSheet } from "@/components/BlockDetailSheet";
import { ClosureBanner, RainBanner, SkipBanner } from "@/components/Banners";
import { DiffPanel } from "@/components/DiffPanel";
import { NextActionCard } from "@/components/NextActionCard";
import { ShareDialog } from "@/components/ShareDialog";
import { SIM_MIN, SimulationPanel } from "@/components/SimulationPanel";
import { Timeline } from "@/components/Timeline";
import { Button, cx, useToast } from "@/components/ui";
import {
  applyDelay,
  keepBlock,
  markSpotClosed,
  replaceBlockSpot,
  skipAllCandidates,
  skipBlocks,
  suggestReplacement,
  switchBlock,
  switchBlocks,
} from "@/core/actions";
import { diffItineraries, type ChangeSet } from "@/core/diff";
import { formatDateJa, formatHHMM } from "@/core/time";
import { getNextAction } from "@/core/today";
import type { Itinerary } from "@/core/types";
import { detectRainImpact, type HourlyWeather, type RainOverride } from "@/core/weather";
import { useTrip, type TodayState } from "@/store/tripStore";
import { usePlanningContext } from "@/store/usePlanningContext";

/** その日の最初の予定の40分前を、シミュレーションの初期の現在時刻にする */
function initialNow(itin: Itinerary, dayIndex: number): number {
  const day = itin.days[dayIndex];
  const first = day.blocks.find((b) => b.spotId) ?? day.blocks[0];
  return Math.max(SIM_MIN, Math.floor(((first?.startMin ?? day.startMin) - 40) / 5) * 5);
}

function initToday(itin: Itinerary, dayIndex = 0): TodayState {
  return { itinerary: structuredClone(itin), dayIndex, nowMin: initialNow(itin, dayIndex), history: [] };
}

export default function TodayPage() {
  const ctx = usePlanningContext();
  const { ready, trip, update } = useTrip();
  const today = trip.today;
  const [weather, setWeather] = useState<HourlyWeather[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const toast = useToast();

  // 当日モードの作業コピーを、もとの旅程から作る
  useEffect(() => {
    if (ready && trip.itinerary && !trip.today) {
      update((t) => (t.itinerary && !t.today ? { ...t, today: initToday(t.itinerary) } : t));
    }
  }, [ready, trip.itinerary, trip.today, update]);

  const day = today?.itinerary.days[today.dayIndex];
  const dayDate = day?.date;
  const origin = day?.origin;

  // 天気は adapter（今はモック）から取得する。雨の降り出しはデモ操作で上書きする
  useEffect(() => {
    if (!dayDate || !origin) return;
    let alive = true;
    adapters.weather.getHourlyForecast(dayDate, origin).then((w) => alive && setWeather(w));
    return () => {
      alive = false;
    };
  }, [dayDate, origin]);

  const nowMin = today?.nowMin ?? 0;
  const dayIndex = today?.dayIndex ?? 0;
  const itin = today?.itinerary;

  const impact = useMemo(
    () =>
      day && ctx && today?.rain && itin
        ? detectRainImpact(day, ctx, weather, nowMin, itin.prefs.rainTolerance, today.rain)
        : { switchable: [], noPlanB: [] },
    [day, ctx, today?.rain, weather, nowMin, itin],
  );

  const closedBlocks = useMemo(() => (day ? day.blocks.filter((b) => b.closed && b.skip !== "skipped" && b.endMin > nowMin) : []), [day, nowMin]);
  const suggestions = useMemo(
    () => (ctx && itin ? new Map(closedBlocks.map((b) => [b.id, suggestReplacement(itin, b.id, ctx)])) : new Map()),
    [closedBlocks, ctx, itin],
  );
  const candidates = useMemo(() => (day ? day.blocks.filter((b) => b.skip === "candidate" && b.startMin > nowMin) : []), [day, nowMin]);

  if (!ready || !ctx) return <p className="py-16 text-center text-sm text-slate-500">読み込み中…</p>;

  if (!trip.itinerary) {
    return (
      <div className="px-4 py-16 text-center">
        <p className="text-4xl">⏱️</p>
        <p className="mt-3 text-base font-bold text-slate-800">先に旅程をつくりましょう</p>
        <p className="mt-1 text-sm text-slate-500">当日モードは、作った旅程に対して雨や遅延を試せます。</p>
        <Link href="/" className="mt-5 inline-flex min-h-12 items-center rounded-xl bg-brand-600 px-6 font-semibold text-white">
          旅程をつくる
        </Link>
      </div>
    );
  }
  if (!today || !day || !itin) return <p className="py-16 text-center text-sm text-slate-500">準備中…</p>;

  /* ---------- 操作 ---------- */

  /** 旅程に変更を加え、前後の差分を履歴に残す */
  const act = (title: string, fn: (it: Itinerary) => Itinerary, doneMessage?: string) => {
    const before = today.itinerary;
    const after = fn(before);
    const items = diffItineraries(before, after);
    update((t) => {
      if (!t.today) return t;
      const history: ChangeSet[] = items.length
        ? [{ id: `${Date.now()}-${t.today.history.length}`, atMin: t.today.nowMin, title, items }, ...t.today.history].slice(0, 20)
        : t.today.history;
      return { ...t, today: { ...t.today, itinerary: after, history } };
    });
    toast.show(items.length ? (doneMessage ?? "旅程を立て直しました") : "旅程への影響はありませんでした");
  };

  const setNow = (min: number) => update((t) => (t.today ? { ...t, today: { ...t.today, nowMin: min } } : t));
  const spotName = (id?: string) => (id ? ctx.spotById.get(id)?.name : undefined) ?? "予定";

  const switchOne = (blockId: string) => {
    const b = day.blocks.find((x) => x.id === blockId);
    const alt = b?.planB ? spotName(b.planB.spotId) : "";
    act(
      `「${spotName(b?.spotId)}」→ ${b?.switched ? "元の予定に戻す" : `Plan B「${alt}」に切り替え`}`,
      (it) => switchBlock(it, blockId, ctx, { nowMin }),
      b?.switched ? "元の予定に戻しました" : "Plan B に切り替えました",
    );
  };

  const switchAll = () => {
    const ids = impact.switchable.map((b) => b.id);
    act(`雨 → 残りの屋外予定 ${ids.length}件を Plan B に切り替え`, (it) => switchBlocks(it, ids, ctx, { nowMin }), `${ids.length}件を Plan B に切り替えました`);
  };

  const rainKey = today.rain ? `${today.rain.prob}@${today.rain.startMin}` : null;
  const rainAffected = impact.switchable.length + impact.noPlanB.length;
  const showRainBanner = !!today.rain && rainKey !== today.rainDismissed && rainAffected > 0;
  const tolerance = itin.prefs.rainTolerance;

  const action = getNextAction(day, ctx, nowMin);
  const latest = today.history[0];
  const changes = new Map((latest?.items ?? []).filter((i) => i.dayIndex === dayIndex).map((i) => [i.blockId, i]));
  const closable = day.blocks.filter((b) => b.spotId && !b.closed && b.skip !== "skipped" && b.endMin > nowMin);
  const selected = selectedId ? (day.blocks.find((b) => b.id === selectedId) ?? null) : null;

  return (
    <div className="px-4 pb-48 pt-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-extrabold text-slate-900">当日モード</h1>
          <p className="text-xs text-slate-500">
            {formatDateJa(day.date)} ／ 現在時刻は<strong>デモ用に操作</strong>できます
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)} data-testid="today-share">
          🔗 共有
        </Button>
      </div>

      {itin.days.length > 1 && (
        <div className="mb-3 grid grid-cols-2 gap-2" role="tablist" aria-label="日付">
          {itin.days.map((d) => (
            <button
              key={d.index}
              role="tab"
              aria-selected={d.index === dayIndex}
              onClick={() =>
                update((t) => (t.today ? { ...t, today: { ...t.today, dayIndex: d.index, nowMin: initialNow(t.today.itinerary, d.index), rain: undefined } } : t))
              }
              className={cx("min-h-10 rounded-xl border text-sm font-bold", d.index === dayIndex ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700")}
            >
              {d.index + 1}日目
            </button>
          ))}
        </div>
      )}

      <NextActionCard action={action} nowMin={nowMin} />

      <div className="mt-3 space-y-3">
        {showRainBanner && today.rain && (
          <RainBanner
            impact={impact}
            rain={today.rain}
            ctx={ctx}
            onSwitchOne={() => impact.switchable[0] && switchOne(impact.switchable[0].id)}
            onSwitchAll={switchAll}
            onDismiss={() => update((t) => (t.today ? { ...t, today: { ...t.today, rainDismissed: rainKey ?? undefined } } : t))}
          />
        )}
        {today.rain && tolerance === "dont-care" && (
          <p className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs leading-relaxed text-sky-900" data-testid="rain-info">
            ☔ 雨の予報が出ていますが、雨への許容度が「気にしない」のため自動の切り替え提案はしていません。予定をタップすると Plan B に手動で切り替えられます。
          </p>
        )}
        {today.rain && tolerance !== "dont-care" && rainAffected === 0 && (
          <p className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs leading-relaxed text-sky-900" data-testid="rain-info">
            ☔ 降水確率 {today.rain.prob}%（{formatHHMM(today.rain.startMin)}〜）。{tolerance === "light-rain-ok" && today.rain.prob < 60 ? "「小雨ならOK」の基準（60%）に達していないため、" : ""}
            切り替えが必要な屋外の予定はありません。
          </p>
        )}
        {closedBlocks.map((b) => (
          <ClosureBanner
            key={b.id}
            block={b}
            ctx={ctx}
            suggestion={suggestions.get(b.id) ?? null}
            onReplace={() => {
              const s = suggestions.get(b.id);
              if (s) act(`「${spotName(b.spotId)}」臨時休業 → 「${s.spot.name}」に切り替え`, (it) => replaceBlockSpot(it, b.id, s.spot.id, ctx, { nowMin }), "代わりの予定に切り替えました");
            }}
            onSkip={() => act(`「${spotName(b.spotId)}」臨時休業 → スキップ`, (it) => skipBlocks(it, dayIndex, [b.id], nowMin, ctx), "スキップしました")}
          />
        ))}
        {candidates.length > 0 && (
          <SkipBanner
            blocks={candidates}
            ctx={ctx}
            onSkipAll={() => act(`スキップ候補 ${candidates.length}件をスキップ`, (it) => skipAllCandidates(it, dayIndex, nowMin, ctx), "スキップして立て直しました")}
            onKeep={(id) => act(`「${spotName(day.blocks.find((b) => b.id === id)?.spotId)}」は、それでも行く`, (it) => keepBlock(it, dayIndex, id, nowMin, ctx))}
          />
        )}
        <DiffPanel history={today.history} ctx={ctx} />
      </div>

      <h2 className="mb-2 mt-5 text-sm font-bold text-slate-700">今日のタイムライン</h2>
      <Timeline day={day} ctx={ctx} onOpen={setSelectedId} nowMin={nowMin} changes={changes} />

      <BlockDetailSheet
        open={!!selected}
        onClose={() => setSelectedId(null)}
        block={selected}
        day={day}
        ctx={ctx}
        mode="live"
        nowMin={nowMin}
        onSwitch={(id) => {
          switchOne(id);
          setSelectedId(null);
        }}
        onSkip={(id) => {
          act(`「${spotName(day.blocks.find((b) => b.id === id)?.spotId)}」をスキップ`, (it) => skipBlocks(it, dayIndex, [id], nowMin, ctx), "スキップしました");
          setSelectedId(null);
        }}
        onKeep={(id) => {
          act(`「${spotName(day.blocks.find((b) => b.id === id)?.spotId)}」は、それでも行く`, (it) => keepBlock(it, dayIndex, id, nowMin, ctx));
          setSelectedId(null);
        }}
      />

      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} itinerary={itin} title="現在の旅程を共有" />

      <SimulationPanel
        nowMin={nowMin}
        onNowChange={setNow}
        rain={today.rain}
        onRain={(rain: RainOverride) => {
          update((t) => (t.today ? { ...t, today: { ...t.today, rain, rainDismissed: undefined } } : t));
          toast.show(`☔ ${formatHHMM(rain.startMin)}から降水確率${rain.prob}%の雨を想定しました`);
        }}
        onStopRain={() => update((t) => (t.today ? { ...t, today: { ...t.today, rain: undefined, rainDismissed: undefined } } : t))}
        onDelay={(m) => act(`電車が${m}分遅延`, (it) => applyDelay(it, dayIndex, m, nowMin, ctx), `遅延${m}分を反映して、後ろの予定を計算し直しました`)}
        closable={closable}
        ctx={ctx}
        onClose={(spotId) => act(`「${spotName(spotId)}」が臨時休業`, (it) => markSpotClosed(it, spotId, dayIndex, nowMin, ctx), "臨時休業を反映しました")}
        onReset={() => {
          update((t) => (t.itinerary ? { ...t, today: initToday(t.itinerary, today.dayIndex) } : t));
          toast.show("デモをリセットしました");
        }}
      />
      {toast.node}
    </div>
  );
}
