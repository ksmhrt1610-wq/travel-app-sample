import spotsJson from "@/data/spots.json";
import type { Spot } from "@/core/types";
import type { SpotProvider } from "../types";

/** サンプルデータ（src/data/spots.json）を返すモック。営業時間などは不正確な場合がある */
export const mockSpotProvider: SpotProvider = {
  async listSpots() {
    return spotsJson as Spot[];
  },
};
