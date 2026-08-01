import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ApiError } from "../lib/api";
import type { UrbanFeature } from "../lib/types";
import { classifyPropertyTaxFeature, propertyTaxColor } from "../lib/propertyTax";
import {
  PROPERTY_TAX_DISCREPANCY_OPTIONS,
  PROPERTY_TAX_STATUS_OPTIONS,
  applyMunicipalRecordToPayload,
  applySurveyEnrichmentToFeature,
  blankAssessmentPayload,
  buildGisTaxSnapshot,
  calculatePropertyTax,
  downloadMunicipalRegisterTemplate,
  fetchLinkedMunicipalRecord,
  fetchMunicipalRecordSuggestions,
  fetchPropertyTaxAssessment,
  fetchPropertyTaxAssessmentHistory,
  fetchPropertyTaxDemand,
  fetchSurveyEnrichment,
  generatePropertyTaxDemand,
  hydratePayloadFromGisSurvey,
  importMunicipalRecords,
  isOfflineAssessmentError,
  linkMunicipalRecord,
  loadLocalPropertyTaxDraft,
  saveLocalPropertyTaxDraft,
  savePropertyTaxAssessment,
  searchMunicipalRecords,
  unlinkMunicipalRecord,
  type FloorTaxLine,
  type MunicipalPropertyRecord,
  type PropertyTaxAssessment,
  type PropertyTaxAssessmentPayload,
  type PropertyTaxAssessmentRevision,
  type PropertyTaxAssessmentStatus,
  type PropertyTaxDemand,
  type PropertyTaxDiscrepancyStatus,
  type SurveyEnrichment,
} from "../lib/propertyTaxAssessment";

interface Props {
  feature: UrbanFeature;
  onClose: () => void;
}

type PanelTab = "record" | "comparison" | "calculation" | "history";
interface PanelPosition { x: number; y: number; }
interface PanelDragState extends PanelPosition {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  parentWidth: number;
  parentHeight: number;
  panelWidth: number;
  panelHeight: number;
}

const PANEL_EDGE_GAP = 10;
const USE_OPTIONS = [
  "Residential", "Commercial", "Mixed Use", "Industrial", "Public & Semi Public",
  "Dilapidated", "Under Construction", "Vacant Plot", "Exempt", "Other",
] as const;
const OCCUPANCY_OPTIONS = [
  "Owner occupied", "Tenant occupied", "Partially rented", "Fully rented", "Vacant",
  "Locked during survey", "Under construction", "Abandoned", "Usage not verified",
] as const;
const CONSTRUCTION_OPTIONS = [
  "RCC framed", "Load bearing", "Pucca", "Semi-pucca", "Kutcha", "Temporary",
  "Tin / sheet roof", "Dilapidated", "Not verified",
] as const;

function toNullableNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function text(value: string): string | null {
  const cleaned = value.trim();
  return cleaned || null;
}
function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}
function currency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object" && "detail" in error.body) {
    const detail = (error.body as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return fallback;
}
function statusLabel(value: PropertyTaxAssessmentStatus): string {
  return PROPERTY_TAX_STATUS_OPTIONS.find((item) => item.value === value)?.label ?? value;
}
function recordTitle(record: MunicipalPropertyRecord): string {
  return record.property_id ?? record.assessment_number ?? record.sas_number ?? record.door_number ?? "Municipal record";
}
function assessmentToPayload(existing: PropertyTaxAssessment, snapshot: ReturnType<typeof buildGisTaxSnapshot>): PropertyTaxAssessmentPayload {
  return hydratePayloadFromGisSurvey({
    status: existing.status,
    property_id: existing.property_id,
    assessment_number: existing.assessment_number,
    owner_name: existing.owner_name,
    occupancy_status: existing.occupancy_status,
    construction_type: existing.construction_type,
    tax_zone: existing.tax_zone,
    municipal_use: existing.municipal_use,
    municipal_plot_area_sqm: existing.municipal_plot_area_sqm,
    municipal_built_up_area_sqm: existing.municipal_built_up_area_sqm,
    municipal_floor_count: existing.municipal_floor_count,
    municipal_record_id: existing.municipal_record_id,
    financial_year: existing.financial_year,
    discrepancy_status: existing.discrepancy_status,
    floor_assessments: existing.floor_assessments ?? [],
    annual_rate_per_sqm: existing.annual_rate_per_sqm,
    usage_factor: existing.usage_factor,
    zone_factor: existing.zone_factor,
    construction_factor: existing.construction_factor,
    age_factor: existing.age_factor,
    cess_percent: existing.cess_percent,
    service_charge: existing.service_charge,
    rebate_amount: existing.rebate_amount,
    exemption_amount: existing.exemption_amount,
    base_annual_tax: existing.base_annual_tax,
    estimated_annual_tax: existing.estimated_annual_tax,
    remarks: existing.remarks,
    gis_snapshot: snapshot,
  }, snapshot);
}

