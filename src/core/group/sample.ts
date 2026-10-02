import { addDays, nextSaturday } from "../time";
import type { GroupMember, MemberInput } from "./types";

export interface SampleGroup {
  members: GroupMember[];
  organizerId: string;
  candidateDates: string[];
  inputs: MemberInput[];
}

/**
 * 「サンプルで試す」用の4人（デモシナリオC）。候補日は、直近の土曜と日曜。
 *   あおい: グルメ好き・自然が苦手・¥8,000／ゆうと: 自然と歴史・詰め込み・¥15,000／
 *   みさき: カフェとアート・屋外なし・¥10,000／けん: こだわりなし・ゆったり・¥12,000
 */
export function sampleGroup(today: Date = new Date()): SampleGroup {
  const sat = nextSaturday(today);
  const candidateDates = [sat, addDays(sat, 1)];
  const members: GroupMember[] = [
    { id: "m1", name: "あおい" },
    { id: "m2", name: "ゆうと" },
    { id: "m3", name: "みさき" },
    { id: "m4", name: "けん" },
  ];
  const base = { availableDates: candidateDates, dietary: [] as MemberInput["dietary"] };
  const inputs: MemberInput[] = [
    { ...base, memberId: "m1", budgetCapYen: 8000, rainTolerance: "light-rain-ok", pace: "normal", interests: { gourmet: "like", nature: "dislike" }, wantedSpotIds: ["nakasu-ichiran"] },
    { ...base, memberId: "m2", budgetCapYen: 15000, rainTolerance: "dont-care", pace: "packed", interests: { nature: "like", history: "like" }, wantedSpotIds: ["ohori-park", "hakata-kushida"] },
    { ...base, memberId: "m3", budgetCapYen: 10000, rainTolerance: "no-outdoor", pace: "normal", interests: { cafe: "like", art: "like" }, wantedSpotIds: ["ohori-art", "ohori-park"] },
    { ...base, memberId: "m4", budgetCapYen: 12000, rainTolerance: "light-rain-ok", pace: "relaxed", interests: {}, wantedSpotIds: [] },
  ];
  return { members, organizerId: "m1", candidateDates, inputs };
}
