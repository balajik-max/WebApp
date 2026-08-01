import JSZip from "jszip";

/**
 * Shared file-intake helpers for staging dataset uploads — used by the
 * Datasets page's own dropzone AND the Map page's page-level "drag a file
 * anywhere to upload it" handoff (see UploadTransferContext). Kept
 * framework-free (no React state) so both call sites can share exactly the
 * same parsing/validation/zipping behavior.
 */

export const ACCEPTED_EXTENSIONS = [
  ".geojson", ".json", ".zip", ".shp", ".dbf", ".shx", ".prj", ".cpg", ".gpkg", ".kml", ".csv", ".tsv", ".xlsx", ".xls",
  ".tif", ".tiff", ".geotiff", ".las", ".laz", ".obj",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp",
];

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];
export const SHAPEFILE_EXTENSIONS = [".shp", ".dbf", ".shx", ".prj", ".cpg"];
export const REQUIRED_SHAPEFILE_EXTENSIONS = [".shp", ".dbf", ".shx", ".prj"];

// File System Access API — not yet in TS's DOM lib. Only Chromium ships it;
// callers must feature-detect `window.showDirectoryPicker` before use.
declare global {
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>;
  }
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

// Best-effort extraction of a ward name/number from an uploaded filename,
// e.g. "Davangere Ghandinagar Ward.gdb-20260708T103425Z-3-001.zip" ->
// "Ghandinagar", or "Ward 12 streetlights.geojson" -> "12". Returns null
// when nothing looks ward-like, so the field is left for the user to fill.
export function guessWardFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.[^.]+$/, "");
  const before = stem.match(/([A-Za-z]+)\s+Ward\b/i);
  if (before) return before[1];
  const after = stem.match(/\bWard[\s_-]+([A-Za-z0-9]+)/i);
  if (after) return after[1];
  return null;
}

// A raw .gdb (File Geodatabase) is a *folder*, not a single file — the
// browser file APIs only ever hand us a placeholder for a dropped/selected
// directory, never its contents, unless we explicitly walk it. These
// helpers read every file inside an unzipped .gdb folder and zip it
// client-side into the exact structure the backend's zipped-GDB reader
// already knows how to open (a <name>.gdb/ directory at the zip root) —
// no backend change needed, it just never sees the difference.
export interface WebkitFileEntry {
  isFile: true;
  isDirectory: false;
  name: string;
  file: (success: (f: File) => void, error: (e: Error) => void) => void;
}
export interface WebkitDirEntry {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader: () => { readEntries: (success: (e: WebkitEntry[]) => void, error: (e: Error) => void) => void };
}
export type WebkitEntry = WebkitFileEntry | WebkitDirEntry;

