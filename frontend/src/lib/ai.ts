/** AI Assistant API client. */
import { apiPost } from "./api";

export type AiKind = "summarize" | "query" | "prioritize" | "recommend";

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

export const aiSummarize = (body: {
  dataset_id?: string;
  ward?: string;
  max_features?: number;
}) => apiPost<AiAnswer>("/api/v1/ai/summarize", body);

export const aiQuery = (body: {
  question: string;
  dataset_id?: string;
  ward?: string;
  feature_ids?: string[];
  max_features?: number;
}) => apiPost<AiAnswer>("/api/v1/ai/query", body);

export const aiPrioritize = (body: { ward?: string; limit?: number }) =>
  apiPost<AiAnswer>("/api/v1/ai/prioritize", body);

export const aiRecommend = (body: { feature_id: string }) =>
  apiPost<AiAnswer>("/api/v1/ai/recommend", body);
