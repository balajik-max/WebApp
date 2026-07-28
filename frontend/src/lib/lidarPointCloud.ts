import { apiDownload, apiGet } from "./api";

export type LidarColorMode = "rgb" | "classification" | "elevation" | "intensity";

export interface LidarPointManifest {
  version: number;
  dataset_id: string;
  source_size_bytes: number | null;
  source_fingerprint: string;
  source_crs: string;
  point_count_source: number;
  point_count: number;
  record_stride_bytes: number;
  origin: {
    longitude: number;
    latitude: number;
    z_base_m: number;
  };
  bounds: {
    min_lon: number;
    min_lat: number;
    max_lon: number;
    max_lat: number;
    z_min_m: number;
    z_max_m: number;
  };
  has_rgb: boolean;
  has_classification: boolean;
  has_intensity: boolean;
  has_return_number: boolean;
  classification_counts: Record<string, number>;
  intensity_min: number;
  intensity_max: number;
  default_color_mode: LidarColorMode;
  draw_budgets: {
    far: number;
    medium: number;
    close: number;
  };
  points_url: string;
}

export interface LidarPointData {
  manifest: LidarPointManifest;
  positions: Float32Array;
  rgb: Uint8Array;
  classifications: Uint8Array;
  intensities: Uint16Array;
}

const CLASSIFICATION_COLORS: Record<number, [number, number, number]> = {
  0: [180, 180, 180],
  1: [190, 190, 190],
  2: [160, 110, 70],
  3: [170, 230, 130],
  4: [90, 190, 80],
  5: [25, 125, 55],
  6: [210, 90, 80],
  7: [110, 110, 110],
  8: [160, 160, 160],
  9: [70, 145, 230],
  10: [90, 90, 90],
  11: [85, 85, 85],
  12: [230, 180, 60],
};

function turboLike(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 3))));
  const g = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 2))));
  const b = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 1))));
  return [r, g, b];
}

export async function fetchLidarPointCloud(
  datasetId: string,
  signal?: AbortSignal
): Promise<LidarPointData> {
  const manifest = await apiGet<LidarPointManifest>(`/api/v1/lidar/${datasetId}/manifest`, signal);
  if (manifest.version !== 1) throw new Error(`Unsupported LiDAR point artifact version: ${manifest.version}`);
  if (manifest.record_stride_bytes !== 20) throw new Error(`Unsupported LiDAR record stride: ${manifest.record_stride_bytes}`);

  const download = await apiDownload(manifest.points_url, signal);
  const buffer = await download.blob.arrayBuffer();
  const expected = manifest.point_count * manifest.record_stride_bytes;
  if (buffer.byteLength !== expected) {
    throw new Error(`LiDAR point artifact is incomplete (${buffer.byteLength} of ${expected} bytes)`);
  }

  const positions = new Float32Array(manifest.point_count * 3);
  const rgb = new Uint8Array(manifest.point_count * 3);
  const classifications = new Uint8Array(manifest.point_count);
  const intensities = new Uint16Array(manifest.point_count);
  const view = new DataView(buffer);

  for (let index = 0; index < manifest.point_count; index += 1) {
    const offset = index * manifest.record_stride_bytes;
    const p = index * 3;
    positions[p] = view.getFloat32(offset, true);
    positions[p + 1] = view.getFloat32(offset + 4, true);
    positions[p + 2] = view.getFloat32(offset + 8, true);
    rgb[p] = view.getUint8(offset + 12);
    rgb[p + 1] = view.getUint8(offset + 13);
    rgb[p + 2] = view.getUint8(offset + 14);
    classifications[index] = view.getUint8(offset + 15);
    intensities[index] = view.getUint16(offset + 16, true);
  }

  return { manifest, positions, rgb, classifications, intensities };
}

export function buildLidarColors(data: LidarPointData, mode: LidarColorMode): Float32Array {
  const count = data.manifest.point_count;
  const colors = new Float32Array(count * 3);
  const zRange = Math.max(0.001, data.manifest.bounds.z_max_m - data.manifest.bounds.z_min_m);
  const intensityRange = Math.max(1, data.manifest.intensity_max - data.manifest.intensity_min);

  for (let index = 0; index < count; index += 1) {
    const p = index * 3;
    let r: number;
    let g: number;
    let b: number;

    if (mode === "rgb" && data.manifest.has_rgb) {
      r = data.rgb[p];
      g = data.rgb[p + 1];
      b = data.rgb[p + 2];
    } else if (mode === "classification" && data.manifest.has_classification) {
      [r, g, b] = CLASSIFICATION_COLORS[data.classifications[index]] ?? [200, 200, 200];
    } else if (mode === "intensity" && data.manifest.has_intensity) {
      const normalized = (data.intensities[index] - data.manifest.intensity_min) / intensityRange;
      const gray = Math.round(Math.min(1, Math.max(0, normalized)) * 255);
      r = gray;
      g = gray;
      b = gray;
    } else {
      const normalized = data.positions[p + 2] / zRange;
      [r, g, b] = turboLike(normalized);
    }

    colors[p] = r / 255;
    colors[p + 1] = g / 255;
    colors[p + 2] = b / 255;
  }
  return colors;
}
