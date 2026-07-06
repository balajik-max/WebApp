import { useEffect, useState } from "react";
import { fetchDatasetFeatureTable, type FeatureTablePage } from "../lib/workflow";

const PAGE_SIZE = 50;

interface Props {
  datasetId: string;
  datasetName: string;
  onClose: () => void;
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
          <h3 className="page-title" style={{ fontSize: 15 }}>
            Attribute table — {datasetName}
          </h3>
          {page && (
            <span className="grid-head__count">
              {page.total} features · {page.columns.length} attribute columns · page {currentPage} of {totalPages}
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
                <th>label</th>
                <th>category</th>
                <th>severity</th>
                {page.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.label ?? "—"}</td>
                  <td>{row.category ?? "—"}</td>
                  <td>{row.severity.toFixed(2)}</td>
                  {page.columns.map((c) => (
                    <td key={c}>{formatCell(row.attributes[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid__empty">loading attribute table…</div>
      )}

      {page && page.total > PAGE_SIZE && (
        <div className="attr-table-pager">
          <button
            type="button"
            className="btn btn--sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            ← prev
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={offset + PAGE_SIZE >= page.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            next →
          </button>
        </div>
      )}
    </section>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
