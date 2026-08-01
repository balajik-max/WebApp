import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DatasetRow } from "../../lib/workflow";

interface Props {
  datasets: DatasetRow[];
  draftDatasetIds: string[];
  appliedDatasetIds: string[];
  loadingDatasets: boolean;
  analyzing: boolean;
  onDatasetChange: (values: string[]) => void;
  onAnalyze: () => void;
  attributeKey: string | null;
  appliedAttributeKey: string | null;
  onAttributeChange: (key: string | null) => void;
  rightSlot?: ReactNode;
}

const ANALYTICS_ATTRIBUTES = [
  { key: "poles", label: "Poles" },
  { key: "drains", label: "Drains" },
  { key: "manholes", label: "Manholes" },
  { key: "roads", label: "Roads" },
  { key: "powerlines", label: "Powerlines" },
  { key: "potholes", label: "Potholes" },
  { key: "standing_water", label: "Standing Water" },
  { key: "road_inspection", label: "Road Inspection" },
] as const;

export function AnalyticsScopeBar({
  datasets,
  draftDatasetIds,
  appliedDatasetIds: _appliedDatasetIds,
  loadingDatasets,
  analyzing,
  onDatasetChange,
  onAnalyze,
  attributeKey,
  appliedAttributeKey: _appliedAttributeKey,
  onAttributeChange,
  rightSlot,
}: Props) {
  const [attributeOpen, setAttributeOpen] = useState(false);
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [attributeQuery, setAttributeQuery] = useState("");
  const [datasetQuery, setDatasetQuery] = useState("");
  const attributeRootRef = useRef<HTMLDivElement | null>(null);
  const datasetRootRef = useRef<HTMLDivElement | null>(null);
  const attributeInputRef = useRef<HTMLInputElement | null>(null);
  const datasetInputRef = useRef<HTMLButtonElement | null>(null);

  const selectedAttribute = useMemo(
    () => ANALYTICS_ATTRIBUTES.find((a) => a.key === attributeKey) ?? null,
    [attributeKey]
  );

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === draftDatasetIds[0]) ?? null,
    [datasets, draftDatasetIds]
  );

  const normalizedAttributeQuery = attributeQuery.trim().toLocaleLowerCase();
  const visibleAttributes = useMemo(() => {
    const sorted = [...ANALYTICS_ATTRIBUTES].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true })
    );
    return normalizedAttributeQuery
      ? sorted.filter((a) => a.label.toLocaleLowerCase().includes(normalizedAttributeQuery))
      : sorted;
  }, [normalizedAttributeQuery]);

  const normalizedDatasetQuery = datasetQuery.trim().toLocaleLowerCase();
  const visibleDatasets = useMemo(() => {
    const sorted = [...datasets].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
    );
    return normalizedDatasetQuery
      ? sorted.filter((dataset) => dataset.name.toLocaleLowerCase().includes(normalizedDatasetQuery))
      : sorted;
  }, [datasets, normalizedDatasetQuery]);

  useEffect(() => {
    if (attributeOpen) {
      setDatasetOpen(false);
    }
  }, [attributeOpen]);

  useEffect(() => {
    if (datasetOpen) {
      setAttributeOpen(false);
    }
  }, [datasetOpen]);

  useEffect(() => {
    if (!attributeOpen && !datasetOpen) return;
    const close = (event: MouseEvent) => {
      if (attributeRootRef.current && !attributeRootRef.current.contains(event.target as Node)) {
        setAttributeOpen(false);
      }
      if (datasetRootRef.current && !datasetRootRef.current.contains(event.target as Node)) {
        setDatasetOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAttributeOpen(false);
        setDatasetOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [attributeOpen, datasetOpen]);

  function selectAttribute(key: string) {
    onAttributeChange(key);
    setAttributeQuery("");
    setAttributeOpen(false);
  }

  function clearAttributeSelection() {
    onAttributeChange(null);
    setAttributeQuery("");
    attributeInputRef.current?.focus();
  }

  function selectDataset(id: string) {
    onDatasetChange([id]);
    setDatasetQuery("");
    setDatasetOpen(false);
  }

  function clearDatasetSelection() {
    onDatasetChange([]);
    setDatasetQuery("");
    datasetInputRef.current?.focus();
  }

  return (
    <section className="analytics-search-scope" data-testid="analytics-scope">
      <div className="analytics-controls">
        <div className="analytics-search-bar" ref={attributeRootRef}>
          <svg className="analytics-search-bar__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" />
          </svg>
          <input
            ref={attributeInputRef}
            value={attributeOpen ? attributeQuery : selectedAttribute?.label ?? ""}
            placeholder={loadingDatasets ? "Loading attributes…" : "Search Attributes ..."}
            disabled={loadingDatasets}
            role="combobox"
            aria-expanded={attributeOpen}
            aria-controls="attribute-listbox"
            aria-haspopup="listbox"
            aria-label="Search Attributes"
            onFocus={() => setAttributeOpen(true)}
            onChange={(event) => {
              setAttributeQuery(event.target.value);
              setAttributeOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setAttributeOpen(false);
              }
            }}
          />
          {selectedAttribute && !attributeOpen && (
            <button
              type="button"
              className="analytics-search-bar__clear"
              onClick={clearAttributeSelection}
              aria-label="Clear selected attribute"
            >
              ×
            </button>
          )}
          {attributeOpen && (
            <div className="analytics-search-bar__menu" id="attribute-listbox" role="listbox">
              {visibleAttributes.map((attribute) => (
                <button
                  type="button"
                  role="option"
                  key={attribute.key}
                  aria-selected={attributeKey === attribute.key}
                  className={attributeKey === attribute.key ? "is-selected" : ""}
                  onClick={() => selectAttribute(attribute.key)}
                >
                  {attribute.label}
                </button>
              ))}
              {visibleAttributes.length === 0 && (
                <div className="analytics-search-bar__empty">No attributes found</div>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className="analytics-search-scope__analyze"
          onClick={onAnalyze}
          disabled={analyzing || !attributeKey || loadingDatasets}
        >
          {analyzing ? "Analyzing…" : "Analyze"}
        </button>

        <div className="analytics-dataset-select" ref={datasetRootRef}>
          <button
            ref={datasetInputRef}
            type="button"
            className="analytics-dataset-select__trigger"
            onClick={() => {
              setDatasetOpen(!datasetOpen);
              setAttributeOpen(false);
            }}
            aria-expanded={datasetOpen}
            aria-controls="dataset-listbox"
            aria-haspopup="listbox"
            aria-label="Select dataset"
            disabled={loadingDatasets}
          >
            {loadingDatasets
              ? "Loading datasets…"
              : selectedDataset
                ? selectedDataset.name.length > 24
                  ? selectedDataset.name.slice(0, 24) + "…"
                  : selectedDataset.name
                : "Select Dataset"}
            <svg className="analytics-dataset-select__chevron" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {datasetOpen && (
            <div className="analytics-search-bar__menu analytics-dataset-select__menu" id="dataset-listbox" role="listbox">
              <button
                type="button"
                role="option"
                aria-selected={draftDatasetIds.length === 0}
                className={draftDatasetIds.length === 0 ? "is-selected" : ""}
                onClick={clearDatasetSelection}
              >
                <b>All datasets</b>
              </button>
              {visibleDatasets.map((dataset) => (
                <button
                  type="button"
                  role="option"
                  key={dataset.id}
                  aria-selected={draftDatasetIds.includes(dataset.id)}
                  className={draftDatasetIds.includes(dataset.id) ? "is-selected" : ""}
                  onClick={() => selectDataset(dataset.id)}
                  title={dataset.name}
                >
                  {dataset.name}
                </button>
              ))}
              {visibleDatasets.length === 0 && (
                <div className="analytics-search-bar__empty">No datasets available</div>
              )}
            </div>
          )}
        </div>

        {rightSlot && <div className="analytics-search-scope__right">{rightSlot}</div>}
      </div>
    </section>
  );
}