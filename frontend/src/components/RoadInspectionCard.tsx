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
  pole_redundancy: "Pole issue",
  drain_encroachment: "Drain issue",
  manhole_status: "Manhole issue",
  road_width_narrowing: "Road width",
  powerline_proximity: "Powerline issue",
  pothole_status: "Pothole issue",
  standing_water_status: "Standing-water issue",
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
    return facts.drain_crosses_building
      ? `Drain crosses building footprint (${facts.crossing_ratio_pct ?? "?"}% span)`
      : "Drain partially clips a building footprint";
  }
  if (issue.anomaly_type === "powerline_proximity") {
    return `Building ${facts.nearest_powerline_distance_m ?? "?"}m from power line (threshold: ${facts.danger_threshold_m ?? "?"}m)`;
  }
  if (issue.anomaly_type === "pothole_status") {
    return `${facts.area_sqm ?? "?"} m² · ${facts.depth_cm ?? "depth unavailable"}${facts.depth_cm === null || facts.depth_cm === undefined ? "" : " cm deep"}`;
  }
  if (issue.anomaly_type === "standing_water_status") {
    return `${facts.area_sqm ?? "?"} m² affected · ${facts.intersects_road ? "on road" : "near road"}`;
  }
  return typeof facts.basis === "string" ? facts.basis : "Manhole condition needs review";
}

export function RoadInspectionCard({ roadLabel, report, loading, error, onClose, onSelectIssue }: Props) {
  const rawLabel = report?.road_label ?? roadLabel;
  const hasRoadLabel = Boolean(rawLabel && rawLabel.trim() && rawLabel.trim() !== "-");
  const title = hasRoadLabel ? rawLabel : report ? `Road ${report.road_id.slice(0, 8)}` : "Selected road";
  return (
    <aside className="road-inspection-card" data-testid="road-inspection-card">
      <header className="road-inspection-card__head">
        <div>
          <span className="road-inspection-card__eyebrow">Road inspection</span>
          <h3>{title}</h3>
          {report && <p>{report.road_length_m.toFixed(1)} m surveyed centerline · {report.issues.length} unresolved finding{report.issues.length === 1 ? "" : "s"}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close road inspection">x</button>
      </header>

      <div className="road-inspection-card__body">
        {loading && <div className="road-inspection-card__loading">Loading this road's audit findings...</div>}
        {error && <div className="road-inspection-card__error">{error}</div>}
        {report && !loading && (
          <>
            <div className="road-inspection-card__assets" aria-label="Roadside surveyed assets">
              <span><b>{report.assets.poles}</b> poles</span>
              <span><b>{report.assets.drains}</b> drains</span>
              <span><b>{report.assets.manholes}</b> manholes</span>
            </div>
            <p className="road-inspection-card__scope">
              Unresolved findings assigned to this road within {report.roadside_corridor_m} m.
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
            <UrbanPlanningSolutionPanel
              featureId={report.road_id}
              contextLabel="Road Inspection"
              placeholder="Describe your proposed road repair, resurfacing, drainage, safety, or traffic-management solution…"
            />
          </>
        )}
      </div>
    </aside>
  );
}
