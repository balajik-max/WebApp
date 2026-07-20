import type { AgentCounts } from "./collisionUtils";

export const PALETTE = {
  GREEN: "#88A991",
  LIGHT: "#D4EDDA",
  WHITE: "#FFFFFF",
  INK_GREEN: "#33503f",
} as const;

export const GRID_STEP = 24;
export const SPAN_X = 120;
export const SPAN_Z = 100;

export const ROAD_HALF_WIDTH = 0.7;
export const ROAD_EXCLUSION_HALF = ROAD_HALF_WIDTH + 0.9;

export const PEDESTRIAN_OFFSET = 4.0;
export const PEDESTRIAN_HALF_WIDTH = 1.6;

export const SAFETY_MARGIN = 0.8;

export const PLACEMENT_BOUNDS = {
  minX: -132,
  maxX: 132,
  minZ: -112,
  maxZ: 112,
} as const;

export const MAX_PLACEMENT_ATTEMPTS = 80;

export const SEED = 1337;

export const AGENT_DENSITY: Record<"desktop" | "mobile", AgentCounts> = {
  desktop: { cars: 9, pedestrians: 12, cyclists: 4, streetlights: 48 },
  mobile: { cars: 4, pedestrians: 6, cyclists: 2, streetlights: 24 },
};

export const TREE_BELT = { x: -52, z: -14, r: 20 } as const;
export const PLAZA = { x: 0, z: -56, w: 22, d: 16 } as const;
export const CIVIC_CENTER = { x: 0, z: 0, r: 8 } as const;

export const PLANNING_ZONES: Array<[number, number]> = [
  [52, 14],
  [40, -14],
  [60, 0],
];

export const PARKS: Array<{ x: number; z: number; size: number }> = [
  { x: 60, z: 40, size: 16 },
  { x: 60, z: -40, size: 16 },
  { x: -60, z: 40, size: 16 },
  { x: -60, z: -40, size: 16 },
];
