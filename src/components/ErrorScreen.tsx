"use client";

import { useState } from "react";
import { STORAGE_KEYS } from "@/core/persist";
import { MAX_SHARE_TOKEN_CHARS } from "@/core/share";

/** 共有リンク（URL または トークンだけ）から、開き直す先のパスを作る。読み取れなければ null */
export function shareHrefFromInput(input: string, origin: string): string | null {
  const text = input.trim();
  if (!text) return null;
  let token: string | null = null;
  try {
    const url = new URL(text, origin);
    token = url.searchParams.get("s");
  } catch {
    token = null;
  }
  if (!token && /^[A-Za-z0-9_-]+$/.test(text)) token = text;
  if (!token || token.length > MAX_SHARE_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return `/share?s=${token}`;
}

function clearAllStorage() {
  try {
    for (const key of [STORAGE_KEYS.current, STORAGE_KEYS.v2, ...STORAGE_KEYS.legacy, STORAGE_KEYS.backup]) window.localStorage.removeItem(key);
  } catch {
    // 保存が許可されていない環境では、何もしない
  }
}

/**
 * 想定外の例外が起きたときの画面（Error Boundary から使う）。
 *   データを初期化 / 共有リンクを開き直す / もう一度表示する を選べる。
 */
export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const onShare = () => {
    const href = shareHrefFromInput(link, window.location.origin);
    if (!href) {
      setLinkError("共有リンクを読み取れませんでした。リンク全体（またはリンクの ?s= 以降）を貼り付けてください。");
      return;
    }
    window.location.assign(href);
  };

  const onReset = () => {
    if (!window.confirm("保存されている旅程・変更履歴をすべて削除して、最初からやり直します。よろしいですか？")) return;
    clearAllStorage();
    window.location.assign("/");
  };

  return (
    <div className="px-4 py-12" data-testid="error-screen" role="alert">
      <p className="text-center text-4xl">🛟</p>
      <h1 className="mt-3 text-center text-lg font-extrabold text-slate-900">問題が起きました</h1>
      <p className="mt-1 text-center text-sm text-slate-600">画面を表示できませんでした。保存データを消さずに、まず「もう一度表示する」を試せます。</p>
      <p className="mt-3 break-words rounded-lg bg-slate-100 p-2 text-center text-[11px] text-slate-600" data-testid="error-message">
        {error.message || "原因不明のエラー"}
      </p>

      <div className="mt-5 grid gap-2">
        <button
          type="button"
          onClick={() => (reset ? reset() : window.location.reload())}
          className="min-h-11 rounded-xl bg-brand-600 px-4 font-semibold text-white hover:bg-brand-700"
          data-testid="error-retry"
        >
          もう一度表示する
        </button>

        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-[13px] font-bold text-slate-800">共有リンクを開き直す</p>
          {typeof window !== "undefined" && window.location.pathname.startsWith("/share") && (
            <button type="button" onClick={() => window.location.reload()} className="mt-1.5 min-h-10 w-full rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50" data-testid="error-reload-share">
              いまのリンクをもう一度開く
            </button>
          )}
          <input
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setLinkError(null);
            }}
            placeholder="共有リンクを貼り付け"
            className="mt-1.5 min-h-10 w-full rounded-lg border border-slate-300 px-2 text-sm"
            data-testid="error-share-input"
          />
          {linkError && <p className="mt-1 text-xs font-semibold text-rose-700">{linkError}</p>}
          <button type="button" onClick={onShare} className="mt-1.5 min-h-10 w-full rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50" data-testid="error-open-share">
            このリンクを開く
          </button>
        </div>

        <button type="button" onClick={onReset} className="min-h-11 rounded-xl border border-rose-300 bg-rose-50 px-4 font-semibold text-rose-800 hover:bg-rose-100" data-testid="error-reset-data">
          データを初期化する（保存した旅程をすべて削除）
        </button>
      </div>
    </div>
  );
}
