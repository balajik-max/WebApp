import { apiDownload, apiGet } from "./api";

export interface LidarFullChunk {
  index: number;
  point_count: number;
  byte_length: number;
  url: string;
}

export interface LidarFullManifest {
  version: number;
  mode: "experimental-full";
  dataset_id: string;
  source_size_bytes: number | null;
  source_fingerprint: string;
  source_crs: string;
  point_count_source: number;
  point_count: number;
  dropped_invalid_points: number;
  record_stride_bytes: number;
  chunk_points_target: number;
  chunk_count: number;
  estimated_binary_bytes: number;
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
  default_color_mode: "rgb" | "classification" | "elevation";
  chunks: LidarFullChunk[];
}

export interface ParsedLidarFullChunk {
  positions: Float32Array;
  colors: Uint8Array;
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

function elevationColor(z: number, maxZ: number): [number, number, number] {
  const value = Math.min(1, Math.max(0, z / Math.max(0.001, maxZ)));
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * value - 3))));
  const g = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * value - 2))));
  const b = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * value - 1))));
  return [r, g, b];
}

export async function fetchLidarFullManifest(
  datasetId: string,
  signal?: AbortSignal
): Promise<LidarFullManifest> {
  const manifest = await apiGet<LidarFullManifest>(
    `/api/v1/lidar-full/${datasetId}/manifest`,
    signal
  );
  if (manifest.version !== 1 || manifest.mode !== "experimental-full") {
    throw new Error("Unsupported full LiDAR artifact version");
  }
  if (manifest.record_stride_bytes !== 16) {
    throw new Error(`Unsupported full LiDAR record stride: ${manifest.record_stride_bytes}`);
  }
  return manifest;
}

export async function fetchAndParseLidarFullChunk(
  manifest: LidarFullManifest,
  chunk: LidarFullChunk,
  signal?: AbortSignal
): Promise<ParsedLidarFullChunk> {
  const download = await apiDownload(chunk.url, signal);
  const buffer = await download.blob.arrayBuffer();
  if (buffer.byteLength !== chunk.byte_length) {
    throw new Error(
      `LiDAR chunk ${chunk.index} is incomplete (${buffer.byteLength} of ${chunk.byte_length} bytes)`
    );
  }
  const expected = chunk.point_count * manifest.record_stride_bytes;
  if (buffer.byteLength !== expected) {
    throw new Error(`LiDAR chunk ${chunk.index} has an invalid point count`);
  }

  const positions = new Float32Array(chunk.point_count * 3);
  const colors = new Uint8Array(chunk.point_count * 3);
  const view = new DataView(buffer);
  const maxLocalZ = Math.max(0.001, manifest.bounds.z_max_m - manifest.origin.z_base_m);

  for (let index = 0; index < chunk.point_count; index += 1) {
    const offset = index * manifest.record_stride_bytes;
    const output = index * 3;
    const z = view.getFloat32(offset + 8, true);
    positions[output] = view.getFloat32(offset, true);
    positions[output + 1] = view.getFloat32(offset + 4, true);
    positions[output + 2] = z;

    if (manifest.has_rgb) {
      colors[output] = view.getUint8(offset + 12);
      colors[output + 1] = view.getUint8(offset + 13);
      colors[output + 2] = view.getUint8(offset + 14);
    } else if (manifest.has_classification) {
      const classification = view.getUint8(offset + 15);
      const [r, g, b] = CLASSIFICATION_COLORS[classification] ?? [200, 200, 200];
      colors[output] = r;
      colors[output + 1] = g;
      colors[output + 2] = b;
    } else {
      const [r, g, b] = elevationColor(z, maxLocalZ);
      colors[output] = r;
      colors[output + 1] = g;
      colors[output + 2] = b;
    }
  }

  return { positions, colors };
}
