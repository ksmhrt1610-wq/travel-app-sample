"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BlockDetailSheet } from "@/components/BlockDetailSheet";
import { FixedTimesPanel, MembersCard } from "@/components/FixedTimesPanel";
import { ProposalCard } from "@/components/ProposalCard";
import { ShareDialog } from "@/components/ShareDialog";
import { Timeline } from "@/components/Timeline";
import { Button, Chip, cx, LABEL_STYLE, Sheet, useToast } from "@/components/ui";
import { canReorder, reorderBlocks } from "@/core/actions";
import { absenceByBlock, memberFixedStatuses } from "@/core/fixed";
import {
  BLOCK_LABEL,
  BUDGET_LABEL,
  COMPANIONS_LABEL,
  DURATION_LABEL,
  PACE_LABEL,
  RAIN_LABEL,
} from "@/core/labels";
import { needsPlanB } from "@/core/planb";
import { planBWarnings } from "@/core/planner";
import { describeEvent, isQuietChange, replan, type ReplanEvent, type ReplanResult } from "@/core/replan";
import { formatDateJa } from "@/core/time";
import type { BlockLabel, Itinerary, Member } from "@/core/types";
import { useTrip } from "@/store/tripStore";
import { usePlanningContext } from "@/store/usePlanningContext";

interface Proposal {
  event: ReplanEvent;
  title: string;
  result: ReplanResult;
  removeMustIds: string[];
}

