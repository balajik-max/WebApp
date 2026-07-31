import type { RoadInspection, SpatialAnomaly } from "../lib/workflow";
import { UrbanPlanningSolutionPanel } from "./UrbanPlanningSolutionPanel";

interface Props {
  roadLabel: string | null;
  report: RoadInspection | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelectIssue: (issueId: string) => void;
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
    return facts.drain_crosses_building
      ? `Drain crosses building footprint (${facts.crossing_ratio_pct ?? "?"}% span)`
      : "Drain partially clips a building footprint";
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

export function RoadInspectionCard({ roadLabel, report, loading, error, onClose, onSelectIssue }: Props) {
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
                  return (
                    <div
                      key={metric.key}
                      className={`road-inspection-card__asset${count === 0 ? " road-inspection-card__asset--empty" : ""}`}
                    >
                      <b>{count}</b>
                      <span>{metric.label}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="road-inspection-card__section" aria-label="Active audit findings">
              <div className="road-inspection-card__section-head">
                <span>Active findings</span>
                <small>{issueCounts.red} critical, {issueCounts.yellow} review</small>
              </div>
              <p className="road-inspection-card__scope">
                Unresolved findings assigned to this road within {report.roadside_corridor_m} m of the surveyed centerline.
              </p>
              {report.issues.length === 0 ? (
                <div className="road-inspection-card__empty">
                  No unresolved red or review findings on this road. Run Spatial Audit if this road has not been audited yet.
                </div>
              ) : (
                <div className="road-inspection-card__issues">
                  {report.issues.map((issue) => (
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
