/** Domain types shared between the map, the API layer, and detail panels. */

export interface FeatureAttributes {
  [key: string]: unknown;
}

export interface FeatureProperties {
  id: string;
  dataset_id: string;
  label: string | null;
  category: string | null;
  severity: number;
  attributes: FeatureAttributes;
}

export type FeatureGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "MultiPoint"; coordinates: [number, number][] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "MultiLineString"; coordinates: [number, number][][] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

export interface UrbanFeature {
  type: "Feature";
  id: string;
  geometry: FeatureGeometry;
  properties: FeatureProperties;
}

export interface FeatureCollectionResponse {
  type: "FeatureCollection";
  features: UrbanFeature[];
  bbox: [number, number, number, number];
  count: number;
  limit: number;
  truncated: boolean;
}

export interface FeatureFilter {
  ward?: string;
  category?: string;
  severity?: number;
  /** When set, isolates the map to exactly this set of datasets — overrides
   * ward/category/severity so a stale global filter can never combine
   * with a dataset selection to silently return zero or mixed results.
   * Multiple entries let the map show two or more datasets together
   * (e.g. a raster orthophoto plus its companion GDB vector layer). */
  datasetIds?: string[];
}
