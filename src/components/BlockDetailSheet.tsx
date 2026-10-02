"use client";

import { findOpenSlot } from "@/core/availability";
import { fixedDeparture } from "@/core/fixed";
import {
  AREA_LABEL,
  BLOCK_LABEL,
  CATEGORY_ICON,
  CATEGORY_LABEL,
  FIXED_KIND_ICON,
  FIXED_KIND_LABEL,
  PRICE_LABEL,
  SETTING_ICON,
  SETTING_LABEL,
  travelLabel,
} from "@/core/labels";
import { mapsDirectionsUrl, mapsSearchUrl } from "@/core/maps";
import { formatDuration, formatHHMM, weekdayOf } from "@/core/time";
import type { Block, Day, PlanningContext, Spot } from "@/core/types";
import { delayOf, shortenedFrom } from "./BlockCard";
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
  marginMin?: number;
  /** 不在のメンバー（特定メンバーだけの固定時刻で抜けたあと） */
  absent?: string[];
  onSwitch?: (blockId: string) => void;
  onSkip?: (blockId: string) => void;
  onRestore?: (blockId: string) => void;
  onRemoveFixed?: (blockId: string) => void;
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
      {spot.dataNote && (
        <div className="py-2 text-xs font-semibold text-amber-800" data-testid="spot-data-note">
          ※ {spot.dataNote}
        </div>
      )}
    </dl>
  );
}

