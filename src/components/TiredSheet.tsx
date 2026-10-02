"use client";

import { Sheet } from "./ui";

/** 「疲れた」ボタンを押したときの2段階の選択 */
export function TiredSheet({ open, onClose, onChoose }: { open: boolean; onClose: () => void; onChoose: (level: "light" | "heavy") => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="どのくらい疲れましたか？" testId="tired-sheet">
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => onChoose("light")}
          data-testid="tired-light"
          className="w-full rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-left hover:bg-amber-100"
        >
          <p className="text-base font-extrabold text-amber-950">☕ 少し休みたい</p>
          <p className="mt-0.5 text-xs leading-relaxed text-amber-900">近くの屋内カフェなど、休憩できる場所で<strong>30分</strong>の休憩を挟みます。</p>
        </button>
        <button
          type="button"
          onClick={() => onChoose("heavy")}
          data-testid="tired-heavy"
          className="w-full rounded-2xl border-2 border-rose-300 bg-rose-50 p-4 text-left hover:bg-rose-100"
        >
          <p className="text-base font-extrabold text-rose-950">😮‍💨 かなり疲れた</p>
          <ul className="mt-1 list-disc pl-5 text-xs leading-relaxed text-rose-900">
            <li>
              <strong>60分</strong>の休憩を挟む
            </li>
            <li>残りの Optional をスキップする</li>
            <li>残りのスポットを近い順に並べ直して、歩く距離を減らす</li>
            <li>徒歩20分以上の移動には、公共交通・タクシーを提案する</li>
          </ul>
        </button>
        <p className="rounded-lg bg-slate-100 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
          どちらも <strong>Must と固定時刻は守ります</strong>。組み直し案を見てから確定できます。押した人の名前は表示されず、グループには「メンバーの1人が休憩を希望しています」とだけ伝わります。
        </p>
      </div>
    </Sheet>
  );
}
