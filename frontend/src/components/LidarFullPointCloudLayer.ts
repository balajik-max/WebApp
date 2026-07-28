import { MercatorCoordinate, type CustomLayerInterface, type Map as MLMap } from "maplibre-gl";
import type { mat4 } from "gl-matrix";
import * as THREE from "three";
import {
  fetchAndParseLidarFullChunk,
  fetchLidarFullManifest,
  type LidarFullManifest,
} from "../lib/lidarFullPointCloud";

interface ModelTransform {
  translateX: number;
  translateY: number;
  translateZ: number;
  scale: number;
}

export class LidarFullPointCloudLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;

  private datasetId: string;
  private map: MLMap | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private material: THREE.PointsMaterial | null = null;
  private geometries: THREE.BufferGeometry[] = [];
  private transform: ModelTransform | null = null;
  private abortController: AbortController | null = null;
  private progressElement: HTMLDivElement | null = null;
  private removed = false;
  private loadedPoints = 0;

  constructor(id: string, datasetId: string) {
    this.id = id;
    this.datasetId = datasetId;
  }

  async onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): Promise<void> {
    this.map = map;
    this.removed = false;
    this.abortController = new AbortController();
    this.createProgressElement(map);

    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.renderer = new THREE.WebGLRenderer({
      canvas: gl.canvas as HTMLCanvasElement,
      context: gl as WebGLRenderingContext,
      antialias: false,
    });
    this.renderer.autoClear = false;
    this.material = new THREE.PointsMaterial({
      size: 2.0,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
      depthTest: true,
      depthWrite: false,
    });

    try {
      const manifest = await fetchLidarFullManifest(
        this.datasetId,
        this.abortController.signal
      );
      if (this.removed) return;
      this.setTransform(manifest);
      this.updateProgress("Loading full point cloud", 0, manifest.point_count);
      void this.loadAllChunks(manifest);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error(`Could not load full LiDAR manifest for ${this.datasetId}:`, error);
        this.updateProgress(`Full LiDAR error: ${(error as Error).message}`, 0, 0);
      }
    }
  }

  private setTransform(manifest: LidarFullManifest): void {
    const origin = MercatorCoordinate.fromLngLat(
      {
        lng: manifest.origin.longitude,
        lat: manifest.origin.latitude,
      },
      0
    );
    this.transform = {
      translateX: origin.x,
      translateY: origin.y,
      translateZ: origin.z,
      scale: origin.meterInMercatorCoordinateUnits(),
    };
  }

  private async loadAllChunks(manifest: LidarFullManifest): Promise<void> {
    if (!this.abortController) return;
    let nextChunk = 0;
    const worker = async (): Promise<void> => {
      while (!this.removed) {
        const index = nextChunk;
        nextChunk += 1;
        if (index >= manifest.chunks.length) return;
        const chunk = manifest.chunks[index];
        const parsed = await fetchAndParseLidarFullChunk(
          manifest,
          chunk,
          this.abortController?.signal
        );
        if (this.removed || !this.scene || !this.material) return;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(parsed.colors, 3, true));
        geometry.computeBoundingSphere();
        const points = new THREE.Points(geometry, this.material);
        points.frustumCulled = false;
        this.scene.add(points);
        this.geometries.push(geometry);
        this.loadedPoints += chunk.point_count;
        this.updateProgress(
          "Loading full point cloud",
          this.loadedPoints,
          manifest.point_count
        );
        this.map?.triggerRepaint();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    };

    try {
      await Promise.all([worker(), worker()]);
      if (!this.removed) {
        this.updateProgress("Full point cloud loaded", this.loadedPoints, manifest.point_count);
        window.setTimeout(() => this.removeProgressElement(), 5000);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError" && !this.removed) {
        console.error(`Full LiDAR chunk loading failed for ${this.datasetId}:`, error);
        this.updateProgress(
          `Full LiDAR stopped at ${this.loadedPoints.toLocaleString()} points`,
          this.loadedPoints,
          manifest.point_count
        );
      }
    }
  }

  private createProgressElement(map: MLMap): void {
    const element = document.createElement("div");
    element.dataset.lidarFullProgress = this.datasetId;
    element.style.position = "absolute";
    element.style.left = "50%";
    element.style.bottom = "24px";
    element.style.transform = "translateX(-50%)";
    element.style.zIndex = "30";
    element.style.padding = "8px 12px";
    element.style.borderRadius = "8px";
    element.style.background = "rgba(15, 23, 42, 0.88)";
    element.style.color = "white";
    element.style.fontSize = "12px";
    element.style.pointerEvents = "none";
    element.style.whiteSpace = "nowrap";
    map.getContainer().appendChild(element);
    this.progressElement = element;
  }

  private updateProgress(label: string, loaded: number, total: number): void {
    if (!this.progressElement) return;
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    this.progressElement.textContent = total > 0
      ? `${label}: ${loaded.toLocaleString()} / ${total.toLocaleString()} (${percent}%)`
      : label;
  }

  private removeProgressElement(): void {
    this.progressElement?.remove();
    this.progressElement = null;
  }

  private updatePointSize(): void {
    if (!this.map || !this.material) return;
    const zoom = this.map.getZoom();
    this.material.size = zoom < 15 ? 2.4 : zoom < 18 ? 1.9 : 1.5;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: mat4): void {
    if (!this.renderer || !this.scene || !this.camera || !this.transform) return;
    this.updatePointSize();
    const transform = this.transform;
    const projection = new THREE.Matrix4().fromArray(Array.from(matrix));
    const local = new THREE.Matrix4()
      .makeTranslation(transform.translateX, transform.translateY, transform.translateZ)
      .scale(new THREE.Vector3(transform.scale, -transform.scale, transform.scale));
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
    this.removeProgressElement();
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries = [];
    this.material?.dispose();
    this.renderer?.dispose();
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.material = null;
    this.transform = null;
    this.map = null;
    this.loadedPoints = 0;
  }
}
