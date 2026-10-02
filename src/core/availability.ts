import type { Spot } from "./types";
import { parseHHMM, weekdayOf } from "./time";

export interface OpenSlot {
  /** 滞在を開始できる最も早い時刻（分） */
  start: number;
  /** その営業枠の閉店時刻（分） */
  close: number;
}

/** その日、定休日でないか */
export function isOpenOnDate(spot: Spot, date: string): boolean {
  return !spot.closedDays?.includes(weekdayOf(date));
}

/**
 * `earliest` 以降に `durationMin` 分の滞在を営業時間内に収められる最も早い開始時刻を返す。
 * 収まる営業枠がなければ null（定休日・閉店後・滞在が枠より長い場合）。
 */
export function findOpenSlot(
  spot: Spot,
  date: string,
  earliest: number,
  durationMin: number,
): OpenSlot | null {
  if (!isOpenOnDate(spot, date)) return null;
  let best: OpenSlot | null = null;
  for (const range of spot.hours) {
    const open = parseHHMM(range.open);
    const close = parseHHMM(range.close);
    const start = Math.max(earliest, open);
    if (start + durationMin <= close) {
      if (!best || start < best.start) best = { start, close };
    }
  }
  return best;
}

/** [start, end] がひとつの営業枠に完全に収まっているか（営業時間外チェック） */
export function isOpenDuring(spot: Spot, date: string, start: number, end: number): boolean {
  if (!isOpenOnDate(spot, date)) return false;
  return spot.hours.some((r) => start >= parseHHMM(r.open) && end <= parseHHMM(r.close));
}

/** [start, end] が混雑しやすい時間帯に重なるか */
export function overlapsCrowded(spot: Spot, start: number, end: number): boolean {
  return (spot.crowded ?? []).some((r) => start < parseHHMM(r.close) && end > parseHHMM(r.open));
}
