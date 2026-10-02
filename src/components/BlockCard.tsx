"use client";

import type { ReactNode } from "react";
import type { DiffItem } from "@/core/diff";
import type { FixedDeparture } from "@/core/fixed";
import { BLOCK_LABEL, CATEGORY_ICON, CATEGORY_LABEL, FIXED_KIND_ICON, FIXED_KIND_LABEL, SETTING_ICON, SETTING_LABEL } from "@/core/labels";
import { formatDuration, formatHHMM } from "@/core/time";
import type { Block, PlanningContext } from "@/core/types";
import { Chip, cx, LABEL_STYLE } from "./ui";

interface Props {
  block: Block;
  ctx: PlanningContext;
  /** いま進行中のブロック（当日モード） */
  inProgress?: boolean;
  /** 直近の変更でこのブロックが変わった */
  change?: DiffItem;
  handle?: ReactNode;
  /** 固定時刻ブロックの「出発すべき時刻」 */
  departure?: FixedDeparture;
  /** この予定にいないメンバー（特定メンバーだけの固定時刻で抜けたあと） */
  absent?: string[];
  onOpen: () => void;
}

/** 計画からのずれ（分）。遅延などで後ろにずれたら正 */
export function delayOf(block: Block): number {
  return block.plannedStartMin !== undefined && block.plannedStartMin > 0 ? block.startMin - block.plannedStartMin : 0;
}

/** 時間が足りなくて短縮される前の滞在時間（分）。短縮されていなければ undefined */
export function shortenedFrom(block: Block): number | undefined {
  if (block.plannedStartMin === undefined || block.plannedEndMin === undefined || block.plannedStartMin <= 0) return undefined;
  const planned = block.plannedEndMin - block.plannedStartMin;
  return block.label !== "buffer" && block.durationMin < planned ? planned : undefined;
}

export function AbsentChips({ names }: { names?: string[] }) {
  if (!names?.length) return null;
  return (
    <Chip className="bg-fuchsia-100 text-fuchsia-800" >
      <span data-testid="absent-chip">👤 {names.join("・")}不在</span>
    </Chip>
  );
}

