import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PublicPortalHeader } from "../components/public/PublicPortalHeader";
import { PublicPortalNav } from "../components/public/PublicPortalNav";
import { usePublicAuth } from "../context/PublicAuthContext";
import { colorForCategory, UNCATEGORIZED_COLOR } from "../lib/categoryColors";
import {
  fetchPublicDatasetBounds,
  fetchPublicDatasetFeatures,
  fetchPublicDatasets,
  PublicApiError,
  type PublicDataset,
} from "../lib/publicPortal";

const DEFAULT_MAP_CENTER: [number, number] = [78.9629, 22.5937];
const DATA_SOURCE = "public-user-datasets";
const FILL_LAYER = "public-user-dataset-fill";
const LINE_LAYER = "public-user-dataset-line";
const POINT_LAYER = "public-user-dataset-point";
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };
const CATEGORY_COLOR_PROPERTY = "category_color";

const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#eef3ef" } },
    { id: "osm", type: "raster", source: "osm" },
  ],
};

function emptyCollection() {
  return { type: "FeatureCollection" as const, features: [] };
}

function popupAttributes(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function featureCategory(properties: Record<string, unknown>): string {
  const category = typeof properties.category === "string" ? properties.category.trim() : "";
  const sourceLayer = typeof properties.source_layer === "string" ? properties.source_layer.trim() : "";
  if (category && category.toLocaleLowerCase() !== "uncategorized") return category;
  if (sourceLayer) return sourceLayer;
  return "uncategorized";
}

function popupHtml(properties: Record<string, unknown>) {
  const attributes = popupAttributes(properties.attributes);
  const rows = Object.entries(attributes)
    .filter(([key, value]) => !key.startsWith("_") && value !== null && value !== "")
    .slice(0, 8)
    .map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
    .join("");
  return `<div class="public-map-popup"><strong>${escapeHtml(String(properties.label || "Map feature"))}</strong><span>${escapeHtml(String(properties.display_category || properties.source_layer || properties.category || "Uncategorized"))}</span>${rows ? `<dl>${rows}</dl>` : ""}</div>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => HTML_ESCAPES[character] || character);
}

export default function PublicMap() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { logout } = usePublicAuth();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [datasets, setDatasets] = useState<PublicDataset[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [mapLoading, setMapLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [categoryStats, setCategoryStats] = useState<Array<{ category: string; color: string; count: number }>>([]);

  useEffect(() => {
    document.body.classList.add("citizen-scroll");
    document.title = "Public Map · Smart Urban Survey";
    return () => document.body.classList.remove("citizen-scroll");
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: DEFAULT_MAP_CENTER,
      zoom: 4.2,
      maxZoom: 22,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.FullscreenControl(), "top-right");
    map.on("load", () => {
      map.addSource(DATA_SOURCE, { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: FILL_LAYER,
        type: "fill",
        source: DATA_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        paint: { "fill-color": ["coalesce", ["get", CATEGORY_COLOR_PROPERTY], UNCATEGORIZED_COLOR], "fill-opacity": 0.28, "fill-outline-color": ["coalesce", ["get", CATEGORY_COLOR_PROPERTY], UNCATEGORIZED_COLOR] },
      } as maplibregl.LayerSpecification);
      map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: DATA_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString", "Polygon", "MultiPolygon"]]],
        paint: { "line-color": ["coalesce", ["get", CATEGORY_COLOR_PROPERTY], UNCATEGORIZED_COLOR], "line-width": 2.3 },
      } as maplibregl.LayerSpecification);
      map.addLayer({
        id: POINT_LAYER,
        type: "circle",
        source: DATA_SOURCE,
        filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
        paint: { "circle-color": ["coalesce", ["get", CATEGORY_COLOR_PROPERTY], UNCATEGORIZED_COLOR], "circle-radius": 5, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 },
      } as maplibregl.LayerSpecification);

      const showPopup = (event: maplibregl.MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        if (!feature) return;
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({ maxWidth: "360px" })
          .setLngLat(event.lngLat)
          .setHTML(popupHtml((feature.properties || {}) as Record<string, unknown>))
          .addTo(map);
      };
      [FILL_LAYER, LINE_LAYER, POINT_LAYER].forEach((layer) => {
        map.on("click", layer, showPopup);
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
      });
    });
    mapRef.current = map;
    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchPublicDatasets(controller.signal)
      .then((rows) => {
        setDatasets(rows);
        const ready = rows.filter((row) => row.status === "ready");
        const requested = searchParams.get("dataset");
        const initial = requested && ready.some((row) => row.id === requested)
          ? [requested]
          : ready[0]
            ? [ready[0].id]
            : [];
        setSelectedIds((current) => current.length ? current.filter((id) => ready.some((row) => row.id === id)) : initial);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof PublicApiError ? reason.message : "Unable to load your datasets.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [searchParams]);

  const readyDatasets = useMemo(() => datasets.filter((dataset) => dataset.status === "ready"), [datasets]);

  const loadMapData = useCallback(async () => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const source = map.getSource(DATA_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    if (!selectedIds.length) {
      source.setData(emptyCollection());
      setTruncated(false);
      setCategoryStats([]);
      return;
    }
    setMapLoading(true);
    setError(null);
    try {
      const results = await Promise.all(selectedIds.map((id) => fetchPublicDatasetFeatures(id)));
      const counts = new Map<string, number>();
      const features = results.flatMap((collection) => collection.features.map((feature) => {
        const category = featureCategory(feature.properties);
        const categoryColor = colorForCategory(category);
        counts.set(category, (counts.get(category) ?? 0) + 1);
        return {
          ...feature,
          properties: {
            ...feature.properties,
            display_category: category,
            [CATEGORY_COLOR_PROPERTY]: categoryColor,
          },
        };
      }));
      source.setData({ type: "FeatureCollection", features } as never);
      setCategoryStats(
        Array.from(counts.entries())
          .map(([category, count]) => ({ category, count, color: colorForCategory(category) }))
          .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      );
      setTruncated(results.some((result) => result.truncated));

      const boundsRows = await Promise.all(selectedIds.map((id) => fetchPublicDatasetBounds(id).catch(() => null)));
      const bounds = new LngLatBounds();
      boundsRows.forEach((row) => {
        if (row) {
          bounds.extend([row.min_lon, row.min_lat]);
          bounds.extend([row.max_lon, row.max_lat]);
        }
      });
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 70, duration: 900, maxZoom: 18 });
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to draw the selected dataset on the map.");
    } finally {
      setMapLoading(false);
    }
  }, [selectedIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) void loadMapData();
    else map.once("load", () => void loadMapData());
  }, [loadMapData]);

  const toggleDataset = (datasetId: string) => {
    setSelectedIds((current) => {
      const next = current.includes(datasetId) ? current.filter((id) => id !== datasetId) : [...current, datasetId];
      const params = new URLSearchParams(searchParams);
      if (next.length === 1) params.set("dataset", next[0]);
      else params.delete("dataset");
      setSearchParams(params, { replace: true });
      return next;
    });
  };

  const signOut = async () => {
    await logout();
    navigate("/public/login", { replace: true });
  };

  return (
    <div className="citizen-dashboard-page public-map-page">
      <PublicPortalHeader />
      <PublicPortalNav />
      <main className="public-map-workspace">
        <aside className="public-map-sidebar">
          <div className="public-map-sidebar__heading"><div><p className="citizen-eyebrow">Private map workspace</p><h1>My Map</h1></div><button className="public-icon-button" type="button" onClick={() => window.location.reload()} aria-label="Refresh map">↻</button></div>
          <p>Select one or more Ready datasets. Only files uploaded by your account are listed here.</p>
          {loading ? <div className="citizen-empty">Loading datasets…</div> : readyDatasets.length === 0 ? (
            <div className="citizen-empty">No map-ready datasets yet.<button className="citizen-primary-button" type="button" onClick={() => navigate("/public/datasets")}>Upload Dataset</button></div>
          ) : (
            <ul className="public-map-dataset-list">
              {readyDatasets.map((dataset) => (
                <li key={dataset.id}>
                  <label>
                    <input type="checkbox" checked={selectedIds.includes(dataset.id)} onChange={() => toggleDataset(dataset.id)} />
                    <span className="public-map-color" aria-hidden="true" />
                    <span><strong>{dataset.name}</strong><small>{dataset.file_type === "shapefile" ? "Shapefile / GDB" : dataset.file_type}</small></span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {categoryStats.length > 0 && (
            <section className="public-map-legend" aria-label="Map category legend">
              <div className="public-map-legend__heading">
                <strong>Category legend</strong>
                <small>{categoryStats.length} {categoryStats.length === 1 ? "category" : "categories"}</small>
              </div>
              <p>Colours match the category styling used in the officer map.</p>
              <ul>
                {categoryStats.map((entry) => (
                  <li key={entry.category}>
                    <span className="public-map-legend__dot" style={{ backgroundColor: entry.color }} aria-hidden="true" />
                    <span title={entry.category}>{entry.category}</span>
                    <small>{entry.count.toLocaleString()}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="public-map-sidebar__footer">
            <button className="citizen-secondary-button" type="button" onClick={() => navigate("/public/datasets")}>Manage Datasets</button>
            <button className="citizen-secondary-button" type="button" onClick={() => void signOut()}>Sign Out</button>
          </div>
        </aside>
        <section className="public-map-canvas-wrap">
          <div ref={containerRef} className="public-map-canvas" />
          {mapLoading && <div className="public-map-message">Loading selected dataset…</div>}
          {!mapLoading && !selectedIds.length && <div className="public-map-message">Select a Ready dataset to view it on the map.</div>}
          {error && <div className="public-map-error">{error}</div>}
          {truncated && <div className="public-map-warning">This dataset is very large. The first 100,000 map features are displayed.</div>}
        </section>
      </main>
    </div>
  );
}
