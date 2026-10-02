import { createPlanningContext } from "@/core/context";
import { DAY_ORIGINS } from "@/core/planner";
import type { PlanningContext } from "@/core/types";
import { mockSpotProvider } from "./mock/spotProvider";
import { mockTransitProvider } from "./mock/transitProvider";
import { mockWeatherProvider } from "./mock/weatherProvider";
import type { Adapters } from "./types";

/**
 * ★ 本物のAPIへの差し替えポイント ★
 * それぞれ SpotProvider / WeatherProvider / TransitProvider を実装したものに置き換える。
 *   spots:   Google Places API  → 例: googlePlacesSpotProvider
 *   weather: 天気API            → 例: openMeteoWeatherProvider
 *   transit: Directions / Distance Matrix → 例: googleTransitProvider
 */
export const adapters: Adapters = {
  spots: mockSpotProvider,
  weather: mockWeatherProvider,
  transit: mockTransitProvider,
};

/** adapter から取得したデータで、旅程生成・再計算に使うコンテキストを作る */
export async function loadPlanningContext(a: Adapters = adapters): Promise<PlanningContext> {
  const spots = await a.spots.listSpots();
  const travel = await a.transit.createEstimator([...spots, ...DAY_ORIGINS]);
  return createPlanningContext(spots, travel);
}
