"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { StorageGate } from "./StorageGate";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "つくる", icon: "🧭" },
  { href: "/itinerary", label: "旅程", icon: "🗓️" },
  { href: "/today", label: "当日モード", icon: "⏱️" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-slate-50 shadow-xl">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-2 px-4 py-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-sm text-white">↺</span>
          <div className="leading-tight">
            <div className="text-[15px] font-extrabold tracking-tight text-slate-900">Replan 福岡</div>
            <div className="text-[11px] text-slate-500">崩れても立て直せる旅程</div>
          </div>
        </div>
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-1 text-[11px] leading-4 text-amber-800" data-testid="sample-notice">
          ⚠ スポット情報は<strong>サンプルデータ</strong>です（営業時間・位置は不正確な場合があります）
        </div>
      </header>

      <StorageGate />
      <main className="flex-1 pb-28">{children}</main>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-md border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        aria-label="メインメニュー"
      >
        <ul className="grid grid-cols-3">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold",
                    active ? "text-brand-700" : "text-slate-500",
                  )}
                >
                  <span className="text-lg leading-none">{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
