import type { LatLng, TravelEstimate, TravelEstimator } from "./types";

const EARTH_RADIUS_M = 6371008.8;

/** 2点間の直線距離（m）。Haversine。 */
export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 直線距離 → 実際の道のりへの補正係数 */
export const DETOUR_FACTOR = 1.3;
/** これ以下の道のりは徒歩 */
export const WALK_MAX_M = 1000;
export const WALK_M_PER_MIN = 75; // 4.5km/h
const TRANSIT_M_PER_MIN = 450; // 27km/h（待ち時間は別に加算）
const TRANSIT_OVERHEAD_MIN = 10; // 乗り場までの移動・待ち時間
const TAXI_M_PER_MIN = 500; // 30km/h
const TAXI_OVERHEAD_MIN = 4; // 乗車までの待ち

/**
 * 直線距離から徒歩・公共交通の概算移動時間を出す（モック実装用）。
 * 実API（Google Directions / Distance Matrix 等）に差し替える場合は TransitProvider 側で行う。
 */
export const estimateTravel: TravelEstimator = (from, to): TravelEstimate => {
  const straight = haversineM(from, to);
  const road = straight * DETOUR_FACTOR;
  if (road <= WALK_MAX_M) {
    return { mode: "walk", minutes: Math.max(1, Math.ceil(road / WALK_M_PER_MIN)), distanceM: Math.round(road) };
  }
  return {
    mode: "transit",
    minutes: Math.ceil(TRANSIT_OVERHEAD_MIN + road / TRANSIT_M_PER_MIN),
    distanceM: Math.round(road),
  };
};

/** 徒歩だと何分かかるか（道のり m から） */
export function walkMinutesFor(roadM: number): number {
  return Math.ceil(roadM / WALK_M_PER_MIN);
}

/** 公共交通だと何分かかるか（道のり m から。乗り場までの移動・待ちを含む） */
export function transitMinutesFor(roadM: number): number {
  return Math.ceil(TRANSIT_OVERHEAD_MIN + roadM / TRANSIT_M_PER_MIN);
}

/** タクシーだと何分かかるか（道のり m から） */
export function taxiMinutesFor(roadM: number): number {
  return Math.ceil(TAXI_OVERHEAD_MIN + roadM / TAXI_M_PER_MIN);
}

/** 「かなり疲れた」以降に使う、徒歩の上限（m）。これを超える移動は公共交通にする */
export const LOW_WALK_MAX_M = 600;

/** 徒歩の上限を設けた見積もり。徒歩が上限を超える移動は公共交通の所要時間に置き換える */
export function withWalkLimit(base: TravelEstimator, maxWalkM: number = LOW_WALK_MAX_M): TravelEstimator {
  return (from, to) => {
    const t = base(from, to);
    if (t.mode === "walk" && t.distanceM > maxWalkM) {
      return { mode: "transit", minutes: transitMinutesFor(t.distanceM), distanceM: t.distanceM };
    }
    return t;
  };
}
