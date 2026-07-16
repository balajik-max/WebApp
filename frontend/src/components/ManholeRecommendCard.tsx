import ReactMarkdown from "react-markdown";
import type { AiAnswer } from "../lib/ai";

interface Props {
  answer: AiAnswer | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onView3D?: () => void;
}

const PROBLEM_LABEL: Record<string, string> = {
  blocked: "Blocked",
  bad_condition: "Bad Condition",
  disconnected: "Disconnected",
  ok: "No Issue",
};

function fmtCoord(lon: number, lat: number): string {
  return `${lon.toFixed(6)}, ${lat.toFixed(6)}`;
}

/** Build a GeoJSON FeatureCollection of the recommended pipe routes (as
 * LineStrings) and the proposed new manhole locations (as Points) so the
 * result can be exported for CAD/GIS use. */
function toGeoJSON(answer: AiAnswer): string {
  const features: unknown[] = [];
  for (const r of answer.routes) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: r.coordinates },
      properties: {
        kind: "recommended_pipe",
        from_id: r.from_id,
        to_id: r.to_id,
        material: r.pipe_spec.material,
        diameter_mm: r.pipe_spec.diameter_mm,
        from_rl: r.pipe_spec.from_rl,
        to_rl: r.pipe_spec.to_rl,
        slope: r.pipe_spec.slope,
      },
    });
  }
  for (const loc of answer.needed_locations ?? []) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [loc.lon, loc.lat] },
      properties: { kind: "proposed_manhole", id: loc.id, reason: loc.reason },
    });
  }
  return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
}

/** Same visual language as AnomalyAlertCard (reuses its CSS classes) — this
 * is the manhole-recommend engine's counterpart: instead of narrating an
 * already-detected SpatialAnomaly, it narrates a manhole-recommend AiAnswer
 * (real facts + a road-routed pipe route + pipe spec), computed fresh on
 * click rather than pre-persisted by a background audit run. */
export function ManholeRecommendCard({ answer, loading, error, onClose, onView3D }: Props) {
  const problemType = (answer?.debug?.problem_type as string | undefined) ?? null;
  const dbg = (answer?.debug ?? {}) as Record<string, unknown>;
  const isArea = "bad" in dbg || "disconnected" in dbg || "gaps" in dbg;

  const handleExport = () => {
    if (!answer) return;
    const blob = new Blob([toGeoJSON(answer)], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "manhole_recommendation.geojson";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="anomaly-card" data-testid="manhole-recommend-card">
      <header className="anomaly-card__head">
        <div>
          {problemType && (
            <span className={`anomaly-card__badge anomaly-card__badge--${problemType === "ok" ? "green" : "red"}`}>
              {PROBLEM_LABEL[problemType] ?? problemType}
            </span>
          )}
          <h3 className="anomaly-card__title">AI Manhole Recommendation</h3>
        </div>
        <button type="button" className="anomaly-card__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="anomaly-card__body">
        {loading && <div className="anomaly-card__loading">Analyzing manhole and drain network…</div>}
        {error && <div className="anomaly-card__error">{error}</div>}
        {answer && (
          <>
            {isArea && (
              <div className="anomaly-card__summary">
                <span><b>{(dbg.bad as number) ?? 0}</b> need rehab</span>
                <span><b>{(dbg.disconnected as number) ?? 0}</b> disconnected</span>
                <span><b>{(dbg.gaps as number) ?? 0}</b> coverage gaps</span>
                <span><b>{answer.routes.length}</b> pipe routes</span>
              </div>
            )}
            <p className="anomaly-card__explanation">
              <ReactMarkdown>{answer.answer_markdown}</ReactMarkdown>
            </p>
            {answer.routes.length > 0 && (
              <>
                <button type="button" className="anomaly-card__export" onClick={handleExport}>
                  Export {answer.routes.length} routes + {(answer.needed_locations ?? []).length} points (GeoJSON)
                </button>
                {onView3D && (
                  <button type="button" className="anomaly-card__export" onClick={onView3D}>
                    View subsurface in 3D
                  </button>
                )}
                <div className="anomaly-card__facts">
                  {answer.routes.map((route, idx) => {
                    const start = route.coordinates[0];
                    const end = route.coordinates[route.coordinates.length - 1];
                    return (
                      <div key={idx} className="anomaly-card__route">
                        <div className="anomaly-card__fact">
                          <span className="anomaly-card__fact-key">manhole</span>
                          <span className="anomaly-card__fact-value">{route.from_id}</span>
                        </div>
                        <div className="anomaly-card__fact">
                          <span className="anomaly-card__fact-key">from</span>
                          <span className="anomaly-card__fact-value">{fmtCoord(start[0], start[1])}</span>
                        </div>
                        <div className="anomaly-card__fact">
                          <span className="anomaly-card__fact-key">to</span>
                          <span className="anomaly-card__fact-value">{fmtCoord(end[0], end[1])}</span>
                        </div>
                        <div className="anomaly-card__fact">
                          <span className="anomaly-card__fact-key">material</span>
                          <span className="anomaly-card__fact-value">{route.pipe_spec.material}</span>
                        </div>
                        <div className="anomaly-card__fact">
                          <span className="anomaly-card__fact-key">diameter mm</span>
                          <span className="anomaly-card__fact-value">{route.pipe_spec.diameter_mm}</span>
                        </div>
                        {route.pipe_spec.from_rl !== null && (
                          <div className="anomaly-card__fact">
                            <span className="anomaly-card__fact-key">from rl</span>
                            <span className="anomaly-card__fact-value">{route.pipe_spec.from_rl}</span>
                          </div>
                        )}
                        {route.pipe_spec.to_rl !== null && (
                          <div className="anomaly-card__fact">
                            <span className="anomaly-card__fact-key">to rl</span>
                            <span className="anomaly-card__fact-value">{route.pipe_spec.to_rl}</span>
                          </div>
                        )}
                        {route.pipe_spec.slope !== null && (
                          <div className="anomaly-card__fact">
                            <span className="anomaly-card__fact-key">slope</span>
                            <span className="anomaly-card__fact-value">{route.pipe_spec.slope}</span>
                          </div>
                        )}
                        {route.elevation_source && (
                          <div className="anomaly-card__fact">
                            <span className="anomaly-card__fact-key">elevation source</span>
                            <span className="anomaly-card__fact-value">{route.elevation_source}</span>
                          </div>
                        )}
                        {route.flow_confirmed !== null && route.flow_confirmed !== undefined && (
                          <div className="anomaly-card__fact">
                            <span className="anomaly-card__fact-key">flow direction</span>
                            <span className="anomaly-card__fact-value">
                              {route.flow_confirmed ? "confirmed (real elevation)" : "not confirmed — no elevation evidence"}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {!answer.grounded && (
              <div className="anomaly-card__error">Not enough surveyed data to answer.</div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
