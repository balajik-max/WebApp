import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

import type { DatasetRow } from "../lib/workflow";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export const objModelLayerId = (datasetId: string) => `obj-model-${datasetId}`;

function modelAssetUrl(datasetId: string, assetPath: string): string {
  const encodedPath = assetPath.split("/").map(encodeURIComponent).join("/");
  return `${API_BASE}/api/v1/datasets/${datasetId}/model-assets/${encodedPath}`;
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach(disposeMaterial);
  });
}

export interface ObjModelLayerCallbacks {
  onLoaded?: () => void;
  onError?: (message: string) => void;
}

export function createObjModelLayer(
  dataset: DatasetRow,
  callbacks: ObjModelLayerCallbacks = {},
): maplibregl.CustomLayerInterface {
  const metadata = dataset.dataset_metadata.model_3d;
  if (!metadata?.render_anchor || metadata.models.length === 0) {
    throw new Error("This OBJ dataset does not contain a browser-renderable model manifest.");
  }

  const modelMetadata = metadata;
  const anchor = metadata.render_anchor;
  const mercator = maplibregl.MercatorCoordinate.fromLngLat(
    [anchor.longitude, anchor.latitude],
    anchor.altitude,
  );
  const meterScale = mercator.meterInMercatorCoordinateUnits();
  const modelMatrix = new THREE.Matrix4()
    .makeTranslation(mercator.x, mercator.y, mercator.z)
    .scale(new THREE.Vector3(meterScale, -meterScale, meterScale));

  let map: maplibregl.Map | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let disposed = false;
  const camera = new THREE.Camera();
  const scene = new THREE.Scene();
  const loadedRoots: THREE.Object3D[] = [];

  scene.add(new THREE.HemisphereLight(0xddeeff, 0x59616b, 0.65));
  const keyLight = new THREE.DirectionalLight(0xfff4df, 1.1);
  keyLight.position.set(-200, -300, 600);
  scene.add(keyLight);

  async function loadModels(): Promise<void> {
    const loadingManager = new THREE.LoadingManager();
    loadingManager.onError = (url) => callbacks.onError?.(`Could not load 3D model asset: ${url}`);

    for (const model of modelMetadata.models) {
      const objLoader = new OBJLoader(loadingManager);
      objLoader.setWithCredentials(true);

      const firstMtl = model.mtl_paths[0];
      if (firstMtl) {
        const mtlLoader = new MTLLoader(loadingManager);
        mtlLoader.setWithCredentials(true);
        mtlLoader.setCrossOrigin("use-credentials");
        const materials = await mtlLoader.loadAsync(modelAssetUrl(dataset.id, firstMtl));
        materials.preload();
        objLoader.setMaterials(materials);
      }

      const root = await objLoader.loadAsync(modelAssetUrl(dataset.id, model.obj_path));
      if (disposed) {
        disposeObject(root);
        return;
      }
      root.position.set(-anchor.local[0], -anchor.local[1], -anchor.local[2]);
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          material.side = THREE.DoubleSide;
          const textured = material as THREE.MeshPhongMaterial;
          if (textured.map) textured.map.colorSpace = THREE.SRGBColorSpace;
          material.needsUpdate = true;
        }
      });
      loadedRoots.push(root);
      scene.add(root);
      map?.triggerRepaint();
    }
    callbacks.onLoaded?.();
  }

  return {
    id: objModelLayerId(dataset.id),
    type: "custom",
    renderingMode: "3d",
    onAdd(mapInstance, gl) {
      map = mapInstance;
      renderer = new THREE.WebGLRenderer({
        canvas: mapInstance.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      void loadModels().catch((error: Error) => {
        if (!disposed) callbacks.onError?.(`Could not load RGB 3D model: ${error.message}`);
      });
    },
    render(_gl, args) {
      if (!renderer || !map) return;
      // The OBJ model is positioned in Mercator coordinate space, which is
      // only valid under the Mercator projection. In globe projection the
      // same coordinates would be misplaced, so skip rendering there rather
      // than drawing it at the wrong spot.
      if (map.getProjection().type !== "mercator") return;
      camera.projectionMatrix.fromArray(args.modelViewProjectionMatrix).multiply(modelMatrix);
      renderer.resetState();
      renderer.render(scene, camera);
    },
    onRemove() {
      disposed = true;
      loadedRoots.forEach(disposeObject);
      loadedRoots.length = 0;
      renderer?.dispose();
      renderer = null;
      map = null;
    },
  };
}
