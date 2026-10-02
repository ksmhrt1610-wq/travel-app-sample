import { generateItinerary } from "@/core/planner";
import type { ItineraryGenerator } from "@/core/types";

/**
 * ★ 旅程生成の差し替えポイント ★
 * 今はルールベース（core/planner.ts）。LLM 等に変える場合は ItineraryGenerator と同じ形
 * （GenerateInput → Itinerary、必要なら async 化）の関数をここで export する。
 * UI は generate() だけを呼ぶ。
 */
export const generate: ItineraryGenerator = generateItinerary;
