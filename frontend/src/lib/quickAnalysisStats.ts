import type { UrbanFeature } from "./types";
import type { AnomalyColor, AnomalyType, SpatialAnomaly, ManholeReadinessReport } from "./workflow";
import { colorForCategory } from "./categoryColors";

export interface LegendEntry { category: string; color: string; count: number; }

export interface StatTile { label: string; value: string; sub?: string; }
export interface BreakdownItem { label: string; count: number; color: string; }
export interface DashboardData {
  bottom: StatTile[];
  rightHeading: string;
  right: BreakdownItem[];
  rightEmptyLabel?: string;
}

export interface QuickAnalysisContext {
  loadedFeatures: UrbanFeature[];
  categoryStats: LegendEntry[];
  anomalies: SpatialAnomaly[];
  activeDatasetIds: string[];
  readiness: ManholeReadinessReport | null;
}

const EMPTY_TOKENS = new Set(["", "-", "n/a", "na", "nan", "none", "null", "unknown"]);
const ANOMALY_COLOR_HEX: Record<AnomalyColor, string> = { red: "#ef4444", yellow: "#f59e0b", green: "#22c55e" };
const ANOMALY_TYPE_LABEL: Record<AnomalyType, string> = {
  drain_encroachment: "Drain encroachment",
  pole_redundancy: "Pole redundancy",
  manhole_status: "Manhole condition",
  road_width_narrowing: "Road narrowing",
  powerline_proximity: "Powerline proximity",
};

