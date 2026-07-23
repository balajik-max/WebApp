import { useEffect, useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { UrbanFeature } from "../lib/types";
import { colorForCategory } from "../lib/categoryColors";
import { fetchManholeReadiness, type DrainEncroachmentReport, type ManholeReadinessReport, type SpatialAnomaly } from "../lib/workflow";
import {
  computeDashboardData, attributeBreakdown, assetGroupForCanonical,
  ASSET_GROUP_CLASSES, ALL_ASSET_GROUP_CANONICAL, CONDITION_ATTRIBUTE_KEYS,
  ROAD_ISSUE_DEPTH_KEYS, ROAD_ISSUE_ELEVATION_KEYS, ROAD_ISSUE_SURFACE_KEYS, ROAD_ISSUE_LOCATION_KEYS,
  firstIssueAttribute, issueNumberValue, isPotholeFeature, isStandingWaterFeature,
  type LegendEntry, type AssetGroup,
} from "../lib/quickAnalysisStats";

export type QuickAnalysisTool = "select" | "measure" | null;

export interface ManholeConnectionDetail {
  id: string;
  fromId: string;
  toId: string | null;
  status: "good" | "warning" | "critical";
  statusLabel: string;
  flowConfirmed: boolean;
  elevationSource: string | null;
  routeBasis: string | null;
  rainySeasonClosed: boolean;
  pipeMaterial: string;
  pipeDiameterMm: number;
  slope: number | null;
}

interface QuickAnalysisMapDashboardProps {
  cardId: string;
  title: string;
  description: string;
  datasetIds: string[];
  features: UrbanFeature[];
  loading: boolean;
  error: string | null;
  drainEncroachment: DrainEncroachmentReport | null;
  drainEncroachmentLoading: boolean;
  drainEncroachmentError: string | null;
  manholeNetworkLoading: boolean;
  manholeNetworkError: string | null;
  manholeNetworkRouteCount: number;
  manholeNetworkFlowCount: number;
  manholeNetworkStatusCounts: { good: number; warning: number; critical: number; unconnected: number };
  anomalies: SpatialAnomaly[];
  selectedFeature: UrbanFeature | null;
  selectedConnection: ManholeConnectionDetail | null;
  activeTool: QuickAnalysisTool;
  canvasBlank: boolean;
  utilitySubCategory?: string;
  onSelectUtilitySubCategory?: (subCategory: string) => void;
  assetCategoryFilter?: string;
  onSelectAssetCategoryFilter?: (filter: string) => void;
  onToggleCanvasBlank: () => void;
  onActivateSelect: () => void;
  onActivateMeasure: () => void;
  onClearSelectedFeature: () => void;
  onClearSelectedConnection: () => void;
  onClose: () => void;
}

const EMPTY_VALUES = new Set(["", "-", "n/a", "na", "null", "none", "unknown"]);
const CHART_TOOLTIP_STYLE = {
  background: "#111d2d",
  border: "1px solid #2b3b50",
  borderRadius: 8,
  color: "#e5edf6",
  fontSize: 11,
};
const ROAD_ISSUE_IMAGE_KEYS = ["Image", "IMAGE", "image", "Photo", "PHOTO", "photo", "Photo_Path", "Image_Path", "Image_Number", "Image_No", "Img3", "IMG3", "img3", "Image_3", "Photo_3"];

function normalizeCategoryName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

const EXCLUDED_UTILITY_CATEGORIES = new Set([
  "manhole", "inlet", "gully", "building", "building extenstions", "building ruin",
  "building underconstruction", "closed drain", "drain levels", "concrete road",
  "road centerline", "road hump", "road sign", "road sign single pole", "road sign double pole",
  "kerb top", "kerb bottom", "concrete edge", "wall", "fence", "gate", "sidewalk",
  "temple", "landmark", "monument", "mionument", "arch", "coconut tree", "other tree", "tree",
  "planter box", "3d_vertex", "raster_pixel", "site_photo", "chainage"
]);

function isUtilityFeature(feature: UrbanFeature): boolean {
  const cat = (feature.properties.category ?? "").trim();
  const norm = normalizeCategoryName(cat);
  if (EXCLUDED_UTILITY_CATEGORIES.has(norm)) return false;
  const canon = feature.properties.canonical_class ?? "";
  if (["Utility_Pole", "Illumination_Asset"].includes(canon)) return true;
  const utilityKeywords = ["pole", "light", "transformer", "water", "power", "electric", "cable", "ofc", "pipe", "camera", "tank", "tower"];
  return utilityKeywords.some((k) => norm.includes(k));
}

function groupForCategory(normCat: string): "electricity" | "water" | "telecom" | "other" {
  if (["power pole", "power pole with light", "light pole", "solar light", "transformer", "power line", "electric line", "high mast", "flag pole", "microwave tower"].includes(normCat)) return "electricity";
  if (["water line", "pipe", "sewage line", "water tank", "water pump", "overhead tank"].includes(normCat)) return "water";
  if (["cc camera", "ofc line", "cable"].includes(normCat)) return "telecom";
  return "other";
}

function categoryBreakdown(features: UrbanFeature[]): LegendEntry[] {
  const counts = new Map<string, number>();
  for (const feature of features) {
    const category = feature.properties.category?.trim() || "uncategorized";
    if (category === "raster_pixel") continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count, color: colorForCategory(category) }))
    .sort((a, b) => b.count - a.count);
}

