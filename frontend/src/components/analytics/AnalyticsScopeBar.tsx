import { useEffect, useMemo, useRef, useState } from "react";
import type { CategoryOption, DatasetRow } from "../../lib/workflow";

interface Choice {
  value: string;
  label: string;
  detail?: string;
  count?: number;
}

type SelectionMode = "toggle" | "single-unless-shift";

interface MultiSelectProps {
  label: string;
  allLabel: string;
  searchPlaceholder: string;
  options: Choice[];
  value: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
  selectionMode?: SelectionMode;
  helperText?: string;
}

function MultiSelect({
  label,
  allLabel,
  searchPlaceholder,
  options,
  value,
  onChange,
  loading = false,
  disabled = false,
  selectionMode = "toggle",
  helperText,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selected = useMemo(() => new Set(value), [value]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = useMemo(() => {
    const sorted = [...options].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true })
    );
    return normalizedQuery
      ? sorted.filter((option) =>
          `${option.label} ${option.detail ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)
        )
      : sorted;
  }, [normalizedQuery, options]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
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

  const summary =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? options.find((option) => option.value === value[0])?.label ?? value[0]
        : `${value.length} selected`;

  function selectOption(optionValue: string, shiftKey: boolean) {
    if (selectionMode === "single-unless-shift" && !shiftKey) {
      // Normal click is intentionally single-select. Clicking the only
      // selected category again clears the explicit selection, which means
      // "All categories" for Analytics.
      if (value.length === 1 && selected.has(optionValue)) onChange([]);
      else onChange([optionValue]);
      return;
    }

    // Dataset selection keeps its existing toggle behaviour. Category
    // selection reaches this branch only while Shift is held, enabling
    // deliberate multi-category analysis without accidental accumulation.
    if (selected.has(optionValue)) onChange(value.filter((item) => item !== optionValue));
    else onChange([...value, optionValue]);
  }

  return (
    <div className="analytics-multiselect" ref={rootRef}>
      <span className="analytics-scope__field-label">{label}</span>
      <button
        type="button"
        className={`analytics-multiselect__trigger${open ? " analytics-multiselect__trigger--open" : ""}`}
        onClick={() => !disabled && setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{loading ? "Loading…" : summary}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 7.5 10 12l4.5-4.5" /></svg>
      </button>

      {open && (
        <div className="analytics-multiselect__menu">
          <div className="analytics-multiselect__search-wrap">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </div>
          {helperText && <div className="analytics-multiselect__hint">{helperText}</div>}
          <div className="analytics-multiselect__list" role="listbox" aria-multiselectable="true">
            {!normalizedQuery && (
              <button
                type="button"
                role="option"
                aria-selected={value.length === 0}
                className={value.length === 0 ? "is-selected" : ""}
                onClick={() => onChange([])}
              >
                <span className="analytics-multiselect__check">{value.length === 0 ? "✓" : ""}</span>
                <span className="analytics-multiselect__option-main">
                  <b>{allLabel}</b>
                  <small>{options.length} available</small>
                </span>
              </button>
            )}
            {visibleOptions.map((option) => {
              const isSelected = selected.has(option.value);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={isSelected ? "is-selected" : ""}
                  key={option.value}
                  onClick={(event) => selectOption(option.value, event.shiftKey)}
                  title={selectionMode === "single-unless-shift" ? "Click for one category. Shift+click to add or remove multiple categories." : undefined}
                >
                  <span className="analytics-multiselect__check">{isSelected ? "✓" : ""}</span>
                  <span className="analytics-multiselect__option-main">
                    <b>{option.label}</b>
                    {option.detail && <small>{option.detail}</small>}
                  </span>
                  {option.count !== undefined && <span className="analytics-multiselect__count">{option.count.toLocaleString()}</span>}
                </button>
              );
            })}
            {!loading && visibleOptions.length === 0 && (
              <div className="analytics-multiselect__empty">No matching options</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  datasets: DatasetRow[];
  categories: CategoryOption[];
  draftDatasetIds: string[];
  draftCategories: string[];
  appliedDatasetIds: string[];
  appliedCategories: string[];
  loadingDatasets: boolean;
  loadingCategories: boolean;
  analyzing: boolean;
  onDatasetChange: (values: string[]) => void;
  onCategoryChange: (values: string[]) => void;
  onAnalyze: () => void;
  onReset: () => void;
}

function sameValues(a: string[], b: string[]) {
  return [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
}

export function AnalyticsScopeBar({
  datasets,
  categories,
  draftDatasetIds,
  draftCategories,
  appliedDatasetIds,
  appliedCategories,
  loadingDatasets,
  loadingCategories,
  analyzing,
  onDatasetChange,
  onCategoryChange,
  onAnalyze,
  onReset,
}: Props) {
  const datasetChoices: Choice[] = datasets.map((dataset) => ({
    value: dataset.id,
    label: dataset.name,
    detail: [dataset.ward ? `Ward ${dataset.ward}` : null, dataset.status].filter(Boolean).join(" · "),
  }));
  const categoryChoices: Choice[] = categories.map((category) => ({
    value: category.category,
    label: category.category,
    count: category.count,
  }));
  const dirty =
    !sameValues(draftDatasetIds, appliedDatasetIds) ||
    !sameValues(draftCategories, appliedCategories);

  return (
    <section className="analytics-scope" data-testid="analytics-scope">
      <div className="analytics-scope__intro">
        <div className="analytics-scope__eyebrow">Analysis scope</div>
        <h3>Select datasets and categories</h3>
        <p>Zero selected categories means every real category in the selected dataset scope.</p>
      </div>
      <div className="analytics-scope__controls">
        <MultiSelect
          label="Datasets"
          allLabel="All datasets"
          searchPlaceholder="Search datasets…"
          options={datasetChoices}
          value={draftDatasetIds}
          onChange={onDatasetChange}
          loading={loadingDatasets}
        />
        <MultiSelect
          label="Categories"
          allLabel="All categories"
          searchPlaceholder="Search categories…"
          options={categoryChoices}
          value={draftCategories}
          onChange={onCategoryChange}
          loading={loadingCategories}
          disabled={loadingCategories}
          selectionMode="single-unless-shift"
          helperText="Click selects one category. Hold Shift while clicking to select multiple categories."
        />
        <div className="analytics-scope__actions">
          <button type="button" className="analytics-scope__analyze" onClick={onAnalyze} disabled={analyzing || loadingCategories}>
            {analyzing ? "Analyzing…" : dirty ? "Analyze changes" : "Analyze"}
          </button>
          <button type="button" className="analytics-scope__reset" onClick={onReset}>Reset</button>
        </div>
      </div>
      <div className="analytics-scope__applied">
        <b>Applied:</b>
        <span>{appliedDatasetIds.length === 0 ? "All datasets" : `${appliedDatasetIds.length} dataset${appliedDatasetIds.length === 1 ? "" : "s"}`}</span>
        <span className="analytics-scope__divider">/</span>
        <span>{appliedCategories.length === 0 ? "All categories" : `${appliedCategories.length} categor${appliedCategories.length === 1 ? "y" : "ies"}`}</span>
        {dirty && <em>Draft selection has unapplied changes</em>}
      </div>
    </section>
  );
}
