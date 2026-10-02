import { z } from "zod";
import { describeIssues, LIMITS, type Validated } from "../schema";
import { GROUP_LIMITS, type GroupState } from "./types";

const id = z.string().min(1).max(LIMITS.idLen);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const category = z.enum(["gourmet", "cafe", "history", "nature", "shopping", "art", "nightview"]);
const kind = z.enum(["balanced", "max-sum", "least-travel"]);

const memberInput = z.object({
  memberId: id,
  availableDates: z.array(dateStr).max(GROUP_LIMITS.maxDates),
  budgetCapYen: z.number().finite().min(0).max(1_000_000),
  dietary: z.array(z.enum(["no-pork", "no-seafood", "no-wheat", "vegetarian"])).max(4),
  rainTolerance: z.enum(["no-outdoor", "light-rain-ok", "dont-care"]),
  pace: z.enum(["relaxed", "normal", "packed"]),
  interests: z.partialRecord(category, z.enum(["like", "neutral", "dislike"])),
  wantedSpotIds: z.array(id).max(GROUP_LIMITS.maxWanted),
});

export const groupStateSchema = z
  .object({
    version: z.literal(1),
    id,
    createdAt: z.string().max(60),
    organizerId: id,
    members: z.array(z.object({ id, name: z.string().min(1).max(30) })).min(GROUP_LIMITS.minMembers).max(GROUP_LIMITS.maxMembers),
    candidateDates: z.array(dateStr).min(GROUP_LIMITS.minDates).max(GROUP_LIMITS.maxDates),
    inputs: z.record(id, memberInput),
    votes: z.record(id, kind),
    decision: z.object({ kind, decidedBy: z.enum(["majority", "organizer-vote", "organizer-choice"]), itineraryId: id }).optional(),
  })
  .superRefine((g, ctx) => {
    const ids = g.members.map((m) => m.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "メンバーのIDが重複しています", path: ["members"] });
    if (!ids.includes(g.organizerId)) ctx.addIssue({ code: "custom", message: "主催者がメンバーにいません", path: ["organizerId"] });
    if (new Set(g.candidateDates).size !== g.candidateDates.length) ctx.addIssue({ code: "custom", message: "候補日が重複しています", path: ["candidateDates"] });
    for (const [key, inp] of Object.entries(g.inputs)) {
      if (!ids.includes(key) || inp.memberId !== key) ctx.addIssue({ code: "custom", message: "回答の持ち主が正しくありません", path: ["inputs", key] });
      for (const d of inp.availableDates) if (!g.candidateDates.includes(d)) ctx.addIssue({ code: "custom", message: "候補日にない日があります", path: ["inputs", key, "availableDates"] });
    }
    for (const key of Object.keys(g.votes)) if (!ids.includes(key)) ctx.addIssue({ code: "custom", message: "投票した人がメンバーにいません", path: ["votes", key] });
  });

export function parseGroupState(input: unknown): Validated<GroupState> {
  const r = groupStateSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data as GroupState } : { ok: false, reason: describeIssues(r.error) };
}
