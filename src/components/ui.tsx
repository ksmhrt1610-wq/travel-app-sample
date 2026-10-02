"use client";

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { BlockLabel } from "@/core/types";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "amber" | "emerald";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-700 disabled:bg-slate-300",
  secondary: "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 active:bg-slate-100 disabled:text-slate-400",
  ghost: "bg-transparent text-brand-700 hover:bg-brand-50 active:bg-brand-100",
  danger: "bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-700 disabled:bg-slate-300",
  amber: "bg-amber-500 text-white hover:bg-amber-600 active:bg-amber-600 disabled:bg-slate-300",
  emerald: "bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-700 disabled:bg-slate-300",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl font-semibold transition-colors disabled:cursor-not-allowed",
        size === "sm" && "min-h-9 px-3 text-sm",
        size === "md" && "min-h-11 px-4 text-[15px]",
        size === "lg" && "min-h-12 px-5 text-base",
        VARIANT[variant],
        className,
      )}
    />
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-5", className)}>
      {children}
    </span>
  );
}

export const LABEL_STYLE: Record<BlockLabel, { chip: string; dot: string; card: string }> = {
  must: { chip: "bg-rose-100 text-rose-700", dot: "bg-rose-500", card: "border-rose-200 bg-white" },
  normal: { chip: "bg-sky-100 text-sky-700", dot: "bg-sky-500", card: "border-slate-200 bg-white" },
  optional: { chip: "bg-violet-100 text-violet-700", dot: "bg-violet-400", card: "border-violet-200 bg-white" },
  buffer: { chip: "bg-teal-100 text-teal-700", dot: "bg-teal-400", card: "border-dashed border-teal-300 bg-teal-50/60" },
};

/** 下から出るシート（モーダル）。背景タップ・Esc で閉じる */
export function Sheet({
  open,
  onClose,
  title,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  testId?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <div className="animate-slide-up relative max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="flex size-9 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"
          >
            ✕
          </button>
        </div>
        <div className="px-4 pb-4 pt-3">{children}</div>
      </div>
    </div>
  );
}

/** 画面下に一時的に出すメッセージ */
export function useToast(durationMs = 2600) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), durationMs);
    return () => clearTimeout(t);
  }, [message, durationMs]);
  const node = message ? (
    <div className="pointer-events-none fixed inset-x-0 bottom-[7.5rem] z-[60] mx-auto flex max-w-md justify-center px-4" role="status" data-testid="toast">
      <div className="animate-pop-in rounded-full bg-slate-900/90 px-4 py-2 text-sm font-semibold text-white shadow-lg">{message}</div>
    </div>
  ) : null;
  return { show: setMessage, node };
}
