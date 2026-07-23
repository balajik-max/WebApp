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
  pothole_status: "Pothole condition",
  standing_water_status: "Standing water",
};

function normalizeCategory(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function normalizeAttrValue(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
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

function attributeBreakdown(features: UrbanFeature[], keys: string[], emptyLabel: string, palette: string[]): BreakdownItem[] {
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

function severityBucket(severity: number): "low" | "medium" | "high" {
  if (severity < 0.34) return "low";
  if (severity < 0.67) return "medium";
  return "high";
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
    case "condition-overview": {
      const buckets = { low: 0, medium: 0, high: 0 };
      let sum = 0;
      for (const f of loadedFeatures) {
        buckets[severityBucket(f.properties.severity)] += 1;
        sum += f.properties.severity;
      }
      const avg = loadedFeatures.length ? sum / loadedFeatures.length : 0;
      return {
        bottom: [
          { label: "Average severity", value: avg.toFixed(2) },
          { label: "High severity", value: String(buckets.high) },
          { label: "Low severity", value: String(buckets.low) },
        ],
        rightHeading: "Severity mix",
        right: [
          { label: "High", count: buckets.high, color: "#ef4444" },
          { label: "Medium", count: buckets.medium, color: "#f59e0b" },
          { label: "Low", count: buckets.low, color: "#22c55e" },
        ],
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
    case "priority-zones": {
      const types: AnomalyType[] = ["drain_encroachment", "pole_redundancy", "manhole_status", "road_width_narrowing", "pothole_status", "standing_water_status"];
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
