import { DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { useNavigate } from "react-router-dom";
import { PublicPortalHeader } from "../components/public/PublicPortalHeader";
import { PublicPortalNav } from "../components/public/PublicPortalNav";
import { usePublicAuth } from "../context/PublicAuthContext";
import {
  deletePublicDataset,
  fetchPublicDatasets,
  PublicApiError,
  type PublicDataset,
  uploadPublicDataset,
} from "../lib/publicPortal";

const REFRESH_MS = 4000;
const SHAPEFILE_EXTENSIONS = new Set([".shp", ".dbf", ".shx", ".prj", ".cpg"]);
const REQUIRED_SHAPEFILE_EXTENSIONS = [".shp", ".dbf", ".shx", ".prj"];
const ALLOWED_SINGLE_EXTENSIONS = new Set([".geojson", ".json", ".zip", ".gpkg", ".kml"]);

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

async function zipShapefile(files: File[]): Promise<File> {
  const invalid = files.find((file) => !SHAPEFILE_EXTENSIONS.has(extensionOf(file.name)));
  if (invalid) throw new Error("Select only one Shapefile bundle (.shp, .dbf, .shx, .prj and optional .cpg). ");
  const shp = files.filter((file) => extensionOf(file.name) === ".shp");
  if (shp.length !== 1) throw new Error("Select exactly one .shp file with its companion files.");
  const stem = baseName(shp[0].name).toLowerCase();
  const missing = REQUIRED_SHAPEFILE_EXTENSIONS.filter(
    (ext) => !files.some((file) => extensionOf(file.name) === ext && baseName(file.name).toLowerCase() === stem),
  );
  if (missing.length) throw new Error(`Missing Shapefile component(s): ${missing.join(", ")}.`);
  if (files.some((file) => baseName(file.name).toLowerCase() !== stem)) {
    throw new Error("All Shapefile components must have the same filename before the extension.");
  }
  const zip = new JSZip();
  files.forEach((file) => zip.file(file.name, file));
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], `${baseName(shp[0].name)}.zip`, { type: "application/zip" });
}

async function zipFolder(fileList: FileList): Promise<File> {
  if (!fileList.length) throw new Error("The selected folder is empty.");
  const first = fileList[0] as File & { webkitRelativePath?: string };
  const root = first.webkitRelativePath?.split("/")[0] || "dataset.gdb";
  if (!root.toLowerCase().endsWith(".gdb")) {
    throw new Error("Choose the complete File Geodatabase folder whose name ends with .gdb.");
  }
  const zip = new JSZip();
  for (let index = 0; index < fileList.length; index += 1) {
    const file = fileList[index] as File & { webkitRelativePath?: string };
    zip.file(file.webkitRelativePath || `${root}/${file.name}`, file);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], `${root}.zip`, { type: "application/zip" });
}

