import { useEffect, useLayoutEffect, useRef, useState, useCallback, useImperativeHandle, useMemo, forwardRef, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import maplibregl, { Map as MLMap, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { fetchFeatureById, fetchFeaturesInViewport, fetchVisualizationLayerFeatures } from "../lib/features";
import type { AiHighlight, FeatureFilter, UrbanFeature, FeatureCollectionResponse } from "../lib/types";
import { ApiError } from "../lib/api";
import { colorForCategory, UNCATEGORIZED_COLOR } from "../lib/categoryColors";
import {
  fetchDatasets, fetchDatasetBounds, fetchVisualizationManifest,
  type DatasetBounds, type DatasetRow,
  type FeatureTableRow, type LayerFeatureTableFilter,
  type VisualizationFieldGroupTree, type VisualizationFieldProfile, type VisualizationLayerGroupNode,
  type VisualizationLayerManifest, type VisualizationManifest,
  fetchAnomalies, runSpatialAudit, updateAnomalyStatus, fetchAllClassMappings,
  type SpatialAnomaly, type AnomalyStatus,
} from "../lib/workflow";
import { AttributeTable } from "./AttributeTable";
import { PanoramaViewer } from "./PanoramaViewer";
import { CylinderPanoramaViewer } from "./CylinderPanoramaViewer";
import { GoogleStreetView } from "./GoogleStreetView";
import { LookAroundCompass, DEFAULT_MAP_PITCH, MAX_MAP_PITCH } from "./LookAroundCompass";
import { DataSourceSelector } from "./DataSourceSelector";
import { SupportingFilesImport } from "./WardReportPanel";
import { AnomalyAlertCard } from "./AnomalyAlertCard";
import { PlacemarkEditor } from "./map/PlacemarkEditor";
import { MyPlacesPanel } from "./map/MyPlacesPanel";
import { PlacemarkDetailsPanel } from "./map/PlacemarkDetailsPanel";
import { ReferenceLayersMenu, type ReferenceLayerVisibility } from "./map/ReferenceLayersMenu";
import { CoordinateSearchPanel } from "./map/CoordinateSearchPanel";
import { useDraggableMapPanel } from "./map/useDraggableMapPanel";
import type { CoordinateSearchDataset, CoordinateValue } from "../lib/coordinateSearch";
import { useIsMobile } from "../lib/useIsMobile";
import {
  bulkDeletePlacemarks, createPlacemark, deletePlacemark, fetchElevationSample, fetchPlacemarks,
  updatePlacemark, type ElevationSample, type Placemark, type PlacemarkDraft,
} from "../lib/placemarks";
import { ManholeRecommendCard } from "./ManholeRecommendCard";
import { Map3DViewer } from "./Map3DViewer";
import { GroupedFieldList } from "./GroupedFieldList";
import { aiManholeRecommend, type AiAnswer } from "../lib/ai";

// .obj datasets are persisted with file_type "other" (the enum has no
// dedicated OBJ value), so detect them from the stored filename instead.
function isObjDataset(d: DatasetRow): boolean {
  // A bundled upload (.obj + .mtl + textures, zipped client-side) has a
  // storage_key ending in .zip, not .obj — model_assets is the reliable
  // signal for those; the plain extension check covers a bare .obj upload.
  if (d.dataset_metadata?.model_assets) return true;
  const name = (d.storage_key ?? d.name).toLowerCase();
  return name.endsWith(".obj");
}

function isVectorVisualizationDataset(d: DatasetRow): boolean {
  if (d.status !== "ready" || isObjDataset(d)) return false;
  if (d.file_type === "geotiff" || d.file_type === "image") return false;
  if (d.dataset_metadata?.raster_overlay || d.dataset_metadata?.model_3d) return false;
  return true;
}
function sourceCrsFromDatasetMetadata(dataset: DatasetRow): string | null {
  const metadata = dataset.dataset_metadata ?? {};
  const direct = metadata.source_crs ?? metadata.crs;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const ingestion = metadata.ingestion;
  if (ingestion && typeof ingestion === "object") {
    const sourceCrs = (ingestion as { source_crs?: unknown }).source_crs;
    if (typeof sourceCrs === "string" && sourceCrs.trim()) return sourceCrs.trim();
  }
  return null;
}

export interface AiVerificationContext {
  anomalyId: string;
  detectionMode: Exclude<DetectionMode, null>;
  anomalyType: SpatialAnomaly["anomaly_type"];
  aiColor: "red" | "yellow";
  severityScore: number;
  detectedAt: string;
  longitude: number;
  latitude: number;
}

interface Props {
  filter: FeatureFilter;
  onFeatureSelect: (feature: UrbanFeature | null, aiVerification?: AiVerificationContext | null) => void;
  /** Fires whenever the set of datasets selected in the Command Center
   * changes — used to drive the ward/dataset-level report panel. */
  onActiveDatasetsChange?: (rows: DatasetRow[]) => void;
  /** Dataset selection persisted by the parent (survives this component
   * being unmounted/remounted on tab navigation) — seeds the initial
   * selection and is re-applied once the map and dataset list are ready. */
  initialActiveDatasets?: DatasetRow[];
  /** AI-produced highlight overrides — redundant poles show red,
   * needed poles show green. Empty array clears the overlay. */
  aiHighlights?: AiHighlight[];
  /** Feature requested from an attribute-table row on another route. */
  focusFeatureId?: string;
  /** Clears the one-shot route request after the feature has been handled. */
  onFocusHandled?: () => void;
  /** Refetch point-verification state after an Admin or Architect update. */
  refreshToken?: number;

  /** Whether the mobile Data Sources drawer is open — lifted up to
   * WorkspaceLayout so the topbar's menu button can open it. Ignored on
   * desktop, where the sidebar is always visible. */
  commandCenterMobileOpen: boolean;
  onCommandCenterMobileOpenChange: (open: boolean) => void;

  /** Session-scoped Spatial Audit trigger guard — owned by WorkspaceLayout
   * (like the props above) so it survives this component unmounting on tab
   * navigation. `spatialAuditRequestedRef` flips true the instant the AI
   * Detection icon is first clicked; `spatialAuditExecutedRef` flips true
   * once the audit has actually been kicked off for an active dataset. */
  spatialAuditRequestedRef: MutableRefObject<boolean>;
  spatialAuditExecutedRef: MutableRefObject<boolean>;
  spatialAuditStatus: "idle" | "running" | "success" | "error";
  onSpatialAuditStatusChange: (status: "idle" | "running" | "success" | "error") => void;
}

const DAVANGERE_CENTER: [number, number] = [75.9218, 14.4644];
const DAVANGERE_ZOOM = 12;
// Dataset/filter changes load one stable GeoJSON snapshot. Map navigation
// then only changes the camera; it never replaces that snapshot. The API
// still requires a bbox, so use the full valid WGS84 extent and let the
// selected dataset/ward/category filters define the data scope.
const COMPLETE_DATA_BBOX: [number, number, number, number] = [-180, -90, 180, 90];

// Same base the rest of the app's fetch wrapper (lib/api.ts) uses — the
// dev setup serves the API from a different origin/port than the SPA, so
// raster preview image requests need the same credentials treatment as
// every other authenticated call.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// Per-dataset IDs (rather than one fixed source/layer) so more than one
// raster overlay can be shown on the map at the same time.
const rasterSourceId = (datasetId: string) => `raster-preview-${datasetId}`;
const rasterLayerId = (datasetId: string) => `raster-preview-layer-${datasetId}`;
const obj3dLayerId = (datasetId: string) => `obj-3d-layer-${datasetId}`;

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

// Every raster overlay in this project is stored with file_type "geotiff"
// (uploaded .tif/.tiff/.geotiff all normalise to this — see DatasetsView),
// so this is the reliable, project-standard way to identify TIFF/GeoTIFF
// rasters. NOTE: DSM/DTM are a name-matched *subset* of these geotiffs and
// are handled separately (Enhanced) by isElevationRasterDataset below.
export function isGeoTiffDataset(dataset: Pick<DatasetRow, "file_type">): boolean {
  return dataset.file_type === "geotiff";
}

// Digital Surface / Terrain Model rasters. There is no dedicated dataset
// "type" field for these — they are single-band elevation GeoTIFFs
// distinguished by name, matching the backend's own established heuristic
// (see manhole_recommend.py: `name ILIKE '%dtm%'` / `%dsm%`). DSM/DTM must
// always render in Enhanced mode and expose no per-dataset display settings.
export function isElevationRasterDataset(dataset: Pick<DatasetRow, "file_type" | "name">): boolean {
  if (dataset.file_type !== "geotiff") return false;
  // Match "dsm"/"dtm" as a distinct token in the name (case-insensitive),
  // allowing the usual separators used in dataset names — e.g.
  // "Davangere_DSM", "DTM ward 5", "dsm-2024", "ward.dtm" — without matching
  // it as an incidental substring inside an unrelated word.
  return /(^|[^a-z0-9])(dsm|dtm)([^a-z0-9]|$)/i.test(dataset.name);
}

// Fixed, non-configurable render modes per raster kind, applied at the
// rendering layer (not just the UI) so they hold across load, selection,
// style updates, layer refresh, and page refresh:
//   • DSM/DTM elevation GeoTIFFs  -> Enhanced (rainbow + hillshade)
//   • all other TIFF/GeoTIFF      -> RGB
// Any previously-chosen (in-memory) colorMode is overridden, so a stale
// Grayscale/Enhanced selection can never persist for an ordinary GeoTIFF.
// Non-raster datasets fall through to the resolved user/default settings.
export function effectiveRasterSettings(
  dataset: Pick<DatasetRow, "file_type" | "name">,
  settings?: Partial<RasterDisplaySettings>
): RasterDisplaySettings {
  const resolved = resolveRasterSettings(settings);
  if (isElevationRasterDataset(dataset)) {
    return { ...resolved, colorMode: "enhanced" };
  }
  if (isGeoTiffDataset(dataset)) {
    return { ...resolved, colorMode: "rgb" };
  }
  return resolved;
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
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
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
    "reference-openfreemap": {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
      attribution: "OpenMapTiles © OpenStreetMap contributors",
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
    {
      id: "reference-boundaries",
      type: "line",
      source: "reference-openfreemap",
      "source-layer": "boundary",
      minzoom: 0,
      layout: { visibility: "none" },
      paint: {
        "line-color": [
          "match", ["to-string", ["get", "admin_level"]],
          "2", "#f8fafc",
          "4", "#facc15",
          "6", "#67e8f9",
          "8", "#a7f3d0",
          "#cbd5e1"
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 10, 1.4, 16, 2.1],
        "line-opacity": 0.92,
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "reference-boundary-labels",
      type: "symbol",
      source: "reference-openfreemap",
      "source-layer": "place",
      minzoom: 3,
      filter: ["in", ["get", "class"], ["literal", ["country", "state", "province", "county", "city", "town", "village", "suburb", "neighbourhood", "hamlet"]]],
      layout: {
        visibility: "none",
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"], ""],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 10, 13, 16, 15],
        "text-letter-spacing": 0.04,
        "text-variable-anchor": ["top", "bottom", "left", "right"],
        "text-radial-offset": 0.3,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#0b1013",
        "text-halo-width": 1.6,
      },
    },
    {
      id: "reference-roads",
      type: "line",
      source: "reference-openfreemap",
      "source-layer": "transportation",
      minzoom: 5,
      layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "match", ["get", "class"],
          ["motorway", "trunk", "primary"], "#fbbf24",
          ["secondary", "tertiary"], "#fb7185",
          ["minor", "service", "track", "path"], "#f8fafc",
          "#e2e8f0"
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.55, 12, 1.9, 17, 5.5],
        "line-opacity": 1,
      },
    },
    {
      id: "reference-road-labels",
      type: "symbol",
      source: "reference-openfreemap",
      "source-layer": "transportation_name",
      minzoom: 9,
      layout: {
        visibility: "none",
        "symbol-placement": "line",
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"], ["get", "ref"], ""],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 9, 15, 12, 19, 14],
        "text-rotation-alignment": "map",
        "text-pitch-alignment": "viewport",
        "text-padding": 4,
      },
      paint: {
        "text-color": "#fff7ed",
        "text-halo-color": "#111827",
        "text-halo-width": 1.6,
      },
    },
    {
      id: "reference-buildings",
      type: "fill",
      source: "reference-openfreemap",
      "source-layer": "building",
      minzoom: 13,
      layout: { visibility: "none" },
      paint: {
        "fill-color": "#22d3ee",
        "fill-opacity": 0.54,
        "fill-outline-color": "#ecfeff",
      },
    },
    {
      id: "reference-building-labels",
      type: "symbol",
      source: "reference-openfreemap",
      "source-layer": "building",
      minzoom: 15,
      filter: ["any", ["has", "name"], ["has", "name:en"]],
      layout: {
        visibility: "none",
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"], ""],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 19, 12],
        "text-variable-anchor": ["center", "top", "bottom"],
        "text-radial-offset": 0.2,
      },
      paint: {
        "text-color": "#ecfeff",
        "text-halo-color": "#083344",
        "text-halo-width": 1.5,
      },
    },
    {
      id: "reference-places",
      type: "symbol",
      source: "reference-openfreemap",
      "source-layer": "place",
      minzoom: 4,
      filter: ["in", ["get", "class"], ["literal", ["city", "town", "village", "suburb", "neighbourhood", "hamlet", "quarter", "isolated_dwelling"]]],
      layout: {
        visibility: "none",
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"], ""],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 15, 14, 19, 16],
        "text-variable-anchor": ["top", "bottom", "left", "right"],
        "text-radial-offset": 0.35,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#f8fafc",
        "text-halo-color": "#0b1013",
        "text-halo-width": 1.5,
      },
    },
    {
      id: "reference-pois",
      type: "circle",
      source: "reference-openfreemap",
      "source-layer": "poi",
      minzoom: 12,
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.8, 18, 5.5],
        "circle-color": "#2dd4bf",
        "circle-stroke-color": "#0b1013",
        "circle-stroke-width": 1.2,
        "circle-opacity": 0.95,
      },
    },
    {
      id: "reference-poi-labels",
      type: "symbol",
      source: "reference-openfreemap",
      "source-layer": "poi",
      minzoom: 13,
      filter: ["any", ["has", "name"], ["has", "name:en"]],
      layout: {
        visibility: "none",
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"], ""],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 9, 18, 12],
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-variable-anchor": ["top", "bottom", "left", "right"],
        "text-radial-offset": 0.35,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#ccfbf1",
        "text-halo-color": "#042f2e",
        "text-halo-width": 1.5,
      },
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
const REFERENCE_SURVEY_BUILDING_LABELS = "reference-survey-building-labels";

const PLACEMARK_SOURCE = "user-placemarks-source";
const PLACEMARK_FOCUS_SOURCE = "user-placemark-focus-source";
const PLACEMARK_LAYER = "user-placemarks-layer";
const PLACEMARK_SELECTED_LAYER = "user-placemarks-selected-layer";
const PLACEMARK_HOVER_LAYER = "user-placemarks-hover-layer";
const PLACEMARK_HIT_LAYER = "user-placemarks-hit-layer";
const PLACEMARK_HOVER_HALO_LAYER = "user-placemarks-hover-halo-layer";
const PLACEMARK_SELECTED_HALO_LAYER = "user-placemarks-selected-halo-layer";
const PLACEMARK_CLUSTER_LAYER = "user-placemarks-cluster-layer";
const PLACEMARK_CLUSTER_COUNT_LAYER = "user-placemarks-cluster-count-layer";
const PLACEMARK_LABEL_LAYER = "user-placemarks-label-layer";
const PLACEMARK_HOVER_LABEL_LAYER = "user-placemarks-hover-label-layer";
const PLACEMARK_SELECTED_LABEL_LAYER = "user-placemarks-selected-label-layer";
const PLACEMARK_ICON_ID = "user-placemark-pin";
const PLACEMARK_ICON_IDS = {
  pin: PLACEMARK_ICON_ID,
  star: "user-placemark-star",
  flag: "user-placemark-flag",
  survey: "user-placemark-survey",
} as const;
const PLACEMARK_ICON_EXPRESSION: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "icon"],
  "star", PLACEMARK_ICON_IDS.star,
  "flag", PLACEMARK_ICON_IDS.flag,
  "survey", PLACEMARK_ICON_IDS.survey,
  PLACEMARK_ICON_IDS.pin,
];
const REFERENCE_LAYER_IDS: Record<keyof ReferenceLayerVisibility, string[]> = {
  borders: ["reference-boundaries", "reference-boundary-labels"],
  roads: ["reference-roads", "reference-road-labels"],
  buildings: ["reference-buildings", "reference-building-labels", REFERENCE_SURVEY_BUILDING_LABELS],
  places: ["reference-places", "reference-pois", "reference-poi-labels"],
};

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

const VIZ_SOURCE_LAYER_PROP = "__viz_source_layer";
const VIZ_LAYER_ID_PROP = "__viz_layer_id";
const VIZ_VALUE_PROP = "__viz_value";
const VIZ_MISSING_PROP = "__viz_missing";

const VIZ_SELECTED_SOURCE = "visualization-selected-source";
const VIZ_SELECTED_POLY_FILL = "visualization-selected-polygon-fill";
const VIZ_SELECTED_POLY_OUTLINE = "visualization-selected-polygon-outline";
const VIZ_SELECTED_LINES = "visualization-selected-lines";
const VIZ_SELECTED_POINTS = "visualization-selected-points";

export type VisualizationMode = "default" | "category" | "numeric" | "missing-data";
export type VisualizationGeometryTarget = "point" | "line" | "polygon";

interface VisualizationStylePreview {
  loadedCount: number;
  numericMin: number | null;
  numericMax: number | null;
  availableCount: number;
  missingCount: number;
  categories: Array<{ value: string; count: number; color: string }>;
}

function visualizationLayerId(datasetId: string, sourceLayer: string): string {
  return `${datasetId}::${sourceLayer}`;
}

function sourceLayerFromFeature(feature: GeoJSON.Feature): string {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const attributes = (properties.attributes ?? {}) as Record<string, unknown>;
  const gdbLayer = attributes.gdb_layer;
  if (typeof gdbLayer === "string" && gdbLayer.trim()) return gdbLayer.trim();
  const category = properties.category;
  return typeof category === "string" && category.trim() ? category.trim() : "uncategorized";
}

function isMissingVisualizationValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function withFeatureVisibility(
  base: maplibregl.FilterSpecification,
  hiddenCategories: Set<string>,
  hiddenVisualizationLayers: Set<string>
): maplibregl.FilterSpecification {
  const clauses: unknown[] = [base];
  if (hiddenCategories.size > 0) {
    clauses.push([
      "!",
      ["in", ["coalesce", ["get", "category"], "uncategorized"], ["literal", Array.from(hiddenCategories)]],
    ]);
  }
  if (hiddenVisualizationLayers.size > 0) {
    clauses.push([
      "!",
      ["in", ["coalesce", ["get", VIZ_LAYER_ID_PROP], ""], ["literal", Array.from(hiddenVisualizationLayers)]],
    ]);
  }
  if (clauses.length === 1) return base;
  return ["all", ...clauses] as unknown as maplibregl.FilterSpecification;
}

