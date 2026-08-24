import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ApiError, apiAssetUrl } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { useTypewriter } from "../lib/useTypewriter";
import { explainAnomaly, type AnomalyStatus, type SpatialAnomaly } from "../lib/workflow";
import {
  fetchPotholeCostEstimate,
  fetchPotholeFinancialYears,
  savePotholeCostEstimate,
  syncPotholeRates,
  type PotholeCostEstimate,
  type PotholeRateMode,
} from "../lib/potholeCost";
import { UrbanPlanningSolutionPanel } from "./UrbanPlanningSolutionPanel";

interface Props {
  anomaly: SpatialAnomaly;
  onClose: () => void;
  onStatusChange: (anomalyId: string, next: AnomalyStatus) => void;
  /** A newer audit run replaced this finding server-side (its id no longer
   * exists) — remove it from the map/local state instead of showing a raw
   * fetch error, since re-running the audit is a normal, expected action. */
  onStale: (anomalyId: string) => void;
  /** Called once a fresh AI explanation is successfully generated, so the
   * shared anomalies list (not just this card's own local state) caches it —
   * otherwise closing and reopening the same finding always re-fetches from
   * scratch, and a remount mid-fetch (this card's own AbortController firing)
   * can leave the panel with no explanation and no visible error at all. */
  onExplained?: (anomalyId: string, explanationText: string) => void;
  /** Set when this card was opened from Road Inspection's issue list — `onClose`
   * already returns there (its state was never torn down), but the "×" alone
   * reads as "dismiss", not "go back". Shows an explicit back affordance so
   * that's obvious instead of implicit. */
  backToRoadLabel?: string;
}

const TYPE_LABEL: Record<SpatialAnomaly["anomaly_type"], string> = {
  pole_redundancy: "Pole Redundancy",
  drain_encroachment: "Drain Encroachment",
  manhole_status: "Manhole Status",
  road_width_narrowing: "Road Width Narrowing",
  powerline_proximity: "Powerline Proximity",
  pothole_status: "Pothole Condition",
  standing_water_status: "Standing Water",
};

const COLOR_LABEL: Record<SpatialAnomaly["color"], string> = {
  red: "Critical",
  yellow: "Review",
  green: "Confirmed OK",
};

/** Facts worth surfacing verbatim next to the AI narration — the same
 * numbers the LLM was given, shown as data so this is never a black box. */
function metadataEntries(metadata: Record<string, unknown>): [string, string][] {
  const skip = new Set([
    "this_feature_id", "kept_feature_id", "building_id", "manhole_id", "pothole_id", "standing_water_id", "top_reference_feature_id", "nearest_drain_id", "drain_ids",
    "centerline_feature_id", "left_edge_feature_id", "right_edge_feature_id",
    "affected_line_wkt", "sample_interval_m", "probe_length_m",
    "recommended_repair_method", "sr_rate_per_sqm", "sr_rate_unit",
    "sr_rate_source", "sr_rate_year", "sr_item_code",
    "estimated_repair_cost_inr", "cost_estimate_status", "cost_estimate_basis",
  ]);
  return Object.entries(metadata)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => [
      k.replace(/_/g, " "),
      Array.isArray(v) ? v.join(", ") : String(v),
    ]);
}

function formatInr(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function rateStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    official_pdf_verified: "Official PDF-verified rate",
    auto_extracted_high_confidence: "Official PDF auto-extracted rate",
    base_sr_reference_applied: "Earlier SR base reference — verification required",
    base_reference: "Earlier SR base reference",
    manual_user_rate: "User-entered manual rate",
    manual_rate_required: "Manual rate required",
    loading: "Loading selected pothole estimate",
  };
  return labels[status] ?? status.replace(/_/g, " ");
}

