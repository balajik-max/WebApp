import { useEffect, useRef, useState, useCallback } from "react";
import maplibregl, { Map as MLMap, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { fetchFeaturesInViewport } from "../lib/features";
import type { FeatureFilter, UrbanFeature, FeatureCollectionResponse } from "../lib/types";
import { ApiError } from "../lib/api";
import { colorForCategory, UNCATEGORIZED_COLOR } from "../lib/categoryColors";

interface Props {
  filter: FeatureFilter;
  onFeatureSelect: (feature: UrbanFeature | null) => void;
}

// Davangere city centre — Karnataka, India (approx.)
const DAVANGERE_CENTER: [number, number] = [75.9218, 14.4644];
const DAVANGERE_ZOOM = 12;

// Free OSM raster tile style — no API key required.
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    "osm-tiles": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    { id: "osm", type: "raster", source: "osm-tiles", minzoom: 0, maxzoom: 22 },
  ],
};

const FEATURE_SOURCE = "urban-features";
const LAYER_POINTS = "urban-features-points";
const LAYER_LINES = "urban-features-lines";
const LAYER_POLY_FILL = "urban-features-poly-fill";
const LAYER_POLY_OUTLINE = "urban-features-poly-outline";

function buildCategoryColorExpression(
  colorByCategory: Map<string, string>
): maplibregl.ExpressionSpecification {
  const pairs: (string | maplibregl.ExpressionSpecification)[] = [];
  colorByCategory.forEach((color, category) => {
    pairs.push(category, color);
  });
  return ["match", ["coalesce", ["get", "category"], "uncategorized"], ...pairs, UNCATEGORIZED_COLOR] as unknown as maplibregl.ExpressionSpecification;
}

const EMPTY_FC: FeatureCollectionResponse = {
  type: "FeatureCollection",
  features: [],
  bbox: [0, 0, 0, 0],
  count: 0,
  limit: 0,
  truncated: false,
};

export interface ViewportStatus {
  loading: boolean;
  count: number;
  truncated: boolean;
  error: string | null;
  bbox: [number, number, number, number] | null;
}

export interface LegendEntry {
  category: string;
  color: string;
  count: number;
}

export interface MapCanvasHandle {
  status: ViewportStatus;
}

