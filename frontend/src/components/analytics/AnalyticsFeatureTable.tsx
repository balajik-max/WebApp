import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  fetchAnalyticsFeatureTable,
  type AnalyticsFeaturePage,
  type AnalyticsFeatureRow,
} from "../../lib/workflow";

const PAGE_SIZE = 50;
const TABLE_STATE_KEY = "davangere.analytics.feature-table.v1";

interface Props {
  datasetIds: string[];
  categories: string[];
}

interface RowMenuState {
  row: AnalyticsFeatureRow;
  x: number;
  y: number;
}

interface StoredTableState {
  scopeKey: string;
  offset: number;
  selectedRowId: string | null;
}

function severityLabel(value: number) {
  if (value >= 0.67) return "High";
  if (value >= 0.34) return "Medium";
  return "Low";
}

function readTableState(scopeKey: string): StoredTableState | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(TABLE_STATE_KEY) ?? "null") as Partial<StoredTableState> | null;
    if (!parsed || parsed.scopeKey !== scopeKey) return null;
    return {
      scopeKey,
      offset: typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0,
      selectedRowId: typeof parsed.selectedRowId === "string" ? parsed.selectedRowId : null,
    };
  } catch {
    return null;
  }
}

export function AnalyticsFeatureTable({ datasetIds, categories }: Props) {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AnalyticsFeaturePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  const scopeKey = useMemo(
    () => `${[...datasetIds].sort().join(",")}|${[...categories].sort().join(",")}`,
    [categories, datasetIds]
  );

  useEffect(() => {
    const stored = readTableState(scopeKey);
    setOffset(stored?.offset ?? 0);
    setSelectedRowId(stored?.selectedRowId ?? null);
    setRowMenu(null);
  }, [scopeKey]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        TABLE_STATE_KEY,
        JSON.stringify({ scopeKey, offset, selectedRowId } satisfies StoredTableState)
      );
    } catch {
      // Storage can be blocked by browser policy. Analytics still works in-memory.
    }
  }, [offset, scopeKey, selectedRowId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchAnalyticsFeatureTable(datasetIds, categories, PAGE_SIZE, offset, controller.signal)
      .then(setPage)
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(caught.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [categories, datasetIds, offset, scopeKey]);

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

  function openRowMenu(row: AnalyticsFeatureRow, x: number, y: number) {
    setSelectedRowId(row.id);
    setRowMenu({
      row,
      x: Math.max(8, Math.min(x, window.innerWidth - 224)),
      y: Math.max(8, Math.min(y, window.innerHeight - 104)),
    });
  }

  function locateFeature(row: AnalyticsFeatureRow) {
    setSelectedRowId(row.id);
    setRowMenu(null);
    navigate(`/map?locateFeature=${encodeURIComponent(row.id)}`);
  }

  const total = page?.total ?? 0;
  const pageNumber = total === 0 ? 0 : Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = total === 0 ? 0 : Math.ceil(total / PAGE_SIZE);

  return (
    <article className="chart-card analytics-feature-card" data-testid="analytics-feature-table">
      <div className="chart-card__header">
        <div>
          <div className="analytics-card-eyebrow">Feature rows</div>
          <h3 className="chart-card__title">Scoped Feature Table</h3>
          <small className="analytics-feature-table__hint">Right-click any feature row and choose “Show on map”.</small>
        </div>
        <span className="chart-card__badge">{total.toLocaleString()} total</span>
      </div>
      <div className="analytics-feature-table-wrap">
        {error && <div className="analytics-inline-error">Table unavailable: {error}</div>}
        <table className="analytics-feature-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>Category</th>
              <th>Dataset</th>
              <th>Ward</th>
              <th>Geometry</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            {!loading && page?.rows.map((row) => (
              <tr
                key={row.id}
                className={selectedRowId === row.id ? "is-selected" : undefined}
                aria-selected={selectedRowId === row.id}
                tabIndex={0}
                data-testid={`analytics-feature-row-${row.id}`}
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
                <td title={row.id}>{row.label || row.id.slice(0, 8)}</td>
                <td>{row.category}</td>
                <td>{row.dataset_name}</td>
                <td>{row.ward || "—"}</td>
                <td>{row.geometry_type.replace(/^ST_/, "")}</td>
                <td>
                  <span className={`analytics-severity analytics-severity--${severityLabel(row.severity).toLowerCase()}`}>
                    {severityLabel(row.severity)} · {row.severity.toFixed(2)}
                  </span>
                </td>
              </tr>
            ))}
            {loading && (
              <tr><td colSpan={6} className="analytics-feature-table__empty">Loading applied-scope rows…</td></tr>
            )}
            {!loading && !error && page?.rows.length === 0 && (
              <tr><td colSpan={6} className="analytics-feature-table__empty">No features match the applied scope.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="analytics-feature-table__pager">
        <span>Page {pageNumber} of {pageCount}</span>
        <div>
          <button type="button" onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))} disabled={offset === 0 || loading}>Previous</button>
          <button type="button" onClick={() => setOffset((current) => current + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading}>Next</button>
        </div>
      </div>

      {rowMenu && createPortal(
        <div
          className="layer-context-menu attribute-row-context-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          role="menu"
          aria-label={`${rowMenu.row.category} feature actions`}
          data-testid="analytics-feature-row-context-menu"
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="layer-context-menu__title">
            {rowMenu.row.label || rowMenu.row.id.slice(0, 8)} · {rowMenu.row.category}
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
    </article>
  );
}
