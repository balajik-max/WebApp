import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { createPortal } from "react-dom";
import maplibregl, { Map as MLMap, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { fetchFeaturesInViewport } from "../lib/features";
import type { AiHighlight, FeatureFilter, UrbanFeature, FeatureCollectionResponse } from "../lib/types";
import { ApiError } from "../lib/api";
import { colorForCategory, UNCATEGORIZED_COLOR } from "../lib/categoryColors";
import {
  fetchDatasets, fetchDatasetBounds, type DatasetRow,
  fetchAnomalies, runSpatialAudit, updateAnomalyStatus, fetchAllClassMappings,
  type SpatialAnomaly, type AnomalyStatus,
} from "../lib/workflow";
import { PanoramaViewer } from "./PanoramaViewer";
import { AnomalyAlertCard } from "./AnomalyAlertCard";

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
}

const DAVANGERE_CENTER: [number, number] = [75.9218, 14.4644];
const DAVANGERE_ZOOM = 12;

// Same base the rest of the app's fetch wrapper (lib/api.ts) uses Ã¢â‚¬â€ the
// dev setup serves the API from a different origin/port than the SPA, so
// raster preview image requests need the same credentials treatment as
// every other authenticated call.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// Per-dataset IDs (rather than one fixed source/layer) so more than one
// raster overlay can be shown on the map at the same time.
const rasterSourceId = (datasetId: string) => `raster-preview-${datasetId}`;
const rasterLayerId = (datasetId: string) => `raster-preview-layer-${datasetId}`;

type RasterColorMode = "rgb" | "grayscale" | "enhanced";

interface RasterDisplaySettings {
  colorMode: RasterColorMode;
  clarity: number;
}

const DEFAULT_RASTER_SETTINGS: RasterDisplaySettings = {
  colorMode: "grayscale",
  clarity: 0,
};

