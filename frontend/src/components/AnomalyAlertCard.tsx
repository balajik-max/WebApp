import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { urbanPlanningSolution, type AiAnswer } from "../lib/ai";
import { useAuth } from "../context/AuthContext";
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
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [explanation, setExplanation] = useState<string | null>(anomaly.explanation_text);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [solutionOpen, setSolutionOpen] = useState(false);
  const [solutionText, setSolutionText] = useState("");
  const [solutionFiles, setSolutionFiles] = useState<File[]>([]);
  const [solutionGenerating, setSolutionGenerating] = useState(false);
  const [solutionResult, setSolutionResult] = useState<AiAnswer | null>(null);
  const [solutionError, setSolutionError] = useState<string | null>(null);

  const handleSolutionFilesChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    setSolutionFiles((prev) => [...prev, ...selected]);
  }, []);

  const removeSolutionFile = useCallback((index: number) => {
    setSolutionFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  async function generateSolution() {
    const featureId = anomaly.feature_ids[0];
    if (!featureId || (!solutionText.trim() && solutionFiles.length === 0)) return;
    setSolutionGenerating(true);
    setSolutionError(null);
    setSolutionResult(null);
    try {
      const result = await urbanPlanningSolution(featureId, solutionText, solutionFiles);
      setSolutionResult(result);
    } catch (reason) {
      if (reason instanceof ApiError && typeof reason.body === "object" && reason.body) {
        const detail = (reason.body as { detail?: unknown }).detail;
        setSolutionError(typeof detail === "string" ? detail : reason.message);
      } else {
        setSolutionError(reason instanceof Error ? reason.message : "Unexpected error");
      }
    } finally {
      setSolutionGenerating(false);
    }
  }

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

        <button type="button" className="anomaly-card__toggle-solution" onClick={() => setSolutionOpen((o) => !o)}>
          {solutionOpen ? "−" : "+"} Urban Planning Solution
        </button>

        {solutionOpen && (
          <div className="anomaly-card__solution">
            <textarea
              className="anomaly-card__solution-input"
              value={solutionText}
              onChange={(e) => setSolutionText(e.target.value)}
              maxLength={50000}
              rows={3}
              placeholder="Describe your proposed solution for this manhole issue…"
            />
            <div className="anomaly-card__solution-upload">
              <label className="anomaly-card__solution-file-label">
                <span>Upload files</span>
                <input type="file" accept=".txt,.pdf,.docx" multiple onChange={handleSolutionFilesChange} />
              </label>
              {solutionFiles.length > 0 && (
                <ul className="anomaly-card__solution-file-list">
                  {solutionFiles.map((f, i) => (
                    <li key={i}>
                      <small>{f.name}</small>
                      <button type="button" className="anomaly-card__solution-file-remove" onClick={() => removeSolutionFile(i)}>×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              className="anomaly-card__solution-generate"
              onClick={generateSolution}
              disabled={solutionGenerating || (!solutionText.trim() && solutionFiles.length === 0)}
            >
              {solutionGenerating ? "Generating…" : "Generate AI Explanation"}
            </button>
            {solutionError && <div className="anomaly-card__error">{solutionError}</div>}
            {solutionGenerating && <div className="anomaly-card__loading">AI is analyzing your solution…</div>}
            {solutionResult && (
              <div className="anomaly-card__solution-result">
                <div className="anomaly-card__solution-result-head">
                  <strong>AI Generated Explanation</strong>
                  <small>{solutionResult.model}</small>
                </div>
                <div className="anomaly-card__solution-result-body">
                  {solutionResult.answer_markdown.split("\n").map((line, i) => {
                    if (line.startsWith("## ")) return <h5 key={i} style={{ margin: "8px 0 3px" }}>{line.slice(3)}</h5>;
                    if (line.startsWith("### ")) return <h6 key={i} style={{ margin: "6px 0 2px" }}>{line.slice(4)}</h6>;
                    if (line.match(/^- /)) return <li key={i} style={{ marginLeft: 12 }}>{line.slice(2)}</li>;
                    if (line.match(/^\d+\. /)) return <li key={i} style={{ marginLeft: 12 }}>{line}</li>;
                    if (line.trim() === "") return <br key={i} />;
                    return <p key={i} style={{ margin: "2px 0", lineHeight: 1.4 }}>{line}</p>;
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="anomaly-card__actions">
        {anomaly.status !== "reviewing" && anomaly.status !== "resolved" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "reviewing")}>Mark Reviewing</button>
        )}
        {isAdmin && anomaly.status !== "dismissed" && anomaly.status !== "resolved" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "dismissed")}>Dismiss</button>
        )}
        <span className="anomaly-card__workflow-note">Resolved status is applied only after Architect evidence and Admin approval.</span>
      </footer>
    </aside>
  );
}
