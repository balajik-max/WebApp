import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  fetchDatasetFeatureTable,
  fetchLayerFeatureTable,
  type FeatureTablePage,
  type FeatureTableRow,
  type LayerFeatureTableFilter,
} from "../lib/workflow";
import { buildCsv, csvTimestamp, downloadCsv, normalizeCsvValue, sanitizeLayerName } from "../lib/csvExport";

// Fetch in bounded API chunks, then combine them into one continuous table.
// This avoids one oversized backend query while keeping pagination out of the
// user experience.
const FETCH_CHUNK_SIZE = 1000;

interface Props {
  datasetId?: string;
  datasetName: string;
  layerFilter?: LayerFeatureTableFilter;
  scopeLabel?: string;
  onLocateFeature?: (row: FeatureTableRow) => void;
  onClose: () => void;
}

function severityClass(v: number): string {
  if (v >= 0.7) return "severity-high";
  if (v >= 0.4) return "severity-medium";
  return "severity-low";
}

function formatCell(v: unknown): { text: string; isNull: boolean; isLong: boolean } {
  if (v === null || v === undefined || v === "") {
    return { text: "—", isNull: true, isLong: false };
  }
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return { text: s, isNull: false, isLong: s.length > 60 };
  }
  const s = String(v);
  return { text: s, isNull: false, isLong: s.length > 60 };
}

function renderAttributeCells(row: FeatureTableRow, columns: string[]) {
  return columns.map((column) => {
    const cell = formatCell(row.attributes[column]);
    return (
      <td
        key={column}
        className={`${cell.isNull ? "is-null" : ""} ${cell.isLong ? "attr-long" : ""}`}
        title={cell.isLong ? cell.text : undefined}
      >
        {cell.text}
      </td>
    );
  });
}

