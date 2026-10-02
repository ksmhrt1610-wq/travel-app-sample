"use client";

import { useEffect } from "react";
import { unreadableTitle } from "@/core/persist";
import { dismissSaveError, finishBoot, resolveLoadIssue, useTripMeta } from "@/store/tripStore";
import { usePlanningContext } from "@/store/usePlanningContext";
import { Button } from "./ui";

/**
 * 保存データの確認と、保存エラーの表示。
 *  - 読めなかった保存データ（壊れている・古い版・いまのデータにないスポットを含む）は、勝手に捨てずに、確認を出す
 *  - 保存できなかった変更（検証で拒否された・容量超過）は、バナーで知らせる（アプリは使い続けられる）
 */
export function StorageGate() {
  const meta = useTripMeta();
  const ctx = usePlanningContext();

  // スポットの情報が読めたら、旧版データの補正と、スポットの存在確認をする
  useEffect(() => {
    if (ctx) finishBoot(ctx);
  }, [ctx]);

  const issue = meta.loadIssue;
  return (
    <>
      {meta.saveError && !issue && (
        <div className="fixed inset-x-0 top-[3.6rem] z-[70] mx-auto max-w-md px-3" role="alert" data-testid="save-error-banner">
          <div className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-[13px] font-semibold text-rose-900 shadow-lg">
            <span className="flex-1">⚠ {meta.saveError}</span>
            <button type="button" onClick={dismissSaveError} className="shrink-0 rounded-md px-2 text-rose-700 hover:bg-rose-100" aria-label="閉じる" data-testid="save-error-close">
              ✕
            </button>
          </div>
        </div>
      )}

      {issue && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/60 p-4" role="alertdialog" aria-modal="true" aria-label="保存データの確認" data-testid="load-issue-dialog" data-kind={issue.kind}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <p className="text-3xl">🗂️</p>
            <h2 className="mt-1 text-base font-extrabold text-slate-900">{unreadableTitle(issue.kind)}</h2>
            <p className="mt-1 text-xs text-slate-500" data-testid="load-issue-reason">
              {issue.reason}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              このまま新しく始めるには、保存されているデータを手放す必要があります。<strong>削除</strong>するか、<strong>バックアップとして残して</strong>新しく始めるかを選んでください。
            </p>
            <div className="mt-4 grid gap-2">
              <Button onClick={() => resolveLoadIssue("backup")} data-testid="load-issue-backup">
                バックアップとして残して、新しく始める
              </Button>
              <Button variant="secondary" onClick={() => resolveLoadIssue("delete")} data-testid="load-issue-delete">
                削除して、新しく始める
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">確認が終わるまで、保存は行いません。</p>
          </div>
        </div>
      )}
    </>
  );
}
