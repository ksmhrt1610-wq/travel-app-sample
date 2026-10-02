"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ChangeSet } from "@/core/diff";
import type { Itinerary, Preferences } from "@/core/types";
import type { RainOverride } from "@/core/weather";

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
  /** 閉じた通知（出発の通知・歩行距離の提案）の識別子 */
  dismissed?: string[];
  history: ChangeSet[];
}

export interface TripState {
  prefs?: Preferences;
  itinerary?: Itinerary;
  today?: TodayState;
}

// v2: 固定時刻・メンバー・休憩を追加したため、旧形式の保存データは読み込まない
const KEY = "replan-fukuoka:v2";
const EMPTY: TripState = {};

let cache: TripState | undefined;
const listeners = new Set<() => void>();

function read(): TripState {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TripState) : {};
  } catch {
    return {};
  }
}

function getSnapshot(): TripState {
  if (cache === undefined) cache = read();
  return cache;
}

function getServerSnapshot(): TripState {
  return EMPTY;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
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

export function saveTrip(next: TripState): void {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 容量超過・プライベートモードなどで保存できなくても、画面上の状態は保つ
  }
  listeners.forEach((l) => l());
}

export function clearTrip(): void {
  saveTrip({});
}

const subscribeHydration = () => () => {};

export function useTrip() {
  const trip = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // サーバー描画・ハイドレーション中は false、クライアントで読み込めたら true
  const ready = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const update = useCallback((fn: (prev: TripState) => TripState) => saveTrip(fn(getSnapshot())), []);
  return { ready, trip, update };
}
