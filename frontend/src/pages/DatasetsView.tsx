import React, { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { deleteDataset, fetchDatasets, updateDataset, assignSourceCrs, type DatasetRow } from "../lib/workflow";
import { AttributeTable } from "../components/AttributeTable";
import { UnclassifiedCategoriesPanel } from "../components/UnclassifiedCategoriesPanel";
import { useLanguage } from "../context/LanguageContext";

const REFRESH_MS = 4000;

const ACCEPTED_EXTENSIONS = [
  ".geojson", ".json", ".zip", ".shp", ".dbf", ".shx", ".prj", ".cpg", ".gpkg", ".kml", ".csv", ".tsv", ".xlsx", ".xls",
  ".tif", ".tiff", ".geotiff", ".las", ".laz", ".obj",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp",
];

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];
const SHAPEFILE_EXTENSIONS = [".shp", ".dbf", ".shx", ".prj", ".cpg"];
const REQUIRED_SHAPEFILE_EXTENSIONS = [".shp", ".dbf", ".shx", ".prj"];

// File System Access API â€” not yet in TS's DOM lib. Only Chromium ships it;
// callers must feature-detect `window.showDirectoryPicker` before use.
declare global {
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>;
  }
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}


const FILE_TYPE_INFO: Record<string, { icon: React.ReactNode; label: string }> = {
  shapefile: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    label: "Shapefile",
  },
  geojson: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    label: "GeoJSON",
  },
  gpkg: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    label: "GeoPackage",
  },
  kml: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    label: "KML",
  },
  csv: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    label: "CSV / TSV",
  },
  xlsx: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" /><path d="M14 3v4a1 1 0 001 1h4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    label: "Excel",
  },
  tif: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    label: "GeoTIFF",
  },
  lidar: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><circle cx="6" cy="7" r="1.1" fill="currentColor" stroke="none" /><circle cx="12" cy="4.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="18.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="4" cy="13" r="1.1" fill="currentColor" stroke="none" /><circle cx="10.5" cy="11.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="16.5" cy="13.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="20.5" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="7.5" cy="18.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="13.5" cy="19.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="19" cy="18" r="1.1" fill="currentColor" stroke="none" /></svg>,
    label: "LiDAR",
  },
  obj: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    label: "3D Model",
  },
  image: {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M4 6h16M4 6a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2M4 6l4-4h8l4 4" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9" cy="10" r="1.5" /></svg>,
    label: "Site Photo",
  },
};

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

// Best-effort extraction of a ward name/number from an uploaded filename,
// e.g. "Davangere Ghandinagar Ward.gdb-20260708T103425Z-3-001.zip" ->
// "Ghandinagar", or "Ward 12 streetlights.geojson" -> "12". Returns null
// when nothing looks ward-like, so the field is left for the user to fill.
function guessWardFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.[^.]+$/, "");
  const before = stem.match(/([A-Za-z]+)\s+Ward\b/i);
  if (before) return before[1];
  const after = stem.match(/\bWard[\s_-]+([A-Za-z0-9]+)/i);
  if (after) return after[1];
  return null;
}

// A raw .gdb (File Geodatabase) is a *folder*, not a single file â€” the
// browser file APIs only ever hand us a placeholder for a dropped/selected
// directory, never its contents, unless we explicitly walk it. These
// helpers read every file inside an unzipped .gdb folder and zip it
// client-side into the exact structure the backend's zipped-GDB reader
// already knows how to open (a <name>.gdb/ directory at the zip root) â€”
// no backend change needed, it just never sees the difference.
interface WebkitFileEntry {
  isFile: true;
  isDirectory: false;
  name: string;
  file: (success: (f: File) => void, error: (e: Error) => void) => void;
}
interface WebkitDirEntry {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader: () => { readEntries: (success: (e: WebkitEntry[]) => void, error: (e: Error) => void) => void };
}
type WebkitEntry = WebkitFileEntry | WebkitDirEntry;

async function readEntriesBatch(reader: {
  readEntries: (success: (e: WebkitEntry[]) => void, error: (e: Error) => void) => void;
}): Promise<WebkitEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function readAllDirEntries(dirEntry: WebkitDirEntry): Promise<WebkitEntry[]> {
  const reader = dirEntry.createReader();
  const all: WebkitEntry[] = [];
  // readEntries() only returns a batch at a time â€” must keep calling until empty.
  let batch = await readEntriesBatch(reader);
  while (batch.length > 0) {
    all.push(...batch);
    batch = await readEntriesBatch(reader);
  }
  return all;
}

async function walkEntry(entry: WebkitEntry, basePath: string, out: { path: string; file: File }[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    out.push({ path: `${basePath}${entry.name}`, file });
  } else {
    const children = await readAllDirEntries(entry);
    for (const child of children) {
      await walkEntry(child, `${basePath}${entry.name}/`, out);
    }
  }
}

async function collectDroppedFolder(rootEntry: WebkitDirEntry): Promise<{ path: string; file: File }[]> {
  const collected: { path: string; file: File }[] = [];
  await walkEntry(rootEntry, "", collected);
  return collected;
}

function collectPickedFolder(fileList: FileList): { name: string; files: { path: string; file: File }[] } {
  const first = fileList[0] as File & { webkitRelativePath?: string };
  const topFolder = first.webkitRelativePath?.split("/")[0] || "folder";
  const files: { path: string; file: File }[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i] as File & { webkitRelativePath?: string };
    files.push({ path: f.webkitRelativePath || f.name, file: f });
  }
  return { name: topFolder, files };
}

