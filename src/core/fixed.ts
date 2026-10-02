import { dayTravel, DEFAULT_MARGIN_MIN, isInert, placeOf } from "./schedule";
import { formatHHMM } from "./time";
import type { Block, Companions, Day, FixedEvent, FixedKind, LatLng, Member, Origin, PlanningContext } from "./types";

/* ---------- 種類ごとの初期値 ---------- */

/** その場所での所要時間の初期値（分） */
export const FIXED_DEFAULT_DURATION: Record<FixedKind, number> = {
  "last-transport": 0,
  checkin: 30,
  reservation: 60,
  "car-return": 15,
  meetup: 15,
};

/** 帰りの交通は、それに乗ったらその日の予定は終わり */
export const FIXED_ENDS_DAY: Record<FixedKind, boolean> = {
  "last-transport": true,
  checkin: false,
  reservation: false,
  "car-return": false,
  meetup: false,
};

/** 固定時刻のタイトルを組み立てる（例: 太宰府駅 18:05 の最終便） */
export function fixedTitle(kind: FixedKind, placeName: string, timeMin: number): string {
  const t = formatHHMM(timeMin);
  switch (kind) {
    case "last-transport":
      return `${placeName} ${t} の最終便`;
    case "checkin":
      return `${placeName} チェックイン ${t}`;
    case "reservation":
      return `${placeName} 予約 ${t}`;
    case "car-return":
      return `レンタカー返却（${placeName}）${t}`;
    case "meetup":
      return `${placeName} 集合 ${t}`;
  }
}

/* ---------- サンプルの固定時刻（実在の時刻表ではありません） ---------- */

export interface FixedPreset {
  id: string;
  kind: FixedKind;
  title: string;
  timeMin: number;
  place: Origin;
  /** 画面に出す補足 */
  note: string;
}

export const FIXED_PRESET_DISCLAIMER = "※ サンプルです。実在の時刻表ではありません（デモ用に時刻を決めています）。";

/** 太宰府・糸島エリアの「帰りの最終便」の例。選ぶだけで固定時刻として登録できる */
export const FIXED_PRESETS: FixedPreset[] = [
  {
    id: "preset-dazaifu-train",
    kind: "last-transport",
    title: "太宰府駅 18:05 の電車（最終）",
    timeMin: 18 * 60 + 5,
    place: { name: "太宰府駅", lat: 33.5206, lng: 130.5304 },
    note: "太宰府 → 天神方面（例）",
  },
  {
    id: "preset-dazaifu-bus",
    kind: "last-transport",
    title: "太宰府天満宮前 19:20 の最終バス",
    timeMin: 19 * 60 + 20,
    place: { name: "太宰府天満宮前バス停", lat: 33.5213, lng: 130.5339 },
    note: "太宰府 → 博多駅方面（例）",
  },
  {
    id: "preset-itoshima-train",
    kind: "last-transport",
    title: "筑前前原駅 20:10 の電車（最終）",
    timeMin: 20 * 60 + 10,
    place: { name: "筑前前原駅", lat: 33.5584, lng: 130.2127 },
    note: "糸島 → 福岡市内方面（例）",
  },
];

/** 固定時刻の場所に選べる駅・施設（スポット以外） */
export const FIXED_PLACES: Origin[] = [
  { name: "博多駅", lat: 33.5898, lng: 130.4207 },
  { name: "西鉄福岡（天神）駅", lat: 33.5913, lng: 130.3993 },
  { name: "福岡空港", lat: 33.5859, lng: 130.4507 },
  { name: "太宰府駅", lat: 33.5206, lng: 130.5304 },
  { name: "筑前前原駅", lat: 33.5584, lng: 130.2127 },
];

/* ---------- メンバー ---------- */

/** 同行者の種類から、メンバーの初期値を作る（名前は後から変えられる） */
export function defaultMembers(companions: Companions): Member[] {
  const names =
    companions === "solo" ? ["自分"] : companions === "couple" ? ["Aさん", "Bさん"] : ["Aさん", "Bさん", "Cさん"];
  return names.map((name, i) => ({ id: `m${i + 1}`, name }));
}

/* ---------- ブロック化 ---------- */

