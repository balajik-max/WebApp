import type { GisRow } from "./gisTypes";
import { featureIdFromRow, featureMapHref } from "./mapLinks";

export type DrainConditionGroup =
  | "Good"
  | "Fair"
  | "Needs attention"
  | "Not recorded";

export type DrainNetworkRecord = {
  id: string;
  featureId: string | null;
  mapHref: string | null;
  type: string;
  length: number;
  source: GisRow;
};

export type DrainObservationRecord = {
  id: string;
  featureId: string | null;
  mapHref: string | null;
  roadName: string;
  condition: string;
  conditionGroup: DrainConditionGroup;
  topLevel: string;
  bottomLevel: string;
  siltLevel: string;
  siltStatus: "No silt recorded" | "Silt present" | "Not recorded";
  widthDepth: string;
  pipeDiameter: string;
  pipeType: string;
  image: string;
  source: GisRow;
};

export type DrainCategoryCount = {
  name: string;
  count: number;
};

export type DrainNetworkSummary = {
  name: string;
  count: number;
  length: number;
};

export type DrainRoadSummary = {
  name: string;
  count: number;
  issues: number;
};

export type DrainCompletenessItem = {
  label: string;
  complete: number;
  total: number;
  percentage: number;
};

export type DrainageDashboardData = {
  networkRecords: DrainNetworkRecord[];
  observationRecords: DrainObservationRecord[];
  totalNetworkSegments: number;
  totalNetworkLengthMetres: number;
  openSegments: number;
  openLengthMetres: number;
  closedSegments: number;
  closedLengthMetres: number;
  totalObservations: number;
  goodObservations: number;
  fairObservations: number;
  attentionObservations: number;
  siltPresent: number;
  networkTypeDistribution: DrainNetworkSummary[];
  conditionDistribution: DrainCategoryCount[];
  pipeTypeDistribution: DrainCategoryCount[];
  roadDistribution: DrainRoadSummary[];
  dimensionDistribution: DrainCategoryCount[];
  completeness: DrainCompletenessItem[];
  attentionRecords: DrainObservationRecord[];
  longestSegment: DrainNetworkRecord | null;
};

function text(value: unknown, fallback = "Not recorded"): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value === null || value === undefined) {
    return 0;
  }

  const normalized = String(value).replaceAll(",", "");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return 0;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function groupDrainCondition(value: unknown): DrainConditionGroup {
  const normalized = text(value, "").toLowerCase();

  if (
    normalized.includes("bad") ||
    normalized.includes("blocked") ||
    normalized.includes("damage") ||
    normalized.includes("poor")
  ) {
    return "Needs attention";
  }

  if (normalized.includes("fair") || normalized.includes("average")) {
    return "Fair";
  }

  if (normalized.includes("good")) {
    return "Good";
  }

  return "Not recorded";
}

function groupSilt(value: unknown): DrainObservationRecord["siltStatus"] {
  const normalized = text(value, "").toLowerCase();

  if (normalized.length === 0) {
    return "Not recorded";
  }

  if (
    normalized === "no" ||
    normalized === "none" ||
    normalized === "nil" ||
    normalized === "n/a"
  ) {
    return "No silt recorded";
  }

  return "Silt present";
}

function networkType(value: unknown): string {
  const normalized = text(value).toLowerCase();

  if (normalized.includes("open")) {
    return "Open drain";
  }

  if (normalized.includes("closed")) {
    return "Closed drain";
  }

  return text(value);
}

