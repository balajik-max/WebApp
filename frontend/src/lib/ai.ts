/** AI Assistant API client. */
import { apiPost } from "./api";

export type AiKind = "query" | "recommend" | "report" | "spacing" | "manhole_recommend";

export interface NeededLocation {
  id: string;
  lon: number;
  lat: number;
  reason: string;
}

export interface PipeSpec {
  material: string;
  diameter_mm: number;
  from_rl: number | null;
  to_rl: number | null;
  slope: number | null;
}

export interface PipeRoute {
  from_id: string;
  to_id: string | null;
  coordinates: [number, number][];
  pipe_spec: PipeSpec;
  /** network-mode only: which real source grounded the flow direction
   * (surveyed_invert / dtm_raster / nearest_contour / unknown), and
   * whether a direction was actually confirmed vs just drawn. */
  elevation_source?: string | null;
  flow_confirmed?: boolean | null;
  /** Network-mode only: this connection needs closure/attention because of
   * a recorded poor condition, local-low-point risk, or unconfirmed flow. */
  rainy_season_closed?: boolean | null;
  /** network-mode only: "sewage_line" (real surveyed pipe), "concrete_road"
   * (no pipe path existed, followed the road network instead), or "bridge"
   * (neither graph spanned the gap, a direct building-checked line was used
   * to keep the network unified) — never left ambiguous which one grounds
   * a given line. */
  route_basis?: string | null;
}

export interface AiAnswer {
  kind: AiKind;
  model: string;
  prompt_tokens_hint: number;
  context_rows: number;
  grounded: boolean;
  answer_markdown: string;
  generated_at: string;
  disclaimer: string | null;
  debug?: Record<string, unknown> | null;
  /** Spacing-only: feature IDs the AI classifies as redundant → show red on map */
  redundant_feature_ids: string[];
  /** Spacing-only: proposed missing/service-gap IDs/points -> show green on map */
  needed_feature_ids: string[];
  needed_locations: NeededLocation[];
  /** manhole_recommend-only: proposed/rehab pipe routes with real coordinates + specs */
  routes: PipeRoute[];
  /** network-mode only: manholes with no real sewage/drain pipe within reach
   * — no route is drawn for these, so they need their own marker + reason. */
  unconnected_manholes: NeededLocation[];
}

export const aiQuery = (body: {
  question: string;
  dataset_id?: string;
  ward?: string;
  category?: string;
  feature_ids?: string[];
  max_features?: number;
}) => apiPost<AiAnswer>("/api/v1/ai/query", body);

export const aiRecommend = (body: { feature_id: string }) =>
  apiPost<AiAnswer>("/api/v1/ai/recommend", body);

export const aiReport = (body: {
  dataset_id?: string;
  dataset_ids?: string[];
  ward?: string;
  categories?: string[];
  severity_buckets?: Array<"low" | "medium" | "high">;
  all_datasets?: boolean;
  max_features?: number;
}) => apiPost<AiAnswer>("/api/v1/ai/report", body);

export const aiSpacing = (body: {
  dataset_id?: string;
  ward?: string;
  category: string;
  distance_m?: number;
}) => apiPost<AiAnswer>("/api/v1/ai/spacing", body);

export const aiManholeRecommend = (body: {
  mode: "feature" | "area" | "network";
  dataset_id: string;
  feature_id?: string;
}) => apiPost<AiAnswer>("/api/v1/ai/manhole-recommend", body);
