import type { GisCell, GisRow } from "./gisTypes";

export type MeasurementPoint = {
  x: number;
  y: number;
  z: number | null;
};

export type PotholeDepthBand =
  | "Shallow (under 5 cm)"
  | "Moderate (5–10 cm)"
  | "Deep (over 10 cm)"
  | "Depth unavailable";

export type PotholeRecord = {
  id: string;
  featureId: string | null;
  sourceFid: string;
  areaSqm: number | null;
  perimeterM: number | null;
  bottomElevationM: number | null;
  topElevationM: number | null;
  depthM: number | null;
  depthCm: number | null;
  volumeM3: number | null;
  volumeMethod: "surveyed" | "area × depth" | "unavailable";
  depthBand: PotholeDepthBand;
  longitude: number | null;
  latitude: number | null;
  startPoint: MeasurementPoint | null;
  endPoint: MeasurementPoint | null;
  surveyedLengthM: number | null;
  mapHref: string | null;
  source: GisRow;
};

export type PotholeDashboardData = {
  records: PotholeRecord[];
  totalPotholes: number;
  totalAreaSqm: number | null;
  averageDepthCm: number | null;
  maximumDepthCm: number | null;
  totalVolumeM3: number | null;
  depthCoverageCount: number;
  volumeCoverageCount: number;
  deepestPothole: PotholeRecord | null;
  depthDistribution: Array<{ name: PotholeDepthBand; count: number }>;
};

export type StandingWaterSizeBand =
  | "Small (under 5 m²)"
  | "Medium (5–15 m²)"
  | "Large (over 15 m²)"
  | "Area unavailable";

export type StandingWaterRecord = {
  id: string;
  featureId: string | null;
  sourceFid: string;
  areaSqm: number | null;
  perimeterM: number | null;
  depthM: number | null;
  volumeM3: number | null;
  sizeBand: StandingWaterSizeBand;
  longitude: number | null;
  latitude: number | null;
  mapHref: string | null;
  source: GisRow;
};

export type StandingWaterDashboardData = {
  records: StandingWaterRecord[];
  totalLocations: number;
  totalAreaSqm: number | null;
  averageAreaSqm: number | null;
  largestAreaSqm: number | null;
  measuredDepthCount: number;
  measuredVolumeM3: number | null;
  largestLocation: StandingWaterRecord | null;
  sizeDistribution: Array<{ name: StandingWaterSizeBand; count: number }>;
};

type NumericMatch = {
  key: string;
  value: number;
  raw: GisCell;
};

const AREA_ALIASES = [
  "Area_sqm",
  "Area_m2",
  "Area_sq_m",
  "SHAPE_Area",
  "Shape_Area",
  "area",
];

const PERIMETER_ALIASES = [
  "Perimeter_m",
  "Perimeter",
  "SHAPE_Length",
  "Shape_Length",
];

const ELEVATION_ALIASES = [
  "Elevation",
  "Elevation_m",
  "RL",
  "Reduced_Level",
  "Z_Level",
];

const DIRECT_VOLUME_ALIASES = [
  "Volume_m3",
  "Volume_Cubic_M",
  "Cubic_Meter",
  "Cubic_Metre",
  "Volume",
];