function formatSize(size: number | null) {
  if (!size) return "-";
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function statusLabel(dataset: PublicDataset) {
  if (dataset.status === "queued") return "Queued";
  if (dataset.status === "processing") return "Processing";
  if (dataset.status === "ready") return "Ready";
  if (dataset.status === "failed") return "Failed";
  return "Uploaded";
}

export default function PublicDatasets() {
  const navigate = useNavigate();
  const { logout } = usePublicAuth();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const [datasets, setDatasets] = useState<PublicDataset[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    document.body.classList.add("citizen-scroll");
    document.title = "My Datasets · Davanagere Smart Urban Survey";
    return () => document.body.classList.remove("citizen-scroll");
  }, []);

  const refresh = async () => {
    try {
      setDatasets(await fetchPublicDatasets());
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to load your datasets.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const readyCount = useMemo(() => datasets.filter((dataset) => dataset.status === "ready").length, [datasets]);

  const chooseFiles = async (files: File[]) => {
    setError(null);
    setSuccess(null);
    try {
      if (!files.length) throw new Error("Choose a geospatial dataset file.");
      let file: File;
      if (files.length > 1 || files.some((candidate) => SHAPEFILE_EXTENSIONS.has(extensionOf(candidate.name)))) {
        file = await zipShapefile(files);
      } else {
        file = files[0];
        if (!ALLOWED_SINGLE_EXTENSIONS.has(extensionOf(file.name))) {
          throw new Error("Supported files are GeoJSON, KML, GeoPackage, zipped Shapefile, and zipped File Geodatabase.");
        }
      }
      setSelectedFile(file);
      setName(baseName(file.name).replace(/\.gdb$/i, ""));
    } catch (reason) {
      setSelectedFile(null);
      setError(reason instanceof Error ? reason.message : "Unable to prepare the selected files.");
    }
  };

  const chooseFolder = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const file = await zipFolder(files);
      setSelectedFile(file);
      setName(baseName(file.name).replace(/\.gdb$/i, ""));
    } catch (reason) {
      setSelectedFile(null);
      setError(reason instanceof Error ? reason.message : "Unable to prepare the selected folder.");
    } finally {
      setBusy(false);
      if (folderInput.current) folderInput.current.value = "";
    }
  };

  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length) void chooseFiles(files);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedFile || !name.trim()) {
      setError("Choose a dataset and enter a dataset name.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await uploadPublicDataset(selectedFile, name.trim(), description);
      setSuccess("Dataset uploaded. Processing has started; it will become available on the map when the status is Ready.");
      setSelectedFile(null);
      setName("");
      setDescription("");
      if (fileInput.current) fileInput.current.value = "";
      await refresh();
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to upload the dataset.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (dataset: PublicDataset) => {
    if (!window.confirm(`Delete \"${dataset.name}\"? This removes only your public dataset.`)) return;
    try {
      await deletePublicDataset(dataset.id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to delete the dataset.");
    }
  };

  const signOut = async () => {
    await logout();
    navigate("/public/login", { replace: true });
  };

  return (
    <div className="citizen-dashboard-page public-datasets-page">
      <PublicPortalHeader />
      <PublicPortalNav />
      <main className="public-workspace">
        <header className="public-workspace__heading">
          <div>
            <p className="citizen-eyebrow">Citizen geospatial workspace</p>
            <h1>My Datasets</h1>
            <p>Upload your own geospatial data and open it safely on the public map.</p>
          </div>
          <div className="public-workspace__actions">
            <span><strong>{datasets.length}</strong> total</span>
            <span><strong>{readyCount}</strong> ready</span>
            <button className="citizen-secondary-button" type="button" onClick={() => void signOut()}>Sign Out</button>
          </div>
        </header>

        {success && <div className="citizen-alert citizen-alert--success">{success}</div>}
        {error && <div className="citizen-alert citizen-alert--error">{error}</div>}

        <section className="public-dataset-grid">
          <form className="public-dataset-upload-card" onSubmit={submit}>
            <div className="public-card-heading">
              <div className="public-card-icon">↑</div>
              <div><h2>Upload New Dataset</h2><p>Add data to your private public-user workspace.</p></div>
            </div>
            <div
              className="public-dataset-dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={dropFiles}
            >
              <input
                ref={fileInput}
                type="file"
                multiple
                accept=".geojson,.json,.zip,.gpkg,.kml,.shp,.dbf,.shx,.prj,.cpg"
                onChange={(event) => void chooseFiles(Array.from(event.target.files ?? []))}
              />
              <input
                ref={folderInput}
                type="file"
                // @ts-expect-error Chromium folder picker extension
                webkitdirectory=""
                onChange={(event) => void chooseFolder(event.target.files)}
              />
              <div className="public-upload-symbol">⇧</div>
              <strong>Drag and drop a file here</strong>
              <p>
                or <button type="button" onClick={() => fileInput.current?.click()}>browse files</button>
                {" · "}<button type="button" onClick={() => folderInput.current?.click()}>browse a .gdb folder</button>
              </p>
              <small>GeoJSON · KML · GeoPackage · zipped Shapefile · File Geodatabase</small>
            </div>
            {selectedFile && <div className="public-selected-file"><strong>{selectedFile.name}</strong><span>{formatSize(selectedFile.size)}</span></div>}
            <label><span>Dataset Name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={255} required /></label>
            <label><span>Description (optional)</span><input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1024} /></label>
            <button className="citizen-primary-button" type="submit" disabled={busy || !selectedFile}>{busy ? "Preparing…" : "Upload Dataset"}</button>
          </form>

          <aside className="public-dataset-help-card">
            <h2>How it works</h2>
            <ol>
              <li><strong>Upload your geospatial data</strong><span>The file stays linked to your public account.</span></li>
              <li><strong>Wait for Ready status</strong><span>The same GIS reading engine processes the geometry in an isolated public table.</span></li>
              <li><strong>View it on the map</strong><span>Only you can open or delete your uploaded datasets.</span></li>
            </ol>
            <div className="public-security-note"><strong>Officer features are protected</strong><span>Your uploads do not enter officer datasets, analytics, AI findings or workflows.</span></div>
          </aside>
        </section>

        <section className="public-dataset-list-card">
          <div className="public-card-heading"><div><h2>Uploaded Datasets</h2><p>Datasets become map-ready after processing.</p></div><button className="public-icon-button" type="button" onClick={() => void refresh()} aria-label="Refresh datasets">↻</button></div>
          {loading ? <div className="citizen-empty">Loading datasets…</div> : datasets.length === 0 ? <div className="citizen-empty">No datasets uploaded yet.</div> : (
            <div className="public-dataset-table-wrap">
              <table className="public-dataset-table">
                <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Uploaded</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {datasets.map((dataset) => (
                    <tr key={dataset.id}>
                      <td><strong>{dataset.name}</strong>{dataset.processing_error && <small>{dataset.processing_error}</small>}</td>
                      <td>{dataset.file_type === "shapefile" ? "Shapefile / GDB" : dataset.file_type}</td>
                      <td>{formatSize(dataset.size_bytes)}</td>
                      <td>{new Date(dataset.created_at).toLocaleString()}</td>
                      <td><span className={`public-dataset-status public-dataset-status--${dataset.status}`}>{statusLabel(dataset)}</span></td>
                      <td>
                        <div className="public-table-actions">
                          <button className="citizen-secondary-button" type="button" disabled={dataset.status !== "ready"} onClick={() => navigate(`/public/map?dataset=${encodeURIComponent(dataset.id)}`)}>View on Map</button>
                          <button className="public-delete-button" type="button" onClick={() => void remove(dataset)} aria-label={`Delete ${dataset.name}`}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
