import type { PlanningContext, Spot, TravelEstimator } from "./types";

export function createPlanningContext(spots: Spot[], travel: TravelEstimator): PlanningContext {
  return { spots, spotById: new Map(spots.map((s) => [s.id, s])), travel };
}
