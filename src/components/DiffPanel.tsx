"use client";

import { useState, type ReactNode } from "react";
import { summarizeDiff, type ChangeSet, type DiffItem } from "@/core/diff";
import { formatDuration, formatHHMM } from "@/core/time";
import type { Itinerary, PlanningContext } from "@/core/types";
import { Button, Chip, cx } from "./ui";

const range = (s: { startMin: number; endMin: number }) => `${formatHHMM(s.startMin)}–${formatHHMM(s.endMin)}`;

function nameOf(item: DiffItem, ctx: PlanningContext, itin?: Itinerary): (id?: string) => string {
  return (id?: string) => {
    if (id) return ctx.spotById.get(id)?.name ?? "予定";
    // スポットを持たないブロック（固定時刻・休憩・余白）は、旅程から名前を引く
    const b = itin?.days.flatMap((d) => d.blocks).find((x) => x.id === item.blockId);
    if (b?.fixed) return b.fixed.title;
    if (b?.label === "rest") return "休憩";
    return "余白";
  };
}

/** 1件の変更の中身（見出し行）。理由は DiffLine が下に付ける */
function body(item: DiffItem, name: (id?: string) => string): { testid?: string; node: ReactNode } {
  switch (item.kind) {
    case "replaced":
      return {
        testid: "diff-replaced",
        node: (
          <>
            <span className="mr-1">🔁</span>
            <span className="text-slate-500 line-through">{name(item.before.spotId)}</span>
            <span className="mx-1 text-slate-400">→</span>
            <strong className="text-emerald-800">{name(item.after.spotId)}</strong>
            <span className="block pl-6 text-[11px] tabular-nums text-slate-500">
              {range(item.before)} → {range(item.after)}
            </span>
          </>
        ),
      };
    case "shifted":
      return {
        testid: "diff-shifted",
        node: (
          <>
            <span className="mr-1">⏱</span>
            <strong>{name(item.after.spotId)}</strong>
            <span className="block pl-6 text-[11px] tabular-nums text-slate-500">
              {range(item.before)} → {range(item.after)}
              <span className={cx("ml-1 font-bold", item.deltaMin > 0 ? "text-amber-700" : "text-emerald-700")}>
                （{item.deltaMin > 0 ? "+" : ""}
                {item.deltaMin}分）
              </span>
            </span>
          </>
        ),
      };
    case "shortened":
      return {
        testid: "diff-shortened",
        node: (
          <>
            <span className="mr-1">✂️</span>
            <strong>{name(item.after.spotId)}</strong>
            <span className="ml-1 text-[11px] font-bold text-sky-800">
              滞在 {item.durationFrom}分 → {item.durationTo}分
            </span>
            <span className="block pl-6 text-[11px] tabular-nums text-slate-500">
              {range(item.before)} → {range(item.after)}
            </span>
          </>
        ),
      };
    case "moved":
      return {
        testid: "diff-moved",
        node: (
          <>
            <span className="mr-1">↕️</span>
            <strong>{name(item.after.spotId)}</strong>
            <span className="ml-1 text-[11px] text-slate-500">順番を入れ替え</span>
            <span className="block pl-6 text-[11px] tabular-nums text-slate-500">
              {range(item.before)} → {range(item.after)}
            </span>
          </>
        ),
      };
    case "inserted":
      return {
        testid: "diff-inserted",
        node: (
          <>
            <span className="mr-1">{item.label === "fixed" ? "🔒" : "☕"}</span>
            <strong>{name(item.after.spotId)}</strong>
            <span className="ml-1 text-[11px] text-emerald-700">を追加</span>
            <span className="block pl-6 text-[11px] tabular-nums text-slate-500">
              {range(item.after)}（{formatDuration(item.after.endMin - item.after.startMin)}）
            </span>
          </>
        ),
      };
    case "removed":
      return {
        testid: "diff-removed",
        node: (
          <>
            <span className="mr-1">➖</span>
            <strong>{name(item.before.spotId)}</strong>
            <span className="ml-1 text-[11px] text-slate-500">を外しました</span>
          </>
        ),
      };
    case "buffer-changed":
      return {
        testid: "diff-buffer",
        node: (
          <>
            <span className="mr-1">☕</span>
            <strong>余白</strong>
            <span className="ml-1 text-[11px] tabular-nums text-slate-500">
              {formatDuration(item.before.endMin - item.before.startMin)} → {formatDuration(item.after.endMin - item.after.startMin)}（遅れを吸収）
            </span>
          </>
        ),
      };
    case "skipped":
      return {
        testid: "diff-skipped",
        node: (
          <>
            <span className="mr-1">⏭</span>
            <strong>{name(item.after.spotId)}</strong>
            <span className="ml-1 text-[11px] text-slate-500">をスキップ{item.label === "optional" ? "（Optional）" : item.label === "normal" ? "（標準）" : item.label === "must" ? "（Must）" : ""}</span>
          </>
        ),
      };
    case "closed":
      return {
        testid: "diff-closed",
        node: (
          <>
            <span className="mr-1">⛔</span>
            <strong>{name(item.after.spotId)}</strong>
            <span className="ml-1 text-[11px] text-rose-700">臨時休業</span>
          </>
        ),
      };
    default:
      return {
        testid: "diff-restored",
        node: (
          <>
            <span className="mr-1">↩️</span>
            <strong>{name(item.after.spotId)}</strong>
            <span className="ml-1 text-[11px] text-slate-500">を元に戻しました</span>
          </>
        ),
      };
  }
}

