/** AI Assistant API client. */
import { apiPost } from "./api";

export type AiKind = "query" | "recommend" | "report" | "spacing";

export interface NeededLocation {
  id: string;
  lon: number;
  lat: number;
  reason: string;
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
