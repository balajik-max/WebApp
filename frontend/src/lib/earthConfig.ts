import type { RasterDEMSourceSpecification } from "maplibre-gl";

/** The two top-level map viewing modes.
 *  - "standard": Mercator, terrain off, ordinary pan/zoom (legacy behaviour).
 *  - "earth3d":  globe projection, terrain + sky, orbit/look-at navigation. */
export type MapViewMode = "standard" | "earth3d";

// --- Source / layer identifiers (kept stable across style reloads) ---------
export const TERRAIN_SOURCE_ID = "terrain-dem";
export const TERRAIN_HILLSHADE_ID = "terrain-hillshade";

// --- Camera limits (Phase 9 / 13) ------------------------------------------
/** Hard hardware ceiling for MapLibre pitch on globe projection. */
export const MAX_TILT_DEG = 85;
/** Mercator/raster legibility ceiling used in Standard mode. */
export const STANDARD_MAX_PITCH = 65;
export const MIN_TILT_DEG = 0;
/** Safe camera-to-target distance band (metres). */
export const MIN_RANGE_M = 25;
export const MAX_RANGE_M = 20_000_000;

/** Earth mean radius used for the range<->zoom conversion. */
export const EARTH_RADIUS_M = 6371008.8;

/** Default terrain vertical exaggeration (Phase 6). */
export const TERRAIN_EXAGGERATION = 1.0;

/** Orbit sensitivities (Phase 13). */
export const ORBIT_HEADING_SENSITIVITY = 0.2; // deg of heading per px
export const ORBIT_TILT_SENSITIVITY = 0.15; // deg of tilt per px

/** Wheel dolly scale (Phase 14). */
export const DOLLY_WHEEL_SCALE = 0.001;

/** Tilt applied when first entering 3D Earth so the horizon is visible. */
export const DEFAULT_EARTH_TILT_DEG = 60;

/** Public, token-free AWS terrain tiles (Terrarium encoding) used as a safe
 *  default when no provider is configured. This is MapLibre's documented
 *  demo terrain source and requires no API key. */
export const AWS_TERRARIUM_TILEJSON =
  "https://elevation-tiles-prod.s3.amazonaws.com/terrarium.json";

export type TerrainEncoding = "terrarium" | "mapbox" | "custom";

export interface TerrainConfig {
  /** Master switch. Set VITE_ENABLE_3D_EARTH=false to disable entirely. */
  enabled: boolean;
  /** Resolved raster-dem source definition, or null when disabled. */
  source: RasterDEMSourceSpecification | null;
}

function readEnv(name: string, fallback = ""): string {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return value && value.length > 0 ? value : fallback;
}

function buildTerrainConfig(): TerrainConfig {
  const enabled = readEnv("VITE_ENABLE_3D_EARTH", "true") !== "false";
  if (!enabled) {
    return { enabled: false, source: null };
  }

  const tileJsonUrl = readEnv("VITE_TERRAIN_TILEJSON_URL");
  const tilesUrl = readEnv("VITE_TERRAIN_TILES_URL");
  const encoding = readEnv("VITE_TERRAIN_ENCODING", "terrarium") as TerrainEncoding;
  const tileSize = Number(readEnv("VITE_TERRAIN_TILE_SIZE", "256")) || 256;
  const maxZoom = Number(readEnv("VITE_TERRAIN_MAX_ZOOM", "14")) || 14;

  // No explicit provider configured: fall back to the public AWS terrarium
  // source so a globe view with real elevation works out of the box.
  const resolvedTileJson = tileJsonUrl || AWS_TERRARIUM_TILEJSON;

  const source: RasterDEMSourceSpecification = tilesUrl
    ? {
        type: "raster-dem",
        tiles: [tilesUrl],
        tileSize,
        encoding,
        maxzoom: maxZoom,
      }
    : {
        type: "raster-dem",
        url: resolvedTileJson,
        tileSize,
        encoding,
      };

  return { enabled: true, source };
}

export const TERRAIN_CONFIG: TerrainConfig = buildTerrainConfig();

/** MapLibre sky/atmosphere specification (Phase 8). In v5 `atmosphere-blend`
 *  is a constant number (not an expression). */
export const SKY_SPECIFICATION = {
  "sky-color": "#87A8C7",
  "horizon-color": "#D8E4ED",
  "fog-color": "#D8E4ED",
  "sky-horizon-blend": 0.35,
  "horizon-fog-blend": 0.5,
  "fog-ground-blend": 0.6,
  "atmosphere-blend": 0.6,
} as const;
