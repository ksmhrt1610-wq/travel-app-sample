import type { ChangeSet } from "./diff";
import type { ChangeWeight } from "./policy";
import type { ReplanResult } from "./replan";
import type { Itinerary } from "./types";

/** 変更履歴は最大 10 件。直前の変更から順に「元に戻す」で戻せる */
export const HISTORY_LIMIT = 10;

export interface Versioned {
  itinerary: Itinerary;
  history: ChangeSet[];
}

export interface CommitMeta {
  /** 操作した時刻（当日モードの現在時刻。旅程画面では 0） */
  atMin: number;
  title: string;
  weight?: ChangeWeight;
  auto?: boolean;
  id?: string;
}

/** 旅程が実際に変わったか（差分に出ない設定の変更なども含めて比べる） */
export function itineraryChanged(a: Itinerary, b: Itinerary): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

let seq = 0;
const newId = () => `cs${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * 組み直しの結果を反映する。反映前の旅程を履歴に持つので、undoLast で完全に元に戻せる。
 * 旅程が実際に変わらないときは、何もしない（履歴にも残さない）。
 */
export function commitResult<T extends Versioned>(state: T, result: ReplanResult, meta: CommitMeta): T {
  const entry: ChangeSet = {
    id: meta.id ?? newId(),
    atMin: meta.atMin,
    title: meta.title,
    items: result.diff,
    before: structuredClone(state.itinerary),
    weight: meta.weight,
    auto: meta.auto,
    notes: result.notes.length ? result.notes : undefined,
    travel: result.travelSuggestions.length
      ? result.travelSuggestions.map((t) => ({ fromName: t.fromName, toName: t.toName, walkMin: t.walkMin, transitMin: t.transitMin, taxiMin: t.taxiMin }))
      : undefined,
  };
  if (!itineraryChanged(state.itinerary, result.after)) return state;
  return { ...state, itinerary: result.after, history: [entry, ...state.history].slice(0, HISTORY_LIMIT) };
}

/** 組み直しの結果ではない旅程の変更（並べ替え・メンバー変更など）を反映する。こちらも元に戻せる */
export function commitItinerary<T extends Versioned>(state: T, next: Itinerary, meta: CommitMeta & { items?: ChangeSet["items"] }): T {
  const entry: ChangeSet = {
    id: meta.id ?? newId(),
    atMin: meta.atMin,
    title: meta.title,
    items: meta.items ?? [],
    before: structuredClone(state.itinerary),
    weight: meta.weight ?? "light",
    auto: meta.auto,
  };
  return { ...state, itinerary: next, history: [entry, ...state.history].slice(0, HISTORY_LIMIT) };
}

/** 直前の変更を元に戻す。戻せる変更がなければそのまま返す */
export function undoLast<T extends Versioned>(state: T): T {
  const [latest, ...rest] = state.history;
  if (!latest?.before) return state;
  return { ...state, itinerary: latest.before, history: rest };
}

export function canUndo(state: Versioned): boolean {
  return !!state.history[0]?.before;
}
