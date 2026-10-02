"use client";

import { findOpenSlot } from "@/core/availability";
import { AREA_LABEL, BLOCK_LABEL, CATEGORY_ICON, CATEGORY_LABEL, PRICE_LABEL, SETTING_ICON, SETTING_LABEL, travelLabel } from "@/core/labels";
import { mapsDirectionsUrl, mapsSearchUrl } from "@/core/maps";
import { formatDuration, formatHHMM, weekdayOf } from "@/core/time";
import type { Block, Day, PlanningContext, Spot } from "@/core/types";
import { delayOf } from "./BlockCard";
import { Button, Chip, LABEL_STYLE, Sheet } from "./ui";

export type DetailMode = "edit" | "live" | "view";

interface Props {
  open: boolean;
  onClose: () => void;
  block: Block | null;
  day: Day;
  ctx: PlanningContext;
  mode: DetailMode;
  /** 当日モードの現在時刻 */
  nowMin?: number;
  onSwitch?: (blockId: string) => void;
  onSkip?: (blockId: string) => void;
  onKeep?: (blockId: string) => void;
  onMove?: (blockId: string, dir: -1 | 1) => void;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-slate-100 py-1.5 text-sm last:border-0">
      <dt className="w-24 shrink-0 text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="flex-1 text-slate-800">{children}</dd>
    </div>
  );
}

function SpotFacts({ spot }: { spot: Spot }) {
  return (
    <dl className="rounded-xl border border-slate-200 bg-white px-3">
      <Row label="エリア">{AREA_LABEL[spot.area]}</Row>
      <Row label="営業時間">
        {spot.hours.map((h) => `${h.open}〜${h.close}`).join(" / ")}
        {spot.closedDays?.length ? <span className="text-rose-600">（定休日：{spot.closedDays.map((d) => WEEKDAY_JA[d]).join("・")}）</span> : null}
      </Row>
      <Row label="平均滞在時間">{formatDuration(spot.stayMin)}</Row>
      <Row label="価格帯">{PRICE_LABEL[spot.priceLevel]}</Row>
      <Row label="混雑しやすい時間">{spot.crowded?.length ? spot.crowded.map((c) => `${c.open}〜${c.close}`).join(" / ") : "特になし"}</Row>
    </dl>
  );
}