/** 全員に効く固定時刻を、旅程のブロックにする。開始は固定時刻そのもの */
export function createFixedBlock(ev: FixedEvent): Block {
  return {
    id: ev.id,
    label: "fixed",
    spotId: ev.spotId,
    place: ev.place,
    fixed: ev,
    durationMin: ev.durationMin,
    startMin: ev.timeMin,
    endMin: ev.timeMin + ev.durationMin,
    plannedStartMin: ev.timeMin,
    plannedEndMin: ev.timeMin + ev.durationMin,
    travelMin: 0,
    travelMode: "none",
  };
}

/** 全メンバー対象（または対象指定なし）なら、全員に効く固定時刻 */
export function isGroupWide(ev: FixedEvent, members: Member[]): boolean {
  return !ev.memberIds || ev.memberIds.length === 0 || members.every((m) => ev.memberIds!.includes(m.id));
}

/** 旅程内で重複しない ID（prefix + 連番） */
export function nextId(ids: Iterable<string>, prefix: string): string {
  let max = 0;
  for (const id of ids) {
    if (id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length));
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
  }
  return `${prefix}${max + 1}`;
}

/* ---------- 出発すべき時刻の逆算 ---------- */

export interface FixedDeparture {
  /** 固定時刻ブロック */
  fixed: Block;
  /** 直前のスポット（なければ出発地） */
  pred?: Block;
  predName: string;
  /** 直前のスポットを出発すべき時刻 = 固定時刻 − 移動時間 − 余裕時間 */
  departBy: number;
  travelMin: number;
  marginMin: number;
}

function placeName(b: Block | undefined, ctx: PlanningContext, fallback: string): string {
  if (!b) return fallback;
  return (b.spotId ? ctx.spotById.get(b.spotId)?.name : b.place?.name) ?? fallback;
}

/** index 番目の固定時刻ブロックについて、直前のスポットを出発すべき時刻を計算する */
export function fixedDeparture(day: Day, index: number, ctx: PlanningContext, marginMin: number = DEFAULT_MARGIN_MIN): FixedDeparture | null {
  const fixed = day.blocks[index];
  if (!fixed?.fixed) return null;
  const to = placeOf(fixed, ctx);
  if (!to) return null;
  let pred: Block | undefined;
  for (let j = index - 1; j >= 0; j--) {
    const b = day.blocks[j];
    if (!isInert(b) && placeOf(b, ctx)) {
      pred = b;
      break;
    }
  }
  const from: LatLng = pred ? placeOf(pred, ctx)! : day.origin;
  const travelMin = dayTravel(day, ctx)(from, to).minutes;
  return {
    fixed,
    pred,
    predName: placeName(pred, ctx, day.origin.name),
    departBy: fixed.fixed!.timeMin - travelMin - marginMin,
    travelMin,
    marginMin,
  };
}

export function allFixedDepartures(day: Day, ctx: PlanningContext, marginMin: number): Map<string, FixedDeparture> {
  const out = new Map<string, FixedDeparture>();
  day.blocks.forEach((b, i) => {
    if (b.fixed && !isInert(b)) {
      const d = fixedDeparture(day, i, ctx, marginMin);
      if (d) out.set(b.id, d);
    }
  });
  return out;
}

export interface FixedCountdown extends FixedDeparture {
  /** 出発すべき時刻までの残り（分）。負なら過ぎている */
  minutesLeft: number;
  /** 直前のスポットにいま滞在中（「ここ」を出る、と言える） */
  here: boolean;
}

/** 直近の固定時刻（全員に効くもの）までの逆算。「次にやること」カードに出す */
export function nextFixedCountdown(day: Day, ctx: PlanningContext, nowMin: number, marginMin: number): FixedCountdown | null {
  const idx = day.blocks.findIndex((b) => b.fixed && !isInert(b) && b.fixed.timeMin > nowMin);
  if (idx < 0) return null;
  const d = fixedDeparture(day, idx, ctx, marginMin);
  if (!d) return null;
  const here = !!d.pred && d.pred.startMin <= nowMin && nowMin < d.pred.endMin;
  return { ...d, minutesLeft: d.departBy - nowMin, here };
}

/* ---------- 特定メンバーだけの固定時刻 ---------- */

