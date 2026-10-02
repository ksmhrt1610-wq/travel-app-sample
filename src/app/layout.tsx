import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Replan 福岡 — 崩れても立て直せる旅程",
  description: "屋外の予定ごとに屋内の Plan B を用意して、雨や遅延でもワンタップで立て直せる福岡旅行プランナー（デモ用サンプル）",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2563eb",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