function recordedValue(value: unknown): boolean {
  return !EMPTY_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function firstRecorded(feature: UrbanFeature, keys: string[]): unknown {
  for (const key of keys) {
    const value = feature.properties.attributes?.[key];
    if (recordedValue(value)) return value;
  }
  return undefined;
}

function firstNumber(feature: UrbanFeature, keys: string[]): number | null {
  const value = firstRecorded(feature, keys);
  if (value === undefined) return null;
  const parsed = Number(String(value).replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLength(coordinates: [number, number][]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += haversineMeters(coordinates[index - 1], coordinates[index]);
  }
  return total;
}

function featureLengthMeters(feature: UrbanFeature): number {
  const recorded = firstNumber(feature, ["SHAPE_Length", "Length_M", "length_m"]);
  if (recorded !== null && recorded >= 0) return recorded;
  if (feature.geometry.type === "LineString") return lineLength(feature.geometry.coordinates);
  if (feature.geometry.type === "MultiLineString") {
    return feature.geometry.coordinates.reduce((sum, line) => sum + lineLength(line), 0);
  }
  return 0;
}

function formatLength(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(1)} m`;
}

function displayValue(value: unknown): string {
  return recordedValue(value) ? String(value) : "Not recorded";
}

export function QuickAnalysisMapDashboard({
  cardId, title, description, datasetIds, features, loading, error,
  drainEncroachment, drainEncroachmentLoading, drainEncroachmentError,
  manholeNetworkLoading, manholeNetworkError, manholeNetworkRouteCount, manholeNetworkFlowCount,
  manholeNetworkStatusCounts,
  anomalies,
  selectedFeature, selectedConnection, activeTool, canvasBlank, utilitySubCategory = "all", onSelectUtilitySubCategory, onActivateMeasure,
  assetCategoryFilter = "all", onSelectAssetCategoryFilter,
  onToggleCanvasBlank, onClearSelectedFeature, onClearSelectedConnection, onClose,
}: QuickAnalysisMapDashboardProps) {
  const [readiness, setReadiness] = useState<ManholeReadinessReport | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const isDrainAnalysis = cardId === "drain-encroachment";

  const dashboardFeatures = useMemo(
    () => {
      if (cardId === "manhole-detail") {
        return features.filter((feature) => feature.properties.category?.trim().toLowerCase() === "manhole");
      }
      if (cardId === "utility-tracker") {
        const utilityFeatures = features.filter(isUtilityFeature);
        if (!utilitySubCategory || utilitySubCategory === "all") return utilityFeatures;
        return utilityFeatures.filter((feature) => {
          const cat = feature.properties.category ?? "";
          const norm = normalizeCategoryName(cat);
          const canon = feature.properties.canonical_class ?? "";
          if (utilitySubCategory === "electricity") {
            return ["power pole", "power pole with light", "light pole", "solar light", "transformer", "power line", "electric line", "high mast", "flag pole", "microwave tower"].includes(norm)
              || ["Utility_Pole", "Illumination_Asset"].includes(canon);
          }
          if (utilitySubCategory === "water") {
            return ["water line", "pipe", "sewage line", "water tank", "water pump", "overhead tank"].includes(norm);
          }
          if (utilitySubCategory === "telecom") {
            return ["cc camera", "ofc line", "cable"].includes(norm);
          }
          return norm === utilitySubCategory;
        });
      }
      if (cardId === "asset-catalog") {
        const filter = assetCategoryFilter || "all";
        if (filter === "all") return features;
        const groupClasses = ASSET_GROUP_CLASSES[filter as Exclude<AssetGroup, "other">];
        if (groupClasses) return features.filter((f) => groupClasses.includes(f.properties.canonical_class ?? ""));
        if (filter === "other") return features.filter((f) => !ALL_ASSET_GROUP_CANONICAL.includes(f.properties.canonical_class ?? ""));
        return features.filter((f) => (f.properties.category ?? "").trim() === filter);
      }
      if (cardId === "pothole-check") {
        return features.filter(isPotholeFeature);
      }
      if (cardId === "standing-water") {
        return features.filter(isStandingWaterFeature);
      }
      return features;
    },
    [cardId, features, utilitySubCategory, assetCategoryFilter]
  );
  const categoryStats = useMemo(() => categoryBreakdown(dashboardFeatures), [dashboardFeatures]);

  const utilityData = useMemo(() => {
    if (cardId !== "utility-tracker") {
      return { groups: [], filteredSubCats: [], activeGroup: "all" as const, elecCount: 0, waterCount: 0, telecomCount: 0, total: 0 };
    }
    const utilityFeatures = features.filter(isUtilityFeature);
    const catCounts = new Map<string, number>();

    let elecCount = 0;
    let waterCount = 0;
    let telecomCount = 0;

    for (const f of utilityFeatures) {
      const cat = (f.properties.category ?? "").trim();
      if (!cat) continue;
      const norm = normalizeCategoryName(cat);
      catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);

      const group = groupForCategory(norm);
      if (group === "electricity" || ["Utility_Pole", "Illumination_Asset"].includes(f.properties.canonical_class ?? "")) {
        elecCount += 1;
      } else if (group === "water") {
        waterCount += 1;
      } else if (group === "telecom") {
        telecomCount += 1;
      }
    }

    const groups = [
      { id: "all", label: "All" },
      { id: "electricity", label: "Electricity" },
      { id: "water", label: "Water" },
      { id: "telecom", label: "Telecom" },
    ];

    const currentSubCat = utilitySubCategory || "all";
    let activeGroup: "all" | "electricity" | "water" | "telecom" = "all";
    if (currentSubCat === "electricity" || groupForCategory(currentSubCat) === "electricity") {
      activeGroup = "electricity";
    } else if (currentSubCat === "water" || groupForCategory(currentSubCat) === "water") {
      activeGroup = "water";
    } else if (currentSubCat === "telecom" || groupForCategory(currentSubCat) === "telecom") {
      activeGroup = "telecom";
    }

    const allSubCats = [...catCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => {
        const norm = normalizeCategoryName(cat);
        return {
          id: norm,
          label: cat,
          count,
          group: groupForCategory(norm),
          color: colorForCategory(cat),
        };
      });

    const filteredSubCats = activeGroup === "all"
      ? allSubCats
      : allSubCats.filter((sub) => sub.group === activeGroup);

    return { groups, filteredSubCats, activeGroup, elecCount, waterCount, telecomCount, total: utilityFeatures.length };
  }, [cardId, features, utilitySubCategory]);

  const utilityLineLengths = useMemo(() => {
    if (cardId !== "utility-tracker") return { powerM: 0, waterM: 0 };
    let powerM = 0;
    let waterM = 0;
    for (const f of features) {
      const cat = (f.properties.category ?? "").trim().toLowerCase();
      if (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString") {
        const len = featureLengthMeters(f);
        if (cat.includes("power line") || cat.includes("electric line")) powerM += len;
        if (cat.includes("water line") || cat.includes("pipe") || cat.includes("sewage line")) waterM += len;
      }
    }
    return { powerM, waterM };
  }, [cardId, features]);

  const ASSET_GROUP_LABEL: Record<AssetGroup, string> = {
    roads: "Roads", drains: "Drains", manholes: "Manholes",
    utility: "Utility & Lighting", buildings: "Buildings", other: "Other",
  };
  const assetCatalogData = useMemo(() => {
    if (cardId !== "asset-catalog") {
      return { groups: [] as { id: string; label: string; count: number }[], filteredSubCats: [] as { id: string; label: string; count: number; color: string }[], activeGroup: "all", total: 0 };
    }
    const groupCounts: Record<AssetGroup, number> = { roads: 0, drains: 0, manholes: 0, utility: 0, buildings: 0, other: 0 };
    for (const f of features) groupCounts[assetGroupForCanonical(f.properties.canonical_class)] += 1;

    const groups = (["all", "roads", "drains", "manholes", "utility", "buildings", "other"] as const)
      .map((id) => ({ id, label: id === "all" ? "All" : ASSET_GROUP_LABEL[id], count: id === "all" ? features.length : groupCounts[id] }))
      .filter((g) => g.id === "all" || g.count > 0);

    const currentFilter = assetCategoryFilter || "all";
    const isKnownGroup = currentFilter === "all" || currentFilter === "other" || currentFilter in ASSET_GROUP_CLASSES;
    const activeGroup: string = isKnownGroup
      ? currentFilter
      : assetGroupForCanonical(features.find((f) => (f.properties.category ?? "").trim() === currentFilter)?.properties.canonical_class);

    const scoped = activeGroup === "all" ? features : features.filter((f) => assetGroupForCanonical(f.properties.canonical_class) === activeGroup);
    const catCounts = new Map<string, number>();
    for (const f of scoped) {
      const cat = (f.properties.category ?? "").trim();
      if (cat) catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    }
    const filteredSubCats = [...catCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => ({ id: cat, label: cat, count, color: colorForCategory(cat) }));

    return { groups, filteredSubCats, activeGroup, total: features.length };
  }, [cardId, features, assetCategoryFilter]);

  const assetConditionBreakdown = useMemo(
    () => (cardId === "asset-catalog" ? attributeBreakdown(dashboardFeatures, CONDITION_ATTRIBUTE_KEYS, "Not recorded", ["#22c55e", "#ef4444", "#f59e0b", "#8b5cf6", "#38bdf8", "#ec4899", "#14b8a6"]) : []),
    [cardId, dashboardFeatures]
  );

  const assetCatalogInsights = useMemo(() => {
    if (cardId !== "asset-catalog") return { recordedCount: 0, notRecordedCount: 0, topCondition: null as { label: string; count: number } | null, needsAttention: 0 };
    const notRecordedCount = assetConditionBreakdown.find((b) => b.label === "Not recorded")?.count ?? 0;
    const recordedCount = dashboardFeatures.length - notRecordedCount;
    const badTokens = ["bad", "block", "damag", "poor", "chok", "silt", "leak", "crack", "broken"];
    const needsAttention = dashboardFeatures.filter((f) => {
      const raw = String(firstRecorded(f, CONDITION_ATTRIBUTE_KEYS) ?? "").toLowerCase();
      return badTokens.some((t) => raw.includes(t));
    }).length;
    const topCondition = assetConditionBreakdown.filter((b) => b.label !== "Not recorded").sort((a, b) => b.count - a.count)[0] ?? null;
    return { recordedCount, notRecordedCount, topCondition, needsAttention };
  }, [cardId, dashboardFeatures, assetConditionBreakdown]);

  const isRoadSurfaceIssue = cardId === "pothole-check" || cardId === "standing-water";
  const roadSurfaceIssueData = useMemo(() => {
    if (!isRoadSurfaceIssue) {
      return {
        depthValues: [] as number[],
        elevationValues: [] as number[],
        avgDepth: null as number | null,
        deepest: null as number | null,
        lowestElevation: null as number | null,
        surfaceRecorded: 0,
        surfaceBreakdown: [] as { label: string; count: number; color: string }[],
        topDepthRecords: [] as { name: string; depth: number; color: string }[],
        locationBreakdown: [] as { label: string; count: number; color: string }[],
        issueGroups: [] as { label: string; count: number; ids: string; maxDepth: string; minElevation: string; evidence: string; color: string }[],
        issueGroupChart: [] as { name: string; count: number; color: string }[],
        evidenceSignals: [] as { label: string; value: number; count: string; color: string }[],
        causeSignals: [] as { label: string; value: number; note: string; color: string }[],
        causeSummary: "No issue data available",
        resolutionSummary: "No repair recommendation can be produced without matched issue records.",
        resolutionSteps: [] as string[],
        issueRecords: [] as { id: string; label: string; depth: string; elevation: string; surface: string; image: string; source: string; color: string }[],
        imageRecorded: 0,
        elevationSpread: null as number | null,
        evidenceScore: 0,
        priorityLabel: "No matching records",
        priorityReason: "No pothole or standing-water records match this quick analysis.",
      };
    }
    const depthValues = dashboardFeatures
      .map((feature) => issueNumberValue(feature, ROAD_ISSUE_DEPTH_KEYS))
      .filter((value): value is number => value !== null);
    const elevationValues = dashboardFeatures
      .map((feature) => issueNumberValue(feature, ROAD_ISSUE_ELEVATION_KEYS))
      .filter((value): value is number => value !== null);
    const avgDepth = depthValues.length ? depthValues.reduce((sum, value) => sum + value, 0) / depthValues.length : null;
    const deepest = depthValues.length ? Math.max(...depthValues) : null;
    const lowestElevation = elevationValues.length ? Math.min(...elevationValues) : null;
    const highestElevation = elevationValues.length ? Math.max(...elevationValues) : null;
    const elevationSpread = lowestElevation !== null && highestElevation !== null && elevationValues.length > 1 ? highestElevation - lowestElevation : null;
    const surfaceBreakdown = attributeBreakdown(dashboardFeatures, ROAD_ISSUE_SURFACE_KEYS, "Not recorded", ["#f97316", "#0ea5e9", "#eab308", "#22c55e", "#8b5cf6", "#ef4444"]);
    const surfaceRecorded = dashboardFeatures.filter((feature) => firstIssueAttribute(feature, ROAD_ISSUE_SURFACE_KEYS) !== undefined).length;
    const imageRecorded = dashboardFeatures.filter((feature) => firstRecorded(feature, ROAD_ISSUE_IMAGE_KEYS) !== undefined).length;
    const groupedFeatures = new Map<string, UrbanFeature[]>();
    for (const feature of dashboardFeatures) {
      const location = String(firstIssueAttribute(feature, ROAD_ISSUE_LOCATION_KEYS) ?? feature.properties.label ?? feature.properties.category ?? "Unspecified location").trim();
      const key = location || "Unspecified location";
      groupedFeatures.set(key, [...(groupedFeatures.get(key) ?? []), feature]);
    }
    const locationBreakdown = [...groupedFeatures.entries()]
      .map(([label, group], index) => ({ label, count: group.length, color: ["#14b8a6", "#38bdf8", "#f97316", "#eab308", "#8b5cf6"][index % 5] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const issueGroupsDetailed = [...groupedFeatures.entries()]
      .map(([label, group], index) => {
        const groupDepths = group.map((feature) => issueNumberValue(feature, ROAD_ISSUE_DEPTH_KEYS)).filter((value): value is number => value !== null);
        const groupElevations = group.map((feature) => issueNumberValue(feature, ROAD_ISSUE_ELEVATION_KEYS)).filter((value): value is number => value !== null);
        const groupIds = group
          .map((feature) => String(firstRecorded(feature, ["FID", "GDB_FID", "OBJECTID", "ObjectId"]) ?? feature.properties.id.slice(0, 8)))
          .slice(0, 3);
        const imageCount = group.filter((feature) => firstRecorded(feature, ROAD_ISSUE_IMAGE_KEYS) !== undefined).length;
        const surfaceCount = group.filter((feature) => firstIssueAttribute(feature, ROAD_ISSUE_SURFACE_KEYS) !== undefined).length;
        return {
          label,
          count: group.length,
          ids: groupIds.join(", "),
          maxDepth: groupDepths.length ? `${Math.max(...groupDepths).toFixed(2)} m` : "No depth",
          minElevation: groupElevations.length ? `${Math.min(...groupElevations).toFixed(2)}` : "No level",
          evidence: `${imageCount} photo / ${surfaceCount} surface`,
          color: cardId === "pothole-check" ? ["#ef4444", "#f97316", "#eab308", "#14b8a6"][index % 4] : ["#0ea5e9", "#2563eb", "#14b8a6", "#64748b"][index % 4],
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const issueGroupChart = issueGroupsDetailed.map((group) => {
      const label = group.label === "Unspecified location" ? `FID ${group.ids}` : group.label;
      return {
        name: label.length > 18 ? `${label.slice(0, 17)}...` : label,
        count: group.count,
        color: group.color,
      };
    });
    const topDepthRecords = dashboardFeatures
      .map((feature, index) => {
        const depth = issueNumberValue(feature, ROAD_ISSUE_DEPTH_KEYS);
        if (depth === null) return null;
        const fid = firstRecorded(feature, ["FID", "GDB_FID", "OBJECTID", "ObjectId"]);
        const road = firstRecorded(feature, ["Road_Name", "Name"]);
        return {
          name: String(road ?? fid ?? feature.properties.label ?? `Record ${index + 1}`).slice(0, 18),
          depth,
          color: cardId === "pothole-check" ? "#f97316" : "#0ea5e9",
        };
      })
      .filter((entry): entry is { name: string; depth: number; color: string } => entry !== null)
      .sort((a, b) => b.depth - a.depth)
      .slice(0, 8);
    const issueRecords = dashboardFeatures.slice(0, 10).map((feature, index) => {
      const fid = firstRecorded(feature, ["FID", "GDB_FID", "OBJECTID", "ObjectId"]);
      const category = feature.properties.category ?? "Issue record";
      const label = String(firstIssueAttribute(feature, ROAD_ISSUE_LOCATION_KEYS) ?? feature.properties.label ?? category ?? `Record ${index + 1}`);
      return {
        id: String(fid ?? feature.properties.id.slice(0, 8)),
        label: label === String(fid ?? "") ? `${category} / ${label}` : label,
        depth: displayValue(firstIssueAttribute(feature, ROAD_ISSUE_DEPTH_KEYS)),
        elevation: displayValue(firstIssueAttribute(feature, ROAD_ISSUE_ELEVATION_KEYS)),
        surface: displayValue(firstIssueAttribute(feature, ROAD_ISSUE_SURFACE_KEYS)),
        image: displayValue(firstRecorded(feature, ROAD_ISSUE_IMAGE_KEYS)),
        source: displayValue(firstRecorded(feature, ["gdb_layer", "GDB_LAYER", "LAYER", "Layer", "layer_name"])),
        color: cardId === "pothole-check" ? "#f97316" : "#0ea5e9",
      };
    });
    const evidenceScore = [depthValues.length > 0, elevationValues.length > 0, surfaceRecorded > 0, imageRecorded > 0].filter(Boolean).length;
    const priorityLabel = dashboardFeatures.length === 0
      ? "No matching records"
      : evidenceScore >= 3
        ? "Work-order ready"
        : evidenceScore >= 1
          ? "Field verify first"
          : "Location-only";
    const priorityReason = dashboardFeatures.length === 0
      ? "No issue layer records matched this card."
      : evidenceScore >= 3
        ? "Enough location and condition evidence exists to compare sites and assign repair priority."
        : cardId === "pothole-check"
          ? "Record the pothole depth, surface type and photo evidence before preparing patching quantities."
          : "Record ponding depth, road level and outlet condition before deciding drainage improvement work.";
    const coverage = (count: number) => dashboardFeatures.length ? Math.round((count / dashboardFeatures.length) * 100) : 0;
    const evidenceSignals = [
      { label: "Location", value: dashboardFeatures.length ? 100 : 0, count: `${locationBreakdown.length}/${dashboardFeatures.length} sites`, color: "#14b8a6" },
      { label: "Level", value: coverage(elevationValues.length), count: `${elevationValues.length}/${dashboardFeatures.length}`, color: "#2563eb" },
      { label: "Depth", value: coverage(depthValues.length), count: `${depthValues.length}/${dashboardFeatures.length}`, color: cardId === "pothole-check" ? "#f97316" : "#0ea5e9" },
      { label: "Surface", value: coverage(surfaceRecorded), count: `${surfaceRecorded}/${dashboardFeatures.length}`, color: "#eab308" },
      { label: "Photo", value: coverage(imageRecorded), count: `${imageRecorded}/${dashboardFeatures.length}`, color: "#8b5cf6" },
    ];
    const topGroup = locationBreakdown[0] ?? null;
    const topSurface = surfaceBreakdown.filter((entry) => entry.label !== "Not recorded").sort((a, b) => b.count - a.count)[0] ?? null;
    const clusterStrength = dashboardFeatures.length && topGroup ? Math.round((topGroup.count / dashboardFeatures.length) * 100) : 0;
    const levelSignal = elevationValues.length
      ? Math.min(100, Math.max(35, Math.round(((elevationSpread ?? 1) / 5) * 100)))
      : 0;
    const depthSignal = depthValues.length ? Math.min(100, Math.max(35, coverage(depthValues.length))) : 0;
    const surfaceSignal = surfaceRecorded ? Math.min(100, Math.max(35, coverage(surfaceRecorded))) : 0;
    const causeSignals = cardId === "pothole-check"
      ? [
        { label: "Low spot stress", value: levelSignal, note: lowestElevation !== null ? `lowest ${lowestElevation.toFixed(2)}` : "level missing", color: "#2563eb" },
        { label: "Surface failure", value: surfaceSignal, note: topSurface ? topSurface.label : "surface missing", color: "#f97316" },
        { label: "Repeated damage", value: clusterStrength, note: topGroup ? `${topGroup.count} at top site` : "no cluster", color: "#ef4444" },
        { label: "Severity measured", value: depthSignal, note: deepest !== null ? `${deepest.toFixed(2)} m max` : "depth missing", color: "#8b5cf6" },
      ]
      : [
        { label: "Low point", value: levelSignal, note: lowestElevation !== null ? `lowest ${lowestElevation.toFixed(2)}` : "level missing", color: "#2563eb" },
        { label: "Outlet/crossfall check", value: Math.max(levelSignal, clusterStrength), note: topGroup ? `${topGroup.count} at top site` : "no cluster", color: "#0ea5e9" },
        { label: "Ponding severity", value: depthSignal, note: deepest !== null ? `${deepest.toFixed(2)} m max` : "depth missing", color: "#14b8a6" },
        { label: "Surface runoff", value: surfaceSignal, note: topSurface ? topSurface.label : "surface missing", color: "#eab308" },
      ];
    const causeSummary = dashboardFeatures.length === 0
      ? "No matched issue records."
      : cardId === "pothole-check"
        ? lowestElevation !== null
          ? `Likely pavement failure around low-level locations; ${topSurface ? `${topSurface.label} surface context is present.` : "surface type must be confirmed."}`
          : "Pothole locations are mapped, but level/depth fields must confirm whether water retention is the driver."
        : lowestElevation !== null
          ? `Likely ponding at local low points; check outlet, crossfall and nearby drain connectivity.`
          : "Standing-water locations are mapped, but road levels must confirm whether these are low points or outlet failures.";
    const resolutionSummary = cardId === "pothole-check"
      ? deepest !== null
        ? "Prepare patching by depth class, then fix drainage if the defect sits at the lowest level."
        : "Measure pothole depth and surface failure before estimating repair quantity."
      : deepest !== null
        ? "Prioritise dewatering, drain cleaning and crossfall correction by measured ponding depth."
        : "Measure ponding depth and verify outlet/crossfall before selecting the drainage treatment.";
    const resolutionSteps = cardId === "pothole-check"
      ? [
        lowestElevation !== null ? "Treat the lowest-level cluster first because runoff will keep damaging the patch." : "Capture road level at each pothole to separate impact damage from drainage-related failure.",
        surfaceRecorded > 0 ? "Match repair method to recorded surface: patch asphalt/BT, reinstate concrete panel, or rebuild unpaved base." : "Record surface type so the estimate is not a generic patch item.",
        deepest !== null ? "Use max depth to classify patch quantity and compaction requirement." : "Measure depth before work order release.",
      ]
      : [
        lowestElevation !== null ? "Check the lowest-level point first and trace where water should discharge." : "Capture road level/crossfall to identify the low pocket.",
        "Inspect nearest drain inlet, outlet and blockage before proposing new construction.",
        deepest !== null ? "Use water depth to rank desilting, regrading or inlet improvement priority." : "Measure water depth during or soon after ponding.",
      ];
    return { depthValues, elevationValues, avgDepth, deepest, lowestElevation, surfaceRecorded, surfaceBreakdown, topDepthRecords, locationBreakdown, issueGroups: issueGroupsDetailed, issueGroupChart, evidenceSignals, causeSignals, causeSummary, resolutionSummary, resolutionSteps, issueRecords, imageRecorded, elevationSpread, evidenceScore, priorityLabel, priorityReason };
  }, [cardId, dashboardFeatures, isRoadSurfaceIssue]);

  useEffect(() => {
    if (cardId !== "survey-kpis" || datasetIds.length === 0) return;
    const controller = new AbortController();
    fetchManholeReadiness(datasetIds, controller.signal).then(setReadiness).catch(() => {});
    return () => controller.abort();
  }, [cardId, datasetIds]);

  const data = useMemo(() => {
    if (cardId === "drain-encroachment") {
      return {
        bottom: [
          { label: "Affected buildings", value: drainEncroachment ? String(drainEncroachment.affected_buildings) : "—" },
          { label: "Affected drains", value: drainEncroachment ? `${drainEncroachment.affected_drains}/${drainEncroachment.total_drains}` : "—" },
          { label: "Major crossings", value: drainEncroachment ? String(drainEncroachment.major_crossings) : "—" },
          { label: "Crossing length", value: drainEncroachment ? formatLength(drainEncroachment.crossing_length_m) : "—" },
        ],
        rightHeading: "Actual encroachment analysis",
        right: [],
        rightEmptyLabel: "No drain/building intersections were found in the active dataset.",
      };
    }
    if (cardId === "utility-tracker") {
      const totalPowerLines = features.filter((f) => (f.properties.category ?? "").toLowerCase().includes("power line") || (f.properties.category ?? "").toLowerCase().includes("electric line")).length;
      const totalWaterLines = features.filter((f) => (f.properties.category ?? "").toLowerCase().includes("water line") || (f.properties.category ?? "").toLowerCase().includes("pipe")).length;
      const totalPoles = features.filter((f) => (f.properties.category ?? "").toLowerCase().includes("pole") || (f.properties.category ?? "").toLowerCase().includes("light")).length;
      const activeLabel = utilitySubCategory === "all" || !utilitySubCategory
        ? "All Utilities"
        : utilitySubCategory === "electricity"
          ? "⚡ Electricity"
          : utilitySubCategory === "water"
            ? "💧 Water System"
            : utilitySubCategory;

      return {
        bottom: [
          { label: "Active View", value: String(dashboardFeatures.length), sub: activeLabel },
          { label: "Poles & Lighting", value: String(totalPoles), sub: "5 distinct icons" },
          { label: "Power Grid Lines", value: formatLength(utilityLineLengths.powerM), sub: `${totalPowerLines} wire segments` },
          { label: "Water Pipe Network", value: formatLength(utilityLineLengths.waterM), sub: `${totalWaterLines} pipe segments` },
        ],
        rightHeading: "Category distribution",
        right: categoryStats.slice(0, 7).map((c) => ({ label: c.category, count: c.count, color: c.color })),
      };
    }
    return computeDashboardData(cardId, {
      loadedFeatures: dashboardFeatures,
      categoryStats,
      anomalies,
      activeDatasetIds: datasetIds,
      readiness,
    });
  }, [anomalies, cardId, categoryStats, dashboardFeatures, datasetIds, drainEncroachment, features, readiness, utilityLineLengths.powerM, utilityLineLengths.waterM, utilitySubCategory]);

  const generalAnalytics = useMemo(() => {
    const geometry = [
      { name: "Points", value: dashboardFeatures.filter((feature) => feature.geometry.type.includes("Point")).length, color: "#14b8a6" },
      { name: "Lines", value: dashboardFeatures.filter((feature) => feature.geometry.type.includes("LineString")).length, color: "#38bdf8" },
      { name: "Areas", value: dashboardFeatures.filter((feature) => feature.geometry.type.includes("Polygon")).length, color: "#a78bfa" },
    ].filter((entry) => entry.value > 0);
    const withAttributes = dashboardFeatures.filter((feature) =>
      Object.values(feature.properties.attributes ?? {}).some(recordedValue)
    ).length;
    const largestCategory = categoryStats[0];
    return {
      geometry,
      withAttributes,
      insights: [
        `${dashboardFeatures.length.toLocaleString()} mapped records are available across ${categoryStats.length} survey categories.`,
        largestCategory
          ? `${largestCategory.category} is the largest mapped group with ${largestCategory.count.toLocaleString()} records.`
          : "No category distribution is available for this selection.",
        `${withAttributes.toLocaleString()} records contain at least one usable survey attribute; ${(dashboardFeatures.length - withAttributes).toLocaleString()} contain geometry only.`,
        data.right.length > 0
          ? `${data.rightHeading} is the strongest available comparison for this analysis.`
          : "No comparable assessment values are recorded for this analysis.",
      ],
    };
  }, [categoryStats, dashboardFeatures, data.right.length, data.rightHeading]);

  const maxCount = Math.max(1, ...data.right.map((item) => item.count));
  const displayedFeatureCount = cardId === "drain-encroachment" ? (drainEncroachment?.total_drains ?? 0) : dashboardFeatures.length;
  const displayedFeatureLabel = isDrainAnalysis
    ? drainEncroachment
      ? `${drainEncroachment.affected_buildings.toLocaleString()} encroached buildings across ${drainEncroachment.affected_drains} drain segments highlighted`
      : "Calculating exact drain/building intersections..."
    : isRoadSurfaceIssue
      ? `${displayedFeatureCount.toLocaleString()} ${cardId === "pothole-check" ? "pothole" : "standing-water"} issue${displayedFeatureCount === 1 ? "" : "s"} highlighted for planner review`
    : `${displayedFeatureCount.toLocaleString()} mapped features shown`;
  const selectedLength = selectedFeature ? featureLengthMeters(selectedFeature) : 0;
  const selectedIsDrain = selectedFeature?.properties.canonical_class === "Drainage_Asset";
  const selectedIsManhole = selectedFeature?.properties.canonical_class === "Access_Point";
  const selectedIsPothole = selectedFeature ? isPotholeFeature(selectedFeature) : false;
  const selectedIsStandingWater = selectedFeature ? isStandingWaterFeature(selectedFeature) : false;
  const selectedCondition = selectedFeature
    ? firstRecorded(
        selectedFeature,
        selectedIsDrain
          ? ["SWD_Status", "Condition", "Maintenance_Status", "Maintenance_Status_1"]
          : ["Manhole_Condition", "Condition", "Maintenance_Status", "Maintenance_Status_1"]
      )
    : undefined;
  const selectedPipeType = selectedFeature ? firstRecorded(selectedFeature, ["Pipe_Type", "pipe_type", "Type_of_UGD"]) : undefined;
  const selectedDepth = selectedFeature ? firstRecorded(selectedFeature, ["Depth", "UGD_Line_Depth"]) : undefined;
  const selectedDiameter = selectedFeature ? firstRecorded(selectedFeature, ["Diameter", "Pipe_Dia"]) : undefined;
  const selectedTopLevel = selectedFeature ? firstRecorded(selectedFeature, ["Top_Level"]) : undefined;
  const selectedBottomLevel = selectedFeature ? firstRecorded(selectedFeature, ["Bottom_Level"]) : undefined;
  const selectedSiltLevel = selectedFeature ? firstRecorded(selectedFeature, ["Silt_Level"]) : undefined;
  const selectedRemarks = selectedFeature ? firstRecorded(selectedFeature, ["Remarks", "Maintenance_Status", "Maintenance_Status_1"]) : undefined;
  const selectedDimensions = selectedFeature ? firstRecorded(selectedFeature, ["SWD_WidthXDepth", "WidthXDepth", "Depth", "Diameter"]) : undefined;
  const selectedRoad = selectedFeature ? firstIssueAttribute(selectedFeature, ROAD_ISSUE_LOCATION_KEYS) ?? firstRecorded(selectedFeature, ["Road_Name", "Name"]) : undefined;
  const selectedFid = selectedFeature ? firstRecorded(selectedFeature, ["FID"]) : undefined;
  const selectedIssueDepth = selectedFeature ? firstIssueAttribute(selectedFeature, ROAD_ISSUE_DEPTH_KEYS) : undefined;
  const selectedIssueElevation = selectedFeature ? firstIssueAttribute(selectedFeature, ROAD_ISSUE_ELEVATION_KEYS) : undefined;
  const selectedIssueSurface = selectedFeature ? firstIssueAttribute(selectedFeature, ROAD_ISSUE_SURFACE_KEYS) : undefined;
  const selectedIssueImage = selectedFeature ? firstRecorded(selectedFeature, ROAD_ISSUE_IMAGE_KEYS) : undefined;
  const selectedSourceLayer = selectedFeature ? firstRecorded(selectedFeature, ["gdb_layer", "GDB_LAYER", "LAYER", "Layer", "layer_name"]) : undefined;
  const selectedAttributes = selectedFeature
    ? Object.entries(selectedFeature.properties.attributes ?? {})
        .filter(([key, value]) => !key.startsWith("_") && recordedValue(value))
        .slice(0, 10)
    : [];
  const selectedEncroachment = selectedFeature && drainEncroachment
    ? drainEncroachment.buildings.find((hit) => hit.building_id === selectedFeature.properties.id) ?? null
    : null;
  const selectedDrainImpact = selectedFeature && drainEncroachment
    ? drainEncroachment.drains.find((drain) => drain.drain_id === selectedFeature.properties.id) ?? null
    : null;
  const hasSelection = Boolean(selectedFeature || selectedConnection);
  const manholeNetworkData = [
    { label: "Verified", count: manholeNetworkStatusCounts.good, color: "#16a34a" },
    { label: "Check", count: manholeNetworkStatusCounts.warning, color: "#eab308" },
    { label: "Attention", count: manholeNetworkStatusCounts.critical, color: "#dc2626" },
  ];
  // Distinct from manholeNetworkData above: that donut classifies each
  // ROUTE's connection quality (Verified/Check/Attention/Not connected).
  // This groups manholes by WHAT is physically wrong with them (condition
  // audit's primary_issue), a different axis — so the bar chart and donut
  // in the Manhole Detail card show complementary facts, not the same
  // counts twice.
  const MANHOLE_ISSUE_LABEL: Record<string, string> = {
    blockage: "Blockage",
    garbage: "Garbage",
    siltation: "Siltation",
    structural_damage: "Structural",
    cover_issue: "Cover",
    odor: "Odor",
    inflow: "Inflow",
    general_deterioration: "General wear",
  };
  const MANHOLE_ISSUE_PALETTE = ["#ef4444", "#f59e0b", "#c2410c", "#8b5cf6", "#38bdf8", "#ec4899", "#14b8a6", "#94a3b8"];
  const manholeIssueBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of anomalies) {
      if (a.anomaly_type !== "manhole_status") continue;
      const issue = String(a.anomaly_metadata?.primary_issue ?? "");
      if (!issue || issue === "no_issues_reported") continue;
      counts.set(issue, (counts.get(issue) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([issue, count], index) => ({
        label: MANHOLE_ISSUE_LABEL[issue] ?? issue.replace(/_/g, " "),
        count,
        color: MANHOLE_ISSUE_PALETTE[index % MANHOLE_ISSUE_PALETTE.length],
      }))
      .sort((a, b) => b.count - a.count);
  }, [anomalies]);
  const roadWidthAnomalies = useMemo(
    () => anomalies.filter((a) => a.anomaly_type === "road_width_narrowing"),
    [anomalies, cardId]
  );
  const roadWidthSeverity = useMemo(() => {
    const counts = { red: 0, yellow: 0, green: 0 };
    for (const a of roadWidthAnomalies) counts[a.color as keyof typeof counts] += 1;
    return [
      { label: "Red — needs attention", value: counts.red, color: "#ef4444" },
      { label: "Yellow — watch", value: counts.yellow, color: "#eab308" },
      { label: "Green — OK", value: counts.green, color: "#22c55e" },
    ].filter((entry) => entry.value > 0);
  }, [roadWidthAnomalies]);
  // Distinct from roadWidthSeverity above: that donut counts how many
  // segments fall in each severity bucket. This ranks the individual
  // WORST segments by their real % narrowing, same "top offenders" shape
  // as the drain-encroachment bar — so the bar and donut here show
  // complementary facts instead of the same red/yellow counts twice.
  const roadWidthTopSegments = useMemo(() => {
    return [...roadWidthAnomalies]
      .sort((a, b) => (Number(b.anomaly_metadata?.drop_pct) || 0) - (Number(a.anomaly_metadata?.drop_pct) || 0))
      .slice(0, 8)
      .map((a) => ({
        name: String(a.anomaly_metadata?.centerline_feature_id ?? a.id).slice(0, 6),
        drop_pct: Number(a.anomaly_metadata?.drop_pct) || 0,
        color: a.color === "red" ? "#ef4444" : a.color === "yellow" ? "#eab308" : "#22c55e",
      }));
  }, [roadWidthAnomalies]);
  const roadWidthAvgWidthM = roadWidthAnomalies.length
    ? roadWidthAnomalies.reduce((sum, a) => sum + (Number(a.anomaly_metadata?.width_m) || 0), 0) / roadWidthAnomalies.length
    : null;
  const wktLineCoords = (wkt: unknown): [number, number][] | null => {
    const value = typeof wkt === "string" ? wkt : "";
    const m = value.match(/LINESTRING\s*\(([^)]+)\)/i);
    if (!m) return null;
    return m[1]
      .trim()
      .split(",")
      .map((pair) => {
        const [lon, lat] = pair.trim().split(/\s+/).map(Number);
        return [lon, lat] as [number, number];
      });
  };
  const roadWidthAffectedM = useMemo(() => {
    let total = 0;
    for (const a of roadWidthAnomalies) {
      const coords = wktLineCoords(a.anomaly_metadata?.affected_line_wkt);
      if (coords) total += lineLength(coords);
    }
    return total;
  }, [roadWidthAnomalies]);
  const roadWidthEdgeBuildings = useMemo(() => {
    let buildingEdges = 0;
    for (const a of roadWidthAnomalies) {
      const meta = a.anomaly_metadata ?? {};
      if (/building|temple|structure/i.test(String(meta.left_edge_category ?? ""))) buildingEdges += 1;
      if (/building|temple|structure/i.test(String(meta.right_edge_category ?? ""))) buildingEdges += 1;
    }
    return buildingEdges;
  }, [roadWidthAnomalies]);
  const roadWidthWorstDropPct = roadWidthAnomalies.length
    ? Math.max(...roadWidthAnomalies.map((a) => Number(a.anomaly_metadata?.drop_pct) || 0))
    : null;

  return (
    <section className="quick-map-dashboard" aria-label={`${title} dashboard`} data-testid="quick-analysis-map-dashboard">
      <div className="quick-map-dashboard__tools">
        <button
          type="button"
          className={`quick-map-dashboard__tools-toggle${toolsOpen ? " is-open" : ""}${activeTool ? " is-active" : ""}`}
          onClick={() => setToolsOpen((current) => !current)}
          aria-label="Quick Analysis map tools"
          aria-expanded={toolsOpen}
          title="Map tools"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14.5 6.5 17.5 9.5 9 18l-4 1 1-4Z" /><path d="m13 8 3 3" /></svg>
        </button>
        <button
          type="button"
          className={`quick-map-dashboard__canvas-toggle${canvasBlank ? " is-active" : ""}`}
          onClick={() => {
            setToolsOpen(false);
            onToggleCanvasBlank();
          }}
          aria-pressed={canvasBlank}
          aria-label={canvasBlank ? "Show background map" : "Hide background map"}
          title={canvasBlank ? "Show background" : "Hide background"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 9h8M8 13h5" /><path d="m4 19 16-14" /></svg>
        </button>
        {toolsOpen && (
          <div className="quick-map-dashboard__tools-menu">
            <button type="button" className={activeTool === "measure" ? "is-active" : ""} onClick={() => { onActivateMeasure(); setToolsOpen(false); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 17 17 4l3 3L7 20Z" /><path d="m10 11 3 3m0-6 3 3" /></svg>
              <span><b>Measure</b><small>Distance, path or area</small></span>
            </button>
          </div>
        )}
      </div>

      {!hasSelection && (
        <div className="quick-map-dashboard__tool-hint">
          {isDrainAnalysis
            ? "Click a building crossed by a bold line or a drain for details"
            : cardId === "manhole-detail"
              ? manholeNetworkLoading
                ? "Building verified manhole connections and flow directions..."
                : manholeNetworkError
                  ? `Manhole connections unavailable: ${manholeNetworkError}`
                  : `${manholeNetworkRouteCount} mapped connections · ${manholeNetworkFlowCount} confirmed flow directions`
              : "Click a highlighted map feature for details"}
        </div>
      )}

      <aside className="quick-map-dashboard__right" aria-label="Analysis summary">
        <header className="quick-map-dashboard__head">
          <div>
            <span className="quick-map-dashboard__eyebrow">Quick Analysis</span>
            <h2>{selectedConnection ? "Manhole connection details" : selectedFeature ? (selectedEncroachment ? "Encroached building details" : selectedIsDrain ? "Drain impact details" : selectedIsManhole ? "Manhole details" : "Survey feature details") : title}</h2>
            <p>{hasSelection ? "Actual surveyed geometry and deterministic spatial analysis" : description}</p>
          </div>
          <button type="button" className="quick-map-dashboard__close" onClick={onClose} aria-label="Close analysis dashboard" title="Back to map">×</button>
        </header>

        {cardId === "utility-tracker" && (
          <div className="quick-map-dashboard__utility-filter">
            <div className="quick-map-dashboard__utility-groups">
              {utilityData.groups.map((group) => {
                const active = utilityData.activeGroup === group.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    className={`quick-map-dashboard__utility-btn${active ? " is-active" : ""}`}
                    onClick={() => onSelectUtilitySubCategory?.(group.id)}
                  >
                    <span>{group.label}</span>
                  </button>
                );
              })}
            </div>
            {utilityData.filteredSubCats.length > 0 && (
              <div className="quick-map-dashboard__utility-select-wrap">
                <label htmlFor="utility-subcat-select">Sub-category Filter:</label>
                <select
                  id="utility-subcat-select"
                  className="quick-map-dashboard__utility-select"
                  value={utilitySubCategory || "all"}
                  onChange={(e) => onSelectUtilitySubCategory?.(e.target.value)}
                >
                  {utilityData.activeGroup === "all" ? (
                    <option value="all">All Sub-categories ({utilityData.total})</option>
                  ) : utilityData.activeGroup === "electricity" ? (
                    <option value="electricity">All Electricity ({utilityData.elecCount})</option>
                  ) : utilityData.activeGroup === "water" ? (
                    <option value="water">All Water ({utilityData.waterCount})</option>
                  ) : (
                    <option value="telecom">All Telecom ({utilityData.telecomCount})</option>
                  )}
                  {utilityData.filteredSubCats.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.label} ({sub.count})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {cardId === "asset-catalog" && (
          <div className="quick-map-dashboard__utility-filter">
            <div className="quick-map-dashboard__utility-groups">
              {assetCatalogData.groups.map((group) => {
                const active = assetCatalogData.activeGroup === group.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    className={`quick-map-dashboard__utility-btn${active ? " is-active" : ""}`}
                    onClick={() => onSelectAssetCategoryFilter?.(group.id)}
                  >
                    <span>{group.label}{group.id !== "all" ? ` (${group.count})` : ""}</span>
                  </button>
                );
              })}
            </div>
            {assetCatalogData.filteredSubCats.length > 0 && (
              <div className="quick-map-dashboard__utility-select-wrap">
                <label htmlFor="asset-subcat-select">Category Filter:</label>
                <select
                  id="asset-subcat-select"
                  className="quick-map-dashboard__utility-select"
                  value={assetCategoryFilter || "all"}
                  onChange={(e) => onSelectAssetCategoryFilter?.(e.target.value)}
                >
                  <option value={assetCatalogData.activeGroup}>
                    {assetCatalogData.activeGroup === "all"
                      ? `All Categories (${assetCatalogData.total})`
                      : `All ${assetCatalogData.groups.find((g) => g.id === assetCatalogData.activeGroup)?.label ?? ""} (${assetCatalogData.groups.find((g) => g.id === assetCatalogData.activeGroup)?.count ?? 0})`}
                  </option>
                  {assetCatalogData.filteredSubCats.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.label} ({sub.count})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {selectedConnection ? (
          <div className="quick-map-dashboard__selection">
            <div className={`quick-map-dashboard__assessment${selectedConnection.status === "critical" ? " is-danger" : selectedConnection.status === "warning" ? " is-warning" : " is-recorded"}`}>
              <span>Connection status</span>
              <strong>{selectedConnection.statusLabel}</strong>
              <small>{selectedConnection.flowConfirmed ? "Downstream flow direction confirmed" : "Flow direction is not confirmed"}</small>
            </div>
            <dl className="quick-map-dashboard__facts">
              <div><dt>From manhole</dt><dd>{selectedConnection.fromId.slice(0, 8)}</dd></div>
              <div><dt>To manhole</dt><dd>{selectedConnection.toId?.slice(0, 8) ?? "Not connected"}</dd></div>
              <div><dt>Flow direction</dt><dd>{selectedConnection.flowConfirmed ? "Confirmed" : "Unconfirmed"}</dd></div>
              <div><dt>Connection basis</dt><dd>{selectedConnection.routeBasis === "sewage_line" ? "Surveyed sewage/drain line" : selectedConnection.routeBasis === "concrete_road" ? "Road-assisted connection" : "Not recorded"}</dd></div>
              <div><dt>Elevation source</dt><dd>{selectedConnection.elevationSource?.replace(/_/g, " ") ?? "Not recorded"}</dd></div>
              <div><dt>Pipe</dt><dd>{selectedConnection.pipeMaterial} · {selectedConnection.pipeDiameterMm} mm</dd></div>
              <div><dt>Slope</dt><dd>{selectedConnection.slope === null ? "Not confirmed" : `${(selectedConnection.slope * 100).toFixed(2)}%`}</dd></div>
              <div><dt>Rainy-season action</dt><dd>{selectedConnection.rainySeasonClosed ? "Inspect / keep closed" : "No closure flag"}</dd></div>
            </dl>
            <button type="button" className="quick-map-dashboard__back-summary" onClick={onClearSelectedConnection}>Deselect connection</button>
          </div>
        ) : selectedFeature ? (
          <div className="quick-map-dashboard__selection">
            {selectedEncroachment ? (
              <div className={`quick-map-dashboard__assessment${selectedEncroachment.classification === "major_crossing" ? " is-danger" : " is-warning"}`}>
                <span>Encroachment classification</span>
                <strong>{selectedEncroachment.classification === "major_crossing" ? "Major drain crossing" : "Partial building clip"}</strong>
                <small>{formatLength(selectedEncroachment.crossing_length_m)} of drain lies inside this footprint</small>
              </div>
            ) : selectedDrainImpact ? (
              <div className={`quick-map-dashboard__assessment${selectedDrainImpact.affected_buildings > 0 ? " is-danger" : " is-recorded"}`}>
                <span>Drain impact</span>
                <strong>{selectedDrainImpact.affected_buildings} buildings intersected</strong>
                <small>{formatLength(selectedDrainImpact.crossing_length_m)} total crossing length</small>
              </div>
            ) : selectedIsManhole ? (
              <div className={`quick-map-dashboard__assessment${selectedCondition === undefined ? " is-warning" : " is-recorded"}`}>
                <span>Manhole condition</span>
                <strong>{selectedCondition === undefined ? "Not recorded" : displayValue(selectedCondition)}</strong>
                <small>{displayValue(selectedPipeType)} pipe{selectedDepth !== undefined ? ` · ${displayValue(selectedDepth)} deep` : ""}</small>
              </div>
            ) : selectedIsPothole || selectedIsStandingWater ? (
              <div className={`quick-map-dashboard__assessment${selectedIsPothole ? " is-warning" : " is-recorded"}`}>
                <span>{selectedIsPothole ? "Pothole / surface defect" : "Standing water / ponding"}</span>
                <strong>{displayValue(selectedIssueDepth !== undefined ? selectedIssueDepth : selectedIssueSurface)}</strong>
                <small>{displayValue(selectedRoad)}{selectedIssueElevation !== undefined ? ` / level ${displayValue(selectedIssueElevation)}` : ""}</small>
              </div>
            ) : (
              <div className="quick-map-dashboard__assessment is-recorded">
                <span>{selectedFeature.properties.category || "Survey feature"}</span>
                <strong>{selectedFeature.properties.label || selectedFeature.properties.category || "Survey feature"}</strong>
                <small>Actual record from the active survey dataset</small>
              </div>
            )}
            <dl className="quick-map-dashboard__facts">
              <div><dt>Feature ID</dt><dd>{displayValue(selectedFid ?? selectedFeature.properties.id.slice(0, 8))}</dd></div>
              {selectedEncroachment && <div><dt>Drain crossings</dt><dd>{selectedEncroachment.drain_ids.length}</dd></div>}
              {selectedEncroachment && <div><dt>Crossing ratio</dt><dd>{selectedEncroachment.crossing_ratio_pct.toFixed(1)}%</dd></div>}
              {selectedEncroachment && <div><dt>Inside footprint</dt><dd>{formatLength(selectedEncroachment.crossing_length_m)}</dd></div>}
              {selectedDrainImpact && <div><dt>Affected buildings</dt><dd>{selectedDrainImpact.affected_buildings}</dd></div>}
              {selectedDrainImpact && <div><dt>Crossing length</dt><dd>{formatLength(selectedDrainImpact.crossing_length_m)}</dd></div>}
              {selectedIsDrain && <div><dt>Condition status</dt><dd>{displayValue(selectedCondition)}</dd></div>}
              {selectedIsDrain && <div><dt>Mapped length</dt><dd>{formatLength(selectedLength)}</dd></div>}
              {selectedIsDrain && <div><dt>Dimensions</dt><dd>{displayValue(selectedDimensions)}</dd></div>}
              {selectedIsDrain && <div><dt>Road name</dt><dd>{displayValue(selectedRoad)}</dd></div>}
              {selectedIsManhole && <div><dt>Condition</dt><dd>{displayValue(selectedCondition)}</dd></div>}
              {selectedIsManhole && <div><dt>Pipe type</dt><dd>{displayValue(selectedPipeType)}</dd></div>}
              {selectedIsManhole && <div><dt>Depth</dt><dd>{displayValue(selectedDepth)}</dd></div>}
              {selectedIsManhole && <div><dt>Diameter</dt><dd>{displayValue(selectedDiameter)}</dd></div>}
              {selectedIsManhole && <div><dt>Road name</dt><dd>{displayValue(selectedRoad)}</dd></div>}
              {selectedIsManhole && <div><dt>Top level</dt><dd>{displayValue(selectedTopLevel)}</dd></div>}
              {selectedIsManhole && <div><dt>Bottom level</dt><dd>{displayValue(selectedBottomLevel)}</dd></div>}
              {selectedIsManhole && <div><dt>Silt level</dt><dd>{displayValue(selectedSiltLevel)}</dd></div>}
              {selectedIsManhole && <div><dt>Connection / remarks</dt><dd>{displayValue(selectedRemarks)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Road / location</dt><dd>{displayValue(selectedRoad)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Depth</dt><dd>{displayValue(selectedIssueDepth)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Elevation / level</dt><dd>{displayValue(selectedIssueElevation)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Surface</dt><dd>{displayValue(selectedIssueSurface)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Condition / status</dt><dd>{displayValue(selectedCondition)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Image / photo</dt><dd>{displayValue(selectedIssueImage)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Source layer</dt><dd>{displayValue(selectedSourceLayer)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Geometry</dt><dd>{selectedFeature.geometry.type}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && <div><dt>Remarks</dt><dd>{displayValue(selectedRemarks)}</dd></div>}
              {(selectedIsPothole || selectedIsStandingWater) && selectedAttributes.map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{displayValue(value)}</dd></div>)}
              {!selectedIsDrain && !selectedIsManhole && !selectedIsPothole && !selectedIsStandingWater && <div><dt>Source layer</dt><dd>{displayValue(firstRecorded(selectedFeature, ["gdb_layer", "LAYER"]))}</dd></div>}
              {!selectedIsDrain && !selectedIsManhole && !selectedIsPothole && !selectedIsStandingWater && <div><dt>Geometry</dt><dd>{selectedFeature.geometry.type}</dd></div>}
              {!selectedIsDrain && !selectedIsManhole && !selectedIsPothole && !selectedIsStandingWater && selectedAttributes.map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{displayValue(value)}</dd></div>)}
            </dl>
            <button type="button" className="quick-map-dashboard__back-summary" onClick={onClearSelectedFeature}>Deselect feature</button>
          </div>
        ) : (
          <>
            <div className="quick-map-dashboard__metrics" aria-label="Key metrics">
              {(cardId === "manhole-detail" ? [
                { label: "Connections", value: String(manholeNetworkRouteCount) },
                { label: "Verified flow", value: String(manholeNetworkFlowCount) },
                { label: "Needs attention", value: String(manholeNetworkStatusCounts.critical + manholeNetworkStatusCounts.warning) },
                { label: "Unconnected", value: String(manholeNetworkStatusCounts.unconnected) },
              ] : cardId === "road-width" ? [
                { label: "Narrow segments", value: String(roadWidthAnomalies.length) },
                { label: "Affected distance", value: formatLength(roadWidthAffectedM) },
                { label: "Edge buildings", value: String(roadWidthEdgeBuildings) },
                { label: "Worst drop", value: roadWidthWorstDropPct !== null ? `${roadWidthWorstDropPct.toFixed(0)}%` : "—" },
              ] : cardId === "asset-catalog" ? [
                { label: "Total assets", value: String(dashboardFeatures.length) },
                { label: "Categories", value: String(categoryStats.length) },
                { label: "Condition recorded", value: String(assetCatalogInsights.recordedCount) },
                { label: "Needs attention", value: String(assetCatalogInsights.needsAttention) },
              ] : isRoadSurfaceIssue ? [
                { label: "Affected sites", value: String(roadSurfaceIssueData.locationBreakdown.length) },
                { label: "Priority", value: roadSurfaceIssueData.priorityLabel },
                { label: "Lowest level", value: roadSurfaceIssueData.lowestElevation !== null ? roadSurfaceIssueData.lowestElevation.toFixed(2) : "Field check" },
                { label: "Cause basis", value: `${roadSurfaceIssueData.evidenceScore}/4 fields` },
              ] : data.bottom).map((tile) => (
                <article className="quick-map-dashboard__metric" key={tile.label}>
                  <span>{tile.label}</span>
                  <strong>{tile.value}</strong>
                  {tile.sub && <small>{tile.sub}</small>}
                </article>
              ))}
            </div>
            <p className="quick-map-dashboard__feature-count">
              {cardId === "manhole-detail"
                ? manholeNetworkLoading ? "Preparing manhole connection analysis..." : `${displayedFeatureCount.toLocaleString()} manholes with mapped connection status`
                : loading ? "Preparing cadastral analysis..." : displayedFeatureLabel}
            </p>
          </>
        )}
      </aside>

      <section className="quick-map-dashboard__breakdown" aria-label={data.rightHeading}>
        {loading ? (
          <p className="quick-map-dashboard__message">Loading analysis data...</p>
        ) : error ? (
          <p className="quick-map-dashboard__message quick-map-dashboard__message--error">{error}</p>
        ) : drainEncroachmentLoading ? (
          <p className="quick-map-dashboard__message">Computing exact drain/building intersections...</p>
        ) : drainEncroachmentError ? (
          <p className="quick-map-dashboard__message quick-map-dashboard__message--error">{drainEncroachmentError}</p>
        ) : cardId === "manhole-detail" && manholeNetworkLoading ? (
          <p className="quick-map-dashboard__message">Building verified manhole connections from the surveyed network...</p>
        ) : cardId === "manhole-detail" && manholeNetworkError ? (
          <p className="quick-map-dashboard__message quick-map-dashboard__message--error">Manhole connection analysis unavailable: {manholeNetworkError}</p>
        ) : cardId === "manhole-detail" ? (
          <div className="quick-map-dashboard__analysis-grid">
            <article className="quick-map-dashboard__chart-card">
              <h3>Condition issues</h3>
              <p>Problem types found by the condition audit — separate from connection status</p>
              <div className="quick-map-dashboard__chart">
                {manholeIssueBreakdown.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={manholeIssueBreakdown} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                      <CartesianGrid stroke="#27364a" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 8 }} axisLine={false} tickLine={false} interval={0} />
                      <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 9 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
                      <Bar dataKey="count" name="Manholes" radius={[4, 4, 0, 0]}>
                        {manholeIssueBreakdown.map((entry) => <Cell key={entry.label} fill={entry.color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="quick-map-dashboard__message">No condition issues found by the audit for this dataset.</p>
                )}
              </div>
            </article>
            <article className="quick-map-dashboard__chart-card quick-map-dashboard__chart-card--donut">
              <h3>Map legend</h3>
              <p>Click a coloured connection line to inspect its real details</p>
              <div className="quick-map-dashboard__donut-wrap">
                <div className="quick-map-dashboard__donut">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={manholeNetworkData} dataKey="count" nameKey="label" innerRadius={36} outerRadius={55} paddingAngle={2}>
                        {manholeNetworkData.map((entry) => <Cell key={entry.label} fill={entry.color} />)}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div><strong>{manholeNetworkRouteCount}</strong><span>links</span></div>
                </div>
                <ul>
                  <li><i style={{ background: "#16a34a" }} /><span>Verified connection</span><b>{manholeNetworkStatusCounts.good}</b></li>
                  <li><i style={{ background: "#eab308" }} /><span>Check flow / basis</span><b>{manholeNetworkStatusCounts.warning}</b></li>
                  <li><i style={{ background: "#dc2626" }} /><span>Needs attention</span><b>{manholeNetworkStatusCounts.critical}</b></li>
                  <li><i style={{ background: "#64748b" }} /><span>Not connected</span><b>{manholeNetworkStatusCounts.unconnected}</b></li>
                </ul>
              </div>
            </article>
            <article className="quick-map-dashboard__insights">
              <h3>Connection analysis</h3>
              <p>Actual route, elevation, and condition evidence for this Manhole Detail view</p>
              <ul>
                <li>{manholeNetworkFlowCount} of {manholeNetworkRouteCount} mapped connections have a confirmed downstream direction and show arrows.</li>
                <li>{manholeNetworkStatusCounts.good} connections are verified on surveyed sewage/drain geometry with confirmed flow.</li>
                <li>{manholeNetworkStatusCounts.warning} connections need verification because flow is unconfirmed or the route is road-assisted.</li>
                <li>{manholeNetworkStatusCounts.critical} connections require attention; {manholeNetworkStatusCounts.unconnected} manholes have no safe mapped connection.</li>
              </ul>
            </article>
          </div>
        ) : cardId === "drain-encroachment" && drainEncroachment ? (
          <div className="quick-map-dashboard__analysis-grid">
            <article className="quick-map-dashboard__chart-card">
              <h3>Most affected drain segments</h3>
              <p>Buildings whose footprints intersect each surveyed drain</p>
              <div className="quick-map-dashboard__chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={drainEncroachment.drains.filter((drain) => drain.affected_buildings > 0).slice(0, 8).map((drain) => ({
                      name: drain.fid ? `FID ${drain.fid}` : drain.drain_id.slice(0, 6),
                      buildings: drain.affected_buildings,
                    }))}
                    margin={{ top: 6, right: 8, bottom: 0, left: -22 }}
                  >
                    <CartesianGrid stroke="#27364a" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 9 }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
                    <Bar dataKey="buildings" name="Affected buildings" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="quick-map-dashboard__chart-card quick-map-dashboard__chart-card--donut">
              <h3>Encroachment severity</h3>
              <p>Classified from drain length inside each building footprint</p>
              <div className="quick-map-dashboard__donut-wrap">
                <div className="quick-map-dashboard__donut">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={[
                          { name: "Major crossing", value: drainEncroachment.major_crossings, color: "#ef4444" },
                          { name: "Partial clip", value: drainEncroachment.partial_clips, color: "#f59e0b" },
                        ]}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={36}
                        outerRadius={55}
                        paddingAngle={2}
                      >
                        <Cell fill="#ef4444" />
                        <Cell fill="#f59e0b" />
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div><strong>{drainEncroachment.affected_buildings}</strong><span>buildings</span></div>
                </div>
                <ul>
                  <li><i style={{ background: "#ef4444" }} /><span>Major crossing</span><b>{drainEncroachment.major_crossings}</b></li>
                  <li><i style={{ background: "#f59e0b" }} /><span>Partial clip</span><b>{drainEncroachment.partial_clips}</b></li>
                  <li><i style={{ background: "#22c55e" }} /><span>Clear drains</span><b>{drainEncroachment.clear_drains}</b></li>
                  <li><i style={{ background: "#38bdf8" }} /><span>Intersection pairs</span><b>{drainEncroachment.intersection_pairs}</b></li>
                </ul>
              </div>
            </article>

            <article className="quick-map-dashboard__insights">
              <h3>Actionable findings</h3>
              <p>Deterministic PostGIS intersections—not inferred conditions</p>
              <ul>
                <li>{drainEncroachment.affected_buildings} building footprints physically intersect the surveyed drain centerlines.</li>
                <li>{drainEncroachment.affected_drains} of {drainEncroachment.total_drains} drain segments are affected; {drainEncroachment.clear_drains} have no building crossing.</li>
                <li>{formatLength(drainEncroachment.crossing_length_m)} of drain geometry lies inside building footprints.</li>
                {drainEncroachment.drains[0] && <li>The worst segment ({drainEncroachment.drains[0].fid ? `FID ${drainEncroachment.drains[0].fid}` : drainEncroachment.drains[0].drain_id.slice(0, 8)}) intersects {drainEncroachment.drains[0].affected_buildings} buildings across {formatLength(drainEncroachment.drains[0].crossing_length_m)}.</li>}
              </ul>
            </article>
          </div>
        ) : cardId === "road-width" ? (
          <div className="quick-map-dashboard__analysis-grid">
            <article className="quick-map-dashboard__chart-card">
              <h3>Worst narrowed segments</h3>
              <p>Top flagged stretches ranked by % narrower than the local average</p>
              <div className="quick-map-dashboard__chart">
                {roadWidthTopSegments.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={roadWidthTopSegments} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                      <CartesianGrid stroke="#27364a" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 8 }} axisLine={false} tickLine={false} interval={0} />
                      <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 9 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(20,184,166,0.08)" }} formatter={(value: number) => [`${value}%`, "Narrowing"]} />
                      <Bar dataKey="drop_pct" name="Narrowing %" radius={[4, 4, 0, 0]}>
                        {roadWidthTopSegments.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="quick-map-dashboard__message">No narrowed segments found by the audit for this dataset.</p>
                )}
              </div>
            </article>

            <article className="quick-map-dashboard__chart-card quick-map-dashboard__chart-card--donut">
              <h3>Severity mix</h3>
              <p>Red / yellow / green narrowing findings on the cadastral map</p>
              <div className="quick-map-dashboard__donut-wrap">
                <div className="quick-map-dashboard__donut">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={roadWidthSeverity} dataKey="value" nameKey="label" innerRadius={36} outerRadius={55} paddingAngle={2}>
                        {roadWidthSeverity.map((entry) => <Cell key={entry.label} fill={entry.color} />)}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div><strong>{roadWidthAnomalies.length}</strong><span>flagged</span></div>
                </div>
                <ul>{roadWidthSeverity.map((entry) => <li key={entry.label}><i style={{ background: entry.color }} /><span>{entry.label}</span><b>{entry.value}</b></li>)}</ul>
              </div>
            </article>

            <article className="quick-map-dashboard__insights">
              <h3>Road width findings</h3>
              <p>Segments drawn in red/yellow on the cadastral map</p>
              <ul>
                <li>{roadWidthAnomalies.length} road segment{roadWidthAnomalies.length === 1 ? "" : "s"} narrowed below the local average carriageway width, spanning {formatLength(roadWidthAffectedM)} of road.</li>
                <li>{roadWidthSeverity.find((e) => e.label.startsWith("Red"))?.value ?? 0} need attention (red); {roadWidthSeverity.find((e) => e.label.startsWith("Yellow"))?.value ?? 0} flagged for review (yellow).</li>
                <li>{roadWidthAvgWidthM !== null ? `Average narrowed width is ${roadWidthAvgWidthM.toFixed(1)} m` : "No width recorded"}{roadWidthWorstDropPct !== null ? `; worst drop ${roadWidthWorstDropPct.toFixed(0)}% below the local average.` : ""}</li>
                <li>{roadWidthEdgeBuildings} narrowing edge{roadWidthEdgeBuildings === 1 ? "" : "s"} back onto a building, temple or structure footprint — the usual cause of the squeeze.</li>
                <li>Run the Spatial Audit if no narrowing has been detected for this survey.</li>
              </ul>
            </article>
          </div>
        ) : isRoadSurfaceIssue ? (
          <div className="quick-map-dashboard__analysis-grid">
            <article className="quick-map-dashboard__chart-card quick-map-dashboard__chart-card--issue-bars">
              <h3>Affected-site distribution</h3>
              <p>{roadSurfaceIssueData.locationBreakdown.length > 1 ? "Shows whether issues are clustered or spread across the ward" : "Grouped by road, location, chainage or FID"}</p>
              <div className="quick-map-dashboard__chart quick-map-dashboard__chart--horizontal">
                {roadSurfaceIssueData.issueGroupChart.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={roadSurfaceIssueData.issueGroupChart} layout="vertical" margin={{ top: 4, right: 18, bottom: 0, left: 2 }}>
                      <CartesianGrid stroke="#d8e3ef" strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" allowDecimals={false} tick={{ fill: "#7890aa", fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="name" width={68} tick={{ fill: "#64748b", fontSize: 8 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(20,184,166,0.08)" }} formatter={(value: number) => [`${value} issue${value === 1 ? "" : "s"}`, "Records"]} />
                      <Bar dataKey="count" name="Issues" radius={[0, 4, 4, 0]} barSize={13}>
                        {roadSurfaceIssueData.issueGroupChart.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="quick-map-dashboard__message">No matching issue records were found for this selection.</p>
                )}
              </div>
            </article>

            <article className="quick-map-dashboard__chart-card quick-map-dashboard__chart-card--signals">
              <h3>{cardId === "pothole-check" ? "Why potholes occur" : "Why water stands"}</h3>
              <p>{roadSurfaceIssueData.causeSummary}</p>
              <div className="quick-map-dashboard__signal-board">
                {roadSurfaceIssueData.causeSignals.map((signal) => (
                  <div className="quick-map-dashboard__signal" key={signal.label}>
                    <div>
                      <strong>{signal.label}</strong>
                      <span>{signal.note}</span>
                    </div>
                    <b>{signal.value}%</b>
                    <i><em style={{ width: `${signal.value}%`, background: signal.color }} /></i>
                  </div>
                ))}
                <div className="quick-map-dashboard__signal-summary">
                  <strong>{roadSurfaceIssueData.lowestElevation !== null ? `Level evidence present: ${roadSurfaceIssueData.lowestElevation.toFixed(2)} lowest` : "Level evidence missing"}</strong>
                  <span>{roadSurfaceIssueData.deepest !== null ? `Depth evidence present: ${roadSurfaceIssueData.deepest.toFixed(2)} m max` : cardId === "pothole-check" ? "Depth still needed for repair quantity" : "Water depth still needed for ponding severity"}</span>
                </div>
              </div>
            </article>

            <article className="quick-map-dashboard__insights quick-map-dashboard__insights--planner">
              <h3>How to resolve</h3>
              <p>{roadSurfaceIssueData.resolutionSummary}</p>
              <ul>
                {roadSurfaceIssueData.resolutionSteps.map((step) => <li key={step}>{step}</li>)}
                <li>{roadSurfaceIssueData.locationBreakdown[0] ? `Start at ${roadSurfaceIssueData.locationBreakdown[0].label}; it has ${roadSurfaceIssueData.locationBreakdown[0].count} mapped issue${roadSurfaceIssueData.locationBreakdown[0].count === 1 ? "" : "s"}.` : "No matched issue location is available for planning action."}</li>
              </ul>
            </article>
          </div>
        ) : cardId === "asset-catalog" ? (
          <div className="quick-map-dashboard__analysis-grid">
            <article className="quick-map-dashboard__chart-card">
              <h3>Category breakdown</h3>
              <p>{assetCatalogData.activeGroup === "all" ? "All mapped categories in the active survey" : `Categories within ${assetCatalogData.groups.find((g) => g.id === assetCatalogData.activeGroup)?.label ?? "this group"}`}</p>
              <div className="quick-map-dashboard__chart">
                {categoryStats.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={categoryStats.slice(0, 8)} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                      <CartesianGrid stroke="#27364a" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="category" tick={{ fill: "#94a3b8", fontSize: 8 }} axisLine={false} tickLine={false} interval={0} />
                      <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 9 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
                      <Bar dataKey="count" name="Records" radius={[4, 4, 0, 0]}>
                        {categoryStats.slice(0, 8).map((entry) => <Cell key={entry.category} fill={entry.color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="quick-map-dashboard__message">No categories in this selection.</p>
                )}
              </div>
            </article>

            <article className="quick-map-dashboard__chart-card quick-map-dashboard__chart-card--donut">
              <h3>Condition breakdown</h3>
              <p>Recorded condition / maintenance status across the selected assets</p>
              <div className="quick-map-dashboard__donut-wrap">
                <div className="quick-map-dashboard__donut">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={assetConditionBreakdown} dataKey="count" nameKey="label" innerRadius={36} outerRadius={55} paddingAngle={2}>
                        {assetConditionBreakdown.map((entry) => <Cell key={entry.label} fill={entry.color} />)}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div><strong>{dashboardFeatures.length}</strong><span>assets</span></div>
                </div>
                <ul>{assetConditionBreakdown.slice(0, 6).map((entry) => <li key={entry.label}><i style={{ background: entry.color }} /><span>{entry.label}</span><b>{entry.count}</b></li>)}</ul>
              </div>
            </article>

            <article className="quick-map-dashboard__insights">
              <h3>Asset findings</h3>
              <p>What the recorded condition data shows for this selection</p>
              <ul>
                <li>{dashboardFeatures.length.toLocaleString()} assets across {categoryStats.length} categories are shown for this selection.</li>
                <li>{assetCatalogInsights.recordedCount.toLocaleString()} assets have a recorded condition; {assetCatalogInsights.notRecordedCount.toLocaleString()} do not.</li>
                {assetCatalogInsights.topCondition ? (
                  <li>&quot;{assetCatalogInsights.topCondition.label}&quot; is the most common recorded condition, affecting {assetCatalogInsights.topCondition.count.toLocaleString()} assets.</li>
                ) : (
                  <li>No recorded condition values are available for this selection yet.</li>
                )}
                <li>{assetCatalogInsights.needsAttention.toLocaleString()} assets have a condition flagged as bad, blocked, damaged, poor or silted.</li>
              </ul>
            </article>
          </div>
        ) : data.right.length > 0 ? (
          <div className="quick-map-dashboard__analysis-grid">
            <article className="quick-map-dashboard__chart-card">
              <h3>{data.rightHeading}</h3>
              <p>Comparison from actual recorded survey values</p>
              <div className="quick-map-dashboard__chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.right.slice(0, 7)} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                    <CartesianGrid stroke="#27364a" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 8 }} axisLine={false} tickLine={false} interval={0} />
                    <YAxis allowDecimals={false} domain={[0, maxCount]} tick={{ fill: "#94a3b8", fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
                    <Bar dataKey="count" name="Records" radius={[4, 4, 0, 0]}>
                      {data.right.slice(0, 7).map((entry) => <Cell key={entry.label} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="quick-map-dashboard__chart-card quick-map-dashboard__chart-card--donut">
              <h3>Geometry coverage</h3>
              <p>Mapped feature types in this analysis</p>
              <div className="quick-map-dashboard__donut-wrap">
                <div className="quick-map-dashboard__donut">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={generalAnalytics.geometry} dataKey="value" nameKey="name" innerRadius={36} outerRadius={55} paddingAngle={2}>
                        {generalAnalytics.geometry.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div><strong>{dashboardFeatures.length}</strong><span>mapped</span></div>
                </div>
                <ul>{generalAnalytics.geometry.map((entry) => <li key={entry.name}><i style={{ background: entry.color }} /><span>{entry.name}</span><b>{entry.value}</b></li>)}</ul>
              </div>
            </article>

            <article className="quick-map-dashboard__insights">
              <h3>Data insights</h3>
              <p>What this survey snapshot shows</p>
              <ul>{generalAnalytics.insights.map((insight) => <li key={insight}>{insight}</li>)}</ul>
            </article>
          </div>
        ) : (
          <div className="quick-map-dashboard__empty"><p>{data.rightEmptyLabel ?? "No related records found"}</p></div>
        )}
      </section>
    </section>
  );
}
