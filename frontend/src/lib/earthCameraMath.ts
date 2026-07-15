import { EARTH_RADIUS_M, MAX_TILT_DEG, MIN_TILT_DEG, MIN_RANGE_M, MAX_RANGE_M } from "./earthConfig";

/** Web Mercator tile size used by MapLibre at zoom 0. */
const TILE_SIZE = 512;
/** MapLibre's default vertical field of view (radians). */
const DEFAULT_FOV = 0.6435;

/** Ground metres represented by one screen pixel at the given zoom. */
export function metersPerPixelAtZoom(zoom: number): number {
  return (2 * Math.PI * EARTH_RADIUS_M) / (TILE_SIZE * Math.pow(2, zoom));
}

/** Camera-to-target distance (metres) implied by a zoom level, for a canvas
 *  of the given pixel height, using MapLibre's perspective camera model. */
export function rangeFromZoom(zoom: number, canvasHeightPx: number): number {
  const mpp = metersPerPixelAtZoom(zoom);
  return (mpp * canvasHeightPx) / (2 * Math.tan(DEFAULT_FOV / 2));
}

/** Inverse of {@link rangeFromZoom}. */
export function zoomFromRange(rangeM: number, canvasHeightPx: number): number {
  const mpp = (2 * Math.tan(DEFAULT_FOV / 2) * rangeM) / Math.max(1, canvasHeightPx);
  return Math.log2((2 * Math.PI * EARTH_RADIUS_M) / (TILE_SIZE * mpp));
}

/** Normalise a heading into [0, 360). */
export function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Clamp tilt to the safe band, honouring the supplied max. */
export function clampTilt(tilt: number, maxTilt: number = MAX_TILT_DEG): number {
  return Math.min(Math.max(tilt, MIN_TILT_DEG), Math.max(MIN_TILT_DEG, maxTilt));
}

/** Clamp range to the safe band. */
export function clampRange(range: number): number {
  return Math.min(Math.max(range, MIN_RANGE_M), MAX_RANGE_M);
}

/** Spherical decomposition of a camera position around a target (Phase 12).
 *  Returns the east/north ground offsets and the camera altitude above the
 *  target. */
export function cameraOffsetMeters(
  rangeM: number,
  headingDeg: number,
  tiltDeg: number
): { eastOffsetM: number; northOffsetM: number; cameraAltitudeM: number } {
  const tiltRad = (tiltDeg * Math.PI) / 180;
  const headingRad = (headingDeg * Math.PI) / 180;
  const horizontalRange = rangeM * Math.sin(tiltRad);
  const verticalRange = rangeM * Math.cos(tiltRad);
  return {
    eastOffsetM: horizontalRange * Math.sin(headingRad),
    northOffsetM: horizontalRange * Math.cos(headingRad),
    cameraAltitudeM: verticalRange,
  };
}

/** Convert an east/north metre offset at a latitude into a lng/lat delta. */
export function offsetMetersToLngLat(
  origin: { lng: number; lat: number },
  eastOffsetM: number,
  northOffsetM: number
): { lng: number; lat: number } {
  const latRad = (origin.lat * Math.PI) / 180;
  const metersPerDegLat = (Math.PI * EARTH_RADIUS_M) / 180;
  const metersPerDegLng = metersPerDegLat * Math.cos(latRad);
  return {
    lng: origin.lng + eastOffsetM / Math.max(1, metersPerDegLng),
    lat: origin.lat + northOffsetM / metersPerDegLat,
  };
}

/** dolly/zoom step used by the wheel handler (Phase 14). */
export function applyDolly(rangeM: number, wheelDelta: number, scale = 0.001): number {
  return clampRange(rangeM * Math.exp(wheelDelta * scale));
}
