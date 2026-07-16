import { apiPost } from "./api";

export type CoordinateFormat = "decimal" | "dms" | "projected";

export interface CoordinateValue {
  latitude: number;
  longitude: number;
}

export type CoordinateBounds = [number, number, number, number];

export interface CoordinateSearchDataset {
  id: string;
  name: string;
  sourceCrs: string | null;
  bounds: CoordinateBounds | null;
}

export interface ProjectedCoordinateValue {
  x: number;
  y: number;
  sourceCrs: string;
  datasetId: string;
  datasetName: string;
}

export interface CoordinateTransformResult extends CoordinateValue {
  sourceX: number;
  sourceY: number;
  sourceCrs: string;
  targetCrs: string;
}

export type CoordinateParseResult =
  | { ok: true; value: CoordinateValue }
  | { ok: false; error: string };

export type ProjectedCoordinateParseResult =
  | { ok: true; value: { x: number; y: number } }
  | { ok: false; error: string };

interface CoordinateTransformApiResponse {
  source_x: number;
  source_y: number;
  source_crs: string;
  longitude: number;
  latitude: number;
  target_crs: string;
}

function parseFiniteNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function parseDmsValue(raw: string, axis: "latitude" | "longitude"): number | null {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[º˚]/g, "°")
    .replace(/[′’]/g, "'")
    .replace(/[″”]/g, '"')
    .replace(/\s+/g, " ");

  if (!normalized) return null;

  const decimalOnly = parseFiniteNumber(normalized);
  if (decimalOnly !== null) return decimalOnly;

  const match = normalized.match(
    /^([+-]?\d{1,3}(?:\.\d+)?)\s*(?:°|D|\s)\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:'|M|\s))?\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|S)?)?\s*([NSEW])?$/
  );
  if (!match) return null;

  const degrees = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;
  const suffix = match[4] ?? "";

  if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
  if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;

  if (axis === "latitude" && suffix && suffix !== "N" && suffix !== "S") return null;
  if (axis === "longitude" && suffix && suffix !== "E" && suffix !== "W") return null;

  let value = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  const negative = degrees < 0 || suffix === "S" || suffix === "W";
  if (negative) value *= -1;
  return value;
}

export function parseCoordinateInputs(
  format: Exclude<CoordinateFormat, "projected">,
  latitudeInput: string,
  longitudeInput: string
): CoordinateParseResult {
  const latitude = format === "dms"
    ? parseDmsValue(latitudeInput, "latitude")
    : parseFiniteNumber(latitudeInput);
  const longitude = format === "dms"
    ? parseDmsValue(longitudeInput, "longitude")
    : parseFiniteNumber(longitudeInput);

  if (latitude === null || longitude === null) {
    return { ok: false, error: `Enter valid ${format === "dms" ? "DMS" : "decimal"} coordinates.` };
  }
  if (latitude < -90 || latitude > 90) {
    return { ok: false, error: "Latitude must be between -90 and 90." };
  }
  if (longitude < -180 || longitude > 180) {
    return { ok: false, error: "Longitude must be between -180 and 180." };
  }
  return { ok: true, value: { latitude, longitude } };
}

export function parseProjectedInputs(xInput: string, yInput: string): ProjectedCoordinateParseResult {
  const x = parseFiniteNumber(xInput);
  const y = parseFiniteNumber(yInput);
  if (x === null || y === null) {
    return { ok: false, error: "Enter valid projected X and Y coordinates." };
  }
  return { ok: true, value: { x, y } };
}

export function isWgs84Crs(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "");
  return normalized === "EPSG:4326"
    || normalized === "OGC:CRS84"
    || normalized.includes("WGS84") && normalized.includes("4326");
}

export function looksLikeProjectedPair(x: number, y: number): boolean {
  return Math.abs(x) > 180 || Math.abs(y) > 90;
}

export function inferUtmCrsFromBounds(bounds: CoordinateBounds | null): string | null {
  if (!bounds) return null;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  const longitude = (minLon + maxLon) / 2;
  const latitude = (minLat + maxLat) / 2;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  const zone = Math.min(60, Math.max(1, Math.floor((longitude + 180) / 6) + 1));
  const epsg = (latitude >= 0 ? 32600 : 32700) + zone;
  return `EPSG:${epsg}`;
}


export function projectedAxisScore(x: number, y: number, sourceCrs: string): number {
  const normalized = sourceCrs.trim().toUpperCase();
  const isUtm = /^EPSG:32[67]\d{2}$/.test(normalized);
  if (!isUtm) return 0;
  const plausibleEasting = x >= 100_000 && x <= 900_000;
  const plausibleNorthing = y >= 0 && y <= 10_000_000;
  return (plausibleEasting ? 0 : 100_000) + (plausibleNorthing ? 0 : 100_000);
}

export function coordinateBoundsScore(
  value: CoordinateValue,
  bounds: CoordinateBounds | null
): number {
  if (!bounds) return 0;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const width = Math.max(maxLon - minLon, 1e-7);
  const height = Math.max(maxLat - minLat, 1e-7);
  const inside = value.longitude >= minLon && value.longitude <= maxLon
    && value.latitude >= minLat && value.latitude <= maxLat;
  const normalizedDistance = Math.hypot(
    (value.longitude - centerLon) / width,
    (value.latitude - centerLat) / height
  );
  return (inside ? 0 : 1_000_000) + normalizedDistance;
}

export async function transformProjectedCoordinate(
  input: ProjectedCoordinateValue,
  signal?: AbortSignal
): Promise<CoordinateTransformResult> {
  const response = await apiPost<CoordinateTransformApiResponse>(
    "/api/v1/map-context/coordinate-transform",
    {
      x: input.x,
      y: input.y,
      source_crs: input.sourceCrs,
      target_crs: "EPSG:4326",
    },
    signal
  );
  return {
    sourceX: response.source_x,
    sourceY: response.source_y,
    sourceCrs: response.source_crs,
    longitude: response.longitude,
    latitude: response.latitude,
    targetCrs: response.target_crs,
  };
}

export function formatCoordinate(value: CoordinateValue): string {
  return `${value.latitude.toFixed(7)}, ${value.longitude.toFixed(7)}`;
}
