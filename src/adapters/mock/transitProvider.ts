import { estimateTravel } from "@/core/geo";
import type { TransitProvider } from "../types";

/** 直線距離から徒歩・公共交通の概算時間を出すモック（core/geo.ts の estimateTravel） */
export const mockTransitProvider: TransitProvider = {
  async createEstimator() {
    return estimateTravel;
  },
};
