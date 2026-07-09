import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import maplibregl, { Map as MLMap, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { fetchFeaturesInViewport } from "../lib/features";
import type { FeatureFilter, UrbanFeature, FeatureCollectionResponse } from "../lib/types";
import { ApiError } from "../lib/api";
import { colorForCategory, UNCATEGORIZED_COLOR } from "../lib/categoryColors";
import { fetchDatasets, fetchDatasetBounds, type DatasetRow } from "../lib/workflow";

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

function previewModeForSettings(settings: RasterDisplaySettings): "rgb" | "grayscale" {
  return settings.colorMode === "grayscale" ? "grayscale" : "rgb";
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
  const baseContrast = normalized.colorMode === "enhanced" ? 0.08 : 0;
  const clarityContrast = normalized.clarity * 0.45;
  const saturation = normalized.colorMode === "grayscale" ? -1 : normalized.colorMode === "enhanced" ? 0.25 : 0;
  const brightnessMin = normalized.colorMode === "enhanced" ? 0.03 : 0;
  const brightnessMax = clamp(1 - normalized.clarity * 0.12 - (normalized.colorMode === "enhanced" ? 0.02 : 0), 0.65, 1);

  return {
    "raster-opacity": 0.85,
    "raster-saturation": saturation,
    "raster-contrast": clamp(baseContrast + clarityContrast, -1, 1),
    "raster-brightness-min": brightnessMin,
    "raster-brightness-max": brightnessMax,
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

function geometryCenter(geometry: GeoJSON.Geometry): [number, number] | null {
  const coords: number[][] = [];
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") { coords.push(c as number[]); return; }
    if (Array.isArray(c)) c.forEach(walk);
  };
  if ("coordinates" in geometry) walk(geometry.coordinates);
  if (coords.length === 0) return null;
  return [coords.reduce((s, c) => s + c[0], 0) / coords.length, coords.reduce((s, c) => s + c[1], 0) / coords.length];
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
}
export interface MapCanvasHandle { clearDatasets: () => void; }

export const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(
  { filter, onFeatureSelect, onActiveDatasetsChange, initialActiveDatasets },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const filterRef = useRef<FeatureFilter>(filter);

  const [status, setStatus] = useState<ViewportStatus>({ loading: false, count: 0, truncated: false, error: null, bbox: null });
  const [legend, setLegend] = useState<LegendEntry[]>([]);
  const [basemap, setBasemap] = useState<Basemap>("street");
  const [hover, setHover] = useState<HoverInfo | null>(null);
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
  const rasterSettingsRef = useRef<Record<string, RasterDisplaySettings>>({});
  const [flyError, setFlyError] = useState<string | null>(null);
  const [topSeverity, setTopSeverity] = useState<UrbanFeature[]>([]);
  const [activeFeatureId, setActiveFeatureId] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDatasets(ctrl.signal).then(setDatasets).catch(() => {});
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

    const colorMap = colorByCategoryRef.current;
    const counts = new Map<string, number>();
    for (const f of data.features as unknown as GeoJSON.Feature[]) {
      const raw = (f.properties as { category?: string | null } | null)?.category;
      if (raw === "raster_pixel") continue; // internal sample grid Ã¢â‚¬â€ already visualized as the raster image itself
      const category = raw && raw.trim() !== "" ? raw : "uncategorized";
      if (!colorMap.has(category)) colorMap.set(category, colorForCategory(category));
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    const colorExpr = buildCategoryColorExpression(colorMap);
    if (map.getLayer(LAYER_POINTS)) map.setPaintProperty(LAYER_POINTS, "circle-color", colorExpr);
    if (map.getLayer(LAYER_LINES)) map.setPaintProperty(LAYER_LINES, "line-color", colorExpr);
    if (map.getLayer(LAYER_POLY_FILL)) map.setPaintProperty(LAYER_POLY_FILL, "fill-color", colorExpr);

    const entries: LegendEntry[] = Array.from(counts.entries())
      .map(([category, count]) => ({ category, color: colorMap.get(category)!, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    setLegend(entries);

    const ranked = (data.features as unknown as GeoJSON.Feature[])
      .map(decodeFeature)
      .filter((f) => f.properties.severity > 0 && f.properties.category !== "raster_pixel")
      .sort((a, b) => b.properties.severity - a.properties.severity)
      .slice(0, 8);
    setTopSeverity(ranked);
  }, []);

  const selectFeature = useCallback((feature: UrbanFeature) => {
    const map = mapRef.current;
    setActiveFeatureId(feature.properties.id);
    onFeatureSelect(feature);
    const center = geometryCenter(feature.geometry);
    if (map && center) map.flyTo({ center, zoom: Math.max(map.getZoom(), 17), duration: 900 });
  }, [onFeatureSelect]);

  const runFetch = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
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

  const removeRasterOverlay = useCallback((datasetId: string) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
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
  useEffect(() => {
    if (!mapReady || activeDatasetIds.length === 0) return;
    const matched = datasets.filter((d) => activeDatasetIds.includes(d.id));
    if (matched.length === 0) return;
    for (const d of matched) addRasterOverlay(d);
    filterRef.current = { datasetIds: activeDatasetIds };
    scheduleFetch();
    // Only re-run when the map/datasets actually become ready or the
    // persisted id list itself changes Ã¢â‚¬â€ not on every addRasterOverlay
    // identity change, which would fight with toggleDataset's own call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, datasets, activeDatasetIds]);

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
      map.addLayer({ id: LAYER_POLY_FILL, type: "fill", source: FEATURE_SOURCE, filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]], paint: { "fill-color": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, "#3aa1ff", 0.5, "#f5c542", 1, "#ff5a3d"], "fill-opacity": 0.35 } });
      map.addLayer({ id: LAYER_POLY_OUTLINE, type: "line", source: FEATURE_SOURCE, filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]], paint: { "line-color": "#0b1013", "line-width": 1 } });
      map.addLayer({ id: LAYER_LINES, type: "line", source: FEATURE_SOURCE, filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]], paint: { "line-color": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, "#3aa1ff", 0.5, "#f5c542", 1, "#ff5a3d"], "line-width": 2.5 } });
      map.addLayer({
        id: LAYER_POINTS,
        type: "circle",
        source: FEATURE_SOURCE,
        // raster_pixel features are the raster reader's internal sample
        // grid (kept for the feature table / severity / AI summary) Ã¢â‚¬â€ the
        // actual image overlay already shows the raster visually, so the
        // grid of dots on top of it would just be redundant clutter.
        filter: ["all", ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]], ["!=", ["get", "category"], "raster_pixel"]],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 6, 16, 10], "circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, "#3aa1ff", 0.5, "#f5c542", 1, "#ff5a3d"], "circle-stroke-color": "#0b1013", "circle-stroke-width": 1.5, "circle-opacity": 0.9 },
      });

      const CLICKABLE = [LAYER_POINTS, LAYER_LINES, LAYER_POLY_FILL];
      const handleClick = (e: MapMouseEvent) => { const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE }); if (!hit.length) return; const selected = decodeFeature(hit[0]); setActiveFeatureId(selected.properties.id); onFeatureSelect(selected); };
      const handleHover = (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE });
        if (!hit.length) { setHover(null); return; }
        // Reuse the same decoder as click-select so the tooltip shows the
        // exact same fully-parsed attributes as the detail panel does.
        const decoded = decodeFeature(hit[0]);
        const category = decoded.properties.category || "uncategorized";
        setHover({
          x: e.point.x,
          y: e.point.y,
          label: decoded.properties.label || "-",
          category,
          severity: decoded.properties.severity,
          color: colorForCategory(category),
          attributes: decoded.properties.attributes,
        });
      };
      CLICKABLE.forEach((id) => { map.on("click", id, handleClick); map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer")); map.on("mousemove", id, handleHover); map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; setHover(null); }); });
      void runFetch();
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
        topSeverity={topSeverity}
        activeFeatureId={activeFeatureId}
        onSelectFeature={selectFeature}
        status={status}
      />
      <div className="map-canvas" data-testid="map-canvas">
        <div ref={containerRef} className="map-canvas__map" data-testid="map-gl" />
        <MapControls basemap={basemap} onChangeBasemap={changeBasemap} status={status} />
        <MapLegend entries={legend} />
        <HoverTooltip hover={hover} />
      </div>
    </>
  );
});