function categoryCounts<T>(
  records: T[],
  valueGetter: (record: T) => string,
): DrainCategoryCount[] {
  const counts = new Map<string, number>();

  for (const record of records) {
    const value = valueGetter(record);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function completeness(
  label: string,
  records: DrainObservationRecord[],
  valueGetter: (record: DrainObservationRecord) => string,
): DrainCompletenessItem {
  const total = records.length;
  const complete = records.filter(
    (record) => valueGetter(record) !== "Not recorded",
  ).length;

  return {
    label,
    complete,
    total,
    percentage: total === 0 ? 0 : Math.round((complete / total) * 100),
  };
}

export function prepareDrainNetworkRecords(rows: GisRow[]): DrainNetworkRecord[] {
  return rows.map((row, index) => ({
    id: text(row.GDB_FID, `drain-segment-${index + 1}`),
    featureId: featureIdFromRow(row),
    mapHref: featureMapHref(row),
    type: networkType(row.LAYER),
    length: numberValue(row.SHAPE_Length),
    source: row,
  }));
}

export function prepareDrainObservationRecords(
  rows: GisRow[],
): DrainObservationRecord[] {
  return rows.map((row, index) => {
    const condition = text(row.Condition);

    return {
      id: text(row.GDB_FID, `drain-observation-${index + 1}`),
      featureId: featureIdFromRow(row),
      mapHref: featureMapHref(row),
      roadName: text(row.Road_Name, `Unnamed location ${index + 1}`),
      condition,
      conditionGroup: groupDrainCondition(condition),
      topLevel: text(row.Top_Level),
      bottomLevel: text(row.Bottom_Level),
      siltLevel: text(row.Silt_Level),
      siltStatus: groupSilt(row.Silt_Level),
      widthDepth: text(row.WidthXDepth),
      pipeDiameter: text(row.Pipe_Diameter),
      pipeType: text(row.Pipe_Type),
      image: text(row.Image),
      source: row,
    };
  });
}

export function calculateDrainageDashboard(
  networkRecords: DrainNetworkRecord[],
  observationRecords: DrainObservationRecord[],
): DrainageDashboardData {
  const totalNetworkLengthMetres = networkRecords.reduce(
    (total, record) => total + record.length,
    0,
  );

  const openRecords = networkRecords.filter((record) =>
    record.type.toLowerCase().includes("open"),
  );
  const closedRecords = networkRecords.filter((record) =>
    record.type.toLowerCase().includes("closed"),
  );

  const summarizeNetworkType = (name: string, records: DrainNetworkRecord[]) => ({
    name,
    count: records.length,
    length: Number(
      records.reduce((total, record) => total + record.length, 0).toFixed(2),
    ),
  });

  const roadMap = new Map<string, DrainRoadSummary>();
  for (const record of observationRecords) {
    const current = roadMap.get(record.roadName) ?? {
      name: record.roadName,
      count: 0,
      issues: 0,
    };

    current.count += 1;
    if (record.conditionGroup === "Needs attention") {
      current.issues += 1;
    }

    roadMap.set(record.roadName, current);
  }

  const conditionOrder: DrainConditionGroup[] = [
    "Good",
    "Fair",
    "Needs attention",
    "Not recorded",
  ];

  const rawConditionCounts = categoryCounts(
    observationRecords,
    (record) => record.conditionGroup,
  );

  const conditionDistribution = conditionOrder
    .map((name) => ({
      name,
      count: rawConditionCounts.find((item) => item.name === name)?.count ?? 0,
    }))
    .filter((item) => item.count > 0);

  const longestSegment = [...networkRecords].sort(
    (a, b) => b.length - a.length,
  )[0] ?? null;

  const attentionRecords = observationRecords.filter(
    (record) =>
      record.conditionGroup === "Needs attention" ||
      record.siltStatus === "Silt present",
  );

  return {
    networkRecords,
    observationRecords,
    totalNetworkSegments: networkRecords.length,
    totalNetworkLengthMetres,
    openSegments: openRecords.length,
    openLengthMetres: openRecords.reduce(
      (total, record) => total + record.length,
      0,
    ),
    closedSegments: closedRecords.length,
    closedLengthMetres: closedRecords.reduce(
      (total, record) => total + record.length,
      0,
    ),
    totalObservations: observationRecords.length,
    goodObservations: observationRecords.filter(
      (record) => record.conditionGroup === "Good",
    ).length,
    fairObservations: observationRecords.filter(
      (record) => record.conditionGroup === "Fair",
    ).length,
    attentionObservations: observationRecords.filter(
      (record) => record.conditionGroup === "Needs attention",
    ).length,
    siltPresent: observationRecords.filter(
      (record) => record.siltStatus === "Silt present",
    ).length,
    networkTypeDistribution: [
      summarizeNetworkType("Closed drain", closedRecords),
      summarizeNetworkType("Open drain", openRecords),
    ].filter((item) => item.count > 0),
    conditionDistribution,
    pipeTypeDistribution: categoryCounts(
      observationRecords,
      (record) => record.pipeType,
    ),
    roadDistribution: Array.from(roadMap.values())
      .sort((a, b) => b.count - a.count || b.issues - a.issues)
      .slice(0, 12),
    dimensionDistribution: categoryCounts(
      observationRecords,
      (record) => record.widthDepth,
    ),
    completeness: [
      completeness("Top level", observationRecords, (record) => record.topLevel),
      completeness(
        "Bottom level",
        observationRecords,
        (record) => record.bottomLevel,
      ),
      completeness(
        "Width and depth",
        observationRecords,
        (record) => record.widthDepth,
      ),
      completeness(
        "Pipe diameter",
        observationRecords,
        (record) => record.pipeDiameter,
      ),
      completeness("Field image", observationRecords, (record) => record.image),
    ],
    attentionRecords,
    longestSegment,
  };
}