export function BlockCard({ block, ctx, inProgress, change, handle, departure, absent, onOpen }: Props) {
  const spot = block.spotId ? ctx.spotById.get(block.spotId) : undefined;
  const planBSpot = block.planB ? ctx.spotById.get(block.planB.spotId) : undefined;
  const style = LABEL_STYLE[block.label];
  const skipped = block.skip === "skipped";
  const closed = !!block.closed;
  const inert = skipped || closed;
  const delay = delayOf(block);
  const ring = change ? "ring-2 ring-amber-400" : inProgress ? "ring-2 ring-brand-500" : "";

  /* ---- 固定時刻（鍵つき・動かせない） ---- */
  if (block.fixed) {
    const f = block.fixed;
    const missed = block.issues?.includes("fixed-missed");
    return (
      <div className={cx("rounded-2xl border-2 shadow-sm", style.card, inert && "opacity-60", missed && "border-rose-500", ring)} data-testid="block-fixed" data-block-id={block.id} data-start={block.startMin} data-end={block.endMin}>
        <div className="flex items-stretch">
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 px-3 py-2.5 text-left" aria-label={`${f.title} の詳細を開く`}>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 text-lg" aria-hidden>
                🔒
              </span>
              <h3 className={cx("flex-1 text-[15px] font-bold leading-snug text-slate-900", inert && "line-through")}>
                {FIXED_KIND_ICON[f.kind]} {f.title}
              </h3>
              <Chip className={style.chip}>{BLOCK_LABEL.fixed}</Chip>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              {FIXED_KIND_LABEL[f.kind]}・{spot?.name ?? f.place.name}・{formatHHMM(block.startMin)}
              {block.durationMin > 0 && `〜${formatHHMM(block.endMin)}`}
            </p>
            {departure && !inert && (
              <p className="mt-1.5 text-xs font-bold text-slate-800" data-testid="fixed-departure">
                🕑 {formatHHMM(departure.departBy)} までに{departure.pred ? `「${departure.predName}」` : departure.predName}を出発
                <span className="font-medium text-slate-500">（移動 約{departure.travelMin}分＋余裕{departure.marginMin}分）</span>
              </p>
            )}
            {missed && !inert && (
              <p className="mt-1 text-xs font-bold text-rose-700" data-testid="fixed-missed">
                ⚠ いまの予定のままでは間に合いません（あと{block.lateByMin ?? 0}分足りません）
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap gap-1">
              {f.endsDay && <Chip className="bg-slate-200 text-slate-700">この便でその日の予定は終わり</Chip>}
              <AbsentChips names={absent} />
            </div>
          </button>
          <div className="flex w-9 shrink-0 items-center justify-center rounded-r-2xl border-l border-slate-200 text-lg text-slate-500" title="固定時刻は動かせません" aria-label="固定（動かせません）" data-testid="fixed-lock">
            🔒
          </div>
        </div>
        {change && <ChangeNote item={change} ctx={ctx} />}
      </div>
    );
  }

  /* ---- 休憩（疲れたボタンで追加） ---- */
  if (block.label === "rest") {
    return (
      <div className={cx("rounded-2xl border shadow-sm", style.card, inert && "opacity-60", ring)} data-testid="block-rest" data-block-id={block.id} data-start={block.startMin} data-end={block.endMin}>
        <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
          <span className="text-xl">☕</span>
          <span className="flex-1">
            <span className="block text-sm font-bold text-amber-900">休憩{spot ? `：${spot.name}` : "（近くで）"}</span>
            <span className="block text-xs text-amber-800">
              {formatDuration(block.endMin - block.startMin)}
              {spot ? `・${SETTING_ICON[spot.setting]} ${SETTING_LABEL[spot.setting]}` : "・場所は決めていません"}
            </span>
            <span className="mt-0.5 flex flex-wrap gap-1">
              <AbsentChips names={absent} />
            </span>
          </span>
          <Chip className={style.chip}>{BLOCK_LABEL.rest}</Chip>
        </button>
        {change && <ChangeNote item={change} ctx={ctx} />}
      </div>
    );
  }

  if (!spot) {
    const minutes = block.endMin - block.startMin;
    return (
      <div className={cx("flex items-center gap-2 rounded-2xl border px-3 py-2.5", style.card, inert && "opacity-60", ring)} data-testid="block-buffer" data-block-id={block.id}>
        <button type="button" onClick={onOpen} className="flex flex-1 items-center gap-2 text-left">
          <span className="text-xl">☕</span>
          <span className="flex-1">
            <span className="block text-sm font-bold text-teal-800">余白（休憩・自由時間）</span>
            <span className="block text-xs text-teal-700">
              {formatDuration(minutes)}
              {minutes < block.durationMin && ` ／ 予定 ${formatDuration(block.durationMin)} から短縮（遅れを吸収）`}
            </span>
            <span className="mt-0.5 flex flex-wrap gap-1">
              <AbsentChips names={absent} />
            </span>
          </span>
          <Chip className={style.chip}>{BLOCK_LABEL.buffer}</Chip>
        </button>
        {handle}
      </div>
    );
  }

  const original = block.switched && planBSpot ? planBSpot : undefined;
  const shortFrom = shortenedFrom(block);

  return (
    <div
      className={cx("rounded-2xl border shadow-sm", style.card, inert && "opacity-60", ring)}
      data-testid="block-spot"
      data-block-id={block.id}
      data-spot-id={spot.id}
      data-setting={spot.setting}
      data-start={block.startMin}
      data-end={block.endMin}
      data-label={block.label}
      data-switched={block.switched ? "true" : undefined}
      data-skipped={skipped ? "true" : undefined}
    >
      <div className="flex items-stretch">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 px-3 py-2.5 text-left" aria-label={`${spot.name} の詳細を開く`}>
          <div className="flex items-start gap-2">
            <h3 className={cx("flex-1 text-[15px] font-bold leading-snug text-slate-900", inert && "line-through")}>{spot.name}</h3>
            <Chip className={style.chip}>{BLOCK_LABEL[block.label]}</Chip>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
            <span>
              {SETTING_ICON[spot.setting]} {SETTING_LABEL[spot.setting]}
            </span>
            <span>
              {CATEGORY_ICON[spot.category]} {CATEGORY_LABEL[spot.category]}
            </span>
            <span>🕒 {formatDuration(block.durationMin)}</span>
          </div>

          <div className="mt-1.5 flex flex-wrap gap-1">
            {inProgress && <Chip className="bg-brand-600 text-white">いま</Chip>}
            {block.switched && <Chip className="bg-emerald-100 text-emerald-800">🔁 Plan B に切替済み</Chip>}
            {closed && <Chip className="bg-rose-100 text-rose-700">⛔ 臨時休業</Chip>}
            {skipped && !closed && <Chip className="bg-slate-200 text-slate-600">スキップ</Chip>}
            {!inert && shortFrom && <Chip className="bg-sky-100 text-sky-800">✂ 滞在 {shortFrom}分 → {block.durationMin}分</Chip>}
            {!inert && delay > 0 && <Chip className="bg-amber-100 text-amber-800">⏱ +{delay}分 遅れ</Chip>}
            {!inert && block.issues?.includes("outside-hours") && <Chip className="bg-rose-100 text-rose-700">営業時間外の見込み</Chip>}
            {!inert && block.issues?.includes("after-last-transport") && <Chip className="bg-rose-100 text-rose-700">最終便のあと</Chip>}
            {!inert && block.issues?.includes("over-day-end") && !block.issues.includes("outside-hours") && (
              <Chip className="bg-amber-100 text-amber-800">終了予定時刻を超過</Chip>
            )}
            {!inert && block.crowdedOverlap && <Chip className="bg-orange-100 text-orange-700">👥 混雑しやすい時間帯</Chip>}
            <AbsentChips names={absent} />
          </div>

          {block.switched && original && (
            <p className="mt-1.5 text-xs text-emerald-800">
              元の予定：<span className="line-through">{original.name}</span>
            </p>
          )}
          {!block.switched && block.planB && planBSpot && !inert && (
            <p className="mt-1.5 text-xs text-emerald-800">
              ☂️ Plan B：<span className="font-semibold">{planBSpot.name}</span>
            </p>
          )}
          {block.planB === null && !inert && (
            <p className="mt-1.5 text-xs font-semibold text-amber-700" data-testid="no-planb-warning">
              ⚠ 雨の日の代わり（Plan B）が見つかっていません
            </p>
          )}
        </button>
        {handle}
      </div>
      {change && <ChangeNote item={change} ctx={ctx} />}
    </div>
  );
}

export function ChangeNote({ item, ctx }: { item: DiffItem; ctx: PlanningContext }) {
  const before = item.before.spotId ? ctx.spotById.get(item.before.spotId)?.name : undefined;
  const range = (s: { startMin: number; endMin: number }) => `${formatHHMM(s.startMin)}–${formatHHMM(s.endMin)}`;
  let text: string;
  switch (item.kind) {
    case "replaced":
      text = `${before ?? "予定"} → このスポットに変更`;
      break;
    case "shifted":
      text = `${range(item.before)} → ${range(item.after)}（${item.deltaMin > 0 ? "+" : ""}${item.deltaMin}分）`;
      break;
    case "shortened":
      text = `滞在 ${item.durationFrom}分 → ${item.durationTo}分に短縮`;
      break;
    case "moved":
      text = `順番を入れ替え（${range(item.before)} → ${range(item.after)}）`;
      break;
    case "inserted":
      text = "追加されました";
      break;
    case "buffer-changed":
      text = `余白 ${formatDuration(item.before.endMin - item.before.startMin)} → ${formatDuration(item.after.endMin - item.after.startMin)}`;
      break;
    case "skipped":
      text = "スキップしました";
      break;
    case "closed":
      text = "臨時休業のため実施できません";
      break;
    default:
      text = "元に戻しました";
  }
  return <div className="rounded-b-2xl border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-semibold text-amber-900">変更: {text}</div>;
}
