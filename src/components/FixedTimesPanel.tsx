"use client";

import { useMemo, useState } from "react";
import {
  allFixedDepartures,
  FIXED_DEFAULT_DURATION,
  FIXED_ENDS_DAY,
  FIXED_PLACES,
  FIXED_PRESET_DISCLAIMER,
  FIXED_PRESETS,
  fixedTitle,
  memberFixedStatuses,
} from "@/core/fixed";
import { FIXED_KIND_ICON, FIXED_KIND_LABEL } from "@/core/labels";
import type { ReplanEvent } from "@/core/replan";
import { isInert } from "@/core/schedule";
import { formatDateJa, formatHHMM, parseHHMM } from "@/core/time";
import type { FixedEvent, FixedKind, Itinerary, Member, Origin, PlanningContext } from "@/core/types";
import { Button, cx, Sheet } from "./ui";

/* ---------- メンバー ---------- */

/** メンバーの名前を編集する。固定時刻を特定のメンバーだけに設定するときに使う */
export function MembersCard({ members, onChange }: { members: Member[]; onChange: (members: Member[]) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" data-testid="members-card">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-bold text-slate-800">👥 メンバー</h2>
        <button type="button" onClick={() => setEditing((e) => !e)} className="text-xs font-semibold text-brand-700 underline" data-testid="members-edit">
          {editing ? "閉じる" : "名前を編集"}
        </button>
      </div>
      {!editing ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {members.map((m) => (
            <span key={m.id} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
              {m.name}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {members.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <input
                value={m.name}
                maxLength={8}
                onChange={(e) => onChange(members.map((x) => (x.id === m.id ? { ...x, name: e.target.value || "名前" } : x)))}
                className="min-h-10 flex-1 rounded-lg border border-slate-300 px-3 text-sm"
                aria-label="メンバーの名前"
              />
              {members.length > 1 && (
                <button type="button" onClick={() => onChange(members.filter((x) => x.id !== m.id))} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm text-slate-600" aria-label={`${m.name} を外す`}>
                  外す
                </button>
              )}
            </div>
          ))}
          {members.length < 6 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const used = new Set(members.map((m) => m.id));
                let n = members.length + 1;
                while (used.has(`m${n}`)) n++;
                onChange([...members, { id: `m${n}`, name: `${String.fromCharCode(64 + Math.min(n, 26))}さん` }]);
              }}
            >
              ＋ メンバーを追加
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------- 固定時刻の登録 ---------- */

interface DialogProps {
  open: boolean;
  onClose: () => void;
  itinerary: Itinerary;
  ctx: PlanningContext;
  dayIndex: number;
  onSubmit: (fixed: FixedEvent) => void;
}

const KINDS = Object.keys(FIXED_KIND_LABEL) as FixedKind[];

export function FixedEventDialog({ open, onClose, itinerary, ctx, dayIndex, onSubmit }: DialogProps) {
  const members = itinerary.members;
  const [tab, setTab] = useState<"preset" | "custom">("preset");
  const [target, setTarget] = useState<string[]>([]); // 空 = 全員
  const [kind, setKind] = useState<FixedKind>("last-transport");
  const [time, setTime] = useState("20:30");
  const [placeKey, setPlaceKey] = useState("p:0");
  const [duration, setDuration] = useState<number>(FIXED_DEFAULT_DURATION["last-transport"]);
  const [day, setDay] = useState(dayIndex);

  const places = useMemo(() => {
    const map = new Map<string, Origin & { spotId?: string }>();
    FIXED_PLACES.forEach((p, i) => map.set(`p:${i}`, p));
    for (const s of ctx.spots) map.set(`s:${s.id}`, { name: s.name, lat: s.lat, lng: s.lng, spotId: s.id });
    return map;
  }, [ctx.spots]);

  const memberIds = target.length === 0 || target.length === members.length ? null : target;
  const targetNames = (memberIds ?? []).map((id) => members.find((m) => m.id === id)?.name).filter(Boolean).join("・");
  const toggleMember = (id: string) => setTarget((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  const submitPreset = (i: number) => {
    const p = FIXED_PRESETS[i];
    onSubmit({
      id: "",
      kind: p.kind,
      title: p.title,
      timeMin: p.timeMin,
      dayIndex: day,
      place: p.place,
      durationMin: FIXED_DEFAULT_DURATION[p.kind],
      endsDay: FIXED_ENDS_DAY[p.kind],
      memberIds,
    });
  };

  const submitCustom = () => {
    const place = places.get(placeKey) ?? FIXED_PLACES[0];
    const timeMin = parseHHMM(time);
    const base = fixedTitle(kind, place.name, timeMin);
    onSubmit({
      id: "",
      kind,
      title: base,
      timeMin,
      dayIndex: day,
      place: { name: place.name, lat: place.lat, lng: place.lng },
      spotId: (place as { spotId?: string }).spotId,
      durationMin: Math.max(0, duration),
      endsDay: FIXED_ENDS_DAY[kind],
      memberIds,
    });
  };

  return (
    <Sheet open={open} onClose={onClose} title="固定時刻を追加" testId="fixed-dialog">
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-slate-600">
          終電・予約など「絶対に守る時刻」です。ブロックは鍵つきで動かせず、遅延や休憩があっても間に合うよう組み直します。
        </p>

        {itinerary.days.length > 1 && (
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="日">
            {itinerary.days.map((d) => (
              <button
                key={d.index}
                type="button"
                role="radio"
                aria-checked={day === d.index}
                onClick={() => setDay(d.index)}
                className={cx("min-h-10 rounded-xl border text-sm font-bold", day === d.index ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-700")}
              >
                {d.index + 1}日目 {formatDateJa(d.date)}
              </button>
            ))}
          </div>
        )}

        {members.length > 1 && (
          <div data-testid="fixed-target">
            <p className="mb-1 text-xs font-bold text-slate-600">対象メンバー</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setTarget([])}
                aria-pressed={target.length === 0}
                data-testid="fixed-target-all"
                className={cx("min-h-9 rounded-full border px-3 text-xs font-bold", target.length === 0 ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 text-slate-700")}
              >
                全員
              </button>
              {members.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleMember(m.id)}
                  aria-pressed={target.includes(m.id)}
                  data-testid={`fixed-target-${m.id}`}
                  className={cx("min-h-9 rounded-full border px-3 text-xs font-bold", target.includes(m.id) ? "border-fuchsia-600 bg-fuchsia-600 text-white" : "border-slate-300 text-slate-700")}
                >
                  {m.name}だけ
                </button>
              ))}
            </div>
            {memberIds && <p className="mt-1 text-[11px] text-fuchsia-800">{targetNames}だけの固定時刻です。グループの予定は動かさず、抜けたあとの予定を「{targetNames}不在」と表示します。</p>}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2" role="tablist">
          {(["preset", "custom"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              data-testid={`fixed-tab-${t}`}
              className={cx("min-h-10 rounded-xl border text-sm font-bold", tab === t ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-700")}
            >
              {t === "preset" ? "最終便の例から選ぶ" : "自分で入力"}
            </button>
          ))}
        </div>

        {tab === "preset" ? (
          <div className="space-y-2" data-testid="fixed-presets">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">{FIXED_PRESET_DISCLAIMER}</p>
            {FIXED_PRESETS.map((p, i) => (
              <div key={p.id} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex-1">
                  <p className="text-sm font-bold text-slate-900">
                    {FIXED_KIND_ICON[p.kind]} {p.title}
                  </p>
                  <p className="text-[11px] text-slate-500">{p.note}</p>
                </div>
                <Button size="sm" onClick={() => submitPreset(i)} data-testid={`fixed-preset-${p.id}`}>
                  登録
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3" data-testid="fixed-custom">
            <label className="block text-xs font-bold text-slate-600">
              種類
              <select
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as FixedKind;
                  setKind(k);
                  setDuration(FIXED_DEFAULT_DURATION[k]);
                }}
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold"
                data-testid="fixed-kind"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {FIXED_KIND_ICON[k]} {FIXED_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-600">
              時刻
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm font-semibold" data-testid="fixed-time" />
            </label>
            <label className="block text-xs font-bold text-slate-600">
              場所
              <select value={placeKey} onChange={(e) => setPlaceKey(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold" data-testid="fixed-place">
                <optgroup label="駅・空港">
                  {FIXED_PLACES.map((p, i) => (
                    <option key={p.name} value={`p:${i}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="スポット">
                  {ctx.spots.map((s) => (
                    <option key={s.id} value={`s:${s.id}`}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            {kind !== "last-transport" && (
              <label className="block text-xs font-bold text-slate-600">
                その場所での所要時間（分）
                <input type="number" min={0} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm font-semibold" />
              </label>
            )}
            <p className="text-[11px] text-slate-500">
              {FIXED_ENDS_DAY[kind] ? "この便に乗ったら、その日の予定は終わりになります。" : "その場所に着いたあとも、予定は続きます。"}
            </p>
            <Button className="w-full" onClick={submitCustom} data-testid="fixed-submit">
              固定時刻として登録
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/* ---------- 一覧・余裕時間 ---------- */

interface PanelProps {
  itinerary: Itinerary;
  ctx: PlanningContext;
  dayIndex: number;
  /** 固定時刻の追加・削除・余裕時間の変更は、再計画エンジンの提案として呼び出し側で扱う */
  onPropose: (event: ReplanEvent) => void;
}

/** 固定時刻の一覧と、追加・削除・余裕時間（初期値10分）の設定 */
export function FixedTimesPanel({ itinerary, ctx, dayIndex, onPropose }: PanelProps) {
  const [open, setOpen] = useState(false);
  const day = itinerary.days[dayIndex];
  const margin = itinerary.settings.marginMin;
  const departures = allFixedDepartures(day, ctx, margin);
  const statuses = memberFixedStatuses(day, ctx, margin, itinerary.members);
  const groupFixed = day.blocks.filter((b) => b.fixed && !isInert(b));

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" data-testid="fixed-panel">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-bold text-slate-800">🔒 固定時刻（絶対に守る時刻）</h2>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="fixed-add">
          ＋ 追加
        </Button>
      </div>

      {groupFixed.length === 0 && statuses.length === 0 && (
        <p className="mt-1.5 text-xs text-slate-500">終電・最終バス、宿のチェックイン、予約、レンタカー返却、集合などを登録すると、出発すべき時刻を逆算します。</p>
      )}

      <ul className="mt-2 space-y-1.5">
        {groupFixed.map((b) => {
          const d = departures.get(b.id);
          return (
            <li key={b.id} className="flex items-start gap-2 rounded-xl bg-slate-50 p-2.5 text-[13px]" data-testid="fixed-item">
              <span className="text-lg">{FIXED_KIND_ICON[b.fixed!.kind]}</span>
              <span className="flex-1">
                <strong className="block text-slate-900">{b.fixed!.title}</strong>
                <span className="block text-[11px] text-slate-500">全員・{FIXED_KIND_LABEL[b.fixed!.kind]}</span>
                {d && (
                  <span className="block text-[11px] font-semibold text-slate-700">
                    {formatHHMM(d.departBy)} までに「{d.predName}」を出発（移動 約{d.travelMin}分＋余裕{d.marginMin}分）
                  </span>
                )}
              </span>
              <button type="button" onClick={() => onPropose({ type: "fixed-remove", fixedId: b.id })} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-600">
                外す
              </button>
            </li>
          );
        })}
        {statuses.map((s) => (
          <li key={s.event.id} className="flex items-start gap-2 rounded-xl bg-fuchsia-50 p-2.5 text-[13px]" data-testid="fixed-item-member">
            <span className="text-lg">{FIXED_KIND_ICON[s.event.kind]}</span>
            <span className="flex-1">
              <strong className="block text-slate-900">{s.event.title}</strong>
              <span className="block text-[11px] text-fuchsia-800">{s.memberNames.join("・")}だけ・{FIXED_KIND_LABEL[s.event.kind]}</span>
              <span className="block text-[11px] font-semibold text-slate-700">{formatHHMM(s.departBy)} までにグループを出発 → このあとは {s.memberNames.join("・")}不在</span>
            </span>
            <button type="button" onClick={() => onPropose({ type: "fixed-remove", fixedId: s.event.id })} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-600">
              外す
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-2.5 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
        <span className="text-xs font-semibold text-slate-700">
          余裕時間 <span className="text-[11px] font-normal text-slate-500">（出発 = 固定時刻 − 移動 − 余裕）</span>
        </span>
        <span className="flex items-center gap-1.5">
          <button type="button" aria-label="余裕時間を5分減らす" disabled={margin <= 0} onClick={() => onPropose({ type: "margin", marginMin: Math.max(0, margin - 5) })} className="size-8 rounded-lg border border-slate-300 bg-white text-base font-bold disabled:opacity-40" data-testid="margin-minus">
            −
          </button>
          <strong className="w-12 text-center text-sm tabular-nums" data-testid="margin-value">
            {margin}分
          </strong>
          <button type="button" aria-label="余裕時間を5分増やす" disabled={margin >= 60} onClick={() => onPropose({ type: "margin", marginMin: margin + 5 })} className="size-8 rounded-lg border border-slate-300 bg-white text-base font-bold disabled:opacity-40" data-testid="margin-plus">
            ＋
          </button>
        </span>
      </div>

      <FixedEventDialog
        open={open}
        onClose={() => setOpen(false)}
        itinerary={itinerary}
        ctx={ctx}
        dayIndex={dayIndex}
        onSubmit={(fixed) => {
          setOpen(false);
          onPropose({ type: "fixed-add", fixed });
        }}
      />
    </section>
  );
}
