"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { canReorder } from "@/core/actions";
import type { DiffItem } from "@/core/diff";
import { absenceByBlock, allFixedDepartures, memberFixedStatuses, type MemberFixedStatus } from "@/core/fixed";
import { travelLabel } from "@/core/labels";
import { mapsDirectionsUrl } from "@/core/maps";
import { restKind } from "@/core/replan";
import { isInert } from "@/core/schedule";
import { formatDuration, formatHHMM } from "@/core/time";
import type { Block, Day, Member, PlanningContext } from "@/core/types";
import { BlockCard } from "./BlockCard";
import { cx, LABEL_STYLE } from "./ui";

interface Props {
  day: Day;
  ctx: PlanningContext;
  onOpen: (blockId: string) => void;
  /** 指定すると、ドラッグで並べ替えられる（旅程画面） */
  onReorder?: (from: number, to: number) => void;
  /** 並べ替えできない移動（固定時刻をまたぐ など）をしたとき */
  onBlocked?: (reason: string) => void;
  /** 当日モードの現在時刻 */
  nowMin?: number;
  changes?: Map<string, DiffItem>;
  members?: Member[];
  /** 固定時刻の余裕時間（分） */
  marginMin?: number;
}

function DragHandle({ attributes, listeners }: { attributes: object; listeners?: object }) {
  return (
    <button
      type="button"
      aria-label="ドラッグして並べ替え"
      data-testid="drag-handle"
      className="flex w-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-r-2xl border-l border-slate-100 text-lg text-slate-400 hover:bg-slate-50 active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      ⠿
    </button>
  );
}

function Connector({ block, prevEnd, day, ctx }: { block: Block; prevEnd: number; day: Day; ctx: PlanningContext }) {
  const place = block.spotId ? ctx.spotById.get(block.spotId) : block.place;
  if (!place || block.skip === "skipped" || block.closed) return null;
  const slack = block.startMin - prevEnd - block.travelMin;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-1 text-[11px] text-slate-500">
      {block.travelMin > 0 && (
        <a
          href={mapsDirectionsUrl({ name: place.name, lat: place.lat, lng: place.lng }, block.travelMode === "none" ? "transit" : block.travelMode)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600 hover:bg-slate-200"
        >
          {block.travelMode === "walk" ? "🚶" : "🚃"} {travelLabel(block.travelMode, block.travelMin)}
        </a>
      )}
      {slack >= 20 && !block.fixed && <span className="text-teal-700">空き時間 約{formatDuration(slack)}</span>}
      {day.blocks[0]?.id === block.id && <span>出発地：{day.origin.name}</span>}
    </div>
  );
}

function Row({
  block,
  index,
  day,
  ctx,
  nowMin,
  changes,
  onOpen,
  sortable,
  absent,
  departure,
}: {
  block: Block;
  index: number;
  day: Day;
  ctx: PlanningContext;
  nowMin?: number;
  changes?: Map<string, DiffItem>;
  onOpen: (id: string) => void;
  sortable: boolean;
  absent?: string[];
  departure?: ReturnType<typeof allFixedDepartures> extends Map<string, infer V> ? V : never;
}) {
  const locked = !!block.fixed;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: !sortable || locked });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const prev = index > 0 ? day.blocks.slice(0, index).reverse().find((b) => !isInert(b)) : undefined;
  const prevEnd = prev ? prev.endMin : day.startMin;
  const inert = isInert(block);
  const inProgress = nowMin !== undefined && !inert && block.startMin <= nowMin && nowMin < block.endMin;
  const dot = LABEL_STYLE[block.label].dot;

  return (
    <li ref={setNodeRef} style={style} className={cx("relative pb-3 pl-[68px]", isDragging && "z-20 opacity-90")} data-testid="timeline-row">
      <div className="absolute left-0 top-2.5 w-[52px] text-right leading-tight">
        <div className={cx("text-[13px] font-bold tabular-nums text-slate-900", inert && "text-slate-400 line-through")}>{formatHHMM(block.startMin)}</div>
        {block.endMin > block.startMin && <div className="text-[11px] tabular-nums text-slate-400">{formatHHMM(block.endMin)}</div>}
      </div>
      <span className="absolute left-[59px] top-0 h-full w-px bg-slate-200" aria-hidden />
      <span className={cx("absolute left-[55px] top-4 size-[9px] rounded-full ring-2 ring-slate-50", dot)} aria-hidden />
      <Connector block={block} prevEnd={prevEnd} day={day} ctx={ctx} />
      <div className={cx(isDragging && "shadow-xl")}>
        <BlockCard
          block={block}
          ctx={ctx}
          inProgress={inProgress}
          change={changes?.get(block.id)}
          departure={departure}
          absent={absent}
          restMode={restKind(day, index, ctx)}
          onOpen={() => onOpen(block.id)}
          handle={sortable && !locked && block.label !== "rest" ? <DragHandle attributes={attributes} listeners={listeners} /> : undefined}
        />
      </div>
    </li>
  );
}

