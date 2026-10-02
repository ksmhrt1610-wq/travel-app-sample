import { describe, expect, it } from "vitest";
import { aggregatePreferences, buildGroupPlans, parseGroupState, sampleGroup } from "@/core/group";
import { makeCtx } from "./helpers";

describe("サンプルで試す（4人ぶん入力済みのグループ）", () => {
  const ctx = makeCtx();
  const s = sampleGroup(new Date(2026, 9, 1)); // 2026-10-01（木）→ 候補日は 10/3（土）・10/4（日）

  it("候補日は直近の土曜と日曜。保存できる形（スキーマ）になっている", () => {
    expect(s.candidateDates).toEqual(["2026-10-03", "2026-10-04"]);
    const state = { version: 1 as const, id: "g", createdAt: "t", organizerId: s.organizerId, members: s.members, candidateDates: s.candidateDates, inputs: Object.fromEntries(s.inputs.map((i) => [i.memberId, i])), votes: {} };
    expect(parseGroupState(state).ok).toBe(true);
  });

  it("まとめと3つの案が作れる（予算は最小、Must は希望が重なった大濠公園と、あおいの一蘭）", () => {
    const agg = aggregatePreferences({ members: s.members, inputs: s.inputs, candidateDates: s.candidateDates, ctx });
    expect(agg.budgetCapYen).toBe(8000);
    expect(agg.mustSpotIds).toEqual(["ohori-park", "nakasu-ichiran"]);
    const set = buildGroupPlans({ members: s.members, inputs: s.inputs, agg, ctx });
    expect(set.plans).toHaveLength(3);
    expect(set.split).toBe(false);
  });
});
