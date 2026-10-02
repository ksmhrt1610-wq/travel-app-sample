"use client";

import { useEffect, useState } from "react";
import { loadPlanningContext } from "@/adapters";
import type { PlanningContext } from "@/core/types";

let promise: Promise<PlanningContext> | undefined;

/** adapter（スポット・移動時間）から旅程計算用のコンテキストを1回だけ読み込む */
export function usePlanningContext(): PlanningContext | null {
  const [ctx, setCtx] = useState<PlanningContext | null>(null);
  useEffect(() => {
    let alive = true;
    promise ??= loadPlanningContext();
    promise.then((c) => alive && setCtx(c));
    return () => {
      alive = false;
    };
  }, []);
  return ctx;
}
