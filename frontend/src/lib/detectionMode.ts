/** AI Detection focus modes — each isolates the map to one asset family and
 * one anomaly type, instead of showing every layer/finding at once. Shared
 * between MapCanvas (2D) and Map3DViewer (3D) so both use the exact same
 * category/anomaly-type mapping. */
export type DetectionMode = "poles" | "drains" | "manholes" | null;

export const DETECTION_MODE_TARGET_CLASSES: Record<Exclude<DetectionMode, null>, string[]> = {
  poles: ["Illumination_Asset"],
  drains: ["Building", "Drainage_Asset"],
  manholes: ["Access_Point"],
};

export const DETECTION_MODE_ANOMALY_TYPE: Record<Exclude<DetectionMode, null>, string> = {
  poles: "pole_redundancy",
  drains: "drain_encroachment",
  manholes: "manhole_status",
};

export const DETECTION_MODE_LABEL: Record<Exclude<DetectionMode, null>, string> = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manholes",
};