export function DiffLine({ item, ctx, itin }: { item: DiffItem; ctx: PlanningContext; itin?: Itinerary }) {
  const { testid, node } = body(item, nameOf(item, ctx, itin));
  return (
    <li data-testid={testid} data-cause={item.cause?.kind}>
      {node}
      {item.reason && (
        <span className="block pl-6 text-[11px] font-semibold text-indigo-800" data-testid="diff-reason">
          理由：{item.reason}
        </span>
      )}
    </li>
  );
}

export function DiffList({ items, ctx, itin }: { items: DiffItem[]; ctx: PlanningContext; itin?: Itinerary }) {
  return (
    <ul className="space-y-1.5 text-[13px] text-slate-800">
      {items.map((it) => (
        <DiffLine key={`${it.blockId}-${it.kind}`} item={it} ctx={ctx} itin={itin} />
      ))}
    </ul>
  );
}

export function DiffSummary({ items }: { items: DiffItem[] }) {
  const s = summarizeDiff(items);
  const chips = [
    s.replaced && `切替 ${s.replaced}件`,
    s.inserted && `追加 ${s.inserted}件`,
    s.shifted && `時刻変更 ${s.shifted}件`,
    s.maxShiftMin > 0 && `最大 +${s.maxShiftMin}分`,
    s.bufferAbsorbedMin > 0 && `余白が ${s.bufferAbsorbedMin}分 吸収`,
    s.shortened && `滞在短縮 ${s.shortened}件`,
    s.moved && `並べ替え ${s.moved}件`,
    s.skipped && `スキップ ${s.skipped}件`,
    s.closed && `休業 ${s.closed}件`,
  ].filter(Boolean) as string[];
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c} className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-slate-700 ring-1 ring-slate-200">
          {c}
        </span>
      ))}
    </div>
  );
}

/** 確定した変更の履歴（切り替え・遅延・休憩の前後で何が変わったか）。直前の変更は元に戻せる */
export function DiffPanel({
  history,
  ctx,
  itin,
  onUndo,
}: {
  history: ChangeSet[];
  ctx: PlanningContext;
  itin?: Itinerary;
  onUndo?: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!history.length) return null;
  const [latest, ...older] = history;

  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50/70 p-3" data-testid="diff-panel">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-extrabold text-amber-950">
            🧾 {latest.auto ? "自動で反映した変更" : "確定した変更"}（{formatHHMM(latest.atMin)}時点）
          </h2>
          <p className="text-[13px] font-semibold text-slate-800" data-testid="diff-title">
            {latest.title}
          </p>
        </div>
        {onUndo && latest.before && (
          <Button variant="secondary" size="sm" onClick={onUndo} data-testid="undo-latest" className="shrink-0 border-amber-400 bg-white">
            ↩ 元に戻す
          </Button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {latest.auto && <Chip className="bg-indigo-100 text-indigo-800">🤖 おまかせで自動反映</Chip>}
        {latest.weight === "light" && <Chip className="bg-emerald-100 text-emerald-800">軽い変更</Chip>}
      </div>
      <DiffSummary items={latest.items} />
      <div className="mt-2">
        <DiffList items={latest.items} ctx={ctx} itin={itin} />
      </div>
      {latest.notes?.map((n) => (
        <p key={n} className="mt-1.5 text-[11px] text-slate-700">
          {n}
        </p>
      ))}
      {latest.travel && latest.travel.length > 0 && (
        <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50 p-2 text-[11px] text-sky-950" data-testid="history-travel">
          <p className="font-bold">徒歩20分以上かかる移動は、公共交通かタクシーがおすすめです</p>
          <ul className="mt-0.5 space-y-0.5">
            {latest.travel.map((t) => (
              <li key={`${t.fromName}-${t.toName}`}>
                {t.fromName} → <strong>{t.toName}</strong>：徒歩 約{t.walkMin}分 → 電車・バス 約{t.transitMin}分 / タクシー 約{t.taxiMin}分
              </li>
            ))}
          </ul>
        </div>
      )}

      {older.length > 0 && (
        <div className="mt-2 border-t border-amber-200 pt-2">
          <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs font-semibold text-amber-900 underline" data-testid="diff-history-toggle">
            {showAll ? "過去の変更を閉じる" : `過去の変更を見る（${older.length}件）`}
          </button>
          {showAll && (
            <ol className="mt-2 space-y-2">
              {older.map((cs) => (
                <li key={cs.id} className="rounded-xl bg-white/70 p-2">
                  <p className="text-xs font-bold text-slate-700">
                    {formatHHMM(cs.atMin)} {cs.title}
                  </p>
                  <DiffSummary items={cs.items} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
