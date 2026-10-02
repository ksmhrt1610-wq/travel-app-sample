import type { DecidedBy, GroupPlanKind } from "./types";

export const PLAN_KINDS: GroupPlanKind[] = ["balanced", "max-sum", "least-travel"];

export interface VoteTally {
  counts: Record<GroupPlanKind, number>;
  voted: number;
  total: number;
  /** 全員が投票した */
  complete: boolean;
  /** 最多票の案（同票なら複数） */
  leaders: GroupPlanKind[];
  /** 決まった案（全員の投票がそろい、同票でないか、同票を主催者の票で決められたとき） */
  winner: GroupPlanKind | null;
  decidedBy: DecidedBy | null;
  /** 同票で、主催者の票も同票の案に入っていない。主催者が、同票の案から選ぶ */
  needsOrganizerChoice: GroupPlanKind[] | null;
}

/**
 * 投票の集計（純粋関数）。1人1票。全員が投票したら決める。
 * 同票のときは、主催者の票を優先する。主催者の票が同票の案に入っていないときは、主催者が同票の案から選ぶ。
 */
export function tallyVotes(votes: Record<string, GroupPlanKind>, memberIds: string[], organizerId: string): VoteTally {
  const counts: Record<GroupPlanKind, number> = { balanced: 0, "max-sum": 0, "least-travel": 0 };
  let voted = 0;
  for (const id of memberIds) {
    const v = votes[id];
    if (v && v in counts) {
      counts[v]++;
      voted++;
    }
  }
  const complete = voted === memberIds.length && memberIds.length > 0;
  const top = Math.max(...PLAN_KINDS.map((k) => counts[k]));
  const leaders = top > 0 ? PLAN_KINDS.filter((k) => counts[k] === top) : [];
  const base = { counts, voted, total: memberIds.length, complete, leaders };
  if (!complete) return { ...base, winner: null, decidedBy: null, needsOrganizerChoice: null };
  if (leaders.length === 1) return { ...base, winner: leaders[0], decidedBy: "majority", needsOrganizerChoice: null };
  const organizerVote = votes[organizerId];
  if (organizerVote && leaders.includes(organizerVote)) return { ...base, winner: organizerVote, decidedBy: "organizer-vote", needsOrganizerChoice: null };
  return { ...base, winner: null, decidedBy: null, needsOrganizerChoice: leaders };
}
