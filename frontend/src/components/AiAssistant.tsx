import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  aiPrioritize,
  aiQuery,
  aiRecommend,
  aiSummarize,
  type AiAnswer,
  type AiKind,
} from "../lib/ai";
import type { FeatureFilter, UrbanFeature } from "../lib/types";

interface Props {
  filter: FeatureFilter;
  selectedFeature: UrbanFeature | null;
}

interface HistoryEntry {
  id: string;
  kind: AiKind;
  prompt: string;
  answer: AiAnswer | null;
  error: string | null;
  loading: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export function AiAssistant({ filter, selectedFeature }: Props) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pendingKind, setPendingKind] = useState<AiKind | null>(null);

  async function run(kind: AiKind, prompt: string, invoke: () => Promise<AiAnswer>) {
    if (pendingKind) return;
    const entry: HistoryEntry = { id: uid(), kind, prompt, answer: null, error: null, loading: true };
    setHistory((h) => [entry, ...h]);
    setPendingKind(kind);
    try {
      const answer = await invoke();
      setHistory((h) => h.map((e) => (e.id === entry.id ? { ...e, answer, loading: false } : e)));
    } catch (e) {
      const message = (e as Error).message;
      setHistory((h) =>
        h.map((e) => (e.id === entry.id ? { ...e, error: message, loading: false } : e))
      );
    } finally {
      setPendingKind(null);
    }
  }

  function summarizeCurrentScope() {
    if (!filter.ward) {
      const msg = "Set a ward filter first, then click Summarize.";
      setHistory((h) => [
        { id: uid(), kind: "summarize", prompt: "Summarize current ward", answer: null, error: msg, loading: false },
        ...h,
      ]);
      return;
    }
    void run("summarize", `Summarize ward ${filter.ward}`, () =>
      aiSummarize({ ward: filter.ward, max_features: 80 })
    );
  }

  function prioritizeCritical() {
    void run(
      "prioritize",
      filter.ward ? `Prioritize open issues in ward ${filter.ward}` : "Prioritize open issues",
      () => aiPrioritize({ ward: filter.ward, limit: 25 })
    );
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
        dataset_id: undefined,
        feature_ids: selectedFeature ? [selectedFeature.properties.id] : undefined,
      })
    );
  }

  return (
    <>
      <button
        type="button"
        className={`ai-fab${open ? " ai-fab--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        data-testid="ai-fab"
        aria-label="Toggle AI assistant"
      >
        {open ? "×" : "AI"}
      </button>

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
              onClick={summarizeCurrentScope}
              disabled={pendingKind !== null}
              data-testid="ai-quick-summarize"
            >
              Summarize current ward
            </button>
            <button
              type="button"
              onClick={prioritizeCritical}
              disabled={pendingKind !== null}
              data-testid="ai-quick-prioritize"
            >
              Prioritize critical issues
            </button>
            <button
              type="button"
              onClick={recommendForSelected}
              disabled={pendingKind !== null || !selectedFeature}
              data-testid="ai-quick-recommend"
            >
              Recommend for selected
            </button>
          </div>

          <form className="ai-panel__form" onSubmit={askQuestion} data-testid="ai-form">
            <textarea
              data-testid="ai-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                selectedFeature
                  ? "Ask about the selected feature or ward…"
                  : "Ask about the selected ward or dataset (set the ward filter first)…"
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
              <p className="workspace__muted">
                Try a quick task or ask a natural-language question.
              </p>
            ) : (
              history.map((h) => <ChatBubble key={h.id} entry={h} />)
            )}
          </div>
        </section>
      )}
    </>
  );
}

function ChatBubble({ entry }: { entry: HistoryEntry }) {
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
          <span>llama3:8b reasoning over PostGIS…</span>
        </div>
      )}

      {entry.error && (
        <div className="ai-turn__error" data-testid="ai-turn-error">
          {entry.error}
        </div>
      )}

      {entry.answer && (
        <>
          <div className="ai-turn__meta">
            <span>model: <b>{entry.answer.model}</b></span>
            <span>rows: <b>{entry.answer.context_rows}</b></span>
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
