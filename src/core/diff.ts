import type { Cause } from "./cause";
import type { Block, Itinerary } from "./types";

export type DiffKind =
  /** 予定のスポットが入れ替わった（Plan B 切替・休業の代替） */
  | "replaced"
  /** 滞在時間が短くなった（時間が足りないとき） */
  | "shortened"
  /** 順番が入れ替わった（「かなり疲れた」で近い順に並べ直したとき） */
  | "moved"
  /** 開始時刻が動いた */
  | "shifted"
  /** 余白の長さが変わった（遅れの吸収） */
  | "buffer-changed"
  /** 休憩・固定時刻などが追加された */
  | "inserted"
  /** 固定時刻などが外された */
  | "removed"
  | "skipped"
  | "closed"
  /** スキップが取り消された */
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
  /** 追加・外されたブロックの種類（休憩・固定など）を表示するための情報 */
  label?: Block["label"];
  /** 滞在時間の変化（短縮のとき）。分 */
  durationFrom?: number;
  durationTo?: number;
  /** 変わった理由（組み直しの結果として付く）と、その文章 */
  cause?: Cause;
  reason?: string;
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
    const afterIds = new Set(dayAfter.blocks.map((b) => b.id));

    // 順番が入れ替わったかは、前後に共通するブロックだけを並べて見る
    const commonBefore = dayBefore.blocks.filter((b) => afterIds.has(b.id)).map((b) => b.id);
    const commonAfter = dayAfter.blocks.filter((b) => byId.has(b.id)).map((b) => b.id);

    for (const a of dayAfter.blocks) {
      const b = byId.get(a.id);
      if (!b) {
        items.push({
          kind: "inserted",
          dayIndex: dayAfter.index,
          blockId: a.id,
          before: side(a),
          after: side(a),
          deltaMin: 0,
          label: a.label,
        });
        continue;
      }
      const base = {
        dayIndex: dayAfter.index,
        blockId: a.id,
        before: side(b),
        after: side(a),
        deltaMin: a.startMin - b.startMin,
        label: a.label,
      };
      const durB = b.endMin - b.startMin;
      const durA = a.endMin - a.startMin;

      let kind: DiffKind | null = null;
      if (b.spotId !== a.spotId) kind = "replaced";
      else if (a.closed && !b.closed) kind = "closed";
      else if (a.skip === "skipped" && b.skip !== "skipped") kind = "skipped";
      else if (!a.skip && b.skip === "skipped") kind = "restored";
      else if (a.skip === "skipped") kind = null;
      else if (a.label !== "buffer" && a.label !== "fixed" && durA < durB) kind = "shortened";
      else if (commonBefore.indexOf(a.id) !== commonAfter.indexOf(a.id)) kind = "moved";
      else if (a.label === "buffer" && durA !== durB) kind = "buffer-changed";
      else if (a.label !== "buffer" && (a.startMin !== b.startMin || a.endMin !== b.endMin)) kind = "shifted";

      if (kind) items.push({ kind, ...base, durationFrom: kind === "shortened" ? durB : undefined, durationTo: kind === "shortened" ? durA : undefined });
    }
    for (const b of dayBefore.blocks) {
      if (!afterIds.has(b.id)) {
        items.push({ kind: "removed", dayIndex: dayAfter.index, blockId: b.id, before: side(b), after: side(b), deltaMin: 0, label: b.label });
      }
    }
  }
  return items;
}

export interface DiffSummary {
  replaced: number;
  shifted: number;
  shortened: number;
  moved: number;
  inserted: number;
  skipped: number;
  closed: number;
  /** 後ろにずれた予定のうち最大のずれ（分） */
  maxShiftMin: number;
  /** 余白が吸収した遅れの合計（分） */
  bufferAbsorbedMin: number;
}

export function summarizeDiff(items: DiffItem[]): DiffSummary {
  const s: DiffSummary = { replaced: 0, shifted: 0, shortened: 0, moved: 0, inserted: 0, skipped: 0, closed: 0, maxShiftMin: 0, bufferAbsorbedMin: 0 };
  for (const it of items) {
    if (it.kind === "replaced") s.replaced++;
    if (it.kind === "shifted") s.shifted++;
    if (it.kind === "shortened") s.shortened++;
    if (it.kind === "moved") s.moved++;
    if (it.kind === "inserted") s.inserted++;
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

/** 徒歩が長い移動への、公共交通・タクシーの提案（履歴に残す分） */
export interface TravelNote {
  fromName: string;
  toName: string;
  walkMin: number;
  transitMin: number;
  taxiMin: number;
}

/** UI に保存する変更履歴の1件 */
export interface ChangeSet {
  id: string;
  /** 操作した時刻（シミュレーション上の現在時刻・分） */
  atMin: number;
  title: string;
  items: DiffItem[];
  /** この変更を反映する前の旅程（「元に戻す」で、これに完全に戻る） */
  before?: Itinerary;
  /** 軽い変更（元に戻せる）か、重い変更（確認が必要）か */
  weight?: "light" | "heavy";
  /** アプリが自動で反映した（おまかせモード） */
  auto?: boolean;
  notes?: string[];
  travel?: TravelNote[];
}
