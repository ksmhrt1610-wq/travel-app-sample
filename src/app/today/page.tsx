"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { adapters } from "@/adapters";
import { BlockDetailSheet } from "@/components/BlockDetailSheet";
import { AttentionBadges, ClosureBanner, DepartureBanner, HeatBanner, RainBanner, WalkBanner, type AttentionBadge } from "@/components/Banners";
import { ModeSwitch } from "@/components/ModeSwitch";
import { DetourSheet, type DetourStop } from "@/components/DetourSheet";
import { DiffPanel } from "@/components/DiffPanel";
import { EarlyCard } from "@/components/EarlyCard";
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
import { currentBlock, currentLocation, nearbyOpenSpots } from "@/core/detour";
import { absenceByBlock, departureNotices, memberFixedStatuses, nextFixedCountdown } from "@/core/fixed";
import { commitResult, itineraryChanged, undoLast } from "@/core/history";
import { canAutoApply, classifyChange, decideApply, modeOf, type ChangeWeight, type Classification } from "@/core/policy";
import { describeEvent, replan, type ReplanEvent, type ReplanResult } from "@/core/replan";
import { earlyProgress, suggestForEarly, type Suggestion } from "@/core/suggest";
import { formatDateJa, formatHHMM } from "@/core/time";
import { getNextAction } from "@/core/today";
import type { Itinerary, ResponseMode } from "@/core/types";
import { dayWalking, suggestRestForWalking } from "@/core/walking";
import { detectHeatImpact, detectRainImpact, HEAT_RULES, RAIN_RULES, RAIN_STRENGTH, rainMm, type HeatOverride, type HourlyWeather, type RainOverride } from "@/core/weather";
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
  classification: Classification;
}

/**
 * おまかせモード: アプリが気づいた出来事のうち、軽い変更を自動で反映する（タップなし）。
 * 同じ出来事（キー）には1回しか反応しない。重い変更は自動では反映せず、通知バナーで確認を求める。
 */
function AutoResponder({ enabled, rainKey, rainTarget, heatKey, heatTarget, walkKey, onRain, onHeat, onWalk }: {
  enabled: boolean;
  rainKey: string | null;
  rainTarget: number;
  heatKey: string | null;
  heatTarget: number;
  walkKey: string | null;
  onRain: () => void;
  onHeat: () => void;
  onWalk: () => void;
}) {
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled || !rainKey || rainTarget === 0) return;
    const key = `rain:${rainKey}:${rainTarget}`;
    if (handled.current.has(key)) return;
    handled.current.add(key);
    onRain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, rainKey, rainTarget]);
  useEffect(() => {
    if (!enabled || !heatKey || heatTarget === 0) return;
    const key = `heat:${heatKey}:${heatTarget}`;
    if (handled.current.has(key)) return;
    handled.current.add(key);
    onHeat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, heatKey, heatTarget]);
  useEffect(() => {
    if (!enabled || !walkKey) return;
    if (handled.current.has(walkKey)) return;
    handled.current.add(walkKey);
    onWalk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, walkKey]);
  return null;
}

