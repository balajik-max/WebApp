import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { explainRoad, type RoadInspection, type SpatialAnomaly } from "../lib/workflow";
import { useTypewriter } from "../lib/useTypewriter";
import { ApiError } from "../lib/api";
import { UrbanPlanningSolutionPanel } from "./UrbanPlanningSolutionPanel";

interface Props {
  roadLabel: string | null;
  report: RoadInspection | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelectIssue: (issueId: string) => void;
  /** Lifted to the map so a selected category filters the canvas layers too,
   * not just this list â€” a purely-local filter here only ever affected text. */
  categoryFilter: keyof RoadInspection["assets"] | null;
  onCategoryFilterChange: (key: keyof RoadInspection["assets"] | null) => void;
}

const ISSUE_LABEL: Record<SpatialAnomaly["anomaly_type"], string> = {
  pole_redundancy: "Pole redundancy",
  drain_encroachment: "Drain encroachment",
  manhole_status: "Manhole status",
  road_width_narrowing: "Road width",
  powerline_proximity: "Powerline clearance",
  pothole_status: "Pothole",
  standing_water_status: "Standing water",
};

const ASSET_METRICS: Array<{ key: keyof RoadInspection["assets"]; label: string }> = [
  { key: "poles", label: "Poles" },
  { key: "drains", label: "Drains" },
  { key: "manholes", label: "Manholes" },
  { key: "potholes", label: "Potholes" },
  { key: "standing_water", label: "Standing water" },
  { key: "power_lines", label: "Power lines" },
  { key: "utility_poles", label: "Utility poles" },
];

// Which finding types belong to each coverage tile — clicking a tile filters
// Active findings down to just these. Utility poles have no detector yet,
// so that tile has nothing to filter to and stays non-interactive.
const ASSET_TO_ISSUE_TYPES: Partial<Record<keyof RoadInspection["assets"], SpatialAnomaly["anomaly_type"][]>> = {
  poles: ["pole_redundancy"],
  drains: ["drain_encroachment"],
  manholes: ["manhole_status"],
  potholes: ["pothole_status"],
  standing_water: ["standing_water_status"],
  power_lines: ["powerline_proximity"],
};

// Same tile -> canonical_class the backend counts assets by (road_inspection.py's
// ROAD_INSPECTION_ASSET_KEY_BY_CLASS, inverted) â€” lets the map filter its
// layers to the same category the findings list is filtered to.
export const ASSET_KEY_TO_CANONICAL_CLASS: Record<keyof RoadInspection["assets"], string> = {
  poles: "Illumination_Asset",
  drains: "Drainage_Asset",
  manholes: "Access_Point",
  potholes: "Pothole",
  standing_water: "Standing_Water",
  power_lines: "Power_Line",
  utility_poles: "Utility_Pole",
};

function issueDetail(issue: SpatialAnomaly): string {
  const facts = issue.anomaly_metadata;
  if (issue.anomaly_type === "road_width_narrowing") {
    return `${facts.width_m ?? "?"} m wide, ${facts.drop_pct ?? "?"}% below local average`;
  }
  if (issue.anomaly_type === "pole_redundancy") {
    return issue.color === "red"
      ? `Redundant pole in a cluster of ${facts.cluster_size ?? "?"}`
      : `Pole spacing needs review: ${facts.nearest_neighbor_m ?? "?"} m to nearest`;
  }
  if (issue.anomaly_type === "drain_encroachment") {
    if (facts.drain_crosses_building) {
      return `Drain crosses building footprint (${facts.crossing_ratio_pct ?? "?"}% span)`;
    }
    if (facts.near_miss_gap_m !== null && facts.near_miss_gap_m !== undefined) {
      return `Building sits ${(Number(facts.near_miss_gap_m) * 100).toFixed(1)} cm from a drain, effectively touching`;
    }
    return "Drain partially clips a building footprint";
  }
  if (issue.anomaly_type === "powerline_proximity") {
    return `Building ${facts.nearest_powerline_distance_m ?? "?"}m from power line (threshold: ${facts.danger_threshold_m ?? "?"}m)`;
  }
  if (issue.anomaly_type === "pothole_status") {
    return `${facts.area_sqm ?? "?"} m2, ${facts.depth_cm ?? "depth unavailable"}${facts.depth_cm === null || facts.depth_cm === undefined ? "" : " cm deep"}`;
  }
  if (issue.anomaly_type === "standing_water_status") {
    return `${facts.area_sqm ?? "?"} m2 affected, ${facts.intersects_road ? "on road" : "near road"}`;
  }
  return typeof facts.basis === "string" ? facts.basis : "Manhole condition needs review";
}

function formatMaterial(category: string): string {
  return category.replace(/_/g, " ");
}