const DEPTH_ALIASES = [
  "Depth_m",
  "Average_Depth_m",
  "Avg_Depth_m",
  "Pothole_Depth_m",
  "Standing_Water_Depth_m",
  "Water_Depth_m",
  "Depth_cm",
  "Average_Depth_cm",
  "Avg_Depth_cm",
  "Pothole_Depth_cm",
  "Standing_Water_Depth_cm",
  "Water_Depth_cm",
  "Depth_mm",
  "Depth",
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hasValue(value: GisCell | undefined): boolean {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized.length > 0 && !["null", "undefined", "nan", "na", "n/a"].includes(normalized);
}

function parseNumber(value: GisCell | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!hasValue(value)) return null;
  const compact = String(value).replace(/,/g, "");
  const match = compact.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function findNumeric(row: GisRow, aliases: string[]): NumericMatch | null {
  const entries = Object.entries(row);
  const normalizedAliases = aliases.map(normalize);

  for (const [key, raw] of entries) {
    const keyNormalized = normalize(key);
    if (!normalizedAliases.includes(keyNormalized)) continue;
    const value = parseNumber(raw);
    if (value !== null) return { key, value, raw };
  }

  for (const [key, raw] of entries) {
    const keyNormalized = normalize(key);
    const alias = normalizedAliases.find(
      (candidate) =>
        candidate.length >= 5 &&
        (keyNormalized.includes(candidate) || candidate.includes(keyNormalized)),
    );
    if (!alias) continue;
    const value = parseNumber(raw);
    if (value !== null) return { key, value, raw };
  }

  return null;
}

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function positive(value: number | null): number | null {
  const finiteValue = finite(value);
  return finiteValue !== null && finiteValue >= 0 ? finiteValue : null;
}

function depthToMetres(match: NumericMatch | null): number | null {
  if (!match) return null;
  const key = normalize(match.key);
  const raw = String(match.raw ?? "").toLowerCase();
  const value = match.value;

  if (key.includes(" mm") || key.endsWith("mm") || raw.includes("mm")) return positive(value / 1000);
  if (key.includes(" cm") || key.endsWith("cm") || raw.includes("cm")) return positive(value / 100);
  if (key.includes("feet") || key.includes(" foot") || key.endsWith("ft") || raw.includes("feet") || raw.includes("foot") || /\bft\b/.test(raw)) {
    return positive(value * 0.3048);
  }
  if (key.includes("inch") || raw.includes("inch") || raw.includes('"')) return positive(value * 0.0254);
  return positive(value);
}

function volumeToCubicMetres(match: NumericMatch | null): number | null {
  if (!match) return null;
  const key = normalize(match.key);
  const raw = String(match.raw ?? "").toLowerCase();
  if (key.includes("cubic feet") || key.includes("cu ft") || raw.includes("cubic feet") || raw.includes("cu ft")) {
    return positive(match.value * 0.028316846592);
  }
  return positive(match.value);
}

function textValue(value: GisCell | undefined, fallback: string): string {
  return hasValue(value) ? String(value).trim() : fallback;
}

function rowNumber(row: GisRow, key: string): number | null {
  return parseNumber(row[key]);
}

function rowFeatureId(row: GisRow): string | null {
  const value = row.__feature_id;
  return hasValue(value) ? String(value) : null;
}

function rowCoordinates(row: GisRow): { longitude: number | null; latitude: number | null } {
  const longitude =
    rowNumber(row, "__longitude") ??
    rowNumber(row, "Centroid_Longitude_WGS84");
  const latitude =
    rowNumber(row, "__latitude") ??
    rowNumber(row, "Centroid_Latitude_WGS84");
  return { longitude, latitude };
}

function internalMapHref(featureId: string | null): string | null {
  return featureId ? `/map?locateFeature=${encodeURIComponent(featureId)}&focusMode=isolate` : null;
}

function measurementPoint(row: GisRow, prefix: "Start" | "End"): MeasurementPoint | null {
  const x = rowNumber(row, `${prefix}_X`);
  const y = rowNumber(row, `${prefix}_Y`);
  if (x === null || y === null) return null;
  return { x, y, z: rowNumber(row, `${prefix}_Z`) };
}

function distanceBetweenPoints(start: MeasurementPoint | null, end: MeasurementPoint | null): number | null {
  if (!start || !end) return null;
  const dz = start.z !== null && end.z !== null ? end.z - start.z : 0;
  return Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2 + dz ** 2);
}

