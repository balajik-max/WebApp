import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { aiReport, type AiAnswer } from "../lib/ai";
import type { DatasetRow } from "../lib/workflow";

interface ReportGeneratorProps {
  datasets: DatasetRow[];
}

/** Picks the scope for the report */
function reportScope(datasets: DatasetRow[]): { ward?: string; dataset_id?: string; label: string; wardName?: string } | null {
  if (datasets.length === 0) return null;
  const withWard = datasets.find((d) => d.ward);
  if (withWard?.ward) return { ward: withWard.ward, label: `Ward ${withWard.ward}`, wardName: withWard.ward };
  const first = datasets[0];
  return { dataset_id: first.id, label: first.name };
}

/** Inline report panel — used inside the topbar dropdown */
export function ReportPanel({ datasets }: { datasets: DatasetRow[] }) {
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

  const scopeKey = scope ? `${scope.ward ?? ""}:${scope.dataset_id ?? ""}` : "";
  useEffect(() => { setReport(null); setError(null); }, [scopeKey]);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const doExport = () => {
    if (!report) return;
    const title = scope?.label ?? "Neighbourhood Report";
    // Escape the markdown for safe injection into a script tag
    const escapedMd = JSON.stringify(report.answer_markdown);
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
  <style>
    body { font-family: Georgia, serif; font-size: 13px; line-height: 1.75; color: #111; max-width: 820px; margin: 40px auto; padding: 0 32px; }
    h1 { font-size: 24px; font-weight: 800; margin: 1.4em 0 0.4em; }
    h2 { font-size: 18px; font-weight: 700; margin: 1.2em 0 0.35em; border-bottom: 1px solid #ddd; padding-bottom: 5px; }
    h3 { font-size: 14px; font-weight: 700; margin: 1em 0 0.25em; }
    p  { margin: 0.5em 0; }
    ul, ol { padding-left: 1.6em; margin: 0.4em 0; }
    li { margin-bottom: 0.25em; }
    strong { font-weight: 700; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 12px; page-break-inside: avoid; }
    thead { background: #f0f0f0; }
    th { padding: 6px 10px; border: 1px solid #bbb; font-weight: 700; text-align: left; white-space: nowrap; }
    td { padding: 5px 10px; border: 1px solid #ccc; vertical-align: top; }
    tr:nth-child(even) td { background: #f9f9f9; }
    code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
    pre  { background: #f4f4f4; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 11px; }
    @media print {
      body { margin: 0; }
      h2 { page-break-after: avoid; }
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"><\/script>
</head>
<body>
  <h1>${title}</h1>
  <div id="content"></div>
  <script>
    const md = ${escapedMd};
    marked.setOptions({ gfm: true, breaks: false });
    document.getElementById('content').innerHTML = marked.parse(md);
    window.onload = function() {
      // Small delay lets the browser finish layout before print dialog
      setTimeout(function() { window.print(); }, 300);
    };
  <\/script>
</body>
</html>`;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
  };

  return (
    <div className="report-panel-inline">
      {/* Header */}
      <div className="report-panel-inline__head">
        <span className="report-panel-inline__eyebrow">Neighbourhood Report</span>
        {scope?.wardName && <span className="report-panel-inline__ward">Ward {scope.wardName}</span>}
        <span className="report-panel-inline__title">{scope?.label ?? "No dataset selected"}</span>
      </div>

      {/* Body */}
      <div className="report-panel-inline__body">
        {!scope && <p className="report-panel-inline__empty">Select a dataset to generate a report.</p>}

        {scope && !report && !loading && !error && (
          <button className="report-panel-inline__action-btn report-panel-inline__action-btn--primary" onClick={() => void run()} data-testid="ward-report-generate">
            Generate Report
          </button>
        )}

        {loading && (
          <div className="report-panel-inline__loading">
            <div style={{ display: "flex", gap: 4 }}>
              <div className="ai-turn__dot" /><div className="ai-turn__dot" /><div className="ai-turn__dot" />
            </div>
            <span>Generating report… ({elapsed}s)</span>
          </div>
        )}

        {error && <div className="report-panel-inline__error">{error}</div>}

        {report && (
          <>
            {/* Markdown content */}
            <div className="report-panel-inline__content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.answer_markdown}</ReactMarkdown>
            </div>

            {/* Actions */}
            <div className="report-panel-inline__actions">
              <button className="report-panel-inline__action-btn report-panel-inline__action-btn--primary" onClick={doExport} data-testid="ward-report-export">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden="true">
                  <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export PDF
              </button>
              <button className="report-panel-inline__action-btn" onClick={() => void run()} data-testid="ward-report-refresh">
                Regenerate
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Legacy floating FAB — kept so MapView.tsx import still compiles,
 *  but rendered as null so the old corner button is gone. */
export function ReportGenerator(_props: ReportGeneratorProps) {
  return null;
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
