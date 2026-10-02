import { describe, expect, it } from "vitest";
import { estimateTravel, haversineM } from "@/core/geo";
import { spots } from "./helpers";

const byId = (id: string) => spots.find((s) => s.id === id)!;

describe("移動時間の概算", () => {
  it("直線距離は Haversine で出る（緯度1度≒111.2km、東京駅〜新宿駅≒6.1km）", () => {
    expect(haversineM({ lat: 33, lng: 130 }, { lat: 34, lng: 130 })).toBeCloseTo(111195, -2);
    const d = haversineM({ lat: 35.6812, lng: 139.7671 }, { lat: 35.6896, lng: 139.7006 });
    expect(d).toBeGreaterThan(5900);
    expect(d).toBeLessThan(6300);
  });

  it("近い2点は徒歩、遠い2点は公共交通で概算する", () => {
    const near = estimateTravel(byId("tenjin-parco"), byId("tenjin-chikagai"));
    expect(near.mode).toBe("walk");
    expect(near.minutes).toBeLessThan(15);

    const far = estimateTravel(byId("hakata-amu"), byId("dazaifu-shrine"));
    expect(far.mode).toBe("transit");
    expect(far.minutes).toBeGreaterThan(35);
    expect(far.minutes).toBeLessThan(75);
  });

  it("距離が長いほど移動時間は単調に増える", () => {
    const origin = byId("hakata-amu");
    const times = ["hakata-canal", "tenjin-parco", "ohori-park", "dazaifu-shrine"].map(
      (id) => estimateTravel(origin, byId(id)).minutes,
    );
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
