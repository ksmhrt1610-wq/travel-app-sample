"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { GroupAnswers } from "@/components/group/GroupAnswers";
import { GroupResults } from "@/components/group/GroupResults";
import { GroupSetup } from "@/components/group/GroupSetup";
import { MemberForm } from "@/components/group/MemberForm";
import { Button } from "@/components/ui";
import { sampleGroup, type DecidedBy, type GroupPlan, type GroupPlanKind } from "@/core/group";
import { saveTrip } from "@/store/tripStore";
import { useGroup } from "@/store/groupStore";
import { usePlanningContext } from "@/store/usePlanningContext";

type View = { name: "answers" } | { name: "form"; memberId: string } | { name: "results" };

export default function GroupPage() {
  const router = useRouter();
  const ctx = usePlanningContext();
  const g = useGroup();
  const [view, setView] = useState<View>({ name: "answers" });
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const answeredCount = useMemo(() => (g.group ? g.group.members.filter((m) => g.group!.inputs[m.id]).length : 0), [g.group]);

  if (!g.ready || !ctx) return <p className="py-10 text-center text-sm text-slate-500">読み込み中…</p>;

  const confirm = async (plan: GroupPlan, decidedBy: DecidedBy) => {
    const group = g.group!;
    const now = new Date();
    const id = `trip-${now.getTime().toString(36)}`;
    const itinerary = { ...plan.itinerary, id, createdAt: now.toISOString(), members: group.members };
    const saved = saveTrip({ prefs: itinerary.prefs, itinerary });
    if (!saved.ok) {
      setConfirmError(`旅程を保存できませんでした（${saved.reason}）`);
      return;
    }
    await g.decide({ kind: plan.kind as GroupPlanKind, decidedBy, itineraryId: id });
    router.push("/itinerary");
  };

  return (
    <div className="px-4 pb-6 pt-4">
      <section className="mb-4 rounded-3xl bg-gradient-to-br from-emerald-600 to-teal-600 p-5 text-white shadow-md">
        <p className="text-xs font-semibold text-emerald-100">グループで計画</p>
        <h1 className="mt-1 text-xl font-extrabold leading-snug">みんなの希望を、ひとつの旅程に。</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-emerald-50">1台のスマホを回して希望を集め、3つの案から投票で決めます。</p>
      </section>

      {g.saveError && (
        <p className="mb-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900" role="alert" data-testid="group-save-error">
          {g.saveError}
          <button type="button" className="ml-2 underline" onClick={g.dismissSaveError}>閉じる</button>
        </p>
      )}
      {confirmError && <p className="mb-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900" role="alert">{confirmError}</p>}

      {g.issue && (
        <section className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" data-testid="group-load-issue">
          <p className="font-bold">保存されていたグループのデータを、読み込めませんでした</p>
          <p className="mt-1 text-xs">{g.issue}</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="secondary" size="sm" data-testid="group-issue-delete" onClick={() => g.reset()}>削除して始める</Button>
            <Button size="sm" data-testid="group-issue-backup" onClick={() => g.reset({ backup: true })}>バックアップに残して始める</Button>
          </div>
        </section>
      )}

      {!g.group && !g.issue && <GroupSetup
          onCreate={async (n) => {
            await g.create(n);
            setView({ name: "answers" });
          }}
          onSample={async () => {
            const { inputs, ...rest } = sampleGroup();
            await g.create(rest, inputs);
            setView({ name: "answers" });
          }}
          error={g.saveError}
        />}

      {g.group && view.name === "answers" && (
        <GroupAnswers
          group={g.group}
          onAnswer={(memberId) => setView({ name: "form", memberId })}
          onMakePlans={() => setView({ name: "results" })}
          onReset={() => {
            if (window.confirm("グループの回答と投票をすべて消して、最初からやり直します。よろしいですか？")) {
              g.reset();
              setView({ name: "answers" });
            }
          }}
        />
      )}

      {g.group && view.name === "form" && (
        <MemberForm
          memberName={g.group.members.find((m) => m.id === view.memberId)?.name ?? ""}
          candidateDates={g.group.candidateDates}
          spots={ctx.spots}
          initial={g.group.inputs[view.memberId]}
          onCancel={() => setView({ name: "answers" })}
          onSubmit={async (input) => {
            const ok = await g.submitInput({ ...input, memberId: view.memberId });
            if (ok) setView({ name: "answers" });
          }}
        />
      )}

      {g.group && view.name === "results" && answeredCount >= 2 && (
        <GroupResults
          group={g.group}
          ctx={ctx}
          onVote={(memberId, kind) => void g.vote(memberId, kind)}
          onClearVotes={() => void g.clearVotes()}
          onConfirm={confirm}
          onBack={() => setView({ name: "answers" })}
        />
      )}
    </div>
  );
}