// Thrown when a granted folder is too big to walk automatically (e.g. the
// user picked a whole drive by mistake) â€” distinct from AbortError/
// SecurityError so the caller can give an actionable message instead of
// treating it like a declined prompt.
class FolderScanLimitError extends Error {}

const MAX_SCAN_ENTRIES = 2000;
const MAX_SCAN_DEPTH = 4;

async function walkDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string,
  depth: number,
  out: { path: string; file: File }[]
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    throw new FolderScanLimitError("That folder is nested too deep to scan automatically â€” choose the folder that directly contains the .obj (or its parent, if it has a metadata.xml).");
  }
  for await (const entry of dirHandle.values()) {
    if (out.length > MAX_SCAN_ENTRIES) {
      throw new FolderScanLimitError("That folder has too many files to scan automatically â€” choose a smaller folder, ideally the one that directly contains the .obj.");
    }
    const path = `${basePath}${entry.name}`;
    if (entry.kind === "directory") {
      await walkDirectoryHandle(entry as FileSystemDirectoryHandle, `${path}/`, depth + 1, out);
    } else {
      out.push({ path, file: await (entry as FileSystemFileHandle).getFile() });
    }
  }
}

// A ContextCapture/Bentley-style tiled mesh export (what the drone survey
// pipeline behind this platform produces) carries its real-world anchor â€”
// SRS + the point the OBJ's local meter offsets are measured from â€” in a
// `metadata.xml` file. That file conventionally sits *next to* the tile
// folder, not inside it (e.g. "3D MODEL/metadata.xml" alongside
// "3D MODEL/Block0/Block0.obj") â€” sniff by content, not name, since the
// convention isn't universal, and it may not be present at all.
async function isGeoMetadataFile(file: File): Promise<boolean> {
  if (extensionOf(file.name) !== ".xml" || file.size > 65_536) return false;
  try {
    return (await file.text()).includes("<SRSOrigin");
  } catch {
    return false;
  }
}

// A single bare .obj (picked via the plain file input, or dropped as one
// file) carries no path info a browser will ever hand us â€” there is no API
// that goes from a File back to its siblings on disk. The only way to pull
// in its .mtl/textures/geo-referencing without the user hand-picking them
// is to ask for a folder via the File System Access API and read it
// ourselves â€” walking subfolders too, since the geo-reference file is
// often one level above wherever the .obj itself lives.
async function collectObjCompanionsFromDisk(objFile: File): Promise<{ path: string; file: File }[]> {
  // Deliberately not caught here â€” the picker throws "AbortError" when the
  // user dismisses the dialog, and "SecurityError"/"NotAllowedError" when
  // Chromium decided this call isn't tied to a fresh-enough user gesture
  // (can happen chaining straight off an <input> change event). Callers
  // need to tell those apart, so let the error propagate.
  const dirHandle = await window.showDirectoryPicker!({ mode: "read" });
  const found: { path: string; file: File }[] = [];
  await walkDirectoryHandle(dirHandle, "", 0, found);

  const collected: { path: string; file: File }[] = [];
  for (const entry of found) {
    const ext = extensionOf(entry.file.name);
    if (ext === ".mtl" || IMAGE_EXTENSIONS.includes(ext) || entry.file.name === objFile.name) {
      collected.push(entry);
    } else if (ext === ".xml" && (await isGeoMetadataFile(entry.file))) {
      collected.push(entry);
    }
  }
  if (!collected.some((c) => c.file.name === objFile.name)) {
    collected.push({ path: objFile.name, file: objFile });
  }
  return collected;
}

async function zipCollectedFiles(name: string, files: { path: string; file: File }[]): Promise<File> {
  const zip = new JSZip();
  for (const { path, file } of files) zip.file(path, file);
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], `${name}.zip`, { type: "application/zip" });
}

