"use client";

import { useEffect, useMemo, useState } from "react";
import { buildShareUrl } from "@/core/share";
import type { Itinerary } from "@/core/types";
import { Button, Sheet } from "./ui";

/** 旅程を URL にして共有する。受け取った人は /share で同じ旅程を閲覧できる（閲覧専用） */
export function ShareDialog({ open, onClose, itinerary, title }: { open: boolean; onClose: () => void; itinerary: Itinerary; title?: string }) {
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const url = useMemo(
    () => (open && typeof window !== "undefined" ? buildShareUrl(window.location.origin, itinerary) : ""),
    [open, itinerary],
  );

  useEffect(() => {
    setCanNativeShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      const el = document.getElementById("share-url") as HTMLTextAreaElement | null;
      el?.select();
      setCopied(document.execCommand?.("copy") ?? false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={title ?? "旅程を共有"} testId="share-dialog">
      <p className="mb-2 text-sm text-slate-600">
        このリンクを開いた人は、同じ旅程を<strong>閲覧</strong>できます（共同編集はできません）。旅程の内容がリンクの中に含まれます。
      </p>
      <textarea
        id="share-url"
        readOnly
        value={url}
        rows={4}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full resize-none rounded-xl border border-slate-300 bg-slate-50 p-2 font-mono text-[11px] leading-4 text-slate-700"
        data-testid="share-url"
      />
      <div className="mt-3 grid grid-cols-1 gap-2">
        <Button onClick={copy} data-testid="copy-share">
          {copied ? "✓ コピーしました" : "リンクをコピー"}
        </Button>
        {canNativeShare && (
          <Button variant="secondary" onClick={() => navigator.share({ title: "Replan 福岡の旅程", url }).catch(() => {})}>
            アプリで共有…
          </Button>
        )}
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-center text-xs font-semibold text-brand-700 underline" data-testid="open-share">
          共有ページを新しいタブで確認
        </a>
      </div>
    </Sheet>
  );
}