function normalizeCategory(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

// Broad asset groups for the Full Asset Catalog card — every canonical_class
// the classifier produces (see backend/app/services/class_taxonomy.py) rolls
// up into one of these, so the group tabs cover the whole survey.
export type AssetGroup = "roads" | "drains" | "manholes" | "utility" | "buildings" | "other";
export const ASSET_GROUP_CLASSES: Record<Exclude<AssetGroup, "other">, string[]> = {
  roads: ["Road_Centerline", "Road_Surface", "Road_Segment"],
  drains: ["Drainage_Asset", "Drainage_Level_Point"],
  manholes: ["Access_Point"],
  utility: ["Illumination_Asset", "Utility_Pole", "Power_Line"],
  buildings: ["Building"],
};
export const ALL_ASSET_GROUP_CANONICAL: string[] = Object.values(ASSET_GROUP_CLASSES).flat();
export function assetGroupForCanonical(canonicalClass: string | null | undefined): AssetGroup {
  const canon = canonicalClass ?? "";
  for (const [group, classes] of Object.entries(ASSET_GROUP_CLASSES)) {
    if (classes.includes(canon)) return group as AssetGroup;
  }
  return "other";
}

// Condition/maintenance-status fields recorded across different asset types
// in the real survey data — checked in order, first recorded value wins.
export const CONDITION_ATTRIBUTE_KEYS = [
  "Condition", "Manhole_Condition", "SWD_Status", "Road_Condition",
  "Maintenance_Status", "Maintenance_Status_1",
];
export const ROAD_ISSUE_DEPTH_KEYS = [
  "Pothole_Depth", "PotHole_Depth", "POTHOLE_DEPTH", "Defect_Depth", "Depression_Depth", "Water_Depth",
  "Standing_Water_Depth", "Max_Depth", "Average_Depth", "Avg_Depth",
  "Depth", "depth", "Depth_m", "depth_m",
];
export const ROAD_ISSUE_ELEVATION_KEYS = [
  "Elevation", "Ground_Elevation", "Ground_Level", "Top_Level", "Bottom_Level",
  "Reduced_Level", "RL", "Level", "Z",
];
export const ROAD_ISSUE_SURFACE_KEYS = [
  "Type_of_Road", "Road_Surface", "Surface", "surface", "Surface_Type",
  "Road_Condition", "Condition",
];
export const ROAD_ISSUE_LOCATION_KEYS = [
  "Road_Name", "Name", "Location", "Chainage", "FID", "GDB_FID", "OBJECTID", "ObjectId",
];
const POTHOLE_FLAG_KEYS = [
  "Pothole", "Potholes", "PotHole", "Road_Defect", "Surface_Defect", "Defect_Type", "Issue_Type", "Problem_Type",
];
const STANDING_WATER_FLAG_KEYS = [
  "Standing_Water", "Waterlogging", "Water_Logging", "Stagnant_Water", "Ponding", "Flooding", "Issue_Type", "Problem_Type",
];
const POTHOLE_TOKENS = [
  "pothole", "potholes", "pot hole", "pot holes",
  "pothhole", "pothholes", "pothhole top",
  "pathhole", "pathholes", "pathhole top", "pathole",
  "road depression", "surface depression", "crater",
];
const STANDING_WATER_TOKENS = ["standing water", "waterlogging", "water logging", "stagnant water", "water stagnation", "ponding", "flooding"];

function normalizeAttrValue(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecorded(value: unknown): boolean {
  return !EMPTY_TOKENS.has(normalizeAttrValue(value));
}

function firstAttribute(feature: UrbanFeature, keys: string[]): unknown {
  for (const key of keys) {
    const value = feature.properties.attributes?.[key];
    if (isRecorded(value)) return value;
  }
  return undefined;
}

function firstNamedAttribute(feature: UrbanFeature, keys: string[]): unknown {
  const attrs = feature.properties.attributes ?? {};
  for (const [attrKey, value] of Object.entries(attrs)) {
    if (!isRecorded(value)) continue;
    const normKey = normalizeSearchText(attrKey);
    if (keys.some((key) => normKey === normalizeSearchText(key))) return value;
  }
  return undefined;
}

function hasRecordedNamedAttribute(feature: UrbanFeature, keys: string[]): boolean {
  const raw = normalizeSearchText(firstNamedAttribute(feature, keys));
  return Boolean(raw && !["no", "false", "0", "nil"].includes(raw));
}

export function firstIssueAttribute(feature: UrbanFeature, keys: string[]): unknown {
  return firstAttribute(feature, keys);
}

export function issueNumberValue(feature: UrbanFeature, keys: string[]): number | null {
  const raw = firstAttribute(feature, keys);
  if (raw === undefined) return null;
  const parsed = parseFloat(String(raw).replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function featureIssueText(feature: UrbanFeature): string {
  const attrs = feature.properties.attributes ?? {};
  const recordedAttributeText = Object.entries(attrs)
    .filter(([, value]) => isRecorded(value))
    .flatMap(([key, value]) => [key, value]);
  return normalizeSearchText([
    feature.properties.category,
    feature.properties.label,
    feature.properties.canonical_class,
    attrs.gdb_layer,
    attrs.LAYER,
    attrs.Layer,
    attrs.layer_name,
    ...recordedAttributeText,
  ].join(" "));
}

function hasIssueToken(feature: UrbanFeature, tokens: string[]): boolean {
  const text = featureIssueText(feature);
  return tokens.some((token) => {
    const normalized = normalizeSearchText(token);
    return Boolean(normalized) && text.includes(normalized);
  });
}

export function isPotholeFeature(feature: UrbanFeature): boolean {
  return hasIssueToken(feature, POTHOLE_TOKENS)
    || hasRecordedNamedAttribute(feature, POTHOLE_FLAG_KEYS);
}

export function isStandingWaterFeature(feature: UrbanFeature): boolean {
  return hasIssueToken(feature, STANDING_WATER_TOKENS)
    || hasRecordedNamedAttribute(feature, STANDING_WATER_FLAG_KEYS);
}

function numericAverage(features: UrbanFeature[], keys: string[]): number | null {
  const values: number[] = [];
  for (const feature of features) {
    const raw = firstAttribute(feature, keys);
    if (raw === undefined) continue;
    const parsed = parseFloat(String(raw).replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(parsed)) values.push(parsed);
  }
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function attributeBreakdown(features: UrbanFeature[], keys: string[], emptyLabel: string, palette: string[]): BreakdownItem[] {
  const counts = new Map<string, number>();
  for (const feature of features) {
    const raw = firstAttribute(feature, keys);
    const label = raw === undefined ? emptyLabel : String(raw).trim();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count], i) => ({ label, count, color: label === emptyLabel ? "#64748b" : palette[i % palette.length] }));
}

function anomaliesByType(anomalies: SpatialAnomaly[], type: AnomalyType): SpatialAnomaly[] {
  return anomalies.filter((a) => a.anomaly_type === type);
}

function colorCounts(list: SpatialAnomaly[]): Record<AnomalyColor, number> {
  const counts: Record<AnomalyColor, number> = { red: 0, yellow: 0, green: 0 };
  for (const a of list) counts[a.color] += 1;
  return counts;
}

function colorBreakdown(list: SpatialAnomaly[]): BreakdownItem[] {
  const counts = colorCounts(list);
  return (["red", "yellow", "green"] as AnomalyColor[])
    .filter((c) => counts[c] > 0)
    .map((c) => ({ label: c === "red" ? "Red — needs attention" : c === "yellow" ? "Yellow — watch" : "Green — OK", count: counts[c], color: ANOMALY_COLOR_HEX[c] }));
}

const PALETTE = ["#14b8a6", "#38bdf8", "#a78bfa", "#f472b6", "#fb923c", "#facc15", "#4ade80"];

export function computeDashboardData(cardId: string, ctx: QuickAnalysisContext): DashboardData {
  const { loadedFeatures, categoryStats, anomalies, activeDatasetIds, readiness } = ctx;
  const manholeFeatures = loadedFeatures.filter((f) => normalizeCategory(f.properties.category) === "manhole");

  switch (cardId) {
    case "drain-encroachment": {
      const list = anomaliesByType(anomalies, "drain_encroachment");
      const counts = colorCounts(list);
      return {
        bottom: [
          { label: "Structures flagged", value: String(list.length) },
          { label: "Needs attention", value: String(counts.red), sub: "red" },
          { label: "Partial overlap", value: String(counts.yellow), sub: "yellow" },
        ],
        rightHeading: "By severity",
        right: colorBreakdown(list),
        rightEmptyLabel: "Run the audit to populate this",
      };
    }
    case "streetlight-spacing": {
      const list = anomaliesByType(anomalies, "pole_redundancy");
      const counts = colorCounts(list);
      return {
        bottom: [
          { label: "Poles flagged", value: String(list.length) },
          { label: "Redundant", value: String(counts.red), sub: "red" },
          { label: "Isolated / close", value: String(counts.yellow), sub: "yellow" },
        ],
        rightHeading: "By severity",
        right: colorBreakdown(list),
        rightEmptyLabel: "Run the audit to populate this",
      };
    }
    case "manhole-hotspots": {
      const list = anomaliesByType(anomalies, "manhole_status");
      const counts = colorCounts(list);
      return {
        bottom: [
          { label: "Manholes flagged", value: String(list.length) },
          { label: "Bad / blocked", value: String(counts.red), sub: "red" },
          { label: "Fair / silted", value: String(counts.yellow), sub: "yellow" },
        ],
        rightHeading: "By severity",
        right: colorBreakdown(list),
        rightEmptyLabel: "Run the audit to populate this",
      };
    }
    case "utility-tracker": {
      const utilityKeywords = ["pole", "light", "transformer", "water", "camera", "tank", "tower"];
      const utility = categoryStats.filter((c) => utilityKeywords.some((k) => normalizeCategory(c.category).includes(k)));
      const total = utility.reduce((sum, c) => sum + c.count, 0);
      const top = [...utility].sort((a, b) => b.count - a.count)[0];
      return {
        bottom: [
          { label: "Utility assets", value: String(total) },
          { label: "Categories tracked", value: String(utility.length) },
          { label: "Largest group", value: top ? String(top.count) : "—", sub: top?.category ?? "" },
        ],
        rightHeading: "Top utility categories",
        right: [...utility].sort((a, b) => b.count - a.count).slice(0, 6).map((c) => ({ label: c.category, count: c.count, color: colorForCategory(c.category) })),
      };
    }
    case "asset-catalog": {
      const top = [...categoryStats].sort((a, b) => b.count - a.count);
      return {
        bottom: [
          { label: "Total features", value: String(loadedFeatures.length) },
          { label: "Categories", value: String(categoryStats.length) },
          { label: "Active datasets", value: String(activeDatasetIds.length) },
        ],
        rightHeading: "Largest categories",
        right: top.slice(0, 6).map((c) => ({ label: c.category, count: c.count, color: colorForCategory(c.category) })),
      };
    }
    case "drainage-capacity": {
      const top = numericAverage(manholeFeatures, ["Top_Level", "top_level"]);
      const bottom = numericAverage(manholeFeatures, ["Bottom_Level", "bottom_level"]);
      const silt = numericAverage(manholeFeatures, ["Silt_Level", "silt_level"]);
      const condition = attributeBreakdown(manholeFeatures, ["Manhole_Condition", "Condition", "condition"], "Not recorded", PALETTE);
      return {
        bottom: [
          { label: "Avg. top level", value: top === null ? "—" : `${top.toFixed(2)} m` },
          { label: "Avg. bottom level", value: bottom === null ? "—" : `${bottom.toFixed(2)} m` },
          { label: "Avg. silt level", value: silt === null ? "—" : `${silt.toFixed(2)} m` },
        ],
        rightHeading: "Manhole condition",
        right: condition,
        rightEmptyLabel: "No manholes loaded in this dataset",
      };
    }
    case "road-width": {
      const list = anomaliesByType(anomalies, "road_width_narrowing");
      const counts = colorCounts(list);
      const roadCount = categoryStats.find((c) => normalizeCategory(c.category) === "concrete road")?.count ?? 0;
      return {
        bottom: [
          { label: "Concrete road segments", value: String(roadCount) },
          { label: "Narrow segments flagged", value: String(list.length) },
          { label: "Needs attention", value: String(counts.red), sub: "red" },
        ],
        rightHeading: "By severity",
        right: colorBreakdown(list),
        rightEmptyLabel: "Run the audit to populate this",
      };
    }
    case "pothole-check": {
      const potholes = loadedFeatures.filter(isPotholeFeature);
      const depths = potholes
        .map((feature) => issueNumberValue(feature, ROAD_ISSUE_DEPTH_KEYS))
        .filter((value): value is number => value !== null);
      const deepest = depths.length ? Math.max(...depths) : null;
      return {
        bottom: [
          { label: "Pothole records", value: String(potholes.length) },
          { label: "Depth recorded", value: String(depths.length) },
          { label: "Deepest", value: deepest === null ? "—" : `${deepest.toFixed(2)} m` },
        ],
        rightHeading: "Surface / condition",
        right: attributeBreakdown(potholes, ROAD_ISSUE_SURFACE_KEYS, "Not recorded", PALETTE),
        rightEmptyLabel: "No pothole records were found in the active dataset.",
      };
    }
    case "standing-water": {
      const water = loadedFeatures.filter(isStandingWaterFeature);
      const depths = water
        .map((feature) => issueNumberValue(feature, ROAD_ISSUE_DEPTH_KEYS))
        .filter((value): value is number => value !== null);
      const elevations = water
        .map((feature) => issueNumberValue(feature, ROAD_ISSUE_ELEVATION_KEYS))
        .filter((value): value is number => value !== null);
      const avgDepth = depths.length ? depths.reduce((sum, value) => sum + value, 0) / depths.length : null;
      return {
        bottom: [
          { label: "Standing-water records", value: String(water.length) },
          { label: "Depth recorded", value: String(depths.length) },
          { label: "Elevation recorded", value: String(elevations.length), sub: avgDepth === null ? "" : `avg depth ${avgDepth.toFixed(2)} m` },
        ],
        rightHeading: "Surface / condition",
        right: attributeBreakdown(water, ROAD_ISSUE_SURFACE_KEYS, "Not recorded", PALETTE),
        rightEmptyLabel: "No standing-water records were found in the active dataset.",
      };
    }
    case "priority-zones": {
      const types: AnomalyType[] = ["drain_encroachment", "pole_redundancy", "manhole_status", "road_width_narrowing"];
      const redByType = types.map((t) => ({ type: t, red: colorCounts(anomaliesByType(anomalies, t)).red }));
      const totalRed = redByType.reduce((sum, t) => sum + t.red, 0);
      const worst = [...redByType].sort((a, b) => b.red - a.red)[0];
      return {
        bottom: [
          { label: "Total priority findings", value: String(totalRed) },
          { label: "All findings", value: String(anomalies.length) },
          { label: "Top issue", value: worst && worst.red > 0 ? String(worst.red) : "—", sub: worst && worst.red > 0 ? ANOMALY_TYPE_LABEL[worst.type] : "" },
        ],
        rightHeading: "Red flags by type",
        right: redByType.filter((t) => t.red > 0).map((t) => ({ label: ANOMALY_TYPE_LABEL[t.type], count: t.red, color: "#ef4444" })),
        rightEmptyLabel: "Run the audit to populate this",
      };
    }
    case "survey-kpis": {
      const avgCompleteness = readiness && readiness.fields.length
        ? readiness.fields.reduce((sum, f) => sum + f.completeness_percentage, 0) / readiness.fields.length
        : null;
      return {
        bottom: [
          { label: "Total features", value: String(loadedFeatures.length) },
          { label: "Categories", value: String(categoryStats.length) },
          { label: "Manhole data completeness", value: avgCompleteness === null ? "—" : `${avgCompleteness.toFixed(0)}%` },
        ],
        rightHeading: "Manhole field completeness",
        right: readiness
          ? [...readiness.fields].sort((a, b) => b.completeness_percentage - a.completeness_percentage)
              .map((f) => ({ label: f.label, count: Math.round(f.completeness_percentage), color: "#14b8a6" }))
          : [],
        rightEmptyLabel: "Loading…",
      };
    }
    case "manhole-detail": {
      const withCondition = manholeFeatures.filter((f) => isRecorded(firstAttribute(f, ["Manhole_Condition", "Condition", "condition"]))).length;
      const pipeType = attributeBreakdown(manholeFeatures, ["Pipe_Type", "pipe_type"], "Not recorded", PALETTE);
      return {
        bottom: [
          { label: "Total manholes", value: String(manholeFeatures.length) },
          { label: "Condition recorded", value: String(withCondition) },
          { label: "Condition missing", value: String(manholeFeatures.length - withCondition) },
        ],
        rightHeading: "Pipe type",
        right: pipeType,
        rightEmptyLabel: "No manholes loaded in this dataset",
      };
    }
    default:
      return { bottom: [], rightHeading: "", right: [] };
  }
}
