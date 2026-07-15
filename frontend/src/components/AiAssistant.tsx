import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import {
  aiQuery,
  aiRecommend,
  aiSpacing,
  type AiAnswer,
  type AiKind,
} from "../lib/ai";
import { AnimatedAiAssistantButton } from "./ai/AnimatedAiAssistantButton";
import type { AiHighlight, FeatureFilter, UrbanFeature } from "../lib/types";

interface Props {
  filter: FeatureFilter;
  selectedFeature: UrbanFeature | null;
  /** Called whenever a spacing check completes with AI highlight data.
   * Pass an empty array to clear previous highlights. */
  onAiHighlights?: (highlights: AiHighlight[]) => void;
}

interface HistoryEntry {
  id: string;
  kind: AiKind;
  prompt: string;
  answer: AiAnswer | null;
  error: string | null;
  loading: boolean;
  startTime?: number;
  duration?: number;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export function AiAssistant({ filter, selectedFeature, onAiHighlights }: Props) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pendingKind, setPendingKind] = useState<AiKind | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);

  const spacingScope = filter.ward || filter.datasetIds?.[0];
  const canCheckSpacing = Boolean(filter.category && spacingScope);

  // Timer for loading state
  useEffect(() => {
    if (pendingKind) {
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        setElapsed((e) => e + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [pendingKind]);

  async function run(kind: AiKind, prompt: string, invoke: () => Promise<AiAnswer>) {
    if (pendingKind) return;
    const startTime = Date.now();
    const entry: HistoryEntry = { id: uid(), kind, prompt, answer: null, error: null, loading: true, startTime };
    setHistory((h) => [entry, ...h]);
    setPendingKind(kind);
    try {
      const answer = await invoke();
      const duration = Math.round((Date.now() - startTime) / 1000);
      setHistory((h) => h.map((e) => (e.id === entry.id ? { ...e, answer, loading: false, duration } : e)));

      // Fire highlight callback for spacing results
      if (kind === "spacing" && onAiHighlights) {
        const highlights: AiHighlight[] = [
          ...(answer.redundant_feature_ids ?? []).map((id) => ({
            featureId: id,
            status: "redundant" as const,
          })),
          ...(answer.needed_feature_ids ?? []).map((id) => ({
            featureId: id,
            status: "needed" as const,
          })),
          ...(answer.needed_locations ?? []).map((loc) => ({
            featureId: loc.id,
            coordinates: [loc.lon, loc.lat] as [number, number],
            reason: loc.reason,
            status: "needed" as const,
          })),
        ];
        onAiHighlights(highlights);
      }
    } catch (e) {
      const message = (e as Error).message;
      const duration = Math.round((Date.now() - startTime) / 1000);
      setHistory((h) =>
        h.map((e) => (e.id === entry.id ? { ...e, error: message, loading: false, duration } : e))
      );
    } finally {
      setPendingKind(null);
    }
  }

  function clearHighlights() {
    onAiHighlights?.([]);
  }

  function recommendForSelected() {
    if (!selectedFeature) {
      setHistory((h) => [
        {
          id: uid(),
          kind: "recommend",
          prompt: "Recommend actions",
          answer: null,
          error: "Select a feature on the map first.",
          loading: false,
        },
        ...h,
      ]);
      return;
    }
    void run(
      "recommend",
      `Recommend mitigation for feature ${selectedFeature.properties.id.slice(0, 8)}`,
      () => aiRecommend({ feature_id: selectedFeature.properties.id })
    );
  }

  function askQuestion(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    setQuestion("");
    void run("query", q, () =>
      aiQuery({
        question: q,
        ward: filter.ward,
        category: filter.category,
        dataset_id: filter.ward ? undefined : filter.datasetIds?.[0],
        feature_ids: selectedFeature ? [selectedFeature.properties.id] : undefined,
      })
    );
  }

  function checkSpacing() {
    if (!filter.category || !spacingScope) return;
    void run(
      "spacing",
      `Check spacing of "${filter.category}"`,
      () =>
        aiSpacing({
          ward: filter.ward,
          dataset_id: filter.ward ? undefined : filter.datasetIds?.[0],
          category: filter.category!,
          distance_m: 200,
        })
    );
  }

  return (
    <>
      <AnimatedAiAssistantButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        isThinking={pendingKind !== null}
        className="ai-fab-override"
      />

      {open && (
        <section className="ai-panel" data-testid="ai-panel">
          <header className="ai-panel__head">
            <div>
              <div className="ai-panel__eyebrow">local · offline · grounded</div>
              <h3 className="ai-panel__title">AI Assistant</h3>
              <div className="ai-panel__sub">
                Answers use ONLY your PostGIS data. Powered by local Ollama.
              </div>
            </div>
          </header>

          <div className="ai-panel__quick" data-testid="ai-quick">
            <button
              type="button"
              onClick={recommendForSelected}
              disabled={pendingKind !== null || !selectedFeature}
              data-testid="ai-quick-recommend"
            >
              Recommend for selected
            </button>
          </div>

          <div className="ai-panel__quick ai-panel__quick--spacing" data-testid="ai-quick-spacing-row">
            <button
              type="button"
              onClick={checkSpacing}
              disabled={pendingKind !== null || !canCheckSpacing}
              data-testid="ai-quick-spacing"
              title={
                canCheckSpacing
                  ? `Analyse ${filter.category} placement — detect redundant poles`
                  : "Select a ward and a category filter first"
              }
            >
              Check spacing
            </button>
          </div>
          {!canCheckSpacing && (
            <div className="ai-panel__hint">
              Set a ward and a category in the topbar filter, then Apply, to check for
              features placed too close together.
            </div>
          )}
          {/* AI highlight legend — visible after a spacing check produces highlights */}
          {onAiHighlights && history.some(
            (h) => h.kind === "spacing" && h.answer &&
              ((h.answer.redundant_feature_ids?.length ?? 0) + (h.answer.needed_feature_ids?.length ?? 0) + (h.answer.needed_locations?.length ?? 0)) > 0
          ) && (
              <div className="ai-highlight-legend">
                <div className="ai-highlight-legend__title">AI Map Overlay</div>
                <div className="ai-highlight-legend__items">
                  <span className="ai-highlight-legend__dot ai-highlight-legend__dot--red" />
                  <span>Recommended removal</span>
                  <span className="ai-highlight-legend__dot ai-highlight-legend__dot--green" />
                  <span>Proposed missing/service-gap pole</span>
                </div>
                <button
                  type="button"
                  className="ai-highlight-legend__clear"
                  onClick={clearHighlights}
                  title="Remove AI colour overlay from the map"
                >
                  Clear overlay ✕
                </button>
              </div>
            )}
          <form className="ai-panel__form" onSubmit={askQuestion} data-testid="ai-form">
            <textarea
              data-testid="ai-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                selectedFeature
                  ? "Ask about the selected feature or ward…"
                  : "Type your question here…"
              }
              rows={2}
              disabled={pendingKind !== null}
            />
            <button
              type="submit"
              disabled={pendingKind !== null || !question.trim()}
              data-testid="ai-send"
            >
              {pendingKind === "query" ? "thinking…" : "Ask"}
            </button>
          </form>

          <div className="ai-panel__history" data-testid="ai-history">
            {history.length === 0 ? (
              <div className="ai-panel__empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="32" height="32">
                  <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p>Ask a question or try a quick action above</p>
                <span>Responses are grounded in your PostGIS data only</span>
              </div>
            ) : (
              history.map((h) => (
                <ChatBubble
                  key={h.id}
                  entry={h}
                  elapsed={h.loading ? elapsed : undefined}
                />
              ))
            )}
          </div>
        </section>
      )}
    </>
  );
}

function ChatBubble({ entry, elapsed }: { entry: HistoryEntry; elapsed?: number }) {
  return (
    <article className="ai-turn" data-testid={`ai-turn-${entry.kind}`}>
      <header className="ai-turn__head">
        <span className={`ai-turn__kind ai-turn__kind--${entry.kind}`}>{entry.kind}</span>
        <span className="ai-turn__prompt">{entry.prompt}</span>
      </header>

      {entry.loading && (
        <div className="ai-turn__loading">
          <span className="ai-turn__dot" />
          <span className="ai-turn__dot" />
          <span className="ai-turn__dot" />
          <span className="ai-turn__loading-text">
            <span>Processing with local AI...</span>
            <span className="ai-turn__timer">{elapsed || 0}s</span>
          </span>
        </div>
      )}

      {entry.error && (
        <div className="ai-turn__error" data-testid="ai-turn-error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
          </svg>
          {entry.error}
        </div>
      )}

      {entry.answer && (
        <>
          <div className="ai-turn__meta">
            <span className="ai-turn__meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
                <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {entry.answer.model}
            </span>
            <span className="ai-turn__meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
                <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {entry.answer.context_rows} rows
            </span>
            {entry.duration && (
              <span className="ai-turn__meta-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
                  <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {entry.duration}s
              </span>
            )}
            <span
              className={
                entry.answer.grounded ? "ai-turn__pill--ok" : "ai-turn__pill--warn"
              }
            >
              {entry.answer.grounded ? "grounded" : "insufficient data"}
            </span>
          </div>
          <div className="ai-turn__markdown">
            <ReactMarkdown>{entry.answer.answer_markdown}</ReactMarkdown>
          </div>
        </>
      )}
    </article>
  );
}
