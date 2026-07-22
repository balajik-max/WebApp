import type { GisRow } from "./gisTypes";

export type ManholeConditionGroup =
  | "Good"
  | "Fair"
  | "Needs attention"
  | "Not recorded";

export type ManholeRecord = {
  id: string;
  roadName: string;
  condition: string;
  conditionGroup: ManholeConditionGroup;
  topLevel: string;
  bottomLevel: string;
  depth: string;
  depthFeet: number | null;
  depthNeedsVerification: boolean;
  pipeType: string;
  diameter: string;
  imageNumber: string;
  hasImage: boolean;
  source: GisRow;
};

export type ManholeCategoryCount = {
  name: string;
  count: number;
};

export type ManholeRoadSummary = {
  name: string;
  count: number;
  issues: number;
};

export type ManholeCompletenessItem = {
  label: string;
  complete: number;
  total: number;
  percentage: number;
};

export type ManholeDashboardData = {
  records: ManholeRecord[];
  totalManholes: number;
  goodManholes: number;
  fairManholes: number;
  attentionManholes: number;
  unassessedManholes: number;
  depthRecorded: number;
  pipeTypeRecorded: number;
  imagesRecorded: number;
  averageDepthFeet: number;
  depthVerificationCount: number;
  conditionDistribution: ManholeCategoryCount[];
  pipeTypeDistribution: ManholeCategoryCount[];
  diameterDistribution: ManholeCategoryCount[];
  roadDistribution: ManholeRoadSummary[];
  completeness: ManholeCompletenessItem[];
  attentionRecords: ManholeRecord[];
};

function text(value: unknown, fallback = "Not recorded"): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function depthInFeet(value: unknown): number | null {
  const normalized = text(value, "").toLowerCase();
  if (!normalized) {
    return null;
  }

  const match = normalized.replaceAll(",", "").match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (normalized.includes("inch")) {
    return parsed / 12;
  }

  return parsed;
}

export function groupManholeCondition(value: unknown): ManholeConditionGroup {
  const normalized = text(value, "").toLowerCase();

  if (
    normalized.includes("bad") ||
    normalized.includes("blocked") ||
    normalized.includes("damage") ||
    normalized.includes("poor") ||
    normalized.includes("sludge")
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

function categoryCounts<T>(
  records: T[],
  valueGetter: (record: T) => string,
): ManholeCategoryCount[] {
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
  records: ManholeRecord[],
  valueGetter: (record: ManholeRecord) => string,
): ManholeCompletenessItem {
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

export function prepareManholeRecords(rows: GisRow[]): ManholeRecord[] {
  return rows.map((row, index) => {
    const condition = text(row.Condition);
    const depth = text(row.Depth);
    const parsedDepth = depthInFeet(row.Depth);

    return {
      id: text(row.GDB_FID, `manhole-${index + 1}`),
      roadName: text(row.Road_Name, `Unnamed location ${index + 1}`),
      condition,
      conditionGroup: groupManholeCondition(condition),
      topLevel: text(row.Top_Level),
      bottomLevel: text(row.Bottom_Level),
      depth,
      depthFeet: parsedDepth,
      depthNeedsVerification:
        parsedDepth !== null && (parsedDepth <= 0 || parsedDepth > 25),
      pipeType: text(row.Pipe_Type),
      diameter: text(row.Diameter),
      imageNumber: text(row.Image_Number),
      hasImage: text(row.Image_Number) !== "Not recorded",
      source: row,
    };
  });
}

export function calculateManholeDashboard(
  records: ManholeRecord[],
): ManholeDashboardData {
  const goodManholes = records.filter(
    (record) => record.conditionGroup === "Good",
  ).length;
  const fairManholes = records.filter(
    (record) => record.conditionGroup === "Fair",
  ).length;
  const attentionManholes = records.filter(
    (record) => record.conditionGroup === "Needs attention",
  ).length;
  const unassessedManholes = records.filter(
    (record) => record.conditionGroup === "Not recorded",
  ).length;

  const plausibleDepths = records
    .map((record) => record.depthFeet)
    .filter(
      (value): value is number => value !== null && value > 0 && value <= 25,
    );

  const averageDepthFeet =
    plausibleDepths.length === 0
      ? 0
      : plausibleDepths.reduce((total, value) => total + value, 0) /
        plausibleDepths.length;

  const roadMap = new Map<string, ManholeRoadSummary>();
  for (const record of records) {
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

  return {
    records,
    totalManholes: records.length,
    goodManholes,
    fairManholes,
    attentionManholes,
    unassessedManholes,
    depthRecorded: records.filter((record) => record.depth !== "Not recorded")
      .length,
    pipeTypeRecorded: records.filter(
      (record) => record.pipeType !== "Not recorded",
    ).length,
    imagesRecorded: records.filter((record) => record.hasImage).length,
    averageDepthFeet,
    depthVerificationCount: records.filter(
      (record) => record.depthNeedsVerification,
    ).length,
    conditionDistribution: categoryCounts(
      records,
      (record) => record.conditionGroup,
    ),
    pipeTypeDistribution: categoryCounts(records, (record) => record.pipeType),
    diameterDistribution: categoryCounts(records, (record) => record.diameter),
    roadDistribution: Array.from(roadMap.values()).sort(
      (a, b) => b.count - a.count || b.issues - a.issues || a.name.localeCompare(b.name),
    ),
    completeness: [
      completeness("Condition", records, (record) => record.condition),
      completeness("Top level", records, (record) => record.topLevel),
      completeness("Bottom level", records, (record) => record.bottomLevel),
      completeness("Depth", records, (record) => record.depth),
      completeness("Pipe type", records, (record) => record.pipeType),
      completeness("Image number", records, (record) => record.imageNumber),
    ],
    attentionRecords: records
      .filter((record) => record.conditionGroup === "Needs attention")
      .sort((a, b) => a.roadName.localeCompare(b.roadName)),
  };
}