export function RoadInspectionCard({
  roadLabel,
  report,
  loading,
  error,
  onClose,
  onSelectIssue,
  categoryFilter,
  onCategoryFilterChange,
}: Props) {
  const roadId = report?.road_id ?? null;
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  const typedSummary = useTypewriter(aiSummary ?? "");

  useEffect(() => {
    setAiSummary(null);
    setAiError(null);
    setAiLoading(false);
    aiAbortRef.current?.abort();
  }, [roadId]);

  useEffect(() => () => aiAbortRef.current?.abort(), []);

  const handleGenerateSummary = () => {
    if (!roadId || aiLoading) return;
    const ctrl = new AbortController();
    aiAbortRef.current = ctrl;
    setAiLoading(true);
    setAiError(null);
    explainRoad(roadId, ctrl.signal)
      .then((r) => setAiSummary(r.explanation_text))
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setAiError(e instanceof ApiError ? `Unable to generate road summary (${e.status})` : e.message);
      })
      .finally(() => setAiLoading(false));
  };

  const rawLabel = report?.road_label ?? roadLabel;
  const hasRoadLabel = Boolean(rawLabel && rawLabel.trim() && rawLabel.trim() !== "-");
  const title = hasRoadLabel ? rawLabel : report ? `Road ${report.road_id.slice(0, 8)}` : "Selected road";
  const assetTotal = report
    ? ASSET_METRICS.reduce((sum, metric) => sum + report.assets[metric.key], 0)
    : 0;
  const populatedClasses = report
    ? ASSET_METRICS.filter((metric) => report.assets[metric.key] > 0).length
    : 0;
  const issueCounts = report
    ? report.issues.reduce(
        (counts, issue) => {
          counts[issue.color] += 1;
          return counts;
        },
        { red: 0, yellow: 0, green: 0 },
      )
    : { red: 0, yellow: 0, green: 0 };
  const filterTypes = categoryFilter ? ASSET_TO_ISSUE_TYPES[categoryFilter] : null;
  const filteredIssues = report
    ? filterTypes
      ? report.issues.filter((issue) => filterTypes.includes(issue.anomaly_type))
      : report.issues
    : [];
  return (
    <aside className="road-inspection-card" data-testid="road-inspection-card">
      <header className="road-inspection-card__head">
        <div>
          <span className="road-inspection-card__eyebrow">Road inspection</span>
          <h3>{title}</h3>
          {report && <p>{report.road_length_m.toFixed(1)} m surveyed centerline, {report.issues.length} unresolved finding{report.issues.length === 1 ? "" : "s"}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close road inspection">x</button>
      </header>

      <div className="road-inspection-card__body">
        {loading && <div className="road-inspection-card__loading">Loading this road's audit findings...</div>}
        {error && <div className="road-inspection-card__error">{error}</div>}
        {report && !loading && (
          <>
            <div className="road-inspection-card__summary" aria-label="Road inspection summary">
              <div className="road-inspection-card__stat">
                <b>{assetTotal}</b>
                <span>surveyed assets</span>
              </div>
              <div className="road-inspection-card__stat">
                <b>{issueCounts.red}</b>
                <span>critical findings</span>
              </div>
              <div className="road-inspection-card__stat">
                <b>{issueCounts.yellow}</b>
                <span>review findings</span>
              </div>
            </div>

            <section className="road-inspection-card__section" aria-label="Surveyed road coverage">
              <div className="road-inspection-card__section-head">
                <span>Surveyed coverage</span>
                <small>{populatedClasses} populated classes</small>
              </div>
              <div className="road-inspection-card__assets">
                {ASSET_METRICS.map((metric) => {
                  const count = report.assets[metric.key];
                  const clickable = count > 0 && Boolean(ASSET_TO_ISSUE_TYPES[metric.key]);
                  const active = categoryFilter === metric.key;
                  return (
                    <button
                      type="button"
                      key={metric.key}
                      disabled={!clickable}
                      title={clickable ? `Show only ${metric.label} findings` : undefined}
                      onClick={() => clickable && onCategoryFilterChange(categoryFilter === metric.key ? null : metric.key)}
                      className={
                        "road-inspection-card__asset"
                        + (count === 0 ? " road-inspection-card__asset--empty" : "")
                        + (clickable ? " road-inspection-card__asset--clickable" : "")
                        + (active ? " road-inspection-card__asset--active" : "")
                      }
                    >
                      <b>{count}</b>
                      <span>{metric.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {report.road_profile && (
              <section className="road-inspection-card__section" aria-label="Road surface profile">
                <div className="road-inspection-card__section-head">
                  <span>Road surface profile</span>
                  <small>{report.road_profile.stations_with_width}/{report.road_profile.stations_sampled} stations sampled</small>
                </div>
                <div className="road-inspection-card__profile">
                  <div className="road-inspection-card__profile-stat">
                    <b>{report.road_profile.dominant_edge_material ? formatMaterial(report.road_profile.dominant_edge_material) : "Unknown"}</b>
                    <span>{report.road_profile.edge_material_consistent ? "consistent both edges" : "mixed edge material"}</span>
                  </div>
                  <div className="road-inspection-card__profile-stat">
                    <b>{report.road_profile.min_width_m ?? "?"} m</b>
                    <span>narrowest sampled width</span>
                  </div>
                  <div className="road-inspection-card__profile-stat">
                    <b>{report.road_profile.mean_width_m ?? "?"} m</b>
                    <span>mean carriageway width</span>
                  </div>
                </div>
                {report.pothole_cost_total_inr !== null && (
                  <p className="road-inspection-card__scope">
                    Estimated pothole repair cost on this road: <b>&#8377;{report.pothole_cost_total_inr.toFixed(2)}</b>
                  </p>
                )}
              </section>
            )}

            {report.drainage_profile && (
              <section className="road-inspection-card__section" aria-label="Drainage condition">
                <div className="road-inspection-card__section-head">
                  <span>Drainage condition</span>
                  <small>{report.drainage_profile.manholes_with_level} manholes with surveyed levels</small>
                </div>
                {Object.keys(report.drainage_profile.condition_counts).length > 0 && (
                  <div className="road-inspection-card__condition-chips">
                    {Object.entries(report.drainage_profile.condition_counts).map(([condition, count]) => (
                      <span
                        key={condition}
                        className={`road-inspection-card__condition-chip road-inspection-card__condition-chip--${condition.toLowerCase()}`}
                      >
                        {count} {condition}
                      </span>
                    ))}
                  </div>
                )}
                {report.drainage_profile.net_fall_m !== null && (
                  <p
                    className={
                      report.drainage_profile.reversed_segments > 0
                        ? "road-inspection-card__warning"
                        : "road-inspection-card__scope"
                    }
                  >
                    Surveyed invert level {report.drainage_profile.net_fall_m > 0 ? "falls" : "rises"}{" "}
                    {Math.abs(report.drainage_profile.net_fall_m).toFixed(2)} m across this road.{" "}
                    {report.drainage_profile.reversed_segments > 0
                      ? `${report.drainage_profile.reversed_segments} segment(s) run against that direction — possible blockage/backflow risk, worth a jetting or re-survey check.`
                      : "No reversed segments — gradient is consistent."}
                  </p>
                )}
              </section>
            )}

            <section className="road-inspection-card__section" aria-label="Active audit findings">
              <div className="road-inspection-card__section-head">
                <span>Active findings</span>
                <small>{issueCounts.red} critical, {issueCounts.yellow} review overall</small>
              </div>
              {report.issues.length === 0 ? (
                <div className="road-inspection-card__empty">
                  No unresolved red or review findings on this road. Run Spatial Audit if this road has not been audited yet.
                </div>
              ) : !categoryFilter ? (
                <div className="road-inspection-card__empty">
                  Select a populated category above to see its findings here.
                </div>
              ) : (
                <>
                  <p className="road-inspection-card__scope">
                    Showing <b>{ASSET_METRICS.find((m) => m.key === categoryFilter)?.label}</b> findings within {report.roadside_corridor_m} m of the surveyed centerline.{" "}
                    <button type="button" className="road-inspection-card__clear-filter" onClick={() => onCategoryFilterChange(null)}>
                      Clear
                    </button>
                  </p>
                  {filteredIssues.length === 0 ? (
                    <div className="road-inspection-card__empty">No unresolved findings in this category.</div>
                  ) : (
                    <div className="road-inspection-card__issues">
                      {filteredIssues.map((issue) => (
                        <button
                          type="button"
                          key={issue.id}
                          className={`road-inspection-card__issue road-inspection-card__issue--${issue.color}`}
                          onClick={() => onSelectIssue(issue.id)}
                          title="Open full audit finding"
                        >
                          <span className="road-inspection-card__issue-top">
                            <b>{ISSUE_LABEL[issue.anomaly_type]}</b>
                            <em>{issue.color === "red" ? "Critical" : "Review"}</em>
                          </span>
                          <span>{issueDetail(issue)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>

            <section className="road-inspection-card__section" aria-label="AI road summary">
              <div className="road-inspection-card__section-head">
                <span>AI road summary</span>
              </div>
              {!aiSummary && !aiLoading && (
                <button type="button" className="road-inspection-card__generate" onClick={handleGenerateSummary}>
                  Generate road summary
                </button>
              )}
              {aiLoading && <div className="road-inspection-card__loading">Reading this road's full survey and findings...</div>}
              {aiError && <div className="road-inspection-card__error">{aiError}</div>}
              {aiSummary && (
                <div className="road-inspection-card__ai-summary">
                  <ReactMarkdown>{typedSummary}</ReactMarkdown>
                </div>
              )}
            </section>

            <UrbanPlanningSolutionPanel
              featureId={report.road_id}
              contextLabel="Road Inspection"
              placeholder="Describe your proposed road repair, resurfacing, drainage, safety, or traffic-management solution..."
            />
          </>
        )}
      </div>
    </aside>
  );
}
