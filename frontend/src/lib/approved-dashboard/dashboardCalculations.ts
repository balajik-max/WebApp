import type { GisLayerName, GisRow, GisWorkbookData } from "./gisTypes";

export type CategoryCount = {
  name: string;
  count: number;
};

export type ConditionSummary = {
  name: "Good" | "Fair" | "Needs attention" | "Not recorded";
  count: number;
};

export type CompletenessItem = {
  label: string;
  complete: number;
  total: number;
  percentage: number;
};

export type ExecutiveDashboardData = {
  totalFeatures: number;
  buildingsAndPolygons: number;
  roads: number;
  manholes: number;
  stormWaterDrains: number;
  utilityAssets: number;
  landmarks: number;
  potholes: number;
  standingWaterLocations: number;
  issuesNeedingAttention: number;
  layerDistribution: CategoryCount[];
  topCategories: CategoryCount[];
  conditionSummary: ConditionSummary[];
  completeness: CompletenessItem[];
  insights: {
    roadsWithoutFootpath: number;
    closedDrains: number;
    manholesWithoutCondition: number;
    poorDrainObservations: number;
  };
};

const LAYER_LABELS: Array<{ layer: GisLayerName; label: string }> = [
  { layer: "Road_Centerline", label: "Roads" },
  { layer: "Polygon", label: "Buildings & polygons" },
  { layer: "Point", label: "Utility points" },
  { layer: "Line", label: "Utility lines" },
  { layer: "Manhole", label: "Manholes" },
  { layer: "SWD", label: "Storm-water drains" },
  { layer: "Drain_Levels", label: "Drain observations" },
  { layer: "Landmark", label: "Landmarks" },
  { layer: "Pothole", label: "Potholes" },
  { layer: "Standing_Water", label: "Standing water" },
];

function text(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function hasValue(value: unknown): boolean {
  const normalized = text(value).toLowerCase();

  return (
    normalized.length > 0 &&
    normalized !== "null" &&
    normalized !== "undefined" &&
    normalized !== "nan" &&
    normalized !== "not recorded" &&
    normalized !== "n/a" &&
    normalized !== "na"
  );
}

function countBy(rows: GisRow[], fieldName: string): CategoryCount[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const value = text(row[fieldName]);
    const category = hasValue(value) ? value : "Not recorded";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function classifyCondition(value: unknown): ConditionSummary["name"] {
  const condition = text(value).toLowerCase();

  if (!hasValue(condition)) {
    return "Not recorded";
  }

  if (
    condition.includes("bad") ||
    condition.includes("blocked") ||
    condition.includes("damage") ||
    condition.includes("poor") ||
    condition.includes("sludge")
  ) {
    return "Needs attention";
  }

  if (condition.includes("fair") || condition.includes("average")) {
    return "Fair";
  }

  if (condition.includes("good") || condition.includes("complete")) {
    return "Good";
  }

  return "Not recorded";
}

function summarizeConditions(rows: GisRow[]): ConditionSummary[] {
  const order: ConditionSummary["name"][] = [
    "Good",
    "Fair",
    "Needs attention",
    "Not recorded",
  ];

  const counts = new Map<ConditionSummary["name"], number>(
    order.map((name) => [name, 0]),
  );

  for (const row of rows) {
    const category = classifyCondition(row.Condition);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return order.map((name) => ({ name, count: counts.get(name) ?? 0 }));
}

function createCompletenessItem(
  label: string,
  rows: GisRow[],
  fieldName: string,
): CompletenessItem {
  const complete = rows.filter((row) => hasValue(row[fieldName])).length;
  const total = rows.length;

  return {
    label,
    complete,
    total,
    percentage: total === 0 ? 0 : Math.round((complete / total) * 100),
  };
}

function mergeTopCategories(data: GisWorkbookData): CategoryCount[] {
  const combined = new Map<string, number>();

  const groups: Array<[GisRow[], string]> = [
    [data.Polygon, "LAYER"],
    [data.Point, "LAYER"],
    [data.Line, "LAYER"],
    [data.SWD, "LAYER"],
  ];

  for (const [rows, fieldName] of groups) {
    for (const category of countBy(rows, fieldName)) {
      if (category.name === "Not recorded") {
        continue;
      }

      combined.set(
        category.name,
        (combined.get(category.name) ?? 0) + category.count,
      );
    }
  }

  return Array.from(combined.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8);
}

function countWhere(
  rows: GisRow[],
  fieldName: string,
  predicate: (value: string) => boolean,
): number {
  return rows.filter((row) => predicate(text(row[fieldName]).toLowerCase())).length;
}

export function calculateExecutiveDashboard(
  data: GisWorkbookData,
): ExecutiveDashboardData {
  const layerDistribution = LAYER_LABELS.map(({ layer, label }) => ({
    name: label,
    count: data[layer].length,
  }));

  const totalFeatures = layerDistribution.reduce(
    (total, item) => total + item.count,
    0,
  );

  const combinedConditions = summarizeConditions([
    ...data.Manhole,
    ...data.Drain_Levels,
  ]);

  const roadsWithoutFootpath = countWhere(
    data.Road_Centerline,
    "Foot_Path",
    (value) => value === "no" || value.includes("without"),
  );

  const closedDrains = countWhere(data.SWD, "LAYER", (value) =>
    value.includes("closed"),
  );

  const manholesWithoutCondition = data.Manhole.filter(
    (row) => !hasValue(row.Condition),
  ).length;

  const poorDrainObservations = data.Drain_Levels.filter(
    (row) => classifyCondition(row.Condition) === "Needs attention",
  ).length;

  const manholeIssues = data.Manhole.filter(
    (row) => classifyCondition(row.Condition) === "Needs attention",
  ).length;

  return {
    totalFeatures,
    buildingsAndPolygons: data.Polygon.length,
    roads: data.Road_Centerline.length,
    manholes: data.Manhole.length,
    stormWaterDrains: data.SWD.length,
    utilityAssets: data.Point.length + data.Line.length,
    landmarks: data.Landmark.length,
    potholes: data.Pothole.length,
    standingWaterLocations: data.Standing_Water.length,
    issuesNeedingAttention:
      roadsWithoutFootpath + manholeIssues + poorDrainObservations + data.Pothole.length + data.Standing_Water.length,
    layerDistribution,
    topCategories: mergeTopCategories(data),
    conditionSummary: combinedConditions,
    completeness: [
      createCompletenessItem(
        "Road names",
        data.Road_Centerline,
        "Road_Name",
      ),
      createCompletenessItem(
        "Manhole condition",
        data.Manhole,
        "Condition",
      ),
      createCompletenessItem(
        "Drain condition",
        data.Drain_Levels,
        "Condition",
      ),
      createCompletenessItem(
        "Drain dimensions",
        data.Drain_Levels,
        "WidthXDepth",
      ),
    ],
    insights: {
      roadsWithoutFootpath,
      closedDrains,
      manholesWithoutCondition,
      poorDrainObservations,
    },
  };
}
