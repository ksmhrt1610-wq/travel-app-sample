"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ChangeSet } from "@/core/diff";
import {
  findUnknownSpots,
  inferMeals,
  parseStored,
  serializeTrip,
  STORAGE_KEYS,
  type UnreadableKind,
} from "@/core/persist";
import type { StoredTrip } from "@/core/schema";
import type { Itinerary, PlanningContext, Preferences } from "@/core/types";
import type { HeatOverride, RainOverride } from "@/core/weather";

/** 当日モードの状態（デモ用シミュレーションを含む）。localStorage に保存する */
export interface TodayState {
  /** 当日モードで操作中の旅程（もとの旅程のコピー。雨・遅延などの変更はここに入る） */
  itinerary: Itinerary;
  dayIndex: number;
  /** シミュレーション上の現在時刻（0:00 からの分） */
  nowMin: number;
  rain?: RainOverride;
  /** 雨の通知を閉じたときの rain の識別子 */
  rainDismissed?: string;
  /** デモ用の「暑くなる」操作（暑さ指数 WBGT） */
  heat?: HeatOverride;
  /** 暑さの通知を閉じたときの heat の識別子 */
  heatDismissed?: string;
  /** 閉じた通知（出発の通知・歩行距離の提案）の識別子 */
  dismissed?: string[];
  history: ChangeSet[];
}

export interface TripState {
  prefs?: Preferences;
  itinerary?: Itinerary;
  today?: TodayState;
  /** 旅程画面で反映した変更の履歴（最大10件。直前の変更から元に戻せる） */
  history?: ChangeSet[];
}

/** 読み込めなかった保存データ。確認のうえで、削除するか、バックアップとして残す */
export type LoadIssueKind = UnreadableKind | "unknown-spots";

export interface LoadIssue {
  kind: LoadIssueKind;
  reason: string;
  /** 元のデータがあるキーと、その中身（バックアップに退避するため） */
  keys: string[];
  raw: string;
}

export interface StoreMeta {
  loadIssue: LoadIssue | null;
  /** 直近の保存の失敗（検証で拒否された・容量超過など）。画面に出して、閉じられる */
  saveError: string | null;
}

const EMPTY: TripState = {};
const EMPTY_META: StoreMeta = { loadIssue: null, saveError: null };

let cache: TripState | undefined;
let meta: StoreMeta = EMPTY_META;
/** 旧版から変換したデータで、スポットの情報が読めてから補正（食事の推定）して保存し直すもの */
let pendingMigration: { from: number; keys: string[] } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const setMeta = (patch: Partial<StoreMeta>) => {
  meta = { ...meta, ...patch };
  emit();
};

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 保存データを読む。v3 → v2（変換）→ それ以前、の順。読めなかったものは勝手に捨てず、loadIssue にする */
function read(): TripState {
  meta = EMPTY_META;
  pendingMigration = null;

  const current = readKey(STORAGE_KEYS.current);
  if (current !== null) {
    const out = parseStored(current, "current");
    if (out.status === "ok") return out.state as unknown as TripState;
    if (out.status === "unreadable") {
      meta = { ...meta, loadIssue: { kind: out.kind, reason: out.reason, keys: [STORAGE_KEYS.current], raw: current } };
      return {};
    }
  }

  const v2 = readKey(STORAGE_KEYS.v2);
  if (v2 !== null) {
    const out = parseStored(v2, "v2");
    if (out.status === "migrated") {
      pendingMigration = { from: out.from, keys: [STORAGE_KEYS.v2] };
      return out.state as unknown as TripState;
    }
    if (out.status === "unreadable") {
      meta = { ...meta, loadIssue: { kind: out.kind, reason: out.reason, keys: [STORAGE_KEYS.v2], raw: v2 } };
      return {};
    }
  }

  for (const key of STORAGE_KEYS.legacy) {
    const raw = readKey(key);
    if (raw !== null) {
      const out = parseStored(raw, "legacy");
      if (out.status === "unreadable") meta = { ...meta, loadIssue: { kind: out.kind, reason: out.reason, keys: [key], raw } };
      return {};
    }
  }
  return {};
}

function getSnapshot(): TripState {
  if (cache === undefined) cache = read();
  return cache;
}

function getServerSnapshot(): TripState {
  return EMPTY;
}

