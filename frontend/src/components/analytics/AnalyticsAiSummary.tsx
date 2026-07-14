import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { aiReport, type AiAnswer } from "../../lib/ai";

interface Props {
  datasetIds: string[];
  datasetNames?: string[];
  categories: string[];
  ward?: string | null;
  severityBuckets?: Array<"low" | "medium" | "high">;
  disabledReason?: string | null;
}

export function AnalyticsAiSummary({
  datasetIds,
  datasetNames = [],
  categories,
  ward = null,
  severityBuckets = [],
  disabledReason = null,
}: Props) {
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);
  const scopeKey = JSON.stringify({
    datasetIds: [...datasetIds].sort(),
    categories: [...categories].sort(),
    ward,
    severityBuckets: [...severityBuckets].sort(),
  });

  useEffect(() => {
    setAnswer(null);
    setError(null);
    setElapsed(0);
  }, [scopeKey]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    []
  );

  async function generate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setElapsed(0);
    timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    try {
      const response = await aiReport({
        dataset_ids: datasetIds,
        categories,
        ward: ward || undefined,
        severity_buckets: severityBuckets,
        all_datasets: datasetIds.length === 0,
        max_features: 25,
      });
      setAnswer(response);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }

  return (
    <section className="chart-card analytics-ai-card" data-testid="analytics-ai-summary">
      <div className="chart-card__header">
        <div>
          <div className="analytics-card-eyebrow">Grounded AI</div>
          <h3 className="chart-card__title">Applied-Scope Planning Summary</h3>
        </div>
        {answer && (
          <span className={`analytics-grounded-badge${answer.grounded ? " is-grounded" : ""}`}>
            {answer.grounded ? "✓ SQL grounded" : "Insufficient data"}
          </span>
        )}
      </div>
      <div className="chart-card__body">
        <p className="analytics-ai-card__note">
          SQL/PostGIS calculates totals, categories, severity, data-quality findings, and priority scores. Ollama writes only the explanatory narrative from those verified facts.
        </p>
        <div className="analytics-ai-scope">
          <span><b>Datasets:</b> {datasetNames.length === 0 ? "All datasets" : datasetNames.join(", ")}</span>
          <span><b>Categories:</b> {categories.length === 0 ? "All categories" : categories.join(", ")}</span>
          <span><b>Ward:</b> {ward || "All wards"}</span>
          <span><b>Severity:</b> {severityBuckets.length === 0 ? "All levels" : severityBuckets.join(", ")}</span>
        </div>
        {disabledReason && <div className="analytics-ai-disabled-note">{disabledReason}</div>}
        {!answer && !loading && (
          <button
            type="button"
            className="analytics-ai-card__button"
            onClick={() => void generate()}
            disabled={Boolean(disabledReason)}
          >
            Generate AI summary
          </button>
        )}
        {loading && (
          <div className="analytics-ai-card__loading">
            <span className="ai-turn__dot" />
            <span className="ai-turn__dot" />
            <span className="ai-turn__dot" />
            <p>Building verified facts and generating the explanation… {elapsed}s</p>
          </div>
        )}
        {error && <div className="analytics-inline-error">AI summary unavailable: {error}</div>}
        {answer && (
          <>
            <div className="analytics-ai-card__meta">
              <span>Model: <b>{answer.model}</b></span>
              <span>Matching rows: <b>{answer.context_rows.toLocaleString()}</b></span>
            </div>
            <div className="analytics-ai-card__report">
              <ReactMarkdown>{answer.answer_markdown}</ReactMarkdown>
            </div>
            <button type="button" className="analytics-ai-card__regenerate" onClick={() => void generate()} disabled={loading || Boolean(disabledReason)}>
              Regenerate for this scope
            </button>
          </>
        )}
      </div>
    </section>
  );
}
