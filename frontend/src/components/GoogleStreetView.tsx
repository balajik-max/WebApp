import { useEffect, useMemo, useRef, useState } from "react";
import type { UrbanFeature } from "../lib/types";
import { colorForCategory } from "../lib/categoryColors";

interface Props {
  latitude: number;
  longitude: number;
  features: UrbanFeature[];
  hiddenCategories: Set<string>;
  onClose: () => void;
}

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? "";
let googleMapsPromise: Promise<any> | null = null;

function loadGoogleMaps(): Promise<any> {
  const current = (window as any).google?.maps;
  if (current) return Promise.resolve(current);
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise((resolve, reject) => {
    const callbackName = `__nakshaGoogleMapsReady_${Date.now()}`;
    const timeout = window.setTimeout(() => reject(new Error("Google Maps took too long to load.")), 15000);
    (window as any)[callbackName] = () => {
      window.clearTimeout(timeout);
      delete (window as any)[callbackName];
      resolve((window as any).google.maps);
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&v=weekly&loading=async&callback=${callbackName}`;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timeout);
      delete (window as any)[callbackName];
      googleMapsPromise = null;
      reject(new Error("Google Maps could not be loaded. Check the API key and its domain restrictions."));
    };
    document.head.appendChild(script);
  });
  return googleMapsPromise;
}

type LngLat = [number, number];
const STREET_VIEW_GEOMETRY_BUFFER_METERS = 100;
const MAX_STREET_VIEW_GEOMETRIES = 200;

function flattenCoordinates(value: unknown, output: LngLat[]): void {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    output.push([value[0], value[1]]);
    return;
  }
  for (const child of value) flattenCoordinates(child, output);
}

function featureAnchor(feature: UrbanFeature): LngLat | null {
  const coordinates: LngLat[] = [];
  flattenCoordinates(feature.geometry.coordinates, coordinates);
  if (coordinates.length === 0) return null;
  if (feature.geometry.type === "Point") return coordinates[0];
  const sum = coordinates.reduce((acc, coordinate) => [acc[0] + coordinate[0], acc[1] + coordinate[1]] as LngLat, [0, 0]);
  return [sum[0] / coordinates.length, sum[1] / coordinates.length];
}

function distanceMeters(a: LngLat, b: LngLat): number {
  const radians = Math.PI / 180;
  const lat1 = a[1] * radians;
  const lat2 = b[1] * radians;
  const deltaLat = (b[1] - a[1]) * radians;
  const deltaLng = (b[0] - a[0]) * radians;
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

interface CameraState {
  position: LngLat;
  heading: number;
  pitch: number;
  zoom: number;
  width: number;
  height: number;
}

interface ScreenPoint { x: number; y: number }

function normalizeAngle(value: number): number {
  return ((value + 540) % 360) - 180;
}

function bearingDegrees(from: LngLat, to: LngLat): number {
  const radians = Math.PI / 180;
  const lat1 = from[1] * radians;
  const lat2 = to[1] * radians;
  const deltaLng = (to[0] - from[0]) * radians;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (Math.atan2(y, x) / radians + 360) % 360;
}

function projectCoordinate(coordinate: LngLat, camera: CameraState): ScreenPoint | null {
  const distance = distanceMeters(camera.position, coordinate);
  // Enforce the same moving 100 m buffer at vertex level. This prevents a
  // nearby feature with a long geometry from drawing far-away segments across
  // the panorama even though its representative anchor is inside the buffer.
  if (distance > STREET_VIEW_GEOMETRY_BUFFER_METERS || distance < 0.25) return null;
  const horizontalFov = Math.max(12, 180 / (2 ** camera.zoom));
  const aspect = Math.max(camera.width / Math.max(camera.height, 1), 0.2);
  const verticalFov = 2 * Math.atan(Math.tan(horizontalFov * Math.PI / 360) / aspect) * 180 / Math.PI;
  const relativeHeading = normalizeAngle(bearingDegrees(camera.position, coordinate) - camera.heading);
  // GDB geometry is two-dimensional. Project it onto a conservative ground
  // plane using the approximate Street View camera height instead of drawing
  // every feature at the horizon.
  const groundPitch = Math.atan2(-2.5, distance) * 180 / Math.PI;
  const relativePitch = groundPitch - camera.pitch;
  if (Math.abs(relativeHeading) > horizontalFov * 0.62 || Math.abs(relativePitch) > verticalFov * 0.62) return null;
  const x = camera.width / 2 + Math.tan(relativeHeading * Math.PI / 180) / Math.tan(horizontalFov * Math.PI / 360) * camera.width / 2;
  const y = camera.height / 2 - Math.tan(relativePitch * Math.PI / 180) / Math.tan(verticalFov * Math.PI / 360) * camera.height / 2;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function coordinateSequences(feature: UrbanFeature): LngLat[][] {
  const geometry = feature.geometry;
  switch (geometry.type) {
    case "Point": return [[geometry.coordinates]];
    case "MultiPoint": return geometry.coordinates.map((coordinate) => [coordinate]);
    case "LineString": return [geometry.coordinates];
    case "MultiLineString": return geometry.coordinates;
    case "Polygon": return geometry.coordinates;
    case "MultiPolygon": return geometry.coordinates.flat();
  }
}

export function GoogleStreetView({ latitude, longitude, features, hiddenCategories, onClose }: Props) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const panoramaRef = useRef<any>(null);
  const [panorama, setPanorama] = useState<any>(null);
  const [camera, setCamera] = useState<CameraState | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<UrbanFeature | null>(null);
  const [geometryVisible, setGeometryVisible] = useState(true);
  const [status, setStatus] = useState("Checking Street View coverage…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!GOOGLE_MAPS_API_KEY) {
      setError("Street View is not configured. Add VITE_GOOGLE_MAPS_API_KEY and rebuild the frontend.");
      return;
    }
    let cancelled = false;
    void loadGoogleMaps()
      .then(async (maps) => {
        const service = new maps.StreetViewService();
        const response = await service.getPanorama({
          location: { lat: latitude, lng: longitude },
          radius: 250,
          preference: maps.StreetViewPreference.NEAREST,
          source: maps.StreetViewSource.GOOGLE,
        });
        if (cancelled || !viewerRef.current) return;
        const panoramaPosition = response.data?.location?.latLng;
        const pano = response.data?.location?.pano;
        if (!pano) throw new Error("No Google Street View panorama is available near this location.");
        panoramaRef.current = new maps.StreetViewPanorama(viewerRef.current, {
          pano,
          position: panoramaPosition,
          pov: { heading: 0, pitch: 0 },
          zoom: 1,
          addressControl: true,
          fullscreenControl: true,
          motionTracking: false,
          motionTrackingControl: true,
          panControl: true,
          zoomControl: true,
          linksControl: true,
          clickToGo: true,
          showRoadLabels: true,
        });
        setPanorama(panoramaRef.current);
        setStatus("");
      })
      .catch((reason: Error) => {
        if (!cancelled) {
          const noCoverage = (reason as any)?.code === "ZERO_RESULTS" || reason.message.includes("ZERO_RESULTS");
          setError(noCoverage
            ? "No official Google Street View coverage was found within 250 metres of this point."
            : reason.message || "Street View could not be opened.");
        }
      });
    return () => {
      cancelled = true;
      setPanorama(null);
      panoramaRef.current = null;
    };
  }, [latitude, longitude]);

  useEffect(() => {
    if (!panorama) return;
    const maps = (window as any).google?.maps;
    if (!maps?.event || !viewerRef.current) return;
    let frame: number | null = null;
    const syncCamera = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        const position = panorama.getPosition?.();
        const pov = panorama.getPov?.() ?? { heading: 0, pitch: 0 };
        const rect = viewerRef.current?.getBoundingClientRect();
        if (!position || !rect) return;
        setCamera({
          position: [position.lng(), position.lat()],
          heading: pov.heading ?? 0,
          pitch: pov.pitch ?? 0,
          zoom: panorama.getZoom?.() ?? 1,
          width: rect.width,
          height: rect.height,
        });
      });
    };
    const listeners = ["position_changed", "pano_changed", "pov_changed", "zoom_changed"]
      .map((eventName) => panorama.addListener(eventName, syncCamera));
    const resizeObserver = new ResizeObserver(syncCamera);
    resizeObserver.observe(viewerRef.current);
    syncCamera();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      for (const listener of listeners) listener.remove();
    };
  }, [panorama]);

  const overlayFeatures = useMemo(() => {
    if (!camera) return [];
    return features
      .filter((feature) => !hiddenCategories.has(feature.properties.category || "uncategorized"))
      .map((feature) => ({ feature, anchor: featureAnchor(feature) }))
      .filter((item): item is { feature: UrbanFeature; anchor: LngLat } => Boolean(item.anchor))
      .filter((item) => distanceMeters(camera.position, item.anchor) <= STREET_VIEW_GEOMETRY_BUFFER_METERS)
      .sort((a, b) => distanceMeters(camera.position, a.anchor) - distanceMeters(camera.position, b.anchor))
      .slice(0, MAX_STREET_VIEW_GEOMETRIES);
  }, [camera, features, hiddenCategories]);

  const selectedDetails = useMemo(() => {
    if (!selectedFeature) return [];
    const attributes = selectedFeature.properties.attributes ?? {};
    const rows: Array<[string, unknown]> = [
      ["FID", attributes.FID ?? attributes.fid ?? selectedFeature.id],
      ["Category", selectedFeature.properties.category || "uncategorized"],
      ["Severity", selectedFeature.properties.severity],
    ];
    for (const [key, value] of Object.entries(attributes)) {
      if (/^(fid|category|severity)$/i.test(key) || value === null || value === "") continue;
      rows.push([key, value]);
      if (rows.length >= 11) break;
    }
    return rows;
  }, [selectedFeature]);

  return (
    <div className="google-street-view" data-testid="google-street-view">
      <div ref={viewerRef} className="google-street-view__canvas" />
      {camera && geometryVisible && (
        <svg
          className="google-street-view__gis-overlay"
          viewBox={`0 0 ${camera.width} ${camera.height}`}
          preserveAspectRatio="none"
          aria-label="GIS features projected into Street View"
        >
          {overlayFeatures.map(({ feature }) => {
            const color = colorForCategory(feature.properties.category || "uncategorized");
            const isPoint = feature.geometry.type === "Point" || feature.geometry.type === "MultiPoint";
            const isPolygon = feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon";
            return (
              <g key={feature.id} className="street-gis-feature" onClick={() => setSelectedFeature(feature)}>
                {coordinateSequences(feature).map((sequence, sequenceIndex) => {
                  const projected = sequence.map((coordinate) => projectCoordinate(coordinate, camera));
                  if (isPoint) {
                    return projected.filter((point): point is ScreenPoint => point !== null).map((point, pointIndex) => (
                      <circle key={`${sequenceIndex}:${pointIndex}`} cx={point.x} cy={point.y} r={7} fill={color} stroke="#111827" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                    ));
                  }
                  const runs: ScreenPoint[][] = [];
                  for (const point of projected) {
                    if (point) {
                      const current = runs[runs.length - 1];
                      if (current) current.push(point);
                      else runs.push([point]);
                    } else if (runs[runs.length - 1]?.length) {
                      runs.push([]);
                    }
                  }
                  const completePolygon = isPolygon && projected.every((point) => point !== null);
                  return runs.filter((run) => run.length >= 2).map((run, runIndex) => {
                    const path = `${run.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}${completePolygon ? " Z" : ""}`;
                    return <path key={`${sequenceIndex}:${runIndex}`} d={path} fill={completePolygon ? color : "none"} fillOpacity={completePolygon ? 0.2 : 0} stroke={color} strokeWidth={isPolygon ? 3 : 4} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
                  });
                })}
              </g>
            );
          })}
        </svg>
      )}
      {(status || error) && (
        <div className={`google-street-view__status${error ? " google-street-view__status--error" : ""}`}>
          <b>{error ? "Street View unavailable" : status}</b>
          {error && <span>{error}</span>}
        </div>
      )}
      <div className="google-street-view__location">
        Street View · {latitude.toFixed(6)}, {longitude.toFixed(6)}
      </div>
      {geometryVisible && selectedFeature && (
        <aside className="street-feature-panel" aria-label="Selected GIS feature attributes">
          <button type="button" onClick={() => setSelectedFeature(null)} aria-label="Close feature details">×</button>
          <strong>{selectedFeature.properties.label || selectedFeature.properties.category || "GIS feature"}</strong>
          {selectedDetails.map(([key, value]) => (
            <div key={key}>
              <span>{key}</span>
              <b>{value === null || value === undefined ? "—" : String(value)}</b>
            </div>
          ))}
        </aside>
      )}
      <button
        type="button"
        className={`google-street-view__geometry-toggle${geometryVisible ? " google-street-view__geometry-toggle--active" : ""}`}
        onClick={() => {
          setGeometryVisible((visible) => {
            if (visible) setSelectedFeature(null);
            return !visible;
          });
        }}
        aria-pressed={geometryVisible}
        data-testid="street-view-geometry-toggle"
      >
        Geometry {geometryVisible ? "ON" : "OFF"}
      </button>
      <button type="button" className="google-street-view__close" onClick={onClose} data-testid="google-street-view-close">
        Close ×
      </button>
    </div>
  );
}
