"use client";

import { useState } from "react";
import { formatHHMM } from "@/core/time";
import type { Block, PlanningContext } from "@/core/types";
import type { RainOverride } from "@/core/weather";
import { Button, cx } from "./ui";

export const SIM_MIN = 6 * 60;
export const SIM_MAX = 23 * 60 + 30;
const PRESETS = [10 * 60, 12 * 60, 13 * 60, 15 * 60, 18 * 60];
const DELAYS = [15, 30, 45, 60, 90];

interface Props {
  nowMin: number;
  onNowChange: (min: number) => void;
  rain?: RainOverride;
  onRain: (rain: RainOverride) => void;
  onStopRain: () => void;
  onDelay: (minutes: number) => void;
  /** 臨時休業にできるスポット（これから行く予定のスポット） */
  closable: Block[];
  ctx: PlanningContext;
  onClose: (spotId: string) => void;
  onReset: () => void;
}

/** デモ用のシミュレーション操作パネル（画面下に固定。折りたたみ可） */
export function SimulationPanel({ nowMin, onNowChange, rain, onRain, onStopRain, onDelay, closable, ctx, onClose, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const [prob, setProb] = useState(80);
  const [rainStart, setRainStart] = useState<number | null>(null); // null = 現在時刻
  const [delay, setDelay] = useState(30);
  const [closeSpot, setCloseSpot] = useState<string>("");

  const startMin = rainStart ?? nowMin;
  const selectedClose = closable.find((b) => b.spotId === closeSpot)?.spotId ?? closable[0]?.spotId ?? "";

  return (
    <div className="fixed inset-x-0 bottom-14 z-40 mx-auto max-w-md px-2" data-testid="sim-panel">
      <div className="overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-2xl">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="sim-toggle"
          className="flex w-full items-center gap-2 bg-slate-900 px-3 py-2 text-left text-white"
        >
          <span className="text-sm font-bold">🧪 デモ操作パネル</span>
          <span className="rounded-md bg-white/15 px-2 py-0.5 text-sm font-bold tabular-nums" data-testid="sim-now-label">
            🕐 {formatHHMM(nowMin)}
          </span>
          {rain && <span className="rounded-md bg-sky-500 px-1.5 py-0.5 text-xs font-bold">☔ {rain.prob}%</span>}
          <span className="ml-auto text-xs text-slate-300">{open ? "閉じる ▾" : "開く ▴"}</span>
        </button>

        {open && (
          <div className="max-h-[58dvh] space-y-4 overflow-y-auto p-3" data-testid="sim-body">
            {/* 現在時刻 */}
            <section>
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-slate-600">現在時刻</h3>
                <span className="text-lg font-black tabular-nums text-slate-900">{formatHHMM(nowMin)}</span>
              </div>
              <input
                type="range"
                min={SIM_MIN}
                max={SIM_MAX}
                step={5}
                value={nowMin}
                onChange={(e) => onNowChange(Number(e.target.value))}
                className="w-full"
                aria-label="現在時刻"
                data-testid="sim-now-slider"
              />
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onNowChange(m)}
                    data-testid={`sim-now-${formatHHMM(m)}`}
                    className={cx(
                      "min-h-9 rounded-lg border px-2.5 text-xs font-bold tabular-nums",
                      nowMin === m ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-300 bg-white text-slate-700",
                    )}
                  >
                    {formatHHMM(m)}
                  </button>
                ))}
                <button type="button" onClick={() => onNowChange(Math.max(SIM_MIN, nowMin - 15))} className="min-h-9 rounded-lg border border-slate-300 px-2.5 text-xs font-bold">
                  −15分
                </button>
                <button type="button" onClick={() => onNowChange(Math.min(SIM_MAX, nowMin + 15))} className="min-h-9 rounded-lg border border-slate-300 px-2.5 text-xs font-bold">
                  +15分
                </button>
              </div>
            </section>

            {/* 雨 */}
            <section className="rounded-xl bg-sky-50 p-3">
              <h3 className="mb-1.5 text-xs font-bold text-sky-900">☔ 雨が降り出す</h3>
              <label className="block text-xs text-slate-700">
                降水確率：<strong className="tabular-nums" data-testid="sim-rain-prob-label">{prob}%</strong>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={10}
                  value={prob}
                  onChange={(e) => setProb(Number(e.target.value))}
                  className="w-full"
                  data-testid="sim-rain-prob"
                />
              </label>
              <label className="block text-xs text-slate-700">
                降り出す時刻：<strong className="tabular-nums">{formatHHMM(startMin)}</strong>
                {rainStart === null && <span className="text-slate-500">（現在時刻）</span>}
                <input
                  type="range"
                  min={SIM_MIN}
                  max={SIM_MAX}
                  step={5}
                  value={startMin}
                  onChange={(e) => setRainStart(Number(e.target.value))}
                  className="w-full"
                  data-testid="sim-rain-start"
                />
              </label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    onRain({ prob, startMin });
                    setOpen(false); // 結果の通知が見えるようにパネルを閉じる
                  }}
                  data-testid="sim-rain-button"
                  className="bg-sky-600 hover:bg-sky-700"
                >
                  雨が降り出す
                </Button>
                <Button variant="secondary" onClick={onStopRain} disabled={!rain} data-testid="sim-rain-stop">
                  雨を止める
                </Button>
              </div>
            </section>

            {/* 遅延 */}
            <section className="rounded-xl bg-amber-50 p-3">
              <h3 className="mb-1.5 text-xs font-bold text-amber-900">🚃 電車が遅延</h3>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <select
                  value={delay}
                  onChange={(e) => setDelay(Number(e.target.value))}
                  className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold"
                  aria-label="遅延時間"
                  data-testid="sim-delay-select"
                >
                  {DELAYS.map((d) => (
                    <option key={d} value={d}>
                      {d}分
                    </option>
                  ))}
                </select>
                <Button
                  variant="amber"
                  onClick={() => {
                    onDelay(delay);
                    setOpen(false);
                  }}
                  data-testid="sim-delay-button"
                >
                  電車が{delay}分遅延
                </Button>
              </div>
            </section>

            {/* 臨時休業 */}
            <section className="rounded-xl bg-rose-50 p-3">
              <h3 className="mb-1.5 text-xs font-bold text-rose-900">⛔ このスポットが臨時休業</h3>
              {closable.length ? (
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <select
                    value={selectedClose}
                    onChange={(e) => setCloseSpot(e.target.value)}
                    className="min-h-11 min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold"
                    aria-label="臨時休業にするスポット"
                    data-testid="sim-close-select"
                  >
                    {closable.map((b) => (
                      <option key={b.id} value={b.spotId}>
                        {formatHHMM(b.startMin)} {ctx.spotById.get(b.spotId!)?.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="danger"
                    onClick={() => {
                      if (!selectedClose) return;
                      onClose(selectedClose);
                      setOpen(false);
                    }}
                    data-testid="sim-close-button"
                  >
                    臨時休業
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-slate-500">これから行く予定のスポットがありません。</p>
              )}
            </section>

            <button
              type="button"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
              className="w-full min-h-10 rounded-xl border border-slate-300 text-sm font-semibold text-slate-600"
              data-testid="sim-reset"
            >
              ↺ デモをリセット（元の旅程に戻す）
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
