import type { HourlyWeather } from "@/core/weather";
import type { LatLng, Spot, TravelEstimator } from "@/core/types";

/**
 * 外部データの境界（adapter 層）。
 * アプリ本体（UI・core）は外部APIを直接呼ばず、ここで定義した interface だけに依存する。
 * 本物のAPIに差し替えるときは、これらを実装して adapters/index.ts の差し替えポイントで登録する。
 */

/** スポット情報。実装例: Google Places API (New) の Text Search / Place Details */
export interface SpotProvider {
  listSpots(): Promise<Spot[]>;
}

/** 天気予報。実装例: Open-Meteo / 気象庁 / OpenWeatherMap の時間別降水確率 */
export interface WeatherProvider {
  getHourlyForecast(date: string, location: LatLng): Promise<HourlyWeather[]>;
}

/**
 * 移動時間。旅程生成は「2点間の移動時間を同期的に引ける関数」を使うので、
 * 実APIの場合は対象地点どうしの所要時間を事前に取得（Distance Matrix 等）してから関数を返す。
 */
export interface TransitProvider {
  createEstimator(points: LatLng[]): Promise<TravelEstimator>;
}

export interface Adapters {
  spots: SpotProvider;
  weather: WeatherProvider;
  transit: TransitProvider;
}