export default function TodayPage() {
  const ctx = usePlanningContext();
  const { ready, trip, update } = useTrip();
  const today = trip.today;
  const [weather, setWeather] = useState<HourlyWeather[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [tiredOpen, setTiredOpen] = useState(false);
  const [detourOpen, setDetourOpen] = useState(false);
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

  const heatImpact = useMemo(
    () => (day && ctx && today?.heat ? detectHeatImpact(day, ctx, weather, nowMin, today.heat) : { level: "none" as const, wbgt: 0, switchable: [], noPlanB: [] }),
    [day, ctx, today?.heat, weather, nowMin],
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

  const mode: ResponseMode = modeOf(itin);

  /**
   * イベントを再計画エンジンに渡す。変更の重さとモードで、そのまま反映するか、差分を見せて確定を求めるかが決まる。
   *   重い変更: 必ず差分→確定 / 軽い変更: 手動なら差分→確定、提案・おまかせならそのまま反映（元に戻すトースト付き）
   */
  const propose = (event: ReplanEvent, removeMustIds: string[] = []) => {
    const result = replan(today.itinerary, event, ctx, { dayIndex: today.dayIndex, nowMin: today.nowMin, removeMustIds });
    const title = describeEvent(event, ctx, today.itinerary);
    const classification = classifyChange(result, ctx);
    if (decideApply(mode, classification.weight, event) === "apply") {
      commit(result, title, { weight: classification.weight });
      return;
    }
    setProposal({ event, title, result, removeMustIds, classification });
  };

  const undo = () => {
    update((t) => (t.today ? { ...t, today: undoLast(t.today) } : t));
    setProposal(null);
    toast.show("元に戻しました");
  };

  const commit = (result: ReplanResult, title: string, meta: { weight?: ChangeWeight; auto?: boolean } = {}) => {
    update((t) => (t.today ? { ...t, today: commitResult(t.today, result, { atMin: t.today.nowMin, title, weight: meta.weight, auto: meta.auto }) } : t));
    const changed = itineraryChanged(result.before, result.after);
    const message = !changed
      ? "旅程への影響はありませんでした"
      : meta.auto
        ? `🤖 自動で反映しました：${title}`
        : meta.weight === "light"
          ? `反映しました：${title}`
          : "確定して、旅程に反映しました";
    toast.show(message, changed ? { action: { label: "元に戻す", onClick: undo } } : undefined);
    setProposal(null);
  };

  const confirm = () => proposal && commit(proposal.result, proposal.title, { weight: proposal.classification.weight });

  const setMode = (m: ResponseMode) => {
    setProposal(null);
    const withMode = (i: Itinerary): Itinerary => ({ ...i, settings: { ...i.settings, mode: m } });
    update((t) => ({
      ...t,
      itinerary: t.itinerary ? withMode(t.itinerary) : t.itinerary,
      today: t.today ? { ...t.today, itinerary: withMode(t.today.itinerary) } : t.today,
    }));
  };

  /** おまかせ: 雨で影響のある屋外の予定を、軽い変更なら自動で Plan B に切り替える */
  const autoRain = () => {
    if (!impact.switchable.length) return;
    const event: ReplanEvent = { type: "plan-b", blockIds: impact.switchable.map((b) => b.id), cause: "rain" };
    const result = replan(today.itinerary, event, ctx, { dayIndex: today.dayIndex, nowMin: today.nowMin });
    const classification = classifyChange(result, ctx);
    if (canAutoApply(mode, classification.weight)) commit(result, `雨のため、屋外の予定${impact.switchable.length}件を Plan B に切り替え`, { weight: "light", auto: true });
  };

  /** 暑さ対策の案: 屋外の予定を Plan B に替える（なければ、屋外の予定のあとに休憩を挟む） */
  const heatEvent = (): ReplanEvent | null =>
    heatImpact.switchable.length
      ? { type: "plan-b", blockIds: heatImpact.switchable.map((b) => b.id), cause: "heat" }
      : heatImpact.noPlanB.length
        ? { type: "heat-rest", blockIds: heatImpact.noPlanB.map((b) => b.id), minutes: HEAT_RULES.restMin }
        : null;

  /** おまかせ: 暑さで影響のある屋外の予定を、軽い変更なら自動で Plan B に切り替える */
  const autoHeat = () => {
    const event = heatEvent();
    if (!event) return;
    const result = replan(today.itinerary, event, ctx, { dayIndex: today.dayIndex, nowMin: today.nowMin });
    const classification = classifyChange(result, ctx);
    if (canAutoApply(mode, classification.weight)) commit(result, `暑さのため、${describeEvent(event, ctx, today.itinerary)}`, { weight: "light", auto: true });
  };

  /** 実績: 着いた・出発した（押した時刻が実績になる）。遅れは後ろをずらし、足りなければ規則どおり削減する */
  const recordProgress = (blockId: string, kind: "arrived" | "departed") => propose({ type: "progress", blockId, kind, atMin: today.nowMin });

  /** 早く進んだときの提案を選ぶ（提案のみ。選ぶと、新しい組み直しになる） */
  const applyEarly = (s: Suggestion) => {
    if (earlyDismissKey) dismiss(earlyDismissKey);
    propose(s.event);
  };

  /** おまかせ: 歩行距離が目安を超えそうなときの休憩を、軽い変更なら自動で入れる */
  const autoWalk = () => {
    if (!walkSuggest) return;
    dismiss(`walk:${walkSuggest.beforeBlockId}`);
    const event: ReplanEvent = { type: "tired", level: "light", source: "walk-limit" };
    const result = replan(today.itinerary, event, ctx, { dayIndex: today.dayIndex, nowMin: today.nowMin });
    const classification = classifyChange(result, ctx);
    if (canAutoApply(mode, classification.weight)) commit(result, describeEvent(event, ctx, today.itinerary), { weight: "light", auto: true });
  };

  /** 空きができたときの提案を選ぶ: いまの案を確定してから、その提案を新しい組み直し案にする */
  const applySuggestion = (s: Suggestion) => {
    if (!proposal) return;
    const base = proposal.result.after;
    commit(proposal.result, proposal.title, { weight: proposal.classification.weight });
    const result = replan(base, s.event, ctx, { dayIndex: today.dayIndex, nowMin: today.nowMin });
    setProposal({ event: s.event, title: describeEvent(s.event, ctx, base), result, removeMustIds: [], classification: classifyChange(result, ctx) });
  };

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
  const heatKey = today.heat ? `${today.heat.wbgt}@${today.heat.startMin}` : null;
  const heatAffected = heatImpact.switchable.length + heatImpact.noPlanB.length;
  const showHeatBanner = !!today.heat && heatKey !== today.heatDismissed && heatAffected > 0;
  const early = earlyProgress(day, ctx, nowMin);
  const earlyDismissKey = early ? `early:${early.anchorBlockId}` : null;
  const earlySuggestions = early && !(today.dismissed ?? []).includes(earlyDismissKey!) ? suggestForEarly(itin, ctx, { dayIndex, nowMin }) : [];
  const showEarly = !!early && !(today.dismissed ?? []).includes(earlyDismissKey!);
  const here = currentLocation(itin, ctx, dayIndex, nowMin);
  const detourCandidates = detourOpen ? nearbyOpenSpots(itin, ctx, { dayIndex, nowMin }) : [];
  const detourAfter = currentBlock(itin, dayIndex, nowMin);

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

  /** 手動モードでバナーの代わりに出すバッジ（タップすると、その対応の案を作る） */
  const badges: AttentionBadge[] = [
    ...(showRainBanner
      ? [
          {
            id: "rain",
            tone: "rain" as const,
            text: `☔ 雨の予報があります（屋外 ${rainAffected}件に影響）`,
            onClick: () => impact.switchable.length && propose({ type: "plan-b", blockIds: impact.switchable.map((b) => b.id), cause: "rain" }),
          },
        ]
      : []),
    ...(showHeatBanner
      ? [
          {
            id: "heat",
            tone: "heat" as const,
            text: `🥵 暑さに注意（WBGT ${heatImpact.wbgt}・屋外 ${heatAffected}件に影響）`,
            onClick: () => {
              const e = heatEvent();
              if (e) propose(e);
            },
          },
        ]
      : []),
    ...closedBlocks.map((b) => ({
      id: `closure:${b.id}`,
      tone: "closure" as const,
      text: `⛔ 「${spotName(b.spotId)}」が臨時休業`,
      onClick: () => {
        const s = suggestions.get(b.id);
        if (s) propose({ type: "closure", spotId: b.spotId!, replacementSpotId: s.spot.id });
        else propose({ type: "skip", blockIds: [b.id] });
      },
    })),
    ...(showWalk && walkSuggest && walkNext
      ? [
          {
            id: "walk",
            tone: "walk" as const,
            text: "🚶 歩行距離が目安を超えそうです（休憩の案を見る）",
            onClick: () => {
              dismiss(`walk:${walkSuggest.beforeBlockId}`);
              propose({ type: "tired", level: "light", source: "walk-limit" });
            },
          },
        ]
      : []),
    ...notices.map((n) => ({
      id: n.id,
      tone: "departure" as const,
      text: `⏰ ${n.level === "over" ? "出発すべき時刻を過ぎています" : n.level === "before10" ? "出発の10分前" : "出発の30分前"}（${formatHHMM(n.departBy)}までに ${n.title}）`,
      onClick: () => dismiss(n.id),
    })),
  ];

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

      <ModeSwitch mode={mode} onChange={setMode} />
      <AutoResponder
        enabled={mode === "auto"}
        rainKey={showRainBanner ? rainKey : null}
        rainTarget={impact.switchable.length}
        heatKey={showHeatBanner ? heatKey : null}
        heatTarget={heatAffected}
        walkKey={showWalk && walkSuggest ? `walk:${walkSuggest.beforeBlockId}` : null}
        onRain={autoRain}
        onHeat={autoHeat}
        onWalk={autoWalk}
      />

      <div className="mt-3" />
      <NextActionCard
        action={action}
        nowMin={nowMin}
        fixed={fixedCountdown}
        memberDepartures={memberDepartures}
        onArrived={() => action.arrivable && recordProgress(action.arrivable.id, "arrived")}
        onDeparted={() => action.departable && recordProgress(action.departable.id, "departed")}
      />

      <Button variant="secondary" size="lg" className="mt-3 w-full border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100" onClick={() => setTiredOpen(true)} data-testid="tired-button">
        😮‍💨 疲れた（休憩を入れる）
      </Button>

      <Button variant="secondary" size="lg" className="mt-2 w-full border-sky-300 bg-sky-50 text-sky-950 hover:bg-sky-100" onClick={() => setDetourOpen(true)} data-testid="detour-button">
        📍 ここに寄る（寄り道）
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
            onApplySuggestion={applySuggestion}
            classification={proposal.classification}
            mode={mode}
          />
        )}

        {mode === "manual" && <AttentionBadges items={badges} />}

        {mode !== "manual" &&
          notices.map((n) => (
            <DepartureBanner key={n.id} notice={n} onDismiss={() => dismiss(n.id)} />
          ))}

        {mode !== "manual" && showRainBanner && today.rain && (
          <RainBanner
            impact={impact}
            rain={today.rain}
            ctx={ctx}
            onSwitchOne={() => impact.switchable[0] && propose({ type: "plan-b", blockIds: [impact.switchable[0].id], cause: "rain" })}
            onSwitchAll={() => propose({ type: "plan-b", blockIds: impact.switchable.map((b) => b.id), cause: "rain" })}
            onDismiss={() => update((t) => (t.today ? { ...t, today: { ...t.today, rainDismissed: rainKey ?? undefined } } : t))}
          />
        )}
        {today.rain && rainAffected === 0 && (
          <p className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs leading-relaxed text-sky-900" data-testid="rain-info">
            ☔ {today.rain.strength ? RAIN_STRENGTH[today.rain.strength].label : "雨"}（降水確率 {today.rain.prob}%・{rainMm(today.rain)}mm/h、{formatHHMM(today.rain.startMin)}〜）。
            {tolerance === "dont-care"
              ? `雨への許容度が「気にしない」のため、強い雨（${RAIN_RULES["dont-care"].mmPerHour}mm/h以上）でなければ切り替えは提案しません。予定をタップすると Plan B に手動で切り替えられます。`
              : tolerance === "light-rain-ok"
                ? `「小雨ならOK」の基準（${RAIN_RULES["light-rain-ok"].mmPerHour}mm/h以上）に達していない、または切り替えが必要な屋外の予定がありません。`
                : "切り替えが必要な屋外の予定はありません。"}
          </p>
        )}
        {mode !== "manual" && showHeatBanner && today.heat && (
          <HeatBanner
            impact={heatImpact}
            heat={today.heat}
            ctx={ctx}
            onSwitchAll={() => propose({ type: "plan-b", blockIds: heatImpact.switchable.map((b) => b.id), cause: "heat" })}
            onRest={() => {
              const ids = [...heatImpact.switchable, ...heatImpact.noPlanB].map((b) => b.id);
              propose({ type: "heat-rest", blockIds: ids, minutes: HEAT_RULES.restMin });
            }}
            onDismiss={() => update((t) => (t.today ? { ...t, today: { ...t.today, heatDismissed: heatKey ?? undefined } } : t))}
          />
        )}
        {showEarly && early && <EarlyCard early={early} suggestions={earlySuggestions} onApply={applyEarly} onDismiss={() => dismiss(earlyDismissKey!)} />}
        {mode !== "manual" && closedBlocks.map((b) => (
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
        {mode !== "manual" && showWalk && walkSuggest && walkNext && (
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
        <DiffPanel history={today.history} ctx={ctx} itin={itin} onUndo={undo} />
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

      <DetourSheet
        open={detourOpen}
        onClose={() => setDetourOpen(false)}
        here={here}
        nowMin={nowMin}
        candidates={detourCandidates}
        onChoose={(stop: DetourStop) => {
          setDetourOpen(false);
          propose({ type: "detour", stop, afterBlockId: detourAfter?.id ?? null });
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
        heat={today.heat}
        onHeat={(heat: HeatOverride) => {
          update((t) => (t.today ? { ...t, today: { ...t.today, heat, heatDismissed: undefined } } : t));
          toast.show(`🥵 ${formatHHMM(heat.startMin)}から暑さ指数 ${heat.wbgt} を想定しました`);
        }}
        onStopHeat={() => update((t) => (t.today ? { ...t, today: { ...t.today, heat: undefined, heatDismissed: undefined } } : t))}
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
