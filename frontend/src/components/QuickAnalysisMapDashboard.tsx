import { useEffect, useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { UrbanFeature } from "../lib/types";
import { colorForCategory } from "../lib/categoryColors";
import { fetchManholeReadiness, type DrainEncroachmentReport, type ManholeReadinessReport } from "../lib/workflow";
import { computeDashboardData, type LegendEntry } from "../lib/quickAnalysisStats";

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
  selectedFeature: UrbanFeature | null;
  selectedConnection: ManholeConnectionDetail | null;
  activeTool: QuickAnalysisTool;
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
  selectedFeature, selectedConnection, activeTool, onActivateMeasure,
  onClearSelectedFeature, onClearSelectedConnection, onClose,
}: QuickAnalysisMapDashboardProps) {
  const [readiness, setReadiness] = useState<ManholeReadinessReport | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const isDrainAnalysis = cardId === "drain-encroachment";
  const dashboardFeatures = useMemo(
    () => cardId === "manhole-detail"
      ? features.filter((feature) => feature.properties.category?.trim().toLowerCase() === "manhole")
      : features,
    [cardId, features]
  );
  const categoryStats = useMemo(() => categoryBreakdown(dashboardFeatures), [dashboardFeatures]);

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
    return computeDashboardData(cardId, {
      loadedFeatures: dashboardFeatures,
      categoryStats,
      anomalies: [],
      activeDatasetIds: datasetIds,
      readiness,
    });
  }, [cardId, categoryStats, dashboardFeatures, datasetIds, drainEncroachment, readiness]);

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
    : `${displayedFeatureCount.toLocaleString()} mapped features shown`;
  const selectedLength = selectedFeature ? featureLengthMeters(selectedFeature) : 0;
  const selectedIsDrain = selectedFeature?.properties.canonical_class === "Drainage_Asset";
  const selectedIsManhole = selectedFeature?.properties.canonical_class === "Access_Point";
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
  const selectedRoad = selectedFeature ? firstRecorded(selectedFeature, ["Road_Name", "Name"]) : undefined;
  const selectedFid = selectedFeature ? firstRecorded(selectedFeature, ["FID"]) : undefined;
  const selectedAttributes = selectedFeature
    ? Object.entries(selectedFeature.properties.attributes ?? {})
        .filter(([key, value]) => !key.startsWith("_") && recordedValue(value))
        .slice(0, 5)
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
              {!selectedIsDrain && !selectedIsManhole && <div><dt>Source layer</dt><dd>{displayValue(firstRecorded(selectedFeature, ["gdb_layer", "LAYER"]))}</dd></div>}
              {!selectedIsDrain && !selectedIsManhole && <div><dt>Geometry</dt><dd>{selectedFeature.geometry.type}</dd></div>}
              {!selectedIsDrain && !selectedIsManhole && selectedAttributes.map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{displayValue(value)}</dd></div>)}
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
              <h3>Connection condition</h3>
              <p>Each mapped line is classified from its verified connection and flow evidence</p>
              <div className="quick-map-dashboard__chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={manholeNetworkData} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                    <CartesianGrid stroke="#27364a" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 9 }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
                    <Bar dataKey="count" name="Connections" radius={[4, 4, 0, 0]}>
                      {manholeNetworkData.map((entry) => <Cell key={entry.label} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
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
