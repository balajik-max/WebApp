import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { aiReport, type AiAnswer } from "../../lib/ai";

interface Props {
  datasetIds: string[];
  categories: string[];
}

export function AnalyticsAiSummary({ datasetIds, categories }: Props) {
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);
  const scopeKey = useMemo(
    () => `${[...datasetIds].sort().join(",")}|${[...categories].sort().join(",")}`,
    [categories, datasetIds]
  );

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
          SQL/PostGIS calculates totals, categories, severity, and priority features. Ollama writes only the explanatory narrative from those verified facts.
        </p>
        {!answer && !loading && (
          <button type="button" className="analytics-ai-card__button" onClick={() => void generate()}>
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
            <button type="button" className="analytics-ai-card__regenerate" onClick={() => void generate()} disabled={loading}>
              Regenerate for this scope
            </button>
          </>
        )}
      </div>
    </section>
  );
}