const COLOR_MODE_OPTIONS: Array<{ value: RasterColorMode; label: string }> = [
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

function resolveRasterSettings(settings?: Partial<RasterDisplaySettings>): RasterDisplaySettings {
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
      attribution: "(c) OpenStreetMap contributors",
    },
    "satellite-tiles": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [
    { id: "osm", type: "raster", source: "osm-tiles", minzoom: 0, maxzoom: 22 },
    {
      id: "satellite",
      type: "raster",
      source: "satellite-tiles",
      minzoom: 0,
      maxzoom: 22,
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
const BUILDING_DEFAULT_COLOR = "#15803d"; // dark green — not (meaningfully) encroached
const BUILDING_RED_COLOR = "#b91c1c"; // dark red — fully/critically encroached
const BUILDING_YELLOW_COLOR = "#b45309"; // dark amber — partially encroached
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
  red: "#b91c1c",
  yellow: "#b45309",
  green: "#15803d",
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
    metric =
      m.drain_overlap_length_m && Number(m.drain_overlap_length_m) > 0
        ? `Building touches drain — ${m.drain_overlap_length_m}m on the line`
        : `Building near drain — ${m.drain_touch_distance_m ?? "?"}m away`;
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
export interface MapCanvasHandle { clearDatasets: () => void; }

export const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(
  { filter, onFeatureSelect, onActiveDatasetsChange, initialActiveDatasets, aiHighlights },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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

  const applyFeatureCollection = useCallback((data: FeatureCollectionResponse) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource(FEATURE_SOURCE) as GeoJSONSource | undefined;
    if (src) src.setData(data as unknown as GeoJSON.FeatureCollection);

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

  const runFetch = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    // If no dataset is selected AND no real topbar filter is active,
    // show an empty map rather than dumping every feature in the viewport.
    const currentFilter = filterRef.current;
    const hasDatasetFilter = (currentFilter.datasetIds?.length ?? 0) > 0;
    const hasRealFilter = Boolean(currentFilter.ward || currentFilter.category || currentFilter.severity !== undefined);
    if (!hasDatasetFilter && !hasRealFilter) {
      applyFeatureCollection(EMPTY_FC);
      setStatus({ loading: false, count: 0, truncated: false, error: null, bbox: null });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const bounds = map.getBounds();
    const bbox: [number, number, number, number] = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    setStatus((prev) => ({ ...prev, loading: true, error: null, bbox }));
    try {
      const data = await fetchFeaturesInViewport(bbox, filterRef.current, controller.signal);
      applyFeatureCollection(data);
      setStatus({ loading: false, count: data.count, truncated: data.truncated, error: null, bbox });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
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

  const runAudit = useCallback(async (datasetId: string) => {
    setAuditRunning(true);
    setAuditError(null);
    try {
      await runSpatialAudit(datasetId);
      const rows = await fetchAnomalies(datasetId);
      setAnomalies((prev) => [...prev.filter((a) => a.dataset_id !== datasetId), ...rows]);
    } catch (e) {
      setAuditError((e as Error).message);
    } finally {
      setAuditRunning(false);
    }
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
    try {
      const b = await fetchDatasetBounds(dataset.id);
      map.fitBounds([[b.min_lon, b.min_lat], [b.max_lon, b.max_lat]], { padding: 80, duration: 1000, maxZoom: 18 });
      // fitBounds fires moveend, which the mount effect already wires to
      // scheduleFetch Ã¢â‚¬â€ but call it directly too in case the map is
      // already sitting on those exact bounds (no moveend would fire).
      scheduleFetch();
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

  useImperativeHandle(ref, () => ({ clearDatasets: clearAllDatasets }), [clearAllDatasets]);

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
    const hasRealFilter = Boolean(filter.ward || filter.category || filter.severity !== undefined);
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
      attributionControl: { compact: true },
      transformRequest: (url) =>
        API_BASE && url.startsWith(API_BASE) ? { url, credentials: "include" } : { url },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

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

      // Single set of event handlers on ALL_CLICKABLE (base + AI layers).
      // Registered AFTER AI layers are added so MapLibre binds them correctly.
      // Using one handler set avoids double-fire when AI circles overlap base features.
      const AI_CLICKABLE = [LAYER_AI_NEEDED, LAYER_AI_REDUNDANT];
      const ALL_CLICKABLE = [...BASE_CLICKABLE, ...AI_CLICKABLE];
      const handleFeatureClick = (e: MapMouseEvent) => {
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
      ALL_CLICKABLE.forEach((id) => {
        map.on("click", id, handleFeatureClick);
        map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mousemove", id, handleFeatureHover);
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; setHover(null); });
      });

      // setMapReady AFTER the AI source/layers are added so the aiHighlights
      // useEffect can safely call map.getSource(AI_HIGHLIGHT_SOURCE).
      setMapReady(true);
    });
    map.on("moveend", scheduleFetch);
    map.on("zoomend", scheduleFetch);
    return () => { abortRef.current?.abort(); if (debounceRef.current !== null) window.clearTimeout(debounceRef.current); map.remove(); mapRef.current = null; };
  }, []);

  return (
    <>
      <CommandCenter
        datasets={datasets}
        activeDatasetIds={activeDatasetIds}
        flyError={flyError}
        onSelectDataset={toggleDataset}
        onClearDataset={clearAllDatasets}
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
        {activeDatasetIds.length === 0 && !filter.ward && !filter.category && filter.severity === undefined && (
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
    </>
  );
});

function CommandCenter({
  datasets, activeDatasetIds, flyError, onSelectDataset, onClearDataset, expandedDatasetId, onToggleDatasetSettings,
  rasterSettingsById, onChangeRasterSettings, categoryStats, hiddenCategories, onToggleCategory,
  onSetAllCategoriesVisible, onRunAudit, auditRunning, auditError, status: _status,
}: {
  datasets: DatasetRow[]; activeDatasetIds: string[]; flyError: string | null; onSelectDataset: (d: DatasetRow) => void;
  onClearDataset: () => void;
  expandedDatasetId: string | null;
  onToggleDatasetSettings: (datasetId: string) => void;
  rasterSettingsById: Record<string, RasterDisplaySettings>;
  onChangeRasterSettings: (datasetId: string, patch: Partial<RasterDisplaySettings>) => void;
  categoryStats: LegendEntry[];
  hiddenCategories: Set<string>;
  onToggleCategory: (category: string) => void;
  onSetAllCategoriesVisible: (visible: boolean) => void;
  onRunAudit: (datasetId: string) => void;
  auditRunning: boolean;
  auditError: string | null;
  status: ViewportStatus;
}) {
  return (
    <aside className="command-center" data-testid="command-center">
      <div className="command-center__header">
        <div className="command-center__eyebrow">Command Center</div>
        <div className="command-center__title">Urban<br/>Intelligence</div>
      </div>
      <div className="command-center__body">
        {datasets.length > 0 && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <span className="command-center__section-title">Data Sources</span>
              {activeDatasetIds.length > 0 ? (
                <button
                  type="button"
                  className="command-center__text-btn"
                  onClick={onClearDataset}
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
                onClick={() => onRunAudit(activeDatasetIds[0])}
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
            <div className="layer-list">
              {categoryStats.map((c) => {
                const visible = !hiddenCategories.has(c.category);
                return (
                  <div
                    key={c.category}
                    className={`layer-row${visible ? "" : " layer-row--hidden"}`}
                    onClick={() => onToggleCategory(c.category)}
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
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
const DETECTION_MODE_LABEL: Record<Exclude<DetectionMode, null>, string> = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manholes",
};

function MapControls({
  basemap, onChangeBasemap, status, detectionMode, onToggleDetectionMode, aiOverlayEnabled, onToggleAiOverlay,
}: {
  basemap: Basemap;
  onChangeBasemap: (b: Basemap) => void;
  status: ViewportStatus;
  detectionMode: DetectionMode;
  onToggleDetectionMode: (mode: Exclude<DetectionMode, null>) => void;
  aiOverlayEnabled: boolean;
  onToggleAiOverlay: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The dropdown itself is portaled to document.body (see below) — it's no
  // longer a DOM descendant of menuRef, so outside-click detection needs
  // its own ref too, or every click inside the portaled list would
  // incorrectly count as "outside" and close it immediately.
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

function MapLegend({ entries }: { entries: LegendEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="map__legend" data-testid="map-legend">
      <div className="map__legend-title">Categories in View</div>
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
