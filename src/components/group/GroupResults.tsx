"use client";

import { useEffect, useMemo, useState } from "react";
import { generate } from "@/generator";
import {
  aggregatePreferences,
  buildGroupPlans,
  PLAN_KINDS,
  tallyVotes,
  type DecidedBy,
  type GroupAggregate,
  type GroupPlan,
  type GroupPlanKind,
  type GroupPlanSet,
  type GroupState,
} from "@/core/group";
import type { PlanningContext } from "@/core/types";
import { Button, cx } from "../ui";
import { Avatar, memberIndex } from "./Avatar";
import { PlanCard } from "./PlanCard";

const KIND_TITLE: Record<GroupPlanKind, string> = { balanced: "バランス案", "max-sum": "合計いちばん案", "least-travel": "移動いちばん少ない案" };
const HOW: Record<DecidedBy, string> = {
  majority: "いちばん票が多かった案です",
  "organizer-vote": "同票だったため、主催者の票で決まりました",
  "organizer-choice": "同票だったため、主催者が選びました",
};

interface Computed {
  agg: GroupAggregate;
  set: GroupPlanSet;
}

/** 集約の結果（調整ポイント）・3案・投票・確定 */
export function GroupResults({
  group,
  ctx,
  onVote,
  onClearVotes,
  onConfirm,
  onBack,
}: {
  group: GroupState;
  ctx: PlanningContext;
  onVote: (memberId: string, kind: GroupPlanKind) => void;
  onClearVotes: () => void;
  onConfirm: (plan: GroupPlan, decidedBy: DecidedBy) => void;
  onBack: () => void;
}) {
  const [computed, setComputed] = useState<Computed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voter, setVoter] = useState<string | null>(null);
  const [organizerChoice, setOrganizerChoice] = useState<GroupPlanKind | null>(null);

  const answeredMembers = useMemo(() => group.members.filter((m) => group.inputs[m.id]), [group]);
  const key = JSON.stringify([group.members, group.candidateDates, group.inputs]);

  useEffect(() => {
    setComputed(null);
    setError(null);
    // 画面を先に描画してから計算する（数百ミリ秒かかる）
    const t = setTimeout(() => {
      try {
        const inputs = answeredMembers.map((m) => group.inputs[m.id]);
        const agg = aggregatePreferences({ members: group.members, inputs, candidateDates: group.candidateDates, ctx });
        const set = buildGroupPlans({ members: answeredMembers, inputs, agg, ctx, generate });
        setComputed({ agg, set });
      } catch (e) {
        setError(e instanceof Error ? e.message : "案を作れませんでした");
      }
    }, 20);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ctx]);

  const voterIds = answeredMembers.map((m) => m.id);
  const tally = useMemo(() => tallyVotes(group.votes, voterIds, group.organizerId), [group.votes, group.organizerId, voterIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="space-y-3">
        <p className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900" role="alert" data-testid="group-plan-error">{error}</p>
        <Button variant="secondary" onClick={onBack}>回答に戻る</Button>
      </div>
    );
  }
  if (!computed) {
    return <p className="py-10 text-center text-sm text-slate-500" data-testid="group-computing">3つの案を作っています…</p>;
  }

  const { agg, set } = computed;
  const winnerKind = tally.winner ?? organizerChoice;
  const winnerPlan = set.plans.find((p) => p.kind === winnerKind);
  const decidedBy: DecidedBy | null = tally.winner ? tally.decidedBy : organizerChoice ? "organizer-choice" : null;
  const organizer = group.members.find((m) => m.id === group.organizerId)!;
  const notVoted = answeredMembers.filter((m) => !group.votes[m.id]);

  return (
    <div className="space-y-4" data-testid="group-results">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-[15px] font-bold text-slate-900">調整したポイント</h2>
        <p className="mb-2 text-xs text-slate-500">みんなの希望をまとめるために、合わせたところです（個人の予算額や苦手は出していません）。</p>
        <ul className="space-y-1.5 text-sm text-slate-800" data-testid="group-adjustments">
          {agg.adjustments.map((a, i) => (
            <li key={i} className="flex gap-2" data-kind={a.kind}>
              <span aria-hidden className="mt-0.5 text-brand-600">●</span>
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      </section>

      {set.split && (
        <p className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm font-semibold leading-relaxed text-rose-900" role="alert" data-testid="group-split">
          希望が大きく割れています。どの案でも、満足度が 40 を下回る人がいます。投票の前に、何を譲れるか話し合うか、候補日・行きたい場所を見直してみてください。
        </p>
      )}

      <div className="space-y-3">
        {set.plans.map((p) => (
          <PlanCard key={p.kind} plan={p} members={answeredMembers} ctx={ctx} voteCount={tally.complete ? tally.counts[p.kind] : undefined} />
        ))}
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="group-vote">
        <h2 className="text-[15px] font-bold text-slate-900">投票（1台を回して、1人1票）</h2>
        <p className="text-xs text-slate-500">全員が投票するまで、結果は見えません。同票のときは主催者（{organizer.name}さん）が決めます。</p>
        <p className="mt-2 text-sm font-bold text-brand-700" data-testid="vote-progress">
          {tally.voted}/{tally.total}人が投票
        </p>

        {!tally.complete && (
          <div className="mt-2 space-y-2">
            {voter === null ? (
              <>
                <p className="text-xs font-semibold text-slate-600">投票する人を選んでください</p>
                <div className="flex flex-wrap gap-2">
                  {notVoted.map((m) => (
                    <Button key={m.id} variant="secondary" size="sm" data-testid={`vote-as-${m.id}`} onClick={() => setVoter(m.id)}>
                      <Avatar member={m} index={memberIndex(group.members, m.id)} size="sm" /> {m.name}
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="text-xs font-semibold text-slate-600">{group.members.find((m) => m.id === voter)?.name}さん、投票する案を選んでください</p>
                <div className="grid gap-2">
                  {PLAN_KINDS.map((k) => (
                    <Button
                      key={k}
                      variant="secondary"
                      data-testid={`vote-pick-${k}`}
                      onClick={() => {
                        onVote(voter, k);
                        setVoter(null);
                      }}
                    >
                      {KIND_TITLE[k]}に投票
                    </Button>
                  ))}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setVoter(null)}>やめる</Button>
              </>
            )}
          </div>
        )}

        {tally.complete && (
          <div className="mt-3 space-y-2" data-testid="vote-result">
            {tally.needsOrganizerChoice && !organizerChoice ? (
              <>
                <p className="text-sm font-semibold text-slate-800">同票でした。主催者の{organizer.name}さんが、同票の案から選んでください。</p>
                <div className="grid gap-2">
                  {tally.needsOrganizerChoice.map((k) => (
                    <Button key={k} variant="secondary" data-testid={`organizer-choice-${k}`} onClick={() => setOrganizerChoice(k)}>
                      {KIND_TITLE[k]}にする
                    </Button>
                  ))}
                </div>
              </>
            ) : winnerPlan && decidedBy ? (
              <>
                <p className="rounded-xl bg-emerald-50 p-3 text-sm font-bold text-emerald-900" data-testid="vote-winner" data-kind={winnerPlan.kind}>
                  「{winnerPlan.title}」に決まりました（{HOW[decidedBy]}）
                </p>
                <Button size="lg" className="w-full" data-testid="confirm-plan" onClick={() => onConfirm(winnerPlan, decidedBy)}>
                  この案で旅程を確定する
                </Button>
              </>
            ) : null}
          </div>
        )}

        {tally.voted > 0 && (
          <Button variant="ghost" size="sm" className={cx("mt-2 text-rose-700")} data-testid="vote-reset" onClick={() => { setOrganizerChoice(null); setVoter(null); onClearVotes(); }}>
            投票をやり直す
          </Button>
        )}
      </section>

      <Button variant="secondary" className="w-full" onClick={onBack} data-testid="group-back-to-answers">
        回答の一覧に戻る
      </Button>
    </div>
  );
}
