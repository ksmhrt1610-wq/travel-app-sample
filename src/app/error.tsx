"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/** ページ（ルート）の中で起きた例外の受け皿。レイアウト（ヘッダー・ナビ）は残る */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} />;
}
