import { apiGet, apiPost, apiPut } from "./api";

export type PotholeRateMode = "official" | "manual";
export type RoadSurface =
  | "bituminous"
  | "concrete"
  | "paver"
  | "wbm"
  | "wmm"
  | "gravel"
  | "earthen"
  | "composite"
  | "unknown";

export interface PotholeRateDetails {
  rate_value: number | null;
  rate_per_sqm: number | null;
  unit: string;
  source: string;
  year: string;
  rate_basis_year: string | null;
  item_code: string;
  item_description: string;
  effective_from: string | null;
  source_document: string | null;
  source_page: number | null;
  source_url: string | null;
  status: string;
  verified_at: string | null;
  last_sync_error: string | null;
  gst_included: boolean;
  rate_mode: PotholeRateMode;
}

export interface RepairOption {
  item_code: string;
  label: string;
  unit: "m2" | "m3" | string;
  rate_value: number;
  status: string;
}

export interface MaterialBreakdown {
  name: string;
  quantity: number | null;
  quantity_unit: string;
  rate: number | null;
  rate_unit: string | null;
  amount_inr: number | null;
  rate_year: string | null;
  source_document: string | null;
  source_page: number | null;
  note: string | null;
  included_in_finished_rate: boolean;
}

export interface PotholeCostEstimate {
  anomaly_id: string;
  area_sqm: number;
  depth_mm: number | null;
  calculated_quantity: number | null;
  quantity_unit: string;
  road_category: string;
  road_surface: RoadSurface;
  road_type_source: string | null;
  pothole_type: "shallow" | "deep";
  recommended_repair_method: string;
  financial_year: string;
  estimate_date: string;
  rate_mode: PotholeRateMode;
  selected_item_code: string;
  available_items: RepairOption[];
  manual_rate_value: number | null;
  manual_rate_unit: "m2" | "m3" | null;
  manual_rate_per_sqm: number | null;
  official_rate_applicable: boolean;
  base_repair_cost_inr: number | null;
  labour_charge_enabled: boolean;
  labour_charge_per_pothole_inr: number;
  additional_charge_reason: string | null;
  total_repair_cost_inr: number | null;
  rate: PotholeRateDetails;
  materials: MaterialBreakdown[];
  material_breakdown_informational_only: boolean;
  calculation_status: string;
  calculation_formula: string;
  online_refresh_attempted: boolean;
  warning: string | null;
}

export interface SavePotholeCostEstimatePayload {
  rate_mode: PotholeRateMode;
  financial_year: string;
  estimate_date: string;
  selected_item_code: string | null;
  repair_depth_mm: number | null;
  manual_rate_value: number | null;
  manual_rate_unit: "m2" | "m3";
  manual_rate_per_sqm?: number | null;
  labour_enabled: boolean;
  labour_charge_per_pothole_inr: number;
  additional_charge_reason: string | null;
}

export interface FinancialYearOption {
  financial_year: string;
  source_url: string | null;
  cached: boolean;
}

export interface PotholeRateSyncResult {
  financial_year: string;
  status: string;
  documents_found: number;
  documents_downloaded: number;
  rates_extracted: number;
  requires_review: number;
  message: string;
}

export function fetchPotholeFinancialYears(signal?: AbortSignal) {
  return apiGet<FinancialYearOption[]>("/api/v1/pothole-cost/years", signal);
}

export function fetchPotholeCostEstimate(
  anomalyId: string,
  options?: { financialYear?: string; estimateDate?: string },
  signal?: AbortSignal
) {
  const params = new URLSearchParams({ refresh_online: "false" });
  if (options?.financialYear) params.set("financial_year", options.financialYear);
  if (options?.estimateDate) params.set("estimate_date", options.estimateDate);
  return apiGet<PotholeCostEstimate>(
    `/api/v1/pothole-cost/estimate/${encodeURIComponent(anomalyId)}?${params.toString()}`,
    signal
  );
}

export function savePotholeCostEstimate(
  anomalyId: string,
  payload: SavePotholeCostEstimatePayload,
  signal?: AbortSignal
) {
  return apiPut<PotholeCostEstimate>(
    `/api/v1/pothole-cost/estimate/${encodeURIComponent(anomalyId)}`,
    payload,
    signal
  );
}

export function syncPotholeRates(financialYear: string, signal?: AbortSignal) {
  return apiPost<PotholeRateSyncResult>(
    `/api/v1/pothole-cost/rates/sync/${encodeURIComponent(financialYear)}`,
    {},
    signal
  );
}
