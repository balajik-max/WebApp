import { useEffect, useMemo, useRef, useState } from "react";
import type { DatasetRow } from "../../lib/workflow";

interface Props {
  datasets: DatasetRow[];
  draftDatasetIds: string[];
  appliedDatasetIds: string[];
  loadingDatasets: boolean;
  analyzing: boolean;
  onDatasetChange: (values: string[]) => void;
  onAnalyze: () => void;
}

function sameValues(a: string[], b: string[]) {
  return [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
}

export function AnalyticsScopeBar({
  datasets,
  draftDatasetIds,
  appliedDatasetIds,
  loadingDatasets,
  analyzing,
  onDatasetChange,
  onAnalyze,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === draftDatasetIds[0]) ?? null,
    [datasets, draftDatasetIds]
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleDatasets = useMemo(() => {
    const sorted = [...datasets].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
    );
    return normalizedQuery
      ? sorted.filter((dataset) => dataset.name.toLocaleLowerCase().includes(normalizedQuery))
      : sorted;
  }, [datasets, normalizedQuery]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const dirty = !sameValues(draftDatasetIds, appliedDatasetIds);

  function selectDataset(id: string) {
    onDatasetChange([id]);
    setQuery("");
    setOpen(false);
  }

  function clearSelection() {
    onDatasetChange([]);
    setQuery("");
    inputRef.current?.focus();
  }

  return (
    <section className="analytics-search-scope" data-testid="analytics-scope">
      <div className="analytics-search-bar" ref={rootRef}>
        <svg className="analytics-search-bar__icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" />
        </svg>
        <input
          ref={inputRef}
          value={open ? query : selectedDataset?.name ?? ""}
          placeholder={loadingDatasets ? "Loading datasets…" : "Search datasets…"}
          disabled={loadingDatasets}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          aria-label="Search datasets"
        />
        {selectedDataset && !open && (
          <button
            type="button"
            className="analytics-search-bar__clear"
            onClick={clearSelection}
            aria-label="Clear selected dataset"
          >
            ×
          </button>
        )}
        {open && (
          <div className="analytics-search-bar__menu" role="listbox">
            <button
              type="button"
              role="option"
              aria-selected={draftDatasetIds.length === 0}
              className={draftDatasetIds.length === 0 ? "is-selected" : ""}
              onClick={clearSelection}
            >
              <b>All datasets</b>
              <small>{datasets.length} available</small>
            </button>
            {visibleDatasets.map((dataset) => (
              <button
                type="button"
                role="option"
                key={dataset.id}
                aria-selected={draftDatasetIds.includes(dataset.id)}
                className={draftDatasetIds.includes(dataset.id) ? "is-selected" : ""}
                onClick={() => selectDataset(dataset.id)}
              >
                <b>{dataset.name}</b>
                {(dataset.ward || dataset.status) && (
                  <small>{[dataset.ward ? `Ward ${dataset.ward}` : null, dataset.status].filter(Boolean).join(" · ")}</small>
                )}
              </button>
            ))}
            {visibleDatasets.length === 0 && <div className="analytics-search-bar__empty">No matching datasets</div>}
          </div>
        )}
      </div>
      <button
        type="button"
        className="analytics-search-scope__analyze"
        onClick={onAnalyze}
        disabled={analyzing}
      >
        {analyzing ? "Analyzing…" : dirty ? "Analyze changes" : "Analyze"}
      </button>
    </section>
  );
}
