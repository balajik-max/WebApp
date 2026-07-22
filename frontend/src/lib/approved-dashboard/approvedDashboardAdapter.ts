import type {
  DashboardRecord,
  VisualizationLayerManifest,
  VisualizationManifest,
} from "../workflow";
import {
  GIS_LAYER_NAMES,
  type GisCell,
  type GisLayerName,
  type GisRow,
  type GisWorkbookData,
} from "./gisTypes";

const FIELD_ALIASES: Record<string, string[]> = {
  GDB_FID: ["gdb fid", "fid", "objectid", "object id", "feature id", "asset id", "id"],
  LAYER: ["layer", "asset type", "category", "type", "class", "feature type"],
  Road_Name: ["road name", "roadname", "rd name", "street name", "streetname", "street", "road"],
  Type_of_Road: ["type of road", "road type", "surface type", "road surface", "surface"],
  Usage_of_Road: ["usage of road", "road usage", "usage", "use type"],
  Carriage_Way_Width: ["carriage way width", "carriageway width", "carriage width", "road width", "width"],
  Foot_Path: ["foot path", "footpath", "sidewalk", "pedestrian path"],
  UGD_Status: ["ugd status", "underground drainage status", "sewer status"],
  SWD_Status: ["swd status", "storm water drain status", "drain status"],
  Divider: ["divider", "median", "road divider"],
  Any_Conservancy: ["any conservancy", "conservancy", "road observation", "remarks", "remark"],
  Sodium__Solar__LED_Other: ["sodium solar led other", "street light", "streetlight", "lighting type", "lamp type"],
  Length_M: ["length m", "length meter", "length metres", "length meters", "length"],
  SHAPE_Length: ["shape length", "shape len", "length m", "length"],
  SHAPE_Area: ["shape area", "area sqm", "area sq m", "area", "area m2"],
  Condition: ["condition", "asset condition", "status", "asset status", "working status", "health", "health status", "inspection status"],
  Top_Level: ["top level", "cover level", "rim level", "ground level"],
  Bottom_Level: ["bottom level", "invert level", "bed level"],
  Silt_Level: ["silt level", "silt depth", "silt"],
  WidthXDepth: ["widthxdepth", "width x depth", "width depth", "drain size"],
  Pipe_Type: ["pipe type", "pipe material", "material"],
  Pipe_Diameter: ["pipe diameter", "diameter", "dia"],
  Diameter: ["diameter", "pipe diameter", "dia"],
  Depth: ["depth", "manhole depth", "mh depth"],
  Image: ["image", "image path", "photo", "photo path", "image reference"],
  Image_Number: ["image number", "image no", "photo number", "photo no", "image reference"],
  Name: ["name", "landmark name", "facility name", "asset name", "label"],
  Centroid_Longitude_WGS84: ["centroid longitude wgs84", "longitude", "lon", "lng"],
  Centroid_Latitude_WGS84: ["centroid latitude wgs84", "latitude", "lat"],
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toCell(value: unknown): GisCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function populated(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function findAlias(attributes: Record<string, unknown>, aliases: string[]): unknown {
  const entries = Object.entries(attributes);
  const normalizedAliases = aliases.map(normalize);
  for (const [key, value] of entries) {
    if (!populated(value)) continue;
    const normalizedKey = normalize(key);
    if (normalizedAliases.includes(normalizedKey)) return value;
  }
  for (const [key, value] of entries) {
    if (!populated(value)) continue;
    const normalizedKey = normalize(key);
    if (normalizedAliases.some((alias) => alias.length >= 5 && (normalizedKey.includes(alias) || alias.includes(normalizedKey)))) {
      return value;
    }
  }
  return null;
}

function sourceLayer(record: DashboardRecord): string {
  const value =
    record.attributes.gdb_layer ??
    record.attributes.GDB_LAYER ??
    record.attributes.layer_name ??
    record.attributes.Layer_Name ??
    record.category;
  return String(value ?? "uncategorized");
}

function geometryFamily(geometryType: string): "point" | "line" | "polygon" | "other" {
  const value = geometryType.toLowerCase();
  if (value.includes("point")) return "point";
  if (value.includes("line")) return "line";
  if (value.includes("polygon")) return "polygon";
  return "other";
}

/**
 * These are the eight original feature classes used by the approved dashboard.
 * They must never be reinterpreted by a broad classifier. In particular, the
 * source feature class named "Line" contains utility/physical linework, not
 * road-centreline survey rows.
 */
function canonicalDestination(record: DashboardRecord): GisLayerName | null {
  const source = normalize(sourceLayer(record));
  const canonical: Record<string, GisLayerName> = {
    "road centerline": "Road_Centerline",
    "road centreline": "Road_Centerline",
    roads: "Road_Centerline",
    polygon: "Polygon",
    point: "Point",
    line: "Line",
    manhole: "Manhole",
    manholes: "Manhole",
    swd: "SWD",
    "drain levels": "Drain_Levels",
    "drain level": "Drain_Levels",
    landmark: "Landmark",
    landmarks: "Landmark",
  };
  return canonical[source] ?? null;
}

function manifestLayerForRecord(
  record: DashboardRecord,
  layers: VisualizationLayerManifest[],
): VisualizationLayerManifest | undefined {
  const source = normalize(sourceLayer(record));
  return layers.find((layer) =>
    normalize(layer.layer_key) === source ||
    normalize(layer.source_layer_name) === source ||
    normalize(layer.display_name) === source,
  );
}

function hasAnyPopulatedField(attributes: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => populated(findAlias(attributes, FIELD_ALIASES[field] ?? [field])));
}

function destinationLayer(
  record: DashboardRecord,
  layer: VisualizationLayerManifest | undefined,
): GisLayerName {
  const canonical = canonicalDestination(record);
  if (canonical) return canonical;

  const family = geometryFamily(record.geometry_type);
  const dashboardType = layer?.dashboard_type ?? "generic";
  const source = normalize(sourceLayer(record));
  const confirmed = layer?.review_status === "confirmed";

  // Domain routes require either explicit user confirmation or actual semantic
  // evidence on the current source layer/record. This prevents a generic line
  // feature class from being counted as hundreds of unnamed roads.
  const roadEvidence =
    /\b(road|street|centreline|centerline|carriageway)\b/.test(source) ||
    hasAnyPopulatedField(record.attributes, [
      "Road_Name",
      "Type_of_Road",
      "Usage_of_Road",
      "Carriage_Way_Width",
      "Foot_Path",
      "UGD_Status",
    ]);
  const drainageEvidence =
    /\b(drain|swd|storm water|stormwater|culvert|nala)\b/.test(source) ||
    hasAnyPopulatedField(record.attributes, ["Silt_Level", "WidthXDepth", "Top_Level", "Bottom_Level"]);
  const manholeEvidence =
    /\b(manhole|man hole|inspection chamber|access chamber)\b/.test(source) ||
    hasAnyPopulatedField(record.attributes, ["Depth", "Diameter", "Pipe_Type", "Top_Level", "Bottom_Level"]);

  if (dashboardType === "roads" && (confirmed || roadEvidence)) return "Road_Centerline";
  if (dashboardType === "manholes" && (confirmed || manholeEvidence)) return "Manhole";
  if (dashboardType === "drainage" && (confirmed || drainageEvidence)) {
    return family === "line" ? "SWD" : "Drain_Levels";
  }
  if (dashboardType === "landmarks") return "Landmark";
  if (dashboardType === "buildings" || dashboardType === "parcels" || dashboardType === "boundaries") return "Polygon";
  if (dashboardType === "streetlights" || dashboardType === "solid_waste" || dashboardType === "vegetation") {
    return family === "line" ? "Line" : family === "polygon" ? "Polygon" : "Point";
  }
  if (dashboardType === "water_network" || dashboardType === "sewer_network" || dashboardType === "utilities") {
    return family === "point" ? "Point" : family === "polygon" ? "Polygon" : "Line";
  }

  if (family === "point") return "Point";
  if (family === "line") return "Line";
  if (family === "polygon") return "Polygon";
  return "Point";
}

function buildMapLink(record: DashboardRecord): string | null {
  const latitude = record.latitude;
  const longitude = record.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return `https://www.google.com/maps?q=${latitude.toFixed(7)},${longitude.toFixed(7)}`;
}

function buildRow(
  record: DashboardRecord,
  layer: VisualizationLayerManifest | undefined,
): GisRow {
  const attributes = record.attributes ?? {};
  const row: GisRow = {};

  for (const [key, value] of Object.entries(attributes)) {
    row[key] = toCell(value);
  }

  for (const [expectedField, aliases] of Object.entries(FIELD_ALIASES)) {
    if (!populated(row[expectedField])) {
      row[expectedField] = toCell(findAlias(attributes, aliases));
    }
  }

  row.GDB_FID = populated(row.GDB_FID) ? row.GDB_FID : record.id;
  row.LAYER = populated(row.LAYER)
    ? row.LAYER
    : record.category || layer?.display_name || sourceLayer(record);
  row.Name = populated(row.Name) ? row.Name : record.label;
  row.Condition = populated(row.Condition)
    ? row.Condition
    : toCell(findAlias(attributes, FIELD_ALIASES.Condition));

  if (!populated(row.Length_M) && populated(row.SHAPE_Length)) {
    row.Length_M = row.SHAPE_Length;
  }
  if (!populated(row.SHAPE_Length) && populated(row.Length_M)) {
    row.SHAPE_Length = row.Length_M;
  }
  if (!populated(row.Diameter) && populated(row.Pipe_Diameter)) {
    row.Diameter = row.Pipe_Diameter;
  }
  if (!populated(row.Pipe_Diameter) && populated(row.Diameter)) {
    row.Pipe_Diameter = row.Diameter;
  }

  if (typeof record.longitude === "number" && Number.isFinite(record.longitude)) {
    row.Centroid_Longitude_WGS84 = record.longitude;
  }
  if (typeof record.latitude === "number" && Number.isFinite(record.latitude)) {
    row.Centroid_Latitude_WGS84 = record.latitude;
  }
  const mapLink = buildMapLink(record);
  if (mapLink) row["Map Link (click)"] = mapLink;

  row.__dashboard_type = layer?.dashboard_type ?? "generic";
  row.__source_layer = sourceLayer(record);
  row.__severity = record.severity;

  return row;
}

function numericIdentifier(value: GisCell): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || value === undefined) return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortRows(rows: GisRow[]): void {
  rows.sort((left, right) => {
    const leftId = numericIdentifier(left.GDB_FID);
    const rightId = numericIdentifier(right.GDB_FID);
    if (leftId !== null && rightId !== null && leftId !== rightId) return leftId - rightId;
    if (leftId !== null && rightId === null) return -1;
    if (leftId === null && rightId !== null) return 1;
    const sourceCompare = String(left.__source_layer ?? "").localeCompare(String(right.__source_layer ?? ""));
    if (sourceCompare !== 0) return sourceCompare;
    return String(left.GDB_FID ?? "").localeCompare(String(right.GDB_FID ?? ""));
  });
}

export function buildApprovedDashboardWorkbook(
  manifest: VisualizationManifest,
  records: DashboardRecord[],
): GisWorkbookData {
  const workbook = Object.fromEntries(
    GIS_LAYER_NAMES.map((name) => [name, []]),
  ) as unknown as GisWorkbookData;
  const includedLayers = manifest.layers.filter((layer) => layer.included);

  for (const record of records) {
    const layer = manifestLayerForRecord(record, includedLayers);
    if (layer && !layer.included) continue;
    const destination = destinationLayer(record, layer);
    workbook[destination].push(buildRow(record, layer));
  }

  for (const layerName of GIS_LAYER_NAMES) sortRows(workbook[layerName]);
  return workbook;
}