function aggregateVisualizationFields(
  layers: VisualizationLayerManifest[]
): VisualizationFieldProfile[] {
  const byName = new Map<string, VisualizationFieldProfile>();
  for (const layer of layers) {
    for (const field of layer.fields) {
      const existing = byName.get(field.name);
      if (!existing) {
        byName.set(field.name, { ...field });
        continue;
      }
      const detectedType = existing.detected_type === field.detected_type
        ? existing.detected_type
        : "mixed";
      const uniqueValues = [existing.unique_count, field.unique_count]
        .filter((value): value is number => typeof value === "number");
      byName.set(field.name, {
        name: field.name,
        detected_type: detectedType,
        populated_count: existing.populated_count + field.populated_count,
        missing_count: existing.missing_count + field.missing_count,
        unique_count: uniqueValues.length > 0 ? Math.max(...uniqueValues) : null,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  }));
}

/**
 * Geometry-based attribute groups arrive pre-built on the manifest
 * (`manifest.field_groups`) — three groups named "{source} - Points/Lines/
 * Polygon" with their fields already aggregated. No client-side aggregation
 * across layers is needed; the panel simply renders them (or falls back to the
 * flat <select> when absent).
 */

function defaultVisualizationField(
  fields: VisualizationFieldProfile[],
  mode: VisualizationMode
): string | null {
  if (mode === "default") return null;
  const eligible = fields.filter((field) => {
    if (mode === "category") {
      return (field.detected_type === "string" || field.detected_type === "boolean")
        && (field.unique_count ?? 0) > 1
        && (field.unique_count ?? 0) <= 50;
    }
    if (mode === "numeric") return field.detected_type === "number";
    return field.missing_count > 0;
  });
  const technical = /^(fid|objectid|shape_(length|area)|x_long|y_lat|gdb_layer)$/i;
  return eligible.find((field) => !technical.test(field.name))?.name ?? eligible[0]?.name ?? null;
}

// When an AI Detection mode is active we want to show ONLY the asset family
// that mode is about (e.g. manholes → Access_Point), and hide every other
// surveyed category — regardless of which datasets happen to be loaded or
// whether the category→canonical_class map is complete. We filter on the
// authoritative `_canonical_class` attribute each feature now carries, which
// is far more robust than the classMap/categoryStats bookkeeping used by the
// manual Layers checklist.
function withCanonicalVisibility(
  base: maplibregl.FilterSpecification,
  allowed: string[],
  extraCategories: Set<string> = new Set()
): maplibregl.FilterSpecification {
  const canonicalMatch: maplibregl.ExpressionSpecification = [
    "in", ["coalesce", ["get", "canonical_class"], "Unclassified"], ["literal", allowed],
  ];
  if (extraCategories.size === 0) {
    return ["all", base, canonicalMatch] as unknown as maplibregl.FilterSpecification;
  }
  // Categories the user explicitly opted into via the Layers checklist while
  // this detection mode is active — shown in addition to the mode's own
  // asset family, not instead of it.
  const extraMatch: maplibregl.ExpressionSpecification = [
    "in", ["coalesce", ["get", "category"], "uncategorized"], ["literal", Array.from(extraCategories)],
  ];
  return ["all", base, ["any", canonicalMatch, extraMatch]] as unknown as maplibregl.FilterSpecification;
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

// AI Manhole Recommendation Engine — proposed/rehab pipe routes, its own
// source/layer so it never touches the anomaly/highlight layers above.
const MANHOLE_ROUTES_SOURCE = "manhole-recommend-routes";
const LAYER_MANHOLE_ROUTES = "manhole-recommend-routes-line";
const LAYER_MANHOLE_FLOW_ARROWS = "manhole-recommend-routes-flow-arrows";
const FLOW_ARROW_ICON_ID = "manhole-flow-arrow-icon";
const MANHOLE_POINTS_SOURCE = "manhole-recommend-points";
const LAYER_MANHOLE_POINTS = "manhole-recommend-points-circle";
const MANHOLE_UNCONNECTED_SOURCE = "manhole-recommend-unconnected";
const LAYER_MANHOLE_UNCONNECTED = "manhole-recommend-unconnected-circle";
const MANHOLE_ROUTE_COLOR = "#3aa1ff";
const MANHOLE_UNCONNECTED_COLOR = "#9b59b6";
const ANOMALY_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "case",
  ["==", ["get", "status"], "resolved"], "#2563eb",
  [
    "match", ["get", "color"],
    "red", "#ef4444",
    "yellow", "#f59e0b",
    "green", "#22c55e",
    "#94a3b8",
  ],
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

/** Small right-pointing triangle used as the flow-direction arrow along
 * manhole-recommend route lines. Icon-based rather than text-field, since
 * this map style has no "glyphs" endpoint configured (text-field symbol
 * layers fail validation without one). */
function buildFlowArrowImageData(): ImageData {
  const w = 24, h = 24;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.moveTo(2, 3);
  ctx.lineTo(22, 12);
  ctx.lineTo(2, 21);
  ctx.closePath();
  ctx.fillStyle = MANHOLE_ROUTE_COLOR;
  ctx.strokeStyle = "#0b1013";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.fill();
  ctx.stroke();
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


// Blue is an AI-workflow color only. Normal map/category rendering always
// keeps its original category color, even after Admin approval.
const POINT_ISSUE_RESOLVED_COLOR = "#2563eb";
function withPointVerificationColor(
  fallback: maplibregl.ExpressionSpecification | string,
): maplibregl.ExpressionSpecification | string {
  return fallback;
}

function buildCategoryColorExpression(
  colorByCategory: Map<string, string>
): maplibregl.ExpressionSpecification | string {
  // A MapLibre "match" expression requires at least one input/output pair
  // before its fallback value — with zero categories seen yet (empty map,
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
  buildingColor: Record<string, "red" | "yellow" | "blue">
): maplibregl.ExpressionSpecification | string {
  const entries = Object.entries(buildingColor);
  if (entries.length === 0) return BUILDING_DEFAULT_COLOR;
  const pairs: (string | maplibregl.ExpressionSpecification)[] = [];
  for (const [id, color] of entries) {
    pairs.push(id, color === "blue" ? POINT_ISSUE_RESOLVED_COLOR : color === "red" ? BUILDING_RED_COLOR : BUILDING_YELLOW_COLOR);
  }
  return ["match", ["get", "id"], ...pairs, BUILDING_DEFAULT_COLOR] as unknown as maplibregl.ExpressionSpecification;
}

type AnomalyDisplayColor = SpatialAnomaly["color"] | "blue";

const ANOMALY_BADGE_COLOR: Record<AnomalyDisplayColor, string> = {
  red: BUILDING_RED_COLOR,
  yellow: BUILDING_YELLOW_COLOR,
  green: BUILDING_DEFAULT_COLOR,
  blue: POINT_ISSUE_RESOLVED_COLOR,
};

const ANOMALY_TYPE_LABEL: Record<SpatialAnomaly["anomaly_type"], string> = {
  pole_redundancy: "Pole Redundancy",
  drain_encroachment: "Drain Encroachment",
  manhole_status: "Manhole Status",
};

/** One-line, numbers-first summary for the hover tooltip's AI Detected
 * badge — same underlying facts as the click-through AI Alert card, just
 * condensed so it's readable at a glance without opening anything. */
function summarizeAnomalyForTooltip(a: SpatialAnomaly): { color: AnomalyDisplayColor; typeLabel: string; metric: string; resolved: boolean; longitude: number; latitude: number } {
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
    metric = typeof m.basis === "string" ? m.basis : (
      m.nearest_drain_category
        ? `Nearest drain: ${m.nearest_drain_category} (${m.nearest_drain_distance_m ?? "?"}m)`
        : "No nearby drain found"
    );
  }
  const resolved = a.status === "resolved";
  return {
    color: resolved ? "blue" : a.color,
    typeLabel: ANOMALY_TYPE_LABEL[a.anomaly_type],
    metric: resolved ? `Resolved and Admin approved · ${metric}` : metric,
    resolved,
    longitude: a.lon,
    latitude: a.lat,
  };
}

function primaryFeatureIdForAnomaly(anomaly: SpatialAnomaly): string | null {
  return (
    (anomaly.anomaly_metadata.this_feature_id as string | undefined) ??
    (anomaly.anomaly_metadata.building_id as string | undefined) ??
    (anomaly.anomaly_metadata.manhole_id as string | undefined) ??
    anomaly.feature_ids[0] ??
    null
  );
}

function aiVerificationContextForAnomaly(
  anomaly: SpatialAnomaly | undefined,
  mode: DetectionMode,
): AiVerificationContext | null {
  if (!anomaly || !mode || (anomaly.color !== "red" && anomaly.color !== "yellow")) return null;
  if (anomaly.anomaly_type !== DETECTION_MODE_ANOMALY_TYPE[mode]) return null;
  return {
    anomalyId: anomaly.id,
    detectionMode: mode,
    anomalyType: anomaly.anomaly_type,
    aiColor: anomaly.color,
    severityScore: anomaly.severity_score,
    detectedAt: anomaly.created_at,
    longitude: anomaly.lon,
    latitude: anomaly.lat,
  };
}

function verificationSummaryFromAttributes(attributes: Record<string, unknown>): HoverInfo["verification"] {
  const status = typeof attributes._verification_status === "string" ? attributes._verification_status : null;
  const originalCondition = typeof attributes._verification_original_condition === "string"
    ? attributes._verification_original_condition
    : typeof attributes.Condition === "string"
      ? attributes.Condition
      : typeof attributes.condition === "string"
        ? attributes.condition
        : null;
  const verified = typeof attributes._verification_current_condition === "string"
    ? attributes._verification_current_condition
    : typeof attributes._verification_verified_condition === "string"
      ? attributes._verification_verified_condition
      : null;
  if (!status && !verified) return undefined;
  return {
    originalCondition,
    currentCondition: status === "resolved" && verified ? verified : originalCondition,
    status,
    architect: typeof attributes._verification_architect === "string" ? attributes._verification_architect : null,
    admin: typeof attributes._verification_verified_by === "string" ? attributes._verification_verified_by : null,
    approvedAt: typeof attributes._verification_resolved_at === "string" ? attributes._verification_resolved_at : null,
    remarks: typeof attributes._verification_remarks === "string" ? attributes._verification_remarks : null,
  };
}

const EMPTY_FC: FeatureCollectionResponse = { type: "FeatureCollection", features: [], bbox: [0, 0, 0, 0], count: 0, limit: 0, truncated: false };


function createPlacemarkPinImage(color = "#ef4444"): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return new ImageData(64, 64);
  context.clearRect(0, 0, 64, 64);
  context.save();
  context.shadowColor = "rgba(0,0,0,0.35)";
  context.shadowBlur = 5;
  context.shadowOffsetY = 3;
  context.beginPath();
  context.moveTo(32, 60);
  context.bezierCurveTo(27, 48, 12, 37, 12, 23);
  context.arc(32, 23, 20, Math.PI, 0, false);
  context.bezierCurveTo(52, 37, 37, 48, 32, 60);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  context.restore();
  context.beginPath();
  context.arc(32, 23, 7.5, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "rgba(127,29,29,0.75)";
  context.stroke();
  return context.getImageData(0, 0, 64, 64);
}

function createPlacemarkMarkerElement(): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "placemark-preview-marker";
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "Temporary placemark pin");
  element.innerHTML = '<span class="placemark-preview-marker__head"></span><span class="placemark-preview-marker__tail"></span>';
  return element;
}

function createCoordinateSearchMarkerElement(): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "coordinate-search-marker";
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "Coordinate search target");
  element.innerHTML = '<span class="coordinate-search-marker__ring"></span><span class="coordinate-search-marker__dot"></span><span class="coordinate-search-marker__cross coordinate-search-marker__cross--horizontal"></span><span class="coordinate-search-marker__cross coordinate-search-marker__cross--vertical"></span>';
  return element;
}

function placemarksToGeoJson(placemarks: Placemark[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: placemarks
      .filter((placemark) => placemark.is_visible)
      .map((placemark) => ({
        type: "Feature",
        id: placemark.id,
        geometry: { type: "Point", coordinates: [placemark.longitude, placemark.latitude] },
        properties: {
          id: placemark.id,
          name: placemark.name,
          category: placemark.category ?? "",
          icon: placemark.icon,
        },
      })),
  };
}

function placemarkFocusToGeoJson(
  placemarks: Placemark[],
  selectedId: string | null,
  hoveredId: string | null,
): GeoJSON.FeatureCollection {
  const ids = [selectedId, hoveredId].filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index);
  return {
    type: "FeatureCollection",
    features: ids.flatMap((id) => {
      const placemark = placemarks.find((item) => item.id === id);
      if (!placemark) return [];
      return [{
        type: "Feature" as const,
        id: placemark.id,
        geometry: {
          type: "Point" as const,
          coordinates: [placemark.longitude, placemark.latitude],
        },
        properties: {
          id: placemark.id,
          name: placemark.name,
          category: placemark.category ?? "",
          icon: placemark.icon,
        },
      }];
    }),
  };
}

function estimateEyeAltitudeMeters(
  zoom: number,
  latitude: number,
  viewportHeight: number,
  pitch: number
): number {
  const latitudeFactor = Math.max(0.05, Math.cos((latitude * Math.PI) / 180));
  const metersPerPixel = 156543.03392 * latitudeFactor / (2 ** zoom);
  const verticalFieldOfView = 36.87 * Math.PI / 180;
  const baseAltitude = (metersPerPixel * Math.max(1, viewportHeight)) / (2 * Math.tan(verticalFieldOfView / 2));
  return baseAltitude / Math.max(0.35, Math.cos((pitch * Math.PI) / 180));
}

