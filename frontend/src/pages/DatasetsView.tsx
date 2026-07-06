import { useCallback, useEffect, useRef, useState } from "react";
import { deleteDataset, fetchDatasets, updateDataset, type DatasetRow } from "../lib/workflow";
import { AttributeTable } from "../components/AttributeTable";

const REFRESH_MS = 4000;

// Kept in sync with the backend reader registry (GISReader + TableReader) —
// anything outside this list will always fail ingestion.
const ACCEPTED_EXTENSIONS = [
  ".geojson",
  ".json",
  ".zip",
  ".gpkg",
  ".kml",
  ".csv",
  ".tsv",
  ".xlsx",
  ".xls",
];

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

export function DatasetsView() {
  const [rows, setRows] = useState<DatasetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadWard, setUploadWard] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [openTableFor, setOpenTableFor] = useState<DatasetRow | null>(null);
  const [editingWardId, setEditingWardId] = useState<string | null>(null);
  const [wardDraft, setWardDraft] = useState("");
  const [wardSaving, setWardSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchDatasets(signal);
      setRows(data);
      setError(null);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [refresh]);

  function pickFile(f: File | null) {
    if (f && !ACCEPTED_EXTENSIONS.includes(extensionOf(f.name))) {
      setUploadFile(null);
      setUploadError(
        `Unsupported file type "${extensionOf(f.name) || f.name}". ` +
          `Supported: GeoJSON, zipped Shapefile, GeoPackage, KML, CSV, TSV, XLSX.`
      );
      return;
    }
    setUploadError(null);
    setUploadFile(f);
    if (f && !uploadName.trim()) setUploadName(f.name.replace(/\.[^.]+$/, ""));
  }

  async function removeDataset(id: string, name: string) {
    if (!window.confirm(`Remove dataset "${name}"? This cannot be undone.`)) return;
    setRemovingId(id);
    try {
      await deleteDataset(id);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemovingId(null);
    }
  }

  function startEditWard(d: DatasetRow) {
    setEditingWardId(d.id);
    setWardDraft(d.ward ?? "");
  }

  async function saveWard(id: string) {
    setWardSaving(true);
    try {
      await updateDataset(id, { ward: wardDraft.trim() || null });
      setEditingWardId(null);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWardSaving(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadFile) {
      setUploadError("Choose a file to upload.");
      return;
    }
    if (!uploadName.trim()) {
      setUploadError("Give the dataset a name.");
      return;
    }
    setUploadBusy(true);
    setUploadError(null);
    setUploadNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("name", uploadName.trim());
      if (uploadWard.trim()) fd.append("ward", uploadWard.trim());
      const res = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? ""}/api/v1/datasets/upload`,
        { method: "POST", credentials: "include", body: fd }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
      }
      const body = await res.json();
      setUploadFile(null);
      setUploadName("");
      setUploadWard("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setUploadNotice(`Queued: ${body.dataset?.name ?? uploadName} → poll status below.`);
      window.setTimeout(() => setUploadNotice(null), 4500);
      void refresh();
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <div className="datasets-page" data-testid="datasets-page">
      <section className="dropzone-wrap">
        <h2 className="page-title">Upload a survey dataset</h2>

        <form
          className={`dropzone${dragOver ? " dropzone--over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0] ?? null;
            if (f) pickFile(f);
          }}
          onSubmit={submit}
          data-testid="dropzone"
        >
          <div className="dropzone__hint">
            <div className="dropzone__eyebrow">drop file here</div>
            <p>
              or{" "}
              <label className="dropzone__browse" htmlFor="dz-file">
                browse
              </label>{" "}
              for GeoJSON · zipped Shapefile · GeoPackage · KML · CSV · TSV · XLSX
            </p>
            <input
              id="dz-file"
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(",")}
              data-testid="dropzone-file"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              disabled={uploadBusy}
              style={{ display: "none" }}
            />
            {uploadFile && (
              <div className="dropzone__picked" data-testid="picked-file">
                <b>{uploadFile.name}</b> · {formatBytes(uploadFile.size)}
              </div>
            )}
          </div>

          <div className="dropzone__fields">
            <label className="field field--inline">
              <span className="field__label">Dataset name</span>
              <input
                className="field__input"
                data-testid="upload-name"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="Ward 12 streetlights"
                disabled={uploadBusy}
              />
            </label>
            <label className="field field--inline">
              <span className="field__label">Ward (optional)</span>
              <input
                className="field__input"
                data-testid="upload-ward"
                value={uploadWard}
                onChange={(e) => setUploadWard(e.target.value)}
                placeholder="12"
                disabled={uploadBusy}
              />
            </label>
          </div>

          {uploadError && (
            <div className="dropzone__error" data-testid="upload-error" role="alert">
              {uploadError}
            </div>
          )}
          {uploadNotice && (
            <div className="dropzone__notice" data-testid="upload-notice">
              {uploadNotice}
            </div>
          )}

          <div className="dropzone__actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={uploadBusy || !uploadFile}
              data-testid="upload-submit"
            >
              {uploadBusy ? "uploading…" : "Upload & ingest"}
            </button>
          </div>
        </form>
      </section>

      <section className="grid-wrap">
        <div className="grid-head">
          <h2 className="page-title">Uploaded datasets</h2>
          <span className="grid-head__count" data-testid="dataset-count">
            {rows ? `${rows.length} rows` : "loading…"}
          </span>
        </div>

        {error && (
          <div className="grid-error" data-testid="datasets-error">
            {error}
          </div>
        )}

        <div className="grid" data-testid="dataset-grid" role="table">
          <div className="grid__head" role="row">
            <div>Name</div>
            <div>Ward</div>
            <div>Type</div>
            <div>Size</div>
            <div>Status</div>
            <div>Uploaded</div>
            <div></div>
          </div>
          {rows && rows.length > 0 ? (
            rows.map((d) => (
              <div
                className="grid__row"
                key={d.id}
                role="row"
                data-testid={`grid-row-${d.id}`}
              >
                <div title={d.description ?? d.name}>
                  <div className="grid__name">{d.name}</div>
                  {d.processing_error && (
                    <div className="grid__err">{d.processing_error}</div>
                  )}
                </div>
                <div className="grid__ward">
                  {editingWardId === d.id ? (
                    <>
                      <input
                        className="grid__ward-input"
                        value={wardDraft}
                        onChange={(e) => setWardDraft(e.target.value)}
                        placeholder="ward"
                        disabled={wardSaving}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={wardSaving}
                        onClick={() => void saveWard(d.id)}
                      >
                        {wardSaving ? "…" : "save"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="grid__ward-edit"
                      onClick={() => startEditWard(d)}
                      title="Click to edit ward"
                    >
                      {d.ward ?? "—"}
                    </button>
                  )}
                </div>
                <div className="grid__mono">{d.file_type}</div>
                <div className="grid__mono">{formatBytes(d.size_bytes ?? 0)}</div>
                <div>
                  <span className={`badge badge--${d.status}`}>{d.status}</span>
                </div>
                <div className="grid__mono grid__muted">{formatDate(d.created_at)}</div>
                <div className="grid__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    data-testid={`view-attrs-${d.id}`}
                    disabled={d.status !== "ready"}
                    onClick={() => setOpenTableFor(d)}
                  >
                    Attributes
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    data-testid={`remove-${d.id}`}
                    disabled={removingId === d.id}
                    onClick={() => void removeDataset(d.id, d.name)}
                  >
                    {removingId === d.id ? "removing…" : "Remove"}
                  </button>
                </div>
              </div>
            ))
          ) : rows === null ? (
            <div className="grid__empty">loading datasets…</div>
          ) : (
            <div className="grid__empty">No datasets uploaded yet. Drop one above.</div>
          )}
        </div>
      </section>

      {openTableFor && (
        <AttributeTable
          datasetId={openTableFor.id}
          datasetName={openTableFor.name}
          onClose={() => setOpenTableFor(null)}
        />
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
