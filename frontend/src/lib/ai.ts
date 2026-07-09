/** AI Assistant API client. */
import { apiPost } from "./api";

export type AiKind = "query" | "recommend" | "report";

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
}

export const aiQuery = (body: {
  question: string;
  dataset_id?: string;
  ward?: string;
  feature_ids?: string[];
  max_features?: number;
}) => apiPost<AiAnswer>("/api/v1/ai/query", body);

export const aiRecommend = (body: { feature_id: string }) =>
  apiPost<AiAnswer>("/api/v1/ai/recommend", body);

export const aiReport = (body: { dataset_id?: string; ward?: string; max_features?: number }) =>
  apiPost<AiAnswer>("/api/v1/ai/report", body);
