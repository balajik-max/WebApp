import { useEffect, useState } from "react";
import { fetchDatasetFeatureTable, type FeatureTablePage } from "../lib/workflow";

const PAGE_SIZE = 50;

interface Props {
  datasetId: string;
  datasetName: string;
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

export function AttributeTable({ datasetId, datasetName, onClose }: Props) {
  const [page, setPage] = useState<FeatureTablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setPage(null);
    fetchDatasetFeatureTable(datasetId, PAGE_SIZE, offset, ctrl.signal)
      .then(setPage)
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [datasetId, offset]);

  const totalPages = page ? Math.max(1, Math.ceil(page.total / PAGE_SIZE)) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <section className="attr-table-wrap" data-testid="attribute-table">
      <div className="attr-table-head">
        <div>
          <h3>Attribute Table — {datasetName}</h3>
          {page && (
            <span className="grid-head__count">
              {page.total.toLocaleString()} features · {page.columns.length} columns · page {currentPage} of {totalPages}
            </span>
          )}
        </div>
        <button type="button" className="btn btn--danger btn--sm" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <div className="grid-error">{error}</div>}

      {page ? (
        <div className="attr-table-scroll">
          <table className="attr-table">
            <thead>
              <tr>
                <th>#</th>
                <th style={{ minWidth: 140 }}>label</th>
                <th style={{ minWidth: 120 }}>category</th>
                <th style={{ width: 80, textAlign: "right" }}>severity</th>
                {page.columns.map((c) => (
                  <th key={c} style={{ minWidth: 120 }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, idx) => (
                <tr key={row.id}>
                  <td>{offset + idx + 1}</td>
                  <td className={`attr-label ${!row.label ? "is-null" : ""}`}>
                    {row.label ?? "—"}
                  </td>
                  <td className={`attr-category ${!row.category ? "is-null" : ""}`}>
                    {row.category ?? "—"}
                  </td>
                  <td className={`attr-severity ${severityClass(row.severity)}`}>
                    {row.severity.toFixed(2)}
                  </td>
                  {page.columns.map((c) => {
                    const cell = formatCell(row.attributes[c]);
                    return (
                      <td
                        key={c}
                        className={`${cell.isNull ? "is-null" : ""} ${cell.isLong ? "attr-long" : ""}`}
                        title={cell.isLong ? cell.text : undefined}
                      >
                        {cell.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid__empty">Loading attribute table…</div>
      )}

      {page && page.total > PAGE_SIZE && (
        <div className="attr-table-pager">
          <button
            type="button"
            className="btn btn--sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            ← Previous
          </button>
          <span style={{ fontSize: 11, color: "var(--ink-mute)", fontFamily: "var(--font-mono)" }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={offset + PAGE_SIZE >= page.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next →
          </button>
        </div>
      )}
    </section>
  );
}
