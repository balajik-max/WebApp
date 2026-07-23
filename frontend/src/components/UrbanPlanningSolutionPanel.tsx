import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { ApiError } from "../lib/api";
import { urbanPlanningSolution, type AiAnswer } from "../lib/ai";

interface Props {
  featureId: string | null | undefined;
  placeholder: string;
  contextLabel: string;
  defaultOpen?: boolean;
}

export function UrbanPlanningSolutionPanel({
  featureId,
  placeholder,
  contextLabel,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<AiAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(defaultOpen);
    setText("");
    setFiles([]);
    setGenerating(false);
    setResult(null);
    setError(null);
  }, [contextLabel, defaultOpen, featureId]);

  const handleFilesChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    setFiles((previous) => [...previous, ...selected]);
    event.target.value = "";
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((previous) => previous.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  async function generate(): Promise<void> {
    if (!featureId || (!text.trim() && files.length === 0)) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const answer = await urbanPlanningSolution(featureId, text, files);
      setResult(answer);
    } catch (reason) {
      if (reason instanceof ApiError && typeof reason.body === "object" && reason.body) {
        const detail = (reason.body as { detail?: unknown }).detail;
        setError(typeof detail === "string" ? detail : reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : "Unexpected error");
      }
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="urban-planning-solution-panel" data-testid={`urban-planning-solution-${contextLabel.replace(/\s+/g, "-").toLowerCase()}`}>
      <button
        type="button"
        className="anomaly-card__toggle-solution"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        {open ? "−" : "+"} Urban Planning Solution
      </button>

      {open && (
        <div className="anomaly-card__solution">
          <textarea
            className="anomaly-card__solution-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={50000}
            rows={3}
            placeholder={placeholder}
          />

          <div className="anomaly-card__solution-upload">
            <label className="anomaly-card__solution-file-label">
              <span>Upload files</span>
              <input type="file" accept=".txt,.pdf,.docx" multiple onChange={handleFilesChange} />
            </label>
            {files.length > 0 && (
              <ul className="anomaly-card__solution-file-list">
                {files.map((file, index) => (
                  <li key={`${file.name}-${file.lastModified}-${index}`}>
                    <small>{file.name}</small>
                    <button
                      type="button"
                      className="anomaly-card__solution-file-remove"
                      onClick={() => removeFile(index)}
                      aria-label={`Remove ${file.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="button"
            className="anomaly-card__solution-generate"
            onClick={() => void generate()}
            disabled={!featureId || generating || (!text.trim() && files.length === 0)}
          >
            {generating ? "Generating…" : "Generate AI Explanation"}
          </button>

          {!featureId && (
            <div className="anomaly-card__error">
              The selected {contextLabel} does not have a valid feature ID, so the planning solution cannot be generated.
            </div>
          )}
          {error && <div className="anomaly-card__error">{error}</div>}
          {generating && <div className="anomaly-card__loading">AI is analyzing your solution…</div>}

          {result && (
            <div className="anomaly-card__solution-result">
              <div className="anomaly-card__solution-result-head">
                <strong>AI Generated Explanation</strong>
                <small>{result.model}</small>
              </div>
              <div className="anomaly-card__solution-result-body">
                {result.answer_markdown.split("\n").map((line, index) => {
                  if (line.startsWith("## ")) return <h5 key={index} style={{ margin: "8px 0 3px" }}>{line.slice(3)}</h5>;
                  if (line.startsWith("### ")) return <h6 key={index} style={{ margin: "6px 0 2px" }}>{line.slice(4)}</h6>;
                  if (/^- /.test(line)) return <li key={index} style={{ marginLeft: 12 }}>{line.slice(2)}</li>;
                  if (/^\d+\. /.test(line)) return <li key={index} style={{ marginLeft: 12 }}>{line}</li>;
                  if (line.trim() === "") return <br key={index} />;
                  return <p key={index} style={{ margin: "2px 0", lineHeight: 1.4 }}>{line}</p>;
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