function haversineMetres(
  left: { longitude: number | null; latitude: number | null },
  right: { longitude: number | null; latitude: number | null },
): number | null {
  if (
    left.longitude === null ||
    left.latitude === null ||
    right.longitude === null ||
    right.latitude === null
  ) {
    return null;
  }
  const radians = Math.PI / 180;
  const dLat = (right.latitude - left.latitude) * radians;
  const dLon = (right.longitude - left.longitude) * radians;
  const lat1 = left.latitude * radians;
  const lat2 = right.latitude * radians;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sourceFid(row: GisRow): string {
  return textValue(row.GDB_FID, "Not recorded");
}

function findTopSurface(
  bottom: GisRow,
  tops: GisRow[],
  usedIndexes: Set<number>,
): { row: GisRow; index: number } | null {
  const fid = sourceFid(bottom);
  const bottomCoordinates = rowCoordinates(bottom);
  const exactIndex = tops.findIndex((top, index) => {
    if (usedIndexes.has(index) || sourceFid(top) !== fid) return false;
    const distance = haversineMetres(bottomCoordinates, rowCoordinates(top));
    return distance === null || distance <= 5;
  });
  if (exactIndex >= 0) return { row: tops[exactIndex], index: exactIndex };
  let nearestRow: GisRow | null = null;
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < tops.length; index += 1) {
    if (usedIndexes.has(index)) continue;
    const top = tops[index];
    const distance = haversineMetres(bottomCoordinates, rowCoordinates(top));
    if (distance === null || distance > 5 || distance >= nearestDistance) continue;
    nearestRow = top;
    nearestIndex = index;
    nearestDistance = distance;
  }
  return nearestRow && nearestIndex >= 0 ? { row: nearestRow, index: nearestIndex } : null;
}

function potholeDepthBand(depthCm: number | null): PotholeDepthBand {
  if (depthCm === null) return "Depth unavailable";
  if (depthCm < 5) return "Shallow (under 5 cm)";
  if (depthCm <= 10) return "Moderate (5–10 cm)";
  return "Deep (over 10 cm)";
}

export function calculatePotholeDashboard(
  bottomRows: GisRow[],
  topRows: GisRow[],
): PotholeDashboardData {
  const usedTopIndexes = new Set<number>();
  const records = bottomRows.map((row, index): PotholeRecord => {
    const featureId = rowFeatureId(row);
    const coordinates = rowCoordinates(row);
    const areaSqm = positive(findNumeric(row, AREA_ALIASES)?.value ?? null);
    const perimeterM = positive(findNumeric(row, PERIMETER_ALIASES)?.value ?? null);
    const bottomElevationM = finite(findNumeric(row, ELEVATION_ALIASES)?.value ?? null);
    const directDepthM = depthToMetres(findNumeric(row, DEPTH_ALIASES));
    const directVolumeM3 = volumeToCubicMetres(findNumeric(row, DIRECT_VOLUME_ALIASES));
    const matchedTop = findTopSurface(row, topRows, usedTopIndexes);
    if (matchedTop) usedTopIndexes.add(matchedTop.index);
    const topElevationM = matchedTop
      ? finite(findNumeric(matchedTop.row, ELEVATION_ALIASES)?.value ?? null)
      : null;
    const elevationDepthM =
      bottomElevationM !== null && topElevationM !== null
        ? positive(topElevationM - bottomElevationM)
        : null;
    const depthM = directDepthM ?? elevationDepthM;
    const depthCm = depthM === null ? null : depthM * 100;
    const calculatedVolumeM3 =
      areaSqm !== null && depthM !== null ? areaSqm * depthM : null;
    const volumeM3 = directVolumeM3 ?? calculatedVolumeM3;
    const startPoint = measurementPoint(row, "Start");
    const endPoint = measurementPoint(row, "End");

    return {
      id: `pothole-${featureId ?? sourceFid(row)}-${index}`,
      featureId,
      sourceFid: sourceFid(row),
      areaSqm,
      perimeterM,
      bottomElevationM,
      topElevationM,
      depthM,
      depthCm,
      volumeM3,
      volumeMethod: directVolumeM3 !== null ? "surveyed" : calculatedVolumeM3 !== null ? "area × depth" : "unavailable",
      depthBand: potholeDepthBand(depthCm),
      longitude: coordinates.longitude,
      latitude: coordinates.latitude,
      startPoint,
      endPoint,
      surveyedLengthM: distanceBetweenPoints(startPoint, endPoint),
      mapHref: internalMapHref(featureId),
      source: row,
    };
  });

  const validAreas = records.flatMap((record) => (record.areaSqm === null ? [] : [record.areaSqm]));
  const validDepths = records.flatMap((record) => (record.depthCm === null ? [] : [record.depthCm]));
  const validVolumes = records.flatMap((record) => (record.volumeM3 === null ? [] : [record.volumeM3]));
  const deepestPothole = records.reduce<PotholeRecord | null>((deepest, record) => {
    if (record.depthCm === null) return deepest;
    if (deepest === null || deepest.depthCm === null || record.depthCm > deepest.depthCm) return record;
    return deepest;
  }, null);
  const depthBands: PotholeDepthBand[] = [
    "Shallow (under 5 cm)",
    "Moderate (5–10 cm)",
    "Deep (over 10 cm)",
    "Depth unavailable",
  ];

  return {
    records,
    totalPotholes: records.length,
    totalAreaSqm:
      validAreas.length > 0
        ? validAreas.reduce((total, value) => total + value, 0)
        : null,
    averageDepthCm:
      validDepths.length > 0
        ? validDepths.reduce((total, value) => total + value, 0) / validDepths.length
        : null,
    maximumDepthCm: validDepths.length > 0 ? Math.max(...validDepths) : null,
    totalVolumeM3:
      validVolumes.length > 0
        ? validVolumes.reduce((total, value) => total + value, 0)
        : null,
    depthCoverageCount: validDepths.length,
    volumeCoverageCount: validVolumes.length,
    deepestPothole,
    depthDistribution: depthBands.map((name) => ({
      name,
      count: records.filter((record) => record.depthBand === name).length,
    })),
  };
}

