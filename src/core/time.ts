/** 時刻ユーティリティ。時刻は 0:00 からの分で扱う。 */

export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function formatHHMM(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** 「1時間05分」「25分」 */
export function formatDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}時間` : `${h}時間${String(r).padStart(2, "0")}分`;
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

export function formatDateJa(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${y}/${m}/${d}（${WEEKDAY_JA[weekdayOf(date)]}）`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return toDateString(dt);
}

export function toDateString(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 基準日以降で最初の土曜日（基準日が土曜ならその日）。旅行日のデフォルトに使う */
export function nextSaturday(from: Date): string {
  const dt = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const diff = (6 - dt.getDay() + 7) % 7;
  dt.setDate(dt.getDate() + diff);
  return toDateString(dt);
}
