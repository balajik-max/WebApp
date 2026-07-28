import { MercatorCoordinate, type CustomLayerInterface, type Map as MLMap } from "maplibre-gl";
import type { mat4 } from "gl-matrix";
import * as THREE from "three";
import {
  buildLidarColors,
  fetchLidarPointCloud,
  type LidarColorMode,
  type LidarPointData,
} from "../lib/lidarPointCloud";

interface ModelTransform {
  translateX: number;
  translateY: number;
  translateZ: number;
  scale: number;
}

export class LidarPointCloudLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;

  private datasetId: string;
  private map: MLMap | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.PointsMaterial | null = null;
  private transform: ModelTransform | null = null;
  private data: LidarPointData | null = null;
  private colorMode: LidarColorMode = "elevation";
  private abortController: AbortController | null = null;
  private removed = false;

  constructor(id: string, datasetId: string) {
    this.id = id;
    this.datasetId = datasetId;
  }

  async onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): Promise<void> {
    this.map = map;
    this.removed = false;
    this.abortController = new AbortController();

    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.renderer = new THREE.WebGLRenderer({
      canvas: gl.canvas as HTMLCanvasElement,
      context: gl as WebGLRenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;

    try {
      const data = await fetchLidarPointCloud(this.datasetId, this.abortController.signal);
      if (this.removed) return;
      this.data = data;
      this.colorMode = data.manifest.default_color_mode;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(buildLidarColors(data, this.colorMode), 3));
      geometry.setDrawRange(0, Math.min(data.manifest.draw_budgets.far, data.manifest.point_count));
      geometry.computeBoundingSphere();

      const material = new THREE.PointsMaterial({
        size: 2.8,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 1.0,
        depthTest: true,
        depthWrite: false,
      });

      const points = new THREE.Points(geometry, material);
      points.frustumCulled = false;
      this.scene.add(points);
      this.geometry = geometry;
      this.material = material;

      const origin = MercatorCoordinate.fromLngLat(
        {
          lng: data.manifest.origin.longitude,
          lat: data.manifest.origin.latitude,
        },
        0
      );
      this.transform = {
        translateX: origin.x,
        translateY: origin.y,
        translateZ: origin.z,
        scale: origin.meterInMercatorCoordinateUnits(),
      };
      map.triggerRepaint();
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error(`Could not load real LiDAR points for dataset ${this.datasetId}:`, error);
      }
    }
  }

  setColorMode(mode: LidarColorMode): void {
    if (!this.data || !this.geometry) return;
    this.colorMode = mode;
    this.geometry.setAttribute("color", new THREE.BufferAttribute(buildLidarColors(this.data, mode), 3));
    this.geometry.attributes.color.needsUpdate = true;
    this.map?.triggerRepaint();
  }

  private updateBudget(): void {
    if (!this.map || !this.data || !this.geometry || !this.material) return;
    const zoom = this.map.getZoom();
    const budgets = this.data.manifest.draw_budgets;
    const count = zoom < 15 ? budgets.far : zoom < 18 ? budgets.medium : budgets.close;
    this.geometry.setDrawRange(0, Math.min(count, this.data.manifest.point_count));
    this.material.size = zoom < 15 ? 3.4 : zoom < 18 ? 2.9 : 2.4;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: mat4): void {
    if (!this.renderer || !this.scene || !this.camera || !this.transform) return;
    this.updateBudget();
    const t = this.transform;
    const projection = new THREE.Matrix4().fromArray(Array.from(matrix));
    const local = new THREE.Matrix4()
      .makeTranslation(t.translateX, t.translateY, t.translateZ)
      .scale(new THREE.Vector3(t.scale, -t.scale, t.scale));
    this.camera.projectionMatrix = projection.multiply(local);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  onRemove(): void {
    this.removed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.geometry?.dispose();
    this.material?.dispose();
    this.renderer?.dispose();
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.geometry = null;
    this.material = null;
    this.transform = null;
    this.data = null;
    this.map = null;
  }
}
