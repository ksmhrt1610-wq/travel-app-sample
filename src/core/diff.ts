import type { Itinerary } from "./types";

export type DiffKind =
  /** 予定のスポットが入れ替わった（Plan B 切替・休業の代替） */
  | "replaced"
  /** 開始時刻が動いた */
  | "shifted"
  /** 余白の長さが変わった（遅れの吸収） */
  | "buffer-changed"
  | "skip-candidate"
  | "skipped"
  | "closed"
  /** スキップ候補・スキップが取り消された */
  | "restored";

export interface DiffSide {
  spotId?: string;
  startMin: number;
  endMin: number;
}

export interface DiffItem {
  kind: DiffKind;
  dayIndex: number;
  blockId: string;
  before: DiffSide;
  after: DiffSide;
  /** 開始時刻の変化（分）。後ろにずれたら正 */
  deltaMin: number;
}

const side = (b: { spotId?: string; startMin: number; endMin: number }): DiffSide => ({
  spotId: b.spotId,
  startMin: b.startMin,
  endMin: b.endMin,
});

/** 2つの旅程を比べて、ブロックごとの変更点を旅程の並び順で返す */
export function diffItineraries(before: Itinerary, after: Itinerary): DiffItem[] {
  const items: DiffItem[] = [];
  for (const dayAfter of after.days) {
    const dayBefore = before.days.find((d) => d.index === dayAfter.index);
    if (!dayBefore) continue;
    const byId = new Map(dayBefore.blocks.map((b) => [b.id, b]));
    for (const a of dayAfter.blocks) {
      const b = byId.get(a.id);
      if (!b) continue;
      const base = { dayIndex: dayAfter.index, blockId: a.id, before: side(b), after: side(a), deltaMin: a.startMin - b.startMin };

      let kind: DiffKind | null = null;
      if (b.spotId !== a.spotId) kind = "replaced";
      else if (a.closed && !b.closed) kind = "closed";
      else if (a.skip === "skipped" && b.skip !== "skipped") kind = "skipped";
      else if (a.skip === "candidate" && b.skip !== "candidate") kind = "skip-candidate";
      else if (!a.skip && (b.skip === "candidate" || b.skip === "skipped")) kind = "restored";
      else if (a.label === "buffer" && a.endMin - a.startMin !== b.endMin - b.startMin) kind = "buffer-changed";
      else if (a.label !== "buffer" && (a.startMin !== b.startMin || a.endMin !== b.endMin)) kind = "shifted";

      if (kind) items.push({ kind, ...base });
    }
  }
  return items;
}

export interface DiffSummary {
  replaced: number;
  shifted: number;
  skipCandidates: number;
  skipped: number;
  closed: number;
  /** 後ろにずれた予定のうち最大のずれ（分） */
  maxShiftMin: number;
  /** 余白が吸収した遅れの合計（分） */
  bufferAbsorbedMin: number;
}

export function summarizeDiff(items: DiffItem[]): DiffSummary {
  const s: DiffSummary = { replaced: 0, shifted: 0, skipCandidates: 0, skipped: 0, closed: 0, maxShiftMin: 0, bufferAbsorbedMin: 0 };
  for (const it of items) {
    if (it.kind === "replaced") s.replaced++;
    if (it.kind === "shifted") s.shifted++;
    if (it.kind === "skip-candidate") s.skipCandidates++;
    if (it.kind === "skipped") s.skipped++;
    if (it.kind === "closed") s.closed++;
    if (it.kind === "buffer-changed") {
      const shrink = it.before.endMin - it.before.startMin - (it.after.endMin - it.after.startMin);
      if (shrink > 0) s.bufferAbsorbedMin += shrink;
    }
    if (it.kind === "shifted" || it.kind === "replaced") s.maxShiftMin = Math.max(s.maxShiftMin, it.deltaMin);
  }
  return s;
}

/** UI に保存する変更履歴の1件 */
export interface ChangeSet {
  id: string;
  /** 操作した時刻（シミュレーション上の現在時刻・分） */
  atMin: number;
  title: string;
  items: DiffItem[];
}