export function MapCanvas({ filter, onFeatureSelect }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const filterRef = useRef<FeatureFilter>(filter);

  const [status, setStatus] = useState<ViewportStatus>({
    loading: false,
    count: 0,
    truncated: false,
    error: null,
    bbox: null,
  });
  const [legend, setLegend] = useState<LegendEntry[]>([]);
  const colorByCategoryRef = useRef<Map<string, string>>(new Map());

  // Keep a ref to the latest filter so moveend handler always sees it.
  useEffect(() => {
    filterRef.current = filter;
    // If the map is already mounted, refetch with the new filter.
    if (mapRef.current) {
      scheduleFetch();
    }
  }, [filter]);

  const applyFeatureCollection = useCallback((data: FeatureCollectionResponse) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource(FEATURE_SOURCE) as GeoJSONSource | undefined;
    if (src) {
      src.setData(data as unknown as GeoJSON.FeatureCollection);
    }

    // Assign a stable color to every category we've ever seen, then tally
    // counts for the current viewport so the legend + map paint stay in sync.
    const colorMap = colorByCategoryRef.current;
    const counts = new Map<string, number>();
    for (const f of data.features as unknown as GeoJSON.Feature[]) {
      const raw = (f.properties as { category?: string | null } | null)?.category;
      const category = raw && raw.trim() !== "" ? raw : "uncategorized";
      if (!colorMap.has(category)) {
        colorMap.set(category, colorForCategory(category));
      }
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
  }, []);

  const runFetch = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    // Abort any in-flight request first.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const bounds = map.getBounds();
    const bbox: [number, number, number, number] = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ];

    setStatus((prev) => ({ ...prev, loading: true, error: null, bbox }));

    try {
      const data = await fetchFeaturesInViewport(
        bbox,
        filterRef.current,
        controller.signal
      );
      applyFeatureCollection(data);
      setStatus({
        loading: false,
        count: data.count,
        truncated: data.truncated,
        error: null,
        bbox,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg =
        err instanceof ApiError ? `${err.status} — ${err.message}` : (err as Error).message;
      applyFeatureCollection(EMPTY_FC);
      setStatus({ loading: false, count: 0, truncated: false, error: msg, bbox });
    }
  }, [applyFeatureCollection]);

  const scheduleFetch = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void runFetch();
    }, 250);
  }, [runFetch]);

  // ---- Bootstrap the map once. ----------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: DAVANGERE_CENTER,
      zoom: DAVANGERE_ZOOM,
      minZoom: 4,
      maxZoom: 20,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      map.addSource(FEATURE_SOURCE, {
        type: "geojson",
        data: EMPTY_FC as unknown as GeoJSON.FeatureCollection,
        promoteId: "id",
      });

      map.addLayer({
        id: LAYER_POLY_FILL,
        type: "fill",
        source: FEATURE_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["coalesce", ["get", "severity"], 0],
            0, "#3aa1ff",
            0.5, "#f5c542",
            1, "#ff5a3d",
          ],
          "fill-opacity": 0.35,
        },
      });

      map.addLayer({
        id: LAYER_POLY_OUTLINE,
        type: "line",
        source: FEATURE_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        paint: { "line-color": "#0b1013", "line-width": 1 },
      });

      map.addLayer({
        id: LAYER_LINES,
        type: "line",
        source: FEATURE_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]],
        paint: {
          "line-color": [
            "interpolate", ["linear"], ["coalesce", ["get", "severity"], 0],
            0, "#3aa1ff",
            0.5, "#f5c542",
            1, "#ff5a3d",
          ],
          "line-width": 2.5,
        },
      });

      map.addLayer({
        id: LAYER_POINTS,
        type: "circle",
        source: FEATURE_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            8, 3, 12, 6, 16, 10,
          ],
          "circle-color": [
            "interpolate", ["linear"], ["coalesce", ["get", "severity"], 0],
            0, "#3aa1ff",
            0.5, "#f5c542",
            1, "#ff5a3d",
          ],
          "circle-stroke-color": "#0b1013",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.9,
        },
      });

      const CLICKABLE = [LAYER_POINTS, LAYER_LINES, LAYER_POLY_FILL];

      const handleClick = (e: MapMouseEvent) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE });
        if (!hit.length) return;
        const raw = hit[0];
        // GeoJSON source rehydrates properties as JSON strings when they
        // are objects — decode `attributes` explicitly.
        const props = raw.properties ?? {};
        let attrs: Record<string, unknown> = {};
        if (typeof props.attributes === "string") {
          try {
            attrs = JSON.parse(props.attributes);
          } catch {
            attrs = { _raw: props.attributes };
          }
        } else if (props.attributes && typeof props.attributes === "object") {
          attrs = props.attributes as Record<string, unknown>;
        }

        const selected: UrbanFeature = {
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
        onFeatureSelect(selected);
      };

      CLICKABLE.forEach((id) => {
        map.on("click", id, handleClick);
        map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
      });

      // First fetch immediately after style is ready.
      void runFetch();
    });

    map.on("moveend", scheduleFetch);
    map.on("zoomend", scheduleFetch);

    return () => {
      abortRef.current?.abort();
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div className="map" data-testid="map-canvas">
      <div ref={containerRef} className="map__gl" data-testid="map-gl" />
      <MapOverlay status={status} />
      <MapLegend entries={legend} />
    </div>
  );
}

function MapOverlay({ status }: { status: ViewportStatus }) {
  return (
    <div className="map__overlay" data-testid="map-overlay">
      <span className="map__pill" data-testid="viewport-status">
        {status.loading ? "loading…" : status.error ? "error" : `${status.count} features`}
        {status.truncated && !status.loading && " · truncated"}
      </span>
      {status.error && (
        <span className="map__pill map__pill--err" data-testid="viewport-error">
          {status.error}
        </span>
      )}
    </div>
  );
}

function MapLegend({ entries }: { entries: LegendEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="map__legend" data-testid="map-legend">
      <div className="map__legend-title">Categories in view</div>
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
