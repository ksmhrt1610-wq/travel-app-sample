"use client";

import { useState } from "react";

/** 動作確認用: ボタンを押すと、表示中に例外を起こして、Error Boundary の画面（初期化・共有リンクの開き直し）を確かめられる */
export default function CrashPage() {
  const [boom, setBoom] = useState(false);
  if (boom) throw new Error("動作確認用に、わざと起こした例外です");
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm text-slate-600">Error Boundary の動作確認用ページです。</p>
      <button
        type="button"
        onClick={() => setBoom(true)}
        className="mt-4 min-h-11 rounded-xl bg-rose-600 px-5 font-semibold text-white hover:bg-rose-700"
        data-testid="crash-now"
      >
        例外を起こす
      </button>
    </div>
  );
}