function validateShapefileBundle(files: File[]): { stem: string; files: File[] } {
  const components = files.filter((file) => SHAPEFILE_EXTENSIONS.includes(extensionOf(file.name)));
  if (components.length !== files.length) {
    throw new Error("A shapefile selection can only contain .shp, .dbf, .shx, .prj, and optional .cpg files.");
  }

  const shpFiles = components.filter((file) => extensionOf(file.name) === ".shp");
  if (shpFiles.length !== 1) {
    throw new Error("Select exactly one .shp file together with its supporting files.");
  }

  const stem = shpFiles[0].name.replace(/\.shp$/i, "");
  const matching = components.filter(
    (file) => file.name.replace(/\.[^.]+$/, "").toLocaleLowerCase() === stem.toLocaleLowerCase()
  );
  if (matching.length !== components.length) {
    throw new Error(`All shapefile components must use the same basename as "${shpFiles[0].name}".`);
  }

  const extensions = new Set(matching.map((file) => extensionOf(file.name)));
  const missing = REQUIRED_SHAPEFILE_EXTENSIONS.filter((extension) => !extensions.has(extension));
  if (missing.length > 0) {
    throw new Error(`Missing required shapefile component${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
  }

  return { stem, files: matching };
}

function datasetDisplayType(dataset: DatasetRow): string {
  return dataset.dataset_metadata?.model_3d ? "OBJ 3D" : dataset.file_type;
}

function getFileIcon(type: string): React.ReactNode {
  // Map common variations to their base types
  const typeMap: Record<string, string> = {
    "tiff": "tif",
    "geotiff": "tif",
    "shapefile": "shapefile",
    "las": "lidar",
    "laz": "lidar",
  };
  const normalizedType = typeMap[type] ?? type;
  return FILE_TYPE_INFO[normalizedType]?.icon ?? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function DatasetsView() {
  const { t } = useLanguage();
  const [rows, setRows] = useState<DatasetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [storage, setStorage] = useState<{
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
    used_percent: number;
  } | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadWard, setUploadWard] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [objAutoNotice, setObjAutoNotice] = useState<string | null>(null);
  const [objAutoRetryFile, setObjAutoRetryFile] = useState<File | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [openTableFor, setOpenTableFor] = useState<DatasetRow | null>(null);
  const [editingWardId, setEditingWardId] = useState<string | null>(null);
  const [wardDraft, setWardDraft] = useState("");
  const [wardSaving, setWardSaving] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [crsAssignFor, setCrsAssignFor] = useState<DatasetRow | null>(null);
  const [crsInput, setCrsInput] = useState("");
  const [crsSaving, setCrsSaving] = useState(false);
  const [crsError, setCrsError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const photosInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/v1/system/storage`, {
      credentials: "include",
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setStorage(d))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

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
    setObjAutoNotice(null);
    setObjAutoRetryFile(null);
    if (f && !ACCEPTED_EXTENSIONS.includes(extensionOf(f.name))) {
      setUploadFile(null);
      setUploadError(
        `Unsupported file type "${extensionOf(f.name) || f.name}". Supported: GeoJSON, Shapefile, GeoPackage, KML, GeoTIFF, LAS/LAZ (LiDAR), OBJ, CSV, TSV, XLSX, and photos (JPG/PNG/GIF/BMP/WEBP).`
      );
      return;
    }
    setUploadError(null);
    setUploadFile(f);
    if (f && !uploadName.trim()) setUploadName(f.name.replace(/\.[^.]+$/, ""));
    // Best-effort ward suggestion from the filename (e.g. "Davangere
    // Ghandinagar Ward.gdb-...zip" -> "Ghandinagar") so re-uploading the
    // same survey doesn't silently drop its ward again â€” never overrides
    // a ward the user already typed.
    if (f && !uploadWard.trim()) {
      const guess = guessWardFromFilename(f.name);
      if (guess) setUploadWard(guess);
    }
  }

  async function pickShapefileBundle(files: File[]) {
    setUploadError(null);
    setZipping(true);
    try {
      const bundle = validateShapefileBundle(files);
      const zipped = await zipCollectedFiles(
        bundle.stem,
        bundle.files.map((file) => ({ path: file.name, file }))
      );
      pickFile(zipped);
    } catch (err) {
      setUploadFile(null);
      setUploadError((err as Error).message);
    } finally {
      setZipping(false);
    }
  }

  async function pickFiles(files: File[]) {
    if (files.length === 0) return;
    const allImages = files.every((file) => IMAGE_EXTENSIONS.includes(extensionOf(file.name)));
    const allShapefileComponents = files.every((file) => SHAPEFILE_EXTENSIONS.includes(extensionOf(file.name)));
    const isObjBundle = files.length > 1 && files.some((file) => extensionOf(file.name) === ".obj");

    if (allImages && files.length > 1) {
      await pickMultiplePhotos(files);
      return;
    }
    if (allShapefileComponents) {
      await pickShapefileBundle(files);
      return;
    }
    if (files.length === 1 && extensionOf(files[0].name) === ".obj") {
      // A bare .obj needs its .mtl/textures/metadata.xml pulled in from
      // disk automatically â€” see pickObjWithAutoCompanions for why this
      // can't just be pickFile(files[0]).
      await pickObjWithAutoCompanions(files[0]);
      return;
    }
    if (isObjBundle) {
      // Manual multi-select of a .obj plus its .mtl/textures together.
      const name = files.find((f) => extensionOf(f.name) === ".obj")!.name.replace(/\.[^/.]+$/, "");
      setZipping(true);
      try {
        const zipped = await zipCollectedFiles(name, files.map((file) => ({ path: file.name, file })));
        pickFile(zipped);
      } catch (err) {
        setUploadError(`Couldn't bundle 3D model files: ${(err as Error).message}`);
      } finally {
        setZipping(false);
      }
      return;
    }
    if (files.length === 1) {
      pickFile(files[0]);
      return;
    }

    setUploadFile(null);
    setUploadError(
      "Multiple files must be a batch of photos, one shapefile bundle (.shp + .dbf + .shx + .prj), or a 3D model bundle (.obj + .mtl + textures)."
    );
  }

  // Several individually selected/dropped photos are bundled into one zip
  // client-side (same JSZip mechanism the .gdb folder path already uses)
  // so they upload and ingest as a single dataset â€” the backend's
  // ImageReader unpacks the zip and geo-tags each photo from its own EXIF.
  async function pickMultiplePhotos(files: File[]) {
    setUploadError(null);
    setZipping(true);
    try {
      const zip = new JSZip();
      for (const f of files) zip.file(f.name, f);
      const blob = await zip.generateAsync({ type: "blob" });
      const zipped = new File([blob], `photos-${Date.now()}.zip`, { type: "application/zip" });
      pickFile(zipped);
    } catch (err) {
      setUploadError(`Couldn't bundle those photos: ${(err as Error).message}`);
    } finally {
      setZipping(false);
    }
  }

  // A bare .obj arriving alone (single browse-select or single drag/drop)
  // never carries its .mtl/textures/metadata.xml â€” the browser hands us
  // exactly the one File and nothing else. Rather than making the user
  // hunt down and multi-select the companion files themselves, immediately
  // ask for a folder (one native prompt) and pull the matching files in
  // ourselves. Falls back to the bare file â€” with an explanation â€” when the
  // API isn't supported, the user declines the prompt, or nothing is found.
  //
  // Shared by the automatic first attempt and the manual retry button below
  // â€” the retry button exists because Chromium sometimes refuses to open a
  // second native picker chained off an <input> change event (no fresh
  // enough user gesture), in which case a real click is the only way to
  // get a valid one.
  async function runObjAutoLoad(file: File) {
    setZipping(true);
    setObjAutoRetryFile(null);
    try {
      const companions = await collectObjCompanionsFromDisk(file);
      if (companions.length <= 1) {
        pickFile(file);
        setObjAutoNotice("âš ï¸ No .mtl or texture files were found next to this .obj â€” it will upload without materials.");
        return;
      }
      const hasGeoMeta = companions.some((c) => extensionOf(c.file.name) === ".xml");
      const name = file.name.replace(/\.[^/.]+$/, "");
      const zipped = await zipCollectedFiles(name, companions);
      pickFile(zipped);
      if (hasGeoMeta) {
        setObjAutoNotice("âœ“ Textures and geo-referencing (metadata.xml) loaded automatically.");
      } else {
        // Don't just warn and hope they know what to do â€” the metadata.xml
        // (when it exists) is conventionally one level *above* wherever the
        // .obj itself lives, so the folder they just granted was very
        // plausibly the wrong one. Offer the retry button right here
        // instead of making them notice a warning and manually reselect.
        setObjAutoRetryFile(file);
        setObjAutoNotice(
          "âš ï¸ Textures loaded, but no metadata.xml was found, so this model's map position may be approximate. If the export has one, click below and pick the PARENT of the folder you just chose."
        );
      }
    } catch (err) {
      pickFile(file);
      if (err instanceof FolderScanLimitError) {
        setObjAutoRetryFile(file);
        setObjAutoNotice(`âš ï¸ ${err.message}`);
      } else if ((err as Error).name === "AbortError") {
        setObjAutoNotice(
          "âš ï¸ Folder access was declined, so textures can't be auto-loaded. Reselect the .obj to try again, or use \"browse a folder\"."
        );
      } else {
        setObjAutoRetryFile(file);
        setObjAutoNotice("âš ï¸ Couldn't open the folder picker automatically â€” click below to grant folder access and load textures.");
      }
    } finally {
      setZipping(false);
    }
  }

  async function pickObjWithAutoCompanions(file: File) {
    if (typeof window.showDirectoryPicker !== "function") {
      pickFile(file);
      setObjAutoNotice(
        "âš ï¸ This browser can't auto-load companion files for a single .obj (Chrome/Edge only). Use \"browse a folder\" below, or drag the whole folder in, to include the .mtl and textures."
      );
      return;
    }
    await runObjAutoLoad(file);
  }

  // A dropped/browsed folder is supported if it's a File Geodatabase (by
  // name), a shapefile bundle, a folder full of photos (checked by content,
  // since a photo folder has no special naming convention), or a 3D model
  // folder/tree (contains an .obj somewhere) â€” the latter is what makes a
  // folder one level up from the .obj (i.e. containing a metadata.xml
  // geo-reference sibling to the model's own folder) work, since these
  // collectors already walk subfolders and grab everything, unfiltered.
  // Anything else is rejected with a clear reason before we waste time
  // zipping it.
  async function pickFolder(name: string, collectFiles: () => Promise<{ path: string; file: File }[]>) {
    setUploadError(null);
    setZipping(true);
    try {
      const files = await collectFiles();
      const isGdb = name.toLowerCase().endsWith(".gdb");
      const isAllImages = files.length > 0 && files.every(({ file }) => IMAGE_EXTENSIONS.includes(extensionOf(file.name)));
      const isObjModel = files.some(({ file }) => extensionOf(file.name) === ".obj");
      const isShapefile = files.length > 0 && files.every(({ file }) => SHAPEFILE_EXTENSIONS.includes(extensionOf(file.name)));
      if (!isGdb && !isAllImages && !isShapefile && !isObjModel) {
        setUploadError(
          `"${name}" doesn't look like a File Geodatabase (.gdb), a shapefile folder, a folder of photos, or a 3D model folder â€” other folder types aren't supported, only individual files.`
        );
        return;
      }
      let archiveName = name;
      let filesToZip = files;
      if (isShapefile) {
        const bundle = validateShapefileBundle(files.map(({ file }) => file));
        archiveName = bundle.stem;
        filesToZip = bundle.files.map((file) => ({ path: file.name, file }));
      }
      const zipped = await zipCollectedFiles(archiveName, filesToZip);
      pickFile(zipped);
      if (isObjModel) {
        const xmlFiles = files.filter(({ file }) => extensionOf(file.name) === ".xml");
        let hasGeoMeta = false;
        for (const { file } of xmlFiles) {
          if (await isGeoMetadataFile(file)) {
            hasGeoMeta = true;
            break;
          }
        }
        setObjAutoNotice(
          hasGeoMeta
            ? "âœ“ Textures and geo-referencing (metadata.xml) loaded automatically."
            : "âš ï¸ No metadata.xml found in that folder â€” if this model uses local/tiled coordinates, its map position may be approximate."
        );
      }
    } catch (err) {
      setUploadError(`Couldn't read that folder: ${(err as Error).message}`);
    } finally {
      setZipping(false);
    }
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

  async function saveCrs(id: string) {
    if (!crsInput.trim()) {
      setCrsError("Enter a CRS (e.g. EPSG:32643)");
      return;
    }
    setCrsSaving(true);
    setCrsError(null);
    try {
      await assignSourceCrs(id, crsInput.trim());
      setCrsAssignFor(null);
      setCrsInput("");
      void refresh();
    } catch (e) {
      setCrsError((e as Error).message || "Failed to assign CRS");
    } finally {
      setCrsSaving(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadFile) {
      setUploadError("Choose a file to upload.");
      return;
    }
    if (!uploadName.trim()) {
      setUploadError(t("datasets.nameRequired"));
      return;
    }
    setUploadBusy(true);
    setUploadError(null);
    setUploadNotice(null);
    setUploadProgress(0);
    const progressInterval = window.setInterval(() => {
      setUploadProgress((p) => Math.min(p + 8, 85));
    }, 200);
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("name", uploadName.trim());
      if (uploadWard.trim()) fd.append("ward", uploadWard.trim());
      const res = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? ""}/api/v1/datasets/upload`,
        { method: "POST", credentials: "include", body: fd }
      );
      window.clearInterval(progressInterval);
      setUploadProgress(100);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
      }
      const body = await res.json();
      setUploadFile(null);
      setUploadName("");
      setUploadWard("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setUploadNotice(`${t("datasets.queueMsg")} ${body.dataset?.name ?? uploadName} â†’ ${t("datasets.processingNote")}`);
      window.setTimeout(() => setUploadNotice(null), 5000);
      void refresh();
    } catch (err) {
      window.clearInterval(progressInterval);
      setUploadError((err as Error).message);
    } finally {
      setUploadBusy(false);
    }
  }

  const processingCount = rows?.filter((r) => r.status === "processing" || r.status === "queued").length ?? 0;
  const failedCount = rows?.filter((r) => r.status === "failed").length ?? 0;
  const totalSize = rows?.reduce((sum, r) => sum + (r.size_bytes ?? 0), 0) ?? 0;

  return (
    <div className={`datasets-page ${mounted ? "datasets-page--mounted" : ""}`} data-testid="datasets-page">

      {/* â”€â”€ HEADER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <header className="ds-header">
        <div className="ds-header__left">
          <h1 className="ds-header__title">{t("datasets.title")}</h1>
          <p className="ds-header__sub">{t("datasets.sub")}</p>
        </div>
        {rows && rows.length > 0 && (
          <div className="ds-stats">
            <div className="ds-stat">
              <span className="ds-stat__value">{rows.length}</span>
              <span className="ds-stat__label">{t("datasets.stat.total")}</span>
            </div>
            {processingCount > 0 && (
              <div className="ds-stat ds-stat--warn">
                <span className="ds-stat__value">{processingCount}</span>
                <span className="ds-stat__label">{t("datasets.stat.processing")}</span>
              </div>
            )}
            {failedCount > 0 && (
              <div className="ds-stat ds-stat--danger">
                <span className="ds-stat__value">{failedCount}</span>
                <span className="ds-stat__label">{t("datasets.stat.failed")}</span>
              </div>
            )}
            <div className="ds-stat ds-stat--storage">
              <div className="ds-stat__top">
                <span className="ds-stat__value">{formatBytes(totalSize)}</span>
                {storage && <span className="ds-stat__used">{storage.used_percent}% {t("common.used")}</span>}
              </div>
              {storage && (
                <div className="ds-storage">
                  <div className="ds-storage__bar">
                    <div
                      className="ds-storage__fill"
                      style={{
                        width: `${Math.min(100, storage.used_percent)}%`,
                        background:
                          storage.used_percent >= 85
                            ? "linear-gradient(90deg,#f59e0b,#ef4444)"
                            : "linear-gradient(90deg,#22c55e,#14b8a6,#3b82f6,#8b5cf6,#ef4444)",
                      }}
                    />
                  </div>
                  <span className="ds-stat__label ds-stat__label--bottom">
                    <span className="ds-stat__label-side">{t("datasets.stat.totalsize")}</span>
                    <span className="ds-stat__label-side">{formatBytes(storage.total_bytes)}</span>
                  </span>
                </div>
              )}
              {!storage && <span className="ds-stat__label">{t("datasets.stat.totalsize")}</span>}
            </div>
          </div>
        )}
      </header>

      {/* â”€â”€ MAIN GRID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="ds-grid">
      <div className="ds-grid__row ds-grid__row--split">

        {/* ── UPLOAD SECTION ────────────────────────────────────────── */}
        <section className="ds-upload-card ds-grid__half">
          <div className="ds-upload-card__header">
            <div className="ds-upload-card__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="24" height="24">
                <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className="ds-upload-card__title">{t("datasets.upload")}</h2>
              <p className="ds-upload-card__sub">{t("datasets.uploadSub")}</p>
            </div>
          </div>

          <form
            className={`ds-dropzone ${dragOver ? "ds-dropzone--active" : ""} ${uploadFile ? "ds-dropzone--has-file" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);

              // A dropped folder (e.g. an unzipped .gdb) arrives as a
              // FileSystemEntry via dataTransfer.items, not as a normal
              // File â€” read it via webkitGetAsEntry() and zip it in the
              // browser before handing it to the normal upload flow.
              const item = e.dataTransfer.items?.[0];
              const entry = (item as unknown as { webkitGetAsEntry?: () => WebkitEntry | null })
                ?.webkitGetAsEntry?.();
              if (entry && !entry.isFile) {
                void pickFolder(entry.name, () => collectDroppedFolder(entry));
                return;
              }

              const files = Array.from(e.dataTransfer.files ?? []);
              void pickFiles(files);
            }}
            onSubmit={submit}
            data-testid="dropzone"
          >
            <input
              id="dz-file"
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(",")}
              multiple
              data-testid="dropzone-file"
              onChange={(e) => {
                void pickFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
              disabled={uploadBusy}
              style={{ display: "none" }}
            />
            <input
              id="dz-folder"
              ref={folderInputRef}
              type="file"
              // @ts-expect-error â€” webkitdirectory isn't in the standard DOM typings
              webkitdirectory=""
              directory=""
              multiple
              data-testid="dropzone-folder"
              onChange={(e) => {
                const files = e.target.files;
                if (!files || files.length === 0) return;
                const { name: topFolder, files: collected } = collectPickedFolder(files);
                void pickFolder(topFolder, () => Promise.resolve(collected));
                e.target.value = "";
              }}
              disabled={uploadBusy || zipping}
              style={{ display: "none" }}
            />
            <input
              id="dz-photos"
              ref={photosInputRef}
              type="file"
              accept="image/*"
              multiple
              data-testid="dropzone-photos"
              onChange={(e) => {
                const files = e.target.files;
                if (!files || files.length === 0) return;
                if (files.length === 1) {
                  pickFile(files[0]);
                } else {
                  void pickMultiplePhotos(Array.from(files));
                }
                e.target.value = "";
              }}
              disabled={uploadBusy || zipping}
              style={{ display: "none" }}
            />

            {zipping ? (
              <div className="ds-dropzone__content">
                <span className="ds-dropzone__label">{t("datasets.validating")}</span>
                <span className="ds-dropzone__hint">{t("datasets.validatingHint")}</span>
              </div>
            ) : !uploadFile ? (
              <label htmlFor="dz-file" className="ds-dropzone__content">
                <div className="ds-dropzone__icon-wrap">
                  <svg viewBox="0 0 48 48" fill="none" width="30" height="30">
                    <rect x="4" y="4" width="40" height="40" rx="8" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" opacity="0.3" />
                    <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <span className="ds-dropzone__label">
                  {dragOver ? t("datasets.dropHere") : t("datasets.dropzone")}
                </span>
                <span className="ds-dropzone__hint">
                  {t("datasets.or")} <span className="ds-dropzone__browse">{t("datasets.browse")}</span>
                  {" Â· "}
                  <span
                    className="ds-dropzone__browse"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      folderInputRef.current?.click();
                    }}
                  >
                    {t("datasets.browseFolder")}
                  </span>
                  {" Â· "}
                  <span
                    className="ds-dropzone__browse"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      photosInputRef.current?.click();
                    }}
                  >
                    browse photos
                  </span>
                </span>
                <span className="ds-dropzone__formats">
                  GeoJSON Â· Shapefile Â· GeoPackage Â· KML Â· GeoTIFF Â· LAS/LAZ Â· OBJ Â· CSV Â· Excel Â· Photos (JPG/PNG/GIF/BMP/WEBP)
                </span>
              </label>
            ) : (
              <div className="ds-dropzone__preview">
                <div className="ds-dropzone__file-icon">{getFileIcon(extensionOf(uploadFile.name).slice(1))}</div>
                <div className="ds-dropzone__file-info">
                  <span className="ds-dropzone__file-name">{uploadFile.name}</span>
                  <span className="ds-dropzone__file-size">{formatBytes(uploadFile.size)}</span>
                  {(extensionOf(uploadFile.name) === ".obj" || objAutoNotice) && (
                    <span className="ds-dropzone__warning" style={{ color: objAutoNotice?.startsWith("âœ“") ? "#4ade80" : "#eab308", fontSize: "0.8rem", marginTop: "4px", display: "block" }}>
                      {objAutoNotice ?? "âš ï¸ Bare .obj file â€” it will upload without materials."}
                      {objAutoRetryFile && (
                        <button
                          type="button"
                          style={{ display: "block", marginTop: "6px", color: "#38bdf8", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline", font: "inherit" }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void runObjAutoLoad(objAutoRetryFile);
                          }}
                        >
                          {extensionOf(uploadFile.name) === ".zip" ? "Retry with parent folder (for geo-referencing)" : "Grant folder access & load textures"}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="ds-dropzone__remove"
                  onClick={() => { setUploadFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                  disabled={uploadBusy}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            )}

            {uploadBusy && (
              <div className="ds-dropzone__progress">
                <div className="ds-dropzone__progress-bar" style={{ width: `${uploadProgress}%` }} />
                <span className="ds-dropzone__progress-text">{uploadProgress}%</span>
              </div>
            )}
          </form>

          {/* â”€â”€ FORM FIELDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          <div className="ds-fields">
            <label className="ds-field">
              <span className="ds-field__label">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                  <path d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("datasets.datasetName")}
              </span>
              <input
                className="ds-field__input"
                data-testid="upload-name"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder={t("datasets.placeholderName")}
                disabled={uploadBusy}
              />
            </label>
            <label className="ds-field">
              <span className="ds-field__label">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                  <path d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("datasets.wardOptional")}
              </span>
              <input
                className="ds-field__input"
                data-testid="upload-ward"
                value={uploadWard}
                onChange={(e) => setUploadWard(e.target.value)}
                placeholder={t("datasets.placeholderWard")}
                disabled={uploadBusy}
              />
            </label>
          </div>

          {/* â”€â”€ MESSAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          {uploadError && (
            <div className="ds-message ds-message--error" data-testid="upload-error">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
              </svg>
              {uploadError}
            </div>
          )}
          {uploadNotice && (
            <div className="ds-message ds-message--success" data-testid="upload-notice">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {uploadNotice}
            </div>
          )}

          <button
            type="submit"
            className="ds-upload-btn"
            disabled={uploadBusy || !uploadFile}
            data-testid="upload-submit"
            onClick={submit}
          >
            {uploadBusy ? (
              <>
                <span className="ds-upload-btn__spinner" />
                {t("datasets.uploading")}
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("datasets.uploadBtn")}
              </>
            )}
          </button>
        </section>

        {/* ── DATASETS TABLE ──────────────────────────────────────────── */}
        <section className="ds-table-section ds-grid__half">
        <div className="ds-table-header">
          <div className="ds-table-header__left">
            <h2 className="ds-table-header__title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
                <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t("datasets.uploadedDatasets")}
            </h2>
            <span className="ds-table-header__count" data-testid="dataset-count">
              {rows ? `${rows.length}` : t("datasets.loading")}
            </span>
          </div>
          <button className="ds-refresh-btn" onClick={() => void refresh()} title={t("datasets.refresh")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="ds-error" data-testid="datasets-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {error}
          </div>
        )}

        <div className="ds-table" data-testid="dataset-grid" role="table">
          <div className="ds-table__head" role="row">
            <div className="ds-table__th ds-table__th--name">{t("datasets.colName")}</div>
            <div className="ds-table__th">{t("datasets.colWard")}</div>
            <div className="ds-table__th">{t("datasets.colType")}</div>
            <div className="ds-table__th">{t("datasets.colSize")}</div>
            <div className="ds-table__th">{t("datasets.colStatus")}</div>
            <div className="ds-table__th">{t("datasets.colUploaded")}</div>
            <div className="ds-table__th ds-table__th--actions">{t("datasets.colActions")}</div>
          </div>

          <div className="ds-table__scroll" role="rowgroup">

          {rows && rows.length > 0 ? (
            rows.map((d, i) => (
              <div
                className="ds-table__row"
                key={d.id}
                role="row"
                data-testid={`grid-row-${d.id}`}
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <div className="ds-table__td ds-table__td--name" title={d.description ?? d.name}>
                  <span className="ds-table__file-icon">{getFileIcon(d.dataset_metadata?.model_3d ? "obj" : d.file_type)}</span>
                  <div className="ds-table__name-wrap">
                    <span className="ds-table__name">{d.name}</span>
                    {d.processing_error && (
                      <span className="ds-table__error">{d.processing_error}</span>
                    )}
                    {d.status === "ready" && d.file_type === "lidar" && d.dataset_metadata?.lidar?.crs_status === "unknown" && (
                      <span className="ds-table__warning" title="No embedded coordinate reference system found. The point cloud has been loaded using its original local coordinates.">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" style={{ marginRight: 4, flexShrink: 0 }}>
                          <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        CRS unknown
                      </span>
                    )}
                  </div>
                </div>
                <div className="ds-table__td">
                  {editingWardId === d.id ? (
                    <div className="ds-table__ward-edit">
                      <input
                        className="ds-table__ward-input"
                        value={wardDraft}
                        onChange={(e) => setWardDraft(e.target.value)}
                        placeholder="ward"
                        disabled={wardSaving}
                        autoFocus
                      />
                      <button type="button" className="ds-table__ward-save" disabled={wardSaving} onClick={() => void saveWard(d.id)}>
                        {wardSaving ? "..." : "âœ“"}
                      </button>
                    </div>
                  ) : (
                      <button type="button" className="ds-table__ward-btn" onClick={() => startEditWard(d)} title={t("datasets.editWardTitle")}>
                      {d.ward ? (
                        <>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
                            <path d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {d.ward}
                        </>
                      ) : (
                        <span className="ds-table__ward-empty">{t("datasets.assignWard")}</span>
                      )}
                    </button>
                  )}
                </div>
                <div className="ds-table__td">
                  <span
                    className="ds-table__badge ds-table__badge--type"
                    title={
                      d.dataset_metadata?.model_3d?.source_crs ??
                      d.dataset_metadata?.lidar?.source_crs ??
                      undefined
                    }
                  >
                    {datasetDisplayType(d)}
                  </span>
                </div>
                <div className="ds-table__td ds-table__td--mono">{formatBytes(d.size_bytes ?? 0)}</div>
                 <div className="ds-table__td">
                  <span className={`ds-table__status ds-table__status--${d.status}`}>
                    {d.status === "ready" && <span className="ds-table__status-dot" />}
                    {t(`datasets.status.${d.status === "queued" ? "queued" : d.status === "processing" ? "processing" : d.status === "failed" ? "failed" : "ready"}`)}
                  </span>
                </div>
                <div className="ds-table__td ds-table__td--mono ds-table__td--muted">{formatDate(d.created_at)}</div>
                <div className="ds-table__td ds-table__td--actions">
                  <button
                    type="button"
                    className="ds-action-btn ds-action-btn--view"
                    data-testid={`view-attrs-${d.id}`}
                    disabled={d.status !== "ready"}
                    onClick={() => setOpenTableFor(d)}
                    title={t("datasets.viewTable")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                      <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {t("datasets.attributes")}
                  </button>
                  {d.status === "ready" && d.file_type === "lidar" && d.dataset_metadata?.lidar?.crs_status === "unknown" && (
                    <button
                      type="button"
                      className="ds-action-btn ds-action-btn--crs"
                      data-testid={`assign-crs-${d.id}`}
                      onClick={() => { setCrsAssignFor(d); setCrsInput(""); setCrsError(null); }}
                      title="Assign a source CRS to place this point cloud on the map"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      CRS
                    </button>
                  )}
                  <button
                    type="button"
                    className="ds-action-btn ds-action-btn--delete"
                    data-testid={`remove-${d.id}`}
                    disabled={removingId === d.id}
                    onClick={() => void removeDataset(d.id, d.name)}
                    title={t("datasets.removeDataset")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                      <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          ) : rows === null ? (
            <div className="ds-table__empty">
              <div className="ds-table__empty-spinner" />
              <span>{t("datasets.loading")}</span>
            </div>
          ) : (
            <div className="ds-table__empty">
              <svg viewBox="0 0 48 48" fill="none" width="48" height="48" opacity="0.3">
                <rect x="4" y="4" width="40" height="40" rx="8" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
                <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span>{t("datasets.noDatasets")}</span>
              <span className="ds-table__empty-hint">{t("datasets.noDatasetsHint")}</span>
            </div>
          )}
          </div>
        </div>
      </section>

      </div>
      </div>
      {/* ── UNCLASSIFIED CATEGORIES (spatial audit classifier review) ── */}
      <UnclassifiedCategoriesPanel />

      {/* ── ATTRIBUTE TABLE OVERLAY ── */}
      {openTableFor && (
        <AttributeTable
          datasetId={openTableFor.id}
          datasetName={openTableFor.name}
          onClose={() => setOpenTableFor(null)}
        />
      )}

      {/* ── ASSIGN CRS MODAL ── */}
      {crsAssignFor && (
        <div className="ds-modal-overlay" onClick={() => { if (!crsSaving) { setCrsAssignFor(null); setCrsError(null); } }}>
          <div className="ds-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Assign CRS">
            <div className="ds-modal__header">
              <h3>Assign Source CRS</h3>
              <button type="button" className="ds-modal__close" onClick={() => { if (!crsSaving) { setCrsAssignFor(null); setCrsError(null); } }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <div className="ds-modal__body">
              <p style={{ marginBottom: 8, color: "var(--text-secondary)", fontSize: 13 }}>
                Assign a coordinate reference system to <strong>{crsAssignFor.name}</strong>.
                This enables geographic placement on the map without re-upload.
              </p>
              <p style={{ marginBottom: 12, color: "var(--text-muted)", fontSize: 12 }}>
                Point count: {(crsAssignFor.dataset_metadata?.lidar?.point_count ?? 0).toLocaleString()}
                {crsAssignFor.dataset_metadata?.lidar?.bounds_raw && (
                  <> | Bounds: [{crsAssignFor.dataset_metadata.lidar.bounds_raw.slice(0, 2).map((v: number) => v.toFixed(1)).join(", ")}] to [{crsAssignFor.dataset_metadata.lidar.bounds_raw.slice(3, 5).map((v: number) => v.toFixed(1)).join(", ")}]</>
                )}
              </p>
              <label style={{ display: "block", marginBottom: 4, fontSize: 13, fontWeight: 500 }}>Source CRS</label>
              <input
                className="ds-table__ward-input"
                value={crsInput}
                onChange={(e) => { setCrsInput(e.target.value); setCrsError(null); }}
                placeholder="EPSG:32643"
                disabled={crsSaving}
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && !crsSaving) void saveCrs(crsAssignFor.id); }}
                style={{ width: "100%", marginBottom: 8 }}
              />
              {crsError && (
                <div style={{ color: "var(--error)", fontSize: 12, marginBottom: 8 }}>{crsError}</div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="ds-modal__btn ds-modal__btn--cancel"
                  onClick={() => { if (!crsSaving) { setCrsAssignFor(null); setCrsError(null); } }}
                  disabled={crsSaving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ds-modal__btn ds-modal__btn--primary"
                  onClick={() => void saveCrs(crsAssignFor.id)}
                  disabled={crsSaving || !crsInput.trim()}
                >
                  {crsSaving ? "Saving..." : "Assign CRS"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "â€”";
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


