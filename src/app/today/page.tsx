"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { adapters } from "@/adapters";
import { BlockDetailSheet } from "@/components/BlockDetailSheet";
import { ClosureBanner, DepartureBanner, RainBanner, WalkBanner } from "@/components/Banners";
import { DiffPanel } from "@/components/DiffPanel";
import { FixedTimesPanel } from "@/components/FixedTimesPanel";
import { NextActionCard } from "@/components/NextActionCard";
import { ProposalCard } from "@/components/ProposalCard";
import { ShareDialog } from "@/components/ShareDialog";
import { SIM_MIN, SimulationPanel } from "@/components/SimulationPanel";
import { TiredSheet } from "@/components/TiredSheet";
import { Timeline } from "@/components/Timeline";
import { WalkMeter } from "@/components/WalkMeter";
import { Button, cx, useToast } from "@/components/ui";
import { suggestReplacement } from "@/core/actions";
import { absenceByBlock, departureNotices, memberFixedStatuses, nextFixedCountdown } from "@/core/fixed";
import { describeEvent, isQuietChange, replan, type ReplanEvent, type ReplanResult } from "@/core/replan";
import { formatDateJa, formatHHMM } from "@/core/time";
import { getNextAction } from "@/core/today";
import type { Itinerary } from "@/core/types";
import { dayWalking, suggestRestForWalking } from "@/core/walking";
import { detectRainImpact, type HourlyWeather, type RainOverride } from "@/core/weather";
import { useTrip, type TodayState } from "@/store/tripStore";
import { usePlanningContext } from "@/store/usePlanningContext";

/** その日の最初の予定の40分前を、シミュレーションの初期の現在時刻にする */
function initialNow(itin: Itinerary, dayIndex: number): number {
  const day = itin.days[dayIndex];
  const first = day.blocks.find((b) => b.spotId || b.fixed) ?? day.blocks[0];
  return Math.max(SIM_MIN, Math.floor(((first?.startMin ?? day.startMin) - 40) / 5) * 5);
}

function initToday(itin: Itinerary, dayIndex = 0): TodayState {
  return { itinerary: structuredClone(itin), dayIndex, nowMin: initialNow(itin, dayIndex), history: [], dismissed: [] };
}

interface Proposal {
  event: ReplanEvent;
  title: string;
  result: ReplanResult;
  removeMustIds: string[];
}

