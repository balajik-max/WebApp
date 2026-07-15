import { MercatorCoordinate, type CustomLayerInterface, type Map as MLMap } from "maplibre-gl";
import type { mat4 } from "gl-matrix";

// MapLibre GL v5 custom layer render method input
interface CustomRenderMethodInput {
  projectionMatrix?: mat4;
  farZ?: number;
}
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { loadObjMaterials } from "../lib/loadObjMaterials";

const METERS_PER_DEGREE_LAT = 111_320;

export interface Obj3DLayerBounds {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

interface ModelTransform {
  translateX: number;
  translateY: number;
  translateZ: number;
  scale: number;
}

// A MapLibre custom layer that drapes a parsed OBJ mesh directly onto the
// live map at its real georeferenced location, instead of a disconnected
// full-screen viewer. The mesh's raw local units are re-centered around the
// dataset's own bounding box (from `fetchDatasetBounds`) and converted to
// meters using the *same* affine mapping the backend used to place each
// vertex's point feature (see obj_reader.py) — so the mesh lines up exactly
// with the point layer already plotted from this file, without hardcoding
// the backend's synthetic-mapping constants here.
//
// Vertices are kept in small local-meter coordinates (not raw mercator
// units, which are ~0.5 in magnitude) and re-projected onto the map's own
// projection matrix each frame via a translate+scale model matrix — mercator
// units are too coarse in 32-bit float to hold fine mesh detail directly.
export class Obj3DMapLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;

  private objText: string;
  private bounds: Obj3DLayerBounds;
  private datasetId: string;
  private mtlFilename: string | undefined;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private transform: ModelTransform | null = null;

  constructor(
    id: string,
    objText: string,
    bounds: Obj3DLayerBounds,
    datasetId: string,
    mtlFilename: string | undefined
  ) {
    this.id = id;
    this.objText = objText;
    this.bounds = bounds;
    this.datasetId = datasetId;
    this.mtlFilename = mtlFilename;
  }

  // Declared void by CustomLayerInterface but MapLibre doesn't await it —
  // render() already no-ops until `this.transform` is set, so it's safe
  // for the real materials fetch to finish after onAdd returns.
  async onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): Promise<void> {
    // Unlike the modal viewer (which has its own requestAnimationFrame
    // loop), this layer only redraws when MapLibre repaints — so once
    // textures finish loading asynchronously after this function returns,
    // the map needs to be told to repaint or they'd never actually appear.
    const materials = await loadObjMaterials(this.datasetId, this.mtlFilename, () => map.triggerRepaint()).catch(() => null);
    const objLoader = new OBJLoader();
    if (materials) objLoader.setMaterials(materials);
    const object = objLoader.parse(this.objText);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity;
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const pos = child.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
      }
    });

    const { min_lon, min_lat, max_lon, max_lat } = this.bounds;
    const scaleLon = (max_lon - min_lon) / (maxX - minX || 1e-9);
    const scaleLat = (max_lat - min_lat) / (maxY - minY || 1e-9);
    const centerLon = (min_lon + max_lon) / 2;
    const centerLat = (min_lat + max_lat) / 2;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Degrees-per-unit -> meters-per-unit, using latitude's constant meters-
    // per-degree so the mesh isn't stretched by longitude's cos(lat) factor.
    const metersPerUnit = (Math.abs(scaleLat) || Math.abs(scaleLon)) * METERS_PER_DEGREE_LAT;

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const geom = child.geometry;
      const pos = geom.attributes.position;
      const next = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        next[i * 3] = (pos.getX(i) - centerX) * metersPerUnit;
        next[i * 3 + 1] = (pos.getY(i) - centerY) * metersPerUnit;
        next[i * 3 + 2] = (pos.getZ(i) - minZ) * metersPerUnit;
      }
      geom.setAttribute("position", new THREE.BufferAttribute(next, 3));
      geom.computeVertexNormals();
      // Only fall back to a flat placeholder color when the file had no
      // real materials to load (a bare .obj carries no color data, unless it has vertex colors).
      if (!materials) {
        const hasVertexColors = geom.hasAttribute("color");
        child.material = new THREE.MeshStandardMaterial({
          color: hasVertexColors ? 0xffffff : 0x3aa1ff,
          flatShading: true,
          vertexColors: hasVertexColors,
        });
      }
    });

    const origin = MercatorCoordinate.fromLngLat({ lng: centerLon, lat: centerLat }, 0);
    this.transform = {
      translateX: origin.x,
      translateY: origin.y,
      translateZ: origin.z,
      scale: origin.meterInMercatorCoordinateUnits(),
    };

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(0, -1, 1);
    this.scene.add(sun);
    this.scene.add(object);

    this.camera = new THREE.Camera();
    this.renderer = new THREE.WebGLRenderer({
      canvas: gl.canvas as HTMLCanvasElement,
      context: gl as WebGLRenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || !this.scene || !this.camera || !this.transform) return;
    
    // Extract projection matrix from options (MapLibre GL v5 API)
    const matrix = options.projectionMatrix;
    if (!matrix) return;
    
    const t = this.transform;
    const m = new THREE.Matrix4().fromArray(Array.from(matrix));
    const l = new THREE.Matrix4()
      .makeTranslation(t.translateX, t.translateY, t.translateZ)
      .scale(new THREE.Vector3(t.scale, -t.scale, t.scale));
    this.camera.projectionMatrix = m.multiply(l);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  onRemove(): void {
    this.scene?.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
    this.renderer?.dispose();
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.transform = null;
  }
}