function standingWaterSizeBand(areaSqm: number | null): StandingWaterSizeBand {
  if (areaSqm === null) return "Area unavailable";
  if (areaSqm > 15) return "Large (over 15 m²)";
  if (areaSqm >= 5) return "Medium (5–15 m²)";
  return "Small (under 5 m²)";
}

export function calculateStandingWaterDashboard(rows: GisRow[]): StandingWaterDashboardData {
  const records = rows.map((row, index): StandingWaterRecord => {
    const featureId = rowFeatureId(row);
    const coordinates = rowCoordinates(row);
    const areaSqm = positive(findNumeric(row, AREA_ALIASES)?.value ?? null);
    const depthM = depthToMetres(findNumeric(row, DEPTH_ALIASES));
    const directVolumeM3 = volumeToCubicMetres(findNumeric(row, DIRECT_VOLUME_ALIASES));
    const calculatedVolumeM3 = areaSqm !== null && depthM !== null ? areaSqm * depthM : null;

    return {
      id: `standing-water-${featureId ?? sourceFid(row)}-${index}`,
      featureId,
      sourceFid: sourceFid(row),
      areaSqm,
      perimeterM: positive(findNumeric(row, PERIMETER_ALIASES)?.value ?? null),
      depthM,
      volumeM3: directVolumeM3 ?? calculatedVolumeM3,
      sizeBand: standingWaterSizeBand(areaSqm),
      longitude: coordinates.longitude,
      latitude: coordinates.latitude,
      mapHref: internalMapHref(featureId),
      source: row,
    };
  });

  const areas = records.flatMap((record) => (record.areaSqm === null ? [] : [record.areaSqm]));
  const largestLocation = records.reduce<StandingWaterRecord | null>((largest, record) => {
    if (record.areaSqm === null) return largest;
    if (largest === null || largest.areaSqm === null || record.areaSqm > largest.areaSqm) return record;
    return largest;
  }, null);
  const sizeBands: StandingWaterSizeBand[] = [
    "Small (under 5 m²)",
    "Medium (5–15 m²)",
    "Large (over 15 m²)",
    "Area unavailable",
  ];

  return {
    records,
    totalLocations: records.length,
    totalAreaSqm:
      areas.length > 0
        ? areas.reduce((total, value) => total + value, 0)
        : null,
    averageAreaSqm:
      areas.length > 0 ? areas.reduce((total, value) => total + value, 0) / areas.length : null,
    largestAreaSqm: areas.length > 0 ? Math.max(...areas) : null,
    measuredDepthCount: records.filter((record) => record.depthM !== null).length,
    measuredVolumeM3: (() => {
      const volumes = records.flatMap((record) =>
        record.volumeM3 === null ? [] : [record.volumeM3],
      );
      return volumes.length > 0
        ? volumes.reduce((total, value) => total + value, 0)
        : null;
    })(),
    largestLocation,
    sizeDistribution: sizeBands.map((name) => ({
      name,
      count: records.filter((record) => record.sizeBand === name).length,
    })),
  };
}
