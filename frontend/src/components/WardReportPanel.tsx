import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { aiReport, type AiAnswer } from "../lib/ai";
import type { DatasetRow } from "../lib/workflow";

interface ReportGeneratorProps {
  datasets: DatasetRow[];
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

/** Floating "Generate Report" trigger + popup, mirroring the AiAssistant
 * fab/panel pattern (button bottom-right, panel opens above it) — kept as
 * a corner control rather than a fixed side panel now that the map no
 * longer reserves a right-hand column for it. */
export function ReportGenerator({ datasets }: ReportGeneratorProps) {
  const [open, setOpen] = useState(false);
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

  return (
    <>
      <button
        type="button"
        className={`report-fab${open ? " report-fab--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        data-testid="report-fab"
        aria-label="Toggle neighbourhood report"
      >
        {open ? "×" : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 3h8l4 4v14a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
            <path d="M9 12h6M9 16h6M9 8h2" />
          </svg>
        )}
      </button>

      {open && (
        <section className="report-panel" data-testid="report-panel">
          <header className="ai-panel__head">
            <div>
              <div className="ai-panel__eyebrow">Neighbourhood Report</div>
              {scope?.wardName && (
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 2 }}>
                  Ward {scope.wardName}
                </div>
              )}
              <h3 className="ai-panel__title" data-testid="ward-report-title">{scope?.label ?? "No dataset selected"}</h3>
              {scope && (
                <div className="ai-panel__sub">
                  {datasets.length} dataset{datasets.length === 1 ? "" : "s"} selected · grounded in real survey data
                </div>
              )}
            </div>
          </header>

          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {!scope && (
              <div style={{ color: "var(--ink-mute)", fontSize: 12 }}>
                Select a dataset to generate a neighbourhood report.
              </div>
            )}

            {scope && !report && !loading && !error && (
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
        </section>
      )}
    </>
  );
}

const SUPPORTING_FILE_ACCEPT = ".pdf,.txt,.csv";

/** Self-contained staging list for files the user wants to attach for AI
 * analysis — never uploaded anywhere by this component (no report/analysis
 * call reads it), just a local add/remove list, so it doesn't need to be
 * wired to `datasets` or the report scope like ReportGenerator above. Lives
 * in the Command Center's footer now that the right-hand panel is gone. */
export function SupportingFilesImport() {
  const [supportingFiles, setSupportingFiles] = useState<File[]>([]);
  const supportingFileInputRef = useRef<HTMLInputElement | null>(null);

  function addSupportingFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setSupportingFiles((prev) => [...prev, ...Array.from(files)]);
    if (supportingFileInputRef.current) supportingFileInputRef.current.value = "";
  }

  function removeSupportingFile(index: number) {
    setSupportingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="command-center__import" data-testid="ward-report-import">
      <input
        ref={supportingFileInputRef}
        type="file"
        accept={SUPPORTING_FILE_ACCEPT}
        multiple
        onChange={(e) => addSupportingFiles(e.target.files)}
        data-testid="ward-report-import-input"
        style={{ display: "none" }}
      />
      <button
        type="button"
        className="command-center__import-btn"
        onClick={() => supportingFileInputRef.current?.click()}
        data-testid="ward-report-import-btn"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        Import supporting files
      </button>
      <div className="command-center__import-hint">PDF, TXT, or CSV to support AI analysis</div>

      {supportingFiles.length > 0 && (
        <ul className="command-center__import-list">
          {supportingFiles.map((file, i) => (
            <li key={`${file.name}-${i}`} className="command-center__import-item">
              <span className="command-center__import-item-name" title={file.name}>{file.name}</span>
              <button
                type="button"
                className="command-center__import-item-remove"
                onClick={() => removeSupportingFile(i)}
                aria-label={`Remove ${file.name}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
