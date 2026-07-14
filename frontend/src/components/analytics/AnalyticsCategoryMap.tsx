import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { GeoJSONSource, LngLatBounds, Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { colorForCategory } from "../../lib/categoryColors";
import { fetchAnalyticsFeatures, type AnalyticsCrossFilters } from "../../lib/workflow";
import type { FeatureCollectionResponse, UrbanFeature } from "../../lib/types";

const SOURCE_ID = "analytics-features";
const POINT_LAYER = "analytics-points";
const LINE_LAYER = "analytics-lines";
const POLYGON_FILL_LAYER = "analytics-polygons-fill";
const POLYGON_LINE_LAYER = "analytics-polygons-line";
const DAVANGERE_CENTER: [number, number] = [75.9218, 14.4644];

const EMPTY_COLLECTION: FeatureCollectionResponse = {
  type: "FeatureCollection",
  features: [],
  bbox: [-180, -90, 180, 90],
  count: 0,
  limit: 5000,
  truncated: false,
};

const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    "analytics-osm": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "analytics-osm-layer", type: "raster", source: "analytics-osm" }],
};

function visitCoordinates(value: unknown, visit: (longitude: number, latitude: number) => void) {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    visit(value[0], value[1]);
    return;
  }
  for (const child of value) visitCoordinates(child, visit);
}

function fitToFeatures(map: MapLibreMap, features: UrbanFeature[]) {
  const bounds = new LngLatBounds();
  let hasCoordinate = false;
  for (const feature of features) {
    visitCoordinates(feature.geometry?.coordinates, (longitude, latitude) => {
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
      bounds.extend([longitude, latitude]);
      hasCoordinate = true;
    });
  }
  if (hasCoordinate) map.fitBounds(bounds, { padding: 34, maxZoom: 17, duration: 500 });
  else map.easeTo({ center: DAVANGERE_CENTER, zoom: 11, duration: 350 });
}

function withAnalyticsColors(collection: FeatureCollectionResponse): FeatureCollectionResponse {
  return {
    ...collection,
    features: collection.features
      .filter((feature) => feature.geometry != null)
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          analytics_color: colorForCategory(feature.properties.category),
        },
      })) as UrbanFeature[],
  };
}

interface Props {
  datasetIds: string[];
  categories: string[];
  filters?: AnalyticsCrossFilters;
  onCategoryFilter?: (category: string) => void;
}

export function AnalyticsCategoryMap({ datasetIds, categories, filters = {}, onCategoryFilter }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedRef = useRef(false);
  const dataRef = useRef<FeatureCollectionResponse>(EMPTY_COLLECTION);
  const onCategoryFilterRef = useRef(onCategoryFilter);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeatureCollectionResponse>(EMPTY_COLLECTION);
  useEffect(() => {
    onCategoryFilterRef.current = onCategoryFilter;
  }, [onCategoryFilter]);

  const scopeKey = useMemo(
    () => JSON.stringify({
      datasetIds: [...datasetIds].sort(),
      categories: [...categories].sort(),
      wards: [...(filters.wards ?? [])].sort(),
      severityBuckets: [...(filters.severityBuckets ?? [])].sort(),
    }),
    [categories, datasetIds, filters.severityBuckets, filters.wards]
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: DAVANGERE_CENTER,
      zoom: 11,
      minZoom: 2,
      maxZoom: 24,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      loadedRef.current = true;
      map.addSource(SOURCE_ID, { type: "geojson", data: dataRef.current });
      map.addLayer({
        id: POLYGON_FILL_LAYER,
        type: "fill",
        source: SOURCE_ID,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        paint: {
          "fill-color": ["coalesce", ["get", "analytics_color"], "#3aa1ff"],
          "fill-opacity": 0.28,
        },
      });
      map.addLayer({
        id: POLYGON_LINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        paint: {
          "line-color": ["coalesce", ["get", "analytics_color"], "#3aa1ff"],
          "line-width": 1.8,
        },
      });
      map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]],
        paint: {
          "line-color": ["coalesce", ["get", "analytics_color"], "#3aa1ff"],
          "line-width": 2.6,
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: POINT_LAYER,
        type: "circle",
        source: SOURCE_ID,
        filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
        paint: {
          "circle-color": ["coalesce", ["get", "analytics_color"], "#3aa1ff"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 15, 6],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
          "circle-opacity": 0.95,
        },
      });
      const initial = dataRef.current;
      (map.getSource(SOURCE_ID) as GeoJSONSource).setData(initial);
      fitToFeatures(map, initial.features);
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, maxWidth: "260px" });
    const clickableLayers = [POINT_LAYER, LINE_LAYER, POLYGON_FILL_LAYER];
    map.on("click", clickableLayers, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const properties = feature.properties ?? {};
      const content = document.createElement("div");
      const title = document.createElement("strong");
      const category = document.createElement("div");
      const severity = document.createElement("small");
      title.textContent = String(properties.label || properties.category || "Feature");
      category.textContent = String(properties.category || "uncategorized");
      severity.textContent = `Severity ${Number(properties.severity || 0).toFixed(2)}`;
      content.append(title, category, severity);
      if (onCategoryFilterRef.current && properties.category) {
        const filterButton = document.createElement("button");
        filterButton.type = "button";
        filterButton.className = "analytics-map-popup__filter";
        filterButton.textContent = "Filter this category";
        filterButton.addEventListener("click", () => {
          onCategoryFilterRef.current?.(String(properties.category));
        });
        content.append(filterButton);
      }
      popup.setLngLat(event.lngLat).setDOMContent(content).addTo(map);
    });
    map.on("mouseenter", clickableLayers, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", clickableLayers, () => { map.getCanvas().style.cursor = ""; });

    mapRef.current = map;
    return () => {
      loadedRef.current = false;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchAnalyticsFeatures(datasetIds, categories, controller.signal, filters)
      .then((response) => {
        const colored = withAnalyticsColors(response);
        dataRef.current = colored;
        setResult(colored);
        const map = mapRef.current;
        if (map && loadedRef.current) {
          (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(colored);
          fitToFeatures(map, colored.features);
        }
      })
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(caught.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scopeKey]);

  return (
    <article className="chart-card analytics-map-card" data-testid="analytics-map-card">
      <div className="chart-card__header">
        <div>
          <div className="analytics-card-eyebrow">Spatial view</div>
          <h3 className="chart-card__title">Applied-Scope Feature Map</h3>
        </div>
        <span className="chart-card__badge">{result.count.toLocaleString()} loaded</span>
      </div>
      <div className="analytics-map-wrap">
        <div ref={containerRef} className="analytics-map" />
        {loading && <div className="analytics-map__overlay">Loading scoped features…</div>}
        {error && <div className="analytics-map__overlay analytics-map__overlay--error">Map unavailable: {error}</div>}
      </div>
      <div className="analytics-map__footer">
        <span>Read-only preview. Colours match the main Map category palette.</span>
        {result.truncated && <b>Showing the first {result.limit.toLocaleString()} features; KPIs still use all matching rows.</b>}
      </div>
    </article>
  );
}
