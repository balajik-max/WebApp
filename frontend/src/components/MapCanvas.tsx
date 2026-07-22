import { useEffect, useLayoutEffect, useRef, useState, useCallback, useImperativeHandle, useMemo, forwardRef, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import maplibregl, { Map as MLMap, MapMouseEvent, MapLayerMouseEvent, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { fetchFeatureById, fetchFeaturesInViewport, fetchVisualizationLayerFeatures } from "../lib/features";
import type { AiHighlight, FeatureFilter, UrbanFeature, FeatureCollectionResponse } from "../lib/types";
import { ApiError } from "../lib/api";
import { colorForCategory, UNCATEGORIZED_COLOR } from "../lib/categoryColors";
import {
  type DetectionMode,
  DETECTION_MODE_TARGET_CLASSES,
  DETECTION_MODE_ANOMALY_TYPE,
  DETECTION_MODE_LABEL,
} from "../lib/detectionMode";
import {
  fetchDatasets, fetchDatasetBounds, fetchVisualizationManifest,
  type DatasetBounds, type DatasetRow,
  type FeatureTableRow, type LayerFeatureTableFilter,
  type VisualizationFieldGroupTree, type VisualizationFieldProfile, type VisualizationLayerGroupNode,
  type VisualizationLayerManifest, type VisualizationManifest,
  fetchAnalyticsFeatures, fetchDrainEncroachment, fetchAnomalies, fetchRoadInspection, runSpatialAudit, updateAnomalyStatus, fetchAllClassMappings,
  type DrainEncroachmentReport, type RoadInspection, type RoadInspectionFeature, type SpatialAnomaly, type AnomalyStatus,
} from "../lib/workflow";
import { AttributeTable } from "./AttributeTable";
import { PanoramaViewer } from "./PanoramaViewer";
import { CylinderPanoramaViewer } from "./CylinderPanoramaViewer";
import { GoogleStreetView } from "./GoogleStreetView";
import { LookAroundCompass, DEFAULT_MAP_PITCH, MAX_MAP_PITCH } from "./LookAroundCompass";
import { DataSourceSelector } from "./DataSourceSelector";
import { SupportingFilesImport } from "./WardReportPanel";
import { AnomalyAlertCard } from "./AnomalyAlertCard";
import { RoadInspectionCard } from "./RoadInspectionCard";
import { QuickAnalysisPanel } from "./QuickAnalysisPanel";
import { QuickAnalysisMapDashboard, type ManholeConnectionDetail, type QuickAnalysisTool } from "./QuickAnalysisMapDashboard";
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
import { useLanguage } from "../context/LanguageContext";
import {
  ROAD_CENTERLINE_RAW_CATEGORIES,
  ROAD_SURFACE_RAW_CATEGORIES,
  isRoadCenterlineFeature,
  isRoadSurfaceFeature,
} from "../lib/roadCompatibility";

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
  if (d.file_type === "geotiff" || (d.file_type === "lidar" || d.file_type === "las") || d.file_type === "image") return false;
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
  // Road findings belong to Quick Analysis/Road Inspection. The existing
  // AE -> AEE -> Commissioner remediation API currently supports poles,
  // drains, and manholes only, so keep the workflow context deliberately
  // narrower than the general map detection mode.
  detectionMode: Exclude<DetectionMode, null | "roads">;
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
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  /** Lets the page hide global AI/report floating buttons in Quick Analysis. */
  onQuickAnalysisActiveChange?: (active: boolean) => void;
  /** Refetch point-verification state after an Admin or Architect update. */
  refreshToken?: number;

  /** Whether the mobile Data Sources drawer is open — lifted up to
   * WorkspaceLayout so the topbar's menu button can open it. Ignored on
   * desktop, where the sidebar is always visible. */
  commandCenterMobileOpen: boolean;
  onCommandCenterMobileOpenChange: (open: boolean) => void;

  /** Session-scoped Spatial Audit trigger guard — owned by WorkspaceLayout
   * (like the props above) so it survives this component unmounting on tab
   * navigation. `spatialAuditRequested` flips true the instant the AI
   * Detection icon is first clicked; `spatialAuditExecutedRef` flips true
   * once the audit has actually been kicked off for an active dataset. */
  spatialAuditRequested: boolean;
  setSpatialAuditRequested: (v: boolean) => void;
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
// Only used when a real parcel-tile service is configured. Without one,
// cadastral mode reuses the same OSM tiles as Street (guaranteed full local
// coverage, unlike Esri's raster services which run out of LOD in smaller
// towns) and gets a cream tint via raster paint properties instead — see
// CADASTRAL_OSM_PAINT below.
const CADASTRAL_TILE_URL = import.meta.env.VITE_CADASTRAL_TILE_URL?.trim() ?? "";
const CADASTRAL_TILE_ATTRIBUTION = import.meta.env.VITE_CADASTRAL_ATTRIBUTION?.trim() ?? "";
const cadastralOpacityRaw = Number(import.meta.env.VITE_CADASTRAL_OPACITY ?? "0.96");
const CADASTRAL_TILE_OPACITY = Number.isFinite(cadastralOpacityRaw)
  ? Math.min(1, Math.max(0, cadastralOpacityRaw))
  : 0.96;
const cadastralMaxZoomRaw = Number(import.meta.env.VITE_CADASTRAL_MAX_ZOOM ?? "22");
const CADASTRAL_TILE_MAX_ZOOM = Number.isFinite(cadastralMaxZoomRaw)
  ? Math.max(0, Math.min(24, cadastralMaxZoomRaw))
  : 22;
// Warm, slightly muted cream tint applied to the shared OSM layer in
// cadastral mode so it reads as a distinct basemap from plain Street even
// though both pull the same reliable tiles.
const CADASTRAL_OSM_PAINT = {
  "raster-hue-rotate": 15,
  "raster-saturation": -0.15,
  "raster-brightness-min": 0.15,
  "raster-contrast": -0.05,
} as const;
const STREET_OSM_PAINT = {
  "raster-hue-rotate": 0,
  "raster-saturation": 0,
  "raster-brightness-min": 0,
  "raster-contrast": 0,
} as const;
const CADASTRAL_TILE_SOURCE = "cadastral-official-tiles";
const CADASTRAL_TILE_LAYER = "cadastral-official-raster";
const HAS_EXTERNAL_CADASTRAL_TILES = CADASTRAL_TILE_URL.length > 0;

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

// Digital Surface / Terrain Model rasters. GeoTIFFs have no dedicated
// dataset "type" field for these — they are single-band elevation rasters
// distinguished by name, matching the backend's own established heuristic
// (see manhole_recommend.py: `name ILIKE '%dtm%'` / `%dsm%`). LiDAR uploads
// need no name match: LidarReader's preview is *always* a Digital Surface
// Model (highest return per grid cell) by construction. DSM/DTM must
// always render in Enhanced mode and expose no per-dataset display settings.
export function isElevationRasterDataset(dataset: Pick<DatasetRow, "file_type" | "name">): boolean {
  if ((dataset.file_type === "lidar" || dataset.file_type === "las")) return true;
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
    ...(HAS_EXTERNAL_CADASTRAL_TILES ? {
      [CADASTRAL_TILE_SOURCE]: {
        type: "raster",
        tiles: [CADASTRAL_TILE_URL],
        tileSize: 256,
        maxzoom: CADASTRAL_TILE_MAX_ZOOM,
        ...(CADASTRAL_TILE_ATTRIBUTION ? { attribution: CADASTRAL_TILE_ATTRIBUTION } : {}),
      } satisfies maplibregl.RasterSourceSpecification,
    } : {}),
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
    ...(HAS_EXTERNAL_CADASTRAL_TILES ? [{
      id: CADASTRAL_TILE_LAYER,
      type: "raster",
      source: CADASTRAL_TILE_SOURCE,
      minzoom: 0,
      maxzoom: 24,
      layout: { visibility: "none" },
      paint: {
        "raster-opacity": CADASTRAL_TILE_OPACITY,
      },
    } satisfies maplibregl.LayerSpecification] : []),
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

type Basemap = "cadastral" | "street" | "satellite" | "off";

const FEATURE_SOURCE = "urban-features";
const LAYER_POINTS = "urban-features-points";
const LAYER_POINTS_CADASTRAL = "urban-features-points-cadastral";
const LAYER_POINTS_CADASTRAL_HIT = "urban-features-points-cadastral-hit";
const LAYER_LINES = "urban-features-lines";
const LAYER_LINES_CADASTRAL = "urban-features-lines-cadastral";
const LAYER_POLY_FILL = "urban-features-poly-fill";
const LAYER_POLY_FILL_CADASTRAL = "urban-features-poly-fill-cadastral";
const LAYER_POLY_OUTLINE = "urban-features-poly-outline";
const LAYER_POLY_OUTLINE_CADASTRAL = "urban-features-poly-outline-cadastral";
const LAYER_PHOTOS = "urban-features-photos";
const PHOTO_ICON_ID = "site-photo-icon";
const CADASTRAL_POINT_ICON_DEFAULT = "cadastral-point-default";
const CADASTRAL_POINT_ICON_TREE = "cadastral-point-tree";
const CADASTRAL_POINT_ICON_PALM = "cadastral-point-palm";
const CADASTRAL_POINT_ICON_POLE = "cadastral-point-pole";
const CADASTRAL_POINT_ICON_POWER_LIGHT_POLE = "cadastral-point-power-light-pole";
const CADASTRAL_POINT_ICON_LIGHT = "cadastral-point-light";
const CADASTRAL_POINT_ICON_SOLAR_LIGHT = "cadastral-point-solar-light";
const CADASTRAL_POINT_ICON_MANHOLE = "cadastral-point-manhole";
const CADASTRAL_POINT_ICON_CAMERA = "cadastral-point-camera";
const CADASTRAL_POINT_ICON_LEVEL = "cadastral-point-level";
const CADASTRAL_POINT_ICON_LANDMARK = "cadastral-point-landmark";
const CADASTRAL_POINT_ICON_TRANSFORMER = "cadastral-point-transformer";
const CADASTRAL_POINT_ICON_SIGN = "cadastral-point-sign";
const CADASTRAL_POINT_ICON_GATE = "cadastral-point-gate";
const CADASTRAL_POINT_ICON_WATER = "cadastral-point-water";
const CADASTRAL_POINT_ICON_WATER_TANK = "cadastral-point-water-tank";
const CADASTRAL_POINT_ICON_WATER_PUMP = "cadastral-point-water-pump";
const CADASTRAL_POINT_ICON_TEMPLE = "cadastral-point-temple";
const REFERENCE_SURVEY_BUILDING_LABELS = "reference-survey-building-labels";
const REFERENCE_SURVEY_ROAD_LABELS = "reference-survey-road-labels";

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

// Road Inspection keeps its selected centerline visibly distinct while the
// user reviews the server-side road report.
const ROAD_INSPECTION_SOURCE = "road-inspection-focus";
const LAYER_ROAD_INSPECTION = "road-inspection-focus-line";
const ROAD_INSPECTION_ASSETS_SOURCE = "road-inspection-assets";
const LAYER_ROAD_INSPECTION_ASSETS_FILL = "road-inspection-assets-fill";
const LAYER_ROAD_INSPECTION_ASSETS_LINE = "road-inspection-assets-line";
const LAYER_ROAD_INSPECTION_ASSETS_POINT = "road-inspection-assets-point";
const ROAD_INSPECTION_WIDTH_SOURCE = "road-inspection-width";
const LAYER_ROAD_INSPECTION_WIDTH = "road-inspection-width-line";

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
const CADASTRAL_DUPLICATE_POINT_PROP = "__cadastral_duplicate_point";

const CADASTRAL_POINT_HIT_FILTER: maplibregl.FilterSpecification = [
  "all",
  POINT_BASE_FILTER,
  ["!=", ["get", CADASTRAL_DUPLICATE_POINT_PROP], true],
];

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

function normalizeCategoryName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function isBuildingCategory(category: string | null | undefined): boolean {
  return normalizeCategoryName(category ?? "").startsWith("building");
}

function featurePointCoordinate(feature: GeoJSON.Feature): [number, number] | null {
  if (feature.geometry?.type !== "Point") return null;
  const [longitude, latitude] = feature.geometry.coordinates;
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null;
}

function featureLabel(feature: GeoJSON.Feature): string | null {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const attributes = (properties.attributes ?? {}) as Record<string, unknown>;
  return featureDisplayLabel(properties.label, attributes);
}

function isNamedTempleLandmark(feature: GeoJSON.Feature): boolean {
  const category = normalizeCategoryName(String((feature.properties ?? {}).category ?? ""));
  const label = featureLabel(feature);
  return category === "landmark" && Boolean(label && normalizeCategoryName(label).includes("temple"));
}

function isGenericTemplePoint(feature: GeoJSON.Feature): boolean {
  const category = normalizeCategoryName(String((feature.properties ?? {}).category ?? ""));
  const label = featureLabel(feature);
  return category === "temple" && (!label || normalizeCategoryName(label) === "temple");
}

const CADASTRAL_CATEGORY_ALLOWLIST = new Set([
  "road centerline",
  "concrete road",
  "concrete edge",
  "wall",
  "fence",
  "power line",
  "kerb top",
  "kerb bottom",
  "sidewalk",
  "hand rail",
  "road hump",
  "arch",
  "planter box",
  "building",
  "building roof extension",
  "building extenstions",
  "building extensions",
  "building ruin",
  "building underconstruction",
  "building under construction",
  "temple",
  "shed",
  "coconut tree",
  "other tree",
  "power pole with light",
  "power pole",
  "light pole",
  "solar light",
  "cc camera",
  "road sign",
  "road sign single pole",
  "road sign double pole",
  "transformer",
  "high mast",
  "flag pole",
  "gate",
  "monument",
  "water tank",
  "water pump",
  "overhead tank",
  "microwave tower",
  "inlet",
  "gully",
  "manhole",
  "landmark",
  "drain levels",
  "parcel",
  "parcels",
  "cadastral",
  "cadastral parcel",
  "property boundary",
  "plot",
  "plot boundary",
  "site boundary",
  "survey parcel",
  "revenue parcel",
  "revenue map",
  "compound wall",
].map(normalizeCategoryName));

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


function withRoadCompatibilityVisibility(
  base: maplibregl.FilterSpecification,
  includeSurfaces: boolean,
  extraCategories: Set<string> = new Set()
): maplibregl.FilterSpecification {
  const canonicalClasses = includeSurfaces
    ? ["Road_Centerline", "Road_Surface"]
    : ["Road_Centerline"];
  const rawCategories = includeSurfaces
    ? [...ROAD_CENTERLINE_RAW_CATEGORIES, ...ROAD_SURFACE_RAW_CATEGORIES]
    : [...ROAD_CENTERLINE_RAW_CATEGORIES];
  const canonicalMatch: maplibregl.ExpressionSpecification = [
    "in", ["coalesce", ["get", "canonical_class"], "Unclassified"], ["literal", canonicalClasses],
  ];
  const rawCategoryMatch: maplibregl.ExpressionSpecification = [
    "in", ["downcase", ["coalesce", ["get", "category"], ""]], ["literal", rawCategories],
  ];
  const roadMatch: maplibregl.ExpressionSpecification = ["any", canonicalMatch, rawCategoryMatch];
  if (extraCategories.size === 0) {
    return ["all", base, roadMatch] as unknown as maplibregl.FilterSpecification;
  }
  const extraMatch: maplibregl.ExpressionSpecification = [
    "in", ["coalesce", ["get", "category"], "uncategorized"], ["literal", Array.from(extraCategories)],
  ];
  return ["all", base, ["any", roadMatch, extraMatch]] as unknown as maplibregl.FilterSpecification;
}

// Separate GeoJSON source + layers for AI highlight overlays so they sit
// on top of the normal feature layers without touching the original data.
const AI_HIGHLIGHT_SOURCE = "ai-highlight";
const LAYER_AI_REDUNDANT = "ai-highlight-redundant";
const LAYER_AI_NEEDED = "ai-highlight-needed";

const AI_REDUNDANT_COLOR = "#ef4444"; // red
const AI_NEEDED_COLOR = "#22c55e";    // green

// Quick Analysis is not an AI overlay. It has its own lightweight survey
// marker source, used by the Drain card for red circle-and-cross markers.
const QUICK_ANALYSIS_MARKER_SOURCE = "quick-analysis-survey-markers";
const QUICK_ANALYSIS_DRAIN_SOURCE = "quick-analysis-drain-network";
const QUICK_ANALYSIS_MANHOLE_SOURCE = "quick-analysis-drain-manholes";
const QUICK_ANALYSIS_ENCROACHMENT_SOURCE = "quick-analysis-building-encroachments";
const LAYER_QUICK_ANALYSIS_DRAIN_CORRIDOR = "quick-analysis-drain-corridor";
const LAYER_QUICK_ANALYSIS_DRAIN_LINE = "quick-analysis-drain-line";
const LAYER_QUICK_ANALYSIS_DRAIN_RING = "quick-analysis-drain-ring";
const LAYER_QUICK_ANALYSIS_DRAIN_CROSS = "quick-analysis-drain-cross";
const LAYER_QUICK_ANALYSIS_MANHOLE_GLOW = "quick-analysis-manhole-glow";
const LAYER_QUICK_ANALYSIS_MANHOLE = "quick-analysis-manhole";
const LAYER_QUICK_ANALYSIS_ENCROACHMENT_FILL = "quick-analysis-encroachment-fill";
const LAYER_QUICK_ANALYSIS_ENCROACHMENT_OUTLINE = "quick-analysis-encroachment-outline";
const LAYER_QUICK_ANALYSIS_ENCROACHMENT_CROSSING_HALO = "quick-analysis-encroachment-crossing-halo";
const LAYER_QUICK_ANALYSIS_ENCROACHMENT_CROSSING = "quick-analysis-encroachment-crossing";
const QUICK_ANALYSIS_MANHOLE_CONNECTION_SOURCE = "quick-analysis-manhole-connections";
const LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HIT = "quick-analysis-manhole-connection-hit";
const LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HALO = "quick-analysis-manhole-connection-halo";
const LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_GOOD = "quick-analysis-manhole-connection-good";
const LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_WARNING = "quick-analysis-manhole-connection-warning";
const LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_CRITICAL = "quick-analysis-manhole-connection-critical";
const LAYER_QUICK_ANALYSIS_MANHOLE_FLOW_ARROWS = "quick-analysis-manhole-flow-arrows";
const QUICK_ANALYSIS_MANHOLE_UNCONNECTED_SOURCE = "quick-analysis-manhole-unconnected";
const LAYER_QUICK_ANALYSIS_MANHOLE_UNCONNECTED_HALO = "quick-analysis-manhole-unconnected-halo";
const LAYER_QUICK_ANALYSIS_MANHOLE_UNCONNECTED_RING = "quick-analysis-manhole-unconnected-ring";
const QUICK_ANALYSIS_FLOW_ARROW_GOOD = "quick-analysis-flow-arrow-good";
const QUICK_ANALYSIS_FLOW_ARROW_WARNING = "quick-analysis-flow-arrow-warning";
const QUICK_ANALYSIS_FLOW_ARROW_CRITICAL = "quick-analysis-flow-arrow-critical";

const QUICK_ANALYSIS_POWER_LINE_SOURCE = "quick-analysis-power-lines-source";
const LAYER_QUICK_ANALYSIS_POWER_LINE = "quick-analysis-power-line";

const QUICK_ANALYSIS_WATER_LINE_SOURCE = "quick-analysis-water-lines-source";
const LAYER_QUICK_ANALYSIS_WATER_LINE = "quick-analysis-water-line";

const QUICK_ANALYSIS_TELECOM_LINE_SOURCE = "quick-analysis-telecom-lines-source";
const LAYER_QUICK_ANALYSIS_TELECOM_LINE = "quick-analysis-telecom-line";

// Spatial Audit Engine — persisted findings (pole redundancy, drain
// encroachment, manhole status), one shared point layer colored by the
// backend-assigned `color` field directly (red/yellow/green already
// decided server-side, no client bucket math needed).
const ANOMALY_SOURCE = "spatial-anomalies";
const LAYER_ANOMALIES = "spatial-anomalies-points";
// Road-width narrowing is drawn as a coloured LINE (the affected carriageway
// stretch, like a traffic segment) rather than vertex dots — see
// ANOMALY_ROAD_LINE_SOURCE below, populated from each finding's
// `affected_line_wkt` metadata. The point layer explicitly excludes this type.
const ANOMALY_ROAD_LINE_SOURCE = "spatial-anomalies-road-lines";
const LAYER_ANOMALIES_ROAD = "spatial-anomalies-road-lines";

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
const MANHOLE_HEATMAP_SOURCE = "manhole-heatmap-source";
const LAYER_MANHOLE_HEATMAP = "manhole-heatmap-layer";
const LAYER_MANHOLE_HEATMAP_POINTS = "manhole-heatmap-points";
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

/** Compact right-pointing arrow (shaft + head) used for flow direction.
 * It is icon-based rather than text-field because this map style has no
 * glyph endpoint. */
function buildFlowArrowImageData(fillColor = MANHOLE_ROUTE_COLOR): ImageData {
  const w = 32, h = 20;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Arrow shaft: this is intentionally visible, so the marker reads as an
  // arrow rather than the triangle-only marker used previously.
  ctx.beginPath();
  ctx.moveTo(3, 10);
  ctx.lineTo(21, 10);
  ctx.strokeStyle = "#0b1013";
  ctx.lineWidth = 4.4;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(3, 10);
  ctx.lineTo(21, 10);
  ctx.strokeStyle = fillColor;
  ctx.lineWidth = 2.3;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(18, 3);
  ctx.lineTo(29, 10);
  ctx.lineTo(18, 17);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.strokeStyle = "#0b1013";
  ctx.lineWidth = 1.8;
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, w, h);
}

// buildFlowArrowheadImageData removed — all arrows now use buildFlowArrowImageData (shaft + head).

function quickAnalysisConnectionDetail(
  route: AiAnswer["routes"][number],
  index: number,
): ManholeConnectionDetail {
  // The backend also raises rainy_season_closed when elevation is missing.
  // That is an uncertainty (yellow), not proof of a bad connection (red).
  // Reserve red for a confirmed-flow connection that is explicitly flagged
  // for attention; keep unconfirmed/road-assisted paths yellow.
  const critical = route.rainy_season_closed === true && route.flow_confirmed === true;
  const warning = !route.flow_confirmed || route.route_basis !== "sewage_line" || route.rainy_season_closed === true;
  const status = critical ? "critical" : warning ? "warning" : "good";
  const statusLabel = critical
    ? "Needs attention"
    : warning
      ? route.flow_confirmed ? "Road-assisted connection" : "Flow verification required"
      : "Verified connection";
  return {
    id: `${route.from_id}:${route.to_id ?? "unconnected"}:${index}`,
    fromId: route.from_id,
    toId: route.to_id,
    status,
    statusLabel,
    flowConfirmed: route.flow_confirmed === true,
    elevationSource: route.elevation_source ?? null,
    routeBasis: route.route_basis ?? null,
    rainySeasonClosed: critical,
    pipeMaterial: route.pipe_spec.material,
    pipeDiameterMm: route.pipe_spec.diameter_mm,
    slope: route.pipe_spec.slope,
  };
}

type CadastralPointIconKind =
  | "default"
  | "tree"
  | "palm"
  | "pole"
  | "power-pole"
  | "power-light-pole"
  | "light"
  | "light-pole"
  | "high-mast"
  | "solar-light"
  | "manhole"
  | "inlet"
  | "gully"
  | "camera"
  | "level"
  | "landmark"
  | "monument"
  | "transformer"
  | "tower"
  | "flag-pole"
  | "sign"
  | "gate"
  | "water"
  | "water-tank"
  | "overhead-tank"
  | "water-pump"
  | "temple";

function buildCadastralPointIconImageData(kind: CadastralPointIconKind): ImageData {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const stroke = "#0f172a";
  const softStroke = "#475569";

  const strokeOnly = (width = 2.5, color = stroke) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  switch (kind) {
    case "tree": {
      ctx.beginPath();
      ctx.moveTo(24, 30);
      ctx.lineTo(24, 38);
      strokeOnly(2.6, "#7c4a24");
      ctx.beginPath();
      ctx.arc(17, 21, 7.2, 0, Math.PI * 2);
      ctx.arc(31, 21, 7.2, 0, Math.PI * 2);
      ctx.arc(24, 14, 8.4, 0, Math.PI * 2);
      ctx.fillStyle = "#4a9350";
      ctx.fill();
      strokeOnly(1.8, "#215226");
      break;
    }
    case "palm": {
      ctx.beginPath();
      ctx.moveTo(24, 15);
      ctx.quadraticCurveTo(20, 24, 24, 35);
      strokeOnly(2.2, "#7c4a24");
      const frondAngles = [-70, -35, -8, 20, 55];
      for (const deg of frondAngles) {
        const rad = (deg * Math.PI) / 180;
        const tipX = 24 + Math.sin(rad) * 13;
        const tipY = 15 - Math.cos(rad) * 10;
        ctx.beginPath();
        ctx.moveTo(24, 15);
        ctx.quadraticCurveTo(24 + Math.sin(rad) * 7, 12 - Math.cos(rad) * 6, tipX, tipY);
        strokeOnly(3.2, "#4a9350");
      }
      break;
    }
    case "pole":
    case "power-pole": {
      // High crossarm power pole carrying insulator pins
      ctx.beginPath();
      ctx.moveTo(24, 10);
      ctx.lineTo(24, 37);
      strokeOnly(2.2, softStroke);
      // Top main crossarm
      ctx.beginPath();
      ctx.moveTo(15, 16);
      ctx.lineTo(33, 16);
      strokeOnly(2.0, "#334155");
      // Secondary lower crossarm
      ctx.beginPath();
      ctx.moveTo(18, 22);
      ctx.lineTo(30, 22);
      strokeOnly(1.8, "#475569");
      // 3 Ceramic Insulators on top crossarm
      for (const x of [16, 24, 32]) {
        ctx.beginPath();
        ctx.arc(x, 13, 2.0, 0, Math.PI * 2);
        ctx.fillStyle = "#e2e8f0";
        ctx.fill();
        strokeOnly(1.2, "#0f172a");
      }
      break;
    }
    case "power-light-pole": {
      // Power pole with crossarm + streetlight fixture
      ctx.beginPath();
      ctx.moveTo(22, 10);
      ctx.lineTo(22, 37);
      strokeOnly(2.2, softStroke);
      // Crossarm
      ctx.beginPath();
      ctx.moveTo(14, 16);
      ctx.lineTo(30, 16);
      strokeOnly(2.0, "#334155");
      // Insulators
      for (const x of [15, 22, 29]) {
        ctx.beginPath();
        ctx.arc(x, 13, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = "#e2e8f0";
        ctx.fill();
        strokeOnly(1.1, "#0f172a");
      }
      // Arm extending right with glowing street light
      ctx.beginPath();
      ctx.moveTo(22, 21);
      ctx.quadraticCurveTo(30, 20, 34, 24);
      strokeOnly(1.8, "#475569");
      // Glowing Lamp head
      ctx.beginPath();
      ctx.arc(34, 25, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = "#fbbf24";
      ctx.fill();
      strokeOnly(1.4, "#b45309");
      break;
    }
    case "light":
    case "light-pole": {
      // Curved modern arch streetlight post
      ctx.beginPath();
      ctx.moveTo(20, 37);
      ctx.lineTo(20, 15);
      ctx.quadraticCurveTo(20, 10, 29, 11);
      strokeOnly(2.2, softStroke);
      // Lamp head cap
      ctx.beginPath();
      ctx.ellipse(30, 13, 3.8, 2.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#cbd5e1";
      ctx.fill();
      strokeOnly(1.3, "#334155");
      // Bright glowing light bulb
      ctx.beginPath();
      ctx.arc(30, 16, 3.0, 0, Math.PI * 2);
      ctx.fillStyle = "#fde047";
      ctx.fill();
      strokeOnly(1.3, "#ca8a04");
      break;
    }
    case "solar-light": {
      // Straight pole with tilted solar PV panel on top + LED module below
      ctx.beginPath();
      ctx.moveTo(24, 15);
      ctx.lineTo(24, 37);
      strokeOnly(2.2, softStroke);
      // Tilted Solar Panel box on top
      ctx.save();
      ctx.translate(24, 11);
      ctx.rotate(-0.25);
      ctx.beginPath();
      roundRectPath(ctx, -9, -4, 18, 8, 1);
      ctx.fillStyle = "#0284c7";
      ctx.fill();
      strokeOnly(1.4, "#0284c7");
      // Panel grid lines
      ctx.beginPath();
      ctx.moveTo(-3, -4);
      ctx.lineTo(-3, 4);
      ctx.moveTo(3, -4);
      ctx.lineTo(3, 4);
      strokeOnly(1.0, "#38bdf8");
      ctx.restore();
      // LED Light fixture below panel
      ctx.beginPath();
      ctx.moveTo(24, 18);
      ctx.lineTo(30, 20);
      strokeOnly(1.6, softStroke);
      ctx.beginPath();
      ctx.arc(31, 21, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = "#38bdf8";
      ctx.fill();
      strokeOnly(1.2, "#0369a1");
      break;
    }
    case "manhole": {
      ctx.beginPath();
      ctx.arc(24, 24, 6.4, 0, Math.PI * 2);
      ctx.fillStyle = "#8a3a2d";
      ctx.fill();
      strokeOnly(1.6, "#3b241d");
      ctx.beginPath();
      ctx.arc(24, 24, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = "#f5d0c5";
      ctx.fill();
      break;
    }
    case "camera": {
      ctx.beginPath();
      ctx.moveTo(24, 16);
      ctx.lineTo(24, 35);
      strokeOnly(1.7, softStroke);
      ctx.fillStyle = "#ffffff";
      roundRectPath(ctx, 16, 20, 16, 10, 3);
      ctx.fill();
      strokeOnly(1.4);
      ctx.beginPath();
      ctx.arc(24, 25, 3, 0, Math.PI * 2);
      strokeOnly(1.4);
      ctx.beginPath();
      ctx.moveTo(19, 20);
      ctx.lineTo(21, 18);
      ctx.lineTo(27, 18);
      ctx.lineTo(29, 20);
      ctx.closePath();
      ctx.fillStyle = "#111827";
      ctx.fill();
      strokeOnly(1.4);
      break;
    }
    case "level": {
      ctx.beginPath();
      ctx.moveTo(24, 14);
      ctx.lineTo(24, 32);
      strokeOnly(1.7, softStroke);
      ctx.beginPath();
      ctx.moveTo(20, 18);
      ctx.lineTo(24, 14);
      ctx.lineTo(28, 18);
      strokeOnly(1.5, softStroke);
      ctx.beginPath();
      ctx.moveTo(17, 28);
      ctx.lineTo(31, 28);
      strokeOnly(1.5, "#38bdf8");
      ctx.beginPath();
      ctx.arc(24, 35, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = "#cbd5e1";
      ctx.fill();
      strokeOnly(1.3, softStroke);
      break;
    }
    case "landmark": {
      ctx.beginPath();
      const points = 4;
      const outer = 8.4;
      const inner = 3.8;
      for (let i = 0; i < points * 2; i += 1) {
        const angle = (-Math.PI / 2) + (i * Math.PI / points);
        const radius = i % 2 === 0 ? outer : inner;
        const x = 24 + Math.cos(angle) * radius;
        const y = 24 + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = "#d97706";
      ctx.fill();
      strokeOnly(1.5, "#7c2d12");
      break;
    }
    case "transformer": {
      // High voltage golden-yellow transformer cabinet with red lightning bolt
      ctx.beginPath();
      roundRectPath(ctx, 15, 14, 18, 18, 2);
      ctx.fillStyle = "#f59e0b";
      ctx.fill();
      strokeOnly(1.8, "#78350f");
      // Side cooling fins lines
      for (const y of [18, 22, 26]) {
        ctx.beginPath();
        ctx.moveTo(12, y);
        ctx.lineTo(15, y);
        ctx.moveTo(33, y);
        ctx.lineTo(36, y);
        strokeOnly(1.4, "#475569");
      }
      // High-voltage lightning bolt in center
      ctx.beginPath();
      ctx.moveTo(25, 17);
      ctx.lineTo(21, 23);
      ctx.lineTo(24, 23);
      ctx.lineTo(22, 29);
      ctx.lineTo(27, 22);
      ctx.lineTo(24, 22);
      ctx.closePath();
      ctx.fillStyle = "#dc2626";
      ctx.fill();
      strokeOnly(1.0, "#7f1d1d");
      break;
    }
    case "sign": {
      ctx.beginPath();
      ctx.moveTo(24, 15);
      ctx.lineTo(24, 35);
      strokeOnly(1.6, softStroke);
      ctx.beginPath();
      ctx.moveTo(24, 11);
      ctx.lineTo(30, 17);
      ctx.lineTo(24, 23);
      ctx.lineTo(18, 17);
      ctx.closePath();
      ctx.fillStyle = "#f8e36b";
      ctx.fill();
      strokeOnly(1.4);
      break;
    }
    case "gate": {
      ctx.beginPath();
      ctx.moveTo(16, 34);
      ctx.lineTo(16, 17);
      ctx.lineTo(32, 17);
      ctx.lineTo(32, 34);
      strokeOnly(1.7, "#7c2d12");
      ctx.beginPath();
      ctx.moveTo(24, 17);
      ctx.lineTo(24, 34);
      ctx.moveTo(20, 23);
      ctx.lineTo(20, 34);
      ctx.moveTo(28, 23);
      ctx.lineTo(28, 34);
      strokeOnly(1.3, "#b45309");
      break;
    }
    case "water":
    case "water-tank": {
      // Cylinder water storage tank with legs and water wave
      ctx.beginPath();
      roundRectPath(ctx, 15, 14, 18, 14, 3);
      ctx.fillStyle = "#0284c7";
      ctx.fill();
      strokeOnly(1.6, "#0c4a6e");
      // Water level highlight line
      ctx.beginPath();
      ctx.moveTo(17, 20);
      ctx.quadraticCurveTo(24, 23, 31, 20);
      strokeOnly(1.3, "#7dd3fc");
      // Legs
      ctx.beginPath();
      ctx.moveTo(17, 28);
      ctx.lineTo(17, 36);
      ctx.moveTo(31, 28);
      ctx.lineTo(31, 36);
      strokeOnly(1.6, softStroke);
      break;
    }
    case "water-pump": {
      // Hydro pump unit icon with water droplet
      ctx.beginPath();
      ctx.arc(24, 22, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = "#0284c7";
      ctx.fill();
      strokeOnly(1.6, "#0c4a6e");
      // Inlet & outlet pipe stubs
      ctx.beginPath();
      ctx.moveTo(12, 22);
      ctx.lineTo(16.5, 22);
      ctx.moveTo(31.5, 22);
      ctx.lineTo(36, 22);
      ctx.moveTo(24, 29.5);
      ctx.lineTo(24, 35);
      strokeOnly(2.2, "#0369a1");
      // Inner droplet shape
      ctx.beginPath();
      ctx.arc(24, 23, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#bae6fd";
      ctx.fill();
      break;
    }
    case "temple": {
      ctx.beginPath();
      ctx.moveTo(24, 11);
      ctx.lineTo(17, 18);
      ctx.lineTo(31, 18);
      ctx.closePath();
      ctx.fillStyle = "#d97706";
      ctx.fill();
      strokeOnly(1.5, "#7c2d12");
      ctx.beginPath();
      ctx.rect(17, 18, 14, 10);
      ctx.fillStyle = "#fde68a";
      ctx.fill();
      strokeOnly(1.5, "#7c2d12");
      ctx.beginPath();
      ctx.moveTo(20, 28);
      ctx.lineTo(20, 36);
      ctx.moveTo(28, 28);
      ctx.lineTo(28, 36);
      ctx.moveTo(18, 36);
      ctx.lineTo(30, 36);
      strokeOnly(1.4, "#7c2d12");
      break;
    }
    case "high-mast": {
      ctx.beginPath();
      ctx.moveTo(24, 12);
      ctx.lineTo(24, 37);
      strokeOnly(2.4, softStroke);
      ctx.beginPath();
      ctx.ellipse(24, 13, 8, 3, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#cbd5e1";
      ctx.fill();
      strokeOnly(1.4, "#334155");
      for (const x of [16, 21, 27, 32]) {
        ctx.beginPath();
        ctx.arc(x, 16, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fde047";
        ctx.fill();
        strokeOnly(1.2, "#ca8a04");
      }
      break;
    }
    case "tower": {
      ctx.beginPath();
      ctx.moveTo(24, 10);
      ctx.lineTo(15, 37);
      ctx.moveTo(24, 10);
      ctx.lineTo(33, 37);
      strokeOnly(2.0, "#dc2626");
      for (const y of [18, 26, 33]) {
        ctx.beginPath();
        ctx.moveTo(24 - (y - 10) * 0.33, y);
        ctx.lineTo(24 + (y - 10) * 0.33, y);
        strokeOnly(1.6, "#f8fafc");
      }
      ctx.beginPath();
      ctx.arc(24, 9, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "#ef4444";
      ctx.fill();
      strokeOnly(1.2, "#7f1d1d");
      break;
    }
    case "flag-pole": {
      ctx.beginPath();
      ctx.moveTo(18, 10);
      ctx.lineTo(18, 37);
      strokeOnly(2.2, softStroke);
      ctx.beginPath();
      ctx.arc(18, 9, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#f59e0b";
      ctx.fill();
      strokeOnly(1.0, "#78350f");
      ctx.beginPath();
      ctx.moveTo(18, 11);
      ctx.quadraticCurveTo(25, 13, 32, 11);
      ctx.lineTo(32, 22);
      ctx.quadraticCurveTo(25, 24, 18, 22);
      ctx.closePath();
      ctx.fillStyle = "#0284c7";
      ctx.fill();
      strokeOnly(1.4, "#0369a1");
      break;
    }
    case "inlet": {
      ctx.beginPath();
      roundRectPath(ctx, 14, 16, 20, 16, 2);
      ctx.fillStyle = "#475569";
      ctx.fill();
      strokeOnly(1.6, "#0f172a");
      for (const x of [18, 22, 26, 30]) {
        ctx.beginPath();
        ctx.moveTo(x, 17);
        ctx.lineTo(x, 31);
        strokeOnly(1.4, "#0f172a");
      }
      break;
    }
    case "gully": {
      ctx.beginPath();
      roundRectPath(ctx, 15, 15, 18, 18, 2);
      ctx.fillStyle = "#334155";
      ctx.fill();
      strokeOnly(1.6, "#0f172a");
      ctx.beginPath();
      ctx.arc(24, 24, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "#0284c7";
      ctx.fill();
      strokeOnly(1.2, "#0c4a6e");
      break;
    }
    case "overhead-tank": {
      ctx.beginPath();
      roundRectPath(ctx, 14, 10, 20, 14, 3);
      ctx.fillStyle = "#0284c7";
      ctx.fill();
      strokeOnly(1.8, "#0c4a6e");
      ctx.beginPath();
      ctx.moveTo(16, 24);
      ctx.lineTo(14, 37);
      ctx.moveTo(32, 24);
      ctx.lineTo(34, 37);
      ctx.moveTo(16, 26);
      ctx.lineTo(32, 35);
      ctx.moveTo(32, 26);
      ctx.lineTo(16, 35);
      strokeOnly(1.6, softStroke);
      break;
    }
    case "monument": {
      ctx.beginPath();
      ctx.moveTo(24, 10);
      ctx.lineTo(21, 28);
      ctx.lineTo(27, 28);
      ctx.closePath();
      ctx.fillStyle = "#94a3b8";
      ctx.fill();
      strokeOnly(1.6, "#334155");
      ctx.beginPath();
      roundRectPath(ctx, 16, 28, 16, 8, 1);
      ctx.fillStyle = "#64748b";
      ctx.fill();
      strokeOnly(1.6, "#1e293b");
      break;
    }
    default: {
      ctx.beginPath();
      ctx.arc(24, 24, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = "#94a3b8";
      ctx.fill();
      strokeOnly(1.6, softStroke);
      break;
    }
  }

  return ctx.getImageData(0, 0, size, size);
}

function cadastralPointIconExpression(): maplibregl.ExpressionSpecification {
  const categoryExpr: maplibregl.ExpressionSpecification = ["downcase", ["coalesce", ["get", "category"], ""]];
  const labelExpr: maplibregl.ExpressionSpecification = [
    "downcase",
    [
      "coalesce",
      ["get", "label"],
      ["get", "Name", ["get", "attributes"]],
      ["get", "name", ["get", "attributes"]],
      "",
    ],
  ];

  return [
    "case",
    [
      "in",
      categoryExpr,
      ["literal", ["coconut tree"]],
    ],
    CADASTRAL_POINT_ICON_TREE,
    [
      "in",
      categoryExpr,
      ["literal", ["other tree", "tree", "planter box"]],
    ],
    CADASTRAL_POINT_ICON_TREE,
    [
      "in",
      categoryExpr,
      ["literal", ["power pole with light", "light pole", "solar light", "high mast"]],
    ],
    CADASTRAL_POINT_ICON_LIGHT,
    [
      "in",
      categoryExpr,
      ["literal", ["power pole", "flag pole", "microwave tower"]],
    ],
    CADASTRAL_POINT_ICON_POLE,
    [
      "in",
      categoryExpr,
      ["literal", ["transformer"]],
    ],
    CADASTRAL_POINT_ICON_TRANSFORMER,
    [
      "in",
      categoryExpr,
      ["literal", ["road sign", "road sign single pole", "road sign double pole"]],
    ],
    CADASTRAL_POINT_ICON_SIGN,
    [
      "in",
      categoryExpr,
      ["literal", ["gate"]],
    ],
    CADASTRAL_POINT_ICON_GATE,
    [
      "in",
      categoryExpr,
      ["literal", ["water tank", "water pump", "overhead tank"]],
    ],
    CADASTRAL_POINT_ICON_WATER,
    [
      "in",
      categoryExpr,
      ["literal", ["manhole", "inlet", "gully"]],
    ],
    CADASTRAL_POINT_ICON_MANHOLE,
    [
      "in",
      categoryExpr,
      ["literal", ["cc camera"]],
    ],
    CADASTRAL_POINT_ICON_CAMERA,
    [
      "in",
      categoryExpr,
      ["literal", ["drain levels"]],
    ],
    CADASTRAL_POINT_ICON_LEVEL,
    [
      "in",
      categoryExpr,
      ["literal", ["temple"]],
    ],
    CADASTRAL_POINT_ICON_TEMPLE,
    [
      "all",
      ["==", categoryExpr, "landmark"],
      ["in", "temple", labelExpr],
    ],
    CADASTRAL_POINT_ICON_TEMPLE,
    [
      "in",
      categoryExpr,
      ["literal", ["monument", "mionument", "landmark"]],
    ],
    CADASTRAL_POINT_ICON_LANDMARK,
    ["==", ["coalesce", ["get", "canonical_class"], ""], "Vegetation"],
    [
      "match",
      categoryExpr,
      "coconut tree", CADASTRAL_POINT_ICON_PALM,
      CADASTRAL_POINT_ICON_TREE,
    ],
    ["==", ["coalesce", ["get", "canonical_class"], ""], "Illumination_Asset"], CADASTRAL_POINT_ICON_LIGHT,
    ["==", ["coalesce", ["get", "canonical_class"], ""], "Access_Point"], CADASTRAL_POINT_ICON_MANHOLE,
    ["==", ["coalesce", ["get", "canonical_class"], ""], "Utility_Pole"], CADASTRAL_POINT_ICON_POLE,
    ["==", ["coalesce", ["get", "canonical_class"], ""], "Drainage_Level_Point"], CADASTRAL_POINT_ICON_LEVEL,
    ["==", categoryExpr, "cc camera"], CADASTRAL_POINT_ICON_CAMERA,
    ["==", categoryExpr, "landmark"], CADASTRAL_POINT_ICON_LANDMARK,
    CADASTRAL_POINT_ICON_DEFAULT,
  ] as unknown as maplibregl.ExpressionSpecification;
}

function cadastralPointIconSizeExpression(): maplibregl.ExpressionSpecification {
  const categoryExpr: maplibregl.ExpressionSpecification = ["downcase", ["coalesce", ["get", "category"], ""]];
  return [
    "*",
    [
      "interpolate", ["linear"], ["zoom"],
      11, 0.72,
      14, 1.02,
      17, 1.38,
      20, 1.8,
    ],
    [
      "match",
      categoryExpr,
      "manhole", 0.9,
      "inlet", 0.9,
      "gully", 0.9,
      "power pole", 0.95,
      "power pole with light", 0.95,
      "light pole", 0.95,
      "solar light", 0.95,
      "high mast", 1.02,
      "road sign", 1.02,
      "road sign single pole", 1.02,
      "road sign double pole", 1.02,
      "transformer", 1.08,
      "temple", 1.08,
      "landmark", 1.08,
      1,
    ],
  ] as unknown as maplibregl.ExpressionSpecification;
}

function cadastralPointHitRadiusExpression(): maplibregl.ExpressionSpecification {
  return [
    "interpolate", ["linear"], ["zoom"],
    11, 8,
    14, 11,
    17, 15,
    20, 20,
  ] as unknown as maplibregl.ExpressionSpecification;
}

function addCadastralPointIconLayer(
  map: maplibregl.Map,
  visibility: "visible" | "none" = "none"
): void {
  if (map.getLayer(LAYER_POINTS_CADASTRAL)) return;
  map.addLayer({
    id: LAYER_POINTS_CADASTRAL,
    type: "symbol",
    source: FEATURE_SOURCE,
    filter: CADASTRAL_POINT_HIT_FILTER,
    layout: {
      "icon-image": cadastralPointIconExpression(),
      "icon-size": cadastralPointIconSizeExpression(),
      "icon-anchor": "center",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      visibility,
    },
  });
}

function cadastralPointIconKindForFeature(feature: UrbanFeature): CadastralPointIconKind {
  const category = normalizeCategoryName(feature.properties.category ?? "");
  const canonicalClass = feature.properties.canonical_class ?? "";

  if (["coconut tree", "other tree", "tree", "planter box"].includes(category)) return category === "coconut tree" ? "palm" : "tree";
  if (category === "power pole with light") return "power-light-pole";
  if (category === "power pole") return "power-pole";
  if (category === "light pole") return "light-pole";
  if (category === "high mast") return "high-mast";
  if (category === "solar light") return "solar-light";
  if (category === "transformer") return "transformer";
  if (["microwave tower", "tower"].includes(category)) return "tower";
  if (category === "flag pole") return "flag-pole";
  if (["road sign", "road sign single pole", "road sign double pole"].includes(category)) return "sign";
  if (category === "gate") return "gate";
  if (category === "overhead tank") return "overhead-tank";
  if (["water tank", "tank"].includes(category)) return "water-tank";
  if (category === "water pump") return "water-pump";
  if (category === "manhole") return "manhole";
  if (category === "inlet") return "inlet";
  if (category === "gully") return "gully";
  if (category === "cc camera") return "camera";
  if (["drain levels", "chainage", "level"].includes(category)) return "level";
  if (category === "temple") return "temple";
  if (["monument", "mionument"].includes(category)) return "monument";
  if (category === "landmark") return "landmark";

  if (canonicalClass === "Vegetation") return category === "coconut tree" ? "palm" : "tree";
  if (canonicalClass === "Illumination_Asset") return "light-pole";
  if (canonicalClass === "Access_Point") return "manhole";
  if (canonicalClass === "Utility_Pole") return "power-pole";
  if (canonicalClass === "Drainage_Level_Point") return "level";
  return "default";
}

const cadastralPointMarkerImageUrls = new Map<CadastralPointIconKind, string>();

function createCadastralPointMarkerElement(feature: UrbanFeature): HTMLImageElement {
  const kind = cadastralPointIconKindForFeature(feature);
  let imageUrl = cadastralPointMarkerImageUrls.get(kind);
  if (!imageUrl) {
    const image = buildCadastralPointIconImageData(kind);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
    imageUrl = canvas.toDataURL();
    cadastralPointMarkerImageUrls.set(kind, imageUrl);
  }

  const icon = document.createElement("img");
  icon.src = imageUrl;
  icon.alt = "";
  icon.draggable = false;
  icon.decoding = "async";
  icon.className = "cadastral-point-marker";
  icon.style.pointerEvents = "none";
  icon.style.filter = "drop-shadow(0 1px 1px rgba(15,23,42,.45))";
  return icon;
}

function cadastralMarkerSize(zoom: number): number {
  const progress = Math.max(0, Math.min(1, (zoom - 11) / 9));
  return Math.round(24 * (0.72 + progress * (1.8 - 0.72)));
}

function cadastralMarkerMinZoom(feature: UrbanFeature): number {
  switch (cadastralPointIconKindForFeature(feature)) {
    // Names/landmarks/towers are useful while navigating a whole ward.
    case "landmark":
    case "monument":
    case "temple":
    case "tower":
    case "overhead-tank":
      return 15;
    // Tall or civic assets remain useful at street/block scale.
    case "pole":
    case "power-pole":
    case "power-light-pole":
    case "light":
    case "light-pole":
    case "high-mast":
    case "solar-light":
    case "transformer":
    case "flag-pole":
      return 17.5;
    // Small ground/detail assets only appear when user is close enough.
    case "tree":
    case "palm":
      return 19.25;
    case "manhole":
    case "inlet":
    case "gully":
    case "level":
    case "camera":
    case "sign":
    case "gate":
    case "water":
    case "water-tank":
    case "water-pump":
    case "default":
      return 18.5;
  }
}

function applyCadastralMarkerZoom(element: HTMLElement, zoom: number): void {
  const minZoom = Number(element.dataset.minZoom ?? 0);
  element.style.display = zoom >= minZoom ? "" : "none";
}

function roadNameTextExpression(): maplibregl.ExpressionSpecification {
  return [
    "coalesce",
    ["get", "label"],
    ["get", "Road_Name", ["get", "attributes"]],
    ["get", "ROAD_NAME", ["get", "attributes"]],
    ["get", "road_name", ["get", "attributes"]],
    ["get", "RoadName", ["get", "attributes"]],
    ["get", "roadname", ["get", "attributes"]],
    ["get", "Street_Name", ["get", "attributes"]],
    ["get", "street_name", ["get", "attributes"]],
    ["get", "streetname", ["get", "attributes"]],
    ["get", "Name", ["get", "attributes"]],
    ["get", "name", ["get", "attributes"]],
    "",
  ] as unknown as maplibregl.ExpressionSpecification;
}

function buildingIdTextExpression(): maplibregl.ExpressionSpecification {
  return [
    "to-string",
    [
      "coalesce",
      ["get", "building_id", ["get", "attributes"]],
      ["get", "BUILDING_ID", ["get", "attributes"]],
      ["get", "property_id", ["get", "attributes"]],
      ["get", "Property_ID", ["get", "attributes"]],
      ["get", "house_no", ["get", "attributes"]],
      ["get", "House_No", ["get", "attributes"]],
      ["get", "door_no", ["get", "attributes"]],
      ["get", "Door_No", ["get", "attributes"]],
      ["get", "FID", ["get", "attributes"]],
      ["get", "fid", ["get", "attributes"]],
      ["get", "id"],
      "",
    ],
  ] as unknown as maplibregl.ExpressionSpecification;
}

function featureDisplayLabel(rawLabel: unknown, attributes: Record<string, unknown>): string | null {
  const topLevel = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (topLevel && topLevel !== "-") return topLevel;
  const candidates = [
    "Road_Name",
    "ROAD_NAME",
    "road_name",
    "RoadName",
    "roadname",
    "Street_Name",
    "street_name",
    "streetname",
    "Name",
    "name",
    "building_name",
    "BUILDING_NAME",
    "asset_name",
  ];
  for (const key of candidates) {
    const value = attributes[key];
    const text = typeof value === "string" ? value.trim() : "";
    if (text && text !== "-") return text;
  }
  return null;
}

function cadastralLineColorExpression(): maplibregl.ExpressionSpecification {
  const categoryExpr: maplibregl.ExpressionSpecification = ["downcase", ["coalesce", ["get", "category"], ""]];
  return [
    "match",
    categoryExpr,
    "power line", "#78c6e7",
    "concrete road", "#2f2b28",
    "concrete edge", "#4b5563",
    "wall", "#111827",
    "fence", "#6b7280",
    "kerb top", "#7c8796",
    "kerb bottom", "#94a3b8",
    "sidewalk", "#6b7280",
    "hand rail", "#60a5fa",
    "arch", "#7c2d12",
    "road hump", "#475569",
    "planter box", "#84cc16",
    "road centerline", "#475569",
    "#3b3b3b",
  ] as unknown as maplibregl.ExpressionSpecification;
}

function cadastralLineWidthExpression(): maplibregl.ExpressionSpecification {
  const categoryExpr: maplibregl.ExpressionSpecification = ["downcase", ["coalesce", ["get", "category"], ""]];
  return [
    "interpolate", ["linear"], ["zoom"],
    12,
    [
      "match",
      categoryExpr,
      "concrete road", 1.05,
      "power line", 0.9,
      "wall", 1.0,
      "concrete edge", 0.9,
      "arch", 1.1,
      0.72,
    ],
    18,
    [
      "match",
      categoryExpr,
      "concrete road", 1.55,
      "power line", 1.2,
      "wall", 1.45,
      "concrete edge", 1.2,
      "arch", 1.55,
      1.0,
    ],
  ] as unknown as maplibregl.ExpressionSpecification;
}

function cadastralPolygonFillExpression(): maplibregl.ExpressionSpecification {
  const categoryExpr: maplibregl.ExpressionSpecification = ["downcase", ["coalesce", ["get", "category"], ""]];
  return [
    "match",
    categoryExpr,
    "building", "#fffaf0",
    "building extenstions", "#fff4dc",
    "building extensions", "#fff4dc",
    "building roof extension", "#fff4dc",
    "shed", "#faf3d2",
    "temple", "#f6efc1",
    "building ruin", "#f4efe6",
    "building underconstruction", "#f2eee7",
    "building under construction", "#f2eee7",
    "#fffaf0",
  ] as unknown as maplibregl.ExpressionSpecification;
}

function cadastralPolygonOutlineExpression(): maplibregl.ExpressionSpecification {
  const categoryExpr: maplibregl.ExpressionSpecification = ["downcase", ["coalesce", ["get", "category"], ""]];
  return [
    "match",
    categoryExpr,
    "temple", "#7c2d12",
    "shed", "#5b5042",
    "building ruin", "#7c6f64",
    "#262626",
  ] as unknown as maplibregl.ExpressionSpecification;
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
      label: featureDisplayLabel(props.label, attrs),
      category: (props.category as string | null) ?? null,
      severity: Number(props.severity ?? 0),
      canonical_class: (props.canonical_class as string | null) ?? (attrs._canonical_class as string | null) ?? null,
      attributes: attrs,
    },
  };
}

function roadInspectionFeatureToGeoJson(feature: RoadInspectionFeature): GeoJSON.Feature {
  return {
    type: "Feature",
    id: feature.id,
    geometry: feature.geometry,
    properties: {
      id: feature.id,
      dataset_id: feature.dataset_id,
      label: feature.label,
      category: feature.category,
      severity: feature.severity,
      canonical_class: feature.canonical_class,
      attributes: feature.attributes,
      audit_color: feature.audit_color,
    },
  };
}

function pointCoordinatesFromFeature(feature: UrbanFeature): {
  longitude: number;
  latitude: number;
} | null {
  if (feature.geometry.type !== "Point") return null;
  const [longitude, latitude] = feature.geometry.coordinates;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return { longitude, latitude };
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

function isQuickAnalysisDrain(feature: UrbanFeature): boolean {
  return feature.properties.canonical_class === "Drainage_Asset";
}

function quickAnalysisDrainAnchor(feature: UrbanFeature): [number, number] | null {
  const lines = feature.geometry.type === "LineString"
    ? [feature.geometry.coordinates]
    : feature.geometry.type === "MultiLineString"
      ? feature.geometry.coordinates
      : [];
  const segments: Array<{ start: [number, number]; end: [number, number]; length: number }> = [];
  let totalLength = 0;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      const length = haversineDistance(start, end);
      if (!Number.isFinite(length) || length <= 0) continue;
      segments.push({ start, end, length });
      totalLength += length;
    }
  }
  if (segments.length === 0) return lines[0]?.[0] ?? null;
  const midpoint = totalLength / 2;
  let traversed = 0;
  for (const segment of segments) {
    if (traversed + segment.length >= midpoint) {
      const ratio = (midpoint - traversed) / segment.length;
      return [
        segment.start[0] + (segment.end[0] - segment.start[0]) * ratio,
        segment.start[1] + (segment.end[1] - segment.start[1]) * ratio,
      ];
    }
    traversed += segment.length;
  }
  return segments[segments.length - 1].end;
}

/** One red cross marker per actual surveyed drain line. This is deliberately
 * independent of AI findings: it reads the Drainage_Asset survey class. */
function quickAnalysisDrainMarkers(features: UrbanFeature[], selectedFeatureId?: string): GeoJSON.Feature[] {
  return features.flatMap((feature) => {
    if (!isQuickAnalysisDrain(feature)) return [];
    const anchor = quickAnalysisDrainAnchor(feature);
    if (!anchor) return [];
    return [{
      type: "Feature" as const,
      id: feature.properties.id,
      geometry: { type: "Point" as const, coordinates: anchor },
      properties: {
        id: feature.properties.id,
        category: feature.properties.category ?? "Closed Drain",
        label: feature.properties.label ?? "Closed Drain",
        selected: feature.properties.id === selectedFeatureId,
        dimmed: Boolean(selectedFeatureId && feature.properties.id !== selectedFeatureId),
      },
    }];
  });
}

/** Actual surveyed closed-drain geometry for the dedicated Quick Analysis
 * network overlay. This prevents the drains from disappearing into the much
 * denser cadastral parcel/road linework. */
function quickAnalysisDrainLines(features: UrbanFeature[], selectedFeatureId?: string): GeoJSON.Feature[] {
  return features.flatMap((feature) => {
    if (!isQuickAnalysisDrain(feature)) return [];
    if (feature.geometry.type !== "LineString" && feature.geometry.type !== "MultiLineString") return [];
    return [{
      type: "Feature" as const,
      id: feature.properties.id,
      geometry: feature.geometry as GeoJSON.LineString | GeoJSON.MultiLineString,
      properties: {
        ...feature.properties,
        selected: feature.properties.id === selectedFeatureId,
        dimmed: Boolean(selectedFeatureId && feature.properties.id !== selectedFeatureId),
      },
    }];
  });
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

interface QuickAnalysisMapConfig {
  title: string;
  description: string;
}

// Each Quick Analysis card owns the content on the cadastral dashboard. The
// sidebar remains a launcher only; the selected card never replaces it.
const QUICK_ANALYSIS_MAP_CONFIG: Record<string, QuickAnalysisMapConfig> = {
  "drain-encroachment": {
    title: "Drain Encroachment Check",
    description: "All surveyed closed-drain segments marked on the cadastral map.",
  },
  "utility-tracker": {
    title: "Utility Asset Tracker",
    description: "Mapped poles, lighting, water and utility assets.",
  },
  "asset-catalog": {
    title: "Full Asset Catalog",
    description: "All geo-referenced survey features in the active dataset.",
  },
  "condition-overview": {
    title: "Asset Condition Overview",
    description: "Condition and severity signals across mapped infrastructure.",
  },
  "survey-kpis": {
    title: "Survey KPIs",
    description: "Coverage, completeness and survey totals.",
  },
  "manhole-detail": {
    title: "Manhole Detail View",
    description: "Manhole location, condition and pipe attributes.",
  },
  "road-width": {
    title: "Road Width Check",
    description: "Road segments narrowed below the local average, marked on the cadastral map.",
  },
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
  road_width_narrowing: "Road Width Narrowing",
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
  if (!anomaly || !mode || mode === "roads" || (anomaly.color !== "red" && anomaly.color !== "yellow")) return null;
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
  longitude?: number;
  latitude?: number;
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
    sidebarCollapsed = false,
    onToggleSidebar,
    onQuickAnalysisActiveChange,
    refreshToken = 0,
    commandCenterMobileOpen, onCommandCenterMobileOpenChange,
    spatialAuditRequested, setSpatialAuditRequested, spatialAuditExecutedRef,
    spatialAuditStatus, onSpatialAuditStatusChange,
  },
  ref
) {
  const { t } = useLanguage();
  const [sidebarPanel, setSidebarPanel] = useState<"layers" | "analysis">("layers");
  // The card list always remains in the Quick Analysis sidebar. A selected
  const [quickAnalysisCardId, setQuickAnalysisCardId] = useState<string | null>(null);
  const [utilitySubCategory, setUtilitySubCategory] = useState<string>("all");
  const [quickAnalysisFeatures, setQuickAnalysisFeatures] = useState<UrbanFeature[]>([]);
  const [quickAnalysisLoading, setQuickAnalysisLoading] = useState(false);
  const [quickAnalysisError, setQuickAnalysisError] = useState<string | null>(null);
  const [quickDrainEncroachment, setQuickDrainEncroachment] = useState<DrainEncroachmentReport | null>(null);
  const [quickDrainEncroachmentLoading, setQuickDrainEncroachmentLoading] = useState(false);
  const [quickDrainEncroachmentError, setQuickDrainEncroachmentError] = useState<string | null>(null);
  const [quickAnalysisTool, setQuickAnalysisTool] = useState<QuickAnalysisTool>(null);
  const quickAnalysisToolRef = useRef<QuickAnalysisTool>(null);
  const [selectedQuickAnalysisFeature, setSelectedQuickAnalysisFeature] = useState<UrbanFeature | null>(null);
  const quickAnalysisFeatureByIdRef = useRef<Map<string, UrbanFeature>>(new Map());
  const quickAnalysisConnectionByIdRef = useRef<Map<string, ManholeConnectionDetail>>(new Map());
  const quickAnalysisSelectableFeatureIdsRef = useRef<Set<string>>(new Set());
  const quickAnalysisFeatureClickConsumedRef = useRef(false);
  const quickAnalysisFitKeyRef = useRef("");
  const quickAnalysisActiveRef = useRef(false);
  const quickAnalysisPreviousMapRef = useRef<{ basemap: Basemap; detectionMode: DetectionMode; aiOverlayEnabled: boolean } | null>(null);

  useEffect(() => {
    onQuickAnalysisActiveChange?.(sidebarPanel === "analysis" && !sidebarCollapsed);
  }, [onQuickAnalysisActiveChange, sidebarCollapsed, sidebarPanel]);

  useEffect(() => {
    if (!selectedQuickAnalysisFeature) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      setSelectedQuickAnalysisFeature(null);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedQuickAnalysisFeature]);
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
  // `legend` above stays capped at 10 entries for the compact map overlay.
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
  const basemapRef = useRef<Basemap>("street");
  const preCadastralHiddenCategoriesRef = useRef<Set<string> | null>(null);
  const cadastralPresetActiveRef = useRef(false);
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
  // Quick Analysis has its own network result. It is deliberately separate
  // from the on-demand AI Detection network so opening/closing the Manhole
  // Detail card never overwrites a user's regular map workflow.
  const [quickAnalysisManholeNetwork, setQuickAnalysisManholeNetwork] = useState<AiAnswer | null>(null);
  const [quickAnalysisManholeNetworkLoading, setQuickAnalysisManholeNetworkLoading] = useState(false);
  const [quickAnalysisManholeNetworkError, setQuickAnalysisManholeNetworkError] = useState<string | null>(null);
  const [selectedQuickAnalysisConnection, setSelectedQuickAnalysisConnection] = useState<ManholeConnectionDetail | null>(null);
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
  // Road Inspection is deliberately separate from the four category-wide AI
  // modes: it narrows the map to selectable centerlines, then asks the server
  // for findings assigned to exactly one unique road ID.
  const [roadInspectionActive, setRoadInspectionActive] = useState(false);
  const roadInspectionActiveRef = useRef(false);
  const [roadInspectionRoad, setRoadInspectionRoad] = useState<UrbanFeature | null>(null);
  const [roadInspectionReport, setRoadInspectionReport] = useState<RoadInspection | null>(null);
  const [roadInspectionLoading, setRoadInspectionLoading] = useState(false);
  const [roadInspectionError, setRoadInspectionError] = useState<string | null>(null);
  const roadInspectionAbortRef = useRef<AbortController | null>(null);
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
  const cadastralPointMarkersRef = useRef<maplibregl.Marker[]>([]);
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

  // Runtime MapLibre symbol layers have intermittently disappeared after the
  // cadastral road-label style pass. Canvas markers bypass that fragile symbol
  // bucket completely while leaving the invisible MapLibre hit layer in place
  // for the normal hover/click pipeline.
  useEffect(() => {
    const map = mapRef.current;
    for (const marker of cadastralPointMarkersRef.current) marker.remove();
    cadastralPointMarkersRef.current = [];
    if (
      !mapReady
      || !map
      || basemap !== "cadastral"
      || detectionMode
      || roadInspectionActive
      || quickAnalysisCardId === "drain-encroachment"
      || quickAnalysisCardId === "road-width"
    ) return;

    const markers: maplibregl.Marker[] = [];
    cadastralPointMarkersRef.current = markers;
    const visibleFeatures = loadedFeatures.filter((feature) => {
      if (feature.geometry.type !== "Point") return false;
      const category = feature.properties.category ?? "uncategorized";
      const normCat = normalizeCategoryName(category);
      const canon = feature.properties.canonical_class ?? "";

      if (quickAnalysisCardId === "manhole-detail") {
        if (canon !== "Access_Point" && normCat !== "manhole") return false;
      } else if (quickAnalysisCardId === "utility-tracker") {
        const isUtilityPoint = ["power pole", "power pole with light", "light pole", "solar light", "transformer", "high mast", "flag pole", "microwave tower", "tower", "water tank", "water pump", "overhead tank", "cc camera"].includes(normCat)
          || ["Utility_Pole", "Illumination_Asset", "Electrical_Asset", "Hydrological_Asset", "Telecom_Asset", "Security_Asset"].includes(canon);
        if (!isUtilityPoint) return false;

        if (utilitySubCategory && utilitySubCategory !== "all") {
          if (utilitySubCategory === "electricity") {
            const isElec = ["power pole", "power pole with light", "light pole", "solar light", "transformer", "high mast", "flag pole", "microwave tower", "tower"].includes(normCat)
              || ["Utility_Pole", "Illumination_Asset", "Electrical_Asset"].includes(canon);
            if (!isElec) return false;
          } else if (utilitySubCategory === "water") {
            const isWater = ["water tank", "water pump", "overhead tank"].includes(normCat)
              || ["Hydrological_Asset"].includes(canon);
            if (!isWater) return false;
          } else if (utilitySubCategory === "telecom") {
            const isTelecom = ["cc camera"].includes(normCat)
              || ["Telecom_Asset", "Security_Asset"].includes(canon);
            if (!isTelecom) return false;
          } else {
            if (normCat !== utilitySubCategory) return false;
          }
        }
      }

      return category !== "raster_pixel"
        && category !== "site_photo"
        && category !== "3d_vertex"
        && !hiddenCategories.has(category)
        && (feature.properties as unknown as Record<string, unknown>)[CADASTRAL_DUPLICATE_POINT_PROP] !== true;
    });
    let cancelled = false;
    let drawFrame: number | null = null;
    let drawTimer: number | null = null;

    // Do not block first cadastral-tile paint by creating every marker in one
    // synchronous loop. Small animation-frame batches keep pan/zoom responsive.
    const drawMarkers = () => {
      if (cancelled) return;
      const size = cadastralMarkerSize(map.getZoom());
      let index = 0;
      const drawBatch = () => {
        if (cancelled) return;
        const end = Math.min(index + 36, visibleFeatures.length);
        for (; index < end; index++) {
          const feature = visibleFeatures[index];
          const [longitude, latitude] = feature.geometry.coordinates as [number, number];
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
          const element = createCadastralPointMarkerElement(feature);
          element.style.width = `${size}px`;
          element.style.height = `${size}px`;
          // A focused point-analysis card must show its subject at the fitted
          // ward extent. The normal cadastral min-zoom rule is for the busy
          // all-assets map and would hide manholes/utilities here.
          element.dataset.minZoom = String(quickAnalysisCardId ? 0 : cadastralMarkerMinZoom(feature));
          applyCadastralMarkerZoom(element, map.getZoom());
          if (quickAnalysisCardId === "manhole-detail") {
            // Select the exact marker that was clicked. The transparent map
            // hit circles overlap at ward scale and can otherwise return a
            // nearby manhole instead of this one.
            element.style.pointerEvents = "auto";
            element.style.cursor = "pointer";
            element.addEventListener("click", (event) => {
              event.stopPropagation();
              setSelectedQuickAnalysisConnection(null);
              setSelectedQuickAnalysisFeature((current) =>
                current?.properties.id === feature.properties.id ? null : feature
              );
            });
          }
          markers.push(new maplibregl.Marker({ element, anchor: "center" })
            .setLngLat([longitude, latitude])
            .addTo(map));
        }
        if (index < visibleFeatures.length) drawFrame = window.requestAnimationFrame(drawBatch);
      };
      drawBatch();
    };

    // Give MapLibre one paint cycle for cadastral tiles/road labels before icons.
    drawTimer = window.setTimeout(drawMarkers, 80);

    const resizeMarkers = () => {
      const markerSize = `${cadastralMarkerSize(map.getZoom())}px`;
      for (const marker of markers) {
        const element = marker.getElement();
        element.style.width = markerSize;
        element.style.height = markerSize;
        applyCadastralMarkerZoom(element, map.getZoom());
      }
    };
    map.on("zoom", resizeMarkers);
    return () => {
      cancelled = true;
      if (drawTimer !== null) window.clearTimeout(drawTimer);
      if (drawFrame !== null) window.cancelAnimationFrame(drawFrame);
      map.off("zoom", resizeMarkers);
      for (const marker of markers) marker.remove();
      if (cadastralPointMarkersRef.current === markers) cadastralPointMarkersRef.current = [];
    };
  }, [basemap, detectionMode, hiddenCategories, loadedFeatures, mapReady, quickAnalysisCardId, roadInspectionActive, utilitySubCategory]);

  useEffect(() => {
    basemapRef.current = basemap;
  }, [basemap]);

  const applyBasemapVisibility = useCallback((map: maplibregl.Map, next: Basemap) => {
    const showOsm = next === "street" || (next === "cadastral" && !HAS_EXTERNAL_CADASTRAL_TILES);
    map.setLayoutProperty("osm", "visibility", showOsm ? "visible" : "none");
    if (map.getLayer("osm")) {
      const tint = next === "cadastral" ? CADASTRAL_OSM_PAINT : STREET_OSM_PAINT;
      for (const [prop, value] of Object.entries(tint)) {
        map.setPaintProperty("osm", prop, value);
      }
    }
    map.setLayoutProperty("satellite", "visibility", next === "satellite" ? "visible" : "none");
    if (map.getLayer(CADASTRAL_TILE_LAYER)) {
      map.setLayoutProperty(CADASTRAL_TILE_LAYER, "visibility", next === "cadastral" ? "visible" : "none");
    }
    if (map.getLayer(LAYER_POLY_FILL)) {
      map.setLayoutProperty(LAYER_POLY_FILL, "visibility", next === "cadastral" ? "none" : "visible");
    }
    if (map.getLayer(LAYER_POLY_OUTLINE)) {
      map.setLayoutProperty(LAYER_POLY_OUTLINE, "visibility", next === "cadastral" ? "none" : "visible");
    }
    if (map.getLayer(LAYER_LINES)) {
      map.setLayoutProperty(LAYER_LINES, "visibility", next === "cadastral" ? "none" : "visible");
    }
    if (map.getLayer(LAYER_POLY_FILL_CADASTRAL)) {
      map.setLayoutProperty(LAYER_POLY_FILL_CADASTRAL, "visibility", next === "cadastral" ? "visible" : "none");
    }
    if (map.getLayer(LAYER_POLY_OUTLINE_CADASTRAL)) {
      map.setLayoutProperty(LAYER_POLY_OUTLINE_CADASTRAL, "visibility", next === "cadastral" ? "visible" : "none");
    }
    if (map.getLayer(LAYER_LINES_CADASTRAL)) {
      map.setLayoutProperty(LAYER_LINES_CADASTRAL, "visibility", next === "cadastral" ? "visible" : "none");
    }
    if (map.getLayer(LAYER_POINTS)) {
      map.setLayoutProperty(LAYER_POINTS, "visibility", next === "cadastral" ? "none" : "visible");
    }
    if (map.getLayer(LAYER_POINTS_CADASTRAL_HIT)) {
      map.setLayoutProperty(LAYER_POINTS_CADASTRAL_HIT, "visibility", next === "cadastral" ? "visible" : "none");
    }
    if (map.getLayer(LAYER_POINTS_CADASTRAL)) {
      // Visual icons are cached HTML markers; leaving duplicate MapLibre
      // symbols disabled avoids a second icon layout pass during tile load.
      map.setLayoutProperty(LAYER_POINTS_CADASTRAL, "visibility", "none");
    }
    if (map.getLayer(REFERENCE_SURVEY_ROAD_LABELS)) {
      map.setLayoutProperty(REFERENCE_SURVEY_ROAD_LABELS, "visibility", next === "cadastral" ? "visible" : "none");
    }
  }, []);

  const changeBasemap = useCallback((next: Basemap) => {
    const map = mapRef.current;
    if (!map) return;
    setBasemap(next);
    applyBasemapVisibility(map, next);
  }, [applyBasemapVisibility]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    applyBasemapVisibility(map, basemap);
  }, [applyBasemapVisibility, basemap, mapReady]);

  useEffect(() => {
    if (detectionMode || roadInspectionActive || quickAnalysisCardId) return;

    if (basemap !== "cadastral") {
      if (!cadastralPresetActiveRef.current) return;
      cadastralPresetActiveRef.current = false;
      const previous = preCadastralHiddenCategoriesRef.current;
      preCadastralHiddenCategoriesRef.current = null;
      setHiddenCategories(previous ? new Set(previous) : new Set());
      return;
    }

    if (categoryStats.length === 0) return;
    if (!cadastralPresetActiveRef.current) {
      preCadastralHiddenCategoriesRef.current = new Set(hiddenCategories);
    }
    cadastralPresetActiveRef.current = true;

    const nextHidden = new Set(
      categoryStats
        .map((entry) => entry.category)
        .filter((category) => !CADASTRAL_CATEGORY_ALLOWLIST.has(normalizeCategoryName(category)))
    );

    setHiddenCategories((current) => {
      if (
        current.size === nextHidden.size
        && Array.from(nextHidden).every((category) => current.has(category))
      ) {
        return current;
      }
      return nextHidden;
    });
  }, [basemap, categoryStats, detectionMode, hiddenCategories, roadInspectionActive]);

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

    // A named landmark and generic Temple survey point commonly occupy same
    // coordinate. Keep named place only: one icon and one correct hover card.
    const namedTempleLocations = rawFeatures
      .filter(isNamedTempleLandmark)
      .map(featurePointCoordinate)
      .filter((coordinate): coordinate is [number, number] => coordinate !== null);

    // Add internal top-level properties used only by visualization UI.
    // Original attributes remain untouched inside properties.attributes.
    const features = rawFeatures.map((feature) => {
      const properties = (feature.properties ?? {}) as Record<string, unknown>;
      const datasetId = String(properties.dataset_id ?? "");
      const sourceLayer = sourceLayerFromFeature(feature);
      const coordinate = featurePointCoordinate(feature);
      const isDuplicateTemple = coordinate !== null
        && isGenericTemplePoint(feature)
        && namedTempleLocations.some((namedCoordinate) => haversineDistance(coordinate, namedCoordinate) < 14);
      return {
        ...feature,
        properties: {
          ...properties,
          [VIZ_SOURCE_LAYER_PROP]: sourceLayer,
          [VIZ_LAYER_ID_PROP]: visualizationLayerId(datasetId, sourceLayer),
          [CADASTRAL_DUPLICATE_POINT_PROP]: isDuplicateTemple,
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
    if (detectionMode || roadInspectionActive || quickAnalysisCardId) return;
    const hiddenForBase = selectedVisualizationFeatures.length > 0
      ? new Set(selectedVisualizationCompositeIds)
      : new Set<string>();
    if (map.getLayer(LAYER_POLY_FILL)) map.setFilter(LAYER_POLY_FILL, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_POLY_OUTLINE)) map.setFilter(LAYER_POLY_OUTLINE, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_POLY_FILL_CADASTRAL)) map.setFilter(LAYER_POLY_FILL_CADASTRAL, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_POLY_OUTLINE_CADASTRAL)) map.setFilter(LAYER_POLY_OUTLINE_CADASTRAL, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_LINES)) map.setFilter(LAYER_LINES, withFeatureVisibility(LINE_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_LINES_CADASTRAL)) map.setFilter(LAYER_LINES_CADASTRAL, withFeatureVisibility(LINE_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(REFERENCE_SURVEY_ROAD_LABELS)) map.setFilter(REFERENCE_SURVEY_ROAD_LABELS, withFeatureVisibility([
      "all",
      LINE_BASE_FILTER,
      ["==", ["coalesce", ["get", "canonical_class"], ""], "Road_Centerline"],
    ] as unknown as maplibregl.FilterSpecification, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_POINTS)) map.setFilter(LAYER_POINTS, withFeatureVisibility(POINT_BASE_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_POINTS_CADASTRAL_HIT)) map.setFilter(LAYER_POINTS_CADASTRAL_HIT, withFeatureVisibility(CADASTRAL_POINT_HIT_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_POINTS_CADASTRAL)) map.setFilter(LAYER_POINTS_CADASTRAL, withFeatureVisibility(CADASTRAL_POINT_HIT_FILTER, hiddenCategories, hiddenForBase));
    if (map.getLayer(LAYER_PHOTOS)) map.setFilter(LAYER_PHOTOS, withFeatureVisibility(PHOTO_BASE_FILTER, hiddenCategories, hiddenForBase));

    // The selected geometry is rendered in a dedicated overlay. It must obey
    // the same Category Visibility controls as the shared/base layers so both
    // individual category toggles and Hide all work consistently.
    const noHiddenVisualizationLayers = new Set<string>();
    if (map.getLayer(VIZ_SELECTED_POLY_FILL)) map.setFilter(VIZ_SELECTED_POLY_FILL, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, noHiddenVisualizationLayers));
    if (map.getLayer(VIZ_SELECTED_POLY_OUTLINE)) map.setFilter(VIZ_SELECTED_POLY_OUTLINE, withFeatureVisibility(POLY_BASE_FILTER, hiddenCategories, noHiddenVisualizationLayers));
    if (map.getLayer(VIZ_SELECTED_LINES)) map.setFilter(VIZ_SELECTED_LINES, withFeatureVisibility(LINE_BASE_FILTER, hiddenCategories, noHiddenVisualizationLayers));
    if (map.getLayer(VIZ_SELECTED_POINTS)) map.setFilter(VIZ_SELECTED_POINTS, withFeatureVisibility(POINT_BASE_FILTER, hiddenCategories, noHiddenVisualizationLayers));
  }, [mapReady, hiddenCategories, detectionMode, quickAnalysisCardId, roadInspectionActive, selectedVisualizationCompositeIds, selectedVisualizationFeatures.length]);

  // Each Quick Analysis card owns a focused cadastral view. Drain keeps only
  // building context + drain lines; utility and manhole views keep building
  // context + their relevant point assets. Catalog/KPI cards retain the full
  // survey. None of these filters reuse AI Detection state.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !quickAnalysisCardId) return;
    if (!["drain-encroachment", "utility-tracker", "manhole-detail", "road-width"].includes(quickAnalysisCardId)) return;
    const buildingFilter: maplibregl.FilterSpecification = [
      "all", POLY_BASE_FILTER,
      ["==", ["coalesce", ["get", "canonical_class"], ""], "Building"],
    ];
    const hideAll: maplibregl.FilterSpecification = ["==", ["get", "id"], "__quick_analysis_none__"];
    if (map.getLayer(LAYER_POLY_FILL)) map.setFilter(LAYER_POLY_FILL, buildingFilter);
    if (map.getLayer(LAYER_POLY_OUTLINE)) map.setFilter(LAYER_POLY_OUTLINE, buildingFilter);
    if (map.getLayer(LAYER_POLY_FILL_CADASTRAL)) map.setFilter(LAYER_POLY_FILL_CADASTRAL, buildingFilter);
    if (map.getLayer(LAYER_POLY_OUTLINE_CADASTRAL)) map.setFilter(LAYER_POLY_OUTLINE_CADASTRAL, buildingFilter);
    if (quickAnalysisCardId === "drain-encroachment") {
      const drainFilter: maplibregl.FilterSpecification = [
        "all", LINE_BASE_FILTER,
        ["==", ["coalesce", ["get", "canonical_class"], ""], "Drainage_Asset"],
      ];
      if (map.getLayer(LAYER_LINES)) map.setFilter(LAYER_LINES, drainFilter);
      if (map.getLayer(LAYER_LINES_CADASTRAL)) map.setFilter(LAYER_LINES_CADASTRAL, drainFilter);
      if (map.getLayer(LAYER_POINTS)) map.setFilter(LAYER_POINTS, hideAll);
      if (map.getLayer(LAYER_POINTS_CADASTRAL_HIT)) map.setFilter(LAYER_POINTS_CADASTRAL_HIT, hideAll);
      if (map.getLayer(LAYER_POINTS_CADASTRAL)) map.setFilter(LAYER_POINTS_CADASTRAL, hideAll);
      if (map.getLayer(REFERENCE_SURVEY_ROAD_LABELS)) map.setFilter(REFERENCE_SURVEY_ROAD_LABELS, hideAll);
      return;
    }

    if (quickAnalysisCardId === "road-width") {
      const roadFilter = withRoadCompatibilityVisibility(LINE_BASE_FILTER, true);
      if (map.getLayer(LAYER_LINES)) map.setFilter(LAYER_LINES, roadFilter);
      if (map.getLayer(LAYER_LINES_CADASTRAL)) map.setFilter(LAYER_LINES_CADASTRAL, roadFilter);
      if (map.getLayer(LAYER_POINTS)) map.setFilter(LAYER_POINTS, hideAll);
      if (map.getLayer(LAYER_POINTS_CADASTRAL_HIT)) map.setFilter(LAYER_POINTS_CADASTRAL_HIT, hideAll);
      if (map.getLayer(LAYER_POINTS_CADASTRAL)) map.setFilter(LAYER_POINTS_CADASTRAL, hideAll);
      if (map.getLayer(REFERENCE_SURVEY_ROAD_LABELS)) map.setFilter(REFERENCE_SURVEY_ROAD_LABELS, hideAll);
      return;
    }

    const targetClasses = quickAnalysisCardId === "manhole-detail"
      ? ["Access_Point"]
      : ["Access_Point", "Illumination_Asset", "Utility_Pole"];
    const targetPoints: maplibregl.FilterSpecification = [
      "all", CADASTRAL_POINT_HIT_FILTER,
      ["in", ["coalesce", ["get", "canonical_class"], ""], ["literal", targetClasses]],
    ];
    if (map.getLayer(LAYER_LINES)) map.setFilter(LAYER_LINES, hideAll);
    if (map.getLayer(LAYER_LINES_CADASTRAL)) map.setFilter(LAYER_LINES_CADASTRAL, hideAll);
    if (map.getLayer(LAYER_POINTS)) map.setFilter(LAYER_POINTS, targetPoints);
    if (map.getLayer(LAYER_POINTS_CADASTRAL_HIT)) map.setFilter(LAYER_POINTS_CADASTRAL_HIT, targetPoints);
    if (map.getLayer(LAYER_POINTS_CADASTRAL)) map.setFilter(LAYER_POINTS_CADASTRAL, targetPoints);
    if (map.getLayer(REFERENCE_SURVEY_ROAD_LABELS)) map.setFilter(REFERENCE_SURVEY_ROAD_LABELS, hideAll);
  }, [mapReady, quickAnalysisCardId]);

  // Drain Encroachment fades the cadastral fabric so the drainage network
  // owns the visual hierarchy. Manhole Detail retains that fabric, but gives
  // the single clicked manhole a cyan focus ring. Keeping those states
  // separate prevents the old drain-point styling from leaking into another
  // Quick Analysis card.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const isDrainAnalysis = quickAnalysisCardId === "drain-encroachment";
    const isManholeDetail = quickAnalysisCardId === "manhole-detail";
    const isRoadWidth = quickAnalysisCardId === "road-width";
    const isUtilityTracker = quickAnalysisCardId === "utility-tracker";
    const hasFocusedCadastralSubject = isDrainAnalysis || isManholeDetail || isRoadWidth || isUtilityTracker;
    const activeFeatureId = selectedQuickAnalysisFeature?.properties.id ?? "";
    const selectedManholeId = isManholeDetail
      && selectedQuickAnalysisFeature?.properties.canonical_class === "Access_Point"
      ? selectedQuickAnalysisFeature.properties.id
      : "";
    const hasDrainSelection = isDrainAnalysis && activeFeatureId !== "";
    const hasManholeSelection = selectedManholeId !== "";
    if (map.getLayer("osm")) map.setPaintProperty("osm", "raster-opacity", 1);
    if (map.getLayer(CADASTRAL_TILE_LAYER)) {
      map.setPaintProperty(CADASTRAL_TILE_LAYER, "raster-opacity", CADASTRAL_TILE_OPACITY);
    }
    if (map.getLayer(LAYER_POLY_FILL_CADASTRAL)) {
      map.setPaintProperty(LAYER_POLY_FILL_CADASTRAL, "fill-opacity", hasFocusedCadastralSubject ? 0.02 : 0.18);
    }
    if (map.getLayer(LAYER_POLY_OUTLINE_CADASTRAL)) {
      map.setPaintProperty(LAYER_POLY_OUTLINE_CADASTRAL, "line-opacity", hasFocusedCadastralSubject ? 0.12 : 0.88);
    }
    if (map.getLayer(LAYER_LINES_CADASTRAL)) {
      map.setPaintProperty(
        LAYER_LINES_CADASTRAL,
        "line-color",
        isDrainAnalysis
          ? ["case", ["==", ["get", "id"], activeFeatureId], "#9f1239", "#e11d48"]
          : isRoadWidth
            ? "#94a3b8"
            : cadastralLineColorExpression()
      );
      map.setPaintProperty(
        LAYER_LINES_CADASTRAL,
        "line-width",
        isDrainAnalysis
          ? [
            "case",
            ["==", ["get", "id"], activeFeatureId],
            ["interpolate", ["linear"], ["zoom"], 12, 5, 16, 7, 20, 10],
            ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 4, 20, 6],
          ]
          : cadastralLineWidthExpression()
      );
      map.setPaintProperty(
        LAYER_LINES_CADASTRAL,
        "line-opacity",
        isDrainAnalysis
          ? (hasDrainSelection
              ? ["case", ["==", ["get", "id"], activeFeatureId], 1, 0.2]
              : 0.98)
          : (isRoadWidth || isUtilityTracker)
            ? 0.18
            : 0.82
      );
      if (isDrainAnalysis || isRoadWidth) map.moveLayer(LAYER_LINES_CADASTRAL);
    }
    if (map.getLayer(LAYER_POINTS_CADASTRAL_HIT)) {
      map.setPaintProperty(
        LAYER_POINTS_CADASTRAL_HIT,
        "circle-radius",
        isManholeDetail
          ? [
              "case",
              ["==", ["get", "id"], selectedManholeId],
              ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 16, 20, 21],
              0,
            ]
          : cadastralPointHitRadiusExpression()
      );
      map.setPaintProperty(LAYER_POINTS_CADASTRAL_HIT, "circle-color", isManholeDetail ? "#083344" : "rgba(15,23,42,0.01)");
      map.setPaintProperty(LAYER_POINTS_CADASTRAL_HIT, "circle-stroke-color", isManholeDetail ? "#22d3ee" : "rgba(15,23,42,0.01)");
      map.setPaintProperty(LAYER_POINTS_CADASTRAL_HIT, "circle-stroke-width", isManholeDetail ? 3 : 0);
      map.setPaintProperty(
        LAYER_POINTS_CADASTRAL_HIT,
        "circle-opacity",
        isManholeDetail
          ? ["case", ["==", ["get", "id"], selectedManholeId], 1, 0]
          : 0.01
      );
      map.setPaintProperty(
        LAYER_POINTS_CADASTRAL_HIT,
        "circle-stroke-opacity",
        isManholeDetail
          ? ["case", ["==", ["get", "id"], selectedManholeId], 1, 0]
          : 0
      );
      map.setPaintProperty(LAYER_POINTS_CADASTRAL_HIT, "circle-radius-transition", { duration: 180, delay: 0 });
      map.setPaintProperty(LAYER_POINTS_CADASTRAL_HIT, "circle-opacity-transition", { duration: 180, delay: 0 });
      map.setPaintProperty(LAYER_POINTS_CADASTRAL_HIT, "circle-stroke-opacity-transition", { duration: 180, delay: 0 });
      if (isManholeDetail && hasManholeSelection) map.moveLayer(LAYER_POINTS_CADASTRAL_HIT);
    }
    if (map.getLayer(REFERENCE_SURVEY_ROAD_LABELS)) {
      map.setPaintProperty(REFERENCE_SURVEY_ROAD_LABELS, "text-opacity", isDrainAnalysis ? 0.22 : 1);
    }
    if (map.getLayer(REFERENCE_SURVEY_BUILDING_LABELS)) {
      map.setPaintProperty(REFERENCE_SURVEY_BUILDING_LABELS, "text-opacity", hasFocusedCadastralSubject ? 0 : 1);
    }
    [
      LAYER_QUICK_ANALYSIS_DRAIN_CORRIDOR,
      LAYER_QUICK_ANALYSIS_DRAIN_LINE,
      LAYER_QUICK_ANALYSIS_MANHOLE_GLOW,
      LAYER_QUICK_ANALYSIS_MANHOLE,
    ].forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
    });
  }, [mapReady, quickAnalysisCardId, selectedQuickAnalysisFeature]);

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
    aiOverlayEnabled, basemap, detectionMode, mapReady, visualizationField,
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
    // The Quick Analysis dashboard owns the feature source while it is open.
    // Do not let a concurrent home-map refresh overwrite that independent
    // dataset snapshot.
    if (quickAnalysisActiveRef.current || quickAnalysisCardId) return;
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
  }, [applyFeatureCollection, quickAnalysisCardId]);

  const scheduleFetch = useCallback(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => { debounceRef.current = null; void runFetch(); }, 250);
  }, [runFetch]);

  const addRasterOverlay = useCallback((dataset: DatasetRow) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const overlay = dataset.dataset_metadata?.raster_overlay;
    if ((dataset.file_type !== "geotiff" && (dataset.file_type !== "lidar" && dataset.file_type !== "las")) || !overlay) return;

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

  const wktLineCoords = (wkt: string | undefined): [number, number][] | null => {
    if (!wkt) return null;
    const m = wkt.match(/LINESTRING\s*\(([^)]+)\)/i);
    if (!m) return null;
    return m[1]
      .trim()
      .split(",")
      .map((pair) => {
        const [lon, lat] = pair.trim().split(/\s+/).map(Number);
        return [lon, lat] as [number, number];
      });
  };

  // Road-width findings carry their affected carriageway stretch as WKT in
  // anomaly_metadata. The road line source existed previously but was never
  // populated, so Road AI Detection and Quick Analysis had nothing to draw
  // even when the backend produced valid narrowing findings.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(ANOMALY_ROAD_LINE_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const features = anomalies
      .filter((anomaly) => anomaly.anomaly_type === "road_width_narrowing")
      .map((anomaly) => {
        const coordinates = wktLineCoords(
          typeof anomaly.anomaly_metadata?.affected_line_wkt === "string"
            ? anomaly.anomaly_metadata.affected_line_wkt
            : undefined,
        );
        if (!coordinates || coordinates.length < 2) return null;
        return {
          type: "Feature" as const,
          id: anomaly.id,
          geometry: { type: "LineString" as const, coordinates },
          properties: {
            id: anomaly.id,
            color: anomaly.color,
            anomaly_type: anomaly.anomaly_type,
            status: anomaly.status,
          },
        };
      })
      .filter((feature): feature is NonNullable<typeof feature> => feature !== null);
    source.setData({ type: "FeatureCollection", features });
  }, [mapReady, anomalies]);

  // Keep the clicked road visible as the report card is read, even though
  // Road Inspection intentionally hides all non-road map categories.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(ROAD_INSPECTION_SOURCE) as GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: roadInspectionRoad ? [roadInspectionRoad as unknown as GeoJSON.Feature] : [],
    });
  }, [mapReady, roadInspectionRoad]);

  // The server returns the actual geometry and attributes for every asset
  // assigned to the selected road. Keep these in a dedicated source so the
  // one-road view can show poles, drains, manholes, road edges, and drain
  // evidence together without leaking neighbouring-road features back in.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const assetSource = map.getSource(ROAD_INSPECTION_ASSETS_SOURCE) as GeoJSONSource | undefined;
    assetSource?.setData({
      type: "FeatureCollection",
      features: roadInspectionReport?.features.map(roadInspectionFeatureToGeoJson) ?? [],
    });
    const widthSource = map.getSource(ROAD_INSPECTION_WIDTH_SOURCE) as GeoJSONSource | undefined;
    widthSource?.setData({
      type: "FeatureCollection",
      features: (roadInspectionReport?.issues ?? [])
        .filter((issue) => issue.anomaly_type === "road_width_narrowing")
        .map((issue) => {
          const coordinates = wktLineCoords(issue.anomaly_metadata.affected_line_wkt as string | undefined);
          return coordinates
            ? {
                type: "Feature" as const,
                id: issue.id,
                geometry: { type: "LineString" as const, coordinates },
                properties: { id: issue.id, color: issue.color, anomaly_type: issue.anomaly_type },
              }
            : null;
        })
        .filter((feature): feature is NonNullable<typeof feature> => feature !== null),
    });
  }, [mapReady, roadInspectionReport]);

  useEffect(() => () => roadInspectionAbortRef.current?.abort(), []);

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
    if (quickAnalysisCardId) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
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
    if (routes.length > 0) {
      if (map.getLayer(LAYER_MANHOLE_ROUTES)) map.moveLayer(LAYER_MANHOLE_ROUTES);
      if (map.getLayer(LAYER_MANHOLE_FLOW_ARROWS)) map.moveLayer(LAYER_MANHOLE_FLOW_ARROWS);
    }
  }, [mapReady, manholeRecommendAnswer, quickAnalysisCardId]);

  // Push the current manhole-recommend answer's proposed manhole locations
  // (coverage gaps / disconnected manholes) into their own point layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const src = map.getSource(MANHOLE_POINTS_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    if (quickAnalysisCardId) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
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
  }, [mapReady, manholeRecommendAnswer, quickAnalysisCardId]);

  // Push manholes with no real sewage/drain pipe within reach (network
  // mode) into their own point layer, so "not connected to the sewage
  // line" is a visible fact on the map, not just hidden absence of a line.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const src = map.getSource(MANHOLE_UNCONNECTED_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    if (quickAnalysisCardId) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
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
  }, [mapReady, manholeRecommendAnswer, quickAnalysisCardId]);

  // Keep the ref mirror in sync so applyFeatureCollection (a stable
  // useCallback) always reads the current mode on the next fetch.
  useEffect(() => { detectionModeRef.current = detectionMode; }, [detectionMode]);
  useEffect(() => { roadInspectionActiveRef.current = roadInspectionActive; }, [roadInspectionActive]);
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
    // Quick Analysis owns its own authoritative survey filters. In particular,
    // Drain Encroachment must remain restricted to the 36 Drainage_Asset
    // geometries; the detection-mode cleanup below previously cleared hidden
    // categories and caused the general filter effect to restore every road,
    // power and unclassified line after the drain filter had been applied.
    if (quickAnalysisActiveRef.current || quickAnalysisCardId) return;
    if (!detectionMode && !roadInspectionActive) {
      // Hand control back to the manual checklist filter.
      setHiddenCategories(new Set());
      return;
    }
    const roadMode = roadInspectionActive || detectionMode === "roads";
    const allowed = roadInspectionActive
      ? ["Road_Centerline"]
      : DETECTION_MODE_TARGET_CLASSES[detectionMode!];
    const focusedFilter = (base: maplibregl.FilterSpecification) => roadMode
      ? withRoadCompatibilityVisibility(base, !roadInspectionActive, extraVisibleCategories)
      : withCanonicalVisibility(base, allowed, extraVisibleCategories);
    if (map.getLayer(LAYER_POLY_FILL)) map.setFilter(LAYER_POLY_FILL, focusedFilter(POLY_BASE_FILTER));
    if (map.getLayer(LAYER_POLY_OUTLINE)) map.setFilter(LAYER_POLY_OUTLINE, focusedFilter(POLY_BASE_FILTER));
    if (map.getLayer(LAYER_POLY_FILL_CADASTRAL)) map.setFilter(LAYER_POLY_FILL_CADASTRAL, focusedFilter(POLY_BASE_FILTER));
    if (map.getLayer(LAYER_POLY_OUTLINE_CADASTRAL)) map.setFilter(LAYER_POLY_OUTLINE_CADASTRAL, focusedFilter(POLY_BASE_FILTER));
    if (map.getLayer(LAYER_LINES)) map.setFilter(LAYER_LINES, focusedFilter(LINE_BASE_FILTER));
    if (map.getLayer(LAYER_LINES_CADASTRAL)) map.setFilter(LAYER_LINES_CADASTRAL, focusedFilter(LINE_BASE_FILTER));
    if (map.getLayer(REFERENCE_SURVEY_ROAD_LABELS)) {
      map.setFilter(
        REFERENCE_SURVEY_ROAD_LABELS,
        withRoadCompatibilityVisibility(LINE_BASE_FILTER, false, extraVisibleCategories),
      );
    }
    if (map.getLayer(LAYER_POINTS)) map.setFilter(LAYER_POINTS, focusedFilter(POINT_BASE_FILTER));
    if (map.getLayer(LAYER_POINTS_CADASTRAL_HIT)) map.setFilter(LAYER_POINTS_CADASTRAL_HIT, focusedFilter(CADASTRAL_POINT_HIT_FILTER));
    if (map.getLayer(LAYER_POINTS_CADASTRAL)) map.setFilter(LAYER_POINTS_CADASTRAL, focusedFilter(CADASTRAL_POINT_HIT_FILTER));
    // LAYER_PHOTOS is intentionally left as-is so geotagged evidence stays visible.
  }, [mapReady, detectionMode, roadInspectionActive, extraVisibleCategories, quickAnalysisCardId]);

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

    const aiOn = !roadInspectionActive && aiOverlayEnabled && detectionMode !== null;
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
      // Each detection mode isolates its own finding type as dots. Road-width
      // narrowing is drawn as a LINE (LAYER_ANOMALIES_ROAD), so in Road Width
      // mode the point layer shows nothing; in other modes it shows that
      // mode's type (never road_width_narrowing). With no mode but the overlay
      // on (e.g. after "Run Spatial Audit") it shows every type except
      // road_width_narrowing. Drains mode suppresses points entirely (it
      // communicates through polygon fill), and Manholes mode suppresses them
      // too — the manhole heatmap overlay replaces the individual dots there.
      const anomalyType =
        aiOn && detectionMode !== null && detectionMode !== "drains" && detectionMode !== "roads" && detectionMode !== "manholes"
          ? DETECTION_MODE_ANOMALY_TYPE[detectionMode]
          : null;
      let pointFilter: maplibregl.FilterSpecification;
      if (anomalyType) {
        pointFilter = ["==", ["get", "anomaly_type"], anomalyType];
      } else if (aiOn && detectionMode === null) {
        pointFilter = ["!=", ["get", "anomaly_type"], "road_width_narrowing"];
      } else {
        // roads or drains mode, or overlay off => no dots
        pointFilter = ["==", ["get", "anomaly_type"], "__none__"];
      }
      map.setFilter(LAYER_ANOMALIES, pointFilter);
    }
    if (map.getLayer(LAYER_ANOMALIES_ROAD)) {
      // The road-line layer mirrors the same visibility logic, but it ONLY
      // ever carries road_width_narrowing — so it shows whenever that type is
      // in scope: Road Width mode, or "show everything" (overlay on, no
      // specific mode). Drains mode communicates via polygon fill, so it
      // hides the road lines too.
      const roadInScope = (aiOn && detectionMode !== "drains" && (detectionMode === "roads" || detectionMode === null))
        || quickAnalysisCardId === "road-width";
      const roadFilter: maplibregl.FilterSpecification = roadInScope
        ? ["==", ["get", "anomaly_type"], "road_width_narrowing"]
        : ["==", ["get", "anomaly_type"], "__none__"];
      map.setFilter(LAYER_ANOMALIES_ROAD, roadFilter);
    }

    function colorByCategoryExpr() {
      return buildCategoryColorExpression(colorByCategoryRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, detectionMode, roadInspectionActive, anomalies, aiOverlayEnabled, quickAnalysisCardId]);

  // Manhole heatmap — populate from the real, persisted manhole_status audit
  // findings (the same red/yellow/green results the individual anomaly
  // points would otherwise show), weighted so red hotspots dominate the
  // density and resolved findings fade out. Visible only in "manholes" AI
  // detection mode; hidden (and cleared) otherwise.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const isManholes = aiOverlayEnabled && detectionMode === "manholes";
    const visibility = isManholes ? "visible" : "none";
    if (map.getLayer(LAYER_MANHOLE_HEATMAP)) {
      map.setLayoutProperty(LAYER_MANHOLE_HEATMAP, "visibility", visibility);
    }
    if (map.getLayer(LAYER_MANHOLE_HEATMAP_POINTS)) {
      map.setLayoutProperty(LAYER_MANHOLE_HEATMAP_POINTS, "visibility", visibility);
    }
    const src = map.getSource(MANHOLE_HEATMAP_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    if (!isManholes) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const weightForAnomaly = (color: string, status: string): number => {
      if (status === "resolved") return 0.1;
      if (color === "red") return 1;
      if (color === "yellow") return 0.55;
      return 0.2; // green
    };
    const features: GeoJSON.Feature[] = anomalies
      .filter((a) => a.anomaly_type === "manhole_status")
      .map((a) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [a.lon, a.lat] },
        properties: { id: a.id, severity: weightForAnomaly(a.color, a.status), color: a.color, status: a.status },
      }));
    src.setData({ type: "FeatureCollection", features });
  }, [mapReady, detectionMode, aiOverlayEnabled, anomalies]);
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
    if (mode === "roads" && !spatialAuditExecutedRef.current) {
      setSpatialAuditRequested(true);
    }
    roadInspectionAbortRef.current?.abort();
    roadInspectionActiveRef.current = false;
    setRoadInspectionActive(false);
    setRoadInspectionRoad(null);
    setRoadInspectionReport(null);
    setRoadInspectionError(null);
    setRoadInspectionLoading(false);
    setDetectionMode((current) => (current === mode ? null : mode));
    // Every fresh mode selection starts with the AI overlay off — isolate
    // the category first, plain colors, then the user explicitly turns AI
    // on as a separate step.
    setAiOverlayEnabled(false);
  }, [setSpatialAuditRequested, spatialAuditExecutedRef]);

  const closeRoadInspection = useCallback(() => {
    roadInspectionAbortRef.current?.abort();
    setRoadInspectionRoad(null);
    setRoadInspectionReport(null);
    setRoadInspectionError(null);
    setRoadInspectionLoading(false);
  }, []);

  const toggleRoadInspection = useCallback(() => {
    setRoadInspectionActive((current) => {
      const next = !current;
      roadInspectionActiveRef.current = next;
      if (next) {
        if (!spatialAuditExecutedRef.current) setSpatialAuditRequested(true);
        setDetectionMode(null);
        setAiOverlayEnabled(false);
        setExtraVisibleCategories(new Set());
      }
      if (!next) closeRoadInspection();
      return next;
    });
  }, [closeRoadInspection, setSpatialAuditRequested, spatialAuditExecutedRef]);

  const openRoadInspection = useCallback((road: UrbanFeature) => {
    if (!road.properties.dataset_id) return;
    roadInspectionAbortRef.current?.abort();
    const controller = new AbortController();
    roadInspectionAbortRef.current = controller;
    setRoadInspectionRoad(road);
    setRoadInspectionReport(null);
    setRoadInspectionError(null);
    setRoadInspectionLoading(true);
    fetchRoadInspection(road.properties.id, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) setRoadInspectionReport(report);
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError" && !controller.signal.aborted) setRoadInspectionError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRoadInspectionLoading(false);
      });
  }, []);

  const toggleAiOverlay = useCallback(() => {
    setAiOverlayEnabled((v) => !v);
  }, []);

  // Marks "the user asked for the one-time Spatial Audit" — synchronous, so
  // rapid repeated icon clicks can only ever set this true once in effect;
  // the actual run is gated separately (see the effect above) on
  // spatialAuditExecutedRef, which this deliberately does not touch.
  const requestSpatialAuditOnce = useCallback(() => {
    console.log("[SpatialAudit] requestSpatialAuditOnce called");
    setSpatialAuditRequested(true);
  }, [setSpatialAuditRequested]);

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
    // Auto-turn on the AI overlay so the freshly-computed audit findings are
    // visible on the map immediately, without the user having to also toggle
    // "AI Detection" on. With no detection mode active this shows ALL audit
    // anomaly types (including the new road_width_narrowing), not one mode.
    setAiOverlayEnabled(true);
    return failures.length === 0;
  }, []);

  const closeQuickAnalysis = useCallback(() => {
    if (measureActiveRef.current) closeMeasureSafely();
    quickAnalysisToolRef.current = null;
    setQuickAnalysisTool(null);
    setSelectedQuickAnalysisFeature(null);
    setSelectedQuickAnalysisConnection(null);
    setUtilitySubCategory("all");
    quickAnalysisFitKeyRef.current = "";
    quickAnalysisActiveRef.current = false;
    setQuickAnalysisCardId(null);
  }, [closeMeasureSafely]);

  const selectQuickAnalysis = useCallback((cardId: string) => {
    // Clicking the already-open card again is a deselect, not a re-select —
    // otherwise there's no way to close a card from the Quick Analysis list
    // itself (only via the dashboard's own × button).
    if (quickAnalysisCardId === cardId) {
      closeQuickAnalysis();
      return;
    }
    const config = QUICK_ANALYSIS_MAP_CONFIG[cardId];
    if (!config) return;
    if (cardId === "road-width" && !spatialAuditExecutedRef.current) {
      setSpatialAuditRequested(true);
    }
    // Save the ordinary map state once, before the dashboard takes over the
    // canvas. Closing the dashboard restores exactly that state.
    if (!quickAnalysisPreviousMapRef.current) {
      quickAnalysisPreviousMapRef.current = { basemap, detectionMode, aiOverlayEnabled };
    }
    if (measureActiveRef.current) closeMeasureSafely();
    quickAnalysisToolRef.current = null;
    setQuickAnalysisTool(null);
    setSelectedQuickAnalysisFeature(null);
    setSelectedQuickAnalysisConnection(null);
    setUtilitySubCategory("all");
    quickAnalysisFitKeyRef.current = "";
    quickAnalysisActiveRef.current = true;
    setQuickAnalysisCardId(cardId);
  }, [
    aiOverlayEnabled,
    basemap,
    closeMeasureSafely,
    closeQuickAnalysis,
    detectionMode,
    quickAnalysisCardId,
    setSpatialAuditRequested,
    spatialAuditExecutedRef,
  ]);

  const activateQuickAnalysisSelect = useCallback(() => {
    if (measureActiveRef.current) closeMeasureSafely();
    const nextTool: QuickAnalysisTool = quickAnalysisToolRef.current === "select" ? null : "select";
    quickAnalysisToolRef.current = nextTool;
    setQuickAnalysisTool(nextTool);
    setSelectedQuickAnalysisFeature(null);
    setSelectedQuickAnalysisConnection(null);
  }, [closeMeasureSafely]);

  const activateQuickAnalysisMeasure = useCallback(() => {
    quickAnalysisToolRef.current = null;
    setQuickAnalysisTool(null);
    setSelectedQuickAnalysisFeature(null);
    setSelectedQuickAnalysisConnection(null);
    toggleMeasureActive();
  }, [toggleMeasureActive]);

  // A selected card is presented as a focused cadastral dashboard. The
  // dashboard controls this state directly rather than routing through the
  // normal map-tool menu, so that menu and unrelated controls never appear
  // as part of a Quick Analysis result.
  useEffect(() => {
    if (!quickAnalysisCardId) {
      const previous = quickAnalysisPreviousMapRef.current;
      if (!previous) return;
      quickAnalysisPreviousMapRef.current = null;
      setDetectionMode(previous.detectionMode);
      setAiOverlayEnabled(previous.aiOverlayEnabled);
      changeBasemap(previous.basemap);
      setQuickAnalysisFeatures([]);
      setQuickAnalysisError(null);
      scheduleFetch();
      return;
    }

    const config = QUICK_ANALYSIS_MAP_CONFIG[quickAnalysisCardId];
    if (!config) return;
    roadInspectionAbortRef.current?.abort();
    roadInspectionActiveRef.current = false;
    setRoadInspectionActive(false);
    setRoadInspectionRoad(null);
    setRoadInspectionReport(null);
    setRoadInspectionError(null);
    setRoadInspectionLoading(false);
    setSelectedAnomalyId(null);
    setExtraVisibleCategories(new Set());
    // Quick Analysis deliberately does not activate an AI Detection mode or
    // reuse its red/yellow/green findings. Its survey markers are drawn from
    // the selected card's actual feature data in a separate source below.
    setDetectionMode(null);
    setAiOverlayEnabled(false);
    changeBasemap("cadastral");
  }, [changeBasemap, quickAnalysisCardId, scheduleFetch]);

  // Quick Analysis must not read its metrics from the home-map viewport
  // state. Fetch a full, independent snapshot of the active datasets while
  // the dashboard is open, then use that same snapshot for its map source.
  // This keeps a result available even if the home map has hidden the source
  // layer or is showing a different live selection.
  useEffect(() => {
    if (!quickAnalysisCardId || !mapReady) return;
    if (activeDatasetIds.length === 0) {
      setQuickAnalysisFeatures([]);
      setQuickAnalysisLoading(false);
      setQuickAnalysisError("Select a dataset to view this analysis.");
      return;
    }
    const controller = new AbortController();
    setQuickAnalysisLoading(true);
    setQuickAnalysisError(null);
    fetchAnalyticsFeatures(activeDatasetIds, [], controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const features = data.features as UrbanFeature[];
        setQuickAnalysisFeatures(features);
        applyFeatureCollection(data);
        setStatus({ loading: false, count: data.count, truncated: data.truncated, error: null, bbox: data.bbox });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          setQuickAnalysisFeatures([]);
          setQuickAnalysisError(error.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuickAnalysisLoading(false);
      });
    return () => controller.abort();
  }, [activeDatasetIds, applyFeatureCollection, mapReady, quickAnalysisCardId]);

  useEffect(() => {
    if (quickAnalysisCardId !== "drain-encroachment" || activeDatasetIds.length === 0) {
      setQuickDrainEncroachment(null);
      setQuickDrainEncroachmentLoading(false);
      setQuickDrainEncroachmentError(null);
      return;
    }
    const controller = new AbortController();
    setQuickDrainEncroachmentLoading(true);
    setQuickDrainEncroachmentError(null);
    fetchDrainEncroachment(activeDatasetIds, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) setQuickDrainEncroachment(report);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          setQuickDrainEncroachment(null);
          setQuickDrainEncroachmentError(error.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuickDrainEncroachmentLoading(false);
      });
    return () => controller.abort();
  }, [activeDatasetIds, quickAnalysisCardId]);

  // The Manhole Detail card is a cadastral network view, not just a point
  // catalogue. Build its verified downstream connections when the card
  // opens so the pipe paths and confirmed flow arrows are present on the map
  // without requiring the user to leave Quick Analysis and open AI Detection.
  useEffect(() => {
    if (quickAnalysisCardId !== "manhole-detail" || activeDatasetIds.length === 0) {
      setQuickAnalysisManholeNetwork(null);
      setQuickAnalysisManholeNetworkLoading(false);
      setQuickAnalysisManholeNetworkError(null);
      return;
    }
    let cancelled = false;
    setQuickAnalysisManholeNetwork(null);
    setQuickAnalysisManholeNetworkLoading(true);
    setQuickAnalysisManholeNetworkError(null);
    aiManholeRecommend({ mode: "network", dataset_id: activeDatasetIds[0] })
      .then((network) => {
        if (!cancelled) setQuickAnalysisManholeNetwork(network);
      })
      .catch((error: Error) => {
        if (!cancelled) setQuickAnalysisManholeNetworkError(error.message);
      })
      .finally(() => {
        if (!cancelled) setQuickAnalysisManholeNetworkLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeDatasetIds, quickAnalysisCardId]);

  useEffect(() => {
    quickAnalysisFeatureByIdRef.current = new Map(
      quickAnalysisFeatures.map((feature) => [feature.properties.id, feature])
    );
  }, [quickAnalysisFeatures]);

  useEffect(() => {
    const selectable = new Set<string>();
    if (quickAnalysisCardId === "drain-encroachment") {
      quickAnalysisFeatures.forEach((feature) => {
        if (isQuickAnalysisDrain(feature)) selectable.add(feature.properties.id);
      });
      quickDrainEncroachment?.buildings.forEach((hit) => selectable.add(hit.building_id));
    } else if (quickAnalysisCardId === "manhole-detail") {
      quickAnalysisFeatures.forEach((feature) => {
        if (feature.properties.canonical_class === "Access_Point") selectable.add(feature.properties.id);
      });
    } else if (quickAnalysisCardId === "road-width") {
      quickAnalysisFeatures.forEach((feature) => {
        if (isRoadCenterlineFeature(feature) || isRoadSurfaceFeature(feature)) {
          selectable.add(feature.properties.id);
        }
      });
    } else if (quickAnalysisCardId === "utility-tracker") {
      quickAnalysisFeatures.forEach((feature) => {
        const cat = feature.properties.category ?? "";
        const normCat = normalizeCategoryName(cat);
        if (normCat === "manhole" || normCat === "inlet" || normCat === "gully" || normCat.includes("drain") || normCat.includes("building") || normCat.includes("road")) return;
        if (!utilitySubCategory || utilitySubCategory === "all") {
          selectable.add(feature.properties.id);
        } else if (utilitySubCategory === "electricity") {
          if (["power pole", "power pole with light", "light pole", "solar light", "transformer", "high mast", "flag pole", "microwave tower"].includes(normCat) || ["Utility_Pole", "Illumination_Asset"].includes(feature.properties.canonical_class ?? "")) {
            selectable.add(feature.properties.id);
          }
        } else if (utilitySubCategory === "water") {
          if (["water line", "pipe", "sewage line", "water tank", "water pump", "overhead tank"].includes(normCat)) {
            selectable.add(feature.properties.id);
          }
        } else if (utilitySubCategory === "telecom") {
          if (["cc camera", "ofc line", "cable"].includes(normCat)) {
            selectable.add(feature.properties.id);
          }
        } else if (normCat === utilitySubCategory) {
          selectable.add(feature.properties.id);
        }
      });
    } else if (quickAnalysisCardId) {
      quickAnalysisFeatures.forEach((feature) => selectable.add(feature.properties.id));
    }
    quickAnalysisSelectableFeatureIdsRef.current = selectable;
  }, [quickAnalysisCardId, quickAnalysisFeatures, quickDrainEncroachment, utilitySubCategory]);

  // Render the complete surveyed drain geometry in its own high-contrast
  // overlay and frame the camera around that network. The red cross source
  // below is only an annotation; this source is the actual drainage map.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(QUICK_ANALYSIS_DRAIN_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const drainFeatures = quickAnalysisCardId === "drain-encroachment"
      ? quickAnalysisFeatures.filter(isQuickAnalysisDrain)
      : [];
    source.setData({
      type: "FeatureCollection",
      features: quickAnalysisDrainLines(drainFeatures, selectedQuickAnalysisFeature?.properties.id),
    });
    if (quickAnalysisCardId === "drain-encroachment") {
      if (map.getLayer(LAYER_QUICK_ANALYSIS_DRAIN_CORRIDOR)) map.moveLayer(LAYER_QUICK_ANALYSIS_DRAIN_CORRIDOR);
      if (map.getLayer(LAYER_QUICK_ANALYSIS_DRAIN_LINE)) map.moveLayer(LAYER_QUICK_ANALYSIS_DRAIN_LINE);
    }

    if (drainFeatures.length === 0 || quickAnalysisCardId !== "drain-encroachment") return;
    const fitKey = `${quickAnalysisCardId}:${activeDatasetIds.join(",")}:${drainFeatures.length}`;
    if (quickAnalysisFitKeyRef.current === fitKey) return;
    const bounds = new maplibregl.LngLatBounds();
    drainFeatures.forEach((feature) => extendCoordinateBounds(bounds, feature.geometry.coordinates));
    if (bounds.isEmpty()) return;
    quickAnalysisFitKeyRef.current = fitKey;
    map.fitBounds(bounds, {
      padding: { top: 70, right: 310, bottom: 260, left: 70 },
      maxZoom: 18,
      duration: 900,
    });
  }, [activeDatasetIds, mapReady, quickAnalysisCardId, quickAnalysisFeatures, selectedQuickAnalysisFeature]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(QUICK_ANALYSIS_MANHOLE_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    // Manhole selection is handled by the exact HTML survey marker. Keep the
    // old WebGL halo empty because it can visually detach from that marker.
    source.setData({ type: "FeatureCollection", features: [] });
    [LAYER_QUICK_ANALYSIS_MANHOLE_GLOW, LAYER_QUICK_ANALYSIS_MANHOLE].forEach((layerId) => {
      if (!map.getLayer(layerId)) return;
      map.setLayoutProperty(layerId, "visibility", "none");
    });
  }, [mapReady, quickAnalysisCardId, selectedQuickAnalysisFeature]);

  // Manhole Detail owns this connection source. It intentionally does not
  // reuse the general AI Manhole Recommendation layers: Quick Analysis has
  // its own condition colours, click details, and lifecycle.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(QUICK_ANALYSIS_MANHOLE_CONNECTION_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const connections = quickAnalysisCardId === "manhole-detail"
      ? (quickAnalysisManholeNetwork?.routes ?? []).map(quickAnalysisConnectionDetail)
      : [];
    const manholeCoordinates = new Map<string, [number, number]>();
    for (const feature of quickAnalysisFeatures) {
      if (feature.properties.canonical_class !== "Access_Point" || feature.geometry.type !== "Point") continue;
      const [longitude, latitude] = feature.geometry.coordinates;
      if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
        manholeCoordinates.set(feature.properties.id, [longitude, latitude]);
      }
    }
    const segments = connections.flatMap((connection, index) => {
      const route = quickAnalysisManholeNetwork?.routes[index];
      if (!route || route.coordinates.length < 2) return [];
      const start = manholeCoordinates.get(connection.fromId) ?? route.coordinates[0];
      const end = connection.toId
        ? manholeCoordinates.get(connection.toId) ?? route.coordinates[route.coordinates.length - 1]
        : route.coordinates[route.coordinates.length - 1];
      return [{ connection, coordinates: [start, end] as [number, number][] }];
    });
    const hasConnectionSelection = selectedQuickAnalysisConnection !== null;
    quickAnalysisConnectionByIdRef.current = new Map(connections.map((connection) => [connection.id, connection]));
    source.setData({
      type: "FeatureCollection",
      features: segments.map(({ connection, coordinates }) => ({
        type: "Feature" as const,
        id: connection.id,
        geometry: {
          type: "LineString" as const,
          coordinates,
        },
        properties: {
          id: connection.id,
          status: connection.status,
          flow_confirmed: connection.flowConfirmed,
          selected: selectedQuickAnalysisConnection?.id === connection.id,
          dimmed: hasConnectionSelection && selectedQuickAnalysisConnection?.id !== connection.id,
        },
      })),
    });
    if (connections.length > 0) {
      [
        LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HIT,
        LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HALO,
        LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_GOOD,
        LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_WARNING,
        LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_CRITICAL,
        LAYER_QUICK_ANALYSIS_MANHOLE_FLOW_ARROWS,
      ].forEach((layerId) => {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "visible");
      });
      if (map.getLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HIT)) map.moveLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HIT);
      if (map.getLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HALO)) map.moveLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HALO);
      if (map.getLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_GOOD)) map.moveLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_GOOD);
      if (map.getLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_WARNING)) map.moveLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_WARNING);
      if (map.getLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_CRITICAL)) map.moveLayer(LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_CRITICAL);
      if (map.getLayer(LAYER_QUICK_ANALYSIS_MANHOLE_FLOW_ARROWS)) map.moveLayer(LAYER_QUICK_ANALYSIS_MANHOLE_FLOW_ARROWS);
    }
  }, [mapReady, quickAnalysisCardId, quickAnalysisFeatures, quickAnalysisManholeNetwork, selectedQuickAnalysisConnection]);

  // Unconnected manholes need a map cue of their own: there is no path to
  // click, so a high-contrast ring makes the missing connection explicit.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(QUICK_ANALYSIS_MANHOLE_UNCONNECTED_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const unconnected = quickAnalysisCardId === "manhole-detail"
      ? quickAnalysisManholeNetwork?.unconnected_manholes ?? []
      : [];
    source.setData({
      type: "FeatureCollection",
      features: unconnected.map((manhole, index) => ({
        type: "Feature" as const,
        id: `${manhole.id}-${index}`,
        geometry: { type: "Point" as const, coordinates: [manhole.lon, manhole.lat] },
        properties: { id: manhole.id, reason: manhole.reason },
      })),
    });
    if (unconnected.length > 0) {
      if (map.getLayer(LAYER_QUICK_ANALYSIS_MANHOLE_UNCONNECTED_HALO)) map.moveLayer(LAYER_QUICK_ANALYSIS_MANHOLE_UNCONNECTED_HALO);
      if (map.getLayer(LAYER_QUICK_ANALYSIS_MANHOLE_UNCONNECTED_RING)) map.moveLayer(LAYER_QUICK_ANALYSIS_MANHOLE_UNCONNECTED_RING);
    }
  }, [mapReady, quickAnalysisCardId, quickAnalysisManholeNetwork]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const powerSource = map.getSource(QUICK_ANALYSIS_POWER_LINE_SOURCE) as GeoJSONSource | undefined;
    const waterSource = map.getSource(QUICK_ANALYSIS_WATER_LINE_SOURCE) as GeoJSONSource | undefined;
    const telecomSource = map.getSource(QUICK_ANALYSIS_TELECOM_LINE_SOURCE) as GeoJSONSource | undefined;

    if (quickAnalysisCardId !== "utility-tracker") {
      powerSource?.setData({ type: "FeatureCollection", features: [] });
      waterSource?.setData({ type: "FeatureCollection", features: [] });
      telecomSource?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const isPowerVisible = utilitySubCategory === "all" || utilitySubCategory === "electricity" || utilitySubCategory === "power line" || utilitySubCategory === "electric line";
    const isWaterVisible = utilitySubCategory === "all" || utilitySubCategory === "water" || utilitySubCategory === "water line" || utilitySubCategory === "pipe" || utilitySubCategory === "sewage line";
    const isTelecomVisible = utilitySubCategory === "all" || utilitySubCategory === "telecom" || utilitySubCategory === "ofc line" || utilitySubCategory === "cable";

    const powerFeatures = isPowerVisible
      ? quickAnalysisFeatures.filter((f) => {
          const category = normalizeCategoryName(f.properties.category ?? "");
          if (utilitySubCategory === "power line" && category !== "power line") return false;
          if (utilitySubCategory === "electric line" && category !== "electric line") return false;
          return (category.includes("power line") || category.includes("electric line") || (f.properties.canonical_class === "Line_Asset" && category.includes("power")))
            && (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString");
        })
      : [];

    const waterFeatures = isWaterVisible
      ? quickAnalysisFeatures.filter((f) => {
          const category = normalizeCategoryName(f.properties.category ?? "");
          if (utilitySubCategory === "water line" && category !== "water line") return false;
          if (utilitySubCategory === "pipe" && category !== "pipe") return false;
          if (utilitySubCategory === "sewage line" && category !== "sewage line") return false;
          return (category.includes("water line") || category === "pipe" || category.includes("sewage line"))
            && (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString");
        })
      : [];

    const telecomFeatures = isTelecomVisible
      ? quickAnalysisFeatures.filter((f) => {
          const category = normalizeCategoryName(f.properties.category ?? "");
          if (utilitySubCategory === "ofc line" && category !== "ofc line") return false;
          if (utilitySubCategory === "cable" && category !== "cable") return false;
          return (category === "ofc line" || category === "cable")
            && (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString");
        })
      : [];

    powerSource?.setData({ type: "FeatureCollection", features: powerFeatures });
    waterSource?.setData({ type: "FeatureCollection", features: waterFeatures });
    telecomSource?.setData({ type: "FeatureCollection", features: telecomFeatures });

    if (powerFeatures.length > 0 && map.getLayer(LAYER_QUICK_ANALYSIS_POWER_LINE)) map.moveLayer(LAYER_QUICK_ANALYSIS_POWER_LINE);
    if (waterFeatures.length > 0 && map.getLayer(LAYER_QUICK_ANALYSIS_WATER_LINE)) map.moveLayer(LAYER_QUICK_ANALYSIS_WATER_LINE);
    if (telecomFeatures.length > 0 && map.getLayer(LAYER_QUICK_ANALYSIS_TELECOM_LINE)) map.moveLayer(LAYER_QUICK_ANALYSIS_TELECOM_LINE);
  }, [mapReady, quickAnalysisCardId, quickAnalysisFeatures, utilitySubCategory]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(QUICK_ANALYSIS_ENCROACHMENT_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const selectedId = selectedQuickAnalysisFeature?.properties.id ?? "";
    const hasSelection = selectedId !== "";
    const features: GeoJSON.Feature[] = [];
    if (quickAnalysisCardId === "drain-encroachment" && quickDrainEncroachment) {
      for (const hit of quickDrainEncroachment.buildings) {
        const buildingSelected = hit.building_id === selectedId;
        const crossingSelected = buildingSelected || hit.drain_ids.includes(selectedId);
        features.push({
          type: "Feature",
          id: hit.building_id,
          geometry: hit.geometry as GeoJSON.Geometry,
          properties: {
            id: hit.building_id,
            building_id: hit.building_id,
            kind: "building",
            classification: hit.classification,
            crossing_length_m: hit.crossing_length_m,
            crossing_ratio_pct: hit.crossing_ratio_pct,
            selected: buildingSelected,
            dimmed: false,
          },
        });
        features.push({
          type: "Feature",
          id: `crossing-${hit.building_id}`,
          geometry: hit.crossing_geometry as GeoJSON.Geometry,
          properties: {
            id: `crossing-${hit.building_id}`,
            building_id: hit.building_id,
            kind: "crossing",
            classification: hit.classification,
            selected: crossingSelected,
            dimmed: hasSelection && !crossingSelected,
          },
        });
      }
    }
    source.setData({ type: "FeatureCollection", features });
    if (quickAnalysisCardId === "drain-encroachment") {
      [
        LAYER_QUICK_ANALYSIS_ENCROACHMENT_FILL,
        LAYER_QUICK_ANALYSIS_ENCROACHMENT_OUTLINE,
        LAYER_QUICK_ANALYSIS_ENCROACHMENT_CROSSING_HALO,
        LAYER_QUICK_ANALYSIS_ENCROACHMENT_CROSSING,
      ].forEach((layerId) => { if (map.getLayer(layerId)) map.moveLayer(layerId); });
    }
  }, [mapReady, quickAnalysisCardId, quickDrainEncroachment, selectedQuickAnalysisFeature]);

  // Quick Analysis markers are populated from the independently fetched
  // survey snapshot. They never read spatial_anomalies or AI-highlight
  // state, so hidden home-map layers cannot make them disappear.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const source = map.getSource(QUICK_ANALYSIS_MARKER_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const features = quickAnalysisCardId === "drain-encroachment"
      ? quickAnalysisDrainMarkers(quickAnalysisFeatures, selectedQuickAnalysisFeature?.properties.id)
      : [];
    source.setData({ type: "FeatureCollection", features });
    if (quickAnalysisCardId === "drain-encroachment") {
      if (map.getLayer(LAYER_QUICK_ANALYSIS_DRAIN_RING)) map.moveLayer(LAYER_QUICK_ANALYSIS_DRAIN_RING);
      if (map.getLayer(LAYER_QUICK_ANALYSIS_DRAIN_CROSS)) map.moveLayer(LAYER_QUICK_ANALYSIS_DRAIN_CROSS);
    }
  }, [mapReady, quickAnalysisCardId, quickAnalysisFeatures, selectedQuickAnalysisFeature]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || measureActive) return;
    map.getCanvas().style.cursor = quickAnalysisTool === "select" ? "crosshair" : "";
  }, [mapReady, measureActive, quickAnalysisTool]);

  // Fires once per fresh app load, on the first AI Detection icon click —
  // see WorkspaceLayout for why the guard lives outside this component.
  // `spatialAuditRequested` is set synchronously on that click; this
  // effect is what actually runs the (reused, unmodified) audit function
  // once a dataset is active, so a click before any dataset is selected
  // isn't wasted and doesn't need a second click to take effect.
  const hasActiveDatasets = activeDatasetIds.length > 0;
  useEffect(() => {
    console.log("[SpatialAudit] effect fired:", { spatialAuditRequested, executed: spatialAuditExecutedRef.current, hasActiveDatasets, datasetCount: activeDatasetIds.length });
    if (!spatialAuditRequested || spatialAuditExecutedRef.current) return;
    if (!hasActiveDatasets) return;
    console.log("[SpatialAudit] starting audit for datasets:", activeDatasetIds);
    spatialAuditExecutedRef.current = true;
    onSpatialAuditStatusChange("running");
    void runAudit(activeDatasetIds).then((ok) => {
      console.log("[SpatialAudit] audit completed:", { ok });
      if (!ok) spatialAuditExecutedRef.current = false;
      onSpatialAuditStatusChange(ok ? "success" : "error");
    });
  }, [hasActiveDatasets, activeDatasetIds, runAudit, onSpatialAuditStatusChange, spatialAuditRequested, spatialAuditExecutedRef]);

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

  const quickAnalysisManholeNetworkStatusCounts = useMemo(() => {
    const counts = { good: 0, warning: 0, critical: 0, unconnected: quickAnalysisManholeNetwork?.unconnected_manholes.length ?? 0 };
    for (const [index, route] of (quickAnalysisManholeNetwork?.routes ?? []).entries()) {
      counts[quickAnalysisConnectionDetail(route, index).status] += 1;
    }
    return counts;
  }, [quickAnalysisManholeNetwork]);

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
            const pointCoordinates = pointCoordinatesFromFeature(feature);
            const fidEntry = Object.entries(attributes).find(([key]) => key.toLowerCase() === "fid");
            setHover({
              x: point.x,
              y: point.y,
              label: feature.properties.label || (fidEntry ? `FID ${String(fidEntry[1])}` : category),
              category,
              severity: feature.properties.severity,
              color: colorForCategory(category),
              longitude: pointCoordinates?.longitude ?? target.anchor.lng,
              latitude: pointCoordinates?.latitude ?? target.anchor.lat,
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
        id: LAYER_POLY_FILL_CADASTRAL,
        type: "fill",
        source: FEATURE_SOURCE,
        filter: POLY_BASE_FILTER,
        layout: { visibility: "none" },
        paint: {
          "fill-color": cadastralPolygonFillExpression(),
          "fill-opacity": 0.18,
        },
      });
      map.addLayer({
        id: LAYER_POLY_OUTLINE_CADASTRAL,
        type: "line",
        source: FEATURE_SOURCE,
        filter: POLY_BASE_FILTER,
        layout: { visibility: "none" },
        paint: {
          "line-color": cadastralPolygonOutlineExpression(),
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.7, 18, 1.1],
          "line-opacity": 0.88,
        },
      });
      map.addLayer({
        id: LAYER_LINES_CADASTRAL,
        type: "line",
        source: FEATURE_SOURCE,
        filter: LINE_BASE_FILTER,
        layout: { visibility: "none" },
        paint: {
          "line-color": cadastralLineColorExpression(),
          "line-width": cadastralLineWidthExpression(),
          "line-opacity": 0.82,
        },
      });
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
      const cadastralPointImages: Array<[string, CadastralPointIconKind]> = [
        [CADASTRAL_POINT_ICON_DEFAULT, "default"],
        [CADASTRAL_POINT_ICON_TREE, "tree"],
        [CADASTRAL_POINT_ICON_PALM, "palm"],
        [CADASTRAL_POINT_ICON_POLE, "power-pole"],
        [CADASTRAL_POINT_ICON_POWER_LIGHT_POLE, "power-light-pole"],
        [CADASTRAL_POINT_ICON_LIGHT, "light-pole"],
        [CADASTRAL_POINT_ICON_SOLAR_LIGHT, "solar-light"],
        [CADASTRAL_POINT_ICON_MANHOLE, "manhole"],
        [CADASTRAL_POINT_ICON_CAMERA, "camera"],
        [CADASTRAL_POINT_ICON_LEVEL, "level"],
        [CADASTRAL_POINT_ICON_LANDMARK, "landmark"],
        [CADASTRAL_POINT_ICON_TRANSFORMER, "transformer"],
        [CADASTRAL_POINT_ICON_SIGN, "sign"],
        [CADASTRAL_POINT_ICON_GATE, "gate"],
        [CADASTRAL_POINT_ICON_WATER, "water"],
        [CADASTRAL_POINT_ICON_WATER_TANK, "water-tank"],
        [CADASTRAL_POINT_ICON_WATER_PUMP, "water-pump"],
        [CADASTRAL_POINT_ICON_TEMPLE, "temple"],
      ];
      for (const [imageId, kind] of cadastralPointImages) {
        if (!map.hasImage(imageId)) map.addImage(imageId, buildCadastralPointIconImageData(kind), { pixelRatio: 2 });
      }
      map.addLayer({
        id: LAYER_POINTS_CADASTRAL_HIT,
        type: "circle",
        source: FEATURE_SOURCE,
        filter: CADASTRAL_POINT_HIT_FILTER,
        layout: {
          visibility: "none",
        },
        paint: {
          "circle-radius": cadastralPointHitRadiusExpression(),
          "circle-color": "rgba(15,23,42,0.01)",
          "circle-stroke-color": "rgba(15,23,42,0.01)",
          "circle-stroke-width": 0,
          "circle-opacity": 0.01,
        },
      });
      addCadastralPointIconLayer(map);
      map.addSource(QUICK_ANALYSIS_DRAIN_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_DRAIN_CORRIDOR,
        type: "line",
        source: QUICK_ANALYSIS_DRAIN_SOURCE,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "#ef4444",
          "line-width": [
            "case",
            ["==", ["get", "selected"], true],
            ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 20, 20, 28],
            ["interpolate", ["linear"], ["zoom"], 12, 7, 16, 12, 20, 18],
          ],
          "line-opacity": [
            "case",
            ["==", ["get", "selected"], true], 0.42,
            ["==", ["get", "dimmed"], true], 0.04,
            0.22,
          ],
        },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_DRAIN_LINE,
        type: "line",
        source: QUICK_ANALYSIS_DRAIN_SOURCE,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": ["case", ["==", ["get", "selected"], true], "#be123c", "#e11d48"],
          "line-width": [
            "case",
            ["==", ["get", "selected"], true],
            ["interpolate", ["linear"], ["zoom"], 12, 3.5, 16, 5, 20, 7],
            ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 3.25, 20, 5],
          ],
          "line-opacity": [
            "case",
            ["==", ["get", "selected"], true], 1,
            ["==", ["get", "dimmed"], true], 0.18,
            0.98,
          ],
        },
      });
      map.addSource(QUICK_ANALYSIS_MANHOLE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_MANHOLE_GLOW,
        type: "circle",
        source: QUICK_ANALYSIS_MANHOLE_SOURCE,
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "selected"], true],
            ["interpolate", ["linear"], ["zoom"], 12, 13, 16, 18, 20, 24],
            ["interpolate", ["linear"], ["zoom"], 12, 8, 16, 12, 20, 16],
          ],
          "circle-color": "#06b6d4",
          "circle-opacity": [
            "case",
            ["==", ["get", "selected"], true], 0.46,
            ["==", ["get", "dimmed"], true], 0.06,
            0.2,
          ],
          "circle-blur": 0.35,
        },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_MANHOLE,
        type: "circle",
        source: QUICK_ANALYSIS_MANHOLE_SOURCE,
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "selected"], true],
            ["interpolate", ["linear"], ["zoom"], 12, 7, 16, 10, 20, 13],
            ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 6, 20, 8],
          ],
          "circle-color": "#083344",
          "circle-opacity": ["case", ["==", ["get", "dimmed"], true], 0.35, 0.98],
          "circle-stroke-color": "#22d3ee",
          "circle-stroke-width": ["case", ["==", ["get", "selected"], true], 4, 2.2],
          "circle-stroke-opacity": ["case", ["==", ["get", "dimmed"], true], 0.3, 1],
        },
      });
      map.addSource(QUICK_ANALYSIS_POWER_LINE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_POWER_LINE,
        type: "line",
        source: QUICK_ANALYSIS_POWER_LINE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#d97706",
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 1.8, 20, 2.5],
          "line-opacity": 0.9,
        },
      });
      map.addSource(QUICK_ANALYSIS_WATER_LINE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_WATER_LINE,
        type: "line",
        source: QUICK_ANALYSIS_WATER_LINE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0284c7",
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 1.8, 20, 2.5],
          "line-opacity": 0.9,
        },
      });
      map.addSource(QUICK_ANALYSIS_TELECOM_LINE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_TELECOM_LINE,
        type: "line",
        source: QUICK_ANALYSIS_TELECOM_LINE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#a855f7",
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 1.8, 20, 2.5],
          "line-opacity": 0.9,
        },
      });
      map.addSource(QUICK_ANALYSIS_MANHOLE_CONNECTION_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      // Wide transparent hit corridor makes a short/curved connection easy
      // to select without competing with building outlines beneath it.
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HIT,
        type: "line",
        source: QUICK_ANALYSIS_MANHOLE_CONNECTION_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 16, 18, 24],
          "line-color": "#0f172a",
          "line-opacity": 0.01,
        },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HALO,
        type: "line",
        source: QUICK_ANALYSIS_MANHOLE_CONNECTION_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "match", ["get", "status"],
            "good", "#22c55e",
            "warning", "#facc15",
            "critical", "#ef4444",
            "#64748b",
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 10, 18, 16],
          "line-opacity": ["case", ["==", ["get", "selected"], true], 0.34, 0],
          "line-blur": 0.45,
        },
      });
      const quickAnalysisConnectionLines: Array<[string, "good" | "warning" | "critical", string]> = [
        [LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_GOOD, "good", "#16a34a"],
        [LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_WARNING, "warning", "#eab308"],
        [LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_CRITICAL, "critical", "#dc2626"],
      ];
      for (const [layerId, status, color] of quickAnalysisConnectionLines) {
        map.addLayer({
          id: layerId,
          type: "line",
          source: QUICK_ANALYSIS_MANHOLE_CONNECTION_SOURCE,
          filter: ["==", ["get", "status"], status],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": color,
            // Same weight curve as the drain path line (LAYER_QUICK_ANALYSIS_
            // DRAIN_LINE) — thin by default, only thickens on selection.
            "line-width": [
              "case", ["==", ["get", "selected"], true],
              ["interpolate", ["linear"], ["zoom"], 12, 3.5, 16, 5, 20, 7],
              ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 3.25, 20, 5],
            ],
            "line-opacity": [
              "case", ["==", ["get", "selected"], true], 1,
              ["==", ["get", "dimmed"], true], 0.18,
              0.98,
            ],
          },
        });
      }
      const quickAnalysisFlowArrowImages: Array<[string, string]> = [
        [QUICK_ANALYSIS_FLOW_ARROW_GOOD, "#16a34a"],
        [QUICK_ANALYSIS_FLOW_ARROW_WARNING, "#eab308"],
        [QUICK_ANALYSIS_FLOW_ARROW_CRITICAL, "#dc2626"],
      ];
      for (const [imageId, color] of quickAnalysisFlowArrowImages) {
        if (!map.hasImage(imageId)) map.addImage(imageId, buildFlowArrowImageData(color), { pixelRatio: 2 });
      }
      // Arrow with shaft + arrowhead placed once per connection line via
      // symbol-placement: "line" so MapLibre anchors and rotates it to
      // the line's own geometry.
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_MANHOLE_FLOW_ARROWS,
        type: "symbol",
        source: QUICK_ANALYSIS_MANHOLE_CONNECTION_SOURCE,
        filter: ["==", ["get", "flow_confirmed"], true],
        layout: {
          "symbol-placement": "line",
          // Larger than any single connection segment, so exactly one
          // arrowhead is placed per line instead of a repeating chevron
          // pattern.
          "symbol-spacing": 10000,
          "icon-image": [
            "match", ["get", "status"],
            "good", QUICK_ANALYSIS_FLOW_ARROW_GOOD,
            "warning", QUICK_ANALYSIS_FLOW_ARROW_WARNING,
            "critical", QUICK_ANALYSIS_FLOW_ARROW_CRITICAL,
            QUICK_ANALYSIS_FLOW_ARROW_WARNING,
          ],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 1.0, 18, 1.6],
          "icon-rotation-alignment": "map",
          "icon-keep-upright": false,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": ["case", ["==", ["get", "dimmed"], true], 0.12, 1],
        },
      });
      map.addSource(QUICK_ANALYSIS_MANHOLE_UNCONNECTED_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_MANHOLE_UNCONNECTED_HALO,
        type: "circle",
        source: QUICK_ANALYSIS_MANHOLE_UNCONNECTED_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 12, 18, 20],
          "circle-color": "#ef4444",
          "circle-opacity": 0.24,
          "circle-blur": 0.45,
        },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_MANHOLE_UNCONNECTED_RING,
        type: "circle",
        source: QUICK_ANALYSIS_MANHOLE_UNCONNECTED_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 18, 14],
          "circle-color": "rgba(255,255,255,0.01)",
          "circle-stroke-color": "#ef4444",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 18, 3.5],
          "circle-stroke-opacity": 1,
        },
      });
      map.addSource(QUICK_ANALYSIS_ENCROACHMENT_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_ENCROACHMENT_FILL,
        type: "fill",
        source: QUICK_ANALYSIS_ENCROACHMENT_SOURCE,
        filter: ["==", ["get", "kind"], "building"],
        paint: {
          "fill-color": ["match", ["get", "classification"], "major_crossing", "#ef4444", "#f59e0b"],
          // Crossing segments already identify every encroachment. Keep the
          // footprint clean until the user asks for one building's details.
          "fill-opacity": ["case", ["==", ["get", "selected"], true], 0.62, 0],
        },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_ENCROACHMENT_OUTLINE,
        type: "line",
        source: QUICK_ANALYSIS_ENCROACHMENT_SOURCE,
        filter: ["==", ["get", "kind"], "building"],
        paint: {
          "line-color": ["match", ["get", "classification"], "major_crossing", "#b91c1c", "#d97706"],
          "line-width": ["case", ["==", ["get", "selected"], true], 4, 2],
          "line-opacity": ["case", ["==", ["get", "selected"], true], 0.98, 0],
        },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_ENCROACHMENT_CROSSING_HALO,
        type: "line",
        source: QUICK_ANALYSIS_ENCROACHMENT_SOURCE,
        filter: ["==", ["get", "kind"], "crossing"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["case", ["==", ["get", "selected"], true], 10, 7],
          "line-opacity": ["case", ["==", ["get", "dimmed"], true], 0.08, 0.95],
        },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_ENCROACHMENT_CROSSING,
        type: "line",
        source: QUICK_ANALYSIS_ENCROACHMENT_SOURCE,
        filter: ["==", ["get", "kind"], "crossing"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["match", ["get", "classification"], "major_crossing", "#7f1d1d", "#b45309"],
          "line-width": ["case", ["==", ["get", "selected"], true], 6, 4],
          "line-opacity": ["case", ["==", ["get", "dimmed"], true], 0.1, 1],
        },
      });
      map.addSource(QUICK_ANALYSIS_MARKER_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_DRAIN_RING,
        type: "circle",
        source: QUICK_ANALYSIS_MARKER_SOURCE,
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "selected"], true],
            ["interpolate", ["linear"], ["zoom"], 12, 11, 16, 17, 20, 22],
            ["interpolate", ["linear"], ["zoom"], 12, 8, 16, 13, 20, 18],
          ],
          "circle-color": "#ef4444",
          "circle-opacity": ["case", ["==", ["get", "selected"], true], 0.34, 0],
          "circle-stroke-color": "#dc2626",
          "circle-stroke-width": ["case", ["==", ["get", "selected"], true], 4, 2.2],
          "circle-stroke-opacity": ["case", ["==", ["get", "selected"], true], 0.96, 0],
        },
      });
      map.addLayer({
        id: LAYER_QUICK_ANALYSIS_DRAIN_CROSS,
        type: "symbol",
        source: QUICK_ANALYSIS_MARKER_SOURCE,
        layout: {
          "text-field": "×",
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 15, 16, 23, 20, 31],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#dc2626",
          "text-halo-color": "rgba(255,255,255,0.9)",
          "text-halo-width": 0.8,
          "text-opacity": ["case", ["==", ["get", "selected"], true], 1, 0],
        },
      });
      const handleQuickAnalysisMarkerClick = (event: MapLayerMouseEvent) => {
        if (!quickAnalysisActiveRef.current) return;
        // A rendered feature can belong to several stacked QA layers (fill +
        // outline, glow + point, corridor + line). Treat the browser click as
        // one selection action instead of toggling once per matching layer.
        if (quickAnalysisFeatureClickConsumedRef.current) return;
        quickAnalysisFeatureClickConsumedRef.current = true;
        window.requestAnimationFrame(() => { quickAnalysisFeatureClickConsumedRef.current = false; });
        const featureId = String(
          event.features?.[0]?.properties?.building_id
          ?? event.features?.[0]?.properties?.id
          ?? ""
        );
        const selected = quickAnalysisFeatureByIdRef.current.get(featureId);
        if (selected) {
          setSelectedQuickAnalysisFeature((current) =>
            current?.properties.id === selected.properties.id ? null : selected
          );
        }
      };
      const handleQuickAnalysisMarkerEnter = () => {
        if (quickAnalysisActiveRef.current) map.getCanvas().style.cursor = "pointer";
      };
      const handleQuickAnalysisMarkerLeave = () => {
        if (quickAnalysisActiveRef.current) map.getCanvas().style.cursor = "";
      };
      [
        LAYER_QUICK_ANALYSIS_DRAIN_CORRIDOR,
        LAYER_QUICK_ANALYSIS_DRAIN_LINE,
        LAYER_QUICK_ANALYSIS_DRAIN_RING,
        LAYER_QUICK_ANALYSIS_DRAIN_CROSS,
        LAYER_QUICK_ANALYSIS_MANHOLE_GLOW,
        LAYER_QUICK_ANALYSIS_MANHOLE,
        LAYER_QUICK_ANALYSIS_ENCROACHMENT_FILL,
        LAYER_QUICK_ANALYSIS_ENCROACHMENT_OUTLINE,
        LAYER_QUICK_ANALYSIS_ENCROACHMENT_CROSSING_HALO,
        LAYER_QUICK_ANALYSIS_ENCROACHMENT_CROSSING,
      ].forEach((layerId) => {
        map.on("click", layerId, handleQuickAnalysisMarkerClick);
        map.on("mouseenter", layerId, handleQuickAnalysisMarkerEnter);
        map.on("mouseleave", layerId, handleQuickAnalysisMarkerLeave);
      });
      map.on("click", LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HIT, (event: MapLayerMouseEvent) => {
        if (!quickAnalysisActiveRef.current) return;
        const id = String(event.features?.[0]?.properties?.id ?? "");
        const connection = quickAnalysisConnectionByIdRef.current.get(id);
        if (!connection) return;
        setSelectedQuickAnalysisFeature(null);
        setSelectedQuickAnalysisConnection((current) => current?.id === connection.id ? null : connection);
      });
      map.on("mouseenter", LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HIT, () => {
        if (quickAnalysisActiveRef.current) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", LAYER_QUICK_ANALYSIS_MANHOLE_CONNECTION_HIT, () => {
        if (quickAnalysisActiveRef.current) map.getCanvas().style.cursor = "";
      });
      map.addLayer({
        id: REFERENCE_SURVEY_ROAD_LABELS,
        type: "symbol",
        source: FEATURE_SOURCE,
        minzoom: 17,
        filter: withRoadCompatibilityVisibility(LINE_BASE_FILTER, false),
        layout: {
          visibility: "none",
          "symbol-placement": "line-center",
          "text-field": roadNameTextExpression(),
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 18, 13, 21, 15],
          "text-letter-spacing": 0.03,
          "text-allow-overlap": false,
          "text-ignore-placement": false,
          "symbol-spacing": 500,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#f8fafc",
          "text-halo-width": 1.4,
          "text-halo-blur": 0.4,
        },
      });

      map.addLayer({
        id: REFERENCE_SURVEY_BUILDING_LABELS,
        type: "symbol",
        source: FEATURE_SOURCE,
        // Parcel IDs are deliberately house-level detail. Showing them at
        // ward/block zoom turns cadastral view into an unreadable wall.
        minzoom: 20.25,
        filter: [
          "all",
          POLY_BASE_FILTER,
          ["in", "building", ["downcase", ["coalesce", ["get", "category"], ""]]],
        ],
        layout: {
          visibility: "none",
          "text-field": buildingIdTextExpression(),
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 20.25, 8.5, 22, 11],
          "text-variable-anchor": ["center", "top", "bottom"],
          "text-radial-offset": 0.25,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#111827",
          // Parcel IDs stay plain: no white halo/background treatment.
          "text-halo-width": 0,
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
        // Canvas cadastral icons intentionally have pointer-events disabled;
        // this transparent hit layer supplies their normal hover/click data.
        // Do not register events against the optional MapLibre symbol layer:
        // a removed style layer aborts the whole handler registration loop.
        LAYER_POINTS, LAYER_POINTS_CADASTRAL_HIT,
        LAYER_LINES, LAYER_LINES_CADASTRAL,
        LAYER_POLY_FILL, LAYER_POLY_FILL_CADASTRAL,
        LAYER_PHOTOS,
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

      // Road-width narrowing rendered as a coloured LINE (the affected
      // carriageway stretch) — like a traffic segment, not vertex markers.
      map.addSource(ANOMALY_ROAD_LINE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_ANOMALIES_ROAD,
        type: "line",
        source: ANOMALY_ROAD_LINE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ANOMALY_COLOR_EXPR,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 8, 19, 14],
          "line-opacity": 0.85,
          "line-blur": 0.5,
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
          longitude: e.lngLat.lng,
          latitude: e.lngLat.lat,
          attributes: { reason },
        });
      });
      map.on("mouseleave", LAYER_MANHOLE_UNCONNECTED, () => {
        map.getCanvas().style.cursor = "";
        setHover(null);
      });

      // Shared by both the plain anomaly-points layer and the manhole
      // heatmap's invisible click layer — same finding, same AI Alert card,
      // just a different visual treatment for manholes (heatmap density
      // instead of individual red/yellow/green dots).
      const openAnomalyFinding = (id: string) => {
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
      };
      map.on("click", LAYER_ANOMALIES, (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER_ANOMALIES] });
        if (!hit.length) return;
        const id = hit[0].properties?.id as string | undefined;
        if (id) openAnomalyFinding(id);
      });
      map.on("mouseenter", LAYER_ANOMALIES, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", LAYER_ANOMALIES, () => (map.getCanvas().style.cursor = ""));

      // Road-width narrowing lines open the same anomaly card on click/hover.
      map.on("click", LAYER_ANOMALIES_ROAD, (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER_ANOMALIES_ROAD] });
        if (!hit.length) return;
        const id = hit[0].properties?.id as string | undefined;
        if (id) setSelectedAnomalyId(id);
      });
      map.on("mouseenter", LAYER_ANOMALIES_ROAD, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", LAYER_ANOMALIES_ROAD, () => (map.getCanvas().style.cursor = ""));

      // Manhole heatmap — density visualization for condition-audit findings,
      // shown instead of the plain dots above when in "manholes" mode.
      map.addSource(MANHOLE_HEATMAP_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_MANHOLE_HEATMAP,
        type: "heatmap",
        source: MANHOLE_HEATMAP_SOURCE,
        layout: { visibility: "none" },
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, 0, 0.5, 0.5, 1, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 22, 3],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0, 0, 255, 0)",
            0.2, "#3b82f6",
            0.4, "#22c55e",
            0.6, "#eab308",
            0.8, "#f97316",
            1, "#ef4444",
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 8, 22, 30],
          "heatmap-opacity": 0.8,
        },
      });
      // Invisible-but-clickable points on top of the heatmap so users can
      // still click individual manholes while the heatmap overlay is active
      // — radius must stay non-zero (opacity 0 makes it invisible) since a
      // zero-radius circle has no rendered pixels for hit-testing to find.
      map.addLayer({
        id: LAYER_MANHOLE_HEATMAP_POINTS,
        type: "circle",
        source: MANHOLE_HEATMAP_SOURCE,
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 18, 14],
          "circle-opacity": 0,
        },
      });
      map.on("click", LAYER_MANHOLE_HEATMAP_POINTS, (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER_MANHOLE_HEATMAP_POINTS] });
        if (!hit.length) return;
        const id = hit[0].properties?.id as string | undefined;
        if (!id) return;
        openAnomalyFinding(id);
      });
      map.on("mouseenter", LAYER_MANHOLE_HEATMAP_POINTS, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", LAYER_MANHOLE_HEATMAP_POINTS, () => (map.getCanvas().style.cursor = ""));

      map.addSource(ROAD_INSPECTION_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_ROAD_INSPECTION,
        type: "line",
        source: ROAD_INSPECTION_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#14b8a6",
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 16, 9, 19, 14],
          "line-opacity": 0.9,
          "line-blur": 0.3,
        },
      });

      map.addSource(ROAD_INSPECTION_ASSETS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_ROAD_INSPECTION_ASSETS_FILL,
        type: "fill",
        source: ROAD_INSPECTION_ASSETS_SOURCE,
        filter: POLY_BASE_FILTER,
        paint: {
          "fill-color": [
            "match", ["get", "audit_color"],
            "red", "#ef4444",
            "yellow", "#f59e0b",
            "green", "#22c55e",
            "#64748b",
          ],
          "fill-opacity": 0.52,
        },
      });
      map.addLayer({
        id: LAYER_ROAD_INSPECTION_ASSETS_LINE,
        type: "line",
        source: ROAD_INSPECTION_ASSETS_SOURCE,
        filter: LINE_BASE_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "match", ["get", "canonical_class"],
            "Drainage_Asset", "#a78bfa",
            "#38bdf8",
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 5, 19, 7],
          "line-opacity": 0.95,
        },
      });
      map.addLayer({
        id: LAYER_ROAD_INSPECTION_ASSETS_POINT,
        type: "circle",
        source: ROAD_INSPECTION_ASSETS_SOURCE,
        filter: POINT_BASE_FILTER,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 6, 14, 10, 18, 14],
          "circle-color": [
            "match", ["coalesce", ["get", "audit_color"], ["get", "canonical_class"]],
            "red", "#ef4444",
            "yellow", "#f59e0b",
            "green", "#22c55e",
            "Illumination_Asset", "#fbbf24",
            "Drainage_Asset", "#a78bfa",
            "Access_Point", "#2dd4bf",
            "#38bdf8",
          ],
          "circle-opacity": 0.96,
          "circle-stroke-color": "#0b1013",
          "circle-stroke-width": 2,
        },
      });

      // Width narrowing has a computed segment rather than a stored asset
      // geometry, so keep it in a small separate line source above the road.
      map.addSource(ROAD_INSPECTION_WIDTH_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_ROAD_INSPECTION_WIDTH,
        type: "line",
        source: ROAD_INSPECTION_WIDTH_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ANOMALY_COLOR_EXPR,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 16, 9, 19, 14],
          "line-opacity": 0.9,
          "line-blur": 0.3,
        },
      });
      map.on("click", LAYER_ROAD_INSPECTION_WIDTH, (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER_ROAD_INSPECTION_WIDTH] });
        const id = hit[0]?.properties?.id as string | undefined;
        if (id) setSelectedAnomalyId(id);
      });
      map.on("mouseenter", LAYER_ROAD_INSPECTION_WIDTH, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", LAYER_ROAD_INSPECTION_WIDTH, () => (map.getCanvas().style.cursor = ""));

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
      const ROAD_INSPECTION_CLICKABLE = [
        LAYER_ROAD_INSPECTION_ASSETS_POINT,
        LAYER_ROAD_INSPECTION_ASSETS_LINE,
        LAYER_ROAD_INSPECTION_ASSETS_FILL,
      ];
      const ALL_CLICKABLE = [...BASE_CLICKABLE, ...ROAD_INSPECTION_CLICKABLE, ...AI_CLICKABLE];
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
        if (quickAnalysisActiveRef.current) {
          if (quickAnalysisFeatureClickConsumedRef.current) return;
          if (quickAnalysisSelectableFeatureIdsRef.current.has(selected.properties.id)) {
            quickAnalysisFeatureClickConsumedRef.current = true;
            window.requestAnimationFrame(() => { quickAnalysisFeatureClickConsumedRef.current = false; });
            const actual = quickAnalysisFeatureByIdRef.current.get(selected.properties.id) ?? selected;
            setSelectedQuickAnalysisConnection(null);
            setSelectedQuickAnalysisFeature((current) =>
              current?.properties.id === actual.properties.id ? null : actual
            );
          }
          return;
        }
        if (roadInspectionActiveRef.current) {
          if (isRoadCenterlineFeature(selected)) void openRoadInspection(selected);
          else onFeatureSelect(selected);
          return;
        }
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
        if (placemarkModeRef.current || streetPickModeRef.current || isMeasureInputActive() || quickAnalysisActiveRef.current) { setHover(null); return; }
        const hit = map.queryRenderedFeatures(e.point, { layers: ALL_CLICKABLE });
        if (!hit.length) { setHover(null); return; }
        const aiHit = hit.find((f) => AI_CLICKABLE.includes(f.layer?.id as string));
        const baseHit = hit.find((f) => BASE_CLICKABLE.includes(f.layer?.id as string));
        const featureToDecode = baseHit ?? aiHit ?? hit[0];
        const decoded = decodeFeature(featureToDecode);
        const pointCoordinates = pointCoordinatesFromFeature(decoded);
        const category = decoded.properties.category || "uncategorized";
        // Buildings dominate this cadastral survey. Their ID is printed on
        // the footprint; suppressing hover cards keeps nearby assets usable.
        if (basemapRef.current === "cadastral" && isBuildingCategory(category)) {
          map.getCanvas().style.cursor = "";
          setHover(null);
          return;
        }
        if (basemapRef.current === "cadastral"
          && decoded.geometry.type === "Point"
          && map.getZoom() < cadastralMarkerMinZoom(decoded)) {
          map.getCanvas().style.cursor = "";
          setHover(null);
          return;
        }
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
          longitude: pointCoordinates?.longitude ?? e.lngLat.lng,
          latitude: pointCoordinates?.latitude ?? e.lngLat.lat,
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
      const handleFeatureMouseEnter = (e: MapMouseEvent) => {
        if (placemarkModeRef.current || streetPickModeRef.current) { map.getCanvas().style.cursor = "crosshair"; return; }
        if (quickAnalysisActiveRef.current) {
          const hit = map.queryRenderedFeatures(e.point, { layers: ALL_CLICKABLE });
          const baseHit = hit.find((feature) => BASE_CLICKABLE.includes(feature.layer?.id as string));
          const featureId = baseHit ? decodeFeature(baseHit).properties.id : "";
          map.getCanvas().style.cursor = quickAnalysisSelectableFeatureIdsRef.current.has(featureId) ? "pointer" : "";
          return;
        }
        if (isMeasureInputActive()) return;
        if (basemapRef.current === "cadastral") {
          const hit = map.queryRenderedFeatures(e.point, { layers: ALL_CLICKABLE });
          const baseHit = hit.find((feature) => BASE_CLICKABLE.includes(feature.layer?.id as string));
          if (baseHit && isBuildingCategory(decodeFeature(baseHit).properties.category)) {
            map.getCanvas().style.cursor = "";
            return;
          }
        }
        map.getCanvas().style.cursor = "pointer";
      };
      const handleFeatureMouseLeave = () => {
        if (placemarkModeRef.current || streetPickModeRef.current) { map.getCanvas().style.cursor = "crosshair"; setHover(null); return; }
        if (quickAnalysisActiveRef.current) { map.getCanvas().style.cursor = ""; setHover(null); return; }
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
        if (
          quickAnalysisActiveRef.current
          && !quickAnalysisFeatureClickConsumedRef.current
          && !isMeasureInputActive()
        ) {
          setSelectedQuickAnalysisFeature(null);
        }
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
      // Some MapLibre style changes can remove a runtime symbol layer while
      // its custom images are being registered. Restore it after that first
      // style pass; points remain on FEATURE_SOURCE so hover/click decoding
      // always reads the same loaded data as every other map layer.
      window.requestAnimationFrame(() => {
        addCadastralPointIconLayer(map, basemap === "cadastral" ? "visible" : "none");
      });
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
        for (const layerId of layerIds) {
          if (!currentMap.getLayer(layerId)) continue;
          // Survey building IDs are a cadastral aid, not a reference-layer
          // toggle. They never appear on street or satellite basemaps.
          const visibility = layerId === REFERENCE_SURVEY_BUILDING_LABELS
            ? (basemapRef.current === "cadastral" ? "visible" : "none")
            : (next[key] ? "visible" : "none");
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
      const dataset = datasets.find(
        (candidate) => candidate.id === id && (candidate.file_type === "geotiff" || (candidate.file_type === "lidar" || candidate.file_type === "las"))
      );
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const frame = window.requestAnimationFrame(() => map.resize());
    return () => window.cancelAnimationFrame(frame);
  }, [sidebarCollapsed]);

  return (
    <>
      <aside className="sidebar-rail" aria-label="Sidebar controls">
        <button
          type="button"
          className={!sidebarCollapsed && sidebarPanel === "layers" ? "sidebar-rail__layers-button sidebar-rail__layers-button--active" : "sidebar-rail__layers-button"}
          onClick={() => {
            if (!sidebarCollapsed && sidebarPanel === "layers") { onToggleSidebar?.(); return; }
            setSidebarPanel("layers");
            if (sidebarCollapsed) onToggleSidebar?.();
          }}
          title={!sidebarCollapsed && sidebarPanel === "layers" ? "Hide layers panel" : "Show layers panel"}
          aria-label={!sidebarCollapsed && sidebarPanel === "layers" ? "Hide layers panel" : "Show layers panel"}
          aria-pressed={!sidebarCollapsed && sidebarPanel === "layers"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <button
          type="button"
          className={!sidebarCollapsed && sidebarPanel === "analysis" ? "sidebar-rail__layers-button sidebar-rail__layers-button--active" : "sidebar-rail__layers-button"}
          onClick={() => {
            if (!sidebarCollapsed && sidebarPanel === "analysis") { onToggleSidebar?.(); return; }
            setSidebarPanel("analysis");
            if (sidebarCollapsed) onToggleSidebar?.();
          }}
          title={!sidebarCollapsed && sidebarPanel === "analysis" ? "Hide quick analysis panel" : "Quick analysis"}
          aria-label={!sidebarCollapsed && sidebarPanel === "analysis" ? "Hide quick analysis panel" : "Quick analysis"}
          aria-pressed={!sidebarCollapsed && sidebarPanel === "analysis"}
          data-testid="quick-analysis-toggle"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
            <path d="M4 20V11m6.5 9V4m6.5 16v-7.5" />
          </svg>
        </button>
      </aside>
      {!sidebarCollapsed && sidebarPanel === "analysis" && (
        <QuickAnalysisPanel
          selectedCardId={quickAnalysisCardId}
          onSelectCard={selectQuickAnalysis}
        />
      )}
      {!sidebarCollapsed && sidebarPanel === "layers" && <CommandCenter
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
      />}
      <div className="map-canvas" data-testid="map-canvas">
        <div ref={containerRef} className="map-canvas__map" data-testid="map-gl" />
        {quickAnalysisCardId && QUICK_ANALYSIS_MAP_CONFIG[quickAnalysisCardId] && (
          <QuickAnalysisMapDashboard
            cardId={quickAnalysisCardId}
            title={QUICK_ANALYSIS_MAP_CONFIG[quickAnalysisCardId].title}
            description={QUICK_ANALYSIS_MAP_CONFIG[quickAnalysisCardId].description}
            datasetIds={activeDatasetIds}
            features={quickAnalysisFeatures}
            loading={quickAnalysisLoading}
            error={quickAnalysisError}
            drainEncroachment={quickDrainEncroachment}
            drainEncroachmentLoading={quickDrainEncroachmentLoading}
            drainEncroachmentError={quickDrainEncroachmentError}
            manholeNetworkLoading={quickAnalysisManholeNetworkLoading}
            manholeNetworkError={quickAnalysisManholeNetworkError}
            manholeNetworkRouteCount={quickAnalysisManholeNetwork?.routes.length ?? 0}
            manholeNetworkFlowCount={quickAnalysisManholeNetwork?.routes.filter((route) => route.flow_confirmed).length ?? 0}
            manholeNetworkStatusCounts={quickAnalysisManholeNetworkStatusCounts}
            anomalies={anomalies}
            selectedFeature={selectedQuickAnalysisFeature}
            selectedConnection={selectedQuickAnalysisConnection}
            activeTool={measureActive ? "measure" : quickAnalysisTool}
            utilitySubCategory={utilitySubCategory}
            onSelectUtilitySubCategory={setUtilitySubCategory}
            onActivateSelect={activateQuickAnalysisSelect}
            onActivateMeasure={activateQuickAnalysisMeasure}
            onClearSelectedFeature={() => setSelectedQuickAnalysisFeature(null)}
            onClearSelectedConnection={() => setSelectedQuickAnalysisConnection(null)}
            onClose={closeQuickAnalysis}
          />
        )}
        {!quickAnalysisCardId && <MapControls
          basemap={basemap}
          onChangeBasemap={changeBasemap}
          status={status}
          detectionMode={detectionMode}
          onToggleDetectionMode={toggleDetectionMode}
          roadInspectionActive={roadInspectionActive}
          onToggleRoadInspection={toggleRoadInspection}
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
          hideBasemap={sidebarPanel === "analysis"}
          measureActive={measureActive}
          onToggleMeasure={toggleMeasureActive}
        />}
        {!quickAnalysisCardId && <HoverTooltip hover={hover} />}
        {selectedAnomaly && (
          <AnomalyAlertCard
            anomaly={selectedAnomaly}
            onClose={() => setSelectedAnomalyId(null)}
            onStatusChange={handleAnomalyStatusChange}
            onStale={handleAnomalyStale}
          />
        )}
        {roadInspectionRoad && (
          <RoadInspectionCard
            roadLabel={roadInspectionRoad.properties.label}
            report={roadInspectionReport}
            loading={roadInspectionLoading}
            error={roadInspectionError}
            onClose={closeRoadInspection}
            onSelectIssue={(issueId) => {
              closeRoadInspection();
              setSelectedAnomalyId(issueId);
            }}
          />
        )}
        {placemarkMode && !placemarkDraft && (
          <div className="placemark-pick-hint" data-testid="placemark-pick-hint">
            {t("map.placemarkHint")}
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
        {!quickAnalysisCardId && <MapStatusBar
          lngLat={cursorLngLat}
          scaleLabel={mapScaleLabel}
          datasetName={activeStatusDataset?.name ?? null}
          surveyDate={activeStatusDataset?.survey_date ?? null}
          elevation={elevationSample?.elevation ?? null}
          eyeAltitudeMeters={eyeAltitudeMeters}
        />}
        {!quickAnalysisCardId && <div className="map-side-controls">
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
            className="map-side-btn"
            onClick={() => setShow3DPlan(true)}
            title={t("map.view.3dViewer")}
            aria-label={t("map.view.3dViewer")}
            data-testid="topbar-3d-viewer"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5z" />
              <path d="M12 12v8.5M12 12l7.5-4.3M12 12L4.5 7.7" />
            </svg>
          </button>
        </div>}
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
            {t("map.streetPickHint")}
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
            {t("map.view.selectDataset")}
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
  const { t } = useLanguage();
  const [layerQuery, setLayerQuery] = useState("");
  const [layerMenu, setLayerMenu] = useState<{ category: string; x: number; y: number } | null>(null);
  const [openSections, setOpenSections] = useState<Record<"dataSources" | "spatialAudit" | "categoryVisibility", boolean>>(() => {
    try {
      const saved = window.localStorage.getItem("davangere.command-center-sections");
      if (saved) return { dataSources: true, spatialAudit: true, categoryVisibility: true, ...JSON.parse(saved) };
    } catch { /* use expanded defaults */ }
    return { dataSources: true, spatialAudit: true, categoryVisibility: true };
  });
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
  const toggleSection = useCallback((section: "dataSources" | "spatialAudit" | "categoryVisibility") => {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  }, []);

  useEffect(() => {
    window.localStorage.setItem("davangere.command-center-sections", JSON.stringify(openSections));
  }, [openSections]);
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
            aria-label={t("map.cc.closeDataSources")}
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
            open={openSections.dataSources}
            onToggleOpen={() => toggleSection("dataSources")}
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
            aria-label={t("map.viz.geometryStylingLabel")}
            style={{
              top: visualizationPopupPosition.top,
              left: visualizationPopupPosition.left,
              width: visualizationPopupPosition.width,
              maxHeight: visualizationPopupPosition.maxHeight,
              ...visualizationDrag.style,
            }}
          >
            <div className="floating-map-panel__dragbar" onPointerDown={visualizationDrag.onDragStart}>
              <span>{t("map.viz.geometryStyling")}</span>
              <small>{t("map.viz.dragToReposition")}</small>
              <button type="button" onClick={() => setVisualizationOpen(false)} aria-label={t("map.viz.geometryStylingLabel")}>×</button>
            </div>
            <VisualizationPanel {...visualization} />
          </div>,
          document.body
        )}

        {activeDatasetIds.length > 0 && detectionMode === "manholes" && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <button
                type="button"
                className="command-center__section-toggle"
                onClick={() => toggleSection("spatialAudit")}
                aria-expanded={openSections.spatialAudit}
                aria-controls="spatial-audit-panel"
              >
                <svg className={`command-center__chevron${openSections.spatialAudit ? " command-center__chevron--open" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m8 10 4 4 4-4" />
                </svg>
                <span className="command-center__section-title">Spatial Audit</span>
              </button>
            </div>
            {openSections.spatialAudit && <div id="spatial-audit-panel">
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
            </div>}
          </div>
        )}

        {categoryStats.length > 0 && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <button
                type="button"
                className="command-center__section-toggle"
                onClick={() => toggleSection("categoryVisibility")}
                aria-expanded={openSections.categoryVisibility}
                aria-controls="category-visibility-panel"
              >
                <svg className={`command-center__chevron${openSections.categoryVisibility ? " command-center__chevron--open" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m8 10 4 4 4-4" />
                </svg>
                <span className="command-center__section-title">{t("map.cc.categoryVisibility")}</span>
              </button>
              {openSections.categoryVisibility &&
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
                {(detectionMode ? extraVisibleCategories.size === 0 : hiddenCategories.size > 0) ? t("map.cc.showAll") : t("map.cc.hideAll")}
              </button>}
            </div>
            {openSections.categoryVisibility && <div id="category-visibility-panel">
            <div className="layer-search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m16.5 16.5 4 4" />
              </svg>
              <input
                type="search"
                value={layerQuery}
                onChange={(event) => setLayerQuery(event.target.value)}
                placeholder={t("map.cc.searchLayersPlaceholder")}
                aria-label={t("map.cc.searchLayersPlaceholder")}
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
                                   <li className="layer-attributes__empty">{t("map.cc.noAttributes")}</li>
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
                  <div className="layer-list__empty">{t("map.cc.noMatchingLayers")}</div>
                )
                : displayedLayers.length === 0 && (
                  <div className="layer-list__empty">{t("map.cc.noMatchingLayers")}</div>
                )}
            </div>
            </div>}
          </div>
        )}
      </div>
      {spatialAuditStatus === "success" && (
        <div className="command-center__audit-success" role="status" aria-live="polite">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
          <span>{t("map.cc.spatialAuditSuccess")}</span>
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
           aria-label={`${layerMenu.category} ${t("map.measure.layerActions")}`}
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
            {t("map.cc.openAttributeTable")}
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
  const { t } = useLanguage();
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
    { value: "default", label: t("map.viz.default"), enabled: true },
    { value: "category", label: t("map.viz.category"), enabled: targetFields.some((candidate) => (
      (candidate.detected_type === "string" || candidate.detected_type === "boolean")
      && (candidate.unique_count ?? 0) > 1
      && (candidate.unique_count ?? 0) <= 50
    )) },
    { value: "numeric", label: t("map.viz.numeric"), enabled: targetFields.some((candidate) => candidate.detected_type === "number") },
    { value: "missing-data", label: t("map.viz.missing"), enabled: targetFields.some((candidate) => candidate.missing_count > 0) },
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
    { value: "point", label: t("map.viz.points"), count: pointCount },
    { value: "line", label: t("map.viz.lines"), count: lineCount },
    { value: "polygon", label: t("map.viz.polygons"), count: polygonCount },
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
          <div className="visualization-panel__eyebrow">{t("map.viz.visualization")}</div>
          <div className="visualization-panel__title">{t("map.viz.geometryStyling")}</div>
        </div>
        <span className="visualization-panel__live"><span aria-hidden="true" /> {t("map.viz.live")}</span>
      </div>

      {!selectedDataset ? (
        <div className="visualization-panel__empty">
          {t("map.viz.clickLayer")}
        </div>
      ) : (
        <>
          <div className="visualization-panel__dataset" title={selectedDataset.name}>{selectedDataset.name}</div>

          {loading && <div className="visualization-panel__loading"><span className="visualization-panel__spinner" />{t("map.viz.profiling")}</div>}
          {error && !loading && <div className="visualization-panel__error">{t("map.viz.couldNotLoad")}{error}</div>}

          {manifest && !loading && (
            <>
              <div className="visualization-panel__summary visualization-panel__summary--v3">
                <div><strong>{compactFeatureCount(allCount)}</strong><span>{t("map.viz.features")}</span></div>
                <div><strong>{[pointCount, lineCount, polygonCount].filter((count) => count > 0).length}</strong><span>{t("map.viz.geometryTypes")}</span></div>
                <div><strong>{manifest.source_format.toUpperCase()}</strong><span>{t("map.viz.source")}</span></div>
              </div>

              <div className="visualization-target-block">
                <div className="visualization-target-block__label">{t("map.viz.targetGeometry")}</div>
                <div className="visualization-target-grid" role="group" aria-label={t("map.viz.targetGeometry")}>
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

function MapControls({
  basemap,
  onChangeBasemap,
  status,
  detectionMode,
  onToggleDetectionMode,
  roadInspectionActive,
  onToggleRoadInspection,
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
  hideBasemap,
  measureActive,
  onToggleMeasure,
}: {
  basemap: Basemap;
  onChangeBasemap: (b: Basemap) => void;
  hideBasemap?: boolean;
  status: ViewportStatus;
  detectionMode: DetectionMode;
  onToggleDetectionMode: (mode: Exclude<DetectionMode, null>) => void;
  roadInspectionActive: boolean;
  onToggleRoadInspection: () => void;
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
  measureActive: boolean;
  onToggleMeasure: () => void;
}) {
  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [activeToolsSection, setActiveToolsSection] = useState<"location" | null>(null);
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
  // useDraggableMapPanel persists an absolute drag offset across opens
  // (correct for panels with a fixed anchor). This menu's anchor moves
  // (aiWrapRef slides with the toolbox state), so trusting its persisted
  // style from a stale/previous anchor position visibly drops the menu on
  // top of the icon instead of beside it. Only trust it once the user has
  // actually dragged THIS open; otherwise always use the freshly measured
  // menuPos below.
  const [aiMenuDragged, setAiMenuDragged] = useState(false);
  const [aiOffsetY, setAiOffsetY] = useState(0);
  const toolsControlRef = useRef<HTMLDivElement | null>(null);
  const basemapControlRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (!basemapMenuOpen) return;
    const onClickOutside = (event: MouseEvent) => {
      if (!basemapControlRef.current?.contains(event.target as Node)) setBasemapMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBasemapMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [basemapMenuOpen]);

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
    setAiMenuDragged(false);
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
    roadInspectionActive ||
    streetPickMode ||
    placemarkMode ||
    myPlacesOpen ||
    coordinateSearchOpen ||
    measureActive ||
    Object.values(referenceLayers).some(Boolean)
  );

  return (
    <>
      <div className="feature-count" data-testid="viewport-status">
        {status.loading ? "loading..." : `${status.count} features`}
      </div>
      {!hideBasemap && (
      <div className="basemap-picker" ref={basemapControlRef}>
        <button
          type="button"
          className={`basemap-picker__toggle${basemapMenuOpen ? " basemap-picker__toggle--open" : ""}`}
          onClick={() => setBasemapMenuOpen((current) => !current)}
          aria-label="Choose map style"
          aria-expanded={basemapMenuOpen}
          aria-controls="basemap-picker-menu"
          title="Map style"
          data-testid="basemap-picker-toggle"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.8 2.5 4.2 5.5 4.2 9S14.8 18.5 12 21c-2.8-2.5-4.2-5.5-4.2-9S9.2 5.5 12 3Z" />
          </svg>
        </button>
        {basemapMenuOpen && (
          <div id="basemap-picker-menu" className="basemap-picker__menu" role="menu" aria-label="Map styles">
            <button type="button" className={basemap === "street" ? "is-active" : ""} onClick={() => { onChangeBasemap("street"); setBasemapMenuOpen(false); }} title="Street" aria-label="Street" data-testid="basemap-street">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M7 3 6 21M17 3l1 18" /><path d="M12 4v3M12 10.5v3M12 17v3" /></svg>
            </button>
            <button type="button" className={basemap === "satellite" ? "is-active" : ""} onClick={() => { onChangeBasemap("satellite"); setBasemapMenuOpen(false); }} title="Satellite" aria-label="Satellite" data-testid="basemap-satellite">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="6" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-20 12 12)" /></svg>
            </button>
            <button type="button" className={basemap === "off" ? "is-active" : ""} onClick={() => { onChangeBasemap("off"); setBasemapMenuOpen(false); }} title="No basemap" aria-label="No basemap" data-testid="basemap-off">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M4 20 20 4" /></svg>
            </button>
          </div>
        )}
      </div>
      )}
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" width="19" height="19" aria-hidden="true">
            <rect x="3" y="8" width="18" height="12" rx="2" />
            <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M3 13h18" />
            <path d="M10 13v2M14 13v2" />
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

            {/* Direct action, not a category with a sub-panel — one click
                after opening the toolbox reaches Measure, same depth as
                every other rail button, instead of being buried inside the
                Location panel's list of six tools. */}
            <button
              type="button"
              className={`map-tools__category-btn${measureActive ? " map-tools__category-btn--active" : ""}`}
              onClick={onToggleMeasure}
              aria-label="Measure distances and areas on the map"
              aria-pressed={measureActive}
              title="Measure"
              data-testid="map-tools-category-measure"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="17" height="17" aria-hidden="true">
                <rect x="2.5" y="8" width="19" height="8" rx="1.5" transform="rotate(-45 12 12)" />
                <g transform="rotate(-45 12 12)">
                  <path d="M6 8v3M9.5 8v2M13 8v3M16.5 8v2" />
                </g>
              </svg>
            </button>
          </div>

          <div className="map-tools__content">
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
            className={`map-tools__ai-standalone${(showDetectionList || showDetectionStatus) ? " map-tools__ai-standalone--active" : ""}${(detectionMode || roadInspectionActive) ? " map-tools__ai-standalone--has-active" : ""}`}
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
            {(detectionMode || roadInspectionActive) && <span className="map-tools__category-dot" aria-hidden="true" />}
          </button>

          {showDetectionList && menuPos && createPortal(
            <div
              className="ai-detection-menu"
              data-testid="ai-detection-menu"
              ref={(node) => {
                portalMenuRef.current = node;
                aiMenuDrag.panelRef.current = node;
              }}
              style={{ position: "fixed", ...(aiMenuDragged ? aiMenuDrag.style : { top: menuPos.top, left: menuPos.left }) }}
            >
              <div
                className="floating-map-panel__dragbar"
                onPointerDown={(event) => {
                  setAiMenuDragged(true);
                  aiMenuDrag.onDragStart(event);
                }}
              >
                <span>AI Detection</span>
                <small>Drag</small>
                <button type="button" onClick={() => setShowDetectionList(false)} aria-label="Close AI Detection">×</button>
              </div>
              {(["poles", "drains", "manholes", "roads"] as const).map((mode) => (
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
              <button
                type="button"
                className={`ai-detection-menu__item${roadInspectionActive ? " ai-detection-menu__item--active" : ""}`}
                onClick={() => {
                  onToggleRoadInspection();
                  setShowDetectionList(false);
                  setShowDetectionStatus(true);
                }}
                data-testid="road-inspection-mode"
              >
                Road Inspection
              </button>
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
          {showDetectionStatus && (detectionMode || roadInspectionActive) && (
            <div className="ai-status-card" data-testid="ai-status-card">
              <span className="ai-status-card__label">
                AI Detection : {roadInspectionActive ? "Road Inspection" : detectionMode ? DETECTION_MODE_LABEL[detectionMode] : ""}
              </span>
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
                <span className="map-controls__btn-label">{aiOverlayEnabled ? "ON" : "OFF"}</span>
              </button>
              )}
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
  const hasHoverCoordinates = Number.isFinite(hover.latitude) && Number.isFinite(hover.longitude);
  // Only show attributes that actually have a value — most survey rows
  // leave many condition/status fields blank, and a tooltip full of "—"
  // placeholders is noise, not information.
  const isPhoto = hover.category === "site_photo";
  const isPanorama = isPhoto && hover.attributes.is_360 === true;
  const attrEntries = Object.entries(hover.attributes).filter(([k, v]) => {
    if (hasHoverCoordinates && isCoordinateAttributeKey(k)) return false;
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
      {(hasHoverCoordinates || attrEntries.length > 0) && (
        <div className="map__tooltip-attrs">
          {hasHoverCoordinates && (
            <>
              <div className="map__tooltip-attr-row">
                <span className="map__tooltip-attr-key">Latitude</span>
                <span className="map__tooltip-attr-val">{formatHoverCoordinate(hover.latitude!)}</span>
              </div>
              <div className="map__tooltip-attr-row">
                <span className="map__tooltip-attr-key">Longitude</span>
                <span className="map__tooltip-attr-val">{formatHoverCoordinate(hover.longitude!)}</span>
              </div>
            </>
          )}
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

function isCoordinateAttributeKey(key: string): boolean {
  const normalized = key.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return [
    "latitude",
    "lat",
    "gpslat",
    "ylat",
    "longitude",
    "long",
    "lng",
    "lon",
    "gpslon",
    "xlong",
  ].includes(normalized);
}

function formatHoverCoordinate(value: number): string {
  return value.toFixed(6);
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
export function ZoomSlider({
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