/** 当日モードで「いま」の位置に出す目印 */
function NowMarker({ nowMin }: { nowMin: number }) {
  return (
    <li className="relative pb-3 pl-[68px]" aria-label="現在時刻" data-testid="now-marker">
      <div className="absolute left-0 top-0 w-[52px] text-right text-[13px] font-bold tabular-nums text-brand-700">{formatHHMM(nowMin)}</div>
      <span className="absolute left-[59px] top-0 h-full w-px bg-brand-300" aria-hidden />
      <span className="absolute left-[53px] top-1.5 size-[13px] rounded-full bg-brand-600 ring-4 ring-brand-100" aria-hidden />
      <div className="h-px translate-y-2 bg-brand-300" />
    </li>
  );
}

/** 特定メンバーだけの固定時刻のため、グループから抜けるタイミングの目印 */
function MemberLeaveMarker({ status }: { status: MemberFixedStatus }) {
  const names = status.memberNames.join("・");
  return (
    <li className="relative pb-3 pl-[68px]" data-testid="member-fixed-marker">
      <span className="absolute left-[59px] top-0 h-full w-px bg-fuchsia-200" aria-hidden />
      <span className="absolute left-[53px] top-2 size-[13px] rounded-full bg-fuchsia-500 ring-4 ring-fuchsia-100" aria-hidden />
      <div className="rounded-xl border border-fuchsia-300 bg-fuchsia-50 px-3 py-2 text-xs text-fuchsia-900">
        <p className="font-bold">
          🔒 {names}：{status.event.title}（{formatHHMM(status.event.timeMin)}）
        </p>
        <p className="mt-0.5">
          {formatHHMM(status.departBy)} までにグループを出発 → このあとの予定は <strong>{names}不在</strong>
        </p>
      </div>
    </li>
  );
}

export function Timeline({ day, ctx, onOpen, onReorder, onBlocked, nowMin, changes, members = [], marginMin = 10 }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortable = !!onReorder;

  const handleDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = day.blocks.findIndex((b) => b.id === e.active.id);
    const to = day.blocks.findIndex((b) => b.id === e.over!.id);
    if (from < 0 || to < 0) return;
    const check = canReorder(day, from, to);
    if (!check.ok) {
      if (check.reason) onBlocked?.(check.reason);
      return;
    }
    onReorder?.(from, to);
  };

  if (!day.blocks.length) {
    return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">この日の予定はありません。</p>;
  }

  const departures = allFixedDepartures(day, ctx, marginMin);
  const statuses = memberFixedStatuses(day, ctx, marginMin, members);
  const absence = absenceByBlock(statuses);

  const markerBefore = nowMin !== undefined ? day.blocks.findIndex((b) => !isInert(b) && b.startMin > nowMin) : -1;
  const markerAtEnd = nowMin !== undefined && markerBefore === -1;

  const nodes: React.ReactNode[] = [];
  // 最初のブロックから不在になるメンバー
  for (const s of statuses.filter((x) => !x.leaveAfterBlockId)) nodes.push(<MemberLeaveMarker key={`leave-${s.event.id}`} status={s} />);
  day.blocks.forEach((b, i) => {
    if (nowMin !== undefined && i === markerBefore) nodes.push(<NowMarker key="now" nowMin={nowMin} />);
    nodes.push(
      <Row
        key={b.id}
        block={b}
        index={i}
        day={day}
        ctx={ctx}
        nowMin={nowMin}
        changes={changes}
        onOpen={onOpen}
        sortable={sortable}
        absent={absence.get(b.id)}
        departure={departures.get(b.id)}
      />,
    );
    for (const s of statuses.filter((x) => x.leaveAfterBlockId === b.id)) nodes.push(<MemberLeaveMarker key={`leave-${s.event.id}`} status={s} />);
  });
  if (markerAtEnd && nowMin !== undefined) nodes.push(<NowMarker key="now" nowMin={nowMin} />);

  const list = (
    <ol className="relative" data-testid="timeline">
      {nodes}
    </ol>
  );

  if (!sortable) return list;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={day.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        {list}
      </SortableContext>
    </DndContext>
  );
}
