import * as THREE from "three";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

/**
 * Fetches and parses a dataset's `.mtl` (if the OBJ was uploaded as a
 * bundle with its real materials/textures), pointing the loader's texture
 * fetches at our authenticated `/model-asset/` endpoint rather than trying
 * to resolve them relative to the page origin.
 *
 * Textures finish loading asynchronously *after* this resolves (three.js
 * mutates them in place once each image arrives) — pass `onTextureLoaded`
 * so a caller with no continuous render loop (e.g. a MapLibre custom
 * layer, unlike the modal viewer's requestAnimationFrame loop) knows to
 * repaint as each one lands, instead of showing stale/blank textures.
 *
 * Returns `null` when the dataset has no `.mtl` — callers should fall back
 * to a placeholder material, since a bare `.obj` carries no color data.
 */
export async function loadObjMaterials(
  datasetId: string,
  mtlFilename: string | undefined,
  onTextureLoaded?: () => void
): Promise<MTLLoader.MaterialCreator | null> {
  if (!mtlFilename) return null;
  const assetBase = `${API_BASE}/api/v1/datasets/${datasetId}/model-asset/`;
  const res = await fetch(`${assetBase}${encodeURIComponent(mtlFilename)}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Could not load materials (${res.status} ${res.statusText})`);
  const mtlText = await res.text();

  const manager = new THREE.LoadingManager();
  if (onTextureLoaded) {
    manager.onLoad = onTextureLoaded;
    manager.onProgress = () => onTextureLoaded();
  }

  const loader = new MTLLoader(manager);
  loader.setCrossOrigin("use-credentials");
  loader.setResourcePath(assetBase);
  const materials = loader.parse(mtlText, "");
  materials.preload();
  return materials;
}
