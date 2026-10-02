import type { LatLng, Spot, TravelMode } from "./types";

/** スポット名と座標で Google Maps を開く URL */
export function mapsSearchUrl(spot: Pick<Spot, "name" | "lat" | "lng">): string {
  const query = `${spot.name} ${spot.lat},${spot.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** 現在地（または出発地）からの経路を Google Maps で開く URL */
export function mapsDirectionsUrl(to: Pick<Spot, "name" | "lat" | "lng">, mode: TravelMode, from?: LatLng): string {
  const params = new URLSearchParams({
    api: "1",
    destination: `${to.lat},${to.lng}`,
    travelmode: mode === "walk" ? "walking" : "transit",
  });
  if (from) params.set("origin", `${from.lat},${from.lng}`);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