export default function ItineraryPage() {
  const ctx = usePlanningContext();
  const { ready, trip, update } = useTrip();
  const itinerary = trip.itinerary;
  const [dayIdx, setDayIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const toast = useToast();

  const day = itinerary?.days[Math.min(dayIdx, (itinerary?.days.length ?? 1) - 1)];

  const stats = useMemo(() => {
    if (!itinerary || !ctx) return null;
    const blocks = itinerary.days.flatMap((d) => d.blocks);
    const outdoor = blocks.filter((b) => needsPlanB(b, ctx));
    return {
      spots: blocks.filter((b) => b.spotId && !b.fixed).length,
      outdoor: outdoor.length,
      covered: outdoor.filter((b) => b.planB).length,
    };
  }, [itinerary, ctx]);

  if (!ready || !ctx) return <p className="py-16 text-center text-sm text-slate-500">読み込み中…</p>;

  if (!itinerary || !day || !stats) {
    return (
      <div className="px-4 py-16 text-center">
        <p className="text-4xl">🧭</p>
        <p className="mt-3 text-base font-bold text-slate-800">まだ旅程がありません</p>
        <p className="mt-1 text-sm text-slate-500">6つの質問に答えると、Plan B つきの旅程を作ります。</p>
        <Link href="/" className="mt-5 inline-flex min-h-12 items-center rounded-xl bg-brand-600 px-6 font-semibold text-white" data-testid="go-create">
          旅程をつくる
        </Link>
      </div>
    );
  }

  const commit = (next: Itinerary, message?: string) => {
    // 旅程を編集したら、当日モードの作業コピーは作り直す
    update((t) => ({ ...t, itinerary: next, today: undefined }));
    if (message) toast.show(message);
  };

  /** 再計画エンジンの提案を作る。確定するまで旅程は変わらない */
  const propose = (event: ReplanEvent, removeMustIds: string[] = []) => {
    const result = replan(itinerary, event, ctx, { dayIndex: day.index, removeMustIds });
    const title = describeEvent(event, ctx, itinerary);
    if (isQuietChange(result)) {
      commit(result.after, "反映しました");
      return;
    }
    setProposal({ event, title, result, removeMustIds });
  };

  const handleReorder = (from: number, to: number) => {
    commit(reorderBlocks(itinerary, day.index, from, to, ctx), "並べ替えて、時刻を計算し直しました");
  };

  const move = (id: string, dir: -1 | 1) => {
    const from = day.blocks.findIndex((b) => b.id === id);
    const to = from + dir;
    const check = canReorder(day, from, to);
    if (!check.ok) {
      if (check.reason) toast.show(check.reason);
      return;
    }
    handleReorder(from, to);
  };

  const changeMembers = (members: Member[]) => {
    const ids = new Set(members.map((m) => m.id));
    commit({
      ...itinerary,
      members,
      days: itinerary.days.map((d) => ({
        ...d,
        memberFixed: d.memberFixed?.map((f) => ({ ...f, memberIds: f.memberIds?.filter((id) => ids.has(id)) ?? null })).filter((f) => !f.memberIds || f.memberIds.length > 0),
      })),
    });
  };

  const selected = selectedId ? day.blocks.find((b) => b.id === selectedId) ?? null : null;
  const warnings = [...day.warnings, ...planBWarnings(day, ctx)];
  const p = itinerary.prefs;
  const margin = itinerary.settings.marginMin;
  const absence = absenceByBlock(memberFixedStatuses(day, ctx, margin, itinerary.members));
  const labelCounts = (["fixed", "must", "normal", "optional", "rest", "buffer"] as BlockLabel[]).map((l) => ({
    label: l,
    n: day.blocks.filter((b) => b.label === l).length,
  }));

  return (
    <div className="px-4 pb-6 pt-4">
      <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-brand-700">{DURATION_LABEL[p.duration]}の福岡旅行</p>
            <h1 className="text-lg font-extrabold text-slate-900" data-testid="itinerary-title">
              {formatDateJa(itinerary.startDate)}
              {itinerary.days.length > 1 && ` 〜 ${formatDateJa(itinerary.days[itinerary.days.length - 1].date)}`}
            </h1>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)} data-testid="share-button">
            🔗 共有
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold text-slate-600">
          {[COMPANIONS_LABEL[p.companions], BUDGET_LABEL[p.budget], PACE_LABEL[p.pace], `雨：${RAIN_LABEL[p.rainTolerance]}`].map((t, i) => (
            <span key={`${i}-${t}`} className="rounded-full bg-slate-100 px-2 py-0.5">
              {t}
            </span>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 p-2">
            <div className="text-lg font-extrabold text-slate-900">{stats.spots}</div>
            <div className="text-[11px] text-slate-500">スポット</div>
          </div>
          <div className="rounded-xl bg-slate-50 p-2">
            <div className="text-lg font-extrabold text-slate-900">{stats.outdoor}</div>
            <div className="text-[11px] text-slate-500">屋外・半屋外</div>
          </div>
          <div className={cx("rounded-xl p-2", stats.covered === stats.outdoor ? "bg-emerald-50" : "bg-amber-50")} data-testid="planb-coverage">
            <div className={cx("text-lg font-extrabold", stats.covered === stats.outdoor ? "text-emerald-700" : "text-amber-700")}>
              {stats.covered}/{stats.outdoor}
            </div>
            <div className="text-[11px] text-slate-500">Plan B あり</div>
          </div>
        </div>
      </section>

      {itinerary.days.length > 1 && (
        <div className="mt-3 grid grid-cols-2 gap-2" role="tablist" aria-label="日付">
          {itinerary.days.map((d) => (
            <button
              key={d.index}
              role="tab"
              aria-selected={d.index === day.index}
              data-testid={`day-tab-${d.index + 1}`}
              onClick={() => setDayIdx(d.index)}
              className={cx(
                "min-h-11 rounded-xl border text-sm font-bold",
                d.index === day.index ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700",
              )}
            >
              {d.index + 1}日目 <span className="text-xs font-medium opacity-80">{formatDateJa(d.date)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 space-y-3">
        <MembersCard members={itinerary.members} onChange={changeMembers} />
        <FixedTimesPanel itinerary={itinerary} ctx={ctx} dayIndex={day.index} onPropose={(e) => propose(e)} />
      </div>

      {warnings.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-2xl border border-amber-300 bg-amber-50 p-3" role="alert" data-testid="warnings">
          {warnings.map((w) => (
            <p key={w} className="text-[13px] font-semibold leading-snug text-amber-900">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      <div className="mb-3 mt-4 flex flex-wrap items-center gap-1.5">
        {labelCounts
          .filter((l) => l.n > 0)
          .map((l) => (
            <Chip key={l.label} className={LABEL_STYLE[l.label].chip}>
              {BLOCK_LABEL[l.label]} {l.n}
            </Chip>
          ))}
        <span className="ml-auto text-[11px] text-slate-500">右端の ⠿ をドラッグで並べ替え（🔒は動かせません）</span>
      </div>

      <Timeline day={day} ctx={ctx} onOpen={setSelectedId} onReorder={handleReorder} onBlocked={(r) => toast.show(r)} members={itinerary.members} marginMin={margin} />

      <div className="mt-4 grid gap-2">
        <Link
          href="/today"
          data-testid="go-today"
          className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-base font-semibold text-white hover:bg-slate-800"
        >
          ⏱️ 当日モードを試す（雨・遅延・疲れたのシミュレーション）
        </Link>
        <Link href="/" className="text-center text-sm font-semibold text-brand-700 underline">
          条件を変えてつくり直す
        </Link>
      </div>

      <BlockDetailSheet
        open={!!selected}
        onClose={() => setSelectedId(null)}
        block={selected}
        day={day}
        ctx={ctx}
        mode="edit"
        marginMin={margin}
        absent={selected ? absence.get(selected.id) : undefined}
        onSwitch={(id) => {
          setSelectedId(null);
          propose({ type: "plan-b", blockIds: [id] });
        }}
        onRemoveFixed={(id) => {
          setSelectedId(null);
          propose({ type: "fixed-remove", fixedId: id });
        }}
        onMove={move}
      />

      <Sheet open={!!proposal} onClose={() => setProposal(null)} title="組み直し案" testId="proposal-sheet">
        {proposal && (
          <ProposalCard
            result={proposal.result}
            ctx={ctx}
            title={proposal.title}
            onConfirm={() => {
              commit(proposal.result.after, "確定して、旅程に反映しました");
              setProposal(null);
            }}
            onCancel={() => setProposal(null)}
            onRemoveMust={(blockId) => propose(proposal.event, [...proposal.removeMustIds, blockId])}
          />
        )}
      </Sheet>

      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} itinerary={itinerary} />
      {toast.node}
    </div>
  );
}