export function BlockDetailSheet({ open, onClose, block, day, ctx, mode, nowMin, onSwitch, onSkip, onKeep, onMove }: Props) {
  if (!block) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;

  const spot = block.spotId ? ctx.spotById.get(block.spotId) : undefined;
  const planBSpot = block.planB ? ctx.spotById.get(block.planB.spotId) : undefined;
  const index = day.blocks.findIndex((b) => b.id === block.id);
  const delay = delayOf(block);
  const started = nowMin !== undefined && block.startMin <= nowMin;
  const inert = block.skip === "skipped" || !!block.closed;

  /* ---- 余白 ---- */
  if (!spot) {
    return (
      <Sheet open={open} onClose={onClose} title="余白（休憩・自由時間）" testId="detail-sheet">
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            {formatHHMM(block.startMin)}〜{formatHHMM(block.endMin)}（{formatDuration(block.endMin - block.startMin)}）
          </p>
          <p className="rounded-xl bg-teal-50 p-3 text-sm leading-relaxed text-teal-900">
            休憩や自由行動のための時間です。電車の遅れなどが起きたときは、この余白が先に縮んで後ろの予定を守ります。
          </p>
          {mode === "edit" && <MoveButtons index={index} total={day.blocks.length} onMove={(d) => onMove?.(block.id, d)} />}
        </div>
      </Sheet>
    );
  }

  const planBSlot = planBSpot ? findOpenSlot(planBSpot, day.date, block.startMin, block.planB!.durationMin) : null;
  const isIndoor = spot.setting === "indoor";

  return (
    <Sheet open={open} onClose={onClose} title={spot.name} testId="detail-sheet">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip className={LABEL_STYLE[block.label].chip}>{BLOCK_LABEL[block.label]}</Chip>
          <Chip className="bg-slate-100 text-slate-700">
            {SETTING_ICON[spot.setting]} {SETTING_LABEL[spot.setting]}
          </Chip>
          <Chip className="bg-slate-100 text-slate-700">
            {CATEGORY_ICON[spot.category]} {CATEGORY_LABEL[spot.category]}
          </Chip>
          {block.switched && <Chip className="bg-emerald-100 text-emerald-800">🔁 Plan B に切替済み</Chip>}
          {block.skip === "candidate" && <Chip className="bg-amber-100 text-amber-800">⏭ スキップ候補</Chip>}
          {block.skip === "skipped" && <Chip className="bg-slate-200 text-slate-600">スキップ</Chip>}
          {block.closed && <Chip className="bg-rose-100 text-rose-700">⛔ 臨時休業</Chip>}
        </div>

        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-lg font-bold tabular-nums text-slate-900">
            {formatHHMM(block.startMin)}〜{formatHHMM(block.endMin)}
            <span className="ml-2 text-sm font-semibold text-slate-500">（滞在 {formatDuration(block.durationMin)}）</span>
          </p>
          {delay > 0 && !inert && <p className="mt-0.5 text-xs font-semibold text-amber-700">⏱ 計画より {delay}分 遅れています（元の予定 {formatHHMM(block.plannedStartMin!)}）</p>}
          {block.travelMin > 0 && !inert && (
            <p className="mt-0.5 text-xs text-slate-600">
              前の場所から {travelLabel(block.travelMode, block.travelMin)}
              <a className="ml-2 font-semibold text-brand-700 underline" href={mapsDirectionsUrl(spot, block.travelMode === "none" ? "transit" : block.travelMode)} target="_blank" rel="noopener noreferrer">
                経路を開く
              </a>
            </p>
          )}
          {block.crowdedOverlap && <p className="mt-0.5 text-xs font-semibold text-orange-700">👥 混雑しやすい時間帯に重なっています</p>}
          {block.issues?.includes("outside-hours") && !inert && <p className="mt-0.5 text-xs font-semibold text-rose-700">この時刻は営業時間外になる見込みです（{WEEKDAY_JA[weekdayOf(day.date)]}曜）</p>}
        </div>

        <p className="text-sm leading-relaxed text-slate-700">{spot.description}</p>
        <SpotFacts spot={spot} />

        <a
          href={mapsSearchUrl(spot)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="open-maps"
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-[15px] font-semibold text-white hover:bg-brand-700"
        >
          📍 Google Mapsで開く
        </a>

        {/* ---- Plan B ---- */}
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3" data-testid="planb-section">
          <h3 className="mb-1.5 text-sm font-bold text-emerald-900">☂️ Plan B（雨・遅延のときの代わり）</h3>

          {isIndoor && !block.switched && <p className="text-sm text-emerald-900">屋内の予定なので、雨でもそのまま楽しめます。Plan B は不要です。</p>}

          {block.planB && planBSpot && (
            <div className="space-y-2">
              <div className="rounded-xl border border-emerald-200 bg-white p-3">
                <p className="text-[11px] font-semibold text-emerald-700">{block.switched ? "元の予定（戻せます）" : "屋内の代わりの予定"}</p>
                <p className="text-[15px] font-bold text-slate-900">{planBSpot.name}</p>
                <p className="mt-0.5 text-xs text-slate-600">
                  {SETTING_ICON[planBSpot.setting]} {SETTING_LABEL[planBSpot.setting]}・{CATEGORY_ICON[planBSpot.category]} {CATEGORY_LABEL[planBSpot.category]}・滞在 約{formatDuration(block.planB.durationMin)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {block.planB.reason}（直線 約{(block.planB.distanceM / 1000).toFixed(1)}km）
                </p>
                {!block.switched && planBSlot && (
                  <p className="mt-1 text-xs text-slate-500">
                    {formatHHMM(block.startMin)} 開始で営業中（{planBSpot.hours.map((h) => `${h.open}〜${h.close}`).join(" / ")}）
                  </p>
                )}
                <a
                  href={mapsSearchUrl(planBSpot)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 inline-block text-xs font-semibold text-brand-700 underline"
                >
                  Plan B を Google Mapsで開く
                </a>
              </div>
              {mode !== "view" && !inert && (
                <Button variant={block.switched ? "secondary" : "emerald"} className="w-full" data-testid="switch-planb" onClick={() => onSwitch?.(block.id)}>
                  {block.switched ? "元の予定に戻す" : "Plan B に切り替える"}
                </Button>
              )}
            </div>
          )}

          {block.planB === null && (
            <p className="text-sm font-semibold text-amber-800">
              ⚠ この時間帯に営業していて、2km以内にある屋内スポットが見つかりませんでした。雨の場合は予定の変更を検討してください。
            </p>
          )}
        </section>

        {/* ---- 当日モードの操作 ---- */}
        {mode === "live" && (
          <section className="flex flex-wrap gap-2">
            {block.skip === "candidate" && (
              <Button variant="secondary" className="flex-1" onClick={() => onKeep?.(block.id)} data-testid="keep-block">
                それでも行く
              </Button>
            )}
            {!inert && !(started && block.endMin <= (nowMin ?? 0)) && block.label !== "buffer" && (
              <Button variant="secondary" className="flex-1" onClick={() => onSkip?.(block.id)} data-testid="skip-block">
                この予定をスキップ
              </Button>
            )}
          </section>
        )}

        {mode === "edit" && <MoveButtons index={index} total={day.blocks.length} onMove={(d) => onMove?.(block.id, d)} />}
      </div>
    </Sheet>
  );
}

function MoveButtons({ index, total, onMove }: { index: number; total: number; onMove: (dir: -1 | 1) => void }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-slate-500">順番を入れ替える（時刻は自動で計算し直されます）</p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" disabled={index <= 0} onClick={() => onMove(-1)} data-testid="move-up">
          ↑ 前へ
        </Button>
        <Button variant="secondary" disabled={index >= total - 1} onClick={() => onMove(1)} data-testid="move-down">
          ↓ 後ろへ
        </Button>
      </div>
    </div>
  );
}