async function readEntriesBatch(reader: {
  readEntries: (success: (e: WebkitEntry[]) => void, error: (e: Error) => void) => void;
}): Promise<WebkitEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function readAllDirEntries(dirEntry: WebkitDirEntry): Promise<WebkitEntry[]> {
  const reader = dirEntry.createReader();
  const all: WebkitEntry[] = [];
  // readEntries() only returns a batch at a time — must keep calling until empty.
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

export async function collectDroppedFolder(rootEntry: WebkitDirEntry): Promise<{ path: string; file: File }[]> {
  const collected: { path: string; file: File }[] = [];
  await walkEntry(rootEntry, "", collected);
  return collected;
}

export function collectPickedFolder(fileList: FileList): { name: string; files: { path: string; file: File }[] } {
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
// user picked a whole drive by mistake) — distinct from AbortError/
// SecurityError so the caller can give an actionable message instead of
// treating it like a declined prompt.
export class FolderScanLimitError extends Error {}

const MAX_SCAN_ENTRIES = 2000;
const MAX_SCAN_DEPTH = 4;

async function walkDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string,
  depth: number,
  out: { path: string; file: File }[]
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    throw new FolderScanLimitError("That folder is nested too deep to scan automatically — choose the folder that directly contains the .obj (or its parent, if it has a metadata.xml).");
  }
  for await (const entry of dirHandle.values()) {
    if (out.length > MAX_SCAN_ENTRIES) {
      throw new FolderScanLimitError("That folder has too many files to scan automatically — choose a smaller folder, ideally the one that directly contains the .obj.");
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
// pipeline behind this platform produces) carries its real-world anchor —
// SRS + the point the OBJ's local meter offsets are measured from — in a
// `metadata.xml` file. That file conventionally sits *next to* the tile
// folder, not inside it (e.g. "3D MODEL/metadata.xml" alongside
// "3D MODEL/Block0/Block0.obj") — sniff by content, not name, since the
// convention isn't universal, and it may not be present at all.
export async function isGeoMetadataFile(file: File): Promise<boolean> {
  if (extensionOf(file.name) !== ".xml" || file.size > 65_536) return false;
  try {
    return (await file.text()).includes("<SRSOrigin");
  } catch {
    return false;
  }
}

// A single bare .obj (picked via the plain file input, or dropped as one
// file) carries no path info a browser will ever hand us — there is no API
// that goes from a File back to its siblings on disk. The only way to pull
// in its .mtl/textures/geo-referencing without the user hand-picking them
// is to ask for a folder via the File System Access API and read it
// ourselves — walking subfolders too, since the geo-reference file is
// often one level above wherever the .obj itself lives.
export async function collectObjCompanionsFromDisk(objFile: File): Promise<{ path: string; file: File }[]> {
  // Deliberately not caught here — the picker throws "AbortError" when the
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

export async function zipCollectedFiles(name: string, files: { path: string; file: File }[]): Promise<File> {
  const zip = new JSZip();
  for (const { path, file } of files) zip.file(path, file);
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], `${name}.zip`, { type: "application/zip" });
}

export function validateShapefileBundle(files: File[]): { stem: string; files: File[] } {
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

export interface FolderClassificationResult {
  file: File;
  isObjModel: boolean;
  hasGeoMeta: boolean;
}

// A dropped/browsed folder is supported if it's a File Geodatabase (by
// name), a shapefile bundle, a folder full of photos (checked by content,
// since a photo folder has no special naming convention), or a 3D model
// folder/tree (contains an .obj somewhere) — the latter is what makes a
// folder one level up from the .obj (i.e. containing a metadata.xml
// geo-reference sibling to the model's own folder) work, since these
// collectors already walk subfolders and grab everything, unfiltered.
// Throws with a clear reason for anything else, before wasting time zipping it.
export async function classifyAndZipFolder(
  name: string,
  files: { path: string; file: File }[]
): Promise<FolderClassificationResult> {
  const isGdb = name.toLowerCase().endsWith(".gdb");
  const isAllImages = files.length > 0 && files.every(({ file }) => IMAGE_EXTENSIONS.includes(extensionOf(file.name)));
  const isObjModel = files.some(({ file }) => extensionOf(file.name) === ".obj");
  const isShapefile = files.length > 0 && files.every(({ file }) => SHAPEFILE_EXTENSIONS.includes(extensionOf(file.name)));
  if (!isGdb && !isAllImages && !isShapefile && !isObjModel) {
    throw new Error(
      `"${name}" doesn't look like a File Geodatabase (.gdb), a shapefile folder, a folder of photos, or a 3D model folder — other folder types aren't supported, only individual files.`
    );
  }
  let archiveName = name;
  let filesToZip = files;
  if (isShapefile) {
    const bundle = validateShapefileBundle(files.map(({ file }) => file));
    archiveName = bundle.stem;
    filesToZip = bundle.files.map((file) => ({ path: file.name, file }));
  }
  const zipped = await zipCollectedFiles(archiveName, filesToZip);
  let hasGeoMeta = false;
  if (isObjModel) {
    const xmlFiles = files.filter(({ file }) => extensionOf(file.name) === ".xml");
    for (const { file } of xmlFiles) {
      if (await isGeoMetadataFile(file)) {
        hasGeoMeta = true;
        break;
      }
    }
  }
  return { file: zipped, isObjModel, hasGeoMeta };
}
