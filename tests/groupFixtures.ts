import type { GroupMember, MemberInput } from "@/core/group";

export const MEMBERS: GroupMember[] = [
  { id: "m1", name: "あおい" },
  { id: "m2", name: "ゆうと" },
  { id: "m3", name: "みさき" },
  { id: "m4", name: "けん" },
];

/** 候補日: 2026-10-03（土）・2026-10-04（日） */
export const DATES = ["2026-10-03", "2026-10-04"];

/** デモシナリオC の4人（改善指示書 §6）: A グルメ好き・自然が苦手・¥8,000 / B 自然・詰め込み・¥15,000 / C カフェとアート・屋外なし・¥10,000 / D こだわりなし・ゆったり・¥12,000 */
export function scenarioC(): MemberInput[] {
  return [
    {
      memberId: "m1",
      availableDates: DATES,
      budgetCapYen: 8000,
      dietary: [],
      rainTolerance: "light-rain-ok",
      pace: "normal",
      interests: { gourmet: "like", nature: "dislike" },
      wantedSpotIds: ["nakasu-ichiran"],
    },
    {
      memberId: "m2",
      availableDates: DATES,
      budgetCapYen: 15000,
      dietary: [],
      rainTolerance: "dont-care",
      pace: "packed",
      interests: { nature: "like", history: "like" },
      wantedSpotIds: ["ohori-park", "hakata-kushida"],
    },
    {
      memberId: "m3",
      availableDates: DATES,
      budgetCapYen: 10000,
      dietary: [],
      rainTolerance: "no-outdoor",
      pace: "normal",
      interests: { cafe: "like", art: "like" },
      wantedSpotIds: ["ohori-art", "ohori-park"],
    },
    {
      memberId: "m4",
      availableDates: DATES,
      budgetCapYen: 12000,
      dietary: [],
      rainTolerance: "light-rain-ok",
      pace: "relaxed",
      interests: {},
      wantedSpotIds: [],
    },
  ];
}
