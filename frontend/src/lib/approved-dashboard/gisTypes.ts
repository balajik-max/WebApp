export const GIS_LAYER_NAMES = [
  "Road_Centerline",
  "Polygon",
  "Point",
  "Line",
  "Manhole",
  "SWD",
  "Drain_Levels",
  "Landmark",
] as const;

export type GisLayerName = (typeof GIS_LAYER_NAMES)[number];

export type GisCell = string | number | boolean | null;

export type GisRow = Record<string, GisCell>;

export type GisWorkbookData = Record<GisLayerName, GisRow[]>;