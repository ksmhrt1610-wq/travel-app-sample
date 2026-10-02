"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adapters } from "@/adapters";
import { GROUP_LIMITS, type GroupDecision, type GroupMember, type GroupPlanKind, type GroupState, type MemberInput } from "@/core/group";

export interface NewGroup {
  members: GroupMember[];
  organizerId: string;
  candidateDates: string[];
}

/** グループの状態。保存先は adapters.groups（GroupRepository）。読めなかった保存データは、確認のうえで削除かバックアップ */
export function useGroup() {
  const repo = adapters.groups;
  const [ready, setReady] = useState(false);
  const [group, setGroup] = useState<GroupState | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef<GroupState | null>(null);

  useEffect(() => {
    let alive = true;
    repo.load().then((r) => {
      if (!alive) return;
      latest.current = r.state;
      setGroup(r.state);
      setIssue(r.issue?.reason ?? null);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [repo]);

  /** 状態を更新して保存する。検証で拒否されたら、前の状態のまま理由を出す */
  const update = useCallback(
    async (fn: (g: GroupState) => GroupState): Promise<boolean> => {
      const cur = latest.current;
      if (!cur) return false;
      const next = fn(cur);
      const r = await repo.save(next);
      if (!r.ok) {
        setSaveError(`保存できませんでした（${r.reason}）`);
        return false;
      }
      latest.current = next;
      setGroup(next);
      setSaveError(null);
      return true;
    },
    [repo],
  );

  const create = useCallback(
    async (g: NewGroup, inputs: MemberInput[] = []): Promise<boolean> => {
      const now = new Date();
      const next: GroupState = {
        version: 1,
        id: `group-${now.getTime().toString(36)}`,
        createdAt: now.toISOString(),
        organizerId: g.organizerId,
        members: g.members,
        candidateDates: g.candidateDates,
        inputs: Object.fromEntries(inputs.map((i) => [i.memberId, i])),
        votes: {},
      };
      const r = await repo.save(next);
      if (!r.ok) {
        setSaveError(`保存できませんでした（${r.reason}）`);
        return false;
      }
      latest.current = next;
      setGroup(next);
      setSaveError(null);
      return true;
    },
    [repo],
  );

  /** 回答を保存する。回答が変わったら、投票と決定はやり直し（案が変わるため） */
  const submitInput = useCallback((input: MemberInput) => update((g) => ({ ...g, inputs: { ...g.inputs, [input.memberId]: input }, votes: {}, decision: undefined })), [update]);
  const vote = useCallback((memberId: string, kind: GroupPlanKind) => update((g) => ({ ...g, votes: { ...g.votes, [memberId]: kind } })), [update]);
  const clearVotes = useCallback(() => update((g) => ({ ...g, votes: {}, decision: undefined })), [update]);
  const decide = useCallback((decision: GroupDecision) => update((g) => ({ ...g, decision })), [update]);

  const reset = useCallback(
    async (opts?: { backup?: boolean }) => {
      await repo.clear(opts);
      latest.current = null;
      setGroup(null);
      setIssue(null);
      setSaveError(null);
    },
    [repo],
  );

  return { ready, group, issue, saveError, dismissSaveError: () => setSaveError(null), create, submitInput, vote, clearVotes, decide, reset };
}

export { GROUP_LIMITS };
