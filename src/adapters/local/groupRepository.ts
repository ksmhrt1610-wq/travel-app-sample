import { parseGroupState } from "@/core/group";
import type { GroupLoadResult, GroupRepository, GroupSaveResult } from "../types";

export const GROUP_STORAGE_KEY = "replan-fukuoka:group:v1";
export const GROUP_BACKUP_KEY = "replan-fukuoka:group:backup";
/** 保存データの長さの上限（文字数） */
export const MAX_GROUP_CHARS = 512 * 1024;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * localStorage に保存する GroupRepository。
 * ここには、メンバー全員の回答（予算額・「苦手」を含む）が入る。1台を回して使うので、
 * 「本人の入力画面でだけ見せる」のは画面の上の約束で、端末の保存データそのものは隠していない（decisions.md 5-8）。
 */
export function createLocalGroupRepository(getStorage: () => StorageLike | null = () => (typeof window === "undefined" ? null : window.localStorage)): GroupRepository {
  return {
    async load(): Promise<GroupLoadResult> {
      let raw: string | null = null;
      try {
        raw = getStorage()?.getItem(GROUP_STORAGE_KEY) ?? null;
      } catch {
        return { state: null };
      }
      if (raw === null) return { state: null };
      if (raw.length > MAX_GROUP_CHARS) return { state: null, issue: { reason: "保存データが大きすぎます" } };
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return { state: null, issue: { reason: "JSON として読めません" } };
      }
      const v = parseGroupState(json);
      return v.ok ? { state: v.value } : { state: null, issue: { reason: v.reason } };
    },

    async save(state): Promise<GroupSaveResult> {
      const v = parseGroupState(state);
      if (!v.ok) return { ok: false, reason: v.reason };
      const text = JSON.stringify(v.value);
      if (text.length > MAX_GROUP_CHARS) return { ok: false, reason: "保存データが大きすぎます" };
      try {
        getStorage()?.setItem(GROUP_STORAGE_KEY, text);
        return { ok: true };
      } catch {
        return { ok: false, reason: "ブラウザに保存できませんでした（容量がいっぱいか、保存が許可されていません）" };
      }
    },

    async clear(opts) {
      const st = getStorage();
      if (!st) return;
      try {
        if (opts?.backup) {
          const raw = st.getItem(GROUP_STORAGE_KEY);
          if (raw !== null) st.setItem(GROUP_BACKUP_KEY, raw);
        }
        st.removeItem(GROUP_STORAGE_KEY);
      } catch {
        // 保存が許可されていない環境では、何もしない
      }
    },
  };
}