function CommandCenter({
  datasets, activeDatasetIds, flyError, onSelectDataset, onClearDataset, expandedDatasetId, onToggleDatasetSettings,
  rasterSettingsById, onChangeRasterSettings, topSeverity, activeFeatureId, onSelectFeature, status: _status,
}: {
  datasets: DatasetRow[]; activeDatasetIds: string[]; flyError: string | null; onSelectDataset: (d: DatasetRow) => void;
  onClearDataset: () => void;
  expandedDatasetId: string | null;
  onToggleDatasetSettings: (datasetId: string) => void;
  rasterSettingsById: Record<string, RasterDisplaySettings>;
  onChangeRasterSettings: (datasetId: string, patch: Partial<RasterDisplaySettings>) => void;
  topSeverity: UrbanFeature[]; activeFeatureId: string | null; onSelectFeature: (f: UrbanFeature) => void;
  status: ViewportStatus;
}) {
  const topFeatures = topSeverity.slice(0, 5);

  return (
    <aside className="command-center" data-testid="command-center">
      <div className="command-center__header">
        <div className="command-center__eyebrow">Command Center</div>
        <div className="command-center__title">Davangere<br/>Live Ops</div>
      </div>
      <div className="command-center__body">
        {datasets.length > 0 && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <span className="command-center__section-title">Data Sources</span>
              {activeDatasetIds.length > 0 ? (
                <button
                  type="button"
                  onClick={onClearDataset}
                  data-testid="clear-dataset-filter"
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--accent)", fontSize: 10.5, fontWeight: 700,
                    letterSpacing: "0.04em", textTransform: "uppercase",
                  }}
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
                    <div className="dataset-card__icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </div>
                    <div className="dataset-card__info">
                      <div className="dataset-card__name">{d.name}</div>
                      <div className="dataset-card__meta">{d.ward ? `Ward ${d.ward}` : "All wards"} - {d.file_type}</div>
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

        {topFeatures.length > 0 && (
          <div className="command-center__section">
            <div className="command-center__section-head">
              <span className="command-center__section-title">Top Severity</span>
              <span className="command-center__section-count">{topFeatures.length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topFeatures.map((f) => {
                const tier = f.properties.severity >= 0.67 ? "critical" : f.properties.severity >= 0.34 ? "high" : "medium";
                const isActive = activeFeatureId === f.properties.id;
                return (
                  <div
                    key={f.properties.id}
                    onClick={() => onSelectFeature(f)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                      background: isActive ? "var(--accent-muted)" : "var(--surface-2)",
                      border: `1px solid ${isActive ? "var(--accent)" : "var(--edge)"}`,
                      borderRadius: "var(--radius-md)", cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                    data-testid={`map-severity-${f.properties.id}`}
                  >
                    <div style={{
                      width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                      background: tier === "critical" ? "var(--danger)" : tier === "high" ? "#f97316" : "var(--warn)",
                      boxShadow: tier === "critical" ? "0 0 8px var(--danger)" : "none",
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {f.properties.label || f.properties.category || "Unnamed"}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--ink-mute)", marginTop: 1 }}>
                        {f.properties.category || "uncategorized"}
                      </div>
                    </div>
                    <div style={{
                      fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)",
                      padding: "2px 8px", borderRadius: "var(--radius-sm)",
                      background: tier === "critical" ? "var(--danger-muted)" : tier === "high" ? "rgba(249, 115, 22, 0.15)" : "var(--warn-muted)",
                      color: tier === "critical" ? "var(--danger)" : tier === "high" ? "#f97316" : "var(--warn)",
                    }}>
                      {f.properties.severity.toFixed(2)}
                    </div>
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
function MapControls({ basemap, onChangeBasemap, status }: { basemap: Basemap; onChangeBasemap: (b: Basemap) => void; status: ViewportStatus }) {
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
  const attrEntries = Object.entries(hover.attributes).filter(([k, v]) => {
    if (k === "gdb_layer") return false;
    if (v === null || v === undefined) return false;
    if (typeof v === "string" && (v.trim() === "" || v.trim().toLowerCase() === "nan")) return false;
    return true;
  });
  return (
    <div className="map__tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }} data-testid="map-tooltip">
      <div className="map__tooltip-head">
        <span className="map__tooltip-swatch" style={{ background: hover.color }} />
        <span className="map__tooltip-name">{hover.label}</span>
      </div>
      <div className="map__tooltip-row">
        <span>{hover.category}</span>
        <span className="map__tooltip-sev">sev {hover.severity.toFixed(2)}</span>
      </div>
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
