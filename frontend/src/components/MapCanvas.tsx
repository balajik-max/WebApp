import { useEffect, useRef, useState, useCallback, useImperativeHandle, useMemo, forwardRef } from "react";
import { createPortal } from "react-dom";
import maplibregl, { Map as MLMap, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { fetchFeatureById, fetchFeaturesInViewport } from "../lib/features";
import type { AiHighlight, FeatureFilter, UrbanFeature, FeatureCollectionResponse } from "../lib/types";
import { ApiError } from "../lib/api";
import { colorForCategory, UNCATEGORIZED_COLOR } from "../lib/categoryColors";
import {
  fetchDatasets, fetchDatasetBounds, type DatasetRow,
  type FeatureTableRow, type LayerFeatureTableFilter,
  fetchAnomalies, runSpatialAudit, updateAnomalyStatus, fetchAllClassMappings,
  type SpatialAnomaly, type AnomalyStatus,
} from "../lib/workflow";
import { AttributeTable } from "./AttributeTable";
import { PanoramaViewer } from "./PanoramaViewer";
import { GoogleStreetView } from "./GoogleStreetView";
import { AnomalyAlertCard } from "./AnomalyAlertCard";
import { LookAroundCompass, DEFAULT_MAP_PITCH, MAX_MAP_PITCH } from "./LookAroundCompass";

interface Props {
  filter: FeatureFilter;
  onFeatureSelect: (feature: UrbanFeature | null) => void;
  /** Fires whenever the set of datasets selected in the Command Center
   * changes Ã¢â‚¬â€ used to drive the ward/dataset-level report panel. */
  onActiveDatasetsChange?: (rows: DatasetRow[]) => void;
  /** Dataset selection persisted by the parent (survives this component
   * being unmounted/remounted on tab navigation) Ã¢â‚¬â€ seeds the initial
   * selection and is re-applied once the map and dataset list are ready. */
  initialActiveDatasets?: DatasetRow[];
  /** AI-produced highlight overrides — redundant poles show red,
   * needed poles show green. Empty array clears the overlay. */
  aiHighlights?: AiHighlight[];
  /** Feature requested from an attribute-table row on another route. */
  focusFeatureId?: string;
  /** Clears the one-shot route request after the feature has been handled. */
  onFocusHandled?: () => void;
  /** Notifies a parent (the top navigation bar) whenever the authoritative
   * Measure visibility changes, so a mirrored top-bar button can stay in sync
   * without duplicating the real Measure state owned here. */
  onMeasureChange?: (active: boolean) => void;
}

const DAVANGERE_CENTER: [number, number] = [75.9218, 14.4644];
const DAVANGERE_ZOOM = 12;
// Dataset/filter changes load one stable GeoJSON snapshot. Map navigation
// then only changes the camera; it never replaces that snapshot. The API
// still requires a bbox, so use the full valid WGS84 extent and let the
// selected dataset/ward/category filters define the data scope.
const COMPLETE_DATA_BBOX: [number, number, number, number] = [-180, -90, 180, 90];

// Same base the rest of the app's fetch wrapper (lib/api.ts) uses Ã¢â‚¬â€ the
// dev setup serves the API from a different origin/port than the SPA, so
// raster preview image requests need the same credentials treatment as
// every other authenticated call.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// Per-dataset IDs (rather than one fixed source/layer) so more than one
// raster overlay can be shown on the map at the same time.
const rasterSourceId = (datasetId: string) => `raster-preview-${datasetId}`;
const rasterLayerId = (datasetId: string) => `raster-preview-layer-${datasetId}`;

export type RasterColorMode = "rgb" | "grayscale" | "enhanced";

export interface RasterDisplaySettings {
  colorMode: RasterColorMode;
  clarity: number;
}

export const DEFAULT_RASTER_SETTINGS: RasterDisplaySettings = {
  colorMode: "grayscale",
  clarity: 0,
};

export const COLOR_MODE_OPTIONS: Array<{ value: RasterColorMode; label: string }> = [
  { value: "rgb", label: "RGB" },
  { value: "grayscale", label: "Grayscale" },
  { value: "enhanced", label: "Enhanced" },
];

function previewModeForSettings(settings: RasterDisplaySettings): "rgb" | "grayscale" | "enhanced" {
  return settings.colorMode;
}

function rasterPreviewUrl(datasetId: string, settings: RasterDisplaySettings): string {
  const params = new URLSearchParams({ mode: previewModeForSettings(settings) });
  return `${API_BASE}/api/v1/datasets/${datasetId}/raster-preview.png?${params.toString()}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveRasterSettings(settings?: Partial<RasterDisplaySettings>): RasterDisplaySettings {
  return {
    colorMode: settings?.colorMode ?? DEFAULT_RASTER_SETTINGS.colorMode,
    clarity: clamp(settings?.clarity ?? DEFAULT_RASTER_SETTINGS.clarity, 0, 2),
  };
}

function rasterPaintForSettings(settings: RasterDisplaySettings): Record<string, number> {
  const normalized = resolveRasterSettings(settings);
  // The backend now renders the correct rainbow/hillshade image.
  // We apply only mild contrast boost from Edge Clarity, and keep
  // brightness untouched so we don't wash out or crush the image.
  const clarityContrast = normalized.clarity * 0.35;
  const saturation = normalized.colorMode === "grayscale" ? -1 : 0;

  return {
    "raster-opacity": 0.9,
    "raster-saturation": saturation,
    "raster-contrast": clamp(clarityContrast, -1, 1),
    "raster-brightness-min": 0,
    "raster-brightness-max": 1,
  };
}

function rasterResamplingForSettings(settings: RasterDisplaySettings): "linear" | "nearest" {
  return resolveRasterSettings(settings).clarity >= 0.35 ? "nearest" : "linear";
}

const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    "osm-tiles": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      // The public OSM raster service ends at z19. Requesting z20+ produces
      // CORS/network failures; source-level maxzoom makes MapLibre overzoom
      // valid z19 tiles while our vector inspection camera continues to z24.
      maxzoom: 19,
      attribution: "(c) OpenStreetMap contributors",
    },
    "satellite-tiles": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      // ArcGIS advertises higher global LODs, but at Davangere levels 20+
      // return its grey "Map data not yet available" placeholder. Declaring
      // the last real local level makes MapLibre overzoom level 19 instead of
      // requesting those placeholders, so satellite mode remains continuous
      // through the application's zoom-24 inspection range.
      maxzoom: 19,
      attribution: "Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [
    { id: "osm", type: "raster", source: "osm-tiles", minzoom: 0, maxzoom: 24 },
    {
      id: "satellite",
      type: "raster",
      source: "satellite-tiles",
      minzoom: 0,
      maxzoom: 24,
      layout: { visibility: "none" },
    },
  ],
};

type Basemap = "street" | "satellite" | "off";

const FEATURE_SOURCE = "urban-features";
const LAYER_POINTS = "urban-features-points";
const LAYER_LINES = "urban-features-lines";
const LAYER_POLY_FILL = "urban-features-poly-fill";
const LAYER_POLY_OUTLINE = "urban-features-poly-outline";
const LAYER_PHOTOS = "urban-features-photos";
const PHOTO_ICON_ID = "site-photo-icon";

// Attribute-table selection highlight. It uses its own source so the target
// remains visible even while the selected dataset snapshot is still loading.
const TABLE_FOCUS_SOURCE = "attribute-table-focus";
const TABLE_FOCUS_FILL = "attribute-table-focus-fill";
const TABLE_FOCUS_LINE = "attribute-table-focus-line";
const TABLE_FOCUS_POINT = "attribute-table-focus-point";
const TABLE_FOCUS_DURATION_MS = 8000;

// Base (category-agnostic) filters for the layers above — kept as named
// constants so the category-visibility checklist can AND a hidden-category
// clause onto them without duplicating the geometry/role logic.
const POLY_BASE_FILTER: maplibregl.FilterSpecification = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const LINE_BASE_FILTER: maplibregl.FilterSpecification = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]];
const POINT_BASE_FILTER: maplibregl.FilterSpecification = [
  "all",
  ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
  ["!=", ["get", "category"], "raster_pixel"],
  ["!=", ["get", "category"], "site_photo"],
];
const PHOTO_BASE_FILTER: maplibregl.FilterSpecification = ["==", ["get", "category"], "site_photo"];

function withCategoryVisibility(
  base: maplibregl.FilterSpecification,
  hidden: Set<string>
): maplibregl.FilterSpecification {
  if (hidden.size === 0) return base;
  return [
    "all",
    base,
    ["!", ["in", ["coalesce", ["get", "category"], "uncategorized"], ["literal", Array.from(hidden)]]],
  ] as unknown as maplibregl.FilterSpecification;
}

// Separate GeoJSON source + layers for AI highlight overlays so they sit
// on top of the normal feature layers without touching the original data.
const AI_HIGHLIGHT_SOURCE = "ai-highlight";
const LAYER_AI_REDUNDANT = "ai-highlight-redundant";
const LAYER_AI_NEEDED = "ai-highlight-needed";

const AI_REDUNDANT_COLOR = "#ef4444"; // red
const AI_NEEDED_COLOR = "#22c55e";    // green

// Spatial Audit Engine — persisted findings (pole redundancy, drain
// encroachment, manhole status), one shared point layer colored by the
// backend-assigned `color` field directly (red/yellow/green already
// decided server-side, no client bucket math needed).
const ANOMALY_SOURCE = "spatial-anomalies";
const LAYER_ANOMALIES = "spatial-anomalies-points";
const ANOMALY_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "match", ["get", "color"],
  "red", "#ef4444",
  "yellow", "#f59e0b",
  "green", "#22c55e",
  "#94a3b8",
];

// Measurement (ruler) tool — separate GeoJSON sources for the vertex
// points, the outline (line/path/polygon-ring/circle-ring), and the filled
// area (polygon/circle only) so each can have its own paint without
// touching any of the feature/AI layers above.
const MEASURE_POINTS_SOURCE = "measure-points";
const MEASURE_LINE_SOURCE = "measure-line";
const MEASURE_FILL_SOURCE = "measure-fill";
const MEASURE_RADIUS_LINE_SOURCE = "measure-radius-line";
const LAYER_MEASURE_FILL = "measure-fill-layer";
const LAYER_MEASURE_LINE = "measure-line-layer";
const LAYER_MEASURE_RADIUS_LINE = "measure-radius-line-layer";
const LAYER_MEASURE_POINTS = "measure-points-layer";
const MEASURE_COLOR = "#f59e0b";

// Below this geodesic separation a second Line/Circle vertex is treated as a
// degenerate (e.g. a stray double-click on the start), so it is ignored
// rather than producing a zero-length / NaN measurement.
const MIN_MEASURE_METERS = 0.001;

const EARTH_RADIUS_M = 6371008.8;

/** Haversine great-circle distance in meters between two [lon, lat] points. */
function haversineDistance(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "Nice" round scale-bar distances (metric), same ladder a cartographic
 * scale bar picks from — used to turn a raw pixel-to-meters measurement
 * into a label like "200 m" or "2 km" instead of an arbitrary number. */
const NICE_SCALE_METERS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000,
];

function formatNiceScaleMeters(meters: number): string {
  return meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
}

/** Picks the largest "nice" round distance that still fits within the given
 * pixel budget at the map's current resolution — the same approach a
 * cartographic scale bar uses, just without drawing a proportional line:
 * the label always fits in a fixed-width box because the box shows the
 * chosen round number's text ("2 km"), never the sample width itself. */
function pickNiceScaleLabel(metersPerPixel: number, maxWidthPx: number): string {
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return "";
  const maxMeters = metersPerPixel * maxWidthPx;
  let chosen = NICE_SCALE_METERS[0];
  for (const candidate of NICE_SCALE_METERS) {
    if (candidate > maxMeters) break;
    chosen = candidate;
  }
  return formatNiceScaleMeters(chosen);
}

/** Initial compass bearing in degrees [0, 360) from point a to point b. */
function bearing(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Total length in meters of an open path (sum of consecutive segments). */
function pathLength(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineDistance(points[i - 1], points[i]);
  return total;
}

/** Perimeter in meters of a closed ring — same as pathLength plus the
 * closing segment back to the first point. */
function ringPerimeter(points: [number, number][]): number {
  if (points.length < 2) return 0;
  return pathLength(points) + haversineDistance(points[points.length - 1], points[0]);
}

/** Destination point in meters/bearing from a start [lon, lat] — the
 * inverse of haversineDistance/bearing, used to draw a geodesic circle. */
function destinationPoint(start: [number, number], distanceMeters: number, bearingDeg: number): [number, number] {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const [lon1, lat1] = start.map(toRad) as [number, number];
  const brng = toRad(bearingDeg);
  const angularDist = distanceMeters / EARTH_RADIUS_M;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDist) + Math.cos(lat1) * Math.sin(angularDist) * Math.cos(brng)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(angularDist) * Math.cos(lat1),
    Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [((toDeg(lon2) + 540) % 360) - 180, toDeg(lat2)];
}

/** Approximate area in square meters of a geographic ring, via the
 * spherical-excess (Girard's theorem) polygon-area formula — accurate
 * enough for city/district-scale ruler measurements without pulling in a
 * full geodesic library. */
function ringArea(points: [number, number][]): number {
  if (points.length < 3) return 0;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  let total = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = points[i];
    const [lon2, lat2] = points[(i + 1) % n];
    total += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Builds a geodesic circle ring (closed) of `steps` points around a
 * center at the given radius, for rendering + area/perimeter math. */
function circlePolygon(center: [number, number], radiusMeters: number, steps = 64): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) ring.push(destinationPoint(center, radiusMeters, (360 * i) / steps));
  return ring;
}

type MeasureTab = "line" | "path" | "polygon" | "circle";

// Authoritative measurement interaction state machine. Replaces the old
// scattered booleans / point-count heuristics (which could desync — e.g. a
// finished Line lingering as "2 points" so the next click was silently read
// as a third vertex). Handlers read `measurePhaseRef`; the mirrored state
// only drives React rendering / effects.
//   inactive — tool off; map clicks must not touch measurement.
//   idle     — tool on, waiting for the first vertex (no start coord).
//   drawing  — at least one vertex placed; cursor rubber-bands a preview.
type MeasurePhase = "inactive" | "idle" | "drawing";

// Line/Circle finish after exactly 2 points; Path/Polygon accept unlimited
// vertices, finished by a right-click.
const MEASURE_MULTI_POINT_TABS: ReadonlySet<MeasureTab> = new Set(["path", "polygon"]);

type DistanceUnit = "meters" | "kilometers" | "feet" | "yards" | "miles" | "nautical_miles";

const DISTANCE_UNIT_OPTIONS: Array<{ value: DistanceUnit; label: string; metersPerUnit: number }> = [
  { value: "meters", label: "Meters", metersPerUnit: 1 },
  { value: "kilometers", label: "Kilometers", metersPerUnit: 1000 },
  { value: "feet", label: "Feet", metersPerUnit: 0.3048 },
  { value: "yards", label: "Yards", metersPerUnit: 0.9144 },
  { value: "miles", label: "Miles", metersPerUnit: 1609.344 },
  { value: "nautical_miles", label: "Nautical Miles", metersPerUnit: 1852 },
];

function metersToUnit(meters: number, unit: DistanceUnit): number {
  const option = DISTANCE_UNIT_OPTIONS.find((o) => o.value === unit)!;
  return meters / option.metersPerUnit;
}

type AreaUnit = "sq_meters" | "sq_kilometers" | "acres" | "hectares" | "sq_miles" | "sq_feet";

const AREA_UNIT_OPTIONS: Array<{ value: AreaUnit; label: string; sqMetersPerUnit: number }> = [
  { value: "sq_meters", label: "Sq Meters", sqMetersPerUnit: 1 },
  { value: "sq_kilometers", label: "Sq Kilometers", sqMetersPerUnit: 1_000_000 },
  { value: "hectares", label: "Hectares", sqMetersPerUnit: 10_000 },
  { value: "acres", label: "Acres", sqMetersPerUnit: 4046.8564224 },
  { value: "sq_miles", label: "Sq Miles", sqMetersPerUnit: 2_589_988.110336 },
  { value: "sq_feet", label: "Sq Feet", sqMetersPerUnit: 0.09290304 },
];

function sqMetersToUnit(sqMeters: number, unit: AreaUnit): number {
  const option = AREA_UNIT_OPTIONS.find((o) => o.value === unit)!;
  return sqMeters / option.sqMetersPerUnit;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws a standard map-pin marker (teardrop + circular badge + camera
 * glyph) at high resolution and returns raw pixel data — the same visual
 * pattern mapping apps use for photo locations (Google Maps, Mapillary,
 * etc.), rendered crisp rather than the small hand-drawn glyph this
 * replaced, which looked muddy at map scale. */
function buildPhotoIconImageData(): ImageData {
  const w = 96, h = 120;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  const pinColor = "#f2b134";
  const strokeColor = "#20140a";
  const cx = w / 2;
  const r = 38;
  const cy = r + 10;

  // Tail (drawn first so the badge circle cleanly covers the seam where
  // the triangle meets the circle).
  const spread = (30 * Math.PI) / 180;
  const leftX = cx - r * Math.sin(spread);
  const rightX = cx + r * Math.sin(spread);
  const baseY = cy + r * Math.cos(spread);
  ctx.beginPath();
  ctx.moveTo(leftX, baseY);
  ctx.lineTo(cx, h - 4);
  ctx.lineTo(rightX, baseY);
  ctx.closePath();
  ctx.fillStyle = pinColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Circular badge
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = pinColor;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  // White disc the camera glyph sits on, for contrast against the badge color.
  ctx.beginPath();
  ctx.arc(cx, cy, r - 9, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  // Camera glyph
  ctx.fillStyle = strokeColor;
  const camW = 34, camH = 22;
  const camX = cx - camW / 2, camY = cy - camH / 2 + 3;
  roundRectPath(ctx, camX, camY, camW, camH, 4);
  ctx.fill();
  roundRectPath(ctx, cx - 8, camY - 7, 16, 8, 2.5);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy + 3, 8, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy + 3, 4, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();

  return ctx.getImageData(0, 0, w, h);
}

function decodeFeature(raw: {
  id?: string | number;
  geometry: unknown;
  properties?: Record<string, unknown> | null;
}): UrbanFeature {
  const props = raw.properties ?? {};
  let attrs: Record<string, unknown> = {};
  if (typeof props.attributes === "string") {
    try { attrs = JSON.parse(props.attributes); } catch { attrs = { _raw: props.attributes }; }
  } else if (props.attributes && typeof props.attributes === "object") {
    attrs = props.attributes as Record<string, unknown>;
  }
  return {
    type: "Feature",
    id: String(raw.id ?? props.id),
    geometry: raw.geometry as UrbanFeature["geometry"],
    properties: {
      id: String(props.id ?? raw.id),
      dataset_id: String(props.dataset_id ?? ""),
      label: (props.label as string | null) ?? null,
      category: (props.category as string | null) ?? null,
      severity: Number(props.severity ?? 0),
      attributes: attrs,
    },
  };
}

function extendCoordinateBounds(bounds: maplibregl.LngLatBounds, coordinates: unknown): void {
  if (!Array.isArray(coordinates)) return;
  if (
    coordinates.length >= 2
    && typeof coordinates[0] === "number"
    && typeof coordinates[1] === "number"
    && Number.isFinite(coordinates[0])
    && Number.isFinite(coordinates[1])
  ) {
    bounds.extend([coordinates[0], coordinates[1]]);
    return;
  }
  coordinates.forEach((nested) => extendCoordinateBounds(bounds, nested));
}

function featureFocusGeometry(feature: UrbanFeature): {
  bounds: maplibregl.LngLatBounds;
  anchor: maplibregl.LngLat;
  isPoint: boolean;
} | null {
  const bounds = new maplibregl.LngLatBounds();
  extendCoordinateBounds(bounds, feature.geometry.coordinates);
  if (bounds.isEmpty()) return null;
  return {
    bounds,
    anchor: bounds.getCenter(),
    isPoint: feature.geometry.type === "Point" || feature.geometry.type === "MultiPoint",
  };
}

function buildCategoryColorExpression(
  colorByCategory: Map<string, string>
): maplibregl.ExpressionSpecification | string {
  // A MapLibre "match" expression requires at least one input/output pair
  // before its fallback value Ã¢â‚¬â€ with zero categories seen yet (empty map,
  // no features loaded), building one anyway produces an invalid
  // expression that throws at runtime. Fall back to a plain solid color.
  if (colorByCategory.size === 0) return UNCATEGORIZED_COLOR;
  const pairs: (string | maplibregl.ExpressionSpecification)[] = [];
  colorByCategory.forEach((color, category) => { pairs.push(category, color); });
  return ["match", ["coalesce", ["get", "category"], "uncategorized"], ...pairs, UNCATEGORIZED_COLOR] as unknown as maplibregl.ExpressionSpecification;
}

/** AI Detection focus modes — each isolates the map to one asset family and
 * one anomaly type, instead of showing every layer/finding at once. */
export type DetectionMode = "poles" | "drains" | "manholes" | null;

const DETECTION_MODE_TARGET_CLASSES: Record<Exclude<DetectionMode, null>, string[]> = {
  poles: ["Illumination_Asset"],
  drains: ["Building", "Drainage_Asset"],
  manholes: ["Access_Point"],
};

const DETECTION_MODE_ANOMALY_TYPE: Record<Exclude<DetectionMode, null>, string> = {
  poles: "pole_redundancy",
  drains: "drain_encroachment",
  manholes: "manhole_status",
};

// Deliberately darker/more saturated than the category-color palette used
// elsewhere — these need to read clearly as a choropleth at a glance, not
// blend into the basemap at the low opacity used for the normal severity
// fill (see DRAINS_MODE_FILL_OPACITY below).
// Deliberately a true red/gold/green trio, not two dark brownish-orange
// tones — #b91c1c red and the old #b45309 amber read as near-identical at
// 0.75 fill opacity over a cream basemap, which is why crossed (red) and
// grazed (yellow) buildings were hard to tell apart by eye. Matches the
// --danger/--warn/--ok tokens used by the AI Alert card badges.
const BUILDING_DEFAULT_COLOR = "#16a34a"; // green — not (meaningfully) encroached
const BUILDING_RED_COLOR = "#dc2626"; // red — drain crosses straight through
const BUILDING_YELLOW_COLOR = "#eab308"; // gold/yellow — partial graze, no full crossing
const DRAINS_MODE_FILL_OPACITY = 0.75;
const DEFAULT_FILL_OPACITY = 0.35;

/** In Drains mode, buildings are recolored by their OWN encroachment
 * finding rather than shown as a separate point marker — a fully/partly
 * encroached building is highlighted red/yellow, everything else defaults
 * to green ("confirmed OK"), matching a real choropleth rather than pins. */
function buildBuildingColorExpression(
  buildingColor: Record<string, "red" | "yellow">
): maplibregl.ExpressionSpecification | string {
  const entries = Object.entries(buildingColor);
  if (entries.length === 0) return BUILDING_DEFAULT_COLOR;
  const pairs: (string | maplibregl.ExpressionSpecification)[] = [];
  for (const [id, color] of entries) pairs.push(id, color === "red" ? BUILDING_RED_COLOR : BUILDING_YELLOW_COLOR);
  return ["match", ["get", "id"], ...pairs, BUILDING_DEFAULT_COLOR] as unknown as maplibregl.ExpressionSpecification;
}

const ANOMALY_BADGE_COLOR: Record<SpatialAnomaly["color"], string> = {
  red: BUILDING_RED_COLOR,
  yellow: BUILDING_YELLOW_COLOR,
  green: BUILDING_DEFAULT_COLOR,
};

const ANOMALY_TYPE_LABEL: Record<SpatialAnomaly["anomaly_type"], string> = {
  pole_redundancy: "Pole Redundancy",
  drain_encroachment: "Drain Encroachment",
  manhole_status: "Manhole Status",
};

/** One-line, numbers-first summary for the hover tooltip's AI Detected
 * badge — same underlying facts as the click-through AI Alert card, just
 * condensed so it's readable at a glance without opening anything. */
function summarizeAnomalyForTooltip(a: SpatialAnomaly): { color: SpatialAnomaly["color"]; typeLabel: string; metric: string } {
  const m = a.anomaly_metadata;
  let metric = "";
  if (a.anomaly_type === "pole_redundancy") {
    metric = a.color === "green"
      ? `Kept — cluster of ${m.cluster_size ?? "?"}`
      : a.color === "red"
      ? `Redundant — cluster of ${m.cluster_size ?? "?"}`
      : `Borderline — ${m.nearest_neighbor_m ?? "?"}m from nearest`;
  } else if (a.anomaly_type === "drain_encroachment") {
    const ratioPct = m.crossing_ratio_pct ? Number(m.crossing_ratio_pct) : 0;
    const areaTxt = `${m.overlap_area_m2 ?? "?"}m² encroached of ${m.building_area_m2 ?? "?"}m² footprint`;
    metric = m.drain_crosses_building
      ? `Drain crosses straight through this building — spans ${ratioPct.toFixed(0)}% of its own width (${areaTxt})`
      : `Building touches the drain line, only a partial clip — spans ${ratioPct.toFixed(0)}% of its own width (${areaTxt})`;
  } else if (a.anomaly_type === "manhole_status") {
    metric = m.nearest_drain_category
      ? `Nearest drain: ${m.nearest_drain_category} (${m.nearest_drain_distance_m ?? "?"}m)`
      : "No nearby drain found";
  }
  return { color: a.color, typeLabel: ANOMALY_TYPE_LABEL[a.anomaly_type], metric };
}

const EMPTY_FC: FeatureCollectionResponse = { type: "FeatureCollection", features: [], bbox: [0, 0, 0, 0], count: 0, limit: 0, truncated: false };

export interface ViewportStatus { loading: boolean; count: number; truncated: boolean; error: string | null; bbox: [number, number, number, number] | null; }
export interface LegendEntry { category: string; color: string; count: number; }
interface HoverInfo {
  x: number;
  y: number;
  label: string;
  category: string;
  severity: number;
  color: string;
  attributes: Record<string, unknown>;
  aiStatus?: "redundant" | "needed";
  /** Populated only while the AI Detection overlay is on and this feature
   * has a finding of its own — a quick "AI Detected" badge at a glance,
   * without needing to click. */
  aiDetection?: { color: SpatialAnomaly["color"]; typeLabel: string; metric: string };
}
interface LayerAttributeTableState extends LayerFeatureTableFilter {
  sourceLabel: string;
}
export interface MapCanvasHandle {
  clearDatasets: () => void;
  toggleMeasure: () => void;
  isMeasureActive: () => boolean;
}

export const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(
  { filter, onFeatureSelect, onActiveDatasetsChange, initialActiveDatasets, aiHighlights, focusFeatureId, onFocusHandled, onMeasureChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // AbortController normally prevents an older data response from being
  // applied after a newer one. Keep an explicit sequence as well because a
  // response can already be resolving when a rapid dashboard change aborts it.
  const fetchSequenceRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const filterRef = useRef<FeatureFilter>(filter);

  const [status, setStatus] = useState<ViewportStatus>({ loading: false, count: 0, truncated: false, error: null, bbox: null });
  const [legend, setLegend] = useState<LegendEntry[]>([]);
  // Full (unsliced) per-category breakdown of the currently loaded features,
  // for the QGIS-style layer-visibility checklist in the Command Center —
  // `legend` above stays capped at 10 entries for the compact map overlay.
  const [categoryStats, setCategoryStats] = useState<LegendEntry[]>([]);
  // Categories unchecked in that checklist — purely a client-side paint/
  // filter toggle on already-fetched features, so it applies instantly and
  // never touches the topbar ward/category filter or triggers a refetch.
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());
  const [basemap, setBasemap] = useState<Basemap>("street");
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [photoViewer, setPhotoViewer] = useState<{ url: string; label: string; isPanorama: boolean } | null>(null);
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  // More than one entry lets two or more datasets be shown together (e.g. a
  // raster orthophoto plus its companion GDB vector layer over the same area).
  // Seeded from the parent-persisted selection (survives this component
  // being unmounted when the user navigates to another tab and back).
  const [activeDatasetIds, setActiveDatasetIds] = useState<string[]>(
    () => initialActiveDatasets?.map((d) => d.id) ?? []
  );
  const rasterLayersRef = useRef<Set<string>>(new Set());
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  const [rasterSettingsById, setRasterSettingsById] = useState<Record<string, RasterDisplaySettings>>({});

  // Spatial Audit Engine — persisted findings for the currently active
  // dataset(s), plus which one (if any) is open in the AI Alert card.
  const [anomalies, setAnomalies] = useState<SpatialAnomaly[]>([]);
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Which AI Detection focus mode is active (null = normal full view).
  // Refs mirror the state so the per-fetch applyFeatureCollection callback
  // (a stable useCallback, not re-created on every mode change) always reads
  // the CURRENT mode/building colors without needing to be in its deps.
  const [detectionMode, setDetectionMode] = useState<DetectionMode>(null);
  const detectionModeRef = useRef<DetectionMode>(null);
  // Selecting a mode only isolates the map to that asset family (plain
  // category colors) — the actual AI red/yellow/green overlay is a
  // separate, explicit step, so a fresh mode selection always starts with
  // this off until the user turns it on.
  const [aiOverlayEnabled, setAiOverlayEnabled] = useState(false);
  const aiOverlayEnabledRef = useRef(false);
  const buildingColorMapRef = useRef<Record<string, "red" | "yellow">>({});
  // feature id -> its own anomaly, for the hover tooltip's "AI Detected"
  // badge — populated whenever anomalies changes, read via ref from the
  // hover handler (registered once at map load).
  const anomalyByFeatureIdRef = useRef<Record<string, SpatialAnomaly>>({});
  // building feature id -> its drain_encroachment SpatialAnomaly id, so a
  // click on a recolored building in Drains mode can open the AI Alert card
  // for that specific finding (read via ref from the click handler, which
  // is registered once at map load and would otherwise close over stale
  // state — same pattern as the other mode-driven refs above).
  const buildingAnomalyIdMapRef = useRef<Record<string, string>>({});
  // raw_category -> canonical_class, fetched once, used to compute which
  // categories a detection mode should hide (e.g. Poles mode hides
  // everything except Illumination_Asset categories).
  const [classMap, setClassMap] = useState<Record<string, string>>({});
  const rasterSettingsRef = useRef<Record<string, RasterDisplaySettings>>({});
  const [flyError, setFlyError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [attributeTable, setAttributeTable] = useState<LayerAttributeTableState | null>(null);
  const [streetPickMode, setStreetPickMode] = useState(false);
  const [streetViewTarget, setStreetViewTarget] = useState<{ latitude: number; longitude: number } | null>(null);
  const [loadedFeatures, setLoadedFeatures] = useState<UrbanFeature[]>([]);
  const streetPickModeRef = useRef(false);
  const streetPickConsumedRef = useRef(false);
  const [pendingFocusFeatureId, setPendingFocusFeatureId] = useState<string | null>(focusFeatureId ?? null);
  const focusAbortRef = useRef<AbortController | null>(null);
  const focusClearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (focusFeatureId) setPendingFocusFeatureId(focusFeatureId);
  }, [focusFeatureId]);

  // Look Around mode takes over map dragging to change bearing/pitch, which
  // would conflict with every other pointer-driven tool (street-view pick,
  // measurement). Turning any of those on force-exits Look Around first;
  // deliberately one-directional so it never has to reach into their
  // internal cancellation logic.
  const deactivateLookAround = useCallback(() => {
    if (!lookAroundActiveRef.current) return;
    lookAroundActiveRef.current = false;
    setLookAroundActive(false);
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = "";
  }, []);

  const toggleStreetPickMode = useCallback(() => {
    deactivateLookAround();
    setStreetPickMode((current) => {
      const next = !current;
      streetPickModeRef.current = next;
      const canvas = mapRef.current?.getCanvas();
      if (canvas) canvas.style.cursor = next ? "crosshair" : "";
      return next;
    });
  }, [deactivateLookAround]);

  // Ruler / measurement tool (Google Earth Pro-style dialog: Line, Path,
  // Polygon, Circle) — off by default. `measureActiveRef`/`measurePointsRef`
  // mirror state into refs so the map click/mousemove handlers (registered
  // once on "load") always read the latest value instead of a stale closure.
  const [measureActive, setMeasureActive] = useState(false);
  const measureActiveRef = useRef(false);
  const [measureTab, setMeasureTab] = useState<MeasureTab>("line");
  const measureTabRef = useRef<MeasureTab>("line");
  // Locked vertices for the shape in progress. Point-count semantics differ
  // per tab: Line/Circle cap at exactly 2 (start + end/radius point); Path/
  // Polygon accept unlimited vertices, finished by a right-click. A live
  // preview point (following the mouse) is kept separate so it doesn't get
  // treated as a locked vertex.
  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([]);
  const measurePointsRef = useRef<[number, number][]>([]);
  const [measurePreviewPoint, setMeasurePreviewPoint] = useState<[number, number] | null>(null);
  // Explicit drawing state machine — see `MeasurePhase`. Handlers read the
  // ref; the state mirror only drives React rendering / effects.
  const [measurePhase, setMeasurePhaseState] = useState<MeasurePhase>("inactive");
  const measurePhaseRef = useRef<MeasurePhase>("inactive");
  // Monotonic id that invalidates any in-flight preview RAF callback whenever
  // the measurement is reset / cleared / cancelled / finalized, so a stale
  // frame can never re-draw old geometry after the state has moved on.
  const measureSessionRef = useRef(0);
  // Last known cursor position in map-container pixel space (screen point,
  // NOT lng/lat) — the authoritative geographic preview endpoint is always
  // re-derived from this via map.unproject() against the *current* camera.
  // A stationary cursor still points at a different geographic location
  // once the map pans/zooms under it, and MapLibre does not synthesize a
  // "mousemove" for that — only "render" fires on every frame of a pan,
  // zoom, or programmatic camera animation (flyTo/easeTo/fitBounds), so
  // that's what re-syncs the preview instead of relying on move/zoom end.
  const latestPointerPointRef = useRef<{ x: number; y: number } | null>(null);
  const measureRafRef = useRef<number | null>(null);
  const [measureUnit, setMeasureUnit] = useState<DistanceUnit>("kilometers");
  const [measureAreaUnit, setMeasureAreaUnit] = useState<AreaUnit>("sq_kilometers");
  // Ruler panel's dragged position — null means "use the default centered
  // position". Persists across close/reopen for the life of this component
  // (i.e. this tab session), reset on a full page reload like the rest of
  // the map's in-memory UI state.
  const [rulerPanelPos, setRulerPanelPos] = useState<{ x: number; y: number } | null>(null);

  // Live cursor position readout (bottom-right, Google-Earth-style).
  const [cursorLngLat, setCursorLngLat] = useState<[number, number] | null>(null);

  // Text-only scale label ("200 m", "1 km", ...) shown in a fixed-size box
  // next to the coordinate readout — replaces MapLibre's built-in
  // ScaleControl, whose DOM element resizes its bar width on every zoom
  // (correct for a real proportional scale bar, but causes the visible
  // status chip to grow/shrink, which looked unstable).
  const [mapScaleLabel, setMapScaleLabel] = useState("");

  // Drives the horizontal zoom slider (Google Earth Pro-style) — mirrors
  // the map's actual zoom so the thumb stays in sync with wheel/pinch/
  // keyboard zoom, not just drags on the slider itself.
  const [mapZoom, setMapZoom] = useState(DAVANGERE_ZOOM);

  // Drives the round compass control — mirrors the map's actual bearing so
  // it stays in sync with right-click-drag rotation, not just the compass
  // dial itself.
  const [mapBearing, setMapBearing] = useState(0);
  // Mirrors the map's actual pitch (3D tilt) for the Look Around compass's
  // up/down buttons and drag-to-look interaction.
  const [mapPitch, setMapPitch] = useState(0);

  // Look Around mode (compass centre button): while active, dragging
  // anywhere on the map changes bearing/pitch instead of panning. Mirrored
  // into a ref for the same reason streetPickMode/measureActive are —
  // map event handlers registered once on "load" need the latest value
  // without becoming stale closures.
  const [lookAroundActive, setLookAroundActive] = useState(false);
  const lookAroundActiveRef = useRef(false);

  // Keep a fast lookup: featureId → "redundant" | "needed" for tooltip + hover
  const aiStatusRef = useRef<Map<string, "redundant" | "needed">>(new Map());
  const aiCoordinateHighlightsRef = useRef<AiHighlight[]>([]);
  // Cache of featureId → [lon, lat] populated whenever features are loaded
  const featureCoordsRef = useRef<Map<string, [number, number]>>(new Map());

  /** Push the current aiStatusRef contents into the AI highlight GeoJSON source.
   * Called both from the aiHighlights useEffect and from applyFeatureCollection
   * so the overlay is always up-to-date regardless of which arrives first. */
  const flushAiHighlightSource = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource(AI_HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    const feats: GeoJSON.Feature[] = [];
    aiStatusRef.current.forEach((status, featureId) => {
      const coords = featureCoordsRef.current.get(featureId);
      if (coords) {
        feats.push({
          type: "Feature",
          id: featureId,
          geometry: { type: "Point", coordinates: coords },
          properties: { id: featureId, ai_status: status },
        });
      }
    });
    for (const h of aiCoordinateHighlightsRef.current) {
      if (h.coordinates) {
        feats.push({
          type: "Feature",
          id: h.featureId ?? `${h.status}-${h.coordinates.join(",")}`,
          geometry: { type: "Point", coordinates: h.coordinates },
          properties: { id: h.featureId ?? "proposed", ai_status: h.status, reason: h.reason ?? "Proposed service-gap pole" },
        });
      }
    }
    src.setData({ type: "FeatureCollection", features: feats });
  }, []);

  // Sync AI highlights → aiStatusRef and then flush to the map source.
  // Also fetches missing coordinates directly from the API so the overlay
  // works even before a full viewport fetch has populated featureCoordsRef.
  useEffect(() => {
    if (!mapReady) return;

    const lookup = new Map<string, "redundant" | "needed">();
    const coordinateHighlights: AiHighlight[] = [];
    for (const h of aiHighlights ?? []) {
      if (h.coordinates) coordinateHighlights.push(h);
      else if (h.featureId) lookup.set(h.featureId, h.status);
    }
    aiStatusRef.current = lookup;
    aiCoordinateHighlightsRef.current = coordinateHighlights;

    if (lookup.size === 0 && coordinateHighlights.length === 0) {
      flushAiHighlightSource();
      return;
    }

    // Collect IDs whose coords we don't have cached yet
    const missing = [...lookup.keys()].filter(
      (id) => !featureCoordsRef.current.has(id)
    );

    if (missing.length === 0) {
      // All coords already in cache — paint immediately
      flushAiHighlightSource();
      return;
    }

    // Fetch missing coords via the features API (by IDs)
    const params = new URLSearchParams();
    for (const id of missing) params.append("id", id);
    params.set("limit", String(missing.length + 10));
    fetch(`${API_BASE}/api/v1/features?${params.toString()}`, { credentials: "include" })
      .then((r) => r.json())
      .then((fc: { features?: Array<{ id?: string; geometry?: { type: string; coordinates: unknown }; properties?: { id?: string } }> }) => {
        for (const f of fc.features ?? []) {
          const fid = String(f.properties?.id ?? f.id ?? "");
          if (fid && f.geometry?.type === "Point") {
            featureCoordsRef.current.set(fid, f.geometry.coordinates as [number, number]);
          }
        }
        flushAiHighlightSource();
      })
      .catch(() => {
        // Best-effort: flush whatever we have from cache
        flushAiHighlightSource();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiHighlights, mapReady, flushAiHighlightSource]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDatasets(ctrl.signal).then(setDatasets).catch(() => {});
    return () => ctrl.abort();
  }, []);

  // If a previously-active dataset was deleted (e.g. removed and the same
  // GDB re-uploaded, which mints a brand-new dataset_id), its old id can
  // otherwise linger forever in activeDatasetIds — it's only ever added/
  // removed by explicit toggle clicks, never reconciled against the real
  // dataset list. A stale id here silently poisons "Run Spatial Audit"
  // (it 404s on the deleted dataset) and viewport fetches, so drop
  // anything no longer present the moment the dataset list refreshes.
  useEffect(() => {
    if (datasets.length === 0) return;
    const validIds = new Set(datasets.map((d) => d.id));
    setActiveDatasetIds((current) => {
      const pruned = current.filter((id) => validIds.has(id));
      return pruned.length === current.length ? current : pruned;
    });
  }, [datasets]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchAllClassMappings(ctrl.signal)
      .then((rows) => {
        const map: Record<string, string> = {};
        for (const r of rows) map[r.raw_category] = r.canonical_class;
        setClassMap(map);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  const colorByCategoryRef = useRef<Map<string, string>>(new Map());

  const changeBasemap = useCallback((next: Basemap) => {
    const map = mapRef.current;
    if (!map) return;
    setBasemap(next);
    map.setLayoutProperty("osm", "visibility", next === "street" ? "visible" : "none");
    map.setLayoutProperty("satellite", "visibility", next === "satellite" ? "visible" : "none");
  }, []);

  // Renders the locked vertices plus, while still placing the shape, a live
  // preview out to `previewPoint` (the current mouse position) — the same
  // "rubber band" behavior as Google Earth Pro's ruler tools. Geometry
  // shape depends on the active tab:
  //  - line/path: open LineString through the locked points (+ preview).
  //  - polygon: closed ring (line) + filled polygon through the locked
  //    points (+ preview), so the shape is visible while still open.
  //  - circle: locked point 0 is the center; the second point (locked or
  //    live preview) sets the radius — rendered as a geodesic circle ring
  //    (line) + filled polygon, not the raw two clicked points.

  // Single entry point for updating the authoritative phase — keeps the ref
  // (read by map handlers) and the React state (used for rendering/effects)
  // perfectly in sync so they can never contradict each other.
  const setMeasurePhase = useCallback((next: MeasurePhase) => {
    measurePhaseRef.current = next;
    setMeasurePhaseState(next);
  }, []);

  // Cancels any in-flight preview frame and bumps the session id so a frame
  // scheduled before a reset can never redraw stale geometry afterwards.
  const beginNewSession = useCallback(() => {
    if (measureRafRef.current !== null) {
      cancelAnimationFrame(measureRafRef.current);
      measureRafRef.current = null;
    }
    measureSessionRef.current += 1;
  }, []);

  // Guarded on source existence (map.getSource returning the source), NOT
  // map.isStyleLoaded() — that flag reflects whether the WHOLE style is
  // currently idle (including unrelated basemap/feature tile loading), and
  // flips to false very frequently during ordinary panning/zooming/tile
  // fetch, long after the measurement sources themselves were created once
  // on "load". Gating on it was silently dropping legitimate setData calls
  // (a placed point's marker/line/endpoint intermittently failing to
  // render) purely because some unrelated tile was mid-fetch at that exact
  // moment — GeoJSONSource.setData() itself has no such requirement, only
  // that the source already exists.
  const flushMeasureSources = useCallback((previewPoint?: [number, number] | null) => {
    const map = mapRef.current;
    if (!map) return;
    const points = measurePointsRef.current;
    const tab = measureTabRef.current;
    const pointSrc = map.getSource(MEASURE_POINTS_SOURCE) as GeoJSONSource | undefined;
    const lineSrc = map.getSource(MEASURE_LINE_SOURCE) as GeoJSONSource | undefined;
    const fillSrc = map.getSource(MEASURE_FILL_SOURCE) as GeoJSONSource | undefined;
    const radiusSrc = map.getSource(MEASURE_RADIUS_LINE_SOURCE) as GeoJSONSource | undefined;

    if (pointSrc) {
      pointSrc.setData({
        type: "FeatureCollection",
        features: points.map((p, i) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: p },
          properties: { index: i },
        })),
      });
    }

    let lineCoords: [number, number][] = [];
    let fillCoords: [number, number][] | null = null;
    // Dedicated center→boundary radius line for the Circle tool. Kept in its own
    // source so it never gets wiped by a preview reset that clears the outline,
    // and so it sits above the fill but below the point markers. Null unless the
    // active tab is a Circle with a known center + edge (preview or confirmed).
    let radiusLineCoords: [number, number][] | null = null;

    if (tab === "circle") {
      const center = points[0];
      const edge = points[1] ?? previewPoint;
      if (center && edge) {
        const radius = haversineDistance(center, edge);
        const ring = circlePolygon(center, radius);
        lineCoords = [...ring, ring[0]];
        fillCoords = lineCoords;
        radiusLineCoords = [center, edge];
      }
    } else if (tab === "polygon") {
      const live = points.length >= 1 && previewPoint ? [...points, previewPoint] : points;
      if (live.length >= 2) lineCoords = [...live, live[0]];
      if (live.length >= 3) fillCoords = [...live, live[0]];
    } else {
      // line / path
      lineCoords = points.length >= 1 && previewPoint ? [...points, previewPoint] : points;
    }

    if (lineSrc) {
      lineSrc.setData({
        type: "FeatureCollection",
        features: lineCoords.length > 1
          ? [{ type: "Feature", geometry: { type: "LineString", coordinates: lineCoords }, properties: {} }]
          : [],
      });
    }
    if (fillSrc) {
      fillSrc.setData({
        type: "FeatureCollection",
        features: fillCoords
          ? [{ type: "Feature", geometry: { type: "Polygon", coordinates: [fillCoords] }, properties: {} }]
          : [],
      });
    }
    if (radiusSrc) {
      radiusSrc.setData({
        type: "FeatureCollection",
        features: radiusLineCoords
          ? [{ type: "Feature", geometry: { type: "LineString", coordinates: radiusLineCoords }, properties: {} }]
          : [],
      });
    }
  }, []);

  // Whether a rubber-band preview should currently be tracking the cursor:
  // true whenever the tool is in the "drawing" phase (at least one vertex
  // placed and not yet finished) — for every tab, not just Line/Circle.
  const isAwaitingMeasurePreview = useCallback(() => {
    return measurePhaseRef.current === "drawing";
  }, []);

  // Re-derives the preview endpoint from the *current* camera and the last
  // known cursor pixel — this is what keeps the line synced when the map
  // pans/zooms under a stationary cursor. Always reads from refs (never
  // captures coordinates in a closure), so a newer scheduled frame can
  // never be overwritten by a stale one.
  const updateMeasurePreviewFromPointer = useCallback(() => {
    const map = mapRef.current;
    const point = latestPointerPointRef.current;
    if (!map || !point) return;
    if (!measureActiveRef.current || !isAwaitingMeasurePreview()) return;
    const lngLat = map.unproject([point.x, point.y]);
    const next: [number, number] = [lngLat.lng, lngLat.lat];
    setMeasurePreviewPoint(next);
    flushMeasureSources(next);
  }, [flushMeasureSources, isAwaitingMeasurePreview]);

  // Coalesces mousemove/render bursts into at most one preview update per
  // animation frame — only one frame is ever in flight at a time, and it
  // always consumes the latest ref values when it finally runs. The captured
  // session id makes the frame a no-op if the measurement was reset in the
  // meantime (clear/escape/finalize/tool-switch), so no stale geometry can
  // be re-applied after the state has moved on.
  const scheduleMeasurePreviewUpdate = useCallback(() => {
    if (measureRafRef.current !== null) return;
    const sessionId = measureSessionRef.current;
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = null;
      if (sessionId !== measureSessionRef.current) return;
      updateMeasurePreviewFromPointer();
    });
  }, [updateMeasurePreviewFromPointer]);

  const cancelScheduledMeasurePreviewUpdate = useCallback(() => {
    if (measureRafRef.current !== null) {
      cancelAnimationFrame(measureRafRef.current);
      measureRafRef.current = null;
    }
  }, []);

  // Whether a measurement tool currently owns map input — true only while
  // the Measure panel is open AND a tool is actually armed/drawing (phase
  // !== "inactive"). Escape deactivates the tool (phase -> "inactive") but
  // deliberately leaves the panel open, so `measureActiveRef.current` alone
  // is NOT enough to decide whether ordinary data-layer hover/click should
  // stay suspended — after Escape the panel is still open but the tool no
  // longer owns input, so normal layers must go back to being interactive.
  const isMeasureInputActive = useCallback(() => {
    return measureActiveRef.current && measurePhaseRef.current !== "inactive";
  }, []);

  // Keeps the canvas cursor consistent with the authoritative measurement state:
  // crosshair while a mode is selected and not deactivated, plain otherwise.
  // Reads from refs so it can be called synchronously right after a phase
  // change (state updates are async but the refs are set immediately).
  const syncMeasureCursor = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = isMeasureInputActive() ? "crosshair" : "";
  }, [isMeasureInputActive]);

  // Closes any ordinary data-layer hover tooltip that was already open the
  // instant a measurement tool is activated (or switched) — guarding the
  // hover/click handlers on measureActiveRef only prevents FUTURE popups;
  // a tooltip already showing needs its state cleared explicitly, or it
  // would keep rendering, stale, until the next real mouse event. Cursor
  // ownership is handled separately by syncMeasureCursor.
  const suspendDataLayerInteraction = useCallback(() => {
    setHover(null);
  }, []);

  // Shared: wipes every in-progress measurement artifact (pending preview
  // frame, cursor pixel, locked vertices, live preview point) and guarantees
  // no stale RAF/closure can repaint old geometry. Does NOT touch the phase
  // or the panel visibility — callers decide the resulting phase (inactive for
  // Escape, idle for a fresh tab / Clear) and whether the tool stays open.
  const resetMeasureTempState = useCallback(() => {
    cancelScheduledMeasurePreviewUpdate();
    latestPointerPointRef.current = null;
    measurePointsRef.current = [];
    setMeasurePoints([]);
    setMeasurePreviewPoint(null);
    beginNewSession();
  }, [cancelScheduledMeasurePreviewUpdate, beginNewSession]);

  // Central cancellation for Escape, panel close, and any future tool-switch
  // with an unfinished shape. Cancels ONLY the unfinished active measurement
  // and leaves any already-finished shape on the map untouched — Escape must
  // never delete a completed measurement. The panel stays open but the tool
  // is marked "inactive", so map clicks / right-click / mousemove can no
  // longer add or rebuild geometry until the user explicitly selects a mode
  // tab again.
  const cancelActiveMeasurement = useCallback(
    (_reason: "escape" | "panel-close" | "tool-switch" | "unmount") => {
      const wasDrawing = measurePhaseRef.current === "drawing";
      // Only discard locked vertices if a shape was still being drawn. A
      // finished measurement (phase "idle" with confirmed points) is preserved.
      if (wasDrawing) {
        measurePointsRef.current = [];
        setMeasurePoints([]);
        setMeasurePreviewPoint(null);
      }
      cancelScheduledMeasurePreviewUpdate();
      latestPointerPointRef.current = null;
      beginNewSession();
      setMeasurePhase("inactive");
      flushMeasureSources(null);
      syncMeasureCursor();
    },
    [flushMeasureSources, cancelScheduledMeasurePreviewUpdate, beginNewSession, setMeasurePhase, syncMeasureCursor]
  );

  // The single real owner of Measure-window visibility — the same
  // `measureActive` state the X button and the toolbar toggle already share.
  // Marks the tool inactive, stops all pending preview work, and hides the
  // panel WITHOUT discarding an already-finished measurement (it stays on the
  // map until the next open or an explicit Clear). This is what makes
  // Escape/X "preserve completed measurements" while still closing the window.
  const closeMeasurePanel = useCallback(() => {
    measureActiveRef.current = false;
    setMeasureActive(false);
    cancelScheduledMeasurePreviewUpdate();
    latestPointerPointRef.current = null;
    beginNewSession();
    setMeasurePhase("inactive");
    flushMeasureSources(null);
    syncMeasureCursor();
  }, [cancelScheduledMeasurePreviewUpdate, beginNewSession, flushMeasureSources, setMeasurePhase, syncMeasureCursor]);

  // ONE safe-close path shared by the X button and the Escape key: cancel any
  // unfinished measurement first (preserving completed ones), then close the
  // window through the real `measureActive` state. Escape and X are now
  // guaranteed to behave identically.
  const closeMeasureSafely = useCallback(() => {
    cancelActiveMeasurement("panel-close");
    closeMeasurePanel();
  }, [cancelActiveMeasurement, closeMeasurePanel]);

  // "Clear" wipes every measurement (finished and unfinished) per this app's
  // single-shot UX and leaves the tool armed/idle so a new measurement can
  // start immediately — distinct from Escape, which only cancels the in-progress
  // shape and preserves any already-finished one.
  const clearMeasurement = useCallback(() => {
    resetMeasureTempState();
    setMeasurePhase("idle");
    flushMeasureSources(null);
  }, [resetMeasureTempState, flushMeasureSources, setMeasurePhase]);

  // Locks the current Path/Polygon at its already-clicked vertices (right-
  // click completion). Only the confirmed, left-clicked points are kept —
  // the cursor's right-click location is never added as a vertex. The shape
  // stays on the map; the phase returns to "idle" so the next left click
  // starts a fresh shape rather than extending the finished one.
  const finishMeasurePath = useCallback(() => {
    const tab = measureTabRef.current;
    if (!MEASURE_MULTI_POINT_TABS.has(tab)) return;
    const minVertices = tab === "polygon" ? 3 : 2;
    if (measurePointsRef.current.length < minVertices) return;
    beginNewSession();
    cancelScheduledMeasurePreviewUpdate();
    setMeasurePreviewPoint(null);
    setMeasurePhase("idle");
    flushMeasureSources(null);
  }, [flushMeasureSources, cancelScheduledMeasurePreviewUpdate, beginNewSession, setMeasurePhase]);

  const toggleMeasureActive = useCallback(() => {
    if (measureActiveRef.current) {
      // Closing via the toolbar toggle reuses the exact same safe-close path
      // as the X button / Escape, so all three stay identical.
      closeMeasureSafely();
      return;
    }
    deactivateLookAround();
    measureActiveRef.current = true;
    setMeasureActive(true);
    beginNewSession();
    cancelScheduledMeasurePreviewUpdate();
    latestPointerPointRef.current = null;
    measurePointsRef.current = [];
    setMeasurePoints([]);
    setMeasurePreviewPoint(null);
    setMeasurePhase("idle");
    flushMeasureSources(null);
    syncMeasureCursor();
    // Close any ordinary data-layer tooltip that happened to be open the
    // instant measurement mode was activated.
    suspendDataLayerInteraction();
  }, [closeMeasureSafely, deactivateLookAround, flushMeasureSources, cancelScheduledMeasurePreviewUpdate, beginNewSession, setMeasurePhase, syncMeasureCursor, suspendDataLayerInteraction]);

  // Toggling Look Around on defers to the same "other tools win" rule as
  // toggleStreetPickMode: it force-exits measurement/street-view-pick first
  // rather than teaching those tools about Look Around.
  const toggleLookAround = useCallback(() => {
    if (lookAroundActiveRef.current) {
      deactivateLookAround();
      return;
    }
    if (measureActiveRef.current) closeMeasureSafely();
    if (streetPickModeRef.current) toggleStreetPickMode();
    lookAroundActiveRef.current = true;
    setLookAroundActive(true);
  }, [deactivateLookAround, closeMeasureSafely, toggleStreetPickMode]);

  // Double-click the compass centre resets bearing AND pitch (unlike the
  // "N" button, which only resets bearing) without touching centre/zoom.
  const resetLookAroundCamera = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ bearing: 0, pitch: DEFAULT_MAP_PITCH, duration: 300 });
  }, []);

  // Switching modes reuses the same cancellation path: the previous tool's
  // unfinished geometry is wiped (via resetMeasureTempState) before the new
  // tab is armed at "idle", so no stale preview/vertices carry over.
  const changeMeasureTab = useCallback((tab: MeasureTab) => {
    resetMeasureTempState();
    measureTabRef.current = tab;
    setMeasureTab(tab);
    setMeasurePhase("idle");
    flushMeasureSources(null);
    syncMeasureCursor();
  }, [resetMeasureTempState, flushMeasureSources, setMeasurePhase, syncMeasureCursor]);

  // Effective vertex list used for the readout — locked points plus the
  // live preview point while a shape is still being placed.
  const measureLiveVertices: [number, number][] =
    measurePreviewPoint && isAwaitingMeasurePreview()
      ? [...measurePoints, measurePreviewPoint]
      : measurePoints;

  let measureLengthMeters = 0;
  let measureAreaSqMeters = 0;
  let measureHeading: number | null = null;
  let measureRadiusMeters = 0;

  if (measureTab === "line") {
    const end = measurePoints.length === 2 ? measurePoints[1] : measurePreviewPoint;
    if (measurePoints.length >= 1 && end) {
      measureLengthMeters = haversineDistance(measurePoints[0], end);
      measureHeading = bearing(measurePoints[0], end);
    }
  } else if (measureTab === "path") {
    measureLengthMeters = pathLength(measureLiveVertices);
  } else if (measureTab === "polygon") {
    measureLengthMeters = measureLiveVertices.length >= 2 ? ringPerimeter(measureLiveVertices) : 0;
    measureAreaSqMeters = measureLiveVertices.length >= 3 ? ringArea(measureLiveVertices) : 0;
  } else if (measureTab === "circle") {
    const center = measurePoints[0];
    const edge = measurePoints.length === 2 ? measurePoints[1] : measurePreviewPoint;
    if (center && edge) {
      measureRadiusMeters = haversineDistance(center, edge);
      measureLengthMeters = 2 * Math.PI * measureRadiusMeters;
      measureAreaSqMeters = Math.PI * measureRadiusMeters * measureRadiusMeters;
    }
  }

  // Mouse Navigation is always enabled for every measurement mode: panning
  // and scroll-zoom stay available so the map can be moved while measuring
  // (the old per-user checkbox has been removed — the enabled behaviour is
  // now permanent). Restored on unmount so navigation never stays stuck off
  // if the map is torn down mid-measurement.
  //
  // Double-click-zoom is suspended only while a measurement mode is actually
  // armed (a tab selected and not yet deactivated), because Path/Polygon finish
  // on right-click (not double-click) and two quick left clicks placing nearby
  // vertices would otherwise also trigger the map's native double-click-zoom,
  // jumping the camera mid-drawing. Once the tool is deactivated via Escape
  // (phase "inactive") the native double-click-zoom is restored, so Escape
  // never leaves a navigation control permanently disabled.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.dragPan.enable();
    map.scrollZoom.enable();
    if (measureActive && measurePhase !== "inactive") {
      map.doubleClickZoom.disable();
    } else {
      map.doubleClickZoom.enable();
    }
    return () => {
      map.dragPan.enable();
      map.scrollZoom.enable();
      map.doubleClickZoom.enable();
    };
  }, [mapReady, measureActive, measurePhase]);

  // Right-click-drag normally rotates the map's bearing (MapLibre's default
  // dragRotate handler) — while a Path/Polygon shape has at least one
  // vertex placed, right-click is instead the "finish this shape" gesture,
  // so rotation is suspended for that window to guarantee a plain
  // right-click always reaches the contextmenu handler above cleanly,
  // rather than potentially being swallowed by drag-rotate. Restored as
  // soon as the shape is finished/cancelled, and on unmount.
  const measureDrawingActive =
    measureActive && MEASURE_MULTI_POINT_TABS.has(measureTab) && measurePhase === "drawing" && measurePoints.length > 0;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (measureDrawingActive) {
      map.dragRotate.disable();
    } else {
      map.dragRotate.enable();
    }
    return () => { map.dragRotate.enable(); };
  }, [mapReady, measureDrawingActive]);

  // Look Around mode: left-click-drag anywhere on the map changes bearing
  // (horizontal movement) and pitch (vertical movement) instead of panning.
  // dragPan is disabled for the duration so the two gestures don't fight,
  // and the cursor swaps to signal the camera-look interaction per the
  // same pattern streetPickMode uses for its crosshair cursor.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !lookAroundActive) return;
    map.dragPan.disable();
    const canvas = map.getCanvas();
    canvas.style.cursor = "grab";

    let dragging = false;
    let activePointerId: number | null = null;
    let lastX = 0;
    let lastY = 0;
    // Pointer Events (not mouse-only) so the same handlers cover touch and
    // pen input, matching the pointer-capture pattern already used by the
    // ruler panel drag and the zoom slider/compass ring above.
    //
    // Look-around drag deliberately bypasses MapLibre's easeTo/inertia path
    // (setBearing/setPitch are synchronous, no animation) so the camera
    // tracks the pointer 1:1 with zero added latency, matching the "click
    // and drag to look around" gesture's expected immediacy.
    const handleDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      activePointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(e.pointerId);
    };
    const handleMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== activePointerId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // 0.3 deg/px keeps a full-width drag well under a full turn — tuned
      // to feel similar to MapLibre's own dragRotate sensitivity.
      map.setBearing(map.getBearing() + dx * 0.3);
      map.setPitch(Math.min(MAX_MAP_PITCH, Math.max(0, map.getPitch() - dy * 0.3)));
    };
    const stopDragging = (e?: PointerEvent) => {
      if (e && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      dragging = false;
      activePointerId = null;
      canvas.style.cursor = "grab";
    };
    const handleBlur = () => stopDragging();
    canvas.addEventListener("pointerdown", handleDown);
    canvas.addEventListener("pointermove", handleMove);
    canvas.addEventListener("pointerup", stopDragging);
    canvas.addEventListener("pointercancel", stopDragging);
    // A pointer that leaves the window entirely (e.g. dragged off-screen)
    // must not leave `dragging` stuck true — matches the blur-safety the
    // task calls out for the press-and-hold rotate buttons. Pointer capture
    // already keeps pointerup/pointermove firing on this canvas even off-
    // element, but window blur (e.g. alt-tab mid-drag) isn't a pointer
    // event at all, so it needs its own listener.
    window.addEventListener("blur", handleBlur);

    return () => {
      canvas.removeEventListener("pointerdown", handleDown);
      canvas.removeEventListener("pointermove", handleMove);
      canvas.removeEventListener("pointerup", stopDragging);
      canvas.removeEventListener("pointercancel", stopDragging);
      window.removeEventListener("blur", handleBlur);
      map.dragPan.enable();
      canvas.style.cursor = "";
    };
  }, [mapReady, lookAroundActive]);

  // Escape deactivates the active measurement TOOL only — it cancels any
  // unfinished shape (preserving completed ones), returns the phase to
  // "inactive" so map clicks stop being consumed by measurement, and
  // restores the normal cursor. It deliberately does NOT close the Measure
  // window/panel: only the explicit X button does that (via
  // closeMeasureSafely). The user can re-arm the same tab by clicking it
  // again (changeMeasureTab always re-arms to "idle" even if that tab was
  // already selected). Registered once on window, guarded purely by refs at
  // fire-time, and ignoring key events from real text fields (none in the
  // panel today) — so it works for every tab, every focus, never
  // double-registers, and never captures a stale active-tool value.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (lookAroundActiveRef.current) {
        e.preventDefault();
        e.stopPropagation();
        deactivateLookAround();
        return;
      }
      if (!measureActiveRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      cancelActiveMeasurement("escape");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFeatureCollection = useCallback((data: FeatureCollectionResponse) => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(FEATURE_SOURCE) as GeoJSONSource | undefined;
    // `isStyleLoaded()` becomes false while new basemap tiles are loading
    // during a zoom. The GeoJSON source already exists at this point and is
    // safe to update, so gating on the whole style caused the new viewport
    // data to be discarded precisely while zooming.
    if (!src) return;
    src.setData(data as unknown as GeoJSON.FeatureCollection);
    // Keep the exact dashboard snapshot available to Street View. The
    // panorama applies the same client-side layer visibility controls and
    // creates nearby, georeferenced markers without issuing another request.
    setLoadedFeatures(data.features);

    // Cache coordinates for every Point feature so the AI highlight layer
    // can place its circles correctly even when highlights arrive after load.
    for (const f of data.features as unknown as GeoJSON.Feature[]) {
      if (f.geometry.type === "Point") {
        const fid = String((f.properties as Record<string, unknown>)?.id ?? f.id ?? "");
        if (fid) featureCoordsRef.current.set(fid, f.geometry.coordinates as [number, number]);
      }
    }

    // If AI highlights are active, refresh the overlay with the newly cached coords.
    // This handles the case where the spacing check ran before features were loaded.
    if (aiStatusRef.current.size > 0) flushAiHighlightSource();

    const colorMap = colorByCategoryRef.current;
    const counts = new Map<string, number>();
    for (const f of data.features as unknown as GeoJSON.Feature[]) {
      const raw = (f.properties as { category?: string | null } | null)?.category;
      if (raw === "raster_pixel") continue;
      const category = raw && raw.trim() !== "" ? raw : "uncategorized";
      if (!colorMap.has(category)) colorMap.set(category, colorForCategory(category));
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    const colorExpr = buildCategoryColorExpression(colorMap);
    if (map.getLayer(LAYER_POINTS)) map.setPaintProperty(LAYER_POINTS, "circle-color", colorExpr);
    if (map.getLayer(LAYER_LINES)) map.setPaintProperty(LAYER_LINES, "line-color", colorExpr);
    // In Drains mode, polygons (buildings) are recolored by their own
    // encroachment finding instead of by category — read via a ref (not
    // component state) so this per-fetch callback always sees the current
    // mode without needing to be re-created on every mode change.
    if (map.getLayer(LAYER_POLY_FILL)) {
      map.setPaintProperty(
        LAYER_POLY_FILL,
        "fill-color",
        detectionModeRef.current === "drains"
          ? buildBuildingColorExpression(buildingColorMapRef.current)
          : colorExpr
      );
    }

    const entries: LegendEntry[] = Array.from(counts.entries())
      .map(([category, count]) => ({ category, color: colorMap.get(category)!, count }))
      .sort((a, b) => b.count - a.count);
    setLegend(entries.slice(0, 10));
    setCategoryStats(entries);
  }, [flushAiHighlightSource]);

  // Re-applies the hidden-category set to every category-aware layer's
  // filter. Runs on mount/mapReady and whenever the checklist changes —
  // client-side only, so toggling a category is instant and never refetches.
  // Deliberately does NOT gate on map.isStyleLoaded(): that flag can be
  // transiently false while tiles are still loading, and this effect only
  // re-runs when hiddenCategories itself changes — a bail-out here would
  // silently drop the filter update with no later retry (the same failure
  // mode fixed earlier for the raster-overlay removal path).
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (map.getLayer(LAYER_POLY_FILL)) map.setFilter(LAYER_POLY_FILL, withCategoryVisibility(POLY_BASE_FILTER, hiddenCategories));
    if (map.getLayer(LAYER_POLY_OUTLINE)) map.setFilter(LAYER_POLY_OUTLINE, withCategoryVisibility(POLY_BASE_FILTER, hiddenCategories));
    if (map.getLayer(LAYER_LINES)) map.setFilter(LAYER_LINES, withCategoryVisibility(LINE_BASE_FILTER, hiddenCategories));
    if (map.getLayer(LAYER_POINTS)) map.setFilter(LAYER_POINTS, withCategoryVisibility(POINT_BASE_FILTER, hiddenCategories));
    if (map.getLayer(LAYER_PHOTOS)) map.setFilter(LAYER_PHOTOS, withCategoryVisibility(PHOTO_BASE_FILTER, hiddenCategories));
  }, [mapReady, hiddenCategories]);

  const toggleCategoryVisibility = useCallback((category: string) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const setAllCategoriesVisible = useCallback((visible: boolean) => {
    setHiddenCategories(visible ? new Set() : new Set(categoryStats.map((c) => c.category)));
  }, [categoryStats]);

  const openLayerAttributeTable = useCallback((category: string) => {
    const currentFilter = filterRef.current;
    const datasetIds = currentFilter.datasetIds?.length ? [...currentFilter.datasetIds] : undefined;
    const selectedNames = datasetIds
      ? datasets.filter((dataset) => datasetIds.includes(dataset.id)).map((dataset) => dataset.name)
      : [];
    const sourceLabel = selectedNames.length === 1
      ? selectedNames[0]
      : selectedNames.length > 1
        ? `${selectedNames.length} selected datasets`
        : currentFilter.ward
          ? `Ward ${currentFilter.ward}`
          : "Current map selection";

    setAttributeTable({
      category,
      datasetIds,
      ward: datasetIds ? undefined : currentFilter.ward,
      severity: datasetIds ? undefined : currentFilter.severity,
      sourceLabel,
    });
  }, [datasets]);

  const runFetch = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const requestSequence = ++fetchSequenceRef.current;

    // If no dataset is selected AND no real topbar filter is active,
    // show an empty map rather than dumping every feature in the viewport.
    const currentFilter = filterRef.current;
    const hasDatasetFilter = (currentFilter.datasetIds?.length ?? 0) > 0;
    const hasRealFilter = Boolean(
      currentFilter.ward
      || currentFilter.category
      || (currentFilter.categories?.length ?? 0) > 0
      || currentFilter.severity !== undefined
    );
    if (!hasDatasetFilter && !hasRealFilter) {
      abortRef.current?.abort();
      applyFeatureCollection(EMPTY_FC);
      setStatus({ loading: false, count: 0, truncated: false, error: null, bbox: null });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const bbox = COMPLETE_DATA_BBOX;
    setStatus((prev) => ({ ...prev, loading: true, error: null, bbox }));
    try {
      const data = await fetchFeaturesInViewport(bbox, filterRef.current, controller.signal);
      if (requestSequence !== fetchSequenceRef.current) return;
      applyFeatureCollection(data);
      setStatus({ loading: false, count: data.count, truncated: data.truncated, error: null, bbox });
    } catch (err) {
      if ((err as Error).name === "AbortError" || requestSequence !== fetchSequenceRef.current) return;
      const msg = err instanceof ApiError ? `${err.status} - ${err.message}` : (err as Error).message;
      applyFeatureCollection(EMPTY_FC);
      setStatus({ loading: false, count: 0, truncated: false, error: msg, bbox });
    }
  }, [applyFeatureCollection]);

  const scheduleFetch = useCallback(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => { debounceRef.current = null; void runFetch(); }, 250);
  }, [runFetch]);

  const addRasterOverlay = useCallback((dataset: DatasetRow) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const overlay = dataset.dataset_metadata?.raster_overlay;
    if (dataset.file_type !== "geotiff" || !overlay) return;

    const sourceId = rasterSourceId(dataset.id);
    const layerId = rasterLayerId(dataset.id);
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    const [west, south, east, north] = overlay.bounds;
    const rasterSettings = resolveRasterSettings(rasterSettingsRef.current[dataset.id]);
    const url = rasterPreviewUrl(dataset.id, rasterSettings);
    map.addSource(sourceId, {
      type: "image",
      url,
      // MapLibre image sources take corners clockwise from top-left.
      coordinates: [[west, north], [east, north], [east, south], [west, south]],
    });
    // Insert below the vector feature layers so pins/lines stay visible
    // on top of the raster imagery.
    map.addLayer({ id: layerId, type: "raster", source: sourceId, paint: rasterPaintForSettings(rasterSettings) }, LAYER_POLY_FILL);
    rasterLayersRef.current.add(dataset.id);
  }, []);

  // Deliberately does NOT gate on map.isStyleLoaded() the way addRasterOverlay
  // does — that check can be transiently false while tiles are still loading,
  // and skipping a removal then leaves the raster permanently stuck on the
  // map with no user-facing way to clear it (deselecting again is a no-op
  // since app state already considers it removed). getLayer/getSource are
  // safe to call as soon as the map exists, loaded or not.
  const removeRasterOverlay = useCallback((datasetId: string) => {
    const map = mapRef.current;
    if (!map) return;
    const layerId = rasterLayerId(datasetId);
    const sourceId = rasterSourceId(datasetId);
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    rasterLayersRef.current.delete(datasetId);
  }, []);

  const clearAllRasterOverlays = useCallback(() => {
    for (const id of Array.from(rasterLayersRef.current)) removeRasterOverlay(id);
  }, [removeRasterOverlay]);

  const applyRasterDisplaySettings = useCallback((datasetId: string, nextSettings: RasterDisplaySettings) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const layerId = rasterLayerId(datasetId);
    if (!map.getLayer(layerId)) return;

    const paint = rasterPaintForSettings(nextSettings);
    Object.entries(paint).forEach(([key, value]) => {
      map.setPaintProperty(layerId, key, value);
    });
    map.setPaintProperty(layerId, "raster-resampling", rasterResamplingForSettings(nextSettings));
  }, []);

  const updateRasterDisplaySettings = useCallback((
    datasetId: string,
    patch: Partial<RasterDisplaySettings>
  ) => {
    const nextSettings = resolveRasterSettings({
      ...rasterSettingsRef.current[datasetId],
      ...patch,
    });
    const previousSettings = resolveRasterSettings(rasterSettingsRef.current[datasetId]);
    rasterSettingsRef.current = { ...rasterSettingsRef.current, [datasetId]: nextSettings };
    setRasterSettingsById(rasterSettingsRef.current);
    if (
      previousSettings.colorMode !== nextSettings.colorMode &&
      rasterLayersRef.current.has(datasetId)
    ) {
      const dataset = datasets.find((row) => row.id === datasetId);
      if (dataset) addRasterOverlay(dataset);
    }
    applyRasterDisplaySettings(datasetId, nextSettings);
  }, [addRasterOverlay, applyRasterDisplaySettings, datasets]);

  // Restores a dataset selection that was persisted by the parent (e.g.
  // the user picked a dataset, switched to the Datasets/Analytics tab,
  // then came back to Map) Ã¢â‚¬â€ re-applies the raster overlay(s) and scopes
  // the feature fetch, without flying the camera anywhere, since this is
  // a passive restore, not a fresh click.
  // Also acts as a standing reconciliation pass: any raster layer left on
  // the map for a dataset that is no longer active (e.g. a removal that
  // lost a race with an in-progress style/tile load) is torn down here
  // too, so the map can never get stuck showing a raster nothing in the
  // UI claims is selected.
  useEffect(() => {
    if (!mapReady) return;
    const activeIds = new Set(activeDatasetIds);
    for (const id of Array.from(rasterLayersRef.current)) {
      if (!activeIds.has(id)) removeRasterOverlay(id);
    }
    if (activeDatasetIds.length === 0) return;
    const matched = datasets.filter((d) => activeIds.has(d.id));
    if (matched.length === 0) return;
    for (const d of matched) addRasterOverlay(d);
    filterRef.current = { datasetIds: activeDatasetIds };
    scheduleFetch();
    // Only re-run when the map/datasets actually become ready or the
    // persisted id list itself changes Ã¢â‚¬â€ not on every addRasterOverlay
    // identity change, which would fight with toggleDataset's own call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, datasets, activeDatasetIds]);

  // Load persisted spatial-audit findings for whichever dataset(s) are
  // active. This is independent of the normal feature fetch — anomalies are
  // audit-run results, not viewport-scoped features, so no debounce needed.
  useEffect(() => {
    if (activeDatasetIds.length === 0) { setAnomalies([]); return; }
    const ctrl = new AbortController();
    Promise.all(activeDatasetIds.map((id) => fetchAnomalies(id, undefined, ctrl.signal).catch(() => [])))
      .then((lists) => setAnomalies(lists.flat()))
      .catch(() => {});
    return () => ctrl.abort();
  }, [activeDatasetIds]);

  // Push the fetched anomalies into the map source whenever they change.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const src = map.getSource(ANOMALY_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: anomalies.map((a) => ({
        type: "Feature",
        id: a.id,
        geometry: { type: "Point", coordinates: [a.lon, a.lat] },
        properties: { id: a.id, color: a.color, anomaly_type: a.anomaly_type },
      })),
    });
  }, [mapReady, anomalies]);

  // Keep the ref mirror in sync so applyFeatureCollection (a stable
  // useCallback) always reads the current mode on the next fetch.
  useEffect(() => { detectionModeRef.current = detectionMode; }, [detectionMode]);
  useEffect(() => { aiOverlayEnabledRef.current = aiOverlayEnabled; }, [aiOverlayEnabled]);

  // Primary feature id each anomaly type is "about", for the hover
  // tooltip's AI-detected lookup — pole rows carry every cluster member in
  // feature_ids, so "this_feature_id" (not feature_ids[0]) is the row's own
  // pole; drain/manhole rows are keyed by their metadata id for the same
  // reason (feature_ids[0] happens to already match those two, but reading
  // the explicit metadata field is the correct contract, not a coincidence).
  useEffect(() => {
    const map: Record<string, SpatialAnomaly> = {};
    for (const a of anomalies) {
      const primaryId =
        (a.anomaly_metadata.this_feature_id as string | undefined) ??
        (a.anomaly_metadata.building_id as string | undefined) ??
        (a.anomaly_metadata.manhole_id as string | undefined) ??
        a.feature_ids[0];
      if (primaryId) map[primaryId] = a;
    }
    anomalyByFeatureIdRef.current = map;
  }, [anomalies]);

  // Entering/leaving a detection mode drives which categories are hidden —
  // this OVERRIDES the manual QGIS-style Layers checklist while a mode is
  // active (a focused AI view is a bigger action than one checkbox), and
  // reverts to "show everything" when the mode is turned off.
  useEffect(() => {
    if (!detectionMode) { setHiddenCategories(new Set()); return; }
    const targetClasses = new Set(DETECTION_MODE_TARGET_CLASSES[detectionMode]);
    const toHide = new Set<string>();
    for (const { category } of categoryStats) {
      // Geotagged site photos have no canonical class of their own (they're
      // reference imagery, not a surveyed asset type) — without this
      // exemption they'd get swept into "hide everything not in this
      // mode's target classes" and vanish the instant any AI Detection
      // mode is picked, even though they're still useful context.
      if (category === "site_photo") continue;
      const canonicalClass = classMap[category];
      if (!canonicalClass || !targetClasses.has(canonicalClass)) toHide.add(category);
    }
    setHiddenCategories(toHide);
  }, [detectionMode, classMap, categoryStats]);

  // Drives the two mode-specific map treatments: (1) Drains mode recolors
  // building polygons by their own encroachment finding instead of showing
  // a separate point marker; (2) the anomaly point layer is filtered to
  // only the active mode's finding type (and hidden entirely for Drains,
  // since that mode communicates through polygon fill, not points).
  // No isStyleLoaded() gate, same reasoning as the category-filter effect
  // above — this only re-runs on mode/anomaly changes, so a transient
  // false here would drop the update with no later retry.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const buildingColors: Record<string, "red" | "yellow"> = {};
    const buildingAnomalyIds: Record<string, string> = {};
    for (const a of anomalies) {
      if (a.anomaly_type !== "drain_encroachment") continue;
      const buildingId = a.feature_ids[0];
      if (buildingId) {
        buildingColors[buildingId] = a.color === "red" ? "red" : "yellow";
        buildingAnomalyIds[buildingId] = a.id;
      }
    }
    buildingColorMapRef.current = buildingColors;
    buildingAnomalyIdMapRef.current = buildingAnomalyIds;

    const aiOn = aiOverlayEnabled && detectionMode !== null;
    if (map.getLayer(LAYER_POLY_FILL)) {
      map.setPaintProperty(
        LAYER_POLY_FILL,
        "fill-color",
        aiOn && detectionMode === "drains" ? buildBuildingColorExpression(buildingColors) : colorByCategoryExpr()
      );
      map.setPaintProperty(
        LAYER_POLY_FILL,
        "fill-opacity",
        aiOn && detectionMode === "drains" ? DRAINS_MODE_FILL_OPACITY : DEFAULT_FILL_OPACITY
      );
    }
    if (map.getLayer(LAYER_ANOMALIES)) {
      const anomalyType = aiOn && detectionMode !== "drains" ? DETECTION_MODE_ANOMALY_TYPE[detectionMode] : null;
      map.setFilter(LAYER_ANOMALIES, anomalyType ? ["==", ["get", "anomaly_type"], anomalyType] : ["==", ["get", "anomaly_type"], "__none__"]);
    }

    function colorByCategoryExpr() {
      return buildCategoryColorExpression(colorByCategoryRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, detectionMode, anomalies, aiOverlayEnabled]);

  // Manholes mode is only useful alongside the geotagged photo evidence —
  // auto-include the image dataset so its site-photo pins appear without
  // requiring a second manual click, without flying the camera anywhere.
  useEffect(() => {
    if (detectionMode !== "manholes") return;
    const photoDataset = datasets.find((d) => d.file_type === "image" && d.status === "ready");
    if (photoDataset && !activeDatasetIds.includes(photoDataset.id)) {
      setActiveDatasetIds((prev) => [...prev, photoDataset.id]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectionMode, datasets]);

  const toggleDetectionMode = useCallback((mode: Exclude<DetectionMode, null>) => {
    setDetectionMode((current) => (current === mode ? null : mode));
    // Every fresh mode selection starts with the AI overlay off — isolate
    // the category first, plain colors, then the user explicitly turns AI
    // on as a separate step.
    setAiOverlayEnabled(false);
  }, []);

  const toggleAiOverlay = useCallback(() => {
    setAiOverlayEnabled((v) => !v);
  }, []);

  // The Data Sources panel is explicitly multi-select ("multiple can be
  // shown together"), so the audit must run for every currently-active
  // dataset, not just the first one — otherwise a second/duplicate dataset
  // toggled on alongside an already-audited one silently never gets its
  // own spatial_anomalies rows (AI Detection then looks "broken" for it,
  // when really its audit was simply never triggered).
  const runAudit = useCallback(async (datasetIds: string[]) => {
    if (datasetIds.length === 0) return;
    setAuditRunning(true);
    setAuditError(null);
    // One dataset failing (e.g. a stale id left over from a deleted+
    // re-uploaded dataset) must not stop the rest of the batch from being
    // audited — collect failures and surface them together at the end
    // instead of aborting on the first one.
    const failures: string[] = [];
    for (const datasetId of datasetIds) {
      try {
        await runSpatialAudit(datasetId);
        const rows = await fetchAnomalies(datasetId);
        setAnomalies((prev) => [...prev.filter((a) => a.dataset_id !== datasetId), ...rows]);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    if (failures.length > 0) setAuditError(failures.join("; "));
    setAuditRunning(false);
  }, []);

  const selectedAnomaly = anomalies.find((a) => a.id === selectedAnomalyId) ?? null;

  const handleAnomalyStatusChange = useCallback(async (anomalyId: string, next: AnomalyStatus) => {
    const updated = await updateAnomalyStatus(anomalyId, next);
    setAnomalies((prev) => prev.map((a) => (a.id === anomalyId ? updated : a)));
  }, []);

  const handleAnomalyStale = useCallback((anomalyId: string) => {
    setAnomalies((prev) => prev.filter((a) => a.id !== anomalyId));
    setSelectedAnomalyId((current) => (current === anomalyId ? null : current));
  }, []);

  // Resolve a one-shot attribute-table request to the authoritative feature,
  // make its dataset/category visible, then focus and identify the geometry.
  useEffect(() => {
    if (!pendingFocusFeatureId || !mapReady || datasets.length === 0) return;
    const map = mapRef.current;
    if (!map) return;

    focusAbortRef.current?.abort();
    if (focusClearTimerRef.current !== null) {
      window.clearTimeout(focusClearTimerRef.current);
      focusClearTimerRef.current = null;
    }
    const controller = new AbortController();
    focusAbortRef.current = controller;

    void fetchFeatureById(pendingFocusFeatureId, controller.signal)
      .then((feature) => {
        if (controller.signal.aborted) return;
        const source = map.getSource(TABLE_FOCUS_SOURCE) as GeoJSONSource | undefined;
        source?.setData({ type: "FeatureCollection", features: [feature] });

        const dataset = datasets.find((row) => row.id === feature.properties.dataset_id);
        if (dataset) {
          setActiveDatasetIds([dataset.id]);
          setExpandedDatasetId(null);
          filterRef.current = { datasetIds: [dataset.id] };
          onActiveDatasetsChange?.([dataset]);
          scheduleFetch();
        }

        const category = feature.properties.category || "uncategorized";
        setHiddenCategories((current) => {
          if (!current.has(category)) return current;
          const next = new Set(current);
          next.delete(category);
          return next;
        });
        onFeatureSelect(feature);

        const target = featureFocusGeometry(feature);
        if (target) {
          const showTooltip = () => {
            const point = map.project(target.anchor);
            const attributes = feature.properties.attributes ?? {};
            const fidEntry = Object.entries(attributes).find(([key]) => key.toLowerCase() === "fid");
            setHover({
              x: point.x,
              y: point.y,
              label: feature.properties.label || (fidEntry ? `FID ${String(fidEntry[1])}` : category),
              category,
              severity: feature.properties.severity,
              color: colorForCategory(category),
              attributes,
            });
            focusClearTimerRef.current = window.setTimeout(() => {
              const focusSource = map.getSource(TABLE_FOCUS_SOURCE) as GeoJSONSource | undefined;
              focusSource?.setData({ type: "FeatureCollection", features: [] });
              setHover(null);
              focusClearTimerRef.current = null;
            }, TABLE_FOCUS_DURATION_MS);
          };
          map.once("moveend", showTooltip);
          if (target.isPoint) {
            map.easeTo({ center: target.anchor, zoom: Math.max(map.getZoom(), 19), duration: 900 });
          } else {
            map.fitBounds(target.bounds, { padding: 110, maxZoom: 19, duration: 900 });
          }
        }

        setFlyError(null);
        setPendingFocusFeatureId(null);
        onFocusHandled?.();
      })
      .catch((error: Error) => {
        if (error.name === "AbortError") return;
        setFlyError(`Could not locate feature: ${error.message}`);
        setPendingFocusFeatureId(null);
        onFocusHandled?.();
      });

    return () => controller.abort();
  }, [datasets, mapReady, onActiveDatasetsChange, onFeatureSelect, onFocusHandled, pendingFocusFeatureId, scheduleFetch]);

  // Selecting a dataset toggles it in/out of the active set rather than
  // replacing it Ã¢â‚¬â€ so a raster orthophoto and its companion GDB vector
  // layer over the same area can be viewed together, not just one at a
  // time. Clearing the set (or changing the topbar filter) goes back to
  // the global ward/category/severity view.
  const toggleDataset = useCallback(async (dataset: DatasetRow) => {
    const map = mapRef.current;
    if (!map) return;
    setFlyError(null);
    const isActive = activeDatasetIds.includes(dataset.id);
    const next = isActive ? activeDatasetIds.filter((id) => id !== dataset.id) : [...activeDatasetIds, dataset.id];
    setActiveDatasetIds(next);
    filterRef.current = next.length > 0 ? { datasetIds: next } : filter;
    onActiveDatasetsChange?.(datasets.filter((d) => next.includes(d.id)));

    if (isActive) {
      setExpandedDatasetId((current) => (current === dataset.id ? null : current));
      removeRasterOverlay(dataset.id);
      scheduleFetch();
      return;
    }
    addRasterOverlay(dataset);
    // Load the complete updated dataset selection immediately. fitBounds
    // below changes only the camera and deliberately does not trigger a
    // second data request.
    scheduleFetch();
    try {
      const b = await fetchDatasetBounds(dataset.id);
      map.fitBounds([[b.min_lon, b.min_lat], [b.max_lon, b.max_lat]], { padding: 80, duration: 1000, maxZoom: 18 });
    } catch (e) { setFlyError((e as Error).message); }
  }, [activeDatasetIds, datasets, filter, scheduleFetch, addRasterOverlay, removeRasterOverlay, onActiveDatasetsChange]);

  const clearAllDatasets = useCallback(() => {
    setActiveDatasetIds([]);
    setExpandedDatasetId(null);
    filterRef.current = filter;
    clearAllRasterOverlays();
    onActiveDatasetsChange?.([]);
    scheduleFetch();
  }, [filter, scheduleFetch, clearAllRasterOverlays, onActiveDatasetsChange]);

  // Bulk toggle used by the Data Sources "Select All" control. Selecting every
  // dataset activates the full set at once without per-dataset camera moves;
  // deselecting reuses the same global clear path as the old "Show all" button.
  const setAllDatasets = useCallback((active: boolean) => {
    setFlyError(null);
    if (!active) {
      clearAllDatasets();
      return;
    }
    const next = datasets.map((d) => d.id);
    setActiveDatasetIds(next);
    filterRef.current = { datasetIds: next };
    onActiveDatasetsChange?.(datasets);
    datasets.forEach((d) => addRasterOverlay(d));
    scheduleFetch();
  }, [datasets, clearAllDatasets, addRasterOverlay, scheduleFetch, onActiveDatasetsChange]);

  useImperativeHandle(
    ref,
    () => ({
      clearDatasets: clearAllDatasets,
      toggleMeasure: () => toggleMeasureActive(),
      isMeasureActive: () => measureActiveRef.current,
    }),
    [clearAllDatasets, toggleMeasureActive]
  );

  // Mirror the authoritative Measure visibility up to any parent (the top
  // navigation bar) so its button can reflect the active state without owning
  // a second copy of the real state.
  useEffect(() => {
    onMeasureChange?.(measureActive);
  }, [measureActive, onMeasureChange]);

  useEffect(() => {
    // Only a *real* ward/category/severity constraint should override an
    // active dataset selection Ã¢â‚¬â€ clicking Apply/Reset with everything left
    // at "all wards"/"all categories"/blank severity is a no-op and must
    // not silently clear the dataset(s) currently shown on the map. A real
    // constraint, though, is an explicit signal to leave dataset isolation
    // and go back to the global filtered view for the vector FEATURES Ã¢â‚¬â€
    // otherwise a stale dataset selection could silently AND-combine with
    // it into an empty/wrong result.
    //
    // A raster image overlay is NOT a filterable feature, though Ã¢â‚¬â€ it's a
    // visual backdrop with no ward/category/severity of its own Ã¢â‚¬â€ so it
    // deliberately stays on the map here. It's only removed when its own
    // dataset card is clicked again or "Show all" is pressed explicitly.
    const hasRealFilter = Boolean(
      filter.ward
      || filter.category
      || (filter.categories?.length ?? 0) > 0
      || filter.severity !== undefined
    );
    if (activeDatasetIds.length > 0 && !hasRealFilter) return;
    setActiveDatasetIds([]);
    filterRef.current = filter;
    if (mapRef.current) scheduleFetch();
    // activeDatasetIds/scheduleFetch are read for their latest value here
    // but must not retrigger this effect on their own Ã¢â‚¬â€ dataset-selection
    // changes are already handled directly by
    // toggleDataset/clearAllDatasets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: DAVANGERE_CENTER,
      zoom: DAVANGERE_ZOOM,
      minZoom: 4,
      // Raster/image overlays (aerial TIFs etc.) have no tile pyramid of
      // their own, so they can be zoomed in far past where basemap tiles
      // stop looking sharp Ã¢â‚¬â€ 20 was capping that closer inspection even
      // with the basemap turned off. MapLibre's practical ceiling is ~24.
      maxZoom: 24,
      attributionControl: false,
      transformRequest: (url) =>
        API_BASE && url.startsWith(API_BASE) ? { url, credentials: "include" } : { url },
    });
    mapRef.current = map;

    // Keeps the custom horizontal zoom slider's thumb synced to the map's
    // actual zoom regardless of how it changed (wheel, pinch, double-click,
    // the slider itself, or a programmatic flyTo/fitBounds).
    const handleZoom = () => setMapZoom(map.getZoom());
    map.on("zoom", handleZoom);

    // Fixed-size scale label (replaces MapLibre's built-in ScaleControl,
    // whose bar DOM element resizes on every zoom — correct for a real
    // scale bar, but made the bottom-right status chip visibly grow/shrink,
    // which the fixed-width box design below cannot show a proportional
    // line for anyway). Measures the geographic distance spanned by a fixed
    // 100px sample near the map's horizontal center, then rounds it to the
    // nearest "nice" cartographic value (200 m, 1 km, 2 km, ...) — the same
    // logic a scale bar uses internally, just rendered as text instead of a
    // proportional-width line.
    const SCALE_SAMPLE_PX = 100;
    const updateScaleLabel = () => {
      const canvas = map.getCanvas();
      const midY = canvas.clientHeight / 2;
      const midX = canvas.clientWidth / 2;
      const left = map.unproject([midX - SCALE_SAMPLE_PX / 2, midY]);
      const right = map.unproject([midX + SCALE_SAMPLE_PX / 2, midY]);
      const meters = haversineDistance([left.lng, left.lat], [right.lng, right.lat]);
      const metersPerPixel = meters / SCALE_SAMPLE_PX;
      setMapScaleLabel(pickNiceScaleLabel(metersPerPixel, SCALE_SAMPLE_PX));
    };
    updateScaleLabel();
    // zoomend/moveend (not the continuous "zoom"/"move") — a text label
    // only needs to be accurate once the camera settles, not on every
    // intermediate animation frame, so this avoids the extra render churn
    // a proportional bar's live-resize would otherwise require.
    map.on("zoomend", updateScaleLabel);
    map.on("moveend", updateScaleLabel);
    map.on("resize", updateScaleLabel);

    // Keeps the compass dial synced to the map's actual bearing regardless
    // of how it changed (right-click-drag, the compass itself, or a
    // programmatic rotateTo/easeTo).
    const handleRotate = () => setMapBearing(map.getBearing());
    map.on("rotate", handleRotate);

    // Keeps the Look Around compass's up/down state synced to the map's
    // actual pitch regardless of how it changed.
    const handlePitch = () => setMapPitch(map.getPitch());
    map.on("pitch", handlePitch);

    // Live cursor coordinate readout — map-wide (not tied to feature
    // layers), so it works over empty map area too, not just on features.
    // Also drives the ruler's "rubber band" preview line while the second
    // point of a measurement hasn't been placed yet.
    //
    // The bottom-right lng/lat readout uses event.lngLat directly (correct
    // for a real pointer event). The ruler preview additionally stores the
    // cursor's *screen* pixel (event.point — map-container-relative, the
    // same space map.unproject expects) so it can be re-resolved against a
    // *later* camera state from the "render" handler below, without ever
    // reading clientX/clientY, offsetX/offsetY, or a cached bounding rect.
    const handleCursorMove = (e: MapMouseEvent) => {
      setCursorLngLat([e.lngLat.lng, e.lngLat.lat]);
      latestPointerPointRef.current = { x: e.point.x, y: e.point.y };
      // isAwaitingMeasurePreview() is tab-aware: Line/Circle preview only
      // while exactly 1 point is placed, but Path/Polygon must keep
      // previewing after every vertex (2, 3, 20, ...) until the shape is
      // finished.
      if (measureActiveRef.current && isAwaitingMeasurePreview()) {
        scheduleMeasurePreviewUpdate();
      }
    };
    const handleCursorLeave = () => {
      setCursorLngLat(null);
      latestPointerPointRef.current = null;
    };
    // Fires on every animation frame the camera changes — pan, wheel/
    // control/pinch zoom, and programmatic flyTo/easeTo/fitBounds — so the
    // preview stays synced even though a stationary cursor generates no
    // new "mousemove". Using "render" instead of "moveend"/"zoomend" avoids
    // the lag/snap-at-the-end behavior the task explicitly calls out.
    const handleMapRender = () => {
      if (measureActiveRef.current && isAwaitingMeasurePreview() && latestPointerPointRef.current) {
        scheduleMeasurePreviewUpdate();
      }
    };
    map.on("mousemove", handleCursorMove);
    map.on("mouseout", handleCursorLeave);
    map.on("render", handleMapRender);

    map.on("load", () => {
      map.addSource(FEATURE_SOURCE, { type: "geojson", data: EMPTY_FC as unknown as GeoJSON.FeatureCollection, promoteId: "id" });
      map.addLayer({ id: LAYER_POLY_FILL, type: "fill", source: FEATURE_SOURCE, filter: POLY_BASE_FILTER, paint: { "fill-color": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, "#3aa1ff", 0.5, "#f5c542", 1, "#ff5a3d"], "fill-opacity": 0.35 } });
      map.addLayer({ id: LAYER_POLY_OUTLINE, type: "line", source: FEATURE_SOURCE, filter: POLY_BASE_FILTER, paint: { "line-color": "#0b1013", "line-width": 1 } });
      map.addLayer({ id: LAYER_LINES, type: "line", source: FEATURE_SOURCE, filter: LINE_BASE_FILTER, paint: { "line-color": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, "#3aa1ff", 0.5, "#f5c542", 1, "#ff5a3d"], "line-width": 2.5 } });
      map.addLayer({
        id: LAYER_POINTS,
        type: "circle",
        source: FEATURE_SOURCE,
        // raster_pixel features are the raster reader's internal sample
        // grid (kept for the feature table / severity / AI summary) Ã¢â‚¬â€ the
        // actual image overlay already shows the raster visually, so the
        // grid of dots on top of it would just be redundant clutter.
        // site_photo features get their own camera-icon symbol layer below
        // instead of a plain dot.
        filter: POINT_BASE_FILTER,
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 6, 16, 10], "circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, "#3aa1ff", 0.5, "#f5c542", 1, "#ff5a3d"], "circle-stroke-color": "#0b1013", "circle-stroke-width": 1.5, "circle-opacity": 0.9 },
      });

      if (!map.hasImage(PHOTO_ICON_ID)) {
        map.addImage(PHOTO_ICON_ID, buildPhotoIconImageData(), { pixelRatio: 2 });
      }
      map.addLayer({
        id: LAYER_PHOTOS,
        type: "symbol",
        source: FEATURE_SOURCE,
        filter: PHOTO_BASE_FILTER,
        layout: {
          "icon-image": PHOTO_ICON_ID,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.35, 16, 0.65],
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
        },
      });

      const BASE_CLICKABLE = [LAYER_POINTS, LAYER_LINES, LAYER_POLY_FILL, LAYER_PHOTOS];
      void runFetch();

      // AI highlight overlay — separate GeoJSON source so it never
      // interferes with the normal feature source or its colour expressions.
      map.addSource(AI_HIGHLIGHT_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      // Proposed missing/service-gap poles - green circle
      map.addLayer({
        id: LAYER_AI_NEEDED,
        type: "circle",
        source: AI_HIGHLIGHT_SOURCE,
        filter: ["==", ["get", "ai_status"], "needed"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 9, 16, 14],
          "circle-color": AI_NEEDED_COLOR,
          "circle-opacity": 0.92,
          "circle-stroke-color": "#065f46",
          "circle-stroke-width": 2,
        },
      });
      // Redundant poles — red circle on top of normal circle
      map.addLayer({
        id: LAYER_AI_REDUNDANT,
        type: "circle",
        source: AI_HIGHLIGHT_SOURCE,
        filter: ["==", ["get", "ai_status"], "redundant"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 9, 16, 14],
          "circle-color": AI_REDUNDANT_COLOR,
          "circle-opacity": 0.92,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      // Spatial Audit Engine overlay — persisted anomaly findings, kept as
      // its own source/layer so it survives independently of the normal
      // feature fetch/AI-highlight overlay lifecycles.
      map.addSource(ANOMALY_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_ANOMALIES,
        type: "circle",
        source: ANOMALY_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 12, 10, 16, 15],
          "circle-color": ANOMALY_COLOR_EXPR,
          "circle-opacity": 0.95,
          "circle-stroke-color": "#0b1013",
          "circle-stroke-width": 2,
        },
      });
      map.on("click", LAYER_ANOMALIES, (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER_ANOMALIES] });
        if (!hit.length) return;
        const id = hit[0].properties?.id as string | undefined;
        if (id) setSelectedAnomalyId(id);
      });
      map.on("mouseenter", LAYER_ANOMALIES, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", LAYER_ANOMALIES, () => (map.getCanvas().style.cursor = ""));

      // A separate, top-most source keeps an attribute-table selection
      // visible even while the regular dataset source is being refreshed.
      map.addSource(TABLE_FOCUS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: TABLE_FOCUS_FILL,
        type: "fill",
        source: TABLE_FOCUS_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.32 },
      });
      map.addLayer({
        id: TABLE_FOCUS_LINE,
        type: "line",
        source: TABLE_FOCUS_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString", "Polygon", "MultiPolygon"]]],
        paint: { "line-color": "#f59e0b", "line-width": 6, "line-opacity": 0.95 },
      });
      map.addLayer({
        id: TABLE_FOCUS_POINT,
        type: "circle",
        source: TABLE_FOCUS_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 8, 16, 14, 20, 18],
          "circle-color": "#fbbf24",
          "circle-opacity": 0.95,
          "circle-stroke-color": "#111827",
          "circle-stroke-width": 3,
        },
      });

      // Single set of event handlers on ALL_CLICKABLE (base + AI layers).
      // Registered AFTER AI layers are added so MapLibre binds them correctly.
      // Using one handler set avoids double-fire when AI circles overlap base features.
      const AI_CLICKABLE = [LAYER_AI_NEEDED, LAYER_AI_REDUNDANT];
      const ALL_CLICKABLE = [...BASE_CLICKABLE, ...AI_CLICKABLE];
      const handleFeatureClick = (e: MapMouseEvent) => {
        // While a measurement tool is actually armed/drawing, clicks drop
        // measurement points instead of selecting a feature/opening its
        // photo — otherwise the two click handlers would both fire for the
        // same click. Once Escape deactivates the tool (panel still open),
        // this must stop applying so ordinary feature clicks work again.
        if (streetPickModeRef.current || streetPickConsumedRef.current || isMeasureInputActive()) return;
        const hit = map.queryRenderedFeatures(e.point, { layers: ALL_CLICKABLE });
        if (!hit.length) return;
        const isAi = AI_CLICKABLE.includes(hit[0].layer?.id as string);
        const base = isAi ? hit.find((f) => BASE_CLICKABLE.includes(f.layer?.id as string)) : hit[0];
        const selected = decodeFeature(base ?? hit[0]);
        if (aiOverlayEnabledRef.current && detectionModeRef.current === "drains") {
          const anomalyId = buildingAnomalyIdMapRef.current[selected.properties.id];
          if (anomalyId) { setSelectedAnomalyId(anomalyId); return; }
        }
        if (selected.properties.category === "site_photo") {
          setPhotoViewer({
            url: `${API_BASE}/api/v1/features/${selected.properties.id}/photo`,
            label: selected.properties.label || "Site photo",
            isPanorama: selected.properties.attributes?.is_360 === true,
          });
          return;
        }
        onFeatureSelect(selected);
      };
      const handleFeatureHover = (e: MapMouseEvent) => {
        // While a measurement tool is actually armed/drawing, ordinary
        // data-layer hover must not open the feature tooltip — otherwise
        // hovering a feature mid-measurement pops up its info card over the
        // map. The measurement crosshair/rubber-band handlers own the
        // cursor and pointer feedback instead (see handleFeatureMouseEnter/
        // Leave below). Uses isMeasureInputActive() (not the raw panel-open
        // flag) so hover works normally again as soon as Escape deactivates
        // the tool, even while the Measure panel itself stays open.
        if (streetPickModeRef.current || isMeasureInputActive()) { setHover(null); return; }
        const hit = map.queryRenderedFeatures(e.point, { layers: ALL_CLICKABLE });
        if (!hit.length) { setHover(null); return; }
        const aiHit = hit.find((f) => AI_CLICKABLE.includes(f.layer?.id as string));
        const baseHit = hit.find((f) => BASE_CLICKABLE.includes(f.layer?.id as string));
        const featureToDecode = baseHit ?? aiHit ?? hit[0];
        const decoded = decodeFeature(featureToDecode);
        const category = decoded.properties.category || "uncategorized";
        const aiStatus: "redundant" | "needed" | undefined =
          (aiHit?.properties?.ai_status as "redundant" | "needed" | undefined)
          ?? aiStatusRef.current.get(decoded.properties.id);
        const anomalyForFeature = aiOverlayEnabledRef.current
          ? anomalyByFeatureIdRef.current[decoded.properties.id]
          : undefined;
        setHover({
          x: e.point.x,
          y: e.point.y,
          label: decoded.properties.label || "-",
          category,
          severity: decoded.properties.severity,
          color: colorForCategory(category),
          attributes: decoded.properties.attributes,
          aiStatus,
          aiDetection: anomalyForFeature ? summarizeAnomalyForTooltip(anomalyForFeature) : undefined,
        });
      };
      // Named (not inline-anonymous) so the cursor is never fought: while
      // measuring, syncMeasureCursor() owns canvas.style.cursor (crosshair),
      // and these handlers must not overwrite it with "pointer"/"" just
      // because the mouse crossed a feature underneath the measurement layer.
      const handleFeatureMouseEnter = () => {
        if (streetPickModeRef.current) { map.getCanvas().style.cursor = "crosshair"; return; }
        if (isMeasureInputActive()) return;
        map.getCanvas().style.cursor = "pointer";
      };
      const handleFeatureMouseLeave = () => {
        if (streetPickModeRef.current) { map.getCanvas().style.cursor = "crosshair"; setHover(null); return; }
        if (isMeasureInputActive()) return;
        map.getCanvas().style.cursor = "";
        setHover(null);
      };
      ALL_CLICKABLE.forEach((id) => {
        map.on("click", id, handleFeatureClick);
        map.on("mouseenter", id, handleFeatureMouseEnter);
        map.on("mousemove", id, handleFeatureHover);
        map.on("mouseleave", id, handleFeatureMouseLeave);
      });

      map.on("click", (event) => {
        if (!streetPickModeRef.current) return;
        streetPickConsumedRef.current = true;
        window.requestAnimationFrame(() => { streetPickConsumedRef.current = false; });
        streetPickModeRef.current = false;
        setStreetPickMode(false);
        map.getCanvas().style.cursor = "";
        setHover(null);
        setStreetViewTarget({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
      });

      // Ruler / measurement overlay — own GeoJSON sources so it never
      // touches the feature/AI sources above. Fill renders below the
      // outline, which renders below the radius line, which renders below
      // the vertex points.
      map.addSource(MEASURE_FILL_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource(MEASURE_LINE_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource(MEASURE_RADIUS_LINE_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource(MEASURE_POINTS_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: LAYER_MEASURE_FILL,
        type: "fill",
        source: MEASURE_FILL_SOURCE,
        paint: { "fill-color": MEASURE_COLOR, "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: LAYER_MEASURE_LINE,
        type: "line",
        source: MEASURE_LINE_SOURCE,
        paint: { "line-color": MEASURE_COLOR, "line-width": 2.5, "line-dasharray": [2, 1.5] },
      });
      map.addLayer({
        id: LAYER_MEASURE_RADIUS_LINE,
        type: "line",
        source: MEASURE_RADIUS_LINE_SOURCE,
        paint: { "line-color": MEASURE_COLOR, "line-width": 2 },
      });
      map.addLayer({
        id: LAYER_MEASURE_POINTS,
        type: "circle",
        source: MEASURE_POINTS_SOURCE,
        paint: {
          "circle-radius": 5,
          "circle-color": MEASURE_COLOR,
          "circle-stroke-color": "#1a1a1a",
          "circle-stroke-width": 1.5,
        },
      });

      // Handles ruler clicks map-wide (not tied to any specific layer) so a
      // point can be dropped anywhere, including on top of other features.
      // The single registered click handler dispatches on the authoritative
      // `measurePhaseRef` state machine (never a stale closure, since this
      // listener is registered once here for the lifetime of the map):
      //   idle    → begin a fresh measurement from this vertex
      //   drawing → Line/Circle: this is the final (2nd) vertex; Path/Polygon:
      //             append another vertex.
      map.on("click", (e: MapMouseEvent) => {
        if (streetPickModeRef.current || streetPickConsumedRef.current || !measureActiveRef.current) return;
        const phase = measurePhaseRef.current;
        const tab = measureTabRef.current;
        const isMultiPoint = MEASURE_MULTI_POINT_TABS.has(tab);
        const coord: [number, number] = [e.lngLat.lng, e.lngLat.lat];

        // Finalizing click for Line / Circle (exactly 2 vertices).
        // A Line whose second vertex lands on the start is a degenerate
        // zero-length / NaN measurement, so it is ignored and we keep
        // awaiting the real end. A Circle with a small radius is still a
        // perfectly valid (tiny) circle, so its second click must ALWAYS
        // complete — otherwise the boundary endpoint intermittently never
        // appears. (Only a literally-zero radius, i.e. the second click
        // on the exact center, is degenerate, and that is harmless.)
        if (phase === "drawing" && !isMultiPoint) {
          const start = measurePointsRef.current[0];
          if (tab !== "circle" && start && haversineDistance(start, coord) < MIN_MEASURE_METERS) return;
          const points: [number, number][] = [...measurePointsRef.current, coord];
          measurePointsRef.current = points;
          setMeasurePoints(points);
          setMeasurePreviewPoint(null);
          flushMeasureSources(null);
          beginNewSession();
          setMeasurePhase("idle");
          return;
        }

        // Extra vertex for an in-progress Path / Polygon — stay in "drawing".
        if (phase === "drawing" && isMultiPoint) {
          const points: [number, number][] = [...measurePointsRef.current, coord];
          measurePointsRef.current = points;
          setMeasurePoints(points);
          setMeasurePreviewPoint(null);
          flushMeasureSources(null);
          return;
        }

        // Idle: begin a brand-new measurement from this vertex. The previously
        // completed shape (if any) is replaced — this app's single-shot UX.
        // An immediate preview tick makes the rubber-band line appear even
        // before the cursor next moves.
        if (phase === "idle") {
          const points: [number, number][] = [coord];
          measurePointsRef.current = points;
          setMeasurePoints(points);
          setMeasurePreviewPoint(null);
          flushMeasureSources(null);
          setMeasurePhase("drawing");
          scheduleMeasurePreviewUpdate();
          return;
        }
      });

      // Right-click finishes an in-progress Path/Polygon (Google Earth
      // Pro's Path/Polygon completion gesture). The browser's native
      // context menu must not appear while a multi-point shape is actively
      // being drawn — MapMouseEvent.preventDefault() only suppresses
      // MapLibre's own internal handlers (drag-rotate, box-zoom, etc.), not
      // the browser context menu, so the underlying DOM event needs its
      // own preventDefault() too. Outside active multi-point drawing,
      // right-click keeps the map's normal behavior (there is no other
      // contextmenu handling in this app to preserve).
      map.on("contextmenu", (e: MapMouseEvent) => {
        if (!measureActiveRef.current) return;
        const tab = measureTabRef.current;
        if (!MEASURE_MULTI_POINT_TABS.has(tab)) return;
        if (measurePhaseRef.current !== "drawing" || measurePointsRef.current.length === 0) return;
        e.preventDefault();
        e.originalEvent.preventDefault();
        // A single placed vertex isn't a valid path/polygon (needs >= 2 /
        // >= 3) — right-clicking at that point cancels the incomplete
        // shape entirely rather than silently doing nothing.
        if (measurePointsRef.current.length === 1) {
          clearMeasurement();
          return;
        }
        finishMeasurePath();
      });
      map.on("click", (event) => {
        if (!streetPickModeRef.current) return;
        streetPickConsumedRef.current = true;
        window.requestAnimationFrame(() => { streetPickConsumedRef.current = false; });
        streetPickModeRef.current = false;
        setStreetPickMode(false);
        map.getCanvas().style.cursor = "";
        setHover(null);
        setStreetViewTarget({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
      });

      // setMapReady AFTER the AI source/layers are added so the aiHighlights
      // useEffect can safely call map.getSource(AI_HIGHLIGHT_SOURCE).
      setMapReady(true);
    });
    // Do not fetch on move/zoom. Once a dashboard selection is loaded, the
    // GeoJSON source remains unchanged until the user changes that selection.
    return () => {
      fetchSequenceRef.current += 1;
      abortRef.current?.abort();
      focusAbortRef.current?.abort();
      if (focusClearTimerRef.current !== null) window.clearTimeout(focusClearTimerRef.current);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (measureRafRef.current !== null) { cancelAnimationFrame(measureRafRef.current); measureRafRef.current = null; }
      map.remove();
      mapRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <CommandCenter
        datasets={datasets}
        activeDatasetIds={activeDatasetIds}
        flyError={flyError}
        onSelectDataset={toggleDataset}
        onSelectAllDatasets={setAllDatasets}
        expandedDatasetId={expandedDatasetId}
        onToggleDatasetSettings={(datasetId) => {
          setExpandedDatasetId((current) => (current === datasetId ? null : datasetId));
        }}
        rasterSettingsById={rasterSettingsById}
        onChangeRasterSettings={updateRasterDisplaySettings}
        categoryStats={categoryStats}
        hiddenCategories={hiddenCategories}
        onToggleCategory={toggleCategoryVisibility}
        onSetAllCategoriesVisible={setAllCategoriesVisible}
        onRunAudit={runAudit}
        auditRunning={auditRunning}
        auditError={auditError}
        onOpenAttributeTable={openLayerAttributeTable}
        status={status}
      />
      <div className="map-canvas" data-testid="map-canvas">
        <div ref={containerRef} className="map-canvas__map" data-testid="map-gl" />
        <MapControls
          basemap={basemap}
          onChangeBasemap={changeBasemap}
          status={status}
          detectionMode={detectionMode}
          onToggleDetectionMode={toggleDetectionMode}
          aiOverlayEnabled={aiOverlayEnabled}
          onToggleAiOverlay={toggleAiOverlay}
          streetPickMode={streetPickMode}
          onToggleStreetView={toggleStreetPickMode}
        />
        <MapLegend entries={legend} />
        <HoverTooltip hover={hover} />
        {selectedAnomaly && (
          <AnomalyAlertCard
            anomaly={selectedAnomaly}
            onClose={() => setSelectedAnomalyId(null)}
            onStatusChange={handleAnomalyStatusChange}
            onStale={handleAnomalyStale}
          />
        )}
        <MapStatusBar lngLat={cursorLngLat} scaleLabel={mapScaleLabel} />
        <ZoomSlider
          zoom={mapZoom}
          minZoom={4}
          maxZoom={24}
          onChange={(next) => mapRef.current?.setZoom(next)}
        />
        <LookAroundCompass
          bearing={mapBearing}
          pitch={mapPitch}
          lookAroundActive={lookAroundActive}
          mapReady={mapReady}
          onRotate={(next) => mapRef.current?.setBearing(next)}
          onResetNorth={() => mapRef.current?.easeTo({ bearing: 0, duration: 300 })}
          onStep={(deltaBearing) => mapRef.current?.setBearing(mapRef.current.getBearing() + deltaBearing)}
          onPitchStep={(deltaPitch) => {
            const map = mapRef.current;
            if (!map) return;
            map.setPitch(Math.min(MAX_MAP_PITCH, Math.max(0, map.getPitch() + deltaPitch)));
          }}
          onToggleLookAround={toggleLookAround}
          onResetCamera={resetLookAroundCamera}
        />
        {measureActive && (
          <RulerPanel
            tab={measureTab}
            onChangeTab={changeMeasureTab}
            lengthMeters={measureLengthMeters}
            areaSqMeters={measureAreaSqMeters}
            radiusMeters={measureRadiusMeters}
            heading={measureHeading}
            unit={measureUnit}
            onChangeUnit={setMeasureUnit}
            areaUnit={measureAreaUnit}
            onChangeAreaUnit={setMeasureAreaUnit}
            onClear={clearMeasurement}
            onClose={closeMeasureSafely}
            position={rulerPanelPos}
            onPositionChange={setRulerPanelPos}
          />
        )}
        {streetPickMode && (
          <div className="street-pick-hint" data-testid="street-pick-hint">
            Click a road location to open the nearest 360° Street View
          </div>
        )}
        {activeDatasetIds.length === 0 && !filter.ward && !filter.category && (filter.categories?.length ?? 0) === 0 && filter.severity === undefined && (
          <div style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            pointerEvents: "none", textAlign: "center",
            background: "rgba(11,16,19,0.72)", borderRadius: "var(--radius-md)",
            padding: "14px 22px", color: "var(--ink-mute)", fontSize: 13, fontWeight: 500,
            backdropFilter: "blur(4px)", border: "1px solid var(--edge)",
          }}>
            Select a dataset from the Command Center to view it on the map
          </div>
        )}
      </div>
      {photoViewer?.isPanorama ? (
        <PanoramaViewer url={photoViewer.url} label={photoViewer.label} onClose={() => setPhotoViewer(null)} />
      ) : (
        <PhotoViewer photo={photoViewer} onClose={() => setPhotoViewer(null)} />
      )}
      {streetViewTarget && (
        <GoogleStreetView
          latitude={streetViewTarget.latitude}
          longitude={streetViewTarget.longitude}
          features={loadedFeatures}
          hiddenCategories={hiddenCategories}
          onClose={() => setStreetViewTarget(null)}
        />
      )}
      {attributeTable && (
        <AttributeTable
          key={`${attributeTable.category}:${attributeTable.datasetIds?.join(",") ?? attributeTable.ward ?? "all"}:${attributeTable.severity ?? ""}`}
          datasetName={attributeTable.category}
          scopeLabel={attributeTable.sourceLabel}
          layerFilter={attributeTable}
          onClose={() => setAttributeTable(null)}
          onLocateFeature={(row: FeatureTableRow) => {
            setAttributeTable(null);
            setPendingFocusFeatureId(row.id);
          }}
        />
      )}
    </>
  );
});

function CommandCenter({
  datasets, activeDatasetIds, flyError, onSelectDataset, onSelectAllDatasets, expandedDatasetId, onToggleDatasetSettings,
  rasterSettingsById, onChangeRasterSettings, categoryStats, hiddenCategories, onToggleCategory,
  onSetAllCategoriesVisible, onRunAudit, auditRunning, auditError, onOpenAttributeTable, status: _status,
}: {
  datasets: DatasetRow[]; activeDatasetIds: string[]; flyError: string | null; onSelectDataset: (d: DatasetRow) => void;
  onSelectAllDatasets: (active: boolean) => void;
  expandedDatasetId: string | null;
  onToggleDatasetSettings: (datasetId: string) => void;
  rasterSettingsById: Record<string, RasterDisplaySettings>;
  onChangeRasterSettings: (datasetId: string, patch: Partial<RasterDisplaySettings>) => void;
  categoryStats: LegendEntry[];
  hiddenCategories: Set<string>;
  onToggleCategory: (category: string) => void;
  onSetAllCategoriesVisible: (visible: boolean) => void;
  onRunAudit: (datasetIds: string[]) => void;
  auditRunning: boolean;
  auditError: string | null;
  onOpenAttributeTable: (category: string) => void;
  status: ViewportStatus;
}) {
  const [layerQuery, setLayerQuery] = useState("");
  const [layerMenu, setLayerMenu] = useState<{ category: string; x: number; y: number } | null>(null);
  const normalizedLayerQuery = layerQuery.trim().toLocaleLowerCase();
  const displayedLayers = useMemo(
    () => [...categoryStats]
      .sort((a, b) => a.category.localeCompare(b.category, undefined, { sensitivity: "base", numeric: true }))
      .filter((layer) => !normalizedLayerQuery || layer.category.toLocaleLowerCase().includes(normalizedLayerQuery)),
    [categoryStats, normalizedLayerQuery]
  );

  useEffect(() => {
    if (!layerMenu) return;
    const closeMenu = () => setLayerMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [layerMenu]);

  return (
    <aside className="command-center" data-testid="command-center">
      <div className="command-center__body">
        {datasets.length > 0 && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <span className="command-center__section-title">Data Sources</span>
              {activeDatasetIds.length > 0 ? (
                <button
                  type="button"
                  className="command-center__text-btn"
                  onClick={() => onSelectAllDatasets(false)}
                  data-testid="clear-dataset-filter"
                >
                  Show all
                </button>
              ) : (
                <span className="command-center__section-count">{datasets.length}</span>
              )}
            </div>
            {activeDatasetIds.length > 0 && (
              <div style={{ fontSize: 10.5, color: "var(--ink-mute)", margin: "-2px 0 8px" }}>
                Click a dataset again to deselect it - multiple can be shown together.
              </div>
            )}
            {activeDatasetIds.length > 0 && (
              <button
                type="button"
                className="command-center__audit-btn"
                disabled={auditRunning}
                onClick={() => onRunAudit(activeDatasetIds)}
                data-testid="run-spatial-audit"
              >
                {auditRunning ? "Running Spatial Audit…" : "Run Spatial Audit"}
              </button>
            )}
            {auditError && (
              <div style={{ marginBottom: 8, padding: "8px 10px", background: "var(--danger-muted)", borderRadius: "var(--radius-sm)", color: "var(--danger)", fontSize: 11 }}>
                {auditError}
              </div>
            )}
            {datasets.map((d) => {
              const isActive = activeDatasetIds.includes(d.id);
              const hasRasterControls = d.status === "ready" && d.file_type === "geotiff" && Boolean(d.dataset_metadata?.raster_overlay);
              const canOpenSettings = hasRasterControls && isActive;
              const isExpanded = canOpenSettings && expandedDatasetId === d.id;
              const rasterSettings = resolveRasterSettings(rasterSettingsById[d.id]);

              return (
                <div
                  key={d.id}
                  className={`dataset-card-shell${isExpanded ? " dataset-card-shell--expanded" : ""}`}
                >
                  <div
                    className={`dataset-card${isActive ? " dataset-card--active" : ""}${d.status !== "ready" ? " dataset-card--disabled" : ""}`}
                    onClick={() => d.status === "ready" && onSelectDataset(d)}
                    data-testid={`map-dataset-${d.id}`}
                  >
                    <div
                      className={`dataset-card__checkbox${isActive ? " dataset-card__checkbox--checked" : ""}`}
                      aria-hidden="true"
                    >
                      <svg className="dataset-card__checkbox-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="dataset-card__info">
                      <div className="dataset-card__name">{d.name}</div>
                      <div className="dataset-card__meta">
                        {d.ward ? (
                          <><strong style={{ color: "var(--accent)", fontWeight: 700 }}>Ward {d.ward}</strong> · {d.file_type}</>
                        ) : (
                          <>All wards · {d.file_type}</>
                        )}
                      </div>
                    </div>
                    <div className="dataset-card__actions">
                      {hasRasterControls ? (
                        <button
                          type="button"
                          className={`dataset-card__gear${isExpanded ? " dataset-card__gear--active" : ""}`}
                          aria-label={`Open display settings for ${d.name}`}
                          aria-expanded={isExpanded}
                          disabled={!canOpenSettings}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!canOpenSettings) return;
                            onToggleDatasetSettings(d.id);
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                          </svg>
                        </button>
                      ) : (
                        <span className={`dataset-card__status dataset-card__status--${d.status}`}>{d.status}</span>
                      )}
                    </div>
                  </div>
                  {canOpenSettings && isExpanded && (
                    <div
                      className="dataset-card__settings"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="dataset-card__settings-head">
                        <div>
                          <div className="dataset-card__settings-title">Display Settings</div>
                          <div className="dataset-card__settings-copy">
                            Default preview already looks correct. Use these only when you need a manual adjustment.
                          </div>
                        </div>
                        <button
                          type="button"
                          className="dataset-card__reset"
                          onClick={() => onChangeRasterSettings(d.id, DEFAULT_RASTER_SETTINGS)}
                        >
                          Reset
                        </button>
                      </div>
                      <div className="dataset-card__settings-group">
                        <div className="dataset-card__settings-label">Color Type</div>
                        <div className="dataset-card__mode-row">
                          {COLOR_MODE_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={`dataset-card__mode-btn${rasterSettings.colorMode === option.value ? " dataset-card__mode-btn--active" : ""}`}
                              onClick={() => onChangeRasterSettings(d.id, { colorMode: option.value })}
                            >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                      <div className="dataset-card__settings-group">
                        <div className="dataset-card__slider-head">
                          <span className="dataset-card__settings-label">Edge Clarity</span>
                          <span className="dataset-card__slider-value">
                            {rasterSettings.clarity.toFixed(2)}
                          </span>
                        </div>
                        <input
                          className="dataset-card__slider"
                          type="range"
                          min="0"
                          max="2"
                          step="0.05"
                          value={rasterSettings.clarity}
                          onChange={(event) => onChangeRasterSettings(d.id, { clarity: Number(event.target.value) })}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {flyError && <div style={{ marginTop: 8, padding: "8px 10px", background: "var(--danger-muted)", borderRadius: "var(--radius-sm)", color: "var(--danger)", fontSize: 11 }}>{flyError}</div>}
          </div>
        )}

        {categoryStats.length > 0 && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <span className="command-center__section-title">Layers</span>
              <button
                type="button"
                className="command-center__text-btn"
                data-testid="layers-toggle-all"
                onClick={() => onSetAllCategoriesVisible(hiddenCategories.size > 0)}
              >
                {hiddenCategories.size > 0 ? "Show all" : "Hide all"}
              </button>
            </div>
            <div className="layer-search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m16.5 16.5 4 4" />
              </svg>
              <input
                type="search"
                value={layerQuery}
                onChange={(event) => setLayerQuery(event.target.value)}
                placeholder="Search layers..."
                aria-label="Search layers"
                data-testid="layer-search"
              />
              {layerQuery && (
                <button
                  type="button"
                  className="layer-search__clear"
                  onClick={() => setLayerQuery("")}
                  aria-label="Clear layer search"
                >
                  ×
                </button>
              )}
            </div>
            <div className="layer-list">
              {displayedLayers.map((c) => {
                const visible = !hiddenCategories.has(c.category);
                return (
                  <div
                    key={c.category}
                    className={`layer-row${visible ? "" : " layer-row--hidden"}`}
                    onClick={() => onToggleCategory(c.category)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setLayerMenu({
                        category: c.category,
                        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
                        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 96)),
                      });
                    }}
                    title="Click to show or hide. Right-click for the attribute table."
                    data-testid={`layer-row-${c.category}`}
                  >
                    <div className={`layer-row__checkbox${visible ? " layer-row__checkbox--checked" : ""}`}>
                      <svg className="layer-row__checkbox-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <span className="layer-row__swatch" style={{ background: c.color }} />
                    <span className="layer-row__name">{c.category}</span>
                    <span className="layer-row__count">{c.count}</span>
                  </div>
                );
              })}
              {displayedLayers.length === 0 && (
                <div className="layer-list__empty">No matching layers</div>
              )}
            </div>
          </div>
        )}
      </div>
      {layerMenu && createPortal(
        <div
          className="layer-context-menu"
          style={{ left: layerMenu.x, top: layerMenu.y }}
          role="menu"
          aria-label={`${layerMenu.category} layer actions`}
          data-testid="layer-context-menu"
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="layer-context-menu__title" title={layerMenu.category}>
            {layerMenu.category}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenAttributeTable(layerMenu.category);
              setLayerMenu(null);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18M9 9v11M15 9v11" />
            </svg>
            Open attribute table
          </button>
        </div>,
        document.body
      )}
    </aside>
  );
}
const DETECTION_MODE_LABEL: Record<Exclude<DetectionMode, null>, string> = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manholes",
};

function MapControls({
  basemap, onChangeBasemap, status, detectionMode, onToggleDetectionMode, aiOverlayEnabled, onToggleAiOverlay, streetPickMode, onToggleStreetView,
}: {
  basemap: Basemap;
  onChangeBasemap: (b: Basemap) => void;
  status: ViewportStatus;
  detectionMode: DetectionMode;
  onToggleDetectionMode: (mode: Exclude<DetectionMode, null>) => void;
  aiOverlayEnabled: boolean;
  onToggleAiOverlay: () => void;
  streetPickMode: boolean;
  onToggleStreetView: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const portalMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        portalMenuRef.current && !portalMenuRef.current.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

  // MapLibre's WebGL canvas can composite on its own GPU layer that paints
  // over positioned overlay siblings regardless of z-index/stacking-context
  // CSS (confirmed via elementFromPoint — the canvas rendered on top of a
  // correctly z-indexed, position:absolute dropdown). Portaling the open
  // dropdown straight to document.body, positioned with fixed coordinates
  // computed from the button's own rect, sidesteps the map's DOM subtree
  // entirely instead of fighting that stacking behavior.
  useEffect(() => {
    if (!menuOpen || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 6, left: rect.left });
  }, [menuOpen]);

  return (
    <>
      <div className="feature-count" data-testid="viewport-status">
        {status.loading ? "loading..." : `${status.count} features`}
      </div>
      <div className="map-controls">
        <div className="map-controls__group" data-testid="basemap-toggle">
          <button className={`map-controls__btn${basemap === "street" ? " map-controls__btn--active" : ""}`} onClick={() => onChangeBasemap("street")} data-testid="basemap-street">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ marginRight: 4, verticalAlign: -2 }}>
              <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" />
            </svg>
            Map
          </button>
          <button className={`map-controls__btn${basemap === "satellite" ? " map-controls__btn--active" : ""}`} onClick={() => onChangeBasemap("satellite")} data-testid="basemap-satellite">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ marginRight: 4, verticalAlign: -2 }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
            Satellite
          </button>
          <button
            className={`map-controls__btn${basemap === "off" ? " map-controls__btn--active" : ""}`}
            onClick={() => onChangeBasemap("off")}
            data-testid="basemap-off"
            title="Hide the basemap so raster overlays/vector data aren't limited by its tile resolution when zooming in close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ marginRight: 4, verticalAlign: -2 }}>
              <path d="M3 3l18 18M10.58 10.58a2 2 0 002.83 2.83M9.88 4.24A9.4 9.4 0 0112 4c5 0 8.5 4 10 8-.46 1.3-1.13 2.6-2 3.79M6.6 6.6C4.7 8 3.2 10 2 12c1.5 4 5 8 10 8 1.35 0 2.63-.28 3.8-.78" />
            </svg>
            Off
          </button>
        </div>
        <div className="map-controls__group ai-detection-control" data-testid="ai-detection-control" ref={menuRef}>
          <button
            type="button"
            className={`map-controls__btn${detectionMode ? " map-controls__btn--active" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            data-testid="ai-detection-toggle"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style={{ marginRight: 4, verticalAlign: -2 }}>
              <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z" />
              <path d="M19 13l.9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9L19 13z" />
            </svg>
            AI Detection{detectionMode ? `: ${DETECTION_MODE_LABEL[detectionMode]}` : ""}
          </button>
          {detectionMode && (
            <button
              type="button"
              className={`ai-overlay-toggle${aiOverlayEnabled ? " ai-overlay-toggle--on" : ""}`}
              onClick={onToggleAiOverlay}
              data-testid="ai-overlay-toggle"
              title={aiOverlayEnabled ? "Turn off the AI red/yellow/green overlay" : "Turn on the AI red/yellow/green overlay"}
            >
              <span className="ai-overlay-toggle__track">
                <span className="ai-overlay-toggle__knob" />
              </span>
              AI {aiOverlayEnabled ? "ON" : "OFF"}
            </button>
          )}
          {menuOpen && menuPos && createPortal(
            <div
              className="ai-detection-menu"
              data-testid="ai-detection-menu"
              ref={portalMenuRef}
              style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
            >
              {(["poles", "drains", "manholes"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={`ai-detection-menu__item${detectionMode === mode ? " ai-detection-menu__item--active" : ""}`}
                  onClick={() => { onToggleDetectionMode(mode); setMenuOpen(false); }}
                  data-testid={`detection-mode-${mode}`}
                >
                  {DETECTION_MODE_LABEL[mode]}
                </button>
              ))}
            </div>,
            document.body
          )}
        </div>
        <div className="map-controls__group map-controls__group--street-view">
          <button
            className={`map-controls__btn map-controls__btn--street-view${streetPickMode ? " map-controls__btn--active" : ""}`}
            onClick={onToggleStreetView}
            data-testid="street-view-picker"
            title="Select a map location and open the nearest Google Street View panorama"
            aria-pressed={streetPickMode}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15" style={{ marginRight: 4, verticalAlign: -2 }}>
              <circle cx="12" cy="5" r="2.5" fill="currentColor" stroke="none" />
              <path d="M8 10c1.2-1.2 2.5-1.8 4-1.8s2.8.6 4 1.8M9.2 10.2 8 16m6.8-5.8L16 16M9.3 13h5.4M10.5 16v5m3-5v5" />
            </svg>
            Street View
          </button>
        </div>
      </div>
      {status.error && (
        <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", zIndex: 10, padding: "8px 14px", background: "var(--danger-muted)", border: "1px solid var(--danger)", borderRadius: "var(--radius-md)", color: "var(--danger)", fontSize: 11, fontWeight: 600 }}>
          {status.error}
        </div>
      )}
    </>
  );
}

function formatAttrValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function HoverTooltip({ hover }: { hover: HoverInfo | null }) {
  if (!hover) return null;
  // Only show attributes that actually have a value Ã¢â‚¬â€ most survey rows
  // leave many condition/status fields blank, and a tooltip full of "Ã¢â‚¬â€"
  // placeholders is noise, not information.
  const isPhoto = hover.category === "site_photo";
  const isPanorama = isPhoto && hover.attributes.is_360 === true;
  const attrEntries = Object.entries(hover.attributes).filter(([k, v]) => {
    if (k === "gdb_layer" || k.startsWith("_")) return false;
    // Internal plumbing fields, not something a user needs to see in a tooltip.
    if (isPhoto && (k === "photo_key" || k === "content_type" || k === "is_360")) return false;
    if (v === null || v === undefined) return false;
    if (typeof v === "string" && (v.trim() === "" || v.trim().toLowerCase() === "nan")) return false;
    return true;
  });

  const aiBadge = hover.aiStatus === "redundant"
    ? { text: "⚠ AI: Recommended for removal", bg: "#ef4444", color: "#fff" }
    : hover.aiStatus === "needed"
    ? { text: "✓ AI: Critical — junction / corner / relay", bg: "#22c55e", color: "#fff" }
    : null;

  return (
    <div className="map__tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }} data-testid="map-tooltip">
      <div className="map__tooltip-head">
        <span className="map__tooltip-swatch" style={{ background: hover.aiStatus === "redundant" ? "#ef4444" : hover.aiStatus === "needed" ? "#22c55e" : hover.color }} />
        <span className="map__tooltip-name">{hover.label}</span>
      </div>
      <div className="map__tooltip-row">
        <span>{hover.category}</span>
        {isPanorama ? (
          <span className="map__tooltip-sev">🌐 360° — click to view</span>
        ) : isPhoto ? (
          <span className="map__tooltip-sev">📷 click to view</span>
        ) : (
          <span className="map__tooltip-sev">sev {hover.severity.toFixed(2)}</span>
        )}
      </div>
      {aiBadge && (
        <div style={{
          margin: "6px 0 2px",
          padding: "4px 8px",
          background: aiBadge.bg,
          color: aiBadge.color,
          borderRadius: "var(--radius-sm)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.04em",
        }}>
          {aiBadge.text}
        </div>
      )}
      {hover.aiDetection && (
        <div style={{
          margin: "6px 0 2px",
          padding: "5px 8px",
          background: ANOMALY_BADGE_COLOR[hover.aiDetection.color],
          color: "#fff",
          borderRadius: "var(--radius-sm)",
          fontSize: 10,
          fontWeight: 700,
        }}>
          <div style={{ letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 2 }}>
            AI Detected: {hover.aiDetection.typeLabel}
          </div>
          <div style={{ fontWeight: 600, opacity: 0.92 }}>{hover.aiDetection.metric}</div>
        </div>
      )}
      {attrEntries.length > 0 && (
        <div className="map__tooltip-attrs">
          {attrEntries.map(([k, v]) => (
            <div className="map__tooltip-attr-row" key={k}>
              <span className="map__tooltip-attr-key">{k}</span>
              <span className="map__tooltip-attr-val">{formatAttrValue(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhotoViewer({ photo, onClose }: { photo: { url: string; label: string } | null; onClose: () => void }) {
  if (!photo) return null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.82)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16,
      }}
      onClick={onClose}
      data-testid="photo-viewer"
    >
      <img
        src={photo.url}
        alt={photo.label}
        style={{ maxWidth: "90vw", maxHeight: "82vh", borderRadius: "var(--radius-md)", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
        onClick={(e) => e.stopPropagation()}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>{photo.label}</span>
        <button
          type="button"
          onClick={onClose}
          data-testid="photo-viewer-close"
          style={{
            background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff",
            borderRadius: "var(--radius-sm)", padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}
        >
          Close ✕
        </button>
      </div>
    </div>
  );
}

function formatDms(value: number, positiveSuffix: string, negativeSuffix: string): string {
  const suffix = value >= 0 ? positiveSuffix : negativeSuffix;
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFull = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFull);
  const seconds = (minutesFull - minutes) * 60;
  return `${degrees}°${String(minutes).padStart(2, "0")}'${seconds.toFixed(2).padStart(5, "0")}" ${suffix}`;
}

function MapLegend({ entries }: { entries: LegendEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="map__legend" data-testid="map-legend">
      <div className="map__legend-title">Loaded Categories</div>
      {entries.map((e) => (
        <div className="map__legend-row" key={e.category}>
          <span className="map__legend-swatch" style={{ background: e.color }} />
          <span className="map__legend-label">{e.category}</span>
          <span className="map__legend-count">{e.count}</span>
        </div>
      ))}
    </div>
  );
}
/** Google Earth Pro-style "Ruler" dialog for the Line measurement tool. */
const MEASURE_TAB_OPTIONS: Array<{ value: MeasureTab; label: string }> = [
  { value: "line", label: "Line" },
  { value: "path", label: "Path" },
  { value: "polygon", label: "Polygon" },
  { value: "circle", label: "Circle" },
];

const MEASURE_TAB_HINTS: Record<MeasureTab, string> = {
  line: "Measure the distance between two points on the ground",
  path: "Click to add points, right-click to finish",
  polygon: "Click to add points, right-click to finish",
  circle: "Measure the radius, perimeter, and area of a circle on the ground",
};

function RulerPanel({
  tab, onChangeTab,
  lengthMeters, areaSqMeters, radiusMeters, heading,
  unit, onChangeUnit, areaUnit, onChangeAreaUnit,
  onClear, onClose,
  position, onPositionChange,
}: {
  tab: MeasureTab;
  onChangeTab: (t: MeasureTab) => void;
  lengthMeters: number;
  areaSqMeters: number;
  radiusMeters: number;
  heading: number | null;
  unit: DistanceUnit;
  onChangeUnit: (u: DistanceUnit) => void;
  areaUnit: AreaUnit;
  onChangeAreaUnit: (u: AreaUnit) => void;
  onClear: () => void;
  onClose: () => void;
  position: { x: number; y: number } | null;
  onPositionChange: (
    pos: { x: number; y: number } | ((prev: { x: number; y: number } | null) => { x: number; y: number } | null)
  ) => void;
}) {
  const displayLength = metersToUnit(lengthMeters, unit).toFixed(2);
  const displayArea = sqMetersToUnit(areaSqMeters, areaUnit).toFixed(2);
  const displayRadius = metersToUnit(radiusMeters, unit).toFixed(2);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Drag offset (pointer position relative to the panel's top-left corner,
  // in viewport/client coordinates — the same space `position: fixed` and
  // clientX/clientY both use) captured on pointerdown so the panel doesn't
  // jump to re-center under the cursor on the first move event.
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  // Tracks the active drag's pointer id so we can release its capture on
  // unmount (e.g. the panel is closed via the X button or Escape mid-drag),
  // which otherwise leaves the browser cursor stuck in dragging mode.
  const dragPointerIdRef = useRef<number | null>(null);

  const clampToViewport = (x: number, y: number, width: number, height: number) => {
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) };
  };

  const handleTitlebarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore drags started on the close button so it still just closes.
    if ((e.target as HTMLElement).closest(".ruler-panel__close")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Grab offset in client (viewport) coordinates — matches the `position:
    // fixed` + clientX/clientY space used below, so no other coordinate
    // system (page, offset, container-relative) is mixed in.
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // Pointer capture routes subsequent move/up events to this element even
    // if the cursor leaves it — no window-level listeners to add/clean up.
    e.currentTarget.setPointerCapture(e.pointerId);
    dragPointerIdRef.current = e.pointerId;
    e.preventDefault();
  };
  const handleTitlebarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!offset || !rect) return;
    const nextX = e.clientX - offset.x;
    const nextY = e.clientY - offset.y;
    onPositionChange(clampToViewport(nextX, nextY, rect.width, rect.height));
    e.preventDefault();
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragOffsetRef.current = null;
    dragPointerIdRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Keep the panel inside the viewport if the window is resized (e.g.
  // shrunk) after the user dragged it near an edge.
  useEffect(() => {
    const handleResize = () => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      onPositionChange((prev) => (prev ? clampToViewport(prev.x, prev.y, rect.width, rect.height) : prev));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On unmount (e.g. the panel is closed via Escape/X while a drag is in
  // progress) release any active pointer capture so the browser cursor is
  // never left stuck in dragging mode.
  useEffect(() => {
    const el = panelRef.current;
    return () => {
      const id = dragPointerIdRef.current;
      if (id !== null && el && el.hasPointerCapture(id)) {
        el.releasePointerCapture(id);
      }
      dragPointerIdRef.current = null;
    };
  }, []);

  // The base CSS already sets `position: fixed` (see .ruler-panel) so the
  // element's containing block is the viewport both before and during a
  // drag — only left/top/transform are overridden here once the user has
  // actually moved it, using the same client-coordinate space throughout.
  const style: React.CSSProperties | undefined = position
    ? { top: position.y, left: position.x, transform: "none" }
    : undefined;

  return (
    <div className="ruler-panel" data-testid="ruler-panel" role="dialog" aria-label="Measure" ref={panelRef} style={style}>
      <div
        className="ruler-panel__titlebar"
        onPointerDown={handleTitlebarPointerDown}
        onPointerMove={handleTitlebarPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid="ruler-panel-titlebar"
      >
        <span>Measure</span>
        <button
          type="button"
          className="ruler-panel__close"
          onClick={onClose}
          aria-label="Close measure"
          data-testid="ruler-panel-close"
        >
          ✕
        </button>
      </div>
      <div className="ruler-panel__body">
        <div className="ruler-panel__tabs" role="tablist">
          {MEASURE_TAB_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="tab"
              aria-selected={tab === o.value}
              className={`ruler-panel__tab${tab === o.value ? " ruler-panel__tab--active" : ""}`}
              onClick={() => onChangeTab(o.value)}
              data-testid={`ruler-tab-${o.value}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="ruler-panel__hint">{MEASURE_TAB_HINTS[tab]}</div>

        {tab === "line" && (
          <>
            <div className="ruler-panel__row">
              <span className="ruler-panel__label">Map Length:</span>
              <span className="ruler-panel__value" data-testid="ruler-map-length">{displayLength}</span>
              <select
                className="ruler-panel__select"
                value={unit}
                onChange={(e) => onChangeUnit(e.target.value as DistanceUnit)}
                data-testid="ruler-unit-select"
              >
                {DISTANCE_UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="ruler-panel__row">
              <span className="ruler-panel__label">Ground Length:</span>
              <span className="ruler-panel__value" data-testid="ruler-ground-length">{displayLength}</span>
            </div>
            <div className="ruler-panel__row">
              <span className="ruler-panel__label">Heading:</span>
              <span className="ruler-panel__value" data-testid="ruler-heading">
                {heading === null ? "-" : `${heading.toFixed(2)} degrees`}
              </span>
            </div>
          </>
        )}

        {tab === "path" && (
          <div className="ruler-panel__row">
            <span className="ruler-panel__label">Length:</span>
            <span className="ruler-panel__value" data-testid="ruler-path-length">{displayLength}</span>
            <select
              className="ruler-panel__select"
              value={unit}
              onChange={(e) => onChangeUnit(e.target.value as DistanceUnit)}
              data-testid="ruler-unit-select"
            >
              {DISTANCE_UNIT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        {tab === "polygon" && (
          <>
            <div className="ruler-panel__row">
              <span className="ruler-panel__label">Perimeter:</span>
              <span className="ruler-panel__value" data-testid="ruler-polygon-perimeter">{displayLength}</span>
              <select
                className="ruler-panel__select"
                value={unit}
                onChange={(e) => onChangeUnit(e.target.value as DistanceUnit)}
                data-testid="ruler-unit-select"
              >
                {DISTANCE_UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="ruler-panel__row">
              <span className="ruler-panel__label">Area:</span>
              <span className="ruler-panel__value" data-testid="ruler-polygon-area">{displayArea}</span>
              <select
                className="ruler-panel__select"
                value={areaUnit}
                onChange={(e) => onChangeAreaUnit(e.target.value as AreaUnit)}
                data-testid="ruler-area-unit-select"
              >
                {AREA_UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {tab === "circle" && (
          <>
            <div className="ruler-panel__row">
              <span className="ruler-panel__label">Radius:</span>
              <span className="ruler-panel__value" data-testid="ruler-circle-radius">{displayRadius}</span>
              <select
                className="ruler-panel__select"
                value={unit}
                onChange={(e) => onChangeUnit(e.target.value as DistanceUnit)}
                data-testid="ruler-unit-select"
              >
                {DISTANCE_UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="ruler-panel__row">
              <span className="ruler-panel__label">Perimeter:</span>
              <span className="ruler-panel__value" data-testid="ruler-circle-perimeter">{displayLength}</span>
            </div>
            <div className="ruler-panel__row">
              <span className="ruler-panel__label">Area:</span>
              <span className="ruler-panel__value" data-testid="ruler-circle-area">{displayArea}</span>
              <select
                className="ruler-panel__select"
                value={areaUnit}
                onChange={(e) => onChangeAreaUnit(e.target.value as AreaUnit)}
                data-testid="ruler-area-unit-select"
              >
                {AREA_UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </>
        )}

        <div className="ruler-panel__actions">
          <button type="button" className="ruler-panel__btn" onClick={onClear} data-testid="ruler-panel-clear">
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
