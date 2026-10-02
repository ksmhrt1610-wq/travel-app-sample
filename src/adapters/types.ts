import type { HourlyWeather } from "@/core/weather";
import type { GroupState } from "@/core/group";
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

/** 天気予報。実装例: Open-Meteo / 気象庁 / OpenWeatherMap の時間別降水確率・雨量 */
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

/** 読み込みの結果。読めなかったデータは勝手に捨てず、issue として返す（確認のうえで、削除かバックアップ） */
export interface GroupLoadResult {
  state: GroupState | null;
  issue?: { reason: string };
}

export type GroupSaveResult = { ok: true } | { ok: false; reason: string };

/**
 * グループの保存先。今は端末の localStorage（1台を回して使う）。
 * 複数端末の同期をするときは、これを実装したサーバー経由のものに差し替える（アプリ本体は、この interface だけに依存する）。
 */
export interface GroupRepository {
  load(): Promise<GroupLoadResult>;
  /** 保存の前に検証する。不正なデータは保存せず、理由を返す */
  save(state: GroupState): Promise<GroupSaveResult>;
  /** 削除する。backup: true なら、読めなかったデータをバックアップとして残してから削除する */
  clear(opts?: { backup?: boolean }): Promise<void>;
}

export interface Adapters {
  spots: SpotProvider;
  weather: WeatherProvider;
  transit: TransitProvider;
  groups: GroupRepository;
}