export default function TodayPage() {
  const ctx = usePlanningContext();
  const { ready, trip, update } = useTrip();
  const today = trip.today;
  const [weather, setWeather] = useState<HourlyWeather[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [tiredOpen, setTiredOpen] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
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
  const margin = itin?.settings.marginMin ?? 10;

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

  /* ---------- 再計画エンジンの提案と確定 ---------- */

  /** イベントを再計画エンジンに渡し、組み直し案を作る（確定するまで旅程は変わらない） */
  const propose = (event: ReplanEvent, removeMustIds: string[] = []) => {
    const result = replan(today.itinerary, event, ctx, { dayIndex: today.dayIndex, nowMin: today.nowMin, removeMustIds });
    const title = describeEvent(event, ctx, today.itinerary);
    if (isQuietChange(result)) {
      commit(result, title); // 余裕時間の変更・固定時刻を外すだけ: 確認なしで反映
      return;
    }
    setProposal({ event, title, result, removeMustIds });
  };

  const commit = (result: ReplanResult, title: string) => {
    update((t) => {
      if (!t.today) return t;
      const history = result.diff.length
        ? [{ id: `${Date.now()}-${t.today.history.length}`, atMin: t.today.nowMin, title, items: result.diff }, ...t.today.history].slice(0, 20)
        : t.today.history;
      return { ...t, today: { ...t.today, itinerary: result.after, history } };
    });
    toast.show(result.diff.length ? "確定して、旅程に反映しました" : "旅程への影響はありませんでした");
    setProposal(null);
  };

  const confirm = () => proposal && commit(proposal.result, proposal.title);

  const setNow = (min: number) => {
    setProposal(null);
    update((t) => (t.today ? { ...t, today: { ...t.today, nowMin: min } } : t));
  };
  const dismiss = (id: string) => update((t) => (t.today ? { ...t, today: { ...t.today, dismissed: [...(t.today.dismissed ?? []), id] } } : t));
  const spotName = (id?: string) => (id ? ctx.spotById.get(id)?.name : undefined) ?? "予定";

  /* ---------- 表示用の計算 ---------- */

  const rainKey = today.rain ? `${today.rain.prob}@${today.rain.startMin}` : null;
  const rainAffected = impact.switchable.length + impact.noPlanB.length;
  const showRainBanner = !!today.rain && rainKey !== today.rainDismissed && rainAffected > 0;
  const tolerance = itin.prefs.rainTolerance;

  const action = getNextAction(day, ctx, nowMin);
  const fixedCountdown = nextFixedCountdown(day, ctx, nowMin, margin);
  const statuses = memberFixedStatuses(day, ctx, margin, itin.members);
  const absence = absenceByBlock(statuses);
  const memberDepartures = statuses
    .filter((s) => s.event.timeMin > nowMin)
    .map((s) => ({ who: s.memberNames.join("・"), title: s.event.title, departBy: s.departBy, timeMin: s.event.timeMin }));
  const dismissed = today.dismissed ?? [];
  const notices = departureNotices(day, ctx, nowMin, margin, itin.members).filter((n) => !dismissed.includes(n.id));

  const walking = dayWalking(day, ctx, itin.prefs.pace, nowMin);
  const walkSuggest = suggestRestForWalking(day, ctx, itin.prefs.pace, nowMin);
  const showWalk = walkSuggest && !dismissed.includes(`walk:${walkSuggest.beforeBlockId}`);
  const walkNext = walkSuggest ? day.blocks.find((b) => b.id === walkSuggest.beforeBlockId) : undefined;

  const latest = today.history[0];
  const changes = new Map((latest?.items ?? []).filter((i) => i.dayIndex === dayIndex).map((i) => [i.blockId, i]));
  const closable = day.blocks.filter((b) => b.spotId && !b.fixed && !b.closed && b.skip !== "skipped" && b.endMin > nowMin);
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
              onClick={() => {
                setProposal(null);
                update((t) => (t.today ? { ...t, today: { ...t.today, dayIndex: d.index, nowMin: initialNow(t.today.itinerary, d.index), rain: undefined } } : t));
              }}
              className={cx("min-h-10 rounded-xl border text-sm font-bold", d.index === dayIndex ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700")}
            >
              {d.index + 1}日目
            </button>
          ))}
        </div>
      )}

      <NextActionCard action={action} nowMin={nowMin} fixed={fixedCountdown} memberDepartures={memberDepartures} />

      <Button variant="secondary" size="lg" className="mt-3 w-full border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100" onClick={() => setTiredOpen(true)} data-testid="tired-button">
        😮‍💨 疲れた（休憩を入れる）
      </Button>

      <div className="mt-3 space-y-3">
        {proposal && (
          <ProposalCard
            result={proposal.result}
            ctx={ctx}
            title={proposal.title}
            onConfirm={confirm}
            onCancel={() => setProposal(null)}
            onRemoveMust={(blockId) => propose(proposal.event, [...proposal.removeMustIds, blockId])}
          />
        )}

        {notices.map((n) => (
          <DepartureBanner key={n.id} notice={n} onDismiss={() => dismiss(n.id)} />
        ))}

        {showRainBanner && today.rain && (
          <RainBanner
            impact={impact}
            rain={today.rain}
            ctx={ctx}
            onSwitchOne={() => impact.switchable[0] && propose({ type: "plan-b", blockIds: [impact.switchable[0].id] })}
            onSwitchAll={() => propose({ type: "plan-b", blockIds: impact.switchable.map((b) => b.id) })}
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
              if (s) propose({ type: "closure", spotId: b.spotId!, replacementSpotId: s.spot.id });
            }}
            onSkip={() => propose({ type: "skip", blockIds: [b.id] })}
          />
        ))}
        {showWalk && walkSuggest && walkNext && (
          <WalkBanner
            suggestion={walkSuggest}
            nextName={walkNext.fixed ? walkNext.fixed.title : spotName(walkNext.spotId)}
            onAccept={() => {
              dismiss(`walk:${walkSuggest.beforeBlockId}`);
              propose({ type: "tired", level: "light", source: "walk-limit" });
            }}
            onDismiss={() => dismiss(`walk:${walkSuggest.beforeBlockId}`)}
          />
        )}

        <WalkMeter walking={walking} pace={itin.prefs.pace} />
        <FixedTimesPanel itinerary={itin} ctx={ctx} dayIndex={dayIndex} onPropose={(e) => propose(e)} />
        <DiffPanel history={today.history} ctx={ctx} itin={itin} />
      </div>

      <h2 className="mb-2 mt-5 text-sm font-bold text-slate-700">今日のタイムライン</h2>
      <Timeline day={day} ctx={ctx} onOpen={setSelectedId} nowMin={nowMin} changes={changes} members={itin.members} marginMin={margin} />

      <BlockDetailSheet
        open={!!selected}
        onClose={() => setSelectedId(null)}
        block={selected}
        day={day}
        ctx={ctx}
        mode="live"
        nowMin={nowMin}
        marginMin={margin}
        absent={selected ? absence.get(selected.id) : undefined}
        onSwitch={(id) => {
          propose({ type: "plan-b", blockIds: [id] });
          setSelectedId(null);
        }}
        onSkip={(id) => {
          propose({ type: "skip", blockIds: [id] });
          setSelectedId(null);
        }}
        onRestore={(id) => {
          propose({ type: "restore", blockId: id });
          setSelectedId(null);
        }}
        onRemoveFixed={(id) => {
          propose({ type: "fixed-remove", fixedId: id });
          setSelectedId(null);
        }}
      />

      <TiredSheet
        open={tiredOpen}
        onClose={() => setTiredOpen(false)}
        onChoose={(level) => {
          setTiredOpen(false);
          propose({ type: "tired", level });
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
        onDelay={(m) => propose({ type: "delay", minutes: m })}
        closable={closable}
        ctx={ctx}
        onClose={(spotId) => propose({ type: "closure", spotId })}
        onReset={() => {
          setProposal(null);
          update((t) => (t.itinerary ? { ...t, today: initToday(t.itinerary, today.dayIndex) } : t));
          toast.show("デモをリセットしました");
        }}
      />
      {toast.node}
    </div>
  );
}