export function AttributeTable({ datasetId, datasetName, layerFilter, scopeLabel, onLocateFeature, onClose }: Props) {
  const navigate = useNavigate();
  const [page, setPage] = useState<FeatureTablePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ row: FeatureTableRow; x: number; y: number } | null>(null);
  const datasetIdsKey = layerFilter?.datasetIds?.join(",") ?? "";

  useEffect(() => {
    const ctrl = new AbortController();
    setPage(null);
    setError(null);
    setLoading(true);

    const loadAllRows = async () => {
      const combinedRows: FeatureTableRow[] = [];
      let nextOffset = 0;
      let total = 0;

      do {
        const chunk = layerFilter
          ? await fetchLayerFeatureTable(layerFilter, FETCH_CHUNK_SIZE, nextOffset, ctrl.signal)
          : datasetId
            ? await fetchDatasetFeatureTable(datasetId, FETCH_CHUNK_SIZE, nextOffset, ctrl.signal)
            : await Promise.reject(new Error("No attribute-table data source was provided."));
        if (ctrl.signal.aborted) return;

        total = chunk.total;
        combinedRows.push(...chunk.rows);
        nextOffset += chunk.rows.length;
        setPage({
          ...chunk,
          limit: combinedRows.length,
          offset: 0,
          rows: [...combinedRows],
        });

        if (chunk.rows.length === 0) break;
      } while (nextOffset < total);
    };

    void loadAllRows()
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [datasetId, datasetIdsKey, layerFilter?.category, layerFilter?.ward, layerFilter?.severity]);

  useEffect(() => {
    if (!rowMenu) return;
    const closeMenu = () => setRowMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [rowMenu]);

  const openRowMenu = (row: FeatureTableRow, x: number, y: number) => {
    setSelectedRowId(row.id);
    setRowMenu({
      row,
      x: Math.max(8, Math.min(x, window.innerWidth - 224)),
      y: Math.max(8, Math.min(y, window.innerHeight - 104)),
    });
  };

  const locateFeature = (row: FeatureTableRow) => {
    setRowMenu(null);
    if (onLocateFeature) {
      onLocateFeature(row);
      return;
    }
    navigate(`/map?locateFeature=${encodeURIComponent(row.id)}`);
  };

  const sourceColumns = page?.columns ?? [];
  const canonicalColumn = (name: string) => name.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  const leadingColumns = ["layer", "shapelength", "shapearea"]
    .map((wanted) => sourceColumns.find((column) => canonicalColumn(column) === wanted))
    .filter((column): column is string => Boolean(column));
  const leadingColumnSet = new Set(leadingColumns);
  const otherColumns = sourceColumns.filter((column) => !leadingColumnSet.has(column));

  const canExport = Boolean(page) && !loading && page!.rows.length > 0;

  const handleExportCsv = useCallback(() => {
    if (!page || page.rows.length === 0) return;
    // Column order exactly matches the on-screen Attribute Table (the UI-only
    // `#` index column is intentionally omitted).
    const exportHeaders = ["FID", ...leadingColumns, "category", "severity", "label", ...otherColumns];
    const rows = page.rows.map((row) => {
      const cells: string[] = [];
      cells.push(normalizeCsvValue(row.fid));
      for (const column of leadingColumns) cells.push(normalizeCsvValue(row.attributes[column]));
      cells.push(normalizeCsvValue(row.category));
      cells.push(row.severity.toFixed(2));
      cells.push(normalizeCsvValue(row.label));
      for (const column of otherColumns) cells.push(normalizeCsvValue(row.attributes[column]));
      return cells;
    });
    const csv = buildCsv(exportHeaders, rows);
    const filename = `attribute-table-${sanitizeLayerName(datasetName)}-${csvTimestamp()}.csv`;
    downloadCsv(filename, csv);
  }, [page, leadingColumns, otherColumns, datasetName]);

  return (
    <section className="attr-table-wrap" data-testid="attribute-table">
      <div className="attr-table-head">
        <div className="attr-table-head__title">
          <h3>Attribute Table — {datasetName}</h3>
          {page && (
            <span className="grid-head__count">
              {scopeLabel ? `${scopeLabel} · ` : ""}
              {page.total.toLocaleString()} features · {page.populated_column_count + 1} populated of {page.columns.length + 1} source columns
              {loading && page.rows.length < page.total ? ` · loading ${page.rows.length.toLocaleString()} of ${page.total.toLocaleString()}` : ""}
            </span>
          )}
        </div>
        <div className="attr-table-head__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={handleExportCsv}
            disabled={!canExport}
            title={!canExport ? "No rows available to export" : undefined}
            aria-label={`Export ${datasetName} attribute table as CSV`}
          >
            Export CSV
          </button>
          <button type="button" className="btn btn--danger btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {error && <div className="grid-error">{error}</div>}

      {page ? (
        <div className="attr-table-scroll">
          <table className="attr-table">
            <thead>
              <tr>
                <th>#</th>
                <th style={{ minWidth: 90 }}>FID</th>
                {leadingColumns.map((c) => (
                  <th key={c} style={{ minWidth: 120 }}>{c}</th>
                ))}
                <th style={{ minWidth: 120 }}>category</th>
                <th style={{ width: 80, textAlign: "right" }}>severity</th>
                <th style={{ minWidth: 140 }}>label</th>
                {otherColumns.map((c) => (
                  <th key={c} style={{ minWidth: 120 }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, idx) => (
                <tr
                  key={row.id}
                  className={selectedRowId === row.id ? "attr-table__row--selected" : undefined}
                  aria-selected={selectedRowId === row.id}
                  tabIndex={0}
                  data-testid={`attribute-row-${row.id}`}
                  onClick={() => setSelectedRowId(row.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openRowMenu(row, event.clientX, event.clientY);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedRowId(row.id);
                    }
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      openRowMenu(row, rect.left + 90, rect.top + Math.min(28, rect.height));
                    }
                  }}
                >
                  <td>{idx + 1}</td>
                  <td className="attr-fid">{row.fid}</td>
                  {renderAttributeCells(row, leadingColumns)}
                  <td className={`attr-category ${!row.category ? "is-null" : ""}`}>
                    {row.category ?? "—"}
                  </td>
                  <td className={`attr-severity ${severityClass(row.severity)}`}>
                    {row.severity.toFixed(2)}
                  </td>
                  <td className={`attr-label ${!row.label ? "is-null" : ""}`}>
                    {row.label ?? "—"}
                  </td>
                  {renderAttributeCells(row, otherColumns)}
                </tr>
              ))}
              {page.rows.length === 0 && (
                <tr>
                  <td colSpan={page.columns.length + 5} className="attr-table__empty">
                    No features match this layer and map selection.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid__empty">{error ? "Unable to load attribute table." : "Loading all attributes…"}</div>
      )}
      {rowMenu && createPortal(
        <div
          className="layer-context-menu attribute-row-context-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          role="menu"
          aria-label={`FID ${rowMenu.row.fid} actions`}
          data-testid="attribute-row-context-menu"
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="layer-context-menu__title">
            FID {rowMenu.row.fid} · {rowMenu.row.category ?? "uncategorized"}
          </div>
          <button type="button" role="menuitem" onClick={() => locateFeature(rowMenu.row)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
            Show on map
          </button>
        </div>,
        document.body
      )}
    </section>
  );
}