export interface MemberFixedStatus {
  event: FixedEvent;
  memberNames: string[];
  /** そのメンバーが最後まで参加できるブロック（なければ最初から不在） */
  leaveAfterBlockId?: string;
  /** グループを抜けて向かうべき出発時刻 */
  departBy: number;
  /** 抜けたあとの、メンバー不在のブロック */
  absentBlockIds: string[];
}

/**
 * 特定メンバーだけの固定時刻を満たすために、そのメンバーがグループを抜ける時点を求める。
 * 「ブロックが終わってから、固定時刻の場所へ 移動 + 余裕 で間に合う」最後のブロックまで参加し、以降を不在とする。
 * グループ全体の旅程は動かさない。
 */
export function memberFixedStatuses(day: Day, ctx: PlanningContext, marginMin: number, members: Member[]): MemberFixedStatus[] {
  const travel = dayTravel(day, ctx);
  return (day.memberFixed ?? []).map((event) => {
    let lastPlace: LatLng = day.origin;
    let leaveAfter: Block | undefined;
    let gone = false;
    const absent: string[] = [];
    for (const b of day.blocks) {
      if (isInert(b)) continue;
      const p = placeOf(b, ctx);
      if (!gone) {
        const tr = travel(p ?? lastPlace, event.place).minutes;
        if (b.endMin + tr + marginMin <= event.timeMin) {
          leaveAfter = b;
          if (p) lastPlace = p;
          continue;
        }
        gone = true;
      }
      absent.push(b.id);
    }
    return {
      event,
      memberNames: (event.memberIds ?? []).map((id) => members.find((m) => m.id === id)?.name ?? "メンバー"),
      leaveAfterBlockId: leaveAfter?.id,
      departBy: event.timeMin - marginMin - travel(lastPlace, event.place).minutes,
      absentBlockIds: absent,
    };
  });
}

/** ブロックごとの「不在メンバー」の名前。表示用（「Cさん不在」） */
export function absenceByBlock(statuses: MemberFixedStatus[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of statuses) {
    for (const id of s.absentBlockIds) {
      const names = out.get(id) ?? [];
      for (const n of s.memberNames) if (!names.includes(n)) names.push(n);
      out.set(id, names);
    }
  }
  return out;
}

/* ---------- 出発の通知（30分前・10分前） ---------- */

export type NoticeLevel = "before30" | "before10" | "over";

export interface DepartureNotice {
  /** 通知を閉じたかの識別に使う（固定時刻ID:段階） */
  id: string;
  level: NoticeLevel;
  title: string;
  departBy: number;
  minutesLeft: number;
  /** メンバー限定の固定時刻のときの対象者 */
  who?: string;
}

function levelOf(minutesLeft: number): NoticeLevel | null {
  if (minutesLeft <= 0) return "over";
  if (minutesLeft <= 10) return "before10";
  if (minutesLeft <= 30) return "before30";
  return null;
}

/**
 * 出発すべき時刻の30分前・10分前の通知。固定時刻の時刻を過ぎるまで、出発時刻を過ぎていれば「over」を返す。
 */
export function departureNotices(day: Day, ctx: PlanningContext, nowMin: number, marginMin: number, members: Member[]): DepartureNotice[] {
  const out: DepartureNotice[] = [];
  day.blocks.forEach((b, i) => {
    if (!b.fixed || isInert(b) || b.fixed.timeMin <= nowMin) return;
    const d = fixedDeparture(day, i, ctx, marginMin);
    if (!d) return;
    const level = levelOf(d.departBy - nowMin);
    if (level) out.push({ id: `${b.id}:${level}`, level, title: b.fixed.title, departBy: d.departBy, minutesLeft: d.departBy - nowMin });
  });
  for (const s of memberFixedStatuses(day, ctx, marginMin, members)) {
    if (s.event.timeMin <= nowMin) continue;
    const level = levelOf(s.departBy - nowMin);
    if (level) {
      out.push({ id: `${s.event.id}:${level}`, level, title: s.event.title, departBy: s.departBy, minutesLeft: s.departBy - nowMin, who: s.memberNames.join("・") });
    }
  }
  return out.sort((a, b) => a.departBy - b.departBy);
}
