import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { aiReport, type AiAnswer } from "../lib/ai";
import type { DatasetRow } from "../lib/workflow";

interface Props {
  datasets: DatasetRow[];
  onClose: () => void;
}

/** Picks the scope for the report: prefer the ward of the first selected
 * dataset that has one (several datasets over the same neighbourhood
 * usually share a ward), otherwise fall back to that single dataset. */
function reportScope(datasets: DatasetRow[]): { ward?: string; dataset_id?: string; label: string; wardName?: string } | null {
  if (datasets.length === 0) return null;
  const withWard = datasets.find((d) => d.ward);
  if (withWard?.ward) return { ward: withWard.ward, label: `Ward ${withWard.ward}`, wardName: withWard.ward };
  const first = datasets[0];
  return { dataset_id: first.id, label: first.name };
}

export function WardReportPanel({ datasets, onClose }: Props) {
  const [report, setReport] = useState<AiAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);
  const scope = reportScope(datasets);

  const run = useCallback(async () => {
    if (!scope || loading) return;
    setLoading(true);
    setError(null);
    setElapsed(0);
    timerRef.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    try {
      const answer = await aiReport({ ward: scope.ward, dataset_id: scope.dataset_id, max_features: 25 });
      setReport(answer);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.ward, scope?.dataset_id]);

  // Reset when the selected scope actually changes (not on every re-render).
  const scopeKey = scope ? `${scope.ward ?? ""}:${scope.dataset_id ?? ""}` : "";
  useEffect(() => {
    setReport(null);
    setError(null);
  }, [scopeKey]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  if (!scope) return null;

  return (
    <aside className="workspace-panel" data-testid="ward-report-panel">
      <header className="workspace-panel__head">
        <div>
          <div className="workspace-panel__eyebrow">Neighbourhood Report</div>
          {scope.wardName && (
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 2 }}>
              Ward {scope.wardName}
            </div>
          )}
          <h2 className="workspace-panel__title" data-testid="ward-report-title">{scope.label}</h2>
          <div className="workspace-panel__sub">
            {datasets.length} dataset{datasets.length === 1 ? "" : "s"} selected · grounded in real survey data
          </div>
        </div>
        <button type="button" className="workspace-panel__close" onClick={onClose} data-testid="ward-report-close">×</button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {!report && !loading && !error && (
          <button
            type="button"
            onClick={() => void run()}
            style={{
              width: "100%", padding: "12px 16px", background: "var(--accent-muted)", border: "1px solid var(--accent)",
              borderRadius: "var(--radius-sm)", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
            data-testid="ward-report-generate"
          >
            Generate Report
          </button>
        )}

        {loading && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: 24, color: "var(--ink-mute)", fontSize: 12 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <div className="ai-turn__dot" />
              <div className="ai-turn__dot" />
              <div className="ai-turn__dot" />
            </div>
            <span>Generating full report from local AI — this covers Executive Summary, Findings, Strategy, and Outcomes in three passes, so it can take a few minutes ({elapsed}s so far)…</span>
          </div>
        )}

        {error && (
          <div style={{ padding: 12, background: "var(--danger-muted)", border: "1px solid var(--danger)", borderRadius: "var(--radius-sm)", color: "var(--danger)", fontSize: 11, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {report && (
          <div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: 10, color: "var(--ink-mute)" }}>
              <span style={{ padding: "3px 8px", background: "var(--surface-2)", borderRadius: "var(--radius-full)" }}>
                Model: <b style={{ color: "var(--ink-dim)" }}>{report.model}</b>
              </span>
              <span style={{ padding: "3px 8px", background: "var(--surface-2)", borderRadius: "var(--radius-full)" }}>
                Context: <b style={{ color: "var(--ink-dim)" }}>{report.context_rows} rows</b>
              </span>
              <span style={{
                padding: "3px 8px", borderRadius: "var(--radius-full)",
                background: report.grounded ? "var(--ok-muted)" : "var(--warn-muted)",
                color: report.grounded ? "var(--ok)" : "var(--warn)", fontWeight: 600,
              }}>
                {report.grounded ? "✓ Grounded" : "⚠ Insufficient data"}
              </span>
            </div>

            <div style={{
              padding: 16, background: "var(--surface-2)", border: "1px solid var(--edge)",
              borderRadius: "var(--radius-md)", fontSize: 12, lineHeight: 1.6, color: "var(--ink)",
            }}>
              <ReactMarkdown>{report.answer_markdown}</ReactMarkdown>
            </div>

            <button
              type="button"
              onClick={() => void run()}
              style={{
                marginTop: 12, width: "100%", padding: "8px 12px", background: "var(--surface-3)",
                border: "1px solid var(--edge)", borderRadius: "var(--radius-sm)", color: "var(--ink-dim)",
                fontSize: 11, fontWeight: 600, cursor: "pointer",
              }}
              data-testid="ward-report-refresh"
            >
              Regenerate Report
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
