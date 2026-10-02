"use client";

import { useState } from "react";
import type { DetourCandidate, Here } from "@/core/detour";
import { FREE_STOP_TRAVEL_MIN } from "@/core/schedule";
import { formatDuration, formatHHMM } from "@/core/time";
import { CATEGORY_ICON, CATEGORY_LABEL, SETTING_ICON, SETTING_LABEL } from "@/core/labels";
import { Button, Sheet } from "./ui";

export type DetourStop = { spotId: string } | { name: string; durationMin: number };

/** 「ここに寄る」: 近く（いまいる場所から1km以内）の営業中のスポットから選ぶか、名前と滞在時間を自由に入力する */
export function DetourSheet({
  open,
  onClose,
  here,
  nowMin,
  candidates,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  here: Here;
  nowMin: number;
  candidates: DetourCandidate[];
  onChoose: (stop: DetourStop) => void;
}) {
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState(20);
  return (
    <Sheet open={open} onClose={onClose} title="ここに寄る" testId="detour-sheet">
      <p className="text-xs text-slate-600">
        いまいる場所：<strong>{here.name}</strong>（{formatHHMM(nowMin)}）。寄り道は、いまの予定の後ろに入れて、後ろの予定を組み直します。
      </p>

      <h3 className="mt-3 text-[13px] font-bold text-slate-800">近くの営業中のスポット（1km以内）</h3>
      {candidates.length === 0 ? (
        <p className="mt-1 rounded-lg bg-slate-50 p-3 text-xs text-slate-600" data-testid="detour-empty">
          近くで、いま営業中の（まだ旅程に入っていない）スポットが見つかりませんでした。下から自由に入力できます。
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1.5" data-testid="detour-candidates">
          {candidates.map((c) => (
            <li key={c.spot.id}>
              <button
                type="button"
                onClick={() => onChoose({ spotId: c.spot.id })}
                data-testid={`detour-spot-${c.spot.id}`}
                className="flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5 text-left hover:bg-slate-50"
              >
                <span className="text-xl">{CATEGORY_ICON[c.spot.category]}</span>
                <span className="flex-1">
                  <span className="block text-sm font-bold text-slate-900">{c.spot.name}</span>
                  <span className="block text-[11px] text-slate-600">
                    {CATEGORY_LABEL[c.spot.category]}・{SETTING_ICON[c.spot.setting]} {SETTING_LABEL[c.spot.setting]}・約{(c.distanceM / 1000).toFixed(1)}km・滞在 {formatDuration(c.spot.stayMin)}
                  </span>
                </span>
                <span className="text-[11px] font-semibold text-emerald-700">あと{formatDuration(c.openUntilMin)}営業</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 text-[13px] font-bold text-slate-800">場所を自由に入力</h3>
      <div className="mt-1.5 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <label className="block text-xs font-semibold text-slate-700">
          名前
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: 気になっていたパン屋"
            maxLength={40}
            className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
            data-testid="detour-free-name"
          />
        </label>
        <label className="block text-xs font-semibold text-slate-700">
          滞在時間：<strong className="tabular-nums">{minutes}分</strong>
          <input
            type="range"
            min={10}
            max={90}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="w-full"
            data-testid="detour-free-minutes"
          />
        </label>
        <p className="text-[11px] text-slate-600" data-testid="detour-free-note">
          ※ 場所が決まっていないので、移動は「直前の場所から{FREE_STOP_TRAVEL_MIN}分」と仮定します。
        </p>
        <Button
          onClick={() => name.trim() && onChoose({ name: name.trim(), durationMin: minutes })}
          disabled={!name.trim()}
          className="w-full"
          data-testid="detour-free-submit"
        >
          この場所に寄る
        </Button>
      </div>
    </Sheet>
  );
}
