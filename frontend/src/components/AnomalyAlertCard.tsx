import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { explainAnomaly, type AnomalyStatus, type SpatialAnomaly } from "../lib/workflow";

interface Props {
  anomaly: SpatialAnomaly;
  onClose: () => void;
  onStatusChange: (anomalyId: string, next: AnomalyStatus) => void;
  /** A newer audit run replaced this finding server-side (its id no longer
   * exists) — remove it from the map/local state instead of showing a raw
   * fetch error, since re-running the audit is a normal, expected action. */
  onStale: (anomalyId: string) => void;
}

const TYPE_LABEL: Record<SpatialAnomaly["anomaly_type"], string> = {
  pole_redundancy: "Pole Redundancy",
  drain_encroachment: "Drain Encroachment",
  manhole_status: "Manhole Status",
  road_width_narrowing: "Road Width Narrowing",
};

const COLOR_LABEL: Record<SpatialAnomaly["color"], string> = {
  red: "Critical",
  yellow: "Review",
  green: "Confirmed OK",
};

/** Facts worth surfacing verbatim next to the AI narration — the same
 * numbers the LLM was given, shown as data so this is never a black box. */
function metadataEntries(metadata: Record<string, unknown>): [string, string][] {
  const skip = new Set([
    "this_feature_id", "kept_feature_id", "building_id", "manhole_id", "nearest_drain_id", "drain_ids",
    "centerline_feature_id", "left_edge_feature_id", "right_edge_feature_id",
    "affected_line_wkt", "sample_interval_m", "probe_length_m",
  ]);
  return Object.entries(metadata)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => [
      k.replace(/_/g, " "),
      Array.isArray(v) ? v.join(", ") : String(v),
    ]);
}

export function AnomalyAlertCard({ anomaly, onClose, onStatusChange, onStale }: Props) {
  const [explanation, setExplanation] = useState<string | null>(anomaly.explanation_text);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setExplanation(anomaly.explanation_text);
    setError(null);
    if (anomaly.explanation_text) return;
    const ctrl = new AbortController();
    setLoading(true);
    explainAnomaly(anomaly.id, ctrl.signal)
      .then((r) => setExplanation(r.explanation_text))
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        if (e instanceof ApiError && e.status === 404) {
          onStale(anomaly.id);
          return;
        }
        setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [anomaly.id, anomaly.explanation_text, onStale]);

  return (
    <aside className="anomaly-card" data-testid="anomaly-alert-card">
      <header className="anomaly-card__head">
        <div>
          <span className={`anomaly-card__badge anomaly-card__badge--${anomaly.color}`}>
            {COLOR_LABEL[anomaly.color]}
          </span>
          <h3 className="anomaly-card__title">{TYPE_LABEL[anomaly.anomaly_type]}</h3>
        </div>
        <button type="button" className="anomaly-card__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="anomaly-card__body">
        {loading && <div className="anomaly-card__loading">Generating explanation…</div>}
        {error && <div className="anomaly-card__error">{error}</div>}
        {explanation && <p className="anomaly-card__explanation">{explanation}</p>}

        <div className="anomaly-card__facts">
          {metadataEntries(anomaly.anomaly_metadata).map(([k, v]) => (
            <div className="anomaly-card__fact" key={k}>
              <span className="anomaly-card__fact-key">{k}</span>
              <span className="anomaly-card__fact-value">{v}</span>
            </div>
          ))}
        </div>
      </div>

      <footer className="anomaly-card__actions">
        {anomaly.status !== "reviewing" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "reviewing")}>Mark Reviewing</button>
        )}
        {anomaly.status !== "resolved" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "resolved")}>Mark Resolved</button>
        )}
        {anomaly.status !== "dismissed" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "dismissed")}>Dismiss</button>
        )}
      </footer>
    </aside>
  );
}