function getMetaSnapshot(): StoreMeta {
  // 初回の read() より前に meta を参照されても、保存データの読み込み結果を反映する
  if (cache === undefined) cache = read();
  return meta;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEYS.current) {
      cache = read();
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

/**
 * 保存する。保存の前に検証し、不正なデータは拒否する（前の状態のまま。アプリは使い続けられる）。
 * 保存データの確認（loadIssue）が終わるまでは保存しない（確認前に、読めなかったデータを上書きしないため）。
 */
export function saveTrip(next: TripState): SaveResult {
  if (meta.loadIssue) {
    const reason = "保存データの確認が終わるまで、保存できません";
    setMeta({ saveError: reason });
    return { ok: false, reason };
  }
  const text = serializeTrip(next);
  if (!text.ok) {
    setMeta({ saveError: `この変更は保存できませんでした（${text.reason}）` });
    return { ok: false, reason: text.reason };
  }
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEYS.current, text.value);
    if (meta.saveError) meta = { ...meta, saveError: null };
  } catch {
    // 容量超過・プライベートモードなどで保存できなくても、画面上の状態は保つ
    meta = { ...meta, saveError: "ブラウザに保存できませんでした（容量がいっぱいか、保存が許可されていません）。この画面では使い続けられます。" };
  }
  emit();
  return { ok: true };
}

export function clearTrip(): void {
  saveTrip({});
}

/** 保存データのすべてのキーを消す（Error Boundary の「データを初期化」） */
export function resetAllStorage(): void {
  try {
    for (const key of [STORAGE_KEYS.current, STORAGE_KEYS.v2, ...STORAGE_KEYS.legacy, STORAGE_KEYS.backup]) window.localStorage.removeItem(key);
  } catch {
    // 保存が許可されていない環境では、何もしない
  }
  cache = {};
  pendingMigration = null;
  meta = EMPTY_META;
  emit();
}

/**
 * 読めなかった保存データの確認への答え。
 *   delete: 削除して、新しく始める / backup: バックアップ（replan-fukuoka:backup）に退避して、新しく始める
 */
export function resolveLoadIssue(choice: "delete" | "backup"): void {
  const issue = meta.loadIssue;
  if (!issue) return;
  try {
    if (choice === "backup") window.localStorage.setItem(STORAGE_KEYS.backup, issue.raw);
    for (const key of issue.keys) window.localStorage.removeItem(key);
  } catch {
    setMeta({ saveError: "バックアップを保存できなかったため、データはそのまま残しています" });
    return;
  }
  cache = {};
  pendingMigration = null;
  meta = EMPTY_META;
  emit();
}

/**
 * スポットの情報が読めたあとの確認:
 *   1. 旧版から変換したデータの補正（食事の印の推定）→ v3 で保存し直し、旧版のキーを消す
 *   2. 保存データが、いまのデータにないスポットを参照していないか（あれば、確認を出す）
 */
export function finishBoot(ctx: PlanningContext): void {
  const state = getSnapshot();
  if (meta.loadIssue) return;

  if (pendingMigration) {
    const migrated = inferMeals(state as unknown as StoredTrip, ctx.spotById) as unknown as TripState;
    const { keys } = pendingMigration;
    pendingMigration = null;
    const r = saveTrip(migrated);
    if (r.ok) {
      try {
        for (const key of keys) window.localStorage.removeItem(key);
      } catch {
        // 消せなくても、v3 を優先して読むので問題ない
      }
    }
  }

  const unknown = findUnknownSpots(getSnapshot() as unknown as StoredTrip, ctx.spotById);
  if (unknown.length) {
    const raw = readKey(STORAGE_KEYS.current) ?? JSON.stringify(getSnapshot());
    setMeta({
      loadIssue: {
        kind: "unknown-spots",
        reason: `いまのデータにないスポット: ${unknown.slice(0, 3).join("、")}${unknown.length > 3 ? ` ほか${unknown.length - 3}件` : ""}`,
        keys: [STORAGE_KEYS.current],
        raw,
      },
    });
  }
}

export function dismissSaveError(): void {
  setMeta({ saveError: null });
}

const subscribeHydration = () => () => {};

export function useTrip() {
  const trip = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // サーバー描画・ハイドレーション中は false、クライアントで読み込めたら true
  const ready = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const update = useCallback((fn: (prev: TripState) => TripState): SaveResult => saveTrip(fn(getSnapshot())), []);
  return { ready, trip, update };
}

/** 保存データの確認・保存エラーの状態 */
export function useTripMeta(): StoreMeta {
  return useSyncExternalStore(subscribe, getMetaSnapshot, () => EMPTY_META);
}
