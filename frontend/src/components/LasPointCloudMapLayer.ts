import { MercatorCoordinate, type CustomLayerInterface, type Map as MLMap } from "maplibre-gl";
import type { mat4 } from "gl-matrix";
import * as THREE from "three";

const HEADER_BYTES = 40;
const POSITION_COMPONENTS = 3;
const COLOR_COMPONENTS = 3;
const INTERACTIVE_POINT_LIMIT = 300_000;

interface DecodedCloud {
  centerLon: number;
  centerLat: number;
  positions: Float32Array;
  colors: Uint8Array;
}

function decodePointCloud(buffer: ArrayBuffer): DecodedCloud {
  if (buffer.byteLength < HEADER_BYTES) throw new Error("Point-cloud preview is incomplete");
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "NPC2") throw new Error("Point-cloud preview has an unsupported format");

  const count = view.getUint32(4, true);
  const positionBytes = count * POSITION_COMPONENTS * Float32Array.BYTES_PER_ELEMENT;
  const colorBytes = count * COLOR_COMPONENTS;
  if (buffer.byteLength !== HEADER_BYTES + positionBytes + colorBytes) {
    throw new Error("Point-cloud preview has an invalid length");
  }
  const centerLon = view.getFloat64(8, true);
  const centerLat = view.getFloat64(16, true);
  // Both typed arrays point directly into the response buffer: zero copies
  // and no per-point decode loop on the browser's main thread.
  const positions = new Float32Array(buffer, HEADER_BYTES, count * POSITION_COMPONENTS);
  const colors = new Uint8Array(buffer, HEADER_BYTES + positionBytes, colorBytes);
  return { centerLon, centerLat, positions, colors };
}

/** Renders dense LAS/LAZ XYZ data as real elevated, per-point RGB on MapLibre. */
export class LasPointCloudMapLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;

  private url: string;
  private onError: (message: string) => void;
  private abortController = new AbortController();
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private points: THREE.Points | null = null;
  private map: MLMap | null = null;
  private interactiveIndex: THREE.BufferAttribute | null = null;
  private projectionMatrix = new THREE.Matrix4();
  private modelMatrix = new THREE.Matrix4();
  private transform: { x: number; y: number; z: number; scale: number } | null = null;

  private enterInteractiveMode = () => {
    if (!this.points || !this.interactiveIndex) return;
    this.points.geometry.setIndex(this.interactiveIndex);
  };

  private restoreFullDetail = () => {
    if (!this.points) return;
    this.points.geometry.setIndex(null);
    this.map?.triggerRepaint();
  };

  constructor(id: string, url: string, onError: (message: string) => void) {
    this.id = id;
    this.url = url;
    this.onError = onError;
  }

  async onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): Promise<void> {
    this.map = map;
    map.on("movestart", this.enterInteractiveMode);
    map.on("moveend", this.restoreFullDetail);
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.renderer = new THREE.WebGLRenderer({
      canvas: gl.canvas as HTMLCanvasElement,
      context: gl as WebGLRenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    try {
      const response = await fetch(this.url, {
        credentials: "include",
        signal: this.abortController.signal,
      });
      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
          const body = await response.json() as { detail?: string };
          if (body.detail) message = body.detail;
        } catch {
          // The endpoint normally returns JSON errors, but keep the HTTP text fallback.
        }
        throw new Error(message);
      }
      const cloud = decodePointCloud(await response.arrayBuffer());
      if (cloud.positions.length === 0) throw new Error("The LAS/LAZ file contains no renderable points");

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(cloud.positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(cloud.colors, 3, true));

      const pointCount = cloud.positions.length / POSITION_COMPONENTS;
      if (pointCount > INTERACTIVE_POINT_LIMIT) {
        const indices = new Uint32Array(INTERACTIVE_POINT_LIMIT);
        for (let index = 0; index < INTERACTIVE_POINT_LIMIT; index += 1) {
          indices[index] = Math.floor(index * (pointCount - 1) / (INTERACTIVE_POINT_LIMIT - 1));
        }
        this.interactiveIndex = new THREE.BufferAttribute(indices, 1);
      }

      const material = new THREE.PointsMaterial({
        size: 2.25,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: false,
      });
      this.points = new THREE.Points(geometry, material);
      this.points.frustumCulled = false;
      this.scene?.add(this.points);

      const origin = MercatorCoordinate.fromLngLat({ lng: cloud.centerLon, lat: cloud.centerLat }, 0);
      this.transform = {
        x: origin.x,
        y: origin.y,
        z: origin.z,
        scale: origin.meterInMercatorCoordinateUnits(),
      };
      this.modelMatrix
        .makeTranslation(this.transform.x, this.transform.y, this.transform.z)
        .scale(new THREE.Vector3(this.transform.scale, -this.transform.scale, this.transform.scale));
      if (map.isMoving()) this.enterInteractiveMode();
      map.triggerRepaint();
    } catch (error) {
      if ((error as Error).name !== "AbortError") this.onError((error as Error).message);
    }
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: mat4): void {
    if (!this.renderer || !this.scene || !this.camera || !this.transform) return;
    this.projectionMatrix.fromArray(matrix);
    this.camera.projectionMatrix.copy(this.projectionMatrix).multiply(this.modelMatrix);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  onRemove(): void {
    this.abortController.abort();
    this.map?.off("movestart", this.enterInteractiveMode);
    this.map?.off("moveend", this.restoreFullDetail);
    this.points?.geometry.dispose();
    const material = this.points?.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
    this.renderer?.dispose();
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.points = null;
    this.map = null;
    this.interactiveIndex = null;
    this.transform = null;
  }
}