function formatMetricDistance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 2)} km`;
  return `${Math.round(value)} m`;
}

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
  aiDetection?: { color: AnomalyDisplayColor; typeLabel: string; metric: string; resolved: boolean; longitude: number; latitude: number };
  verification?: {
    originalCondition: string | null;
    currentCondition: string | null;
    status: string | null;
    architect: string | null;
    admin: string | null;
    approvedAt: string | null;
    remarks: string | null;
  };
}
interface LayerAttributeTableState extends LayerFeatureTableFilter {
  sourceLabel: string;
}
export interface MapCanvasHandle {
  clearDatasets: () => void;
}

export const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(
  {
    filter,
    onFeatureSelect,
    onActiveDatasetsChange,
    initialActiveDatasets,
    aiHighlights,
    focusFeatureId,
    onFocusHandled,
    refreshToken = 0,
    commandCenterMobileOpen, onCommandCenterMobileOpenChange,
    spatialAuditRequestedRef, spatialAuditExecutedRef,
    spatialAuditStatus, onSpatialAuditStatusChange,
  },
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
  // Full (unsliced) per-category breakdown of the currently loaded features,
  // for the QGIS-style layer-visibility checklist in the Command Center.
  // The compact map overlay remains independently limited.

  const [categoryStats, setCategoryStats] = useState<LegendEntry[]>([]);
  // Categories unchecked in that checklist — purely a client-side paint/
  // filter toggle on already-fetched features, so it applies instantly and
  // never touches the topbar ward/category filter or triggers a refetch.
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());
  // While an AI Detection mode is active, the map is restricted to that
  // mode's own asset family (see the canonical-class effect below) and the
  // ordinary hiddenCategories checklist stands down entirely. This is a
  // separate, mode-scoped "show this extra category too" allowlist so the
  // Layers checklist still does something useful during a detection mode —
  // starts empty every time a mode is entered/left, so nothing extra shows
  // until the user explicitly asks for it.
  const [extraVisibleCategories, setExtraVisibleCategories] = useState<Set<string>>(new Set());
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
  const obj3dLayersRef = useRef<Set<string>>(new Set());
  // Dataset ids whose data is an OBJ mesh — their vertex point features are
  // drawn as the draped 3D mesh (Obj3DMapLayer), so they must NOT also be
  // plotted as flat 2D circles in the feature source below.
  const objDatasetIdsRef = useRef<Set<string>>(new Set());
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  const [rasterSettingsById, setRasterSettingsById] = useState<Record<string, RasterDisplaySettings>>({});

  // Universal visualization UI. Manifests are fetched only for active vector
  // datasets; raster, image, and OBJ datasets keep their existing renderers.
  const [visualizationManifests, setVisualizationManifests] = useState<Record<string, VisualizationManifest>>({});
  const [visualizationLoadingIds, setVisualizationLoadingIds] = useState<Set<string>>(new Set());
  const [visualizationErrors, setVisualizationErrors] = useState<Record<string, string>>({});
  const [selectedVisualizationDatasetId, setSelectedVisualizationDatasetId] = useState<string | null>(null);
  const [visualizationTarget, setVisualizationTarget] = useState<VisualizationGeometryTarget>("point");
  const [visualizationMode, setVisualizationMode] = useState<VisualizationMode>("default");
  const [visualizationField, setVisualizationField] = useState<string | null>(null);
  const [visualizationOpacity, setVisualizationOpacity] = useState(0.85);
  const [visualizationPointSize, setVisualizationPointSize] = useState(4);
  const [visualizationLineWidth, setVisualizationLineWidth] = useState(3);
  const [selectedVisualizationFeatures, setSelectedVisualizationFeatures] = useState<GeoJSON.Feature[]>([]);
  const [visualizationLayerLoading, setVisualizationLayerLoading] = useState(false);
  const [visualizationLayerError, setVisualizationLayerError] = useState<string | null>(null);
  const [visualizationLayerTruncated, setVisualizationLayerTruncated] = useState(false);
  const visualizationLayerAbortRef = useRef<AbortController | null>(null);

  // Spatial Audit Engine — persisted findings for the currently active
  // dataset(s), plus which one (if any) is open in the AI Alert card.
  const [anomalies, setAnomalies] = useState<SpatialAnomaly[]>([]);
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);

  // AI Manhole Recommendation Engine — computed fresh per click/plan-run
  // (not pre-persisted like the spatial audit engine above), so its own
  // loading/error/answer state lives separately from the anomaly card's.
  const [manholeRecommendAnswer, setManholeRecommendAnswer] = useState<AiAnswer | null>(null);
  const [manholeRecommendLoading, setManholeRecommendLoading] = useState(false);
  const [manholeRecommendError, setManholeRecommendError] = useState<string | null>(null);
  const [manholeRecommendOpen, setManholeRecommendOpen] = useState(false);
  // Single-manhole click ("feature" mode: real pipe suggestion — material,
  // diameter, RLs, route) — deliberately its OWN state, separate from the
  // network-mode state above. The map's drawn network (MANHOLE_ROUTES_SOURCE)
  // reads only manholeRecommendAnswer, never this one, so clicking a manhole
  // to see its pipe suggestion can never clear an already-drawn network.
  const [manholeFeatureAnswer, setManholeFeatureAnswer] = useState<AiAnswer | null>(null);
  const [manholeFeatureLoading, setManholeFeatureLoading] = useState(false);
  const [manholeFeatureError, setManholeFeatureError] = useState<string | null>(null);
  const [manholeFeatureOpen, setManholeFeatureOpen] = useState(false);
  // Phase C — 3D subsurface view, opened from the same recommend result
  // (or on its own, showing real terrain/buildings/manholes with no plan
  // run yet) so it never shows a fact the 2D view didn't already show.
  const [show3DPlan, setShow3DPlan] = useState(false);

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
  const buildingColorMapRef = useRef<Record<string, "red" | "yellow" | "blue">>({});
  // feature id -> its own anomaly, for the hover tooltip's "AI Detected"
  // badge — populated whenever anomalies changes, read via ref from the
  // hover handler (registered once at map load).
  const anomalyByFeatureIdRef = useRef<Record<string, SpatialAnomaly>>({});
  const anomalyByIdRef = useRef<Record<string, SpatialAnomaly>>({});
  const aiAnomalyClickConsumedRef = useRef(false);
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
  // Mirrors classMap for handleFeatureClick (registered once at map load,
  // per the same stale-closure reasoning as detectionModeRef above) — it
  // needs to know whether a clicked feature is an Access_Point (manhole)
  // to trigger the manhole-recommend card.
  const classMapRef = useRef<Record<string, string>>({});
  const rasterSettingsRef = useRef<Record<string, RasterDisplaySettings>>({});
  const [flyError, setFlyError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [attributeTable, setAttributeTable] = useState<LayerAttributeTableState | null>(null);

  // User placemarks are a separate persisted annotation system. They never
  // enter the uploaded survey feature source or analytics/category filters.
  const [placemarks, setPlacemarks] = useState<Placemark[]>([]);
  const placemarksRef = useRef<Placemark[]>([]);
  const [placemarksLoading, setPlacemarksLoading] = useState(false);
  const [placemarksError, setPlacemarksError] = useState<string | null>(null);
  const [placemarkMode, setPlacemarkMode] = useState(false);
  const placemarkModeRef = useRef(false);
  const placemarkSavedClickRef = useRef(false);
  const [placemarkDraft, setPlacemarkDraft] = useState<PlacemarkDraft | null>(null);
  const placemarkDraftRef = useRef<PlacemarkDraft | null>(null);
  const [placemarkSaving, setPlacemarkSaving] = useState(false);
  const [placemarkEditorError, setPlacemarkEditorError] = useState<string | null>(null);
  const placemarkPreviewMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [selectedPlacemarkId, setSelectedPlacemarkId] = useState<string | null>(null);
  const [mapHoveredPlacemarkId, setMapHoveredPlacemarkId] = useState<string | null>(null);
  const [listHoveredPlacemarkId, setListHoveredPlacemarkId] = useState<string | null>(null);
  const hoveredPlacemarkId = listHoveredPlacemarkId ?? mapHoveredPlacemarkId;
  const [placemarkDetailsId, setPlacemarkDetailsId] = useState<string | null>(null);
  const [placemarkNotice, setPlacemarkNotice] = useState<string | null>(null);
  const [myPlacesOpen, setMyPlacesOpen] = useState(false);
  const [coordinateSearchOpen, setCoordinateSearchOpen] = useState(false);
  const coordinateSearchMarkerRef = useRef<maplibregl.Marker | null>(null);
  // Below the mobile breakpoint the Data Sources sidebar becomes a
  // slide-in drawer rather than a permanent fixed panel — open state is
  // lifted up to WorkspaceLayout (see commandCenterMobileOpen prop) so the
  // topbar's menu button can open it.
  const isMobile = useIsMobile();
  const [referenceLayers, setReferenceLayers] = useState<ReferenceLayerVisibility>({
    borders: false,
    roads: false,
    buildings: false,
    places: false,
  });
  const [elevationSample, setElevationSample] = useState<ElevationSample | null>(null);

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

  const cancelPlacemarkPlacement = useCallback((clearDraft = true) => {
    placemarkModeRef.current = false;
    setPlacemarkMode(false);
    if (clearDraft) {
      placemarkDraftRef.current = null;
      setPlacemarkDraft(null);
      setPlacemarkEditorError(null);
    }
    placemarkPreviewMarkerRef.current?.remove();
    placemarkPreviewMarkerRef.current = null;
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = "";
  }, []);

  const clearCoordinateSearchTarget = useCallback(() => {
    coordinateSearchMarkerRef.current?.remove();
    coordinateSearchMarkerRef.current = null;
  }, []);

  const closeCoordinateSearch = useCallback(() => {
    clearCoordinateSearchTarget();
    setCoordinateSearchOpen(false);
  }, [clearCoordinateSearchTarget]);

  const toggleCoordinateSearch = useCallback(() => {
    setCoordinateSearchOpen((current) => {
      if (current) clearCoordinateSearchTarget();
      return !current;
    });
  }, [clearCoordinateSearchTarget]);

  const handleCoordinateFlyTo = useCallback((coordinate: CoordinateValue) => {
    const map = mapRef.current;
    if (!map) return;

    clearCoordinateSearchTarget();
    coordinateSearchMarkerRef.current = new maplibregl.Marker({
      element: createCoordinateSearchMarkerElement(),
      anchor: "center",
    })
      .setLngLat([coordinate.longitude, coordinate.latitude])
      .addTo(map);

    map.flyTo({
      center: [coordinate.longitude, coordinate.latitude],
      zoom: Math.max(map.getZoom(), 17),
      duration: 1500,
      curve: 1.35,
      essential: true,
    });
  }, [clearCoordinateSearchTarget]);

  useEffect(() => () => {
    coordinateSearchMarkerRef.current?.remove();
    coordinateSearchMarkerRef.current = null;
  }, []);

  const toggleStreetPickMode = useCallback(() => {
    cancelPlacemarkPlacement();
    deactivateLookAround();
    setStreetPickMode((current) => {
      const next = !current;
      streetPickModeRef.current = next;
      const canvas = mapRef.current?.getCanvas();
      if (canvas) canvas.style.cursor = next ? "crosshair" : "";
      return next;
    });
  }, [cancelPlacemarkPlacement, deactivateLookAround]);

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

  const refreshPlacemarks = useCallback(async (signal?: AbortSignal) => {
    setPlacemarksLoading(true);
    setPlacemarksError(null);
    try {
      const rows = await fetchPlacemarks(signal);
      placemarksRef.current = rows;
      setPlacemarks(rows);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setPlacemarksError(error instanceof ApiError ? "Could not load saved placemarks." : (error as Error).message);
    } finally {
      if (!signal?.aborted) setPlacemarksLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshPlacemarks(controller.signal);
    return () => controller.abort();
  }, [refreshPlacemarks]);

  useEffect(() => {
    placemarksRef.current = placemarks;
  }, [placemarks]);

  useEffect(() => {
    if (!placemarkNotice) return;
    const timeout = window.setTimeout(() => setPlacemarkNotice(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [placemarkNotice]);

  useEffect(() => {
    placemarkDraftRef.current = placemarkDraft;
    const marker = placemarkPreviewMarkerRef.current;
    if (!marker || !placemarkDraft) return;
    const current = marker.getLngLat();
    if (Math.abs(current.lng - placemarkDraft.longitude) > 1e-9 || Math.abs(current.lat - placemarkDraft.latitude) > 1e-9) {
      marker.setLngLat([placemarkDraft.longitude, placemarkDraft.latitude]);
    }
  }, [placemarkDraft]);

  // Keep a fast lookup of which datasets are OBJ meshes so applyFeatureCollection
  // can drop their vertex points from the 2D feature layers (they are rendered
  // as the 3D mesh instead).
  useEffect(() => {
    objDatasetIdsRef.current = new Set(datasets.filter(isObjDataset).map((d) => d.id));
  }, [datasets]);

  const activeVectorDatasets = useMemo(
    () => datasets.filter((dataset) => activeDatasetIds.includes(dataset.id) && isVectorVisualizationDataset(dataset)),
    [datasets, activeDatasetIds]
  );
  const coordinateSearchDatasets = useMemo<CoordinateSearchDataset[]>(() => {
    const candidates = activeVectorDatasets.length > 0
      ? activeVectorDatasets
      : datasets.filter(isVectorVisualizationDataset);
    return candidates.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      sourceCrs: visualizationManifests[dataset.id]?.source_crs
        ?? sourceCrsFromDatasetMetadata(dataset),
      bounds: visualizationManifests[dataset.id]?.bounds ?? null,
    }));
  }, [activeVectorDatasets, datasets, visualizationManifests]);

  useEffect(() => {
    setSelectedVisualizationDatasetId((current) => (
      current && activeVectorDatasets.some((dataset) => dataset.id === current) ? current : null
    ));
  }, [activeVectorDatasets]);

  // Load styling metadata (which also carries the per-source-layer attribute
  // tree) for every active vector dataset. This is required so the map's
  // layer/attribute panel can group source layers by geometry — not just when a
  // user opens Layer styling. Each dataset is fetched at most once; results are
  // cached in `visualizationManifests`, so repeated renders are cheap.
  useEffect(() => {
    const pending = activeVectorDatasets.filter(
      (dataset) => !visualizationManifests[dataset.id]
    );
    if (pending.length === 0) return;

    const controller = new AbortController();
    for (const dataset of pending) {
      setVisualizationLoadingIds((current) => new Set(current).add(dataset.id));

      void fetchVisualizationManifest(dataset.id, controller.signal).then((manifest) => {
        if (controller.signal.aborted) return;
        setVisualizationManifests((current) => ({ ...current, [dataset.id]: manifest }));
        setVisualizationErrors((current) => {
          const next = { ...current };
          delete next[dataset.id];
          return next;
        });
      }).catch((error: Error) => {
        if (error.name === "AbortError") return;
        setVisualizationErrors((current) => ({ ...current, [dataset.id]: error.message }));
      }).finally(() => {
        if (controller.signal.aborted) return;
        setVisualizationLoadingIds((current) => {
          const next = new Set(current);
          next.delete(dataset.id);
          return next;
        });
      });
    }

    return () => controller.abort();
  }, [activeVectorDatasets, visualizationManifests]);

  const selectedVisualizationManifest = selectedVisualizationDatasetId
    ? visualizationManifests[selectedVisualizationDatasetId] ?? null
    : null;

  const selectedVisualizationLayers = useMemo(() => {
    const layers = selectedVisualizationManifest?.layers ?? [];
    return layers.filter((layer) => layer.recommended_renderer === visualizationTarget);
  }, [selectedVisualizationManifest, visualizationTarget]);

  const selectedVisualizationFields = useMemo(
    () => aggregateVisualizationFields(selectedVisualizationLayers),
    [selectedVisualizationLayers]
  );

  const selectedVisualizationSourceLayers = useMemo(
    () => [...new Set(selectedVisualizationLayers.map((layer) => layer.source_layer_name))],
    [selectedVisualizationLayers]
  );

  const selectedVisualizationCompositeIds = useMemo(() => {
    if (!selectedVisualizationDatasetId) return new Set<string>();
    return new Set(selectedVisualizationSourceLayers.map(
      (sourceLayer) => visualizationLayerId(selectedVisualizationDatasetId, sourceLayer)
    ));
  }, [selectedVisualizationDatasetId, selectedVisualizationSourceLayers]);

  const visualizationTargetDatasetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedVisualizationDatasetId) {
      visualizationTargetDatasetRef.current = null;
      return;
    }
    if (!selectedVisualizationManifest) return;

    const available = new Set(selectedVisualizationManifest.layers.map(
      (layer) => layer.recommended_renderer
    ));
    const firstAvailable = (["point", "line", "polygon"] as const)
      .find((candidate) => available.has(candidate));
    if (!firstAvailable) return;

    if (visualizationTargetDatasetRef.current !== selectedVisualizationDatasetId) {
      visualizationTargetDatasetRef.current = selectedVisualizationDatasetId;
      setVisualizationTarget(firstAvailable);
      return;
    }
    if (!available.has(visualizationTarget)) setVisualizationTarget(firstAvailable);
  }, [selectedVisualizationDatasetId, selectedVisualizationManifest, visualizationTarget]);

  useEffect(() => {
    setVisualizationMode("default");
    setVisualizationField(null);
  }, [selectedVisualizationDatasetId, visualizationTarget]);

  const visualizationPreview = useMemo<VisualizationStylePreview>(() => {
    const empty: VisualizationStylePreview = {
      loadedCount: 0,
      numericMin: null,
      numericMax: null,
      availableCount: 0,
      missingCount: 0,
      categories: [],
    };
    if (selectedVisualizationLayers.length === 0) return empty;

    const numericValues: number[] = [];
    const categoryCounts = new Map<string, number>();
    let loadedCount = 0;
    let availableCount = 0;
    let missingCount = 0;

    for (const feature of selectedVisualizationFeatures) {
      const raw = feature as unknown as GeoJSON.Feature;
      const properties = (raw.properties ?? {}) as Record<string, unknown>;
      loadedCount += 1;
      if (!visualizationField) continue;
      const attributes = (properties.attributes ?? {}) as Record<string, unknown>;
      const value = attributes[visualizationField];
      if (isMissingVisualizationValue(value)) {
        missingCount += 1;
        continue;
      }
      availableCount += 1;
      const numeric = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(numeric)) numericValues.push(numeric);
      const label = String(value);
      categoryCounts.set(label, (categoryCounts.get(label) ?? 0) + 1);
    }

    const categories = [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => ({
        value,
        count,
        color: colorForCategory(`visualization:${visualizationField}:${value}`),
      }));

    return {
      loadedCount,
      numericMin: numericValues.length ? Math.min(...numericValues) : null,
      numericMax: numericValues.length ? Math.max(...numericValues) : null,
      availableCount,
      missingCount,
      categories,
    };
  }, [selectedVisualizationFeatures, selectedVisualizationLayers.length, visualizationField]);

  const changeVisualizationMode = useCallback((mode: VisualizationMode) => {
    setVisualizationMode(mode);
    setVisualizationField(defaultVisualizationField(selectedVisualizationFields, mode));
  }, [selectedVisualizationFields]);

  const resetVisualizationStyle = useCallback(() => {
    setVisualizationMode("default");
    setVisualizationField(null);
    setVisualizationOpacity(0.85);
    setVisualizationPointSize(4);
    setVisualizationLineWidth(3);
  }, []);


  const clearSelectedVisualizationSource = useCallback(() => {
    setSelectedVisualizationFeatures([]);
    setVisualizationLayerTruncated(false);
    const map = mapRef.current;
    const source = map?.getSource(VIZ_SELECTED_SOURCE) as GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features: [] });
  }, []);

  const refreshSelectedVisualizationLayer = useCallback(async () => {
    const map = mapRef.current;
    if (
      !mapReady
      || !map
      || !selectedVisualizationDatasetId
      || selectedVisualizationLayers.length === 0
      || selectedVisualizationSourceLayers.length === 0
    ) {
      clearSelectedVisualizationSource();
      return;
    }

    visualizationLayerAbortRef.current?.abort();
    const controller = new AbortController();
    visualizationLayerAbortRef.current = controller;
    setVisualizationLayerLoading(true);
    setVisualizationLayerError(null);

    const bounds = map.getBounds();
    const bbox: [number, number, number, number] = [
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
    ];

    const batches = [selectedVisualizationSourceLayers];

    try {
      const responses = await Promise.all(batches.map((sourceLayers) => (
        fetchVisualizationLayerFeatures(
          bbox,
          selectedVisualizationDatasetId,
          sourceLayers,
          controller.signal
        )
      )));
      if (controller.signal.aborted) return;

      const byId = new Map<string, GeoJSON.Feature>();
      let anonymousIndex = 0;
      for (const data of responses) {
        for (const feature of data.features as unknown as GeoJSON.Feature[]) {
          const properties = (feature.properties ?? {}) as Record<string, unknown>;
          const sourceLayer = sourceLayerFromFeature(feature);
          const featureId = String(properties.id ?? feature.id ?? `anonymous-${anonymousIndex++}`);
          byId.set(featureId, {
            ...feature,
            properties: {
              ...properties,
              [VIZ_SOURCE_LAYER_PROP]: sourceLayer,
              [VIZ_LAYER_ID_PROP]: visualizationLayerId(selectedVisualizationDatasetId, sourceLayer),
            },
          } as GeoJSON.Feature);
        }
      }

      setSelectedVisualizationFeatures([...byId.values()]);
      setVisualizationLayerTruncated(responses.some((data) => data.truncated));
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setSelectedVisualizationFeatures([]);
      setVisualizationLayerTruncated(false);
      setVisualizationLayerError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setVisualizationLayerLoading(false);
    }
  }, [
    clearSelectedVisualizationSource,
    mapReady,
    selectedVisualizationDatasetId,
    selectedVisualizationLayers,
    selectedVisualizationSourceLayers,
  ]);
  useEffect(() => {
    void refreshSelectedVisualizationLayer();
    return () => visualizationLayerAbortRef.current?.abort();
  }, [refreshSelectedVisualizationLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const refresh = () => { void refreshSelectedVisualizationLayer(); };
    map.on("moveend", refresh);
    return () => { map.off("moveend", refresh); };
  }, [mapReady, refreshSelectedVisualizationLayer]);

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
    cancelPlacemarkPlacement();
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
  }, [cancelPlacemarkPlacement, closeMeasureSafely, deactivateLookAround, flushMeasureSources, cancelScheduledMeasurePreviewUpdate, beginNewSession, setMeasurePhase, syncMeasureCursor, suspendDataLayerInteraction]);

  // Toggling Look Around on defers to the same "other tools win" rule as
  // toggleStreetPickMode: it force-exits measurement/street-view-pick first
  // rather than teaching those tools about Look Around.
  const toggleLookAround = useCallback(() => {
    if (lookAroundActiveRef.current) {
      deactivateLookAround();
      return;
    }
    cancelPlacemarkPlacement();
    if (measureActiveRef.current) closeMeasureSafely();
    if (streetPickModeRef.current) toggleStreetPickMode();
    lookAroundActiveRef.current = true;
    setLookAroundActive(true);
  }, [cancelPlacemarkPlacement, deactivateLookAround, closeMeasureSafely, toggleStreetPickMode]);

  const openPlacemarkDraft = useCallback((draft: PlacemarkDraft) => {
    const map = mapRef.current;
    if (!map) return;
    placemarkPreviewMarkerRef.current?.remove();
    const marker = new maplibregl.Marker({
      element: createPlacemarkMarkerElement(),
      draggable: true,
      anchor: "bottom",
    })
      .setLngLat([draft.longitude, draft.latitude])
      .addTo(map);
    marker.on("dragend", () => {
      const next = marker.getLngLat();
      setPlacemarkDraft((current) => {
        if (!current) return current;
        const updated = {
          ...current,
          longitude: next.lng,
          latitude: next.lat,
        };
        placemarkDraftRef.current = updated;
        return updated;
      });
    });
    placemarkPreviewMarkerRef.current = marker;
    placemarkDraftRef.current = draft;
    setPlacemarkDraft(draft);
    setPlacemarkEditorError(null);
    setSelectedPlacemarkId(draft.id ?? null);
  }, []);

  const togglePlacemarkMode = useCallback(() => {
    if (placemarkModeRef.current) {
      cancelPlacemarkPlacement();
      return;
    }
    deactivateLookAround();
    if (measureActiveRef.current) closeMeasureSafely();
    if (streetPickModeRef.current) toggleStreetPickMode();
    placemarkModeRef.current = true;
    setPlacemarkMode(true);
    setPlacemarkEditorError(null);
    setHover(null);
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = "crosshair";
  }, [cancelPlacemarkPlacement, closeMeasureSafely, deactivateLookAround, toggleStreetPickMode]);

  const handleSavePlacemark = useCallback(async () => {
    const draft = placemarkDraftRef.current;
    if (!draft || !draft.name.trim()) return;
    const editing = Boolean(draft.id);
    setPlacemarkSaving(true);
    setPlacemarkEditorError(null);
    const payload = {
      name: draft.name.trim(),
      description: draft.description?.trim() || null,
      category: draft.category?.trim() || null,
      icon: draft.icon || "pin",
      longitude: draft.longitude,
      latitude: draft.latitude,
      altitude: draft.altitude ?? null,
      dataset_id: draft.dataset_id ?? null,
      is_visible: true,
    };
    try {
      const saved = draft.id
        ? await updatePlacemark(draft.id, payload)
        : await createPlacemark(payload);
      setPlacemarks((current) => {
        const without = current.filter((item) => item.id !== saved.id);
        const next = [saved, ...without];
        placemarksRef.current = next;
        return next;
      });
      setSelectedPlacemarkId(saved.id);
      setPlacemarkDetailsId(editing ? saved.id : null);
      setPlacemarkNotice(editing ? "Placemark updated successfully" : "Location marked successfully");
      cancelPlacemarkPlacement();
    } catch (error) {
      setPlacemarkEditorError(error instanceof ApiError ? "Could not save this placemark." : (error as Error).message);
    } finally {
      setPlacemarkSaving(false);
    }
  }, [cancelPlacemarkPlacement]);

  const handleEditPlacemark = useCallback((placemark: Placemark) => {
    setPlacemarkDetailsId(null);
    deactivateLookAround();
    if (measureActiveRef.current) closeMeasureSafely();
    if (streetPickModeRef.current) toggleStreetPickMode();
    placemarkModeRef.current = true;
    setPlacemarkMode(true);
    openPlacemarkDraft({
      id: placemark.id,
      name: placemark.name,
      description: placemark.description,
      category: placemark.category,
      icon: placemark.icon,
      longitude: placemark.longitude,
      latitude: placemark.latitude,
      altitude: placemark.altitude,
      dataset_id: placemark.dataset_id,
      is_visible: placemark.is_visible,
    });
    const map = mapRef.current;
    if (map) {
      map.flyTo({
        center: [placemark.longitude, placemark.latitude],
        zoom: Math.max(map.getZoom(), 17),
        duration: 700,
      });
    }
  }, [closeMeasureSafely, deactivateLookAround, openPlacemarkDraft, toggleStreetPickMode]);

  const handleFlyToPlacemark = useCallback((placemark: Placemark) => {
    cancelPlacemarkPlacement();
    const visiblePlacemark = { ...placemark, is_visible: true };
    setPlacemarks((current) => {
      const next = current.map((item) => item.id === placemark.id ? visiblePlacemark : item);
      placemarksRef.current = next;
      return next;
    });
    setSelectedPlacemarkId(placemark.id);
    setPlacemarkDetailsId(placemark.id);
    setListHoveredPlacemarkId(null);

    if (!placemark.is_visible) {
      void updatePlacemark(placemark.id, { is_visible: true })
        .then((updated) => {
          setPlacemarks((current) => {
            const next = current.map((item) => item.id === updated.id ? updated : item);
            placemarksRef.current = next;
            return next;
          });
        })
        .catch(() => setPlacemarksError("Could not show the selected placemark."));
    }

    const map = mapRef.current;
    if (!map) return;
    map.flyTo({
      center: [placemark.longitude, placemark.latitude],
      zoom: Math.max(map.getZoom(), 18),
      duration: 850,
      essential: true,
    });
  }, [cancelPlacemarkPlacement]);

  const handleTogglePlacemarkVisibility = useCallback(async (placemark: Placemark) => {
    try {
      const updated = await updatePlacemark(placemark.id, { is_visible: !placemark.is_visible });
      setPlacemarks((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch {
      setPlacemarksError("Could not update placemark visibility.");
    }
  }, []);

  const handleDeletePlacemark = useCallback(async (placemark: Placemark) => {
    try {
      await deletePlacemark(placemark.id);
      setPlacemarks((current) => current.filter((item) => item.id !== placemark.id));
      if (selectedPlacemarkId === placemark.id) setSelectedPlacemarkId(null);
      if (placemarkDetailsId === placemark.id) setPlacemarkDetailsId(null);
      if (placemarkDraftRef.current?.id === placemark.id) cancelPlacemarkPlacement();
    } catch {
      setPlacemarksError("Could not delete placemark.");
    }
  }, [cancelPlacemarkPlacement, placemarkDetailsId, selectedPlacemarkId]);

  const handleBulkDeletePlacemarks = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await bulkDeletePlacemarks(ids);
      const deleted = new Set(ids);
      setPlacemarks((current) => current.filter((item) => !deleted.has(item.id)));
      if (selectedPlacemarkId && deleted.has(selectedPlacemarkId)) setSelectedPlacemarkId(null);
      if (placemarkDetailsId && deleted.has(placemarkDetailsId)) setPlacemarkDetailsId(null);
      if (placemarkDraftRef.current?.id && deleted.has(placemarkDraftRef.current.id)) cancelPlacemarkPlacement();
    } catch {
      setPlacemarksError("Could not delete the selected placemarks.");
    }
  }, [cancelPlacemarkPlacement, placemarkDetailsId, selectedPlacemarkId]);

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
      if (placemarkModeRef.current || placemarkDraftRef.current) {
        e.preventDefault();
        e.stopPropagation();
        cancelPlacemarkPlacement();
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
  }, [cancelPlacemarkPlacement, cancelActiveMeasurement, deactivateLookAround]);

  const applyFeatureCollection = useCallback((data: FeatureCollectionResponse) => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(FEATURE_SOURCE) as GeoJSONSource | undefined;
    // `isStyleLoaded()` becomes false while new basemap tiles are loading
    // during a zoom. The GeoJSON source already exists at this point and is
    // safe to update, so gating on the whole style caused the new viewport
    // data to be discarded precisely while zooming.
    if (!src) return;

    // OBJ mesh datasets render as a draped 3D mesh (Obj3DMapLayer), so drop
    // their vertex point features here — otherwise they also paint as flat
    // 2D circles on top of the mesh, which the user does not want.
    const objIds = objDatasetIdsRef.current;
    const rawFeatures = objIds.size === 0
      ? (data.features as unknown as GeoJSON.Feature[])
      : (data.features as unknown as GeoJSON.Feature[]).filter((f) => {
          const did = String((f.properties as Record<string, unknown>)?.dataset_id ?? "");
          return !objIds.has(did);
        });

    // Add two internal top-level properties used only by the visualization UI.
    // Original attributes remain untouched inside properties.attributes.
    const features = rawFeatures.map((feature) => {
      const properties = (feature.properties ?? {}) as Record<string, unknown>;
      const datasetId = String(properties.dataset_id ?? "");
      const sourceLayer = sourceLayerFromFeature(feature);
      return {
        ...feature,
        properties: {
          ...properties,
          [VIZ_SOURCE_LAYER_PROP]: sourceLayer,
          [VIZ_LAYER_ID_PROP]: visualizationLayerId(datasetId, sourceLayer),
        },
      } as GeoJSON.Feature;
    });

    src.setData({ type: "FeatureCollection", features } as unknown as GeoJSON.FeatureCollection);
    // Keep the exact dashboard snapshot available to Street View. The
    // panorama applies the same client-side layer visibility controls and
    // creates nearby, georeferenced markers without issuing another request.
    setLoadedFeatures(features as unknown as UrbanFeature[]);

    // Cache coordinates for every Point feature so the AI highlight layer
    // can place its circles correctly even when highlights arrive after load.
    for (const f of features) {
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
    for (const f of features) {
      const raw = (f.properties as { category?: string | null } | null)?.category;
      if (raw === "raster_pixel") continue;
      const category = raw && raw.trim() !== "" ? raw : "uncategorized";
      if (!colorMap.has(category)) colorMap.set(category, colorForCategory(category));
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    const colorExpr = buildCategoryColorExpression(colorMap);
    if (map.getLayer(LAYER_POINTS)) map.setPaintProperty(LAYER_POINTS, "circle-color", withPointVerificationColor(colorExpr));
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
    // While an AI Detection mode owns the map, the detection effect below
    // drives layer visibility by canonical class; this manual-checklist
    // filter must not fight it, so stand down in that case.
    if (detectionMode) return;
    const hiddenForBase = selectedVisualizationFeatures.length > 0
      ? new Set(selectedVisualizationCompositeIds)
      : new Set<string>();
    if (map.getLayer(LAYER_POLY_FILL)) map.setFilter(LAYER_POLY_FILL, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_POLY_OUTLINE)) map.setFilter(LAYER_POLY_OUTLINE, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_LINES)) map.setFilter(LAYER_LINES, withFeatureVisibility(LINE_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_POINTS)) map.setFilter(LAYER_POINTS, withFeatureVisibility(POINT_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_PHOTOS)) map.setFilter(LAYER_PHOTOS, withFeatureVisibility(PHOTO_BASE_FILTER, hiddenCategories, hiddenForBase));

    // The selected geometry is rendered in a dedicated overlay. It must obey
    // the same Category Visibility controls as the shared/base layers so both
    // individual category toggles and Hide all work consistently.
    const noHiddenVisualizationLayers = new Set<string>();
    if (map.getLayer(VIZ_SELECTED_POLY_FILL)) map.setFilter(VIZ_SELECTED_POLY_FILL, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, noHiddenVisualizationLayers));
    if (map.getLayer(VIZ_SELECTED_POLY_OUTLINE)) map.setFilter(VIZ_SELECTED_POLY_OUTLINE, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, noHiddenVisualizationLayers));
    if (map.getLayer(VIZ_SELECTED_LINES)) map.setFilter(VIZ_SELECTED_LINES, withFeatureVisibility(LINE_BASE_FILTER, hiddenCategories, noHiddenVisualizationLayers));
    if (map.getLayer(VIZ_SELECTED_POINTS)) map.setFilter(VIZ_SELECTED_POINTS, withFeatureVisibility(POINT_BASE_FILTER, hiddenCategories, noHiddenVisualizationLayers));
  }, [mapReady, hiddenCategories, detectionMode, selectedVisualizationCompositeIds, selectedVisualizationFeatures.length]);

  // Publish the selected source layer into its own viewport-scoped overlay.
  // Large datasets such as AMRUT exceed the normal 5,000-feature base snapshot;
  // this dedicated source guarantees that the selected layer is actually loaded
  // and that opacity/size/width changes are visible immediately.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(VIZ_SELECTED_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;

    const features = selectedVisualizationFeatures.map((raw) => {
      const properties = (raw.properties ?? {}) as Record<string, unknown>;
      const attributes = (properties.attributes ?? {}) as Record<string, unknown>;
      const value = visualizationField ? attributes[visualizationField] : null;
      return {
        ...raw,
        properties: {
          ...properties,
          [VIZ_VALUE_PROP]: value,
          [VIZ_MISSING_PROP]: visualizationField ? isMissingVisualizationValue(value) : false,
        },
      } as GeoJSON.Feature;
    });

    source.setData({ type: "FeatureCollection", features });
  }, [mapReady, selectedVisualizationFeatures, visualizationField]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const baseColor = buildCategoryColorExpression(colorByCategoryRef.current);
    let selectedColor: maplibregl.ExpressionSpecification | string = baseColor;

    if (visualizationMode === "category" && visualizationField) {
      const pairs: Array<string> = [];
      for (const item of visualizationPreview.categories) pairs.push(item.value, item.color);
      selectedColor = pairs.length > 0
        ? [
            "match",
            ["to-string", ["coalesce", ["get", VIZ_VALUE_PROP], "Missing"]],
            ...pairs,
            "#94a3b8",
          ] as unknown as maplibregl.ExpressionSpecification
        : "#94a3b8";
    } else if (visualizationMode === "numeric" && visualizationField) {
      const min = visualizationPreview.numericMin;
      const max = visualizationPreview.numericMax;
      if (min !== null && max !== null) {
        selectedColor = min === max
          ? "#22c55e"
          : [
              "case",
              ["==", ["get", VIZ_MISSING_PROP], true],
              "#64748b",
              [
                "interpolate",
                ["linear"],
                ["to-number", ["get", VIZ_VALUE_PROP], min],
                min, "#2563eb",
                min + (max - min) / 2, "#f59e0b",
                max, "#ef4444",
              ],
            ] as unknown as maplibregl.ExpressionSpecification;
      } else {
        selectedColor = "#64748b";
      }
    } else if (visualizationMode === "missing-data" && visualizationField) {
      selectedColor = [
        "case",
        ["==", ["get", VIZ_MISSING_PROP], true],
        "#ef4444",
        "#22c55e",
      ] as unknown as maplibregl.ExpressionSpecification;
    }

    const selectedPointRadius = Math.max(2, visualizationPointSize);

    // Restore the normal shared layers. The selected source layer is removed
    // from these layers by the filter effect and rendered only by the overlay.
    if (map.getLayer(LAYER_POINTS)) {
      map.setPaintProperty(LAYER_POINTS, "circle-color", withPointVerificationColor(baseColor));
      map.setPaintProperty(LAYER_POINTS, "circle-radius", 3.5);
      map.setPaintProperty(LAYER_POINTS, "circle-opacity", 0.9);
    }
    if (map.getLayer(LAYER_LINES)) {
      map.setPaintProperty(LAYER_LINES, "line-color", baseColor);
      map.setPaintProperty(LAYER_LINES, "line-width", 2.5);
      map.setPaintProperty(LAYER_LINES, "line-opacity", 1);
    }
    const drainsAiActive = aiOverlayEnabled && detectionMode === "drains";
    if (map.getLayer(LAYER_POLY_FILL) && !drainsAiActive) {
      map.setPaintProperty(LAYER_POLY_FILL, "fill-color", baseColor);
      map.setPaintProperty(LAYER_POLY_FILL, "fill-opacity", DEFAULT_FILL_OPACITY);
    }
    if (map.getLayer(LAYER_POLY_OUTLINE)) {
      map.setPaintProperty(LAYER_POLY_OUTLINE, "line-width", 1);
      map.setPaintProperty(LAYER_POLY_OUTLINE, "line-opacity", 1);
    }

    if (map.getLayer(VIZ_SELECTED_POINTS)) {
      map.setPaintProperty(VIZ_SELECTED_POINTS, "circle-color", withPointVerificationColor(selectedColor));
      map.setPaintProperty(VIZ_SELECTED_POINTS, "circle-radius", selectedPointRadius);
      map.setPaintProperty(VIZ_SELECTED_POINTS, "circle-opacity", visualizationOpacity);
    }
    if (map.getLayer(VIZ_SELECTED_LINES)) {
      map.setPaintProperty(VIZ_SELECTED_LINES, "line-color", selectedColor);
      map.setPaintProperty(VIZ_SELECTED_LINES, "line-width", visualizationLineWidth);
      map.setPaintProperty(VIZ_SELECTED_LINES, "line-opacity", visualizationOpacity);
    }
    if (map.getLayer(VIZ_SELECTED_POLY_FILL)) {
      map.setPaintProperty(VIZ_SELECTED_POLY_FILL, "fill-color", selectedColor);
      map.setPaintProperty(VIZ_SELECTED_POLY_FILL, "fill-opacity", visualizationOpacity);
    }
    if (map.getLayer(VIZ_SELECTED_POLY_OUTLINE)) {
      map.setPaintProperty(VIZ_SELECTED_POLY_OUTLINE, "line-color", selectedColor);
      map.setPaintProperty(VIZ_SELECTED_POLY_OUTLINE, "line-width", Math.max(1, visualizationLineWidth * 0.55));
      map.setPaintProperty(VIZ_SELECTED_POLY_OUTLINE, "line-opacity", visualizationOpacity);
    }
  }, [
    aiOverlayEnabled, detectionMode, mapReady, visualizationField,
    visualizationLineWidth, visualizationMode, visualizationOpacity,
    visualizationPointSize, visualizationPreview,
  ]);

  const toggleCategoryVisibility = useCallback((category: string) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const toggleExtraVisibleCategory = useCallback((category: string) => {
    setExtraVisibleCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const setAllExtraVisibleCategories = useCallback((categories: string[]) => {
    setExtraVisibleCategories(new Set(categories));
  }, []);

  // Fresh slate every time a detection mode is entered or left, so an extra
  // category picked while in Poles mode doesn't linger into Manholes mode.
  useEffect(() => {
    setExtraVisibleCategories(new Set());
  }, [detectionMode]);

  const setAllCategoriesVisible = useCallback((visible: boolean) => {
    setHiddenCategories(visible ? new Set() : new Set(categoryStats.map((c) => c.category)));
  }, [categoryStats]);

  // Batched visibility update for a subset of categories (used by the
  // geometry-group checkbox). Reuses the exact same single-source-of-truth
  // state as the individual layer checkboxes — `hiddenCategories` in the
  // normal map and `extraVisibleCategories` in a detection mode — so a
  // group toggle never forks into parallel state.
  const setCategoriesVisible = useCallback((categories: string[], visible: boolean) => {
    if (detectionMode) {
      setExtraVisibleCategories((prev) => {
        const next = new Set(prev);
        for (const category of categories) {
          if (DETECTION_MODE_TARGET_CLASSES[detectionMode].includes(classMap[category])) continue;
          if (visible) next.add(category);
          else next.delete(category);
        }
        return next;
      });
    } else {
      setHiddenCategories((prev) => {
        const next = new Set(prev);
        for (const category of categories) {
          if (visible) next.delete(category);
          else next.add(category);
        }
        return next;
      });
    }
  }, [detectionMode, classMap]);

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
    const rasterSettings = effectiveRasterSettings(dataset, rasterSettingsRef.current[dataset.id]);
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

  // Drapes the dataset's actual OBJ mesh onto the map at its real
  // georeferenced location (see Obj3DMapLayer) instead of only offering a
  // disconnected full-screen viewer. three.js is dynamically imported here
  // so it's never fetched unless a 3D dataset is actually toggled on.
  const removeObj3DLayer = useCallback((datasetId: string) => {
    obj3dLayersRef.current.delete(datasetId);
    const map = mapRef.current;
    if (!map) return;
    const layerId = obj3dLayerId(datasetId);
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }, []);

  const hideObj3DLayer = useCallback((datasetId: string) => {
    const map = mapRef.current;
    if (!map) return;
    const layerId = obj3dLayerId(datasetId);
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", "none");
    }
  }, []);

  const addObj3DLayer = useCallback(async (dataset: DatasetRow, bounds: DatasetBounds) => {
    const map = mapRef.current;
    if (!map || !isObjDataset(dataset)) return;
    obj3dLayersRef.current.add(dataset.id);
    const layerId = obj3dLayerId(dataset.id);
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", "visible");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/v1/datasets/${dataset.id}/raw-file`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = await res.text();
      // The dataset may have been deselected (or the map torn down) while
      // the fetch/parse of a large mesh was still in flight.
      if (!obj3dLayersRef.current.has(dataset.id)) return;
      const currentMap = mapRef.current;
      if (!currentMap) return;
      if (currentMap.getLayer(layerId)) {
        currentMap.setLayoutProperty(layerId, "visibility", "visible");
        return;
      }
      const { Obj3DMapLayer } = await import("./Obj3DMapLayer");
      const mtlFilename = dataset.dataset_metadata?.model_assets?.mtl_filename;
      // Same beforeId as addRasterOverlay: keeps draped mesh/shading layers
      // (OBJ, DSM, DTM) under the vector feature layers (markers, buildings,
      // AI highlights) instead of painting over them.
      currentMap.addLayer(new Obj3DMapLayer(layerId, text, bounds, dataset.id, mtlFilename), LAYER_POLY_FILL);
    } catch (e) {
      setFlyError(`Could not load 3D model on map: ${(e as Error).message}`);
    }
  }, []);

  const clearAllObj3DLayers = useCallback(() => {
    for (const id of Array.from(obj3dLayersRef.current)) removeObj3DLayer(id);
  }, [removeObj3DLayer]);

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
    const dataset = datasets.find((row) => row.id === datasetId);
    // DSM/DTM are locked to Enhanced at the rendering layer — any incoming
    // patch (including stale/incompatible values) is coerced, never stored
    // as RGB/Grayscale for an elevation raster.
    const nextSettings = dataset
      ? effectiveRasterSettings(dataset, { ...rasterSettingsRef.current[datasetId], ...patch })
      : resolveRasterSettings({ ...rasterSettingsRef.current[datasetId], ...patch });
    const previousSettings = resolveRasterSettings(rasterSettingsRef.current[datasetId]);
    rasterSettingsRef.current = { ...rasterSettingsRef.current, [datasetId]: nextSettings };
    setRasterSettingsById(rasterSettingsRef.current);
    if (
      previousSettings.colorMode !== nextSettings.colorMode &&
      rasterLayersRef.current.has(datasetId)
    ) {
      if (dataset) addRasterOverlay(dataset);
    }
    applyRasterDisplaySettings(datasetId, nextSettings);
  }, [addRasterOverlay, applyRasterDisplaySettings, datasets]);

  // Restores a dataset selection that was persisted by the parent (e.g.
  // the user picked a dataset, switched to the Datasets/Analytics tab,
  // then came back to Map) — re-applies the raster overlay(s) and scopes
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
    // persisted id list itself changes — not on every addRasterOverlay
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
  }, [activeDatasetIds, refreshToken]);

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
        properties: { id: a.id, color: a.color, anomaly_type: a.anomaly_type, status: a.status },
      })),
    });
  }, [mapReady, anomalies]);

  // Push the current manhole-recommend answer's routes into their own map
  // source whenever the answer changes (including clearing to [] on close).
  //
  // Dedup strategy — segment-level union:
  //   Two manholes rarely share the *exact* same line, but many edges route
  //   along the SAME road segments (several manholes converge on a common
  //   downstream node, so their paths overlap on the shared approach). That
  //   overlap is what renders as "parallel / double lines". Pair-key dedup
  //   can't catch it, so instead we walk every route as a sequence of small
  //   directed segments and only ever draw each UNDIRECTED segment once. The
  //   first route to claim a segment keeps it; later routes that re-trace it
  //   simply skip that segment (the earlier route already covers it on the
  //   map). Confirmed-flow edges are processed first so they own the shared
  //   "trunk" segments and the arrows stay correct. The result: every road
  //   segment is painted exactly once — no duplicate lines.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const src = map.getSource(MANHOLE_ROUTES_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    const routes = manholeRecommendAnswer?.routes ?? [];

    // Priority: confirmed-flow edges first (they own shared trunk segments
    // and keep their arrows), then longer edges (trunks) before short spurs.
    const ordered = [...routes].sort((a, b) => {
      const ac = a.flow_confirmed ? 1 : 0;
      const bc = b.flow_confirmed ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return (b.coordinates?.length ?? 0) - (a.coordinates?.length ?? 0);
    });

    // Coordinate snapping to a coarse ~3m grid. Two paths that run 1-3m apart
    // for a shared stretch (e.g. two genuine edges sharing a hub manhole and
    // converging on the same corridor, computed independently and snapped to
    // slightly different road points) collapse onto the same lattice grid, so
    // their segments resolve to identical keys and merge into ONE drawn line
    // instead of rendering as near-parallel duplicates. Snapping every
    // coordinate *before* segmenting also handles the case where the two paths
    // have different point densities — their consecutive-segment endpoints will
    // now coincide on the grid regardless.
    const GRID = 0.00006; // ~3m at typical latitudes
    const snap = (v: number): number => Math.round(v / GRID) * GRID;
    const snapPt = (p: number[]): [number, number] => [snap(p[0]), snap(p[1])];
    const segKey = (a: number[], b: number[]): string => {
      const ra = `${a[0].toFixed(5)},${a[1].toFixed(5)}`;
      const rb = `${b[0].toFixed(5)},${b[1].toFixed(5)}`;
      return ra < rb ? `${ra}|${rb}` : `${rb}|${ra}`;
    };
    // Two snapped points count as the SAME node if they share a grid cell.
    const sameNode = (a: number[], b: number[]): boolean =>
      a[0] === b[0] && a[1] === b[1];

    const drawn = new Set<string>();
    const features: GeoJSON.Feature[] = [];

    for (const route of ordered) {
      const raw = route.coordinates;
      if (!raw || raw.length < 2) continue;

      // 1) Snap every coordinate to the grid, then collapse consecutive
      //    duplicate grid-nodes (this removes a single route's own tiny
      //    zig-zag / double-back so one path never renders as two lines).
      const snapped: number[][] = [];
      for (const p of raw) {
        const s = snapPt(p);
        const last = snapped[snapped.length - 1];
        if (!last || !sameNode(last, s)) snapped.push(s);
      }
      if (snapped.length < 2) continue;

      // Group consecutive UN-drawn segments into contiguous runs so the
      // dashed line style stays continuous; a drawn (shared) segment becomes
      // a gap that the owning route already covers.
      let run: number[][] = [snapped[0]];
      const flush = () => {
        if (run.length >= 2) {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: run },
            properties: {
              from_id: route.from_id,
              to_id: route.to_id,
              flow_confirmed: route.flow_confirmed ?? false,
            },
          } as GeoJSON.Feature);
        }
        run = [];
      };

      let prev = snapped[0];
      run = [prev];
      for (let i = 1; i < snapped.length; i++) {
        const cur = snapped[i];
        const key = segKey(prev, cur);
        if (drawn.has(key)) {
          flush();          // gap: start a fresh run after the shared segment
          run = [cur];
        } else {
          drawn.add(key);
          run.push(cur);
        }
        prev = cur;
      }
      flush();
    }

    src.setData({ type: "FeatureCollection", features });
  }, [mapReady, manholeRecommendAnswer]);

  // Push the current manhole-recommend answer's proposed manhole locations
  // (coverage gaps / disconnected manholes) into their own point layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const src = map.getSource(MANHOLE_POINTS_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    const locs = manholeRecommendAnswer?.needed_locations ?? [];
    src.setData({
      type: "FeatureCollection",
      features: locs.map((loc, idx) => ({
        type: "Feature",
        id: idx,
        geometry: { type: "Point", coordinates: [loc.lon, loc.lat] },
        properties: { id: loc.id, reason: loc.reason },
      })),
    });
  }, [mapReady, manholeRecommendAnswer]);

  // Push manholes with no real sewage/drain pipe within reach (network
  // mode) into their own point layer, so "not connected to the sewage
  // line" is a visible fact on the map, not just hidden absence of a line.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const src = map.getSource(MANHOLE_UNCONNECTED_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    const locs = manholeRecommendAnswer?.unconnected_manholes ?? [];
    src.setData({
      type: "FeatureCollection",
      features: locs.map((loc, idx) => ({
        type: "Feature",
        id: idx,
        geometry: { type: "Point", coordinates: [loc.lon, loc.lat] },
        properties: { id: loc.id, reason: loc.reason },
      })),
    });
  }, [mapReady, manholeRecommendAnswer]);

  // Keep the ref mirror in sync so applyFeatureCollection (a stable
  // useCallback) always reads the current mode on the next fetch.
  useEffect(() => { detectionModeRef.current = detectionMode; }, [detectionMode]);
  useEffect(() => { aiOverlayEnabledRef.current = aiOverlayEnabled; }, [aiOverlayEnabled]);
  useEffect(() => { classMapRef.current = classMap; }, [classMap]);

  // Primary feature id each anomaly type is "about", for the hover
  // tooltip's AI-detected lookup — pole rows carry every cluster member in
  // feature_ids, so "this_feature_id" (not feature_ids[0]) is the row's own
  // pole; drain/manhole rows are keyed by their metadata id for the same
  // reason (feature_ids[0] happens to already match those two, but reading
  // the explicit metadata field is the correct contract, not a coincidence).
  useEffect(() => {
    const byFeature: Record<string, SpatialAnomaly> = {};
    const byId: Record<string, SpatialAnomaly> = {};
    for (const anomaly of anomalies) {
      byId[anomaly.id] = anomaly;
      const primaryId = primaryFeatureIdForAnomaly(anomaly);
      if (primaryId) byFeature[primaryId] = anomaly;
    }
    anomalyByFeatureIdRef.current = byFeature;
    anomalyByIdRef.current = byId;
  }, [anomalies]);

  // Entering/leaving a detection mode drives which asset family is visible —
  // this OVERRIDES the manual Layers checklist while a mode is active (a
  // focused AI view is a bigger action than one checkbox). We filter the
  // point/line/polygon layers directly on each feature's authoritative
  // `canonical_class` attribute so ONLY the mode's asset family shows, no
  // matter which datasets are loaded or how complete the class map is.
  // Photos are left untouched (they're reference imagery, useful context).
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (!detectionMode) {
      // Hand control back to the manual checklist filter.
      setHiddenCategories(new Set());
      return;
    }
    const allowed = DETECTION_MODE_TARGET_CLASSES[detectionMode];
    if (map.getLayer(LAYER_POLY_FILL)) map.setFilter(LAYER_POLY_FILL, withCanonicalVisibility(POLY_BASE_FILTER, allowed, extraVisibleCategories));
    if (map.getLayer(LAYER_POLY_OUTLINE)) map.setFilter(LAYER_POLY_OUTLINE, withCanonicalVisibility(POLY_BASE_FILTER, allowed, extraVisibleCategories));
    if (map.getLayer(LAYER_LINES)) map.setFilter(LAYER_LINES, withCanonicalVisibility(LINE_BASE_FILTER, allowed, extraVisibleCategories));
    if (map.getLayer(LAYER_POINTS)) map.setFilter(LAYER_POINTS, withCanonicalVisibility(POINT_BASE_FILTER, allowed, extraVisibleCategories));
    // LAYER_PHOTOS is intentionally left as-is so geotagged evidence stays visible.
  }, [mapReady, detectionMode, extraVisibleCategories]);

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

    const buildingColors: Record<string, "red" | "yellow" | "blue"> = {};
    const buildingAnomalyIds: Record<string, string> = {};
    for (const a of anomalies) {
      if (a.anomaly_type !== "drain_encroachment") continue;
      const buildingId = a.feature_ids[0];
      if (buildingId) {
        buildingColors[buildingId] = a.status === "resolved" ? "blue" : a.color === "red" ? "red" : "yellow";
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

  // Marks "the user asked for the one-time Spatial Audit" — synchronous, so
  // rapid repeated icon clicks can only ever set this true once in effect;
  // the actual run is gated separately (see the effect above) on
  // spatialAuditExecutedRef, which this deliberately does not touch.
  const requestSpatialAuditOnce = useCallback(() => {
    spatialAuditRequestedRef.current = true;
  }, [spatialAuditRequestedRef]);

  // The Data Sources panel is explicitly multi-select ("multiple can be
  // shown together"), so the audit must run for every currently-active
  // dataset, not just the first one — otherwise a second/duplicate dataset
  // toggled on alongside an already-audited one silently never gets its
  // own spatial_anomalies rows (AI Detection then looks "broken" for it,
  // when really its audit was simply never triggered).
  const runAudit = useCallback(async (datasetIds: string[]): Promise<boolean> => {
    if (datasetIds.length === 0) return true;
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
    if (failures.length > 0) {
      console.error("Spatial Audit failed", failures);
    }
    return failures.length === 0;
  }, []);

  // Fires once per fresh app load, on the first AI Detection icon click —
  // see WorkspaceLayout for why the guard refs live outside this component.
  // `spatialAuditRequestedRef` is set synchronously on that click; this
  // effect is what actually runs the (reused, unmodified) audit function
  // once a dataset is active, so a click before any dataset is selected
  // isn't wasted and doesn't need a second click to take effect.
  const hasActiveDatasets = activeDatasetIds.length > 0;
  useEffect(() => {
    if (!spatialAuditRequestedRef.current || spatialAuditExecutedRef.current) return;
    if (!hasActiveDatasets) return;
    spatialAuditExecutedRef.current = true;
    onSpatialAuditStatusChange("running");
    void runAudit(activeDatasetIds).then((ok) => {
      onSpatialAuditStatusChange(ok ? "success" : "error");
    });
  }, [hasActiveDatasets, activeDatasetIds, runAudit, onSpatialAuditStatusChange, spatialAuditRequestedRef, spatialAuditExecutedRef]);

  const runManholeFeatureRecommend = useCallback(async (datasetId: string, featureId: string) => {
    setManholeFeatureOpen(true);
    setManholeFeatureLoading(true);
    setManholeFeatureError(null);
    setManholeFeatureAnswer(null);
    try {
      const answer = await aiManholeRecommend({ mode: "feature", dataset_id: datasetId, feature_id: featureId });
      setManholeFeatureAnswer(answer);
    } catch (e) {
      setManholeFeatureError((e as Error).message);
    } finally {
      setManholeFeatureLoading(false);
    }
  }, []);

  const closeManholeFeature = useCallback(() => {
    setManholeFeatureOpen(false);
    setManholeFeatureAnswer(null);
    setManholeFeatureError(null);
  }, []);

  const runManholeNetwork = useCallback(async (datasetIds: string[]) => {
    if (datasetIds.length === 0) return;
    setManholeRecommendOpen(true);
    setManholeRecommendLoading(true);
    setManholeRecommendError(null);
    setManholeRecommendAnswer(null);
    try {
      const answer = await aiManholeRecommend({ mode: "network", dataset_id: datasetIds[0] });
      setManholeRecommendAnswer(answer);
    } catch (e) {
      setManholeRecommendError((e as Error).message);
    } finally {
      setManholeRecommendLoading(false);
    }
  }, []);

  const closeManholeRecommend = useCallback(() => {
    setManholeRecommendOpen(false);
    setManholeRecommendAnswer(null);
    setManholeRecommendError(null);
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
  // replacing it — so a raster orthophoto and its companion GDB vector
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
      if (isObjDataset(dataset)) {
        hideObj3DLayer(dataset.id);
      } else {
        removeObj3DLayer(dataset.id);
      }
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
      if (isObjDataset(dataset)) {
        // Tilt into a 3/4 view so the newly-draped mesh actually reads as
        // a 3D model instead of a flat top-down footprint.
        map.setPitch(58);
        map.setBearing(-18);
      }
      map.fitBounds([[b.min_lon, b.min_lat], [b.max_lon, b.max_lat]], { padding: 80, duration: 1000, maxZoom: 18 });
      if (isObjDataset(dataset)) void addObj3DLayer(dataset, b);
    } catch (e) { setFlyError((e as Error).message); }
  }, [activeDatasetIds, datasets, filter, scheduleFetch, addRasterOverlay, removeRasterOverlay, addObj3DLayer, removeObj3DLayer, hideObj3DLayer, onActiveDatasetsChange]);

  const clearAllDatasets = useCallback(() => {
    setActiveDatasetIds([]);
    setExpandedDatasetId(null);
    filterRef.current = filter;
    clearAllRasterOverlays();
    clearAllObj3DLayers();
    onActiveDatasetsChange?.([]);
    scheduleFetch();
  }, [filter, scheduleFetch, clearAllRasterOverlays, clearAllObj3DLayers, onActiveDatasetsChange]);

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
    }),
    [clearAllDatasets]
  );

  useEffect(() => {
    // Only a *real* ward/category/severity constraint should override an
    // active dataset selection — clicking Apply/Reset with everything left
    // at "all wards"/"all categories"/blank severity is a no-op and must
    // not silently clear the dataset(s) currently shown on the map. A real
    // constraint, though, is an explicit signal to leave dataset isolation
    // and go back to the global filtered view for the vector FEATURES —
    // otherwise a stale dataset selection could silently AND-combine with
    // it into an empty/wrong result.
    //
    // A raster image overlay is NOT a filterable feature, though — it's a
    // visual backdrop with no ward/category/severity of its own — so it
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
    // but must not retrigger this effect on their own — dataset-selection
    // changes are already handled directly by
    // toggleDataset/clearAllDatasets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => { if (!mapReady || refreshToken === 0) return; scheduleFetch(); }, [mapReady, refreshToken, scheduleFetch]);
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
      // stop looking sharp — 20 was capping that closer inspection even
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
        // grid (kept for the feature table / severity / AI summary) — the
        // actual image overlay already shows the raster visually, so the
        // grid of dots on top of it would just be redundant clutter.
        // site_photo features get their own camera-icon symbol layer below
        // instead of a plain dot.
        filter: POINT_BASE_FILTER,
        paint: { "circle-radius": 3.5, "circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, "#3aa1ff", 0.5, "#f5c542", 1, "#ff5a3d"], "circle-stroke-color": "#0b1013", "circle-stroke-width": 1.5, "circle-opacity": 0.9 },
      });

      map.addLayer({
        id: REFERENCE_SURVEY_BUILDING_LABELS,
        type: "symbol",
        source: FEATURE_SOURCE,
        minzoom: 15,
        filter: [
          "all",
          POLY_BASE_FILTER,
          ["in", "building", ["downcase", ["coalesce", ["get", "category"], ""]]],
        ],
        layout: {
          visibility: "none",
          "text-field": [
            "coalesce",
            ["get", "building_name", ["get", "attributes"]],
            ["get", "BUILDING_NAME", ["get", "attributes"]],
            ["get", "name", ["get", "attributes"]],
            ["get", "Name", ["get", "attributes"]],
            ["get", "asset_name", ["get", "attributes"]],
            "",
          ],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 20, 12],
          "text-variable-anchor": ["center", "top", "bottom"],
          "text-radial-offset": 0.25,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#ecfeff",
          "text-halo-color": "#083344",
          "text-halo-width": 1.6,
        },
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

      map.addSource(VIZ_SELECTED_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: VIZ_SELECTED_POLY_FILL,
        type: "fill",
        source: VIZ_SELECTED_SOURCE,
        filter: POLY_BASE_FILTER,
        paint: { "fill-color": "#14b8a6", "fill-opacity": 0.85 },
      });
      map.addLayer({
        id: VIZ_SELECTED_POLY_OUTLINE,
        type: "line",
        source: VIZ_SELECTED_SOURCE,
        filter: POLY_BASE_FILTER,
        paint: { "line-color": "#14b8a6", "line-width": 2, "line-opacity": 0.85 },
      });
      map.addLayer({
        id: VIZ_SELECTED_LINES,
        type: "line",
        source: VIZ_SELECTED_SOURCE,
        filter: LINE_BASE_FILTER,
        paint: { "line-color": "#14b8a6", "line-width": 3, "line-opacity": 0.85 },
      });
      map.addLayer({
        id: VIZ_SELECTED_POINTS,
        type: "circle",
        source: VIZ_SELECTED_SOURCE,
        filter: POINT_BASE_FILTER,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 12, 8, 16, 12],
          "circle-color": "#14b8a6",
          "circle-opacity": 0.85,
          "circle-stroke-color": "#07141c",
          "circle-stroke-width": 1.2,
        },
      });

      const BASE_CLICKABLE = [
        VIZ_SELECTED_POINTS, VIZ_SELECTED_LINES, VIZ_SELECTED_POLY_FILL,
        LAYER_POINTS, LAYER_LINES, LAYER_POLY_FILL, LAYER_PHOTOS,
      ];
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

      // AI Manhole Recommendation Engine — proposed/rehab pipe routes.
      map.addSource(MANHOLE_ROUTES_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_MANHOLE_ROUTES,
        type: "line",
        source: MANHOLE_ROUTES_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": MANHOLE_ROUTE_COLOR,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 18, 6],
          "line-dasharray": [0.2, 1.5],
        },
      });
      // Flow-direction arrows drawn along each route line, only where the
      // direction is actually grounded in real elevation evidence
      // (flow_confirmed) — an unconfirmed route still shows as a plain line,
      // never with an arrow asserting a direction we don't have evidence for.
      if (!map.hasImage(FLOW_ARROW_ICON_ID)) {
        map.addImage(FLOW_ARROW_ICON_ID, buildFlowArrowImageData(), { pixelRatio: 2 });
      }
      map.addLayer({
        id: LAYER_MANHOLE_FLOW_ARROWS,
        type: "symbol",
        source: MANHOLE_ROUTES_SOURCE,
        filter: ["==", ["get", "flow_confirmed"], true],
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 60,
          "icon-image": FLOW_ARROW_ICON_ID,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 18, 1.1],
          "icon-rotation-alignment": "map",
          "icon-keep-upright": false,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });

      // AI Manhole Recommendation Engine — proposed new manhole locations
      // (coverage gaps / disconnected manholes), drawn as points on top.
      map.addSource(MANHOLE_POINTS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_MANHOLE_POINTS,
        type: "circle",
        source: MANHOLE_POINTS_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 6, 18, 11],
          "circle-color": MANHOLE_ROUTE_COLOR,
          "circle-stroke-color": "#0b1013",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.9,
        },
      });

      // AI Manhole Recommendation Engine — manholes with no real sewage/
      // drain pipe within reach. Drawn as a distinct ring rather than left
      // silently unconnected, so it reads as "flagged" rather than "missing".
      map.addSource(MANHOLE_UNCONNECTED_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_MANHOLE_UNCONNECTED,
        type: "circle",
        source: MANHOLE_UNCONNECTED_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 18, 14],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": MANHOLE_UNCONNECTED_COLOR,
          "circle-stroke-width": 3,
        },
      });

      map.on("mousemove", LAYER_MANHOLE_UNCONNECTED, (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER_MANHOLE_UNCONNECTED] });
        if (!hit.length) return;
        map.getCanvas().style.cursor = "pointer";
        const reason = (hit[0].properties?.reason as string | undefined) ?? "Not connected to the sewage line";
        setHover({
          x: e.point.x,
          y: e.point.y,
          label: "Unconnected Manhole",
          category: "Not connected to sewage line",
          severity: 1,
          color: MANHOLE_UNCONNECTED_COLOR,
          attributes: { reason },
        });
      });
      map.on("mouseleave", LAYER_MANHOLE_UNCONNECTED, () => {
        map.getCanvas().style.cursor = "";
        setHover(null);
      });

      map.on("click", LAYER_ANOMALIES, (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER_ANOMALIES] });
        if (!hit.length) return;
        const id = hit[0].properties?.id as string | undefined;
        if (!id) return;

        const anomaly = anomalyByIdRef.current[id];
        const activeMode = detectionModeRef.current;
        const context = aiOverlayEnabledRef.current
          ? aiVerificationContextForAnomaly(anomaly, activeMode)
          : null;
        const primaryFeatureId = anomaly ? primaryFeatureIdForAnomaly(anomaly) : null;

        // Preserve the previous AI UI: Poles/Drains still open the AI Alert
        // card; Manholes still use their richer recommendation card.
        if (activeMode !== "manholes") setSelectedAnomalyId(id);
        if (!context || !primaryFeatureId) return;

        aiAnomalyClickConsumedRef.current = true;
        window.requestAnimationFrame(() => { aiAnomalyClickConsumedRef.current = false; });
        void fetchFeatureById(primaryFeatureId)
          .then((feature) => {
            onFeatureSelect(feature, context);
            if (context.detectionMode === "manholes" && feature.properties.dataset_id) {
              setManholeRecommendOpen(false);
              void runManholeFeatureRecommend(feature.properties.dataset_id, feature.properties.id);
            }
          })
          .catch(() => {});
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
        if (placemarkModeRef.current || streetPickModeRef.current || streetPickConsumedRef.current || aiAnomalyClickConsumedRef.current || isMeasureInputActive()) return;
        const hit = map.queryRenderedFeatures(e.point, { layers: ALL_CLICKABLE });
        if (!hit.length) return;
        const isAi = AI_CLICKABLE.includes(hit[0].layer?.id as string);
        const base = isAi ? hit.find((f) => BASE_CLICKABLE.includes(f.layer?.id as string)) : hit[0];
        const selected = decodeFeature(base ?? hit[0]);
        const activeMode = detectionModeRef.current;
        const selectedAnomaly = aiOverlayEnabledRef.current && activeMode
          ? anomalyByFeatureIdRef.current[selected.properties.id]
          : undefined;
        const verificationContext = aiOverlayEnabledRef.current
          ? aiVerificationContextForAnomaly(selectedAnomaly, activeMode)
          : null;
        if (aiOverlayEnabledRef.current && activeMode === "drains") {
          const anomalyId = buildingAnomalyIdMapRef.current[selected.properties.id];
          if (anomalyId) {
            setSelectedAnomalyId(anomalyId);
            if (verificationContext) onFeatureSelect(selected, verificationContext);
            return;
          }
        }
        if (
          aiOverlayEnabledRef.current &&
          detectionModeRef.current === "manholes" &&
          classMapRef.current[selected.properties.category ?? ""] === "Access_Point" &&
          selected.properties.dataset_id
        ) {
          // The real pipe-suggestion card (material/diameter/RL/slope/route)
          // — kept in its OWN state (manholeFeatureAnswer), never touching
          // manholeRecommendAnswer/routes, so a "Full Drainage Network"
          // already drawn on the map stays exactly as-is. Same courtesy as
          // Poles/Drains: only hide the network SUMMARY PANEL (not its
          // data) so the two cards don't visually stack in the same corner.
          setManholeRecommendOpen(false);
          if (verificationContext) onFeatureSelect(selected, verificationContext);
          void runManholeFeatureRecommend(selected.properties.dataset_id, selected.properties.id);
          return;
        }
        if (selected.properties.category === "site_photo") {
          setPhotoViewer({
            url: `${API_BASE}/api/v1/features/${selected.properties.id}/photo`,
            label: selected.properties.label || "Site photo",
            isPanorama: selected.properties.attributes?.is_360 === true,
          });
          return;
        }
        onFeatureSelect(selected, verificationContext);
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
        if (placemarkModeRef.current || streetPickModeRef.current || isMeasureInputActive()) { setHover(null); return; }
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
        const aiSummary = anomalyForFeature ? summarizeAnomalyForTooltip(anomalyForFeature) : undefined;
        setHover({
          x: e.point.x,
          y: e.point.y,
          label: decoded.properties.label || "-",
          category,
          severity: decoded.properties.severity,
          color: aiSummary ? ANOMALY_BADGE_COLOR[aiSummary.color] : colorForCategory(category),
          attributes: decoded.properties.attributes,
          aiStatus,
          aiDetection: aiSummary,
          verification: verificationSummaryFromAttributes(decoded.properties.attributes),
        });
      };
      // Named (not inline-anonymous) so the cursor is never fought: while
      // measuring, syncMeasureCursor() owns canvas.style.cursor (crosshair),
      // and these handlers must not overwrite it with "pointer"/"" just
      // because the mouse crossed a feature underneath the measurement layer.
      const handleFeatureMouseEnter = () => {
        if (placemarkModeRef.current || streetPickModeRef.current) { map.getCanvas().style.cursor = "crosshair"; return; }
        if (isMeasureInputActive()) return;
        map.getCanvas().style.cursor = "pointer";
      };
      const handleFeatureMouseLeave = () => {
        if (placemarkModeRef.current || streetPickModeRef.current) { map.getCanvas().style.cursor = "crosshair"; setHover(null); return; }
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
        if (placemarkModeRef.current || streetPickModeRef.current || streetPickConsumedRef.current || !measureActiveRef.current) return;
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
      placemarkPreviewMarkerRef.current?.remove();
      placemarkPreviewMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MapLibre's own `trackResize` only reacts to the window's resize event,
  // not to its container div changing size on its own (e.g. the sidebar
  // being dragged wider/narrower) — without this, the canvas keeps its old
  // dimensions until the window itself is resized. A ResizeObserver on the
  // container is the direct, self-contained fix: it doesn't care *why* the
  // container changed size, so it also covers any future resizable-layout
  // change, not just this one.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !mapReady || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => mapRef.current?.resize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const placemarkImages: Array<[string, string]> = [
      [PLACEMARK_ICON_IDS.pin, "#ef4444"],
      [PLACEMARK_ICON_IDS.star, "#f59e0b"],
      [PLACEMARK_ICON_IDS.flag, "#a855f7"],
      [PLACEMARK_ICON_IDS.survey, "#3b82f6"],
    ];
    for (const [imageId, color] of placemarkImages) {
      if (!map.hasImage(imageId)) {
        map.addImage(imageId, createPlacemarkPinImage(color), { pixelRatio: 2 });
      }
    }
    if (!map.getSource(PLACEMARK_SOURCE)) {
      map.addSource(PLACEMARK_SOURCE, {
        type: "geojson",
        data: placemarksToGeoJson(placemarksRef.current),
        promoteId: "id",
        cluster: true,
        clusterRadius: 52,
        clusterMaxZoom: 15,
      });
    }
    if (!map.getSource(PLACEMARK_FOCUS_SOURCE)) {
      map.addSource(PLACEMARK_FOCUS_SOURCE, {
        type: "geojson",
        data: placemarkFocusToGeoJson(placemarksRef.current, selectedPlacemarkId, hoveredPlacemarkId),
        promoteId: "id",
      });
    }
    if (!map.getLayer(PLACEMARK_CLUSTER_LAYER)) {
      map.addLayer({
        id: PLACEMARK_CLUSTER_LAYER,
        type: "circle",
        source: PLACEMARK_SOURCE,
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": ["step", ["get", "point_count"], 17, 10, 21, 30, 26],
          "circle-color": "#0f766e",
          "circle-stroke-color": "#99f6e4",
          "circle-stroke-width": 2,
          "circle-opacity": 0.92,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_CLUSTER_COUNT_LAYER)) {
      map.addLayer({
        id: PLACEMARK_CLUSTER_COUNT_LAYER,
        type: "symbol",
        source: PLACEMARK_SOURCE,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#ecfeff",
          "text-halo-color": "#042f2e",
          "text-halo-width": 1,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_HOVER_HALO_LAYER)) {
      map.addLayer({
        id: PLACEMARK_HOVER_HALO_LAYER,
        type: "circle",
        source: PLACEMARK_FOCUS_SOURCE,
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], "__none__"]],
        paint: {
          "circle-radius": 18,
          "circle-color": "rgba(250, 204, 21, 0.2)",
          "circle-stroke-color": "#fde047",
          "circle-stroke-width": 3,
          "circle-blur": 0.12,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_SELECTED_HALO_LAYER)) {
      map.addLayer({
        id: PLACEMARK_SELECTED_HALO_LAYER,
        type: "circle",
        source: PLACEMARK_FOCUS_SOURCE,
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], "__none__"]],
        paint: {
          "circle-radius": 17,
          "circle-color": "rgba(45, 212, 191, 0.16)",
          "circle-stroke-color": "#5eead4",
          "circle-stroke-width": 3,
          "circle-opacity": 0.75,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_HIT_LAYER)) {
      map.addLayer({
        id: PLACEMARK_HIT_LAYER,
        type: "circle",
        source: PLACEMARK_SOURCE,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 15, 12, 18, 18, 22],
          "circle-color": "rgba(255,255,255,0.001)",
          "circle-stroke-width": 0,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_LAYER)) {
      map.addLayer({
        id: PLACEMARK_LAYER,
        type: "symbol",
        source: PLACEMARK_SOURCE,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": PLACEMARK_ICON_EXPRESSION,
          "icon-size": 0.68,
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_HOVER_LAYER)) {
      map.addLayer({
        id: PLACEMARK_HOVER_LAYER,
        type: "symbol",
        source: PLACEMARK_FOCUS_SOURCE,
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], "__none__"]],
        layout: {
          "icon-image": PLACEMARK_ICON_EXPRESSION,
          "icon-size": 0.92,
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_SELECTED_LAYER)) {
      map.addLayer({
        id: PLACEMARK_SELECTED_LAYER,
        type: "symbol",
        source: PLACEMARK_FOCUS_SOURCE,
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], "__none__"]],
        layout: {
          "icon-image": PLACEMARK_ICON_EXPRESSION,
          "icon-size": 0.84,
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_LABEL_LAYER)) {
      map.addLayer({
        id: PLACEMARK_LABEL_LAYER,
        type: "symbol",
        source: PLACEMARK_SOURCE,
        minzoom: 13,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.15],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#f8fafc",
          "text-halo-color": "#0b1013",
          "text-halo-width": 1.4,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_HOVER_LABEL_LAYER)) {
      map.addLayer({
        id: PLACEMARK_HOVER_LABEL_LAYER,
        type: "symbol",
        source: PLACEMARK_FOCUS_SOURCE,
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], "__none__"]],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-offset": [0, 1.35],
          "text-anchor": "top",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#fff7c2",
          "text-halo-color": "#111827",
          "text-halo-width": 2,
        },
      });
    }
    if (!map.getLayer(PLACEMARK_SELECTED_LABEL_LAYER)) {
      map.addLayer({
        id: PLACEMARK_SELECTED_LABEL_LAYER,
        type: "symbol",
        source: PLACEMARK_FOCUS_SOURCE,
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], "__none__"]],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-offset": [0, 1.35],
          "text-anchor": "top",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#99f6e4",
          "text-halo-color": "#042f2e",
          "text-halo-width": 2,
        },
      });
    }

    // Always keep saved annotations above survey, AI and reference layers.
    for (const layerId of [
      PLACEMARK_HOVER_HALO_LAYER,
      PLACEMARK_SELECTED_HALO_LAYER,
      PLACEMARK_CLUSTER_LAYER,
      PLACEMARK_HIT_LAYER,
      PLACEMARK_LAYER,
      PLACEMARK_SELECTED_LAYER,
      PLACEMARK_HOVER_LAYER,
      PLACEMARK_LABEL_LAYER,
      PLACEMARK_SELECTED_LABEL_LAYER,
      PLACEMARK_HOVER_LABEL_LAYER,
      PLACEMARK_CLUSTER_COUNT_LAYER,
    ]) {
      if (map.getLayer(layerId)) map.moveLayer(layerId);
    }

    const hoverPopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: [0, -38],
      className: "placemark-hover-popup",
    });

    const clearHover = () => {
      hoverPopup.remove();
      setMapHoveredPlacemarkId(null);
    };

    const handlePlacemarkClick = (event: MapMouseEvent) => {
      const hit = map.queryRenderedFeatures(event.point, { layers: [PLACEMARK_HIT_LAYER] })[0];
      const id = String(hit?.properties?.id ?? "");
      const placemark = placemarksRef.current.find((item) => item.id === id);
      if (!placemark) return;
      placemarkSavedClickRef.current = true;
      window.requestAnimationFrame(() => { placemarkSavedClickRef.current = false; });
      setSelectedPlacemarkId(placemark.id);
      setPlacemarkDetailsId(placemark.id);
      event.originalEvent.stopPropagation();
    };

    const handlePlacemarkMove = (event: MapMouseEvent) => {
      if (!placemarkModeRef.current) map.getCanvas().style.cursor = "pointer";
      const hit = map.queryRenderedFeatures(event.point, { layers: [PLACEMARK_HIT_LAYER] })[0];
      const id = String(hit?.properties?.id ?? "");
      const placemark = placemarksRef.current.find((item) => item.id === id);
      if (!placemark) {
        clearHover();
        return;
      }

      setMapHoveredPlacemarkId(placemark.id);

      const card = document.createElement("div");
      card.className = "placemark-hover-card";
      const name = document.createElement("strong");
      name.textContent = placemark.name;
      const meta = document.createElement("span");
      meta.textContent = placemark.category || "Saved placemark";
      card.append(name, meta);
      hoverPopup
        .setDOMContent(card)
        .setLngLat([placemark.longitude, placemark.latitude])
        .addTo(map);
    };

    const handlePlacemarkLeave = () => {
      map.getCanvas().style.cursor = placemarkModeRef.current ? "crosshair" : "";
      clearHover();
    };

    const handleClusterClick = (event: MapMouseEvent) => {
      const hit = map.queryRenderedFeatures(event.point, { layers: [PLACEMARK_CLUSTER_LAYER] })[0];
      const clusterId = Number(hit?.properties?.cluster_id);
      const coordinates = hit?.geometry.type === "Point" ? hit.geometry.coordinates : null;
      if (!Number.isFinite(clusterId) || !coordinates) return;
      placemarkSavedClickRef.current = true;
      window.requestAnimationFrame(() => { placemarkSavedClickRef.current = false; });
      const source = map.getSource(PLACEMARK_SOURCE) as GeoJSONSource | undefined;
      void source?.getClusterExpansionZoom(clusterId).then((zoom) => {
        map.easeTo({ center: coordinates as [number, number], zoom, duration: 550 });
      });
      event.originalEvent.stopPropagation();
    };

    const handleClusterEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const handleClusterLeave = () => {
      map.getCanvas().style.cursor = placemarkModeRef.current ? "crosshair" : "";
    };

    const handlePlacementClick = (event: MapMouseEvent) => {
      if (!placemarkModeRef.current || placemarkSavedClickRef.current) return;
      const existing = placemarkDraftRef.current;
      const draft: PlacemarkDraft = {
        ...(existing ?? {}),
        name: existing?.name ?? "",
        description: existing?.description ?? "",
        category: existing?.category ?? "",
        icon: existing?.icon ?? "pin",
        longitude: event.lngLat.lng,
        latitude: event.lngLat.lat,
        altitude: existing?.altitude ?? null,
        dataset_id: existing?.dataset_id ?? activeDatasetIds[0] ?? null,
        is_visible: existing?.is_visible ?? true,
      };
      openPlacemarkDraft(draft);
    };
    const handlePlacementCancel = (event: MapMouseEvent) => {
      if (!placemarkModeRef.current) return;
      event.preventDefault();
      event.originalEvent.preventDefault();
      cancelPlacemarkPlacement();
    };

    map.on("click", PLACEMARK_HIT_LAYER, handlePlacemarkClick);
    map.on("mousemove", PLACEMARK_HIT_LAYER, handlePlacemarkMove);
    map.on("mouseleave", PLACEMARK_HIT_LAYER, handlePlacemarkLeave);
    map.on("click", PLACEMARK_CLUSTER_LAYER, handleClusterClick);
    map.on("mouseenter", PLACEMARK_CLUSTER_LAYER, handleClusterEnter);
    map.on("mouseleave", PLACEMARK_CLUSTER_LAYER, handleClusterLeave);
    map.on("click", handlePlacementClick);
    map.on("contextmenu", handlePlacementCancel);

    return () => {
      clearHover();
      map.off("click", PLACEMARK_HIT_LAYER, handlePlacemarkClick);
      map.off("mousemove", PLACEMARK_HIT_LAYER, handlePlacemarkMove);
      map.off("mouseleave", PLACEMARK_HIT_LAYER, handlePlacemarkLeave);
      map.off("click", PLACEMARK_CLUSTER_LAYER, handleClusterClick);
      map.off("mouseenter", PLACEMARK_CLUSTER_LAYER, handleClusterEnter);
      map.off("mouseleave", PLACEMARK_CLUSTER_LAYER, handleClusterLeave);
      map.off("click", handlePlacementClick);
      map.off("contextmenu", handlePlacementCancel);
    };
  }, [activeDatasetIds, cancelPlacemarkPlacement, mapReady, openPlacemarkDraft]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(PLACEMARK_SOURCE) as GeoJSONSource | undefined;
    source?.setData(placemarksToGeoJson(placemarks));
  }, [mapReady, placemarks]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(PLACEMARK_FOCUS_SOURCE) as GeoJSONSource | undefined;
    source?.setData(placemarkFocusToGeoJson(placemarks, selectedPlacemarkId, hoveredPlacemarkId));
  }, [hoveredPlacemarkId, mapReady, placemarks, selectedPlacemarkId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const hoverFilter: maplibregl.FilterSpecification = [
      "all",
      ["!", ["has", "point_count"]],
      ["==", ["get", "id"], hoveredPlacemarkId ?? "__none__"],
    ];
    for (const layerId of [PLACEMARK_HOVER_HALO_LAYER, PLACEMARK_HOVER_LAYER, PLACEMARK_HOVER_LABEL_LAYER]) {
      if (map.getLayer(layerId)) map.setFilter(layerId, hoverFilter);
    }
  }, [hoveredPlacemarkId, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer(PLACEMARK_SELECTED_LAYER)) return;
    const selectedFilter: maplibregl.FilterSpecification = [
      "all",
      ["!", ["has", "point_count"]],
      ["==", ["get", "id"], selectedPlacemarkId ?? "__none__"],
    ];
    map.setFilter(PLACEMARK_SELECTED_LAYER, selectedFilter);
    for (const layerId of [PLACEMARK_SELECTED_HALO_LAYER, PLACEMARK_SELECTED_LABEL_LAYER]) {
      if (map.getLayer(layerId)) map.setFilter(layerId, selectedFilter);
    }

    if (!selectedPlacemarkId || !map.getLayer(PLACEMARK_SELECTED_HALO_LAYER)) return;
    const startedAt = performance.now();
    let frame = 0;
    const animate = (now: number) => {
      const elapsed = now - startedAt;
      const phase = (elapsed % 850) / 850;
      const wave = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2;
      map.setPaintProperty(PLACEMARK_SELECTED_HALO_LAYER, "circle-radius", 15 + wave * 8);
      map.setPaintProperty(PLACEMARK_SELECTED_HALO_LAYER, "circle-opacity", 0.78 - wave * 0.46);
      if (elapsed < 2550) frame = window.requestAnimationFrame(animate);
      else {
        map.setPaintProperty(PLACEMARK_SELECTED_HALO_LAYER, "circle-radius", 17);
        map.setPaintProperty(PLACEMARK_SELECTED_HALO_LAYER, "circle-opacity", 0.75);
      }
    };
    frame = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frame);
      if (map.getLayer(PLACEMARK_SELECTED_HALO_LAYER)) {
        map.setPaintProperty(PLACEMARK_SELECTED_HALO_LAYER, "circle-radius", 17);
        map.setPaintProperty(PLACEMARK_SELECTED_HALO_LAYER, "circle-opacity", 0.75);
      }
    };
  }, [mapReady, selectedPlacemarkId]);

  // REFERENCE LAYERS RELIABLE RUNTIME FIX V6
  // Do not gate visibility updates on map.isStyleLoaded(). MapLibre reports
  // false while raster/vector tiles are still arriving during zoom or a
  // basemap switch, even though existing style layers are already safe to
  // update. That old guard made the checkboxes change while the map stayed
  // unchanged. Apply existing layers immediately and retry missing layers
  // once the style becomes ready.
  const referenceLayersRef = useRef(referenceLayers);

  useEffect(() => {
    referenceLayersRef.current = referenceLayers;
  }, [referenceLayers]);

  const ensureReferenceLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    // Existing layers can be used while tiles are loading. Adding a missing
    // source/layer, however, is deferred until the style is ready.
    if (!map.getSource("reference-openfreemap")) {
      if (!map.isStyleLoaded()) return;
      const sourceSpec = BASE_STYLE.sources["reference-openfreemap"];
      map.addSource(
        "reference-openfreemap",
        JSON.parse(JSON.stringify(sourceSpec)) as maplibregl.SourceSpecification
      );
    }

    if (!map.isStyleLoaded()) return;

    const firstPlacemarkLayer = [
      PLACEMARK_HOVER_HALO_LAYER,
      PLACEMARK_SELECTED_HALO_LAYER,
      PLACEMARK_CLUSTER_LAYER,
      PLACEMARK_HIT_LAYER,
      PLACEMARK_LAYER,
    ].find((layerId) => Boolean(map.getLayer(layerId)));

    for (const layerSpec of BASE_STYLE.layers) {
      if (!layerSpec.id.startsWith("reference-") || map.getLayer(layerSpec.id)) continue;
      map.addLayer(
        JSON.parse(JSON.stringify(layerSpec)) as maplibregl.LayerSpecification,
        firstPlacemarkLayer
      );
    }
  }, []);

  const applyReferenceLayerVisibility = useCallback((next: ReferenceLayerVisibility) => {
    const map = mapRef.current;
    if (!map) return;

    referenceLayersRef.current = next;

    const applyNow = () => {
      const currentMap = mapRef.current;
      if (!currentMap) return;

      ensureReferenceLayers();

      const firstPlacemarkLayer = [
        PLACEMARK_HOVER_HALO_LAYER,
        PLACEMARK_SELECTED_HALO_LAYER,
        PLACEMARK_CLUSTER_LAYER,
        PLACEMARK_HIT_LAYER,
        PLACEMARK_LAYER,
      ].find((layerId) => Boolean(currentMap.getLayer(layerId)));

      for (const [key, layerIds] of Object.entries(REFERENCE_LAYER_IDS) as Array<[keyof ReferenceLayerVisibility, string[]]>) {
        const visibility = next[key] ? "visible" : "none";
        for (const layerId of layerIds) {
          if (!currentMap.getLayer(layerId)) continue;
          if (currentMap.getLayoutProperty(layerId, "visibility") !== visibility) {
            currentMap.setLayoutProperty(layerId, "visibility", visibility);
          }
          // Keep reference overlays above survey/raster content but below
          // saved placemark pins, so a selected annotation is never hidden.
          if (next[key]) currentMap.moveLayer(layerId, firstPlacemarkLayer);
        }
      }
      currentMap.triggerRepaint();
    };

    // Immediate application plus short retries covers basemap switches,
    // active zoom animation, and delayed vector-source initialization.
    applyNow();
    window.requestAnimationFrame(applyNow);
    window.setTimeout(applyNow, 180);
    window.setTimeout(applyNow, 700);
  }, [ensureReferenceLayers]);

  const handleToggleReferenceLayer = useCallback((
    key: keyof ReferenceLayerVisibility,
    visible: boolean
  ) => {
    const next = { ...referenceLayersRef.current, [key]: visible };
    referenceLayersRef.current = next;
    setReferenceLayers(next);
    applyReferenceLayerVisibility(next);
  }, [applyReferenceLayerVisibility]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const reapply = () => applyReferenceLayerVisibility(referenceLayersRef.current);
    reapply();
    map.on("load", reapply);
    map.on("styledata", reapply);
    map.on("idle", reapply);

    return () => {
      map.off("load", reapply);
      map.off("styledata", reapply);
      map.off("idle", reapply);
    };
  }, [applyReferenceLayerVisibility, mapReady]);

  useEffect(() => {
    if (!mapReady) return;
    applyReferenceLayerVisibility(referenceLayersRef.current);
  }, [applyReferenceLayerVisibility, basemap, mapReady]);

  const activeStatusDataset = useMemo(() => {
    for (const id of activeDatasetIds) {
      const dataset = datasets.find((candidate) => candidate.id === id);
      if (dataset) return dataset;
    }
    return null;
  }, [activeDatasetIds, datasets]);

  const activeElevationDataset = useMemo(() => {
    for (const id of activeDatasetIds) {
      const dataset = datasets.find((candidate) => candidate.id === id && candidate.file_type === "geotiff");
      if (dataset) return dataset;
    }
    return null;
  }, [activeDatasetIds, datasets]);

  useEffect(() => {
    if (!cursorLngLat || !activeElevationDataset) {
      setElevationSample(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchElevationSample(activeElevationDataset.id, cursorLngLat[0], cursorLngLat[1], controller.signal)
        .then(setElevationSample)
        .catch((error) => {
          if ((error as Error).name !== "AbortError") setElevationSample(null);
        });
    }, 450);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeElevationDataset, cursorLngLat]);

  const eyeAltitudeMeters = useMemo(() => {
    const latitude = cursorLngLat?.[1] ?? mapRef.current?.getCenter().lat ?? DAVANGERE_CENTER[1];
    const height = containerRef.current?.clientHeight ?? 800;
    return estimateEyeAltitudeMeters(mapZoom, latitude, height, mapPitch);
  }, [cursorLngLat, mapPitch, mapZoom]);

  // Retained for backward-compatible placemark actions.
  void handleTogglePlacemarkVisibility;
  void handleBulkDeletePlacemarks;
  const selectedPlacemarkDetails = placemarkDetailsId
    ? placemarks.find((placemark) => placemark.id === placemarkDetailsId) ?? null
    : null;
  const selectedPlacemarkDatasetName = selectedPlacemarkDetails?.dataset_id
    ? datasets.find((dataset) => dataset.id === selectedPlacemarkDetails.dataset_id)?.name ?? null
    : null;

  return (
    <>
      <CommandCenter
        isMobile={isMobile}
        open={!isMobile || commandCenterMobileOpen}
        onRequestClose={() => onCommandCenterMobileOpenChange(false)}
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
        spatialAuditStatus={spatialAuditStatus}
        onOpenAttributeTable={openLayerAttributeTable}
        status={status}
        visualization={{
          datasets: activeVectorDatasets,
          availableDatasetIds: datasets.filter(isVectorVisualizationDataset).map((dataset) => dataset.id),
          manifests: visualizationManifests,
          loadingIds: visualizationLoadingIds,
          errors: visualizationErrors,
          selectedDatasetId: selectedVisualizationDatasetId,
          target: visualizationTarget,
          mode: visualizationMode,
          field: visualizationField,
          opacity: visualizationOpacity,
          pointSize: visualizationPointSize,
          lineWidth: visualizationLineWidth,
          preview: visualizationPreview,
          truncated: status.truncated,
          layerLoading: visualizationLayerLoading,
          layerError: visualizationLayerError,
          layerTruncated: visualizationLayerTruncated,
          onDatasetChange: setSelectedVisualizationDatasetId,
          onTargetChange: setVisualizationTarget,
          onModeChange: changeVisualizationMode,
          onFieldChange: setVisualizationField,
          onOpacityChange: setVisualizationOpacity,
          onPointSizeChange: setVisualizationPointSize,
          onLineWidthChange: setVisualizationLineWidth,
          onResetStyle: resetVisualizationStyle,
        }}
        detectionMode={detectionMode}
        onRunManholeNetwork={runManholeNetwork}
        manholeRecommendLoading={manholeRecommendLoading}
        classMap={classMap}
        extraVisibleCategories={extraVisibleCategories}
        onToggleExtraVisibleCategory={toggleExtraVisibleCategory}
        onSetAllExtraVisibleCategories={setAllExtraVisibleCategories}
        onSetCategoriesVisible={setCategoriesVisible}
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
          onAiIconClick={requestSpatialAuditOnce}
          streetPickMode={streetPickMode}
          onToggleStreetView={toggleStreetPickMode}
          placemarkMode={placemarkMode}
          onTogglePlacemark={togglePlacemarkMode}
          placemarkCount={placemarks.length}
          myPlacesOpen={myPlacesOpen}
          onToggleMyPlaces={() => setMyPlacesOpen((current) => !current)}
          coordinateSearchOpen={coordinateSearchOpen}
          onToggleCoordinateSearch={toggleCoordinateSearch}
          referenceLayers={referenceLayers}
          onToggleReferenceLayer={handleToggleReferenceLayer}
        />
        <HoverTooltip hover={hover} />
        {selectedAnomaly && (
          <AnomalyAlertCard
            anomaly={selectedAnomaly}
            onClose={() => setSelectedAnomalyId(null)}
            onStatusChange={handleAnomalyStatusChange}
            onStale={handleAnomalyStale}
          />
        )}
        {placemarkMode && !placemarkDraft && (
          <div className="placemark-pick-hint" data-testid="placemark-pick-hint">
            Click the map to place a pin · right-click or Esc to cancel
          </div>
        )}
        {coordinateSearchOpen && (
          <CoordinateSearchPanel
            datasets={coordinateSearchDatasets}
            onFlyTo={handleCoordinateFlyTo}
            onClear={clearCoordinateSearchTarget}
            onClose={closeCoordinateSearch}
          />
        )}
        {placemarkNotice && (
          <div className="placemark-success-toast" role="status" aria-live="polite">
            <span aria-hidden="true">✓</span>
            {placemarkNotice}
          </div>
        )}
        {placemarkDraft && (
          <PlacemarkEditor
            draft={placemarkDraft}
            saving={placemarkSaving}
            error={placemarkEditorError}
            onChange={(patch) => {
              setPlacemarkDraft((current) => {
                if (!current) return current;
                const updated = { ...current, ...patch };
                placemarkDraftRef.current = updated;
                const marker = placemarkPreviewMarkerRef.current;
                if (marker && (patch.longitude !== undefined || patch.latitude !== undefined)) {
                  marker.setLngLat([updated.longitude, updated.latitude]);
                }
                return updated;
              });
            }}
            onSave={() => void handleSavePlacemark()}
            onCancel={() => cancelPlacemarkPlacement()}
          />
        )}
        {selectedPlacemarkDetails && (
          <PlacemarkDetailsPanel
            placemark={selectedPlacemarkDetails}
            datasetName={selectedPlacemarkDatasetName}
            onClose={() => setPlacemarkDetailsId(null)}
            onEdit={handleEditPlacemark}
            onDelete={(placemark) => void handleDeletePlacemark(placemark)}
          />
        )}
        {myPlacesOpen && (
          <MyPlacesPanel
            placemarks={placemarks}
            loading={placemarksLoading}
            error={placemarksError}
            selectedId={selectedPlacemarkId}
            onClose={() => { setMyPlacesOpen(false); setListHoveredPlacemarkId(null); }}
            onFlyTo={handleFlyToPlacemark}
            onHover={(placemark) => setListHoveredPlacemarkId(placemark?.id ?? null)}
          />
        )}
        <MapStatusBar
          lngLat={cursorLngLat}
          scaleLabel={mapScaleLabel}
          datasetName={activeStatusDataset?.name ?? null}
          surveyDate={activeStatusDataset?.survey_date ?? null}
          elevation={elevationSample?.elevation ?? null}
          eyeAltitudeMeters={eyeAltitudeMeters}
        />
        <ZoomSlider
          zoom={mapZoom}
          minZoom={4}
          maxZoom={24}
          onChange={(next) => mapRef.current?.setZoom(next)}
        />
        <div className="map-side-controls">
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
          <button
            type="button"
            className={`map-measure-btn${measureActive ? " map-measure-btn--active" : ""}`}
            onClick={toggleMeasureActive}
            title="Measure"
            aria-label="Open Measure tools"
            aria-pressed={measureActive}
            data-testid="topbar-measure"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="8" width="19" height="8" rx="1.5" transform="rotate(-45 12 12)" />
              <g transform="rotate(-45 12 12)">
                <path d="M6 8v3M9.5 8v2M13 8v3M16.5 8v2" />
              </g>
            </svg>
          </button>
          <button
            type="button"
            className="map-measure-btn"
            onClick={() => setShow3DPlan(true)}
            title="3D Viewer"
            aria-label="Open 3D Viewer"
            data-testid="topbar-3d-viewer"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5z" />
              <path d="M12 12v8.5M12 12l7.5-4.3M12 12L4.5 7.7" />
            </svg>
          </button>
        </div>
        {manholeRecommendOpen && (
          <ManholeRecommendCard
            answer={manholeRecommendAnswer}
            loading={manholeRecommendLoading}
            error={manholeRecommendError}
            onClose={closeManholeRecommend}
            onView3D={() => setShow3DPlan(true)}
          />
        )}
        {manholeFeatureOpen && (
          <ManholeRecommendCard
            answer={manholeFeatureAnswer}
            loading={manholeFeatureLoading}
            error={manholeFeatureError}
            onClose={closeManholeFeature}
            onView3D={() => setShow3DPlan(true)}
          />
        )}
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
      {photoViewer && (
        photoViewer.isPanorama ? (
          <PanoramaViewer url={photoViewer.url} label={photoViewer.label} onClose={() => setPhotoViewer(null)} />
        ) : (
          <CylinderPanoramaViewer url={photoViewer.url} label={photoViewer.label} mode="180" onClose={() => setPhotoViewer(null)} />
        )
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
      {show3DPlan && (
        <Map3DViewer
          features={loadedFeatures}
          classMap={classMap}
          anomalies={anomalies}
          manholeAnswer={manholeFeatureOpen ? manholeFeatureAnswer : manholeRecommendAnswer}
          datasets={datasets}
          activeDatasetIds={activeDatasetIds}
          onClose={() => setShow3DPlan(false)}
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

interface VisualizationPanelProps {
  datasets: DatasetRow[];
  availableDatasetIds: string[];
  manifests: Record<string, VisualizationManifest>;
  loadingIds: Set<string>;
  errors: Record<string, string>;
  selectedDatasetId: string | null;
  target: VisualizationGeometryTarget;
  mode: VisualizationMode;
  field: string | null;
  opacity: number;
  pointSize: number;
  lineWidth: number;
  preview: VisualizationStylePreview;
  truncated: boolean;
  layerLoading: boolean;
  layerError: string | null;
  layerTruncated: boolean;
  onDatasetChange: (datasetId: string | null) => void;
  onTargetChange: (target: VisualizationGeometryTarget) => void;
  onModeChange: (mode: VisualizationMode) => void;
  onFieldChange: (field: string | null) => void;
  onOpacityChange: (value: number) => void;
  onPointSizeChange: (value: number) => void;
  onLineWidthChange: (value: number) => void;
  onResetStyle: () => void;
}

// Dedicated POLES geometry group: an explicit allowlist (not a substring
// match like `name.includes("pole")`, which could sweep in unrelated
// layers) matched against the normalized category name so case, whitespace,
// and underscore/hyphen variants don't break grouping.
function normalizeLayerName(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const POLE_LAYER_NAMES = new Set([
  "power pole with light",
  "power pole",
  "light pole",
  "solar light",
]);

function isPoleLayer(layerName: string): boolean {
  return POLE_LAYER_NAMES.has(normalizeLayerName(layerName));
}

function CommandCenter({
  isMobile, open, onRequestClose,
  datasets, activeDatasetIds, flyError, onSelectDataset, onSelectAllDatasets, expandedDatasetId, onToggleDatasetSettings,
  rasterSettingsById, onChangeRasterSettings, categoryStats, hiddenCategories, onToggleCategory,
  onSetAllCategoriesVisible, spatialAuditStatus, onOpenAttributeTable, status: _status, visualization,
  detectionMode, onRunManholeNetwork, manholeRecommendLoading,
  classMap, extraVisibleCategories, onToggleExtraVisibleCategory, onSetAllExtraVisibleCategories,
  onSetCategoriesVisible,
}: {
  isMobile: boolean; open: boolean; onRequestClose: () => void;
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
  spatialAuditStatus: "idle" | "running" | "success" | "error";
  onOpenAttributeTable: (category: string) => void;
  status: ViewportStatus;
  visualization: VisualizationPanelProps;
  detectionMode: DetectionMode;
  onRunManholeNetwork: (datasetIds: string[]) => void;
  manholeRecommendLoading: boolean;
  classMap: Record<string, string>;
  extraVisibleCategories: Set<string>;
  onToggleExtraVisibleCategory: (category: string) => void;
  onSetAllExtraVisibleCategories: (categories: string[]) => void;
  onSetCategoriesVisible: (categories: string[], visible: boolean) => void;
}) {
  const [layerQuery, setLayerQuery] = useState("");
  const [layerMenu, setLayerMenu] = useState<{ category: string; x: number; y: number } | null>(null);
  const [visualizationOpen, setVisualizationOpen] = useState(false);
  const visualizationAnchorRef = useRef<HTMLElement | null>(null);
  const visualizationPopupRef = useRef<HTMLDivElement | null>(null);
  const [visualizationPopupPosition, setVisualizationPopupPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const visualizationDrag = useDraggableMapPanel<HTMLDivElement>({
    storageKey: "davangere.geometry-styling-position",
    boundary: "viewport",
    initialPosition: visualizationPopupPosition
      ? { x: visualizationPopupPosition.left, y: visualizationPopupPosition.top }
      : null,
    margin: 8,
    disabled: isMobile,
  });
  const normalizedLayerQuery = layerQuery.trim().toLocaleLowerCase();
  const displayedLayers = useMemo(
    () => [...categoryStats]
      .sort((a, b) => a.category.localeCompare(b.category, undefined, { sensitivity: "base", numeric: true }))
      .filter((layer) => !normalizedLayerQuery || layer.category.toLocaleLowerCase().includes(normalizedLayerQuery)),
    [categoryStats, normalizedLayerQuery]
  );

  // Optional 3-level grouping for the layer/attribute panel: Geometry group
  // → original source layer → that layer's own attributes. Built from the
  // visualization manifest's `field_groups` tree (one per active vector
  // dataset) joined with `categoryStats` for colour/count/visibility. When no
  // active dataset exposes a tree (e.g. raster, legacy uploads) this is null
  // and the panel falls back to the classic flat category list.
  const GEOMETRY_ORDER = ["Points", "Lines", "Polygon"] as const;
  const [expandedCategoryLayers, setExpandedCategoryLayers] = useState<Set<string>>(() => new Set());
  // Geometry-group expansion is independent of each layer's own checkbox.
  // Everything starts collapsed; we only reset on an actual datasource switch.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setExpandedGroups(new Set());
  }, [activeDatasetIds]);

  // Active vector (e.g. GDB) datasets — derived from CommandCenter's own
  // props so the tree can be built without reaching into the parent scope.
  const activeVectorDatasets = useMemo(
    () => datasets.filter((dataset) => activeDatasetIds.includes(dataset.id) && isVectorVisualizationDataset(dataset)),
    [datasets, activeDatasetIds]
  );

  const groupedCategoryView = useMemo(() => {
    const matchesQuery = (name: string) =>
      !normalizedLayerQuery || name.toLocaleLowerCase().includes(normalizedLayerQuery);

    // One entry per active vector dataset that has a manifest. `ownCategories`
    // is that dataset's full layer list (VisualizationManifest.layers) — the
    // only reliable per-dataset attribution for POLES/Other, since those
    // categories never appear in `field_groups` (which only covers layers the
    // backend classified as Points/Lines/Polygon).
    interface DatasetInfo {
      dataset: DatasetRow;
      tree: VisualizationFieldGroupTree | null;
      ownCategories: Set<string>;
    }
    const datasetInfos: DatasetInfo[] = activeVectorDatasets.flatMap((dataset) => {
      const manifest = visualization.manifests[dataset.id];
      if (!manifest) return [];
      const ownCategories = new Set(
        manifest.layers.map((layer) => layer.display_name || layer.source_layer_name)
      );
      return [{ dataset, tree: manifest.field_groups ?? null, ownCategories }];
    });

    const hasUsableTree = datasetInfos.some((info) => info.tree && info.tree.geometry_groups.length > 0);
    if (!hasUsableTree) return null;

    const legendByCat = new Map(categoryStats.map((entry) => [entry.category, entry]));
    const groups: Array<{
      name: string;
      layers: Array<{ node: VisualizationLayerGroupNode; legend?: LegendEntry }>;
    }> = [];
    const covered = new Set<string>();

    for (const { dataset, tree, ownCategories } of datasetInfos) {
      // `tree.datasource` is the backend's already-cleaned source name (no
      // `.gdb` extension or upload timestamp suffix); fall back to the raw
      // dataset name for datasets with no tree at all.
      const prefix = `${tree?.datasource ?? dataset.name} - `;
      const findLayerNode = (name: string): VisualizationLayerGroupNode | undefined => {
        if (!tree) return undefined;
        for (const geomGroup of tree.geometry_groups) {
          const found = geomGroup.layers.find((node) => node.name === name);
          if (found) return found;
        }
        return undefined;
      };

      // POLES first, ahead of this dataset's own geometry-tree classification
      // and its Other fallback below, so the allowlisted layers land there
      // regardless of how (or whether) the tree would otherwise place them.
      const poleLayers: Array<{ node: VisualizationLayerGroupNode; legend?: LegendEntry }> = [];
      for (const category of ownCategories) {
        if (covered.has(category) || !isPoleLayer(category)) continue;
        covered.add(category);
        if (!matchesQuery(category)) continue;
        poleLayers.push({ node: findLayerNode(category) ?? { name: category, fields: [] }, legend: legendByCat.get(category) });
      }

      if (tree) {
        for (const geom of GEOMETRY_ORDER) {
          const geomGroup = tree.geometry_groups.find((candidate) => candidate.name === geom);
          if (!geomGroup) continue;
          const layers: Array<{ node: VisualizationLayerGroupNode; legend?: LegendEntry }> = [];
          for (const node of geomGroup.layers) {
            if (covered.has(node.name)) continue;
            covered.add(node.name);
            if (!matchesQuery(node.name)) continue;
            layers.push({ node, legend: legendByCat.get(node.name) });
          }
          if (layers.length > 0) groups.push({ name: `${prefix}${geom}`, layers });
        }
      }

      // Omit POLES entirely when this dataset has no matching layers, rather
      // than showing an empty "<Dataset> - Poles 0" row.
      if (poleLayers.length > 0) groups.push({ name: `${prefix}Poles`, layers: poleLayers });

      // This dataset's own remaining categories (unrecognised / mixed-
      // geometry layers the tree doesn't classify) go under its own Other.
      const otherLayers: Array<{ node: VisualizationLayerGroupNode; legend?: LegendEntry }> = [];
      for (const category of ownCategories) {
        if (covered.has(category)) continue;
        covered.add(category);
        if (!matchesQuery(category)) continue;
        otherLayers.push({ node: { name: category, fields: [] }, legend: legendByCat.get(category) });
      }
      if (otherLayers.length > 0) groups.push({ name: `${prefix}Other`, layers: otherLayers });
    }

    // Safety net: any category still unattributed (e.g. an active dataset
    // with no manifest yet) is kept under a shared "Other" so nothing
    // silently disappears from the panel.
    const leftover = categoryStats.filter(
      (entry) => !covered.has(entry.category) && matchesQuery(entry.category)
    );
    if (leftover.length > 0) {
      groups.push({
        name: "Other",
        layers: leftover.map((entry) => ({
          node: { name: entry.category, fields: [] },
          legend: entry,
        })),
      });
    }

    return { groups };
  }, [activeVectorDatasets, visualization.manifests, categoryStats, normalizedLayerQuery]);

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

  const updateVisualizationPopupPosition = useCallback(() => {
    const anchor = visualizationAnchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportGap = 8;
    const width = Math.min(420, Math.max(340, window.innerWidth - viewportGap * 2));
    const left = Math.max(viewportGap, Math.min(rect.right - width, window.innerWidth - width - viewportGap));
    const hasRoomBelow = window.innerHeight - rect.bottom >= 320;
    const top = hasRoomBelow ? rect.bottom + 6 : viewportGap;
    setVisualizationPopupPosition({
      top,
      left,
      width,
      maxHeight: Math.max(280, window.innerHeight - top - viewportGap),
    });
  }, []);

  const openVisualizationForDataset = useCallback((datasetId: string, anchor: HTMLElement) => {
    visualizationAnchorRef.current = anchor;
    visualization.onDatasetChange(datasetId);
    setVisualizationOpen(true);
    window.requestAnimationFrame(updateVisualizationPopupPosition);
  }, [updateVisualizationPopupPosition, visualization.onDatasetChange]);

  useEffect(() => {
    if (!visualizationOpen) return;
    updateVisualizationPopupPosition();

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (visualizationAnchorRef.current?.contains(target)) return;
      if (visualizationPopupRef.current?.contains(target)) return;
      setVisualizationOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setVisualizationOpen(false);
      visualizationAnchorRef.current?.focus();
    };
    const reposition = () => updateVisualizationPopupPosition();
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", reposition);
    };
  }, [updateVisualizationPopupPosition, visualizationOpen]);

  useEffect(() => {
    if (visualization.selectedDatasetId) return;
    setVisualizationOpen(false);
  }, [visualization.selectedDatasetId]);

  return (
    <>
      {isMobile && open && (
        <div
          className="command-center__backdrop"
          onClick={onRequestClose}
          data-testid="command-center-backdrop"
        />
      )}
      <aside
        className={`command-center${isMobile && !open ? " command-center--closed" : ""}`}
        data-testid="command-center"
      >
        {isMobile && (
          <button
            type="button"
            className="command-center__close"
            onClick={onRequestClose}
            aria-label="Close data sources"
            data-testid="command-center-close"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      <div className="command-center__body">
        {datasets.length > 0 && (
          <DataSourceSelector
            datasets={datasets}
            activeDatasetIds={activeDatasetIds}
            onSelectDataset={onSelectDataset}
            onSelectAllDatasets={onSelectAllDatasets}
            expandedDatasetId={expandedDatasetId}
            onToggleDatasetSettings={onToggleDatasetSettings}
            rasterSettingsById={rasterSettingsById}
            onChangeRasterSettings={onChangeRasterSettings}
            layerDatasetIds={visualization.availableDatasetIds}
            onOpenLayer={openVisualizationForDataset}
            flyError={flyError}
          />
        )}

        {visualizationOpen && visualizationPopupPosition && createPortal(
          <div
            ref={(node) => {
              visualizationPopupRef.current = node;
              visualizationDrag.panelRef.current = node;
            }}
            id="geometry-styling-popup"
            className="visualization-popup"
            role="dialog"
            aria-modal="false"
            aria-label="Geometry styling"
            style={{
              top: visualizationPopupPosition.top,
              left: visualizationPopupPosition.left,
              width: visualizationPopupPosition.width,
              maxHeight: visualizationPopupPosition.maxHeight,
              ...visualizationDrag.style,
            }}
          >
            <div className="floating-map-panel__dragbar" onPointerDown={visualizationDrag.onDragStart}>
              <span>Geometry Styling</span>
              <small>Drag to reposition</small>
              <button type="button" onClick={() => setVisualizationOpen(false)} aria-label="Close Geometry Styling">×</button>
            </div>
            <VisualizationPanel {...visualization} />
          </div>,
          document.body
        )}

        {activeDatasetIds.length > 0 && detectionMode === "manholes" && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <span className="command-center__section-title">Spatial Audit</span>
            </div>
            <button
              type="button"
              className="command-center__audit-btn"
              disabled={manholeRecommendLoading}
              onClick={() => onRunManholeNetwork(activeDatasetIds)}
              data-testid="run-manhole-network"
              title="Build the complete manhole-to-manhole drainage network, with flow direction grounded in real surveyed levels / DTM / contour elevation"
              style={{ marginTop: 8 }}
            >
              {manholeRecommendLoading ? "Building…" : "Full Drainage Network"}
            </button>
          </div>
        )}

        {categoryStats.length > 0 && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <span className="command-center__section-title">Category Visibility</span>
              <button
                type="button"
                className="command-center__text-btn"
                data-testid="layers-toggle-all"
                onClick={() => {
                  if (detectionMode) {
                    // Mirrors the per-row toggle: categories already in the
                    // mode's own asset family are always shown regardless, so
                    // "all" only ever needs to add/clear the OTHER categories.
                    const nonFamily = categoryStats
                      .map((c) => c.category)
                      .filter((cat) => !DETECTION_MODE_TARGET_CLASSES[detectionMode].includes(classMap[cat]));
                    onSetAllExtraVisibleCategories(extraVisibleCategories.size === 0 ? nonFamily : []);
                  } else {
                    onSetAllCategoriesVisible(hiddenCategories.size > 0);
                  }
                }}
              >
                {(detectionMode ? extraVisibleCategories.size === 0 : hiddenCategories.size > 0) ? "Show all" : "Hide all"}
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
              {groupedCategoryView ? (
                groupedCategoryView.groups.map((group) => {
                  const eligible = group.layers.filter((layer) => layer.legend);
                  const toggleable = eligible.filter((layer) => {
                    const inModeFamily = detectionMode
                      ? DETECTION_MODE_TARGET_CLASSES[detectionMode].includes(classMap[layer.node.name])
                      : false;
                    return !inModeFamily;
                  });
                  const isLayerSelected = (category: string) => {
                    const inModeFamily = detectionMode
                      ? DETECTION_MODE_TARGET_CLASSES[detectionMode].includes(classMap[category])
                      : false;
                    return detectionMode
                      ? (inModeFamily || extraVisibleCategories.has(category))
                      : !hiddenCategories.has(category);
                  };
                  const selectedToggleable = toggleable.filter((layer) => isLayerSelected(layer.node.name)).length;
                  const allSelected = toggleable.length > 0 && selectedToggleable === toggleable.length;
                  const indeterminate = selectedToggleable > 0 && selectedToggleable < toggleable.length;
                  const groupExpanded = expandedGroups.has(group.name);

                  const setGroupVisible = (visible: boolean) => {
                    onSetCategoriesVisible(toggleable.map((layer) => layer.node.name), visible);
                  };

                  const toggleGroup = () => {
                    setExpandedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group.name)) next.delete(group.name);
                      else next.add(group.name);
                      return next;
                    });
                  };

                  return (
                  <div key={group.name} className="layer-group">
                    <div className="layer-group__head" onClick={toggleGroup}>
                      <input
                        type="checkbox"
                        className="layer-group__check"
                        aria-label={`Select all layers in ${group.name}`}
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = indeterminate; }}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          event.stopPropagation();
                          setGroupVisible(event.target.checked);
                        }}
                      />
                      <button
                        type="button"
                        className="layer-group__toggle"
                        aria-expanded={groupExpanded}
                        aria-controls={`layer-group-body-${group.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleGroup();
                        }}
                      >
                        <span className="layer-group__name" title={group.name}>{group.name}</span>
                        <span className="layer-group__count">{group.layers.length}</span>
                        <span className="grouped-field-list__chevron layer-group__chevron" aria-hidden="true" />
                      </button>
                    </div>
                    {groupExpanded && (
                    <div className="layer-group__body" id={`layer-group-body-${group.name}`}>
                      {group.layers.map(({ node, legend }) => {
                        const category = node.name;
                        const inModeFamily = detectionMode
                          ? DETECTION_MODE_TARGET_CLASSES[detectionMode].includes(classMap[category])
                          : false;
                        const visible = detectionMode
                          ? inModeFamily || extraVisibleCategories.has(category)
                          : !hiddenCategories.has(category);
                        const expandKey = `${group.name}::${category}`;
                        const open = expandedCategoryLayers.has(expandKey);
                        const toggleVisibility = () => {
                          if (detectionMode) {
                            if (!inModeFamily) onToggleExtraVisibleCategory(category);
                          } else {
                            onToggleCategory(category);
                          }
                        };
                        return (
                          <div
                            key={category}
                            className={`layer-row layer-row--grouped${visible ? "" : " layer-row--hidden"}`}
                            data-testid={`layer-row-${category}`}
                          >
                            <button
                              type="button"
                              className="layer-row__chevron"
                              aria-label={`${open ? "Hide" : "Show"} attributes of ${category}`}
                              aria-expanded={open}
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpandedCategoryLayers((current) => {
                                  const next = new Set(current);
                                  if (next.has(expandKey)) next.delete(expandKey);
                                  else next.add(expandKey);
                                  return next;
                                });
                              }}
                            >
                              <span className="grouped-field-list__chevron" aria-hidden="true" />
                            </button>
                            <div
                              className={`layer-row__checkbox${visible ? " layer-row__checkbox--checked" : ""}`}
                              onClick={toggleVisibility}
                            >
                              <svg className="layer-row__checkbox-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </div>
                            <span
                              className="layer-row__name"
                              onClick={toggleVisibility}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setLayerMenu({
                                  category,
                                  x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
                                  y: Math.max(8, Math.min(event.clientY, window.innerHeight - 96)),
                                });
                              }}
                              title={
                                detectionMode
                                  ? (inModeFamily
                                    ? "Always shown in this AI Detection mode"
                                    : "Click to also show this category alongside the AI Detection view")
                                  : "Click to show or hide. Right-click for the attribute table."
                              }
                            >
                              {legend && <span className="layer-row__swatch" style={{ background: legend.color }} />}
                              {category}
                              <span className="layer-row__count">{legend?.count ?? node.fields.length}</span>
                            </span>
                            {open && (
                              <ul className="layer-attributes">
                                {node.fields.length === 0 ? (
                                  <li className="layer-attributes__empty">No attributes</li>
                                ) : (
                                  node.fields.map((field) => (
                                    <li key={field.name} className="layer-attributes__item" title={field.name}>
                                      <span className="layer-attributes__name">{field.name}</span>
                                      <span className="layer-attributes__type">{field.detected_type}</span>
                                    </li>
                                  ))
                                )}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    )}
                  </div>
                );
              })
              ) : (
                displayedLayers.map((c) => {
                  // While a detection mode owns the map, a category already in
                  // the mode's own asset family is always shown (its checkbox
                  // just reflects that, clicking it is a no-op); any OTHER
                  // category is off by default and toggles via the separate
                  // extraVisibleCategories allowlist instead of the ordinary
                  // hiddenCategories blacklist, since the mode ignores that one.
                  const inModeFamily = detectionMode
                    ? DETECTION_MODE_TARGET_CLASSES[detectionMode].includes(classMap[c.category])
                    : false;
                  const visible = detectionMode
                    ? inModeFamily || extraVisibleCategories.has(c.category)
                    : !hiddenCategories.has(c.category);
                  return (
                    <div
                      key={c.category}
                      className={`layer-row${visible ? "" : " layer-row--hidden"}`}
                      onClick={() => {
                        if (detectionMode) {
                          if (!inModeFamily) onToggleExtraVisibleCategory(c.category);
                        } else {
                          onToggleCategory(c.category);
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setLayerMenu({
                          category: c.category,
                          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
                          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 96)),
                        });
                      }}
                      title={
                        detectionMode
                          ? (inModeFamily
                            ? "Always shown in this AI Detection mode"
                            : "Click to also show this category alongside the AI Detection view")
                          : "Click to show or hide. Right-click for the attribute table."
                      }
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
                })
              )}
              {groupedCategoryView
                ? groupedCategoryView.groups.reduce((sum, g) => sum + g.layers.length, 0) === 0 && (
                  <div className="layer-list__empty">No matching layers</div>
                )
                : displayedLayers.length === 0 && (
                  <div className="layer-list__empty">No matching layers</div>
                )}
            </div>
          </div>
        )}
      </div>
      {spatialAuditStatus === "success" && (
        <div className="command-center__audit-success" role="status" aria-live="polite">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
          <span>Spatial Audit run success</span>
        </div>
      )}
      <div className="command-center__footer">
        <SupportingFilesImport />
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
    </>
  );
}

function compactFeatureCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10000 ? 1 : 0,
  }).format(value);
}

function VisualizationPanel({
  datasets,
  manifests,
  loadingIds,
  errors,
  selectedDatasetId,
  target,
  mode,
  field,
  opacity,
  pointSize,
  lineWidth,
  preview,
  truncated,
  layerLoading,
  layerError,
  layerTruncated,
  onTargetChange,
  onModeChange,
  onFieldChange,
  onOpacityChange,
  onPointSizeChange,
  onLineWidthChange,
  onResetStyle,
}: VisualizationPanelProps) {
  const effectiveDatasetId = selectedDatasetId;
  const selectedDataset = datasets.find((dataset) => dataset.id === effectiveDatasetId) ?? null;
  const manifest = effectiveDatasetId ? manifests[effectiveDatasetId] ?? null : null;
  const loading = effectiveDatasetId ? loadingIds.has(effectiveDatasetId) : false;
  const error = effectiveDatasetId ? errors[effectiveDatasetId] ?? null : null;
  const layers = manifest?.layers ?? [];

  const geometryLayers = useMemo(() => ({
    point: layers.filter((layer) => layer.recommended_renderer === "point"),
    line: layers.filter((layer) => layer.recommended_renderer === "line"),
    polygon: layers.filter((layer) => layer.recommended_renderer === "polygon"),
  }), [layers]);

  const targetLayers = useMemo(() => geometryLayers[target], [geometryLayers, target]);

  const targetFields = useMemo(
    () => aggregateVisualizationFields(targetLayers),
    [targetLayers]
  );

  const eligibleFields = targetFields.filter((candidate) => {
    if (mode === "category") {
      return (candidate.detected_type === "string" || candidate.detected_type === "boolean")
        && (candidate.unique_count ?? 0) > 1
        && (candidate.unique_count ?? 0) <= 50;
    }
    if (mode === "numeric") return candidate.detected_type === "number";
    if (mode === "missing-data") return candidate.missing_count > 0;
    return false;
  });

  // The hierarchical attribute tree arrives pre-built on the manifest
  // (`field_groups`): datasource → geometry groups (Points/Lines/Polygon) →
  // source layers → attributes. When present and non-empty we render the
  // 3-level tree; otherwise we keep the flat <select> — fully backward
  // compatible with datasets that expose no tree.
  const manifestGroups = useMemo(
    () => (manifest?.field_groups && manifest.field_groups.geometry_groups.length > 0
      ? manifest.field_groups
      : null),
    [manifest]
  );

  // Map the (single-field-name) styling selection back onto its exact source
  // layer so the tree can highlight the correct row even when the same field
  // name exists in more than one layer (e.g. "FID" in Manhole vs Point).
  const selectedField = useMemo(() => {
    if (!manifestGroups || !field) return null;
    const geomName = target === "point" ? "Points" : target === "line" ? "Lines" : "Polygon";
    const group = manifestGroups.geometry_groups.find((candidate) => candidate.name === geomName);
    const layer = group?.layers.find((candidate) => candidate.fields.some((f) => f.name === field));
    if (!layer) return null;
    return { geometryGroup: geomName, layerName: layer.name, fieldName: field };
  }, [manifestGroups, target, field]);

  const modeOptions: Array<{ value: VisualizationMode; label: string; enabled: boolean }> = [
    { value: "default", label: "Default", enabled: true },
    { value: "category", label: "Category", enabled: targetFields.some((candidate) => (
      (candidate.detected_type === "string" || candidate.detected_type === "boolean")
      && (candidate.unique_count ?? 0) > 1
      && (candidate.unique_count ?? 0) <= 50
    )) },
    { value: "numeric", label: "Numeric", enabled: targetFields.some((candidate) => candidate.detected_type === "number") },
    { value: "missing-data", label: "Missing", enabled: targetFields.some((candidate) => candidate.missing_count > 0) },
  ];

  const countFor = (renderer: "point" | "line" | "polygon") => geometryLayers[renderer]
    .reduce((total, layer) => total + layer.feature_count, 0);
  const pointCount = countFor("point");
  const lineCount = countFor("line");
  const polygonCount = countFor("polygon");
  const allCount = pointCount + lineCount + polygonCount;

  const targetOptions: Array<{
    value: VisualizationGeometryTarget;
    label: string;
    count: number;
  }> = [
    { value: "point", label: "Points", count: pointCount },
    { value: "line", label: "Lines", count: lineCount },
    { value: "polygon", label: "Polygons", count: polygonCount },
  ];

  useEffect(() => {
    if (mode === "default") return;
    if (eligibleFields.some((candidate) => candidate.name === field)) return;
    onFieldChange(eligibleFields[0]?.name ?? null);
  }, [eligibleFields, field, mode, onFieldChange]);

  return (
    <section className="visualization-panel visualization-panel--v3" data-testid="visualization-panel">
      <div className="visualization-panel__head">
        <div>
          <div className="visualization-panel__eyebrow">Visualization</div>
          <div className="visualization-panel__title">Geometry Styling</div>
        </div>
        <span className="visualization-panel__live"><span aria-hidden="true" /> Live</span>
      </div>

      {!selectedDataset ? (
        <div className="visualization-panel__empty">
          Click Layer beside an active vector data source to open geometry styling.
        </div>
      ) : (
        <>
          <div className="visualization-panel__dataset" title={selectedDataset.name}>{selectedDataset.name}</div>

          {loading && <div className="visualization-panel__loading"><span className="visualization-panel__spinner" />Profiling geometry and fields…</div>}
          {error && !loading && <div className="visualization-panel__error">Could not load visualization profile: {error}</div>}

          {manifest && !loading && (
            <>
              <div className="visualization-panel__summary visualization-panel__summary--v3">
                <div><strong>{compactFeatureCount(allCount)}</strong><span>Features</span></div>
                <div><strong>{[pointCount, lineCount, polygonCount].filter((count) => count > 0).length}</strong><span>Geometry types</span></div>
                <div><strong>{manifest.source_format.toUpperCase()}</strong><span>Source</span></div>
              </div>

              <div className="visualization-target-block">
                <div className="visualization-target-block__label">Target geometry</div>
                <div className="visualization-target-grid" role="group" aria-label="Target geometry">
                  {targetOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={target === option.value ? "is-active" : ""}
                      disabled={option.count === 0}
                      onClick={() => onTargetChange(option.value)}
                    >
                      <strong>{option.label}</strong>
                      <span>{compactFeatureCount(option.count)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="visualization-style-card visualization-style-card--geometry">
                <div className="visualization-style-card__head">
                  <div><span>Style</span><strong>{targetOptions.find((option) => option.value === target)?.label ?? "Geometry"}</strong></div>
                  <button type="button" onClick={onResetStyle}>Reset</button>
                </div>

                {layerLoading && <div className="visualization-layer-runtime"><span className="visualization-panel__spinner" />Loading visible geometry…</div>}
                {layerError && <div className="visualization-panel__error">Geometry load failed: {layerError}</div>}
                {!layerLoading && !layerError && (
                  <div className="visualization-layer-runtime visualization-layer-runtime--ok">
                    <b>{preview.loadedCount.toLocaleString()}</b> features loaded in the current view
                    {layerTruncated && <em>Zoom in to load every visible feature</em>}
                  </div>
                )}

                <div className="visualization-mode-grid">
                  {modeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={mode === option.value ? "visualization-mode-grid__active" : ""}
                      disabled={!option.enabled}
                      onClick={() => onModeChange(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {mode !== "default" && (
                  <label className="visualization-field">
                    <span>Field</span>
                    {manifestGroups ? (
                      <GroupedFieldList
                        tree={manifestGroups}
                        selected={selectedField}
                        onSelect={(selection) => onFieldChange(selection.fieldName)}
                        renderFieldMeta={(candidate) =>
                          `${candidate.populated_count.toLocaleString()} populated`
                        }
                        emptyLabel="No compatible field"
                      />
                    ) : (
                      <select value={field ?? ""} onChange={(event) => onFieldChange(event.target.value || null)} disabled={eligibleFields.length === 0}>
                        {eligibleFields.length === 0 && <option value="">No compatible field</option>}
                        {eligibleFields.map((candidate) => (
                          <option key={candidate.name} value={candidate.name}>
                            {candidate.name} · {candidate.populated_count.toLocaleString()} populated
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                )}

                {mode === "category" && field && <div className="visualization-preview-list">{preview.categories.length > 0 ? preview.categories.map((item) => <div key={item.value}><span style={{ background: item.color }} /><strong title={item.value}>{item.value}</strong><small>{item.count.toLocaleString()}</small></div>) : <p>No categorical values are loaded in this view.</p>}</div>}
                {mode === "numeric" && field && <div className="visualization-numeric-preview"><div className="visualization-numeric-preview__bar" /><div><span>{preview.numericMin === null ? "No value" : preview.numericMin.toLocaleString()}</span><span>{preview.numericMax === null ? "No value" : preview.numericMax.toLocaleString()}</span></div></div>}
                {mode === "missing-data" && field && <div className="visualization-missing-preview"><span><i className="visualization-missing-preview__available" />Available {preview.availableCount.toLocaleString()}</span><span><i className="visualization-missing-preview__missing" />Missing {preview.missingCount.toLocaleString()}</span></div>}

                <label className="visualization-slider"><span><b>Opacity</b><em>{Math.round(opacity * 100)}%</em></span><input type="range" min="0.15" max="1" step="0.05" value={opacity} onChange={(event) => onOpacityChange(Number(event.target.value))} /></label>
                {target === "point" && <label className="visualization-slider"><span><b>Point size</b><em>{pointSize}px</em></span><input type="range" min="3" max="24" step="1" value={pointSize} onChange={(event) => onPointSizeChange(Number(event.target.value))} /></label>}
                {(target === "line" || target === "polygon") && <label className="visualization-slider"><span><b>{target === "polygon" ? "Outline width" : "Line width"}</b><em>{lineWidth.toFixed(1)}px</em></span><input type="range" min="1" max="12" step="0.5" value={lineWidth} onChange={(event) => onLineWidthChange(Number(event.target.value))} /></label>}
              </div>

              {manifest.warnings.length > 0 && <details className="visualization-panel__limitations"><summary>Data limitations</summary>{manifest.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
              {truncated && <div className="visualization-base-cap-note">The base preview is capped at 5,000 features. Geometry styling uses live viewport requests.</div>}
            </>
          )}
        </>
      )}
    </section>
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

const DETECTION_MODE_LABEL: Record<Exclude<DetectionMode, null>, string> = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manholes",
};

function MapControls({
  basemap,
  onChangeBasemap,
  status,
  detectionMode,
  onToggleDetectionMode,
  aiOverlayEnabled,
  onToggleAiOverlay,
  onAiIconClick,
  streetPickMode,
  onToggleStreetView,
  placemarkMode,
  onTogglePlacemark,
  placemarkCount,
  myPlacesOpen,
  onToggleMyPlaces,
  coordinateSearchOpen,
  onToggleCoordinateSearch,
  referenceLayers,
  onToggleReferenceLayer,
}: {
  basemap: Basemap;
  onChangeBasemap: (b: Basemap) => void;
  status: ViewportStatus;
  detectionMode: DetectionMode;
  onToggleDetectionMode: (mode: Exclude<DetectionMode, null>) => void;
  aiOverlayEnabled: boolean;
  onToggleAiOverlay: () => void;
  /** Fires on every AI Detection icon click (not just the first) — the
   * caller owns the one-time-per-session gating; this is just a
   * notification. */
  onAiIconClick?: () => void;
  streetPickMode: boolean;
  onToggleStreetView: () => void;
  placemarkMode: boolean;
  onTogglePlacemark: () => void;
  placemarkCount: number;
  myPlacesOpen: boolean;
  onToggleMyPlaces: () => void;
  coordinateSearchOpen: boolean;
  onToggleCoordinateSearch: () => void;
  referenceLayers: ReferenceLayerVisibility;
  onToggleReferenceLayer: (key: keyof ReferenceLayerVisibility, visible: boolean) => void;
}) {
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [activeToolsSection, setActiveToolsSection] = useState<"map" | "location" | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  // AI Detection is an independent floating control, not a tools-menu
  // category — its own open state, own outside-click handling, own anchor.
  // Three explicit, independent states (not derived from one another):
  // showDetectionList (the Poles/Drains/Manholes picker), showDetectionStatus
  // (the "AI Detection : X  ON/OFF" card), and detectionMode/aiOverlayEnabled
  // (props — the actual selection/activation, untouched by this UI layer).
  // Keeping list-visibility and status-visibility as separate booleans
  // (rather than deriving one from "not the other") is what lets a single
  // icon click close the status card without also opening the list.
  const [showDetectionList, setShowDetectionList] = useState(false);
  const [showDetectionStatus, setShowDetectionStatus] = useState(false);
  const [aiOffsetY, setAiOffsetY] = useState(0);
  const toolsControlRef = useRef<HTMLDivElement | null>(null);
  const toolsToggleRef = useRef<HTMLButtonElement | null>(null);
  const toolsPanelsRef = useRef<HTMLDivElement | null>(null);
  const aiWrapRef = useRef<HTMLDivElement | null>(null);
  const portalMenuRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const aiMenuDrag = useDraggableMapPanel<HTMLDivElement>({
    storageKey: "davangere.ai-detection-position",
    boundary: "viewport",
    initialPosition: menuPos ? { x: menuPos.left, y: menuPos.top } : null,
    margin: 8,
    disabled: isMobile,
  });

  // MapLibre's WebGL canvas can composite on its own GPU layer that paints
  // over positioned overlay siblings regardless of z-index/stacking-context
  // CSS (confirmed via elementFromPoint — the canvas rendered on top of a
  // correctly z-indexed, position:absolute dropdown). Portaling the open
  // dropdown straight to document.body, positioned with fixed coordinates
  // computed from the AI icon's own rect, sidesteps the map's DOM subtree
  // entirely instead of fighting that stacking behavior. Opens beside the
  // icon (right edge + spacing), not below it.
  useEffect(() => {
    if (!showDetectionList || !aiWrapRef.current) return;
    const rect = aiWrapRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.top, left: rect.right + 8 });
  }, [showDetectionList]);

  useEffect(() => {
    if (!toolsMenuOpen) {
      setActiveToolsSection(null);
      return;
    }

    const onToolsOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (toolsControlRef.current?.contains(target)) return;
      // The AI mode-picker dropdown is portaled to document.body (outside
      // toolsControlRef) — a click inside it is unrelated to this menu and
      // must not close it, since AI Detection is now fully independent.
      if (portalMenuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".reference-layers-menu")) return;
      setToolsMenuOpen(false);
      setActiveToolsSection(null);
    };

    const onToolsEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setToolsMenuOpen(false);
      setActiveToolsSection(null);
    };

    document.addEventListener("mousedown", onToolsOutside);
    document.addEventListener("keydown", onToolsEscape);
    return () => {
      document.removeEventListener("mousedown", onToolsOutside);
      document.removeEventListener("keydown", onToolsEscape);
    };
  }, [toolsMenuOpen]);

  // AI Detection's own outside-click/escape handling — fully independent of
  // the tools menu's. The dropdown is portaled to document.body, so it's
  // exempted the same way the tools menu exempts it above. Dismissing the
  // list this way (without picking anything) returns to whatever was
  // showing before it opened — the status card reappears if a mode is
  // already active, same as before the list was split into its own state.
  // The AI icon's own click handler is deliberately different (see
  // handleAiIconClick) and does not restore the status card this way.
  useEffect(() => {
    if (!showDetectionList) return;
    const onAiOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (aiWrapRef.current?.contains(target)) return;
      if (portalMenuRef.current?.contains(target)) return;
      setShowDetectionList(false);
      setShowDetectionStatus(Boolean(detectionMode));
    };
    const onAiEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShowDetectionList(false);
      setShowDetectionStatus(Boolean(detectionMode));
    };
    document.addEventListener("mousedown", onAiOutside);
    document.addEventListener("keydown", onAiEscape);
    return () => {
      document.removeEventListener("mousedown", onAiOutside);
      document.removeEventListener("keydown", onAiEscape);
    };
  }, [showDetectionList, detectionMode]);

  // Strict 3-state controller for the AI icon. The two surfaces (list,
  // status card) must never flip together in one click — closing the status
  // card must NOT also open the list (that only happens on the next click).
  // The priority is exactly: (1) close status card if visible, (2) close
  // list if visible, (3) otherwise open the list.
  const handleAiIconClick = () => {
    onAiIconClick?.();
    if (showDetectionStatus) {
      setShowDetectionStatus(false);
      return;
    }
    if (showDetectionList) {
      setShowDetectionList(false);
      return;
    }
    setShowDetectionList(true);
  };

  // Keeps the AI icon flush under the toggle when the tools menu is closed,
  // and dynamically pushes it below the expanded panel's real rendered
  // height when the menu opens — measured from actual DOM rects and the
  // container's own CSS gap (not a hardcoded offset), so it stays correct
  // regardless of which tool category's content is showing.
  const measureAiOffset = useCallback(() => {
    const container = toolsControlRef.current;
    const toggleEl = toolsToggleRef.current;
    if (!container || !toggleEl) return;
    const gap = parseFloat(getComputedStyle(container).rowGap || getComputedStyle(container).gap || "0") || 0;
    const containerTop = container.getBoundingClientRect().top;
    let referenceBottom = toggleEl.getBoundingClientRect().bottom;
    if (toolsMenuOpen && toolsPanelsRef.current) {
      const panelsBottom = toolsPanelsRef.current.getBoundingClientRect().bottom;
      if (panelsBottom > referenceBottom) referenceBottom = panelsBottom;
    }
    setAiOffsetY(referenceBottom - containerTop + gap);
  }, [toolsMenuOpen]);

  useLayoutEffect(() => {
    measureAiOffset();
  }, [measureAiOffset, activeToolsSection]);

  useEffect(() => {
    const panelsEl = toolsPanelsRef.current;
    if (!panelsEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureAiOffset());
    observer.observe(panelsEl);
    return () => observer.disconnect();
  }, [measureAiOffset]);

  const hasActiveTool = Boolean(
    detectionMode ||
    streetPickMode ||
    placemarkMode ||
    myPlacesOpen ||
    coordinateSearchOpen ||
    Object.values(referenceLayers).some(Boolean)
  );

  return (
    <>
      <div className="feature-count" data-testid="viewport-status">
        {status.loading ? "loading..." : `${status.count} features`}
      </div>
      <div className="map-tools" ref={toolsControlRef}>
        <button
          type="button"
          ref={toolsToggleRef}
          className={`map-tools__toggle${toolsMenuOpen ? " map-tools__toggle--open" : ""}${hasActiveTool ? " map-tools__toggle--has-active" : ""}`}
          onClick={() => {
            const nextOpen = !toolsMenuOpen;
            setToolsMenuOpen(nextOpen);
            if (!nextOpen) {
              setActiveToolsSection(null);
            }
          }}
          aria-expanded={toolsMenuOpen}
          aria-controls="map-tools-panels"
          aria-label={toolsMenuOpen ? "Close map tools" : "Open map tools"}
          data-testid="map-tools-toggle"
          title={toolsMenuOpen ? "Close tools" : "Open tools"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
          {hasActiveTool && <span className="map-tools__active-dot" aria-hidden="true" />}
        </button>

        <div
          id="map-tools-panels"
          ref={toolsPanelsRef}
          className={`map-tools__panels${toolsMenuOpen ? " map-tools__panels--open" : ""}`}
          aria-label="Map tools"
          aria-hidden={!toolsMenuOpen}
        >
          <div className="map-tools__category-rail" aria-label="Tool categories">
            <button
              type="button"
              className={`map-tools__category-btn${activeToolsSection === "map" ? " map-tools__category-btn--active" : ""}`}
              onClick={() => {
                setActiveToolsSection((current) => current === "map" ? null : "map");
              }}
              aria-label="Map view tools"
              aria-expanded={activeToolsSection === "map"}
              title="Map view"
              data-testid="map-tools-category-map"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" width="19" height="19" aria-hidden="true">
                <path d="m3 6 5-3 8 3 5-3v15l-5 3-8-3-5 3V6Z" />
                <path d="M8 3v15M16 6v15" />
              </svg>
            </button>

            <button
              type="button"
              className={`map-tools__category-btn${activeToolsSection === "location" ? " map-tools__category-btn--active" : ""}${(streetPickMode || placemarkMode || myPlacesOpen || coordinateSearchOpen || Object.values(referenceLayers).some(Boolean)) ? " map-tools__category-btn--has-active" : ""}`}
              onClick={() => {
                setActiveToolsSection((current) => current === "location" ? null : "location");
              }}
              aria-label="Location and map tools"
              aria-expanded={activeToolsSection === "location"}
              title="Location tools"
              data-testid="map-tools-category-location"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" width="19" height="19" aria-hidden="true">
                <path d="M12 22s7-6.1 7-13a7 7 0 1 0-14 0c0 6.9 7 13 7 13Z" />
                <circle cx="12" cy="9" r="2.2" />
              </svg>
              {(streetPickMode || placemarkMode || myPlacesOpen || coordinateSearchOpen || Object.values(referenceLayers).some(Boolean)) && <span className="map-tools__category-dot" aria-hidden="true" />}
            </button>
          </div>

          <div className="map-tools__content">
          {activeToolsSection === "map" && (
          <div className="map-tools__floating-panel map-tools__floating-panel--map" data-testid="map-view-panel">
            <div className="map-controls map-controls--floating-panel">
              <div className="map-controls__group" data-testid="basemap-toggle">
          <button className={`map-controls__btn${basemap === "street" ? " map-controls__btn--active" : ""}`} onClick={() => onChangeBasemap("street")} data-testid="basemap-street">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ marginRight: 4, verticalAlign: -2 }}>
              <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" />
            </svg>
            <span className="map-controls__btn-label">Map</span>
          </button>
          <button className={`map-controls__btn${basemap === "satellite" ? " map-controls__btn--active" : ""}`} onClick={() => onChangeBasemap("satellite")} data-testid="basemap-satellite">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ marginRight: 4, verticalAlign: -2 }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
            <span className="map-controls__btn-label">Satellite</span>
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
            <span className="map-controls__btn-label">Off</span>
          </button>
              </div>
            </div>
          </div>
          )}

          {activeToolsSection === "location" && (
          <div className="map-tools__floating-panel map-tools__floating-panel--location" data-testid="location-tools-panel">
            <div className="map-controls map-controls--floating-panel map-controls--location-panel">
              <div className="map-controls__group map-controls__group--annotations" data-testid="annotation-controls">
          <button
            type="button"
            className={`map-controls__btn${placemarkMode ? " map-controls__btn--active" : ""}`}
            onClick={onTogglePlacemark}
            data-testid="placemark-tool"
            aria-pressed={placemarkMode}
            title="Place a saved placemark on the map"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15" style={{ marginRight: 4, verticalAlign: -2 }} aria-hidden="true">
              <path d="M12 22s7-6.1 7-13a7 7 0 1 0-14 0c0 6.9 7 13 7 13Z" />
              <circle cx="12" cy="9" r="2.2" />
            </svg>
            <span className="map-controls__btn-label">Placemark</span>
          </button>
          <button
            type="button"
            className={`map-controls__btn${myPlacesOpen ? " map-controls__btn--active" : ""}`}
            onClick={onToggleMyPlaces}
            data-testid="my-places-toggle"
            aria-pressed={myPlacesOpen}
            title="Search and manage saved placemarks"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15" style={{ marginRight: 4, verticalAlign: -2 }} aria-hidden="true">
              <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18.5v-13Z" />
              <path d="M8 3v18M12 8h5M12 12h5" />
            </svg>
            <span className="map-controls__btn-label">My Places{placemarkCount > 0 ? ` · ${placemarkCount}` : ""}</span>
          </button>
          <button
            type="button"
            className={`map-controls__btn${coordinateSearchOpen ? " map-controls__btn--active" : ""}`}
            onClick={onToggleCoordinateSearch}
            data-testid="coordinate-search-toggle"
            aria-pressed={coordinateSearchOpen}
            title="Enter latitude and longitude and fly to the exact location"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15" style={{ marginRight: 4, verticalAlign: -2 }} aria-hidden="true">
              <circle cx="12" cy="12" r="6" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
            </svg>
            Coordinate Search
          </button>
          <ReferenceLayersMenu value={referenceLayers} onChange={onToggleReferenceLayer} />
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
            <span className="map-controls__btn-label">Street View</span>
          </button>
              </div>
            </div>
          </div>
          )}
          </div>
        </div>
        {/* AI Detection: an independent floating control, not a tools-menu
            category. It sits directly below the toggle and dynamically
            slides down (via aiOffsetY, see measureAiOffset) when the tools
            menu expands, but its own panel opens to the right and is never
            gated by toolsMenuOpen/activeToolsSection. */}
        <div
          className="map-tools__ai-wrap"
          ref={aiWrapRef}
          style={{ transform: `translateY(${aiOffsetY}px)` }}
        >
          <button
            type="button"
            className={`map-tools__ai-standalone${(showDetectionList || showDetectionStatus) ? " map-tools__ai-standalone--active" : ""}${detectionMode ? " map-tools__ai-standalone--has-active" : ""}`}
            onClick={handleAiIconClick}
            aria-label="AI detection tools"
            aria-haspopup="true"
            aria-expanded={showDetectionList}
            title="AI detection"
            data-testid="map-tools-category-ai"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="19" height="19" aria-hidden="true">
              <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2Z" />
              <path d="m19 13 .9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9L19 13Z" />
            </svg>
            {detectionMode && <span className="map-tools__category-dot" aria-hidden="true" />}
          </button>

          {showDetectionList && menuPos && createPortal(
            <div
              className="ai-detection-menu"
              data-testid="ai-detection-menu"
              ref={(node) => {
                portalMenuRef.current = node;
                aiMenuDrag.panelRef.current = node;
              }}
              style={{ position: "fixed", top: menuPos.top, left: menuPos.left, ...aiMenuDrag.style }}
              onPointerDown={aiMenuDrag.onDragStart}
            >
              {(["poles", "drains", "manholes"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={`ai-detection-menu__item${detectionMode === mode ? " ai-detection-menu__item--active" : ""}`}
                  onClick={() => {
                    // Always activate the chosen mode — never toggle it off.
                    // onToggleDetectionMode is a toggle, so re-picking the
                    // already-active mode would clear detectionMode and hide
                    // the status card; guard against that so selection is a
                    // pure "set" (matching the spec).
                    if (detectionMode !== mode) {
                      onToggleDetectionMode(mode);
                    }
                    setShowDetectionList(false);
                    setShowDetectionStatus(true);
                  }}
                  data-testid={`detection-mode-${mode}`}
                >
                  {DETECTION_MODE_LABEL[mode]}
                </button>
              ))}
            </div>,
            document.body
          )}

          {/* Persistent status card — its visibility (showDetectionStatus)
              is a fully independent boolean from the list's, not derived
              from "list closed". That decoupling is what lets the AI icon's
              first click close just this card without also opening the
              list (see handleAiIconClick above). Reuses the same
              aiOverlayEnabled/onToggleAiOverlay state as everything else;
              no new or duplicate detection state. */}
          {showDetectionStatus && detectionMode && (
            <div className="ai-status-card" data-testid="ai-status-card">
              <span className="ai-status-card__label">
                AI Detection : {DETECTION_MODE_LABEL[detectionMode]}
              </span>
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
                <span className="map-controls__btn-label">{aiOverlayEnabled ? "ON" : "OFF"}</span>
              </button>
            </div>
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
  // Only show attributes that actually have a value — most survey rows
  // leave many condition/status fields blank, and a tooltip full of "—"
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
    ? { text: "⚠  AI: Recommended for removal", bg: "#ef4444", color: "#fff" }
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
          <div style={{ marginTop: 4, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 8, rowGap: 2, fontFamily: "var(--font-mono)", fontSize: 9, opacity: 0.96 }}>
            <span>Latitude</span><strong style={{ textAlign: "right" }}>{hover.aiDetection.latitude.toFixed(7)}</strong>
            <span>Longitude</span><strong style={{ textAlign: "right" }}>{hover.aiDetection.longitude.toFixed(7)}</strong>
          </div>
        </div>
      )}
      {hover.verification && (
        <div className="map__tooltip-verification">
          <div><span>Original GDB Condition</span><strong>{hover.verification.originalCondition ?? "—"}</strong></div>
          <div><span>Current Condition</span><strong>{hover.verification.currentCondition ?? "—"}</strong></div>
          <div><span>Resolution Status</span><strong>{hover.verification.status?.replaceAll("_", " ") ?? "—"}</strong></div>
          {hover.verification.admin && <div><span>Approved By</span><strong>{hover.verification.admin}</strong></div>}
          {hover.verification.approvedAt && <div><span>Approved Date</span><strong>{new Date(hover.verification.approvedAt).toLocaleString()}</strong></div>}
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

function formatDms(value: number, positiveSuffix: string, negativeSuffix: string): string {
  const suffix = value >= 0 ? positiveSuffix : negativeSuffix;
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFull = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFull);
  const seconds = (minutesFull - minutes) * 60;
  return `${degrees}°${String(minutes).padStart(2, "0")}'${seconds.toFixed(2).padStart(5, "0")}" ${suffix}`;
}

/** Bottom-right status strip: live cursor coordinates plus a fixed-size
 * scale/distance chip. Both boxes share one positioned wrapper so they can
 * never drift apart or overlap independently — the distance box's width
 * never changes with its text ("200 m" vs "2 km"), only the coordinate
 * box's content changes size (as the cursor moves over water/edge cases
 * that shorten the DMS string), which is why the distance box sits fixed
 * on the wrapper's right edge rather than being laid out purely by flex
 * order against a variable-width neighbour. */
function MapStatusBar({
  lngLat,
  scaleLabel,
  datasetName,
  surveyDate,
  elevation,
  eyeAltitudeMeters,
}: {
  lngLat: [number, number] | null;
  scaleLabel: string;
  datasetName: string | null;
  surveyDate: string | null;
  elevation: number | null;
  eyeAltitudeMeters: number;
}) {
  if (!lngLat && !scaleLabel && !datasetName) return null;
  const surveyLabel = surveyDate
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(surveyDate))
    : "—";
  return (
    <div className="map__status-bar map__status-bar--earth" data-testid="map-status-bar">
      <div className="map__status-box map__dataset-readout" title={datasetName ?? "No active dataset"}>
        <span>Survey</span>
        <strong>{surveyLabel}</strong>
      </div>
      {lngLat && (
        <div className="map__status-box map__coord-readout" data-testid="map-coord-readout">
          {formatDms(lngLat[1], "N", "S")}&nbsp;&nbsp;{formatDms(lngLat[0], "E", "W")}
        </div>
      )}
      <div className="map__status-box map__elevation-readout">
        elev&nbsp;{elevation === null ? "—" : `${Math.round(elevation)} m`}
      </div>
      <div className="map__status-box map__eye-altitude-readout">
        eye alt&nbsp;{formatMetricDistance(eyeAltitudeMeters)}
      </div>
      {scaleLabel && (
        <div className="map__status-box map__scale-readout" data-testid="map-scale-readout">
          {scaleLabel}
        </div>
      )}
    </div>
  );
}

/** Google Earth Pro-style zoom control, laid out as a horizontal bar: a "−"
 * button, a draggable slider track, and a "+" button. Purely presentational —
 * the map's zoom is the single source of truth (passed in via `zoom`), and
 * every interaction (click ends, drag, track click) just calls `onChange`;
 * MapCanvas is the one that actually calls `map.setZoom()`. */
function ZoomSlider({
  zoom,
  minZoom,
  maxZoom,
  onChange,
}: {
  zoom: number;
  minZoom: number;
  maxZoom: number;
  onChange: (zoom: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const range = maxZoom - minZoom;
  const fraction = range > 0 ? Math.min(1, Math.max(0, (zoom - minZoom) / range)) : 0;

  const zoomFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return minZoom + t * range;
  };

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const next = zoomFromClientX(e.clientX);
    if (next !== null) onChange(next);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const next = zoomFromClientX(e.clientX);
    if (next !== null) onChange(next);
  };
  const handleTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div className="map-zoom-slider" data-testid="map-zoom-slider">
      <button
        type="button"
        className="map-zoom-slider__btn"
        onClick={() => onChange(Math.max(minZoom, zoom - 1))}
        aria-label="Zoom out"
        data-testid="map-zoom-out"
      >
        −
      </button>
      <div
        ref={trackRef}
        className="map-zoom-slider__track"
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={handleTrackPointerUp}
        role="slider"
        aria-label="Map zoom"
        aria-valuemin={minZoom}
        aria-valuemax={maxZoom}
        aria-valuenow={Math.round(zoom * 10) / 10}
      >
        <div className="map-zoom-slider__fill" style={{ width: `${fraction * 100}%` }} />
        <div className="map-zoom-slider__thumb" style={{ left: `${fraction * 100}%` }} />
      </div>
      <button
        type="button"
        className="map-zoom-slider__btn"
        onClick={() => onChange(Math.min(maxZoom, zoom + 1))}
        aria-label="Zoom in"
        data-testid="map-zoom-in"
      >
        +
      </button>
    </div>
  );
}

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