export function PropertyTaxAssessmentPanel({ feature, onClose }: Props) {
  const [enrichment, setEnrichment] = useState<SurveyEnrichment | null>(null);
  const enrichedFeature = useMemo(() => applySurveyEnrichmentToFeature(feature, enrichment), [feature, enrichment]);
  const snapshot = useMemo(() => buildGisTaxSnapshot(enrichedFeature), [enrichedFeature]);
  const classification = useMemo(() => classifyPropertyTaxFeature(enrichedFeature), [enrichedFeature]);
  const [tab, setTab] = useState<PanelTab>("record");
  const [form, setForm] = useState<PropertyTaxAssessmentPayload>(() => blankAssessmentPayload(snapshot));
  const [record, setRecord] = useState<PropertyTaxAssessment | null>(null);
  const [municipalRecord, setMunicipalRecord] = useState<MunicipalPropertyRecord | null>(null);
  const [suggestions, setSuggestions] = useState<MunicipalPropertyRecord[]>([]);
  const [registerResults, setRegisterResults] = useState<MunicipalPropertyRecord[]>([]);
  const [registerQuery, setRegisterQuery] = useState("");
  const [demand, setDemand] = useState<PropertyTaxDemand | null>(null);
  const [revisions, setRevisions] = useState<PropertyTaxAssessmentRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [registerBusy, setRegisterBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageMode, setStorageMode] = useState<"database" | "local">("database");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<PanelDragState | null>(null);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  const calculation = useMemo(() => calculatePropertyTax(form), [form]);
  const builtUpDifference = form.municipal_built_up_area_sqm !== null && snapshot.built_up_area_sqm !== null
    ? form.municipal_built_up_area_sqm - snapshot.built_up_area_sqm : null;
  const floorDifference = form.municipal_floor_count !== null && snapshot.floor_count !== null
    ? form.municipal_floor_count - snapshot.floor_count : null;
  const useMatches = Boolean(form.municipal_use && form.municipal_use === snapshot.tax_class);

  const clampPosition = (x: number, y: number, drag: PanelDragState): PanelPosition => {
    const maxX = Math.max(PANEL_EDGE_GAP, drag.parentWidth - drag.panelWidth - PANEL_EDGE_GAP);
    const maxY = Math.max(PANEL_EDGE_GAP, drag.parentHeight - drag.panelHeight - PANEL_EDGE_GAP);
    return { x: Math.min(maxX, Math.max(PANEL_EDGE_GAP, x)), y: Math.min(maxY, Math.max(PANEL_EDGE_GAP, y)) };
  };
  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return;
    const panelRect = panel.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const origin = { x: panelRect.left - parentRect.left, y: panelRect.top - parentRect.top };
    const drag: PanelDragState = {
      ...origin, pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY,
      parentWidth: parentRect.width, parentHeight: parentRect.height, panelWidth: panelRect.width, panelHeight: panelRect.height,
    };
    dragRef.current = drag;
    setPanelPosition(clampPosition(origin.x, origin.y, drag));
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    setPanelPosition(clampPosition(drag.x + event.clientX - drag.startClientX, drag.y + event.clientY - drag.startClientY, drag));
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current || event.pointerId !== dragRef.current.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };

  useEffect(() => {
    const controller = new AbortController();
    setEnrichment(null);
    void fetchSurveyEnrichment(feature.properties.id, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setEnrichment(value); })
      .catch(() => { /* Plot enrichment is optional; building attributes remain available. */ });
    return () => controller.abort();
  }, [feature.properties.id]);

  useEffect(() => {
    if (!panelPosition) return;
    const keepInsideViewport = () => {
      const panel = panelRef.current;
      const parent = panel?.offsetParent as HTMLElement | null;
      if (!panel || !parent) return;
      const panelRect = panel.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const drag: PanelDragState = {
        x: panelPosition.x, y: panelPosition.y, pointerId: -1, startClientX: 0, startClientY: 0,
        parentWidth: parentRect.width, parentHeight: parentRect.height,
        panelWidth: panelRect.width, panelHeight: panelRect.height,
      };
      setPanelPosition((current) => current ? clampPosition(current.x, current.y, drag) : current);
    };
    window.addEventListener("resize", keepInsideViewport);
    return () => window.removeEventListener("resize", keepInsideViewport);
  }, [panelPosition]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setMessage(null); setRecord(null); setMunicipalRecord(null);
    setSuggestions([]); setRegisterResults([]); setDemand(null); setRevisions([]);
    const initial = blankAssessmentPayload(snapshot);
    setForm(initial);
    void Promise.allSettled([
      fetchPropertyTaxAssessment(feature.properties.id, controller.signal),
      fetchLinkedMunicipalRecord(feature.properties.id, controller.signal),
      fetchPropertyTaxDemand(feature.properties.id, controller.signal),
      fetchPropertyTaxAssessmentHistory(feature.properties.id, controller.signal),
    ]).then(async ([assessmentResult, municipalResult, demandResult, historyResult]) => {
      if (controller.signal.aborted) return;
      const existing = assessmentResult.status === "fulfilled" ? assessmentResult.value : null;
      const linked = municipalResult.status === "fulfilled" ? municipalResult.value : null;
      if (demandResult.status === "fulfilled") setDemand(demandResult.value);
      if (historyResult.status === "fulfilled") setRevisions(historyResult.value);
      setMunicipalRecord(linked);

      if (existing) {
        const gisHydrated = assessmentToPayload(existing, snapshot);
        setRecord(existing);
        setStorageMode("database");
        setForm(linked ? applyMunicipalRecordToPayload(gisHydrated, linked, snapshot) : gisHydrated);
        if (!linked) setMessage("Saved assessment loaded; any previously empty fields were filled from the GIS survey.");
      } else if (linked) {
        setStorageMode("database");
        setForm(applyMunicipalRecordToPayload(initial, linked, snapshot));
        setMessage("Official municipal record connected. Missing values continue to fall back to the GIS survey.");
      } else {
        const local = loadLocalPropertyTaxDraft(feature.properties.id);
        if (local) {
          setForm(hydratePayloadFromGisSurvey({ ...initial, ...local, gis_snapshot: snapshot }, snapshot));
          setStorageMode("local");
          setMessage("Local draft restored and refreshed with available GIS survey fields.");
        } else {
          setStorageMode("database");
          setForm(initial);
          setMessage(`${snapshot.populated_field_count} populated GIS attributes detected; property and tax fields were filled automatically.`);
        }
        try { setSuggestions(await fetchMunicipalRecordSuggestions(feature.properties.id, controller.signal)); } catch { /* optional */ }
      }

      if (assessmentResult.status === "rejected" && municipalResult.status === "rejected") {
        setStorageMode("local");
        setMessage("Backend tax storage is unavailable. GIS values are still loaded and changes can be saved as a local browser draft.");
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [feature.properties.id, snapshot]);

  const patch = <K extends keyof PropertyTaxAssessmentPayload>(key: K, value: PropertyTaxAssessmentPayload[K]) => {
    setForm((current) => ({ ...current, [key]: value, gis_snapshot: snapshot }));
    setMessage(null); setError(null);
  };

  const handleSave = async () => {
    const payload: PropertyTaxAssessmentPayload = {
      ...form,
      status: form.status === "not_assessed" ? "draft" : form.status,
      base_annual_tax: calculation.baseTax,
      estimated_annual_tax: calculation.totalTax,
      gis_snapshot: snapshot,
    };
    setSaving(true); setError(null); setMessage(null);
    try {
      const saved = await savePropertyTaxAssessment(feature.properties.id, payload);
      setRecord(saved); setStorageMode("database"); setForm(assessmentToPayload(saved, snapshot));
      try { setRevisions(await fetchPropertyTaxAssessmentHistory(feature.properties.id)); } catch { /* history is optional */ }
      setMessage(`Assessment saved to the database · version ${saved.version}`);
    } catch (caught: unknown) {
      if (!isOfflineAssessmentError(caught)) setError(apiErrorMessage(caught, "The assessment could not be saved. Check the workflow status and entered values."));
      else {
        saveLocalPropertyTaxDraft(feature.properties.id, payload); setStorageMode("local"); setForm(payload);
        setMessage("Saved as a local browser draft. It can be transferred after the backend starts.");
      }
    } finally { setSaving(false); }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setRegisterBusy(true); setError(null); setMessage(null);
    try {
      const result = await importMunicipalRecords(feature.properties.dataset_id, file);
      const linked = await fetchLinkedMunicipalRecord(feature.properties.id);
      setMunicipalRecord(linked);
      if (linked) setForm((current) => applyMunicipalRecordToPayload(current, linked, snapshot));
      else setSuggestions(await fetchMunicipalRecordSuggestions(feature.properties.id));
      setMessage(`${result.imported} imported · ${result.exact_linked} exact links · ${result.spatial_linked} spatial links · ${result.unlinked} awaiting manual link · ${result.skipped} skipped`);
    } catch (caught: unknown) {
      setError(apiErrorMessage(caught, "Municipal register import failed. Use CSV/XLSX with an identifier or Latitude/Longitude."));
    } finally { setRegisterBusy(false); }
  };

  const handleSearch = async () => {
    setRegisterBusy(true); setError(null);
    try { setRegisterResults(await searchMunicipalRecords(feature.properties.dataset_id, registerQuery)); }
    catch (caught: unknown) { setError(apiErrorMessage(caught, "Municipal-register search is unavailable.")); }
    finally { setRegisterBusy(false); }
  };

  const handleLink = async (candidate: MunicipalPropertyRecord) => {
    setRegisterBusy(true); setError(null);
    try {
      const linked = await linkMunicipalRecord(candidate.id, feature.properties.id);
      setMunicipalRecord(linked); setSuggestions([]); setRegisterResults([]);
      const linkedAssessment = await fetchPropertyTaxAssessment(feature.properties.id);
      if (linkedAssessment) {
        setRecord(linkedAssessment);
        setForm(assessmentToPayload(linkedAssessment, snapshot));
      } else {
        setForm((current) => applyMunicipalRecordToPayload(current, linked, snapshot));
      }
      try { setRevisions(await fetchPropertyTaxAssessmentHistory(feature.properties.id)); } catch { /* optional */ }
      setMessage("Official municipal record linked and copied into the draft assessment.");
    } catch (caught: unknown) { setError(apiErrorMessage(caught, "This municipal record could not be linked. It may already belong to another building.")); }
    finally { setRegisterBusy(false); }
  };

  const handleUnlink = async () => {
    if (!municipalRecord) return;
    setRegisterBusy(true); setError(null);
    try {
      await unlinkMunicipalRecord(municipalRecord.id);
      setMunicipalRecord(null);
      const unlinkedAssessment = await fetchPropertyTaxAssessment(feature.properties.id);
      if (unlinkedAssessment) setRecord(unlinkedAssessment);
      setForm(blankAssessmentPayload(snapshot));
      try { setRevisions(await fetchPropertyTaxAssessmentHistory(feature.properties.id)); } catch { /* optional */ }
      setMessage("Municipal record unlinked. The working record was restored from the GIS survey.");
      setSuggestions(await fetchMunicipalRecordSuggestions(feature.properties.id));
    } catch (caught: unknown) { setError(apiErrorMessage(caught, "The municipal record could not be unlinked.")); }
    finally { setRegisterBusy(false); }
  };

  const handleGenerateDemand = async () => {
    if (!record || form.status !== "approved") {
      setError("Save this assessment with Approved status before generating demand."); return;
    }
    setSaving(true); setError(null);
    try {
      const generated = await generatePropertyTaxDemand(feature.properties.id);
      setDemand(generated);
      const lockedAssessment = await fetchPropertyTaxAssessment(feature.properties.id);
      if (lockedAssessment) {
        setRecord(lockedAssessment);
        setForm(assessmentToPayload(lockedAssessment, snapshot));
      } else {
        patch("status", "demand_generated");
      }
      try { setRevisions(await fetchPropertyTaxAssessmentHistory(feature.properties.id)); } catch { /* optional */ }
      setMessage(`Annual demand ${generated.demand_number} generated successfully.`);
    } catch (caught: unknown) { setError(apiErrorMessage(caught, "Demand could not be generated. Confirm that the approved assessment has a complete tax calculation.")); }
    finally { setSaving(false); }
  };

  const handleResetDraft = () => {
    const blank = blankAssessmentPayload(snapshot);
    setForm(municipalRecord ? applyMunicipalRecordToPayload(blank, municipalRecord, snapshot) : blank);
    setError(null);
    setMessage(municipalRecord ? "Draft reset to the official record with GIS fallback for missing values." : "Draft restored from the GIS survey.");
  };

  const addFloor = () => {
    const nextNumber = form.floor_assessments.length + 1;
    const area = form.floor_assessments.length === 0 && form.municipal_built_up_area_sqm !== null ? form.municipal_built_up_area_sqm : 0;
    patch("floor_assessments", [...form.floor_assessments, {
      floor_name: nextNumber === 1 ? "Ground floor" : `Floor ${nextNumber - 1}`,
      property_use: form.municipal_use,
      area_sqm: area,
      annual_rate_per_sqm: form.annual_rate_per_sqm,
      usage_factor: 1,
    }]);
  };
  const patchFloor = <K extends keyof FloorTaxLine>(index: number, key: K, value: FloorTaxLine[K]) => {
    patch("floor_assessments", form.floor_assessments.map((line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line));
  };

  return (
    <aside
      ref={panelRef}
      className={`property-assessment-panel property-assessment-panel--phase3${dragging ? " is-dragging" : ""}`}
      data-testid="property-assessment-panel"
      aria-label="Property tax assessment"
      style={panelPosition ? ({ left: panelPosition.x, top: panelPosition.y, right: "auto" } as CSSProperties) : undefined}
    >
      <header
        className="property-assessment-panel__header"
        title="Drag to move · Double-click to reset position"
        onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
        onDoubleClick={() => setPanelPosition(null)}
      >
        <div className="property-assessment-panel__heading">
          <span className="property-assessment-panel__class-dot" style={{ background: propertyTaxColor(classification.taxClass) }} />
          <div><div className="property-assessment-panel__eyebrow">PROPERTY TAX RECORD · PHASE 3.1</div><h3>{feature.properties.label ?? `Building ${feature.properties.id.slice(0, 8)}`}</h3><p>{classification.taxClass} · {statusLabel(form.status)}</p></div>
        </div>
        <div className="property-assessment-panel__header-actions"><span className="property-assessment-panel__drag-label">Drag</span><button type="button" className="property-assessment-panel__close" onClick={onClose} aria-label="Close property tax record">×</button></div>
      </header>

      <div className="property-assessment-panel__identity">
        <div><span>Feature ID</span><strong>{feature.properties.id.slice(0, 12)}…</strong></div>
        <div><span>Official record</span><strong className={municipalRecord ? "is-connected" : ""}>{municipalRecord ? "Connected" : "GIS fallback"}</strong></div>
        <div><span>Version</span><strong>{record?.version ?? "New"}</strong></div>
      </div>

      <nav className="property-assessment-panel__tabs">
        <button type="button" className={tab === "record" ? "is-active" : ""} onClick={() => setTab("record")}>Property record</button>
        <button type="button" className={tab === "comparison" ? "is-active" : ""} onClick={() => setTab("comparison")}>GIS comparison</button>
        <button type="button" className={tab === "calculation" ? "is-active" : ""} onClick={() => setTab("calculation")}>Tax assessment</button>
        <button type="button" className={tab === "history" ? "is-active" : ""} onClick={() => setTab("history")}>History</button>
      </nav>

      <div className="property-assessment-panel__body">
        {loading ? <div className="property-assessment-panel__loading"><span /> Loading GIS survey, assessment and municipal records…</div> : tab === "record" ? (
          <div className="property-assessment-panel__form">
            <MunicipalRegisterConnection
              record={municipalRecord} suggestions={suggestions} results={registerResults} query={registerQuery}
              busy={registerBusy} onQuery={setRegisterQuery} onSearch={handleSearch} onLink={handleLink}
              onUnlink={handleUnlink} onImport={() => fileInputRef.current?.click()} onTemplate={downloadMunicipalRegisterTemplate}
            />
            <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={handleImport} />
            <div className={`property-assessment-panel__source-banner${municipalRecord ? " is-official" : ""}`}>
              <div><strong>{municipalRecord ? "Official record + GIS fallback" : "GIS survey auto-fill active"}</strong><span>{municipalRecord ? "Official values take priority; missing fields use the uploaded survey." : `${snapshot.populated_field_count} populated GIS attributes were detected for this building and its containing plot.`}</span></div>
              <b>{municipalRecord ? "HYBRID" : "GIS"}</b>
            </div>

            <div className="property-assessment-panel__section-title"><strong>Property identity</strong><span>Official values are used when linked; otherwise available GIS survey references are loaded</span></div>
            <div className="property-assessment-panel__grid">
              <label><span>Property / survey ID</span><input value={form.property_id ?? ""} onChange={(event) => patch("property_id", text(event.target.value))} placeholder="GIS survey ID or official property ID" /></label>
              <label><span>Assessment / survey number</span><input value={form.assessment_number ?? ""} onChange={(event) => patch("assessment_number", text(event.target.value))} placeholder="Not captured in GIS survey" /></label>
              <label className="is-wide"><span>Owner name</span><input value={form.owner_name ?? ""} onChange={(event) => patch("owner_name", text(event.target.value))} placeholder="Not captured in GIS survey" /></label>
              <label><span>Assessment status</span><select value={form.status} disabled={form.status === "demand_generated"} onChange={(event) => patch("status", event.target.value as PropertyTaxAssessmentStatus)}>{PROPERTY_TAX_STATUS_OPTIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
              <label><span>Financial year</span><input value={form.financial_year} onChange={(event) => patch("financial_year", event.target.value)} placeholder="2026-27" /></label>
              <label><span>Tax zone</span><input value={form.tax_zone ?? ""} onChange={(event) => patch("tax_zone", text(event.target.value))} placeholder="Zone A / B / C" /></label>
              <label><span>Discrepancy status</span><select value={form.discrepancy_status} onChange={(event) => patch("discrepancy_status", event.target.value as PropertyTaxDiscrepancyStatus)}>{PROPERTY_TAX_DISCREPANCY_OPTIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
            </div>

            <div className="property-assessment-panel__section-title"><strong>Assessment classification</strong><span>Auto-filled from GIS; linked municipal values take priority when available</span></div>
            <div className="property-assessment-panel__grid">
              <label><span>Property use</span><select value={form.municipal_use ?? ""} onChange={(event) => patch("municipal_use", text(event.target.value))}><option value="">Select use</option>{USE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label><span>Occupancy</span><select value={form.occupancy_status ?? ""} onChange={(event) => patch("occupancy_status", text(event.target.value))}><option value="">Select occupancy</option>{OCCUPANCY_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label className="is-wide"><span>Construction type</span><select value={form.construction_type ?? ""} onChange={(event) => patch("construction_type", text(event.target.value))}><option value="">Select construction</option>{CONSTRUCTION_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label><span>Plot area (sqm)</span><input type="number" min="0" step="0.01" value={form.municipal_plot_area_sqm ?? ""} onChange={(event) => patch("municipal_plot_area_sqm", toNullableNumber(event.target.value))} /></label>
              <label><span>Taxable built-up area (sqm)</span><input type="number" min="0" step="0.01" value={form.municipal_built_up_area_sqm ?? ""} onChange={(event) => patch("municipal_built_up_area_sqm", toNullableNumber(event.target.value))} /></label>
              <label><span>Floor count</span><input type="number" min="0" step="1" value={form.municipal_floor_count ?? ""} onChange={(event) => patch("municipal_floor_count", toNullableNumber(event.target.value))} /></label>
              <label className="is-wide"><span>Assessment remarks</span><textarea value={form.remarks ?? ""} onChange={(event) => patch("remarks", text(event.target.value))} placeholder="Verification notes, missing documents, use change, additional floor…" rows={3} /></label>
            </div>
          </div>
        ) : tab === "comparison" ? (
          <div className="property-assessment-panel__comparison">
            <div className="property-assessment-panel__section-title"><strong>GIS survey vs working assessment</strong><span>When an official record is linked it is compared here; otherwise the assessment uses GIS survey values</span></div>
            <div className="property-assessment-panel__comparison-head"><span>Parameter</span><span>GIS survey</span><span>{municipalRecord ? "Municipal record" : "Working assessment"}</span><span>Result</span></div>
            <ComparisonRow label="Property use" gis={snapshot.tax_class} municipal={form.municipal_use ?? "—"} result={!municipalRecord ? "GIS fallback" : form.municipal_use ? (useMatches ? "Matched" : "Review") : "Missing"} tone={!municipalRecord ? "good" : form.municipal_use ? (useMatches ? "good" : "warn") : "muted"} />
            <ComparisonRow label="Plot area" gis={`${formatNumber(snapshot.plot_area_sqm)} sqm`} municipal={`${formatNumber(form.municipal_plot_area_sqm)} sqm`} result={!municipalRecord ? "GIS fallback" : "Reference"} tone={!municipalRecord ? "good" : "muted"} />
            <ComparisonRow label="Built-up area" gis={`${formatNumber(snapshot.built_up_area_sqm)} sqm`} municipal={`${formatNumber(form.municipal_built_up_area_sqm)} sqm`} result={!municipalRecord ? "GIS fallback" : builtUpDifference === null ? "Missing" : `${builtUpDifference >= 0 ? "+" : ""}${formatNumber(builtUpDifference)} sqm`} tone={!municipalRecord ? "good" : builtUpDifference === null ? "muted" : Math.abs(builtUpDifference) < 1 ? "good" : "warn"} />
            <ComparisonRow label="Floor count" gis={formatNumber(snapshot.floor_count, 0)} municipal={formatNumber(form.municipal_floor_count, 0)} result={!municipalRecord ? "GIS fallback" : floorDifference === null ? "Missing" : `${floorDifference >= 0 ? "+" : ""}${floorDifference}`} tone={!municipalRecord ? "good" : floorDifference === null ? "muted" : floorDifference === 0 ? "good" : "warn"} />
            <ComparisonRow label="Construction" gis={snapshot.construction_type ?? "—"} municipal={form.construction_type ?? "—"} result={!municipalRecord ? "GIS fallback" : form.construction_type ? "Recorded" : "Missing"} tone={!municipalRecord ? "good" : form.construction_type ? "good" : "muted"} />
            <ComparisonRow label="Occupancy" gis={snapshot.occupancy_status ?? "—"} municipal={form.occupancy_status ?? "—"} result={!municipalRecord ? "GIS fallback" : form.occupancy_status ? "Recorded" : "Missing"} tone={!municipalRecord ? "good" : form.occupancy_status ? "good" : "muted"} />
            <div className="property-assessment-panel__gis-source"><strong>GIS calculation sources</strong>{Object.keys(snapshot.source_fields).length === 0 ? <p>No recognised survey fields were found; geometry is used where possible.</p> : <ul>{Object.entries(snapshot.source_fields).map(([key, value]) => <li key={key}><span>{key.replace(/_/g, " ")}</span><b>{value}</b></li>)}</ul>}</div>
          </div>
        ) : tab === "calculation" ? (
          <div className="property-assessment-panel__calculation">
            <div className="property-assessment-panel__section-title"><strong>Provisional annual tax assessment</strong><span>Area, building use, floors and indicative rates are loaded automatically from the GIS survey</span></div>
            <div className="property-assessment-panel__formula">GIS taxable area × indicative annual rate × floor/use factor × zone × construction × age + cess + service charge − rebate − exemption</div>
            <div className="property-assessment-panel__rate-note">
              <div><strong>Indicative rate loaded automatically</strong><span>{snapshot.indicative_rate_source}</span></div>
              <b>₹{formatNumber(form.annual_rate_per_sqm)} / sqm / year</b>
            </div>
            <div className="property-assessment-panel__grid">
              <label><span>Taxable built-up area (sqm)</span><input type="number" min="0" step="0.01" value={form.municipal_built_up_area_sqm ?? ""} onChange={(event) => patch("municipal_built_up_area_sqm", toNullableNumber(event.target.value))} /></label>
              <label><span>Indicative annual rate / sqm (₹)</span><input type="number" min="0" step="0.01" value={form.annual_rate_per_sqm ?? ""} onChange={(event) => patch("annual_rate_per_sqm", toNullableNumber(event.target.value))} /></label>
              <FactorInput label="Usage factor" value={form.usage_factor} onChange={(value) => patch("usage_factor", value)} />
              <FactorInput label="Zone factor" value={form.zone_factor} onChange={(value) => patch("zone_factor", value)} />
              <FactorInput label="Construction factor" value={form.construction_factor} onChange={(value) => patch("construction_factor", value)} />
              <FactorInput label="Age factor" value={form.age_factor} onChange={(value) => patch("age_factor", value)} />
              <FactorInput label="Cess (%)" value={form.cess_percent} onChange={(value) => patch("cess_percent", value)} />
              <MoneyInput label="Service charge (₹)" value={form.service_charge} onChange={(value) => patch("service_charge", value)} />
              <MoneyInput label="Rebate (₹)" value={form.rebate_amount} onChange={(value) => patch("rebate_amount", value)} />
              <MoneyInput label="Exemption (₹)" value={form.exemption_amount} onChange={(value) => patch("exemption_amount", value)} />
            </div>

            <div className="property-assessment-panel__floor-head"><div><strong>Floor-wise assessment</strong><span>Floor use, area, indicative rate and upper-floor factor are auto-generated from the GIS survey</span></div><button type="button" onClick={addFloor}>+ Add floor</button></div>
            {form.floor_assessments.length > 0 && <div className="property-assessment-panel__floors">
              <div className="property-assessment-panel__floor-columns" aria-hidden="true">
                <span>Floor</span><span>Surveyed use</span><span>Area sqm</span><span>Rate ₹/sqm</span><span>Floor factor</span><span />
              </div>
              {form.floor_assessments.map((line, index) => <div className="property-assessment-panel__floor" key={`${line.floor_name}-${index}`}>
                <input aria-label="Floor name" value={line.floor_name} onChange={(event) => patchFloor(index, "floor_name", event.target.value)} />
                <select aria-label="Floor use" value={line.property_use ?? ""} onChange={(event) => patchFloor(index, "property_use", text(event.target.value))}><option value="">Use</option>{USE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select>
                <input aria-label="Floor area" type="number" min="0" step="0.01" value={line.area_sqm || ""} placeholder="Area sqm" onChange={(event) => patchFloor(index, "area_sqm", Number(event.target.value) || 0)} />
                <input aria-label="Floor rate" type="number" min="0" step="0.01" value={line.annual_rate_per_sqm ?? ""} placeholder="Rate ₹/sqm" onChange={(event) => patchFloor(index, "annual_rate_per_sqm", toNullableNumber(event.target.value))} />
                <input aria-label="Floor use factor" type="number" min="0" step="0.01" value={line.usage_factor} onChange={(event) => patchFloor(index, "usage_factor", Number(event.target.value) || 1)} />
                <button type="button" aria-label="Remove floor" onClick={() => patch("floor_assessments", form.floor_assessments.filter((_, lineIndex) => lineIndex !== index))}>×</button>
              </div>)}
            </div>}

            <div className="property-assessment-panel__breakdown">
              <div><span>Calculation mode</span><strong>{calculation.calculationMode === "floor_wise" ? "Floor-wise" : calculation.calculationMode === "whole_building" ? "Whole building" : "Incomplete"}</strong></div>
              <div><span>Base property tax</span><strong>{currency(calculation.baseTax)}</strong></div>
              <div><span>Cess</span><strong>{currency(calculation.cessAmount)}</strong></div>
              <div><span>Service charge</span><strong>{currency(form.service_charge)}</strong></div>
              <div><span>Rebate + exemption</span><strong>− {currency(form.rebate_amount + form.exemption_amount)}</strong></div>
            </div>
            <div className="property-assessment-panel__estimate"><span>Annual tax payable</span><strong>{calculation.totalTax === null ? "GIS data or rate unavailable" : currency(calculation.totalTax)}</strong><small>{form.status === "approved" ? "Approved assessment is ready for demand generation." : "Indicative GIS estimate only; review and approve before generating demand."}</small></div>
            {demand ? <div className="property-assessment-panel__demand is-generated"><div><span>Demand number</span><strong>{demand.demand_number}</strong></div><div><span>Financial year</span><strong>{demand.financial_year}</strong></div><div><span>Total demand</span><strong>{currency(demand.total_demand)}</strong></div></div> : <button type="button" className="property-assessment-panel__generate" onClick={handleGenerateDemand} disabled={saving || form.status !== "approved"}>Generate annual demand</button>}
          </div>
        ) : (
          <div className="property-assessment-panel__history">
            <div className="property-assessment-panel__section-title"><strong>Assessment history</strong><span>Immutable revisions retained for audit and officer review</span></div>
            {revisions.length === 0 ? <div className="property-assessment-panel__history-empty">No database revision has been created yet. Save the assessment to create version 1.</div> : revisions.map((revision) => {
              const fields = Object.keys(revision.changed_fields);
              return <article key={revision.id} className="property-assessment-panel__history-item">
                <div className="property-assessment-panel__history-head"><strong>Version {revision.version}</strong><span>{new Date(revision.created_at).toLocaleString("en-IN")}</span></div>
                <div className="property-assessment-panel__history-status"><b>{statusLabel(revision.status as PropertyTaxAssessmentStatus)}</b><span>{revision.change_reason ?? "Assessment updated"}</span></div>
                <div className="property-assessment-panel__history-fields">{fields.length === 0 ? <em>No field differences recorded</em> : fields.slice(0, 12).map((field) => <span key={field}>{field.replace(/_/g, " ")}</span>)}</div>
              </article>;
            })}
          </div>
        )}
      </div>

      {(message || error) && <div className={`property-assessment-panel__notice${error ? " is-error" : ""}`}>{error ?? message}</div>}
      <footer className="property-assessment-panel__footer">
        <button type="button" className="property-assessment-panel__secondary" onClick={handleResetDraft} disabled={saving || form.status === "demand_generated"}>Restore GIS survey</button>
        <button type="button" className="property-assessment-panel__save" onClick={handleSave} disabled={saving || form.status === "demand_generated"}>{saving ? "Saving…" : storageMode === "local" ? "Save local draft" : "Save assessment"}</button>
      </footer>
    </aside>
  );
}

function MunicipalRegisterConnection({
  record, suggestions, results, query, busy, onQuery, onSearch, onLink, onUnlink, onImport, onTemplate,
}: {
  record: MunicipalPropertyRecord | null;
  suggestions: MunicipalPropertyRecord[];
  results: MunicipalPropertyRecord[];
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onSearch: () => void;
  onLink: (record: MunicipalPropertyRecord) => void;
  onUnlink: () => void;
  onImport: () => void;
  onTemplate: () => void;
}) {
  if (record) return <div className="property-assessment-panel__register is-linked">
    <div className="property-assessment-panel__register-icon">✓</div>
    <div className="property-assessment-panel__register-main"><span>OFFICIAL MUNICIPAL RECORD CONNECTED</span><strong>{recordTitle(record)}</strong><small>{record.owner_name ?? "Owner not recorded"} · {record.source_name}{record.source_row_number ? ` · row ${record.source_row_number}` : ""}</small><div className="property-assessment-panel__register-meta">{record.sas_number && <b>SAS {record.sas_number}</b>}{record.door_number && <b>Door {record.door_number}</b>}{record.match_method && <b>{record.match_method.replace(/:/g, " · ")}</b>}{record.address && <em>{record.address}</em>}</div></div>
    <button type="button" onClick={onUnlink} disabled={busy}>Unlink</button>
  </div>;
  const candidates = results.length > 0 ? results : suggestions;
  return <div className="property-assessment-panel__register">
    <div className="property-assessment-panel__register-top"><div><span>OPTIONAL MUNICIPAL REGISTER</span><strong>No official record linked · GIS fallback is active</strong><small>The property and tax fields below are already populated from the GIS survey. Import/search only when the client supplies an official register.</small></div><div className="property-assessment-panel__register-actions"><button type="button" onClick={onTemplate} disabled={busy}>Template</button><button type="button" onClick={onImport} disabled={busy}>{busy ? "Working…" : "Import CSV/XLSX"}</button></div></div>
    <div className="property-assessment-panel__register-search"><input value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="Search Property ID, assessment no., owner or door no." /><button type="button" onClick={onSearch} disabled={busy}>Search</button></div>
    {candidates.length > 0 && <div className="property-assessment-panel__register-results"><span>{results.length > 0 ? "Search results" : "Exact-match suggestions"}</span>{candidates.slice(0, 5).map((candidate) => <div key={candidate.id}><div><strong>{recordTitle(candidate)}</strong><small>{candidate.owner_name ?? "Owner not recorded"} · {candidate.door_number ? `Door ${candidate.door_number}` : candidate.source_name}</small></div><button type="button" onClick={() => onLink(candidate)} disabled={busy}>Link</button></div>)}</div>}
  </div>;
}

function ComparisonRow({ label, gis, municipal, result, tone }: { label: string; gis: string; municipal: string; result: string; tone: "good" | "warn" | "muted" }) {
  return <div className="property-assessment-panel__comparison-row"><strong>{label}</strong><span>{gis}</span><span>{municipal}</span><em className={`is-${tone}`}>{result}</em></div>;
}
function FactorInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min="0" max="100" step="0.01" value={value} onChange={(event) => onChange(Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : 1)} /></label>;
}
function MoneyInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min="0" step="0.01" value={value} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))} /></label>;
}
