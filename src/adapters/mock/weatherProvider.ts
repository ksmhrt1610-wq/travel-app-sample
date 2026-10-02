import type { WeatherProvider } from "../types";

/** 終日おおむね晴れのモック予報。降り出しはデモの操作パネルで上書きする */
export const mockWeatherProvider: WeatherProvider = {
  async getHourlyForecast() {
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      precipProb: hour >= 12 && hour <= 17 ? 20 : 10,
    }));
  },
};
