/** AI Detection focus modes — each isolates the map to one asset family and
 * one anomaly type, instead of showing every layer/finding at once. Shared
 * between MapCanvas (2D) and Map3DViewer (3D) so both use the exact same
 * category/anomaly-type mapping. */
export type DetectionMode = "poles" | "drains" | "manholes" | "roads" | "powerlines" | null;

export const DETECTION_MODE_TARGET_CLASSES: Record<Exclude<DetectionMode, null>, string[]> = {
  poles: ["Illumination_Asset"],
  drains: ["Building", "Drainage_Asset"],
  // Road_Segment was here for pipe-route-recommendation context, but reads
  // as pure clutter in the AI Detection focus itself (easy to mistake for a
  // real finding) — removed at explicit request.
  manholes: ["Access_Point", "Drainage_Asset"],
  roads: ["Road_Centerline", "Road_Surface"],
  // Poles included alongside the line/building pair — the real supports
  // the conductor hangs from are essential context for judging a proximity
  // finding, and roads are deliberately left OUT (pure clutter for this
  // focus, easy to confuse with the power line itself at a glance).
  powerlines: ["Power_Line", "Building", "Illumination_Asset", "Utility_Pole"],
};

export const DETECTION_MODE_ANOMALY_TYPE: Record<Exclude<DetectionMode, null>, string> = {
  poles: "pole_redundancy",
  drains: "drain_encroachment",
  manholes: "manhole_status",
  roads: "road_width_narrowing",
  powerlines: "powerline_proximity",
};

export const DETECTION_MODE_LABEL: Record<Exclude<DetectionMode, null>, string> = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manholes",
  roads: "Roads",
  powerlines: "Powerlines",
};