export function BlockDetailSheet({ open, onClose, block, day, ctx, mode, nowMin, marginMin = 10, absent, onSwitch, onSkip, onRestore, onRemoveFixed, onMove }: Props) {
  if (!block) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;

  const spot = block.spotId ? ctx.spotById.get(block.spotId) : undefined;
  const planBSpot = block.planB ? ctx.spotById.get(block.planB.spotId) : undefined;
  const index = day.blocks.findIndex((b) => b.id === block.id);
  const delay = delayOf(block);
  const shortFrom = shortenedFrom(block);
  const started = nowMin !== undefined && block.startMin <= nowMin;
  const inert = block.skip === "skipped" || !!block.closed;
  const absentNote = absent?.length ? (
    <p className="rounded-lg bg-fuchsia-50 px-3 py-2 text-xs font-semibold text-fuchsia-900">👤 {absent.join("・")}不在（固定時刻のため、先にグループを抜けています）</p>
  ) : null;

  /* ---- 固定時刻 ---- */
  if (block.fixed) {
    const f = block.fixed;
    const d = fixedDeparture(day, index, ctx, marginMin);
    const missed = block.issues?.includes("fixed-missed");
    return (
      <Sheet open={open} onClose={onClose} title={`🔒 ${f.title}`} testId="detail-sheet">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <Chip className={LABEL_STYLE.fixed.chip}>{BLOCK_LABEL.fixed}</Chip>
            <Chip className="bg-slate-100 text-slate-700">
              {FIXED_KIND_ICON[f.kind]} {FIXED_KIND_LABEL[f.kind]}
            </Chip>
            {f.endsDay && <Chip className="bg-slate-200 text-slate-700">この便でその日の予定は終わり</Chip>}
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-lg font-bold tabular-nums text-slate-900">
              {formatHHMM(f.timeMin)}
              {f.durationMin > 0 && <span className="text-sm font-semibold text-slate-500">〜{formatHHMM(f.timeMin + f.durationMin)}</span>}
            </p>
            <p className="text-sm text-slate-700">{spot?.name ?? f.place.name}</p>
            {d && (
              <p className="mt-1 text-sm font-bold text-slate-900" data-testid="detail-departby">
                🕑 {formatHHMM(d.departBy)} までに「{d.predName}」を出発
                <span className="block text-xs font-medium text-slate-500">
                  = 固定時刻 {formatHHMM(f.timeMin)} − 移動 {d.travelMin}分 − 余裕 {d.marginMin}分
                </span>
              </p>
            )}
            {missed && <p className="mt-1 text-xs font-bold text-rose-700">⚠ いまの予定のままでは間に合いません（あと{block.lateByMin ?? 0}分足りません）</p>}
          </div>
          <p className="text-xs leading-relaxed text-slate-600">固定時刻は動かせません。遅延・Plan B 切り替え・疲れたボタンで予定がずれても、この時刻に間に合うよう組み直します。</p>
          {absentNote}
          <a href={mapsSearchUrl({ name: f.place.name, lat: f.place.lat, lng: f.place.lng })} target="_blank" rel="noopener noreferrer" data-testid="open-maps" className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-[15px] font-semibold text-white hover:bg-brand-700">
            📍 Google Mapsで開く
          </a>
          {mode !== "view" && (
            <Button variant="secondary" className="w-full" onClick={() => onRemoveFixed?.(block.id)} data-testid="remove-fixed">
              この固定時刻を外す
            </Button>
          )}
        </div>
      </Sheet>
    );
  }

  /* ---- 休憩 ---- */
  if (block.label === "rest") {
    return (
      <Sheet open={open} onClose={onClose} title={spot ? `休憩：${spot.name}` : "休憩（近くで）"} testId="detail-sheet">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <Chip className={LABEL_STYLE.rest.chip}>{BLOCK_LABEL.rest}</Chip>
          </div>
          <p className="text-lg font-bold tabular-nums text-slate-900">
            {formatHHMM(block.startMin)}〜{formatHHMM(block.endMin)}
            <span className="ml-2 text-sm font-semibold text-slate-500">（{formatDuration(block.endMin - block.startMin)}）</span>
          </p>
          <p className="rounded-xl bg-amber-50 p-3 text-sm leading-relaxed text-amber-900">
            「疲れた」などで入れた休憩です。休憩は保護されるので、時間が足りなくなっても、標準・Optional の予定が先に削られます。
          </p>
          {spot && (
            <>
              <p className="text-sm text-slate-700">{spot.description}</p>
              <SpotFacts spot={spot} />
              <a href={mapsSearchUrl(spot)} target="_blank" rel="noopener noreferrer" data-testid="open-maps" className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-[15px] font-semibold text-white hover:bg-brand-700">
                📍 Google Mapsで開く
              </a>
            </>
          )}
          {absentNote}
        </div>
      </Sheet>
    );
  }

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
          {absentNote}
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
          {block.skip === "skipped" && <Chip className="bg-slate-200 text-slate-600">スキップ</Chip>}
          {block.closed && <Chip className="bg-rose-100 text-rose-700">⛔ 臨時休業</Chip>}
        </div>

        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-lg font-bold tabular-nums text-slate-900">
            {formatHHMM(block.startMin)}〜{formatHHMM(block.endMin)}
            <span className="ml-2 text-sm font-semibold text-slate-500">（滞在 {formatDuration(block.durationMin)}）</span>
          </p>
          {shortFrom && !inert && <p className="mt-0.5 text-xs font-semibold text-sky-800">✂ 時間が足りないため、滞在を {shortFrom}分 → {block.durationMin}分 に短縮しています</p>}
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
          {block.issues?.includes("after-last-transport") && !inert && <p className="mt-0.5 text-xs font-semibold text-rose-700">最終便のあとになるため、実施できません</p>}
        </div>

        {absentNote}

        <p className="text-sm leading-relaxed text-slate-700">{spot.description}</p>
        <SpotFacts spot={spot} />

        <a href={mapsSearchUrl(spot)} target="_blank" rel="noopener noreferrer" data-testid="open-maps" className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-[15px] font-semibold text-white hover:bg-brand-700">
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
                <a href={mapsSearchUrl(planBSpot)} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-block text-xs font-semibold text-brand-700 underline">
                  Plan B を Google Mapsで開く
                </a>
              </div>
              {mode !== "view" && !inert && (
                <Button variant={block.switched ? "secondary" : "emerald"} className="w-full" data-testid="switch-planb" onClick={() => onSwitch?.(block.id)}>
                  {block.switched ? "元の予定に戻す案を見る" : "Plan B に切り替える案を見る"}
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
            {block.skip === "skipped" && !block.closed && (
              <Button variant="secondary" className="flex-1" onClick={() => onRestore?.(block.id)} data-testid="restore-block">
                スキップを取り消す案を見る
              </Button>
            )}
            {!inert && !(started && block.endMin <= (nowMin ?? 0)) && (
              <Button variant="secondary" className="flex-1" onClick={() => onSkip?.(block.id)} data-testid="skip-block">
                この予定をスキップする案を見る
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
