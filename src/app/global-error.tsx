"use client";

import { ErrorScreen } from "@/components/ErrorScreen";
import "./globals.css";

/** レイアウト自体で起きた例外の受け皿（root layout を置き換えるので、html と body を持つ） */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ja">
      <body>
        <div className="mx-auto min-h-dvh max-w-md bg-slate-50">
          <ErrorScreen error={error} reset={reset} />
        </div>
      </body>
    </html>
  );
}