function formatDate(value: string | null): string {
  if (!value) return "Not applicable";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-IN");
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const detail = (error.body as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((entry) => (entry && typeof entry === "object" ? String((entry as { msg?: unknown }).msg ?? "") : ""))
        .filter(Boolean);
      if (messages.length) return messages.join("; ");
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

const MIN_WIDTH = 280;
const MIN_HEIGHT = 220;

type ResizeEdge = "right" | "bottom" | "corner";

export function AnomalyAlertCard({ anomaly, onClose, onStatusChange, onStale, onExplained, backToRoadLabel }: Props) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const canEditCost = user?.role !== "mla";
  const [liveRepairEstimate, setLiveRepairEstimate] = useState<PotholeCostEstimate | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const [rateMode, setRateMode] = useState<PotholeRateMode>("official");
  const [selectedItemCode, setSelectedItemCode] = useState("10.15(ii)");
  const [financialYears, setFinancialYears] = useState<string[]>(["2026-27", "2023-24"]);
  const [financialYear, setFinancialYear] = useState("2026-27");
  const [estimateDate, setEstimateDate] = useState("2026-07-27");
  const [repairDepthInput, setRepairDepthInput] = useState("");
  const [manualRateInput, setManualRateInput] = useState("");
  const [manualRateUnit, setManualRateUnit] = useState<"m2" | "m3">("m2");
  const [labourEnabled, setLabourEnabled] = useState(false);
  const [labourInput, setLabourInput] = useState("0");
  const [additionalReason, setAdditionalReason] = useState("");
  const [savingCost, setSavingCost] = useState(false);
  const [syncingRates, setSyncingRates] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<string | null>(anomaly.explanation_text);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typedExplanation = useTypewriter(explanation ?? "");

  // Draggable (header) + resizable (right/bottom/corner handles), so a long
  // AI explanation or a wide metrics table (e.g. Road Width Narrowing) isn't
  // stuck cramped into a fixed 320px box — the user can both move the panel
  // out of the way and grow it to actually read the content comfortably.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const resizeStartRef = useRef<{ edge: ResizeEdge; x: number; y: number; width: number; height: number } | null>(null);
  const resizePointerIdRef = useRef<number | null>(null);

  const clampToViewport = (x: number, y: number, width: number, height: number) => {
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) };
  };

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // Ignore drags started on the header's own buttons so they still just click.
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    dragPointerIdRef.current = e.pointerId;
    e.preventDefault();
  };
  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const offset = dragOffsetRef.current;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!offset || !rect) return;
    const nextX = e.clientX - offset.x;
    const nextY = e.clientY - offset.y;
    setPosition(clampToViewport(nextX, nextY, rect.width, rect.height));
    e.preventDefault();
  };
  const endHeaderDrag = (e: React.PointerEvent<HTMLElement>) => {
    dragOffsetRef.current = null;
    dragPointerIdRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleResizePointerDown = (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Dragging a resize handle also pins the panel's current on-screen
    // position (if it hadn't been moved yet) so it grows from where it
    // already is instead of jumping back to the default top/right corner.
    setPosition((prev) => prev ?? { x: rect.left, y: rect.top });
    resizeStartRef.current = { edge, x: e.clientX, y: e.clientY, width: rect.width, height: rect.height };
    e.currentTarget.setPointerCapture(e.pointerId);
    resizePointerIdRef.current = e.pointerId;
    e.preventDefault();
    e.stopPropagation();
  };
  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!start || !rect) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - rect.left - 8);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - rect.top - 8);
    setSize({
      width: start.edge === "bottom" ? rect.width : Math.min(maxWidth, Math.max(MIN_WIDTH, start.width + dx)),
      height: start.edge === "right" ? rect.height : Math.min(maxHeight, Math.max(MIN_HEIGHT, start.height + dy)),
    });
    e.preventDefault();
    e.stopPropagation();
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null;
    resizePointerIdRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Keep the card inside the viewport if the window shrinks after being
  // dragged/resized near an edge.
  useEffect(() => {
    const handleResize = () => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition((prev) => (prev ? clampToViewport(prev.x, prev.y, rect.width, rect.height) : prev));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // On unmount (e.g. closed mid-drag/resize) release any active pointer
  // capture so the browser cursor is never left stuck in dragging mode.
  useEffect(() => {
    const el = panelRef.current;
    return () => {
      const dragId = dragPointerIdRef.current;
      const resizeId = resizePointerIdRef.current;
      if (dragId !== null && el?.hasPointerCapture(dragId)) el.releasePointerCapture(dragId);
      if (resizeId !== null && el?.hasPointerCapture(resizeId)) el.releasePointerCapture(resizeId);
    };
  }, []);

  useEffect(() => {
    setExplanation(anomaly.explanation_text);
    setError(null);
    if (anomaly.explanation_text) return;
    const ctrl = new AbortController();
    setLoading(true);
    explainAnomaly(anomaly.id, ctrl.signal)
      .then((r) => {
        setExplanation(r.explanation_text);
        onExplained?.(anomaly.id, r.explanation_text);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        if (e instanceof ApiError && e.status === 404) {
          onStale(anomaly.id);
          return;
        }
        setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [anomaly.id, anomaly.explanation_text, onStale, onExplained]);

  const hydrateCostEstimate = (estimate: PotholeCostEstimate) => {
    setLiveRepairEstimate(estimate);
    setRateMode(estimate.rate_mode);
    setSelectedItemCode(estimate.selected_item_code);
    setFinancialYear(estimate.financial_year);
    setEstimateDate(estimate.estimate_date);
    setRepairDepthInput(estimate.depth_mm == null ? "" : String(estimate.depth_mm));
    setManualRateInput(estimate.manual_rate_value == null ? "" : String(estimate.manual_rate_value));
    setManualRateUnit(estimate.manual_rate_unit ?? (estimate.quantity_unit === "m3" ? "m3" : "m2"));
    setLabourEnabled(estimate.labour_charge_enabled);
    setLabourInput(String(estimate.labour_charge_per_pothole_inr));
    setAdditionalReason(estimate.additional_charge_reason ?? "");
  };

  useEffect(() => {
    setLiveRepairEstimate(null);
    setCostError(null);
    setSyncMessage(null);
    setRateMode("official");
    setSelectedItemCode("10.15(ii)");
    setFinancialYear("2026-27");
    setEstimateDate("2026-07-27");
    setRepairDepthInput("");
    setManualRateInput("");
    setManualRateUnit("m2");
    setLabourEnabled(false);
    setLabourInput("0");
    setAdditionalReason("");
    if (anomaly.anomaly_type !== "pothole_status") return;

    const ctrl = new AbortController();
    setCostLoading(true);
    Promise.all([
      fetchPotholeCostEstimate(anomaly.id, undefined, ctrl.signal),
      fetchPotholeFinancialYears(ctrl.signal).catch(() => []),
    ])
      .then(([estimate, years]) => {
        hydrateCostEstimate(estimate);
        const values = years.map((entry) => entry.financial_year);
        if (values.length) setFinancialYears(Array.from(new Set(values)).sort().reverse());
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        if (e instanceof ApiError && e.status === 404) {
          onStale(anomaly.id);
          return;
        }
        setCostError(apiErrorMessage(e, "Unable to calculate pothole repair cost"));
      })
      .finally(() => setCostLoading(false));
    return () => ctrl.abort();
  }, [anomaly.id, anomaly.anomaly_type, onStale]);

  const previewYearAndDate = async (nextYear: string, nextDate: string) => {
    if (!/^\d{4}-\d{2}$/.test(nextYear) || !nextDate) return;
    setCostLoading(true);
    setCostError(null);
    try {
      const estimate = await fetchPotholeCostEstimate(anomaly.id, {
        financialYear: nextYear,
        estimateDate: nextDate,
      });
      hydrateCostEstimate(estimate);
    } catch (e) {
      setCostError(apiErrorMessage(e, "Unable to load the selected SR year"));
    } finally {
      setCostLoading(false);
    }
  };

  const handleSyncRates = async () => {
    if (!/^\d{4}-\d{2}$/.test(financialYear)) {
      setCostError("Financial year must use YYYY-YY format, for example 2027-28.");
      return;
    }
    setSyncingRates(true);
    setSyncMessage(null);
    setCostError(null);
    try {
      const result = await syncPotholeRates(financialYear);
      setSyncMessage(result.message);
      const years = await fetchPotholeFinancialYears();
      setFinancialYears(Array.from(new Set(years.map((entry) => entry.financial_year))).sort().reverse());
      await previewYearAndDate(financialYear, estimateDate);
    } catch (e) {
      setCostError(apiErrorMessage(e, "Unable to synchronize official KPWD documents"));
    } finally {
      setSyncingRates(false);
    }
  };

  const handleApplyCost = async () => {
    const labourCharge = Number(labourInput || 0);
    if (!Number.isFinite(labourCharge) || labourCharge < 0) {
      setCostError("Enter a valid additional labour/mobilisation charge of zero or more.");
      return;
    }
    if (labourEnabled && !additionalReason.trim()) {
      setCostError("Enter the reason or approval reference for the additional charge.");
      return;
    }

    const manualRate = manualRateInput.trim() === "" ? null : Number(manualRateInput);
    if (rateMode === "manual" && (!Number.isFinite(manualRate) || (manualRate ?? 0) <= 0)) {
      setCostError("Enter a valid manual rate greater than zero.");
      return;
    }
    const repairDepth = repairDepthInput.trim() === "" ? null : Number(repairDepthInput);
    if (repairDepth != null && (!Number.isFinite(repairDepth) || repairDepth < 0)) {
      setCostError("Enter a valid repair depth in millimetres.");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(financialYear)) {
      setCostError("Financial year must use YYYY-YY format, for example 2026-27.");
      return;
    }

    setSavingCost(true);
    setCostLoading(true);
    setCostError(null);
    try {
      const estimate = await savePotholeCostEstimate(anomaly.id, {
        rate_mode: rateMode,
        financial_year: financialYear,
        estimate_date: estimateDate,
        selected_item_code: rateMode === "official" ? selectedItemCode : null,
        repair_depth_mm: repairDepth,
        manual_rate_value: rateMode === "manual" ? manualRate : null,
        manual_rate_unit: manualRateUnit,
        manual_rate_per_sqm: rateMode === "manual" && manualRateUnit === "m2" ? manualRate : null,
        labour_enabled: labourEnabled,
        labour_charge_per_pothole_inr: labourCharge,
        additional_charge_reason: labourEnabled ? additionalReason.trim() : null,
      });
      hydrateCostEstimate(estimate);
    } catch (e) {
      setCostError(apiErrorMessage(e, "Unable to save the selected pothole estimate"));
    } finally {
      setSavingCost(false);
      setCostLoading(false);
    }
  };

  const displayedArea = liveRepairEstimate?.area_sqm ?? 0;
  const displayedRate = liveRepairEstimate?.rate.rate_value ?? null;
  const displayedBaseCost = liveRepairEstimate?.base_repair_cost_inr ?? null;
  const displayedLabour = liveRepairEstimate?.labour_charge_per_pothole_inr ?? 0;
  const displayedTotal = liveRepairEstimate?.total_repair_cost_inr ?? null;
  const displayedMethod = liveRepairEstimate?.recommended_repair_method ?? "Not configured";
  const displayedSource = liveRepairEstimate?.rate.source ?? "Not configured";
  const displayedYear = liveRepairEstimate?.rate.year ?? "Not configured";
  const displayedItemCode = liveRepairEstimate?.rate.item_code ?? "Not configured";
  const displayedRateStatus = liveRepairEstimate?.rate.status ?? "loading";
  const displayedEffectiveFrom = liveRepairEstimate?.rate.effective_from ?? null;
  const displayedSourceDocument = liveRepairEstimate?.rate.source_document ?? null;
  const displayedSourcePage = liveRepairEstimate?.rate.source_page ?? null;
  const displayedSourceUrl = liveRepairEstimate?.rate.source_url ?? null;
  const displayedGst = liveRepairEstimate?.rate.gst_included ?? false;
  const hasRepairEstimate = Boolean(liveRepairEstimate);

  const style: React.CSSProperties | undefined = {
    ...(position ? { top: position.y, left: position.x, right: "auto", transform: "none" } : undefined),
    ...(size ? { width: size.width, maxHeight: size.height } : undefined),
  };

  return (
    <aside
      className="anomaly-card"
      data-testid="anomaly-alert-card"
      ref={panelRef as React.RefObject<HTMLElement>}
      style={style}
    >
      <header
        className="anomaly-card__head"
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
        data-testid="anomaly-card-head"
      >
        <div>
          {backToRoadLabel && (
            <button type="button" className="anomaly-card__back" onClick={onClose}>
              ← Back to {backToRoadLabel}
            </button>
          )}
          <span className={`anomaly-card__badge anomaly-card__badge--${anomaly.color}`}>
            {COLOR_LABEL[anomaly.color]}
          </span>
          <h3 className="anomaly-card__title">{TYPE_LABEL[anomaly.anomaly_type]}</h3>
        </div>
        <button type="button" className="anomaly-card__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="anomaly-card__body">
        {loading && <div className="anomaly-card__loading">Generating explanation…</div>}
        {error && <div className="anomaly-card__error">{error}</div>}
        {explanation && (
          <div className="anomaly-card__explanation">
            <ReactMarkdown>{typedExplanation}</ReactMarkdown>
          </div>
        )}

        <div className="anomaly-card__facts">
          {metadataEntries(anomaly.anomaly_metadata).map(([k, v]) => (
            <div className="anomaly-card__fact" key={k}>
              <span className="anomaly-card__fact-key">{k}</span>
              <span className="anomaly-card__fact-value">{v}</span>
            </div>
          ))}
        </div>

        {anomaly.anomaly_type === "pothole_status" && (
          <section className="anomaly-card__repair-cost" aria-label="Pothole repair cost estimate">
            <div className="anomaly-card__repair-cost-head">
              <div>
                <div className="anomaly-card__repair-cost-label">Pothole Repair Estimate</div>
                <div className="anomaly-card__repair-cost-status">{rateStatusLabel(displayedRateStatus)}</div>
              </div>
            </div>

            {costLoading && (
              <div className="anomaly-card__repair-cost-loading">
                Calculating the selected pothole using its mapped area and saved rate settings…
              </div>
            )}
            {costError && <div className="anomaly-card__repair-cost-error">{costError}</div>}
            {liveRepairEstimate?.warning && (
              <div className="anomaly-card__repair-cost-warning">{liveRepairEstimate.warning}</div>
            )}

            {hasRepairEstimate && liveRepairEstimate && (
              <>
                <div className="anomaly-card__repair-cost-grid anomaly-card__repair-cost-grid--selection">
                  <span>Selected Pothole</span>
                  <strong>{anomaly.anomaly_metadata.source_fid == null ? anomaly.id.slice(0, 8) : String(anomaly.anomaly_metadata.source_fid)}</strong>
                  <span>Area</span>
                  <strong>{displayedArea.toFixed(4)} m²</strong>
                  <span>Road Surface</span>
                  <strong>{liveRepairEstimate.road_category}</strong>
                  <span>Road-Type Source</span>
                  <strong>{liveRepairEstimate.road_type_source ?? "Not recorded"}</strong>
                  <span>Calculated Quantity</span>
                  <strong>{liveRepairEstimate.calculated_quantity == null ? "Depth/rate required" : `${liveRepairEstimate.calculated_quantity.toFixed(4)} ${liveRepairEstimate.quantity_unit === "m3" ? "m³" : "m²"}`}</strong>
                </div>

                <div className="anomaly-card__rate-settings">
                  <div className="anomaly-card__settings-title">SR Year and Estimate Date</div>
                  <label className="anomaly-card__field-label">
                    Financial year
                    <input
                      type="text"
                      list={`pothole-financial-years-${anomaly.id}`}
                      value={financialYear}
                      disabled={!canEditCost || savingCost}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => setFinancialYear(event.target.value)}
                      onBlur={() => void previewYearAndDate(financialYear, estimateDate)}
                      placeholder="2026-27"
                    />
                    <datalist id={`pothole-financial-years-${anomaly.id}`}>
                      {financialYears.map((year) => <option value={year} key={year} />)}
                    </datalist>
                  </label>
                  <label className="anomaly-card__field-label">
                    Estimate date
                    <input
                      type="date"
                      value={estimateDate}
                      disabled={!canEditCost || savingCost}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => setEstimateDate(event.target.value)}
                      onBlur={() => void previewYearAndDate(financialYear, estimateDate)}
                    />
                  </label>
                  {isAdmin && (
                    <button
                      type="button"
                      className="anomaly-card__sync-rates"
                      onClick={handleSyncRates}
                      disabled={syncingRates || savingCost}
                    >
                      {syncingRates ? "Synchronizing KPWD PDFs…" : "Sync Official KPWD Documents"}
                    </button>
                  )}
                  {syncMessage && <small className="anomaly-card__sync-message">{syncMessage}</small>}
                </div>

                <div className="anomaly-card__rate-settings">
                  <div className="anomaly-card__settings-title">Rate Source</div>
                  <label className="anomaly-card__rate-option">
                    <input
                      type="radio"
                      name={`pothole-rate-${anomaly.id}`}
                      value="official"
                      checked={rateMode === "official"}
                      disabled={!canEditCost || !liveRepairEstimate.official_rate_applicable || savingCost}
                      onChange={() => setRateMode("official")}
                    />
                    Use Karnataka PWD SR for {financialYear}
                  </label>
                  <label className="anomaly-card__rate-option">
                    <input
                      type="radio"
                      name={`pothole-rate-${anomaly.id}`}
                      value="manual"
                      checked={rateMode === "manual"}
                      disabled={!canEditCost || savingCost}
                      onChange={() => {
                        setRateMode("manual");
                        const option = liveRepairEstimate.available_items.find((entry) => entry.item_code === selectedItemCode);
                        if (option?.unit === "m3") setManualRateUnit("m3");
                      }}
                    />
                    Enter an engineer-approved rate manually
                  </label>

                  {rateMode === "official" ? (
                    <label className="anomaly-card__field-label">
                      Applicable repair item
                      <select
                        value={selectedItemCode}
                        disabled={!canEditCost || savingCost}
                        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setSelectedItemCode(event.target.value)}
                      >
                        {liveRepairEstimate.available_items.map((option) => (
                          <option value={option.item_code} key={option.item_code}>
                            {option.item_code} — {option.label} — {formatInr(option.rate_value)}/{option.unit === "m3" ? "m³" : "m²"}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <>
                      <label className="anomaly-card__field-label">
                        Manual rate unit
                        <select
                          value={manualRateUnit}
                          disabled={!canEditCost || savingCost}
                          onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setManualRateUnit(event.target.value as "m2" | "m3")}
                        >
                          <option value="m2">Per square metre (m²)</option>
                          <option value="m3">Per cubic metre (m³)</option>
                        </select>
                      </label>
                      <label className="anomaly-card__field-label">
                        Approved manual rate per {manualRateUnit === "m3" ? "m³" : "m²"}
                        <span className="anomaly-card__money-input">
                          <span>₹</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            inputMode="decimal"
                            value={manualRateInput}
                            disabled={!canEditCost || savingCost}
                            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setManualRateInput(event.target.value)}
                            placeholder="Enter approved rate"
                            aria-label="Approved manual pothole repair rate"
                          />
                        </span>
                      </label>
                    </>
                  )}

                  <label className="anomaly-card__field-label">
                    Repair depth in millimetres
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="decimal"
                      value={repairDepthInput}
                      disabled={!canEditCost || savingCost}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => setRepairDepthInput(event.target.value)}
                      placeholder="Read from dataset or enter verified depth"
                    />
                    <small>Required for concrete, WMM, gravel and other items measured in m³.</small>
                  </label>
                </div>

                <div className="anomaly-card__labour-settings">
                  <label className="anomaly-card__labour-toggle">
                    <input
                      type="checkbox"
                      checked={labourEnabled}
                      disabled={!canEditCost || savingCost}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => setLabourEnabled(event.target.checked)}
                    />
                    Add approved project-specific labour / mobilisation charge
                  </label>
                  <label className="anomaly-card__field-label">
                    Additional charge per selected pothole
                    <span className="anomaly-card__money-input">
                      <span>₹</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="decimal"
                        value={labourInput}
                        disabled={!canEditCost || !labourEnabled || savingCost}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setLabourInput(event.target.value)}
                        aria-label="Additional labour or mobilisation charge per selected pothole"
                      />
                    </span>
                  </label>
                  <label className="anomaly-card__field-label">
                    Reason / approval reference
                    <input
                      type="text"
                      value={additionalReason}
                      disabled={!canEditCost || !labourEnabled || savingCost}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAdditionalReason(event.target.value)}
                      placeholder="Example: traffic diversion and night mobilisation"
                    />
                  </label>
                  <button
                    type="button"
                    className="anomaly-card__apply-cost"
                    onClick={handleApplyCost}
                    disabled={!canEditCost || savingCost}
                  >
                    {savingCost ? "Saving…" : "Apply & Recalculate"}
                  </button>
                  {!canEditCost && <small>Estimate settings are read-only for this account.</small>}
                </div>

                <div className="anomaly-card__repair-cost-breakdown">
                  <div>
                    <span>Finished-item repair cost</span>
                    <strong>{displayedBaseCost == null ? "Rate or quantity required" : formatInr(displayedBaseCost)}</strong>
                  </div>
                  <div>
                    <span>Additional approved charge</span>
                    <strong>{liveRepairEstimate.labour_charge_enabled ? formatInr(displayedLabour) : "Not applied"}</strong>
                  </div>
                  <div className="anomaly-card__repair-cost-total">
                    <span>Total estimated cost</span>
                    <strong>{displayedTotal == null ? "Rate or quantity required" : formatInr(displayedTotal)}</strong>
                  </div>
                </div>

                <div className="anomaly-card__repair-cost-formula">
                  {liveRepairEstimate.calculation_formula}
                </div>

                <div className="anomaly-card__repair-cost-grid">
                  <span>Recommended Repair</span>
                  <strong>{displayedMethod}</strong>
                  <span>Applied Rate</span>
                  <strong>{displayedRate == null ? "Not entered" : `${formatInr(displayedRate)}/${liveRepairEstimate.rate.unit.endsWith("m3") ? "m³" : "m²"}`}</strong>
                  <span>Rate Source</span>
                  <strong>{displayedSource}</strong>
                  <span>Requested Financial Year</span>
                  <strong>{displayedYear}</strong>
                  {liveRepairEstimate.rate.rate_basis_year && liveRepairEstimate.rate.rate_basis_year !== displayedYear && (
                    <>
                      <span>Rate Basis Year</span>
                      <strong>{liveRepairEstimate.rate.rate_basis_year}</strong>
                    </>
                  )}
                  <span>SR Item Code</span>
                  <strong>{displayedItemCode}</strong>
                  <span>Effective From</span>
                  <strong>{formatDate(displayedEffectiveFrom)}</strong>
                  <span>GST</span>
                  <strong>{displayedGst ? "Included" : "Excluded"}</strong>
                  {displayedSourceDocument && (
                    <>
                      <span>Source Document</span>
                      <strong>{displayedSourceDocument}{displayedSourcePage ? `, page ${displayedSourcePage}` : ""}</strong>
                    </>
                  )}
                </div>

                {liveRepairEstimate.materials.length > 0 && (
                  <div className="anomaly-card__materials">
                    <div className="anomaly-card__settings-title">Materials Included in the Finished Rate</div>
                    {liveRepairEstimate.materials.map((material) => (
                      <div className="anomaly-card__material-row" key={`${material.name}-${material.quantity_unit}`}>
                        <div>
                          <strong>{material.name}</strong>
                          {material.note && <small>{material.note}</small>}
                        </div>
                        <span>{material.quantity == null ? "Mix-design quantity" : `${material.quantity.toFixed(4)} ${material.quantity_unit}`}</span>
                        <span>{material.rate == null ? "Rate not separately verified" : `${formatInr(material.rate)}/${material.rate_unit?.replace("INR/", "") ?? material.quantity_unit}`}</span>
                        <span>{material.amount_inr == null ? "Included" : formatInr(material.amount_inr)}</span>
                      </div>
                    ))}
                    <small className="anomaly-card__material-note">These values explain the official finished-item rate. They are not added again, preventing double counting.</small>
                  </div>
                )}

                {displayedSourceUrl && (
                  <a
                    className="anomaly-card__repair-cost-source"
                    href={apiAssetUrl(displayedSourceUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source document
                  </a>
                )}

                <div className="anomaly-card__repair-cost-note">
                  The map click uses locally cached verified SR data, so KPWD website downtime does not break the estimate. Website/PDF synchronization is an administrator action. Material values are informational when a finished-item rate is used; only approved additional charges are added to the total.
                </div>
              </>
            )}
          </section>
        )}

        <UrbanPlanningSolutionPanel
          featureId={anomaly.feature_ids[0] ?? null}
          contextLabel={TYPE_LABEL[anomaly.anomaly_type]}
          placeholder={`Describe your proposed solution for this ${TYPE_LABEL[anomaly.anomaly_type].toLowerCase()} issue…`}
        />
      </div>

      <footer className="anomaly-card__actions">
        {anomaly.status !== "reviewing" && anomaly.status !== "resolved" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "reviewing")}>Mark Reviewing</button>
        )}
        {isAdmin && anomaly.status !== "dismissed" && anomaly.status !== "resolved" && (
          <button type="button" onClick={() => onStatusChange(anomaly.id, "dismissed")}>Dismiss</button>
        )}
        <span className="anomaly-card__workflow-note">Resolution follows the active remediation workflow and its required approvals.</span>
      </footer>

      <div
        className="anomaly-card__resize anomaly-card__resize--right"
        onPointerDown={handleResizePointerDown("right")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
      />
      <div
        className="anomaly-card__resize anomaly-card__resize--bottom"
        onPointerDown={handleResizePointerDown("bottom")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
      />
      <div
        className="anomaly-card__resize anomaly-card__resize--corner"
        onPointerDown={handleResizePointerDown("corner")}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
      />
    </aside>
  );
}
