import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  downloadUniversalDashboardExcel,
  fetchDashboardRecords,
  fetchDashboardTypes,
  fetchDatasets,
  fetchUniversalDashboard,
  fetchVisualizationManifest,
  updateVisualizationLayerReview,
  type DashboardLayerSummary,
  type DashboardRecordResponse,
  type DatasetRow,
  type UniversalDashboard,
  type VisualizationLayerManifest,
  type VisualizationManifest,
} from "../lib/workflow";
import { ApprovedUniversalDashboard } from "../components/approved-dashboard/ApprovedUniversalDashboard";

interface LayoutCtx {
  selectedDatasets: DatasetRow[];
  setSelectedDatasets: React.Dispatch<React.SetStateAction<DatasetRow[]>>;
}

type PageMode = "review" | "dashboard";

const CHART_COLORS = ["#0f8a70", "#3b82f6", "#f59e0b", "#8b5cf6", "#06b6d4", "#ef4444", "#84cc16"];

const TYPE_DESCRIPTIONS: Record<string, { eyebrow: string; title: string; description: string }> = {
  roads: {
    eyebrow: "ROAD INFRASTRUCTURE",
    title: "Road network assessment",
    description: "Understand mapped roads, attributes, data completeness and available condition information.",
  },
  drainage: {
    eyebrow: "DRAINAGE INFRASTRUCTURE",
    title: "Storm-water drainage assessment",
    description: "Review drainage layers, categories, inspection status, dimensions and missing field information.",
  },
  manholes: {
    eyebrow: "MANHOLE INFRASTRUCTURE",
    title: "Manhole and access-point assessment",
    description: "Review access structures, condition fields, depth-related measurements and survey completeness.",
  },
  streetlights: {
    eyebrow: "STREET-LIGHTING INFRASTRUCTURE",
    title: "Street-lighting assessment",
    description: "Review lighting assets, status fields, available technical attributes and survey coverage.",
  },
  water_network: {
    eyebrow: "WATER-SUPPLY INFRASTRUCTURE",
    title: "Water-network assessment",
    description: "Review pipelines, valves and hydrants with available material, diameter and status information.",
  },
  sewer_network: {
    eyebrow: "SEWER INFRASTRUCTURE",
    title: "Sewer and UGD assessment",
    description: "Review sewer-network layers, access assets, technical fields and data gaps.",
  },
  buildings: {
    eyebrow: "BUILDING INVENTORY",
    title: "Building and structure assessment",
    description: "Review mapped structures, categories, available area fields and attribute completeness.",
  },
  parcels: {
    eyebrow: "PROPERTY INVENTORY",
    title: "Land parcel and property assessment",
    description: "Review property layers, identifiers, categories and available ownership or survey fields.",
  },
  vegetation: {
    eyebrow: "GREEN ASSET INVENTORY",
    title: "Trees and vegetation assessment",
    description: "Review green assets, species or health fields, numerical measurements and survey gaps.",
  },
  solid_waste: {
    eyebrow: "SOLID-WASTE INFRASTRUCTURE",
    title: "Solid-waste asset assessment",
    description: "Review bins, collection points, available capacity fields and service-status information.",
  },
  landmarks: {
    eyebrow: "PUBLIC FACILITIES",
    title: "Landmark and public-facility assessment",
    description: "Review public facilities, landmark categories and available descriptive information.",
  },
  utilities: {
    eyebrow: "UTILITY INFRASTRUCTURE",
    title: "Utility asset assessment",
    description: "Review point, line and area utility assets with available categories and technical fields.",
  },
  boundaries: {
    eyebrow: "ADMINISTRATIVE GEOGRAPHY",
    title: "Boundary and zone assessment",
    description: "Review ward, zone and administrative layers and their available identifiers.",
  },
  generic_point: {
    eyebrow: "OTHER POINT ASSETS",
    title: "Point-layer assessment",
    description: "A safe generic analysis generated from the fields available in this point layer.",
  },
  generic_line: {
    eyebrow: "OTHER LINEAR ASSETS",
    title: "Linear-layer assessment",
    description: "A safe generic analysis generated from the fields available in this line layer.",
  },
  generic_polygon: {
    eyebrow: "OTHER AREA ASSETS",
    title: "Area-layer assessment",
    description: "A safe generic analysis generated from the fields available in this polygon layer.",
  },
  generic: {
    eyebrow: "OTHER MAPPED LAYERS",
    title: "Generic layer assessment",
    description: "A field-driven dashboard generated without making unsupported assumptions about the data.",
  },
};

function formatNumber(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function geometryLabel(layer: VisualizationLayerManifest): string {
  return layer.geometry_types.length ? layer.geometry_types.join(", ") : "Unknown geometry";
}

function confidenceLabel(value: number): string {
  if (value >= 0.85) return "High confidence";
  if (value >= 0.65) return "Review suggested";
  return "Confirmation required";
}

function KpiCard({ label, value, note, tone = "default" }: {
  label: string;
  value: string;
  note: string;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <article className={`lr-kpi lr-kpi--${tone}`}>
      <div className="lr-kpi__label">{label}</div>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="lr-empty">
      <span aria-hidden="true">◇</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function LayerReviewCard({
  layer,
  dashboardTypes,
  busy,
  onChange,
  onSave,
}: {
  layer: VisualizationLayerManifest;
  dashboardTypes: Record<string, string>;
  busy: boolean;
  onChange: (patch: Partial<VisualizationLayerManifest>) => void;
  onSave: () => void;
}) {
  const confidenceTone = layer.review_status === "confirmed"
    ? "confirmed"
    : layer.classification_confidence >= 0.65
      ? "auto"
      : "review";
  return (
    <article className={`lr-layer-card lr-layer-card--${confidenceTone}`}>
      <div className="lr-layer-card__head">
        <div>
          <div className="lr-layer-card__source">{layer.source_layer_name}</div>
          <input
            className="lr-layer-card__name"
            value={layer.display_name}
            onChange={(event) => onChange({ display_name: event.target.value })}
            aria-label={`Display name for ${layer.source_layer_name}`}
          />
        </div>
        <span className={`lr-confidence lr-confidence--${confidenceTone}`}>
          {layer.review_status === "confirmed" ? "Confirmed" : confidenceLabel(layer.classification_confidence)}
        </span>
      </div>

      <div className="lr-layer-card__facts">
        <span><b>{formatNumber(layer.feature_count)}</b> persisted features</span>
        <span>{geometryLabel(layer)}</span>
        <span><b>{layer.fields.length}</b> usable fields</span>
        {layer.ingestion_status !== "ready" && <span className="lr-layer-card__warning">{layer.ingestion_status}</span>}
      </div>

      <div className="lr-layer-card__form">
        <label>
          <span>Dashboard interpretation</span>
          <select
            value={layer.dashboard_type}
            onChange={(event) => onChange({ dashboard_type: event.target.value })}
          >
            {Object.entries(dashboardTypes).map(([value, label]) => (
              <option value={value} key={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="lr-toggle-row">
          <input
            type="checkbox"
            checked={layer.included}
            onChange={(event) => onChange({ included: event.target.checked })}
          />
          <span>Include in generated dashboard</span>
        </label>
      </div>

      <div className="lr-layer-card__evidence">
        <strong>Why it was detected this way</strong>
        <p>{layer.classification_reasons.join(" · ") || "No classification evidence was available."}</p>
      </div>

      <div className="lr-field-chips">
        {layer.fields.slice(0, 8).map((field) => (
          <span key={field.name} title={`${field.populated_count} populated, ${field.missing_count} missing`}>
            {field.name}
          </span>
        ))}
        {layer.fields.length > 8 && <span>+{layer.fields.length - 8} fields</span>}
      </div>

      {(layer.warnings.length > 0 || layer.ingestion_warning) && (
        <div className="lr-layer-card__warnings">
          {[...layer.warnings, ...(layer.ingestion_warning ? [layer.ingestion_warning] : [])].map((warning) => (
            <div key={warning}>⚠ {warning}</div>
          ))}
        </div>
      )}

      <button type="button" className="lr-secondary-btn" disabled={busy} onClick={onSave}>
        {busy ? "Saving…" : layer.review_status === "confirmed" ? "Save changes" : "Confirm layer"}
      </button>
    </article>
  );
}

function LayerCharts({ layer }: { layer: DashboardLayerSummary }) {
  const categoryData = layer.category_breakdown.filter((row) => row.count > 0).slice(0, 8);
  const statusData = layer.status_breakdown.filter((row) => row.count > 0).slice(0, 8);
  return (
    <section className="lr-layer-analysis">
      <div className="lr-section-heading">
        <div>
          <p>{layer.layer_key}</p>
          <h2>{layer.display_name}</h2>
        </div>
        <span>{formatNumber(layer.feature_count)} features</span>
      </div>

      <div className="lr-kpi-grid lr-kpi-grid--compact">
        <KpiCard label="Features" value={formatNumber(layer.feature_count)} note="Records available for this layer" />
        <KpiCard label="Data completeness" value={`${layer.completeness_percentage.toFixed(1)}%`} note="Across profiled attribute fields" tone={layer.completeness_percentage < 60 ? "warning" : "default"} />
        <KpiCard label="Items needing attention" value={formatNumber(layer.issue_count)} note="Features with elevated severity" tone={layer.issue_count > 0 ? "danger" : "default"} />
        <KpiCard label="Available fields" value={formatNumber(layer.fields.length)} note="Fields with at least one usable value" />
      </div>

      <div className="lr-chart-grid">
        <article className="lr-chart-card">
          <div className="lr-chart-card__head">
            <div><p>CATEGORY DISTRIBUTION</p><h3>Most common values</h3></div>
          </div>
          {categoryData.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={categoryData} layout="vertical" margin={{ top: 8, right: 18, left: 18, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--edge)" />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="label" width={130} tick={{ fill: "var(--ink-dim)", fontSize: 11 }} />
                <Tooltip formatter={(value) => formatNumber(Number(value))} />
                <Bar dataKey="count" fill="#0f8a70" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="lr-chart-empty">No category values were available.</div>}
        </article>

        <article className="lr-chart-card">
          <div className="lr-chart-card__head">
            <div><p>STATUS / CONDITION</p><h3>{layer.status_field || "No status field detected"}</h3></div>
          </div>
          {statusData.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={statusData} dataKey="count" nameKey="label" innerRadius={65} outerRadius={105} paddingAngle={2}>
                  {statusData.map((entry, index) => <Cell key={entry.label} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(value) => formatNumber(Number(value))} />
              </PieChart>
            </ResponsiveContainer>
          ) : <div className="lr-chart-empty">This survey does not include a usable condition or status field for this layer.</div>}
        </article>
      </div>

      {layer.numeric_summaries.length > 0 && (
        <div className="lr-numeric-grid">
          {layer.numeric_summaries.map((summary) => (
            <article key={summary.field}>
              <span>{summary.field}</span>
              <strong>{summary.average === null ? "Not available" : formatNumber(summary.average)}</strong>
              <small>
                {summary.minimum === null || summary.maximum === null
                  ? `${summary.count} numeric values`
                  : `Range ${formatNumber(summary.minimum)} – ${formatNumber(summary.maximum)} · ${summary.count} values`}
              </small>
            </article>
          ))}
        </div>
      )}

      <article className="lr-field-table-card">
        <div className="lr-chart-card__head"><div><p>FIELD REPORT</p><h3>Availability and missing information</h3></div></div>
        <div className="lr-field-table">
          <div className="lr-field-table__head"><span>Field</span><span>Type</span><span>Populated</span><span>Missing</span><span>Completeness</span></div>
          {layer.fields.slice(0, 24).map((field) => {
            const total = field.populated_count + field.missing_count;
            const completeness = total ? (field.populated_count / total) * 100 : 0;
            return (
              <div className="lr-field-table__row" key={field.name}>
                <span>{field.name}</span>
                <span>{field.detected_type}</span>
                <span>{formatNumber(field.populated_count)}</span>
                <span>{formatNumber(field.missing_count)}</span>
                <span><i><b style={{ width: `${completeness}%` }} /></i>{completeness.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      </article>
    </section>
  );
}

function GeneratedDashboard({
  dashboard,
  dashboardTypes,
  activeType,
  setActiveType,
}: {
  dashboard: UniversalDashboard;
  dashboardTypes: Record<string, string>;
  activeType: string;
  setActiveType: (value: string) => void;
}) {
  const types = useMemo(() => [...new Set(dashboard.layers.map((layer) => layer.dashboard_type))], [dashboard.layers]);
  const visibleLayers = activeType === "overview"
    ? dashboard.layers
    : dashboard.layers.filter((layer) => layer.dashboard_type === activeType);
  const descriptor = activeType === "overview"
    ? {
        eyebrow: "GENERATED DATASET OVERVIEW",
        title: "Urban Infrastructure Dashboard",
        description: "A clear summary generated automatically from the reviewed layers and fields in this dataset.",
      }
    : TYPE_DESCRIPTIONS[activeType] ?? TYPE_DESCRIPTIONS.generic;
  const completeness = dashboard.profiled_values > 0
    ? 100 * (dashboard.profiled_values - dashboard.missing_values) / dashboard.profiled_values
    : 100;

  return (
    <>
      <nav className="lr-dashboard-tabs" aria-label="Generated dashboard sections">
        <button type="button" className={activeType === "overview" ? "active" : ""} onClick={() => setActiveType("overview")}>Executive overview</button>
        {types.map((type) => (
          <button type="button" className={activeType === type ? "active" : ""} onClick={() => setActiveType(type)} key={type}>
            {dashboardTypes[type] ?? type.replaceAll("_", " ")}
          </button>
        ))}
      </nav>

      <div className="lr-dashboard-heading">
        <div>
          <p>{descriptor.eyebrow}</p>
          <h1>{descriptor.title}</h1>
          <span>{descriptor.description}</span>
        </div>
        <b>{activeType === "overview" ? `${dashboard.included_layers} layers` : `${visibleLayers.length} layer${visibleLayers.length === 1 ? "" : "s"}`}</b>
      </div>

      {activeType === "overview" ? (
        <>
          <section className="lr-hero-summary">
            <div><span>Total mapped features</span><strong>{formatNumber(dashboard.total_features)}</strong><p>Generated from all included, successfully ingested layers.</p></div>
            <div><b>✓ Universal dashboard is ready</b><p>Cards and charts are based only on fields that actually exist in the uploaded dataset. Missing fields are not treated as zero.</p></div>
          </section>

          <div className="lr-kpi-grid">
            <KpiCard label="Included layers" value={formatNumber(dashboard.included_layers)} note="Reviewed layers used in this dashboard" />
            <KpiCard label="Point features" value={formatNumber(dashboard.point_features)} note="Point and multipoint records" />
            <KpiCard label="Linear features" value={formatNumber(dashboard.line_features)} note="Line and multiline records" />
            <KpiCard label="Area features" value={formatNumber(dashboard.polygon_features)} note="Polygon and multipolygon records" />
            <KpiCard label="Data completeness" value={`${completeness.toFixed(1)}%`} note="Across all profiled fields" tone={completeness < 60 ? "warning" : "default"} />
            <KpiCard label="Items needing attention" value={formatNumber(dashboard.issue_count)} note="Features with elevated severity" tone={dashboard.issue_count > 0 ? "danger" : "default"} />
          </div>

          <div className="lr-chart-grid">
            <article className="lr-chart-card">
              <div className="lr-chart-card__head"><div><p>SURVEY COMPOSITION</p><h3>Records by source layer</h3></div></div>
              <ResponsiveContainer width="100%" height={360}>
                <BarChart data={dashboard.layers.slice().sort((a, b) => b.feature_count - a.feature_count).slice(0, 12)} layout="vertical" margin={{ top: 8, right: 18, left: 18, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--edge)" />
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="display_name" width={145} tick={{ fill: "var(--ink-dim)", fontSize: 11 }} />
                  <Tooltip formatter={(value) => formatNumber(Number(value))} />
                  <Bar dataKey="feature_count" fill="#0f8a70" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </article>

            <article className="lr-chart-card">
              <div className="lr-chart-card__head"><div><p>GEOMETRY MIX</p><h3>How the dataset is represented</h3></div></div>
              <ResponsiveContainer width="100%" height={360}>
                <PieChart>
                  <Pie data={dashboard.geometry_breakdown} dataKey="count" nameKey="label" innerRadius={75} outerRadius={120} paddingAngle={3}>
                    {dashboard.geometry_breakdown.map((entry, index) => <Cell key={entry.label} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(value) => formatNumber(Number(value))} />
                </PieChart>
              </ResponsiveContainer>
              <div className="lr-chart-legend">
                {dashboard.geometry_breakdown.map((entry, index) => (
                  <span key={entry.label}><i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />{entry.label}: {formatNumber(entry.count)}</span>
                ))}
              </div>
            </article>
          </div>

          <section className="lr-overview-layers">
            <div className="lr-section-heading"><div><p>DYNAMIC LAYER INVENTORY</p><h2>What the engine found</h2></div><span>Open a dashboard tab above for layer-level details.</span></div>
            <div className="lr-overview-layers__grid">
              {dashboard.layers.map((layer) => (
                <article key={layer.layer_key} onClick={() => setActiveType(layer.dashboard_type)}>
                  <span>{dashboardTypes[layer.dashboard_type] ?? layer.dashboard_type}</span>
                  <strong>{formatNumber(layer.feature_count)}</strong>
                  <h3>{layer.display_name}</h3>
                  <p>{layer.completeness_percentage.toFixed(1)}% attribute completeness</p>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : visibleLayers.length ? (
        visibleLayers.map((layer) => <LayerCharts layer={layer} key={layer.layer_key} />)
      ) : (
        <EmptyState title="No included layers" description="Return to Layer Review and include at least one layer for this dashboard section." />
      )}
    </>
  );
}

export function LayerReviewView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedDatasets, setSelectedDatasets } = useOutletContext<LayoutCtx>();
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  const [datasetId, setDatasetId] = useState(searchParams.get("dataset") ?? selectedDatasets[0]?.id ?? "");
  const [manifest, setManifest] = useState<VisualizationManifest | null>(null);
  const [dashboard, setDashboard] = useState<UniversalDashboard | null>(null);
  const [dashboardRecords, setDashboardRecords] = useState<DashboardRecordResponse | null>(null);
  const [dashboardTypes, setDashboardTypes] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<PageMode>("dashboard");
  const [activeType, setActiveType] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [savingLayer, setSavingLayer] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchDatasets(controller.signal, 250),
      fetchDashboardTypes(controller.signal),
    ]).then(([datasetRows, types]) => {
      const readyRows = datasetRows.filter((dataset) => dataset.status === "ready");
      setDatasets(readyRows);
      setDashboardTypes(types);
      if (!datasetId && readyRows[0]) setDatasetId(readyRows[0].id);
    }).catch((caught: Error) => {
      if (caught.name !== "AbortError") setError(caught.message);
    });
    return () => controller.abort();
  }, [datasetId]);

  const loadDataset = useCallback(async (id: string, nextMode = mode) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [nextManifest, nextDashboard, nextRecords] = await Promise.all([
        fetchVisualizationManifest(id),
        fetchUniversalDashboard(id),
        fetchDashboardRecords(id),
      ]);
      setManifest(nextManifest);
      setDashboard(nextDashboard);
      setDashboardRecords(nextRecords);
      setActiveType("overview");
      setMode(nextMode);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    if (!datasetId) {
      setLoading(false);
      return;
    }
    const selected = datasets.find((dataset) => dataset.id === datasetId);
    if (selected) setSelectedDatasets([selected]);
    setSearchParams({ dataset: datasetId, view: mode }, { replace: true });
    void loadDataset(datasetId, mode);
    // The explicit mode action reloads data itself; avoid a request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, datasets]);

  const changeLayer = useCallback((layerKey: string, patch: Partial<VisualizationLayerManifest>) => {
    setManifest((current) => current ? {
      ...current,
      layers: current.layers.map((layer) => layer.layer_key === layerKey ? { ...layer, ...patch } : layer),
    } : current);
  }, []);

  async function saveLayer(layer: VisualizationLayerManifest) {
    if (!datasetId) return;
    setSavingLayer(layer.layer_key);
    setError(null);
    try {
      const nextManifest = await updateVisualizationLayerReview(datasetId, layer.layer_key, {
        display_name: layer.display_name,
        dashboard_type: layer.dashboard_type,
        included: layer.included,
        confirmed: true,
      });
      setManifest(nextManifest);
      setDashboard(await fetchUniversalDashboard(datasetId));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSavingLayer(null);
    }
  }

  async function confirmAll() {
    if (!datasetId || !manifest) return;
    setConfirmingAll(true);
    setError(null);
    try {
      let nextManifest = manifest;
      for (const layer of manifest.layers) {
        nextManifest = await updateVisualizationLayerReview(datasetId, layer.layer_key, {
          display_name: layer.display_name,
          dashboard_type: layer.dashboard_type,
          included: layer.included,
          confirmed: true,
        });
      }
      setManifest(nextManifest);
      setDashboard(await fetchUniversalDashboard(datasetId));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setConfirmingAll(false);
    }
  }

  async function openDashboard() {
    if (!datasetId) return;
    setMode("dashboard");
    setSearchParams({ dataset: datasetId, view: "dashboard" }, { replace: true });
    await loadDataset(datasetId, "dashboard");
  }

  async function exportExcel() {
    if (!datasetId) return;
    setExporting(true);
    setError(null);
    try {
      const result = await downloadUniversalDashboardExcel(datasetId);
      saveBlob(result.blob, result.filename ?? `${manifest?.dataset_name ?? "dataset"}_dashboard.xlsx`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const confirmedCount = manifest?.layers.filter((layer) => layer.review_status === "confirmed").length ?? 0;
  const reviewCount = manifest?.layers.filter((layer) => layer.review_status === "needs_review").length ?? 0;
  const selectedDataset = datasets.find((dataset) => dataset.id === datasetId) ?? null;

  if (mode === "dashboard" && manifest && dashboard && dashboardRecords && !loading) {
    return (
      <ApprovedUniversalDashboard
        manifest={manifest}
        dashboard={dashboard}
        recordResponse={dashboardRecords}
        dataset={selectedDataset}
        actions={
          <>
            <button type="button" onClick={() => navigate("/map")}>
              View on map
            </button>
            <button
              type="button"
              onClick={() => void exportExcel()}
              disabled={exporting}
            >
              {exporting ? "Preparing…" : "Export Excel"}
            </button>
          </>
        }
      />
    );
  }

  return (
    <div className="layer-review-page" data-testid="layer-review-page">
      <header className="lr-page-header">
        <div>
          <p>UNIVERSAL GDB DASHBOARD ENGINE</p>
          <h1>{mode === "review" ? "Layer Review" : manifest?.dataset_name ?? "Generated Dashboard"}</h1>
          <span>
            {mode === "review"
              ? "Verify how uploaded layers should be interpreted before generating the dashboard."
              : "The dashboard below is generated from the reviewed layers and fields in the selected dataset."}
          </span>
        </div>
        <div className="lr-page-header__actions">
          <label>
            <span>Dataset</span>
            <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
              <option value="">Select a ready dataset</option>
              {datasets.map((dataset) => <option value={dataset.id} key={dataset.id}>{dataset.name}</option>)}
            </select>
          </label>
          {mode === "dashboard" && (
            <>
              <button type="button" className="lr-secondary-btn" onClick={() => navigate("/map")}>View on map</button>
              <button type="button" className="lr-primary-btn" onClick={() => void exportExcel()} disabled={exporting}>{exporting ? "Preparing…" : "Export Excel"}</button>
            </>
          )}
        </div>
      </header>

      <div className="lr-process-strip">
        <span className={datasetId ? "done" : "active"}><b>1</b> Upload dataset</span>
        <i />
        <span className={mode === "review" ? "active" : "done"}><b>2</b> Review layers</span>
        <i />
        <span className={mode === "dashboard" ? "active" : ""}><b>3</b> Generated dashboard</span>
      </div>

      {error && <div className="lr-error">{error}</div>}

      {!datasetId ? (
        <EmptyState title="Select an uploaded dataset" description="Upload a GDB ZIP from Datasets, wait until processing is Ready, then select it here." />
      ) : loading ? (
        <div className="lr-loading"><span /><strong>Inspecting layers and generating field profiles…</strong></div>
      ) : !manifest ? (
        <EmptyState title="Layer report unavailable" description="The selected dataset did not return a visualization manifest." />
      ) : mode === "review" ? (
        <>
          <section className="lr-review-summary">
            <div><span>Dataset</span><strong>{manifest.dataset_name}</strong><p>{manifest.source_format.toUpperCase()} · {manifest.source_crs ?? "Source CRS not recorded"}</p></div>
            <div><span>Mapped features</span><strong>{formatNumber(manifest.total_features)}</strong><p>Persisted and ready for map/dashboard use</p></div>
            <div><span>Detected layers</span><strong>{formatNumber(manifest.layers.length)}</strong><p>{confirmedCount} confirmed · {reviewCount} need review</p></div>
            <div><span>Selected dataset</span><strong>{selectedDataset?.ward || "No ward"}</strong><p>{selectedDataset?.name}</p></div>
          </section>

          <section className="lr-review-actions">
            <div><p>LAYER CLASSIFICATION</p><h2>Confirm what each layer represents</h2><span>Unknown layers remain fully usable through a safe generic dashboard.</span></div>
            <div>
              <button type="button" className="lr-secondary-btn" disabled={confirmingAll} onClick={() => void confirmAll()}>{confirmingAll ? "Confirming…" : "Confirm all detected layers"}</button>
              <button type="button" className="lr-primary-btn" onClick={() => void openDashboard()}>Generate dashboard</button>
            </div>
          </section>

          {manifest.warnings.length > 0 && <div className="lr-manifest-warnings">{manifest.warnings.map((warning) => <div key={warning}>⚠ {warning}</div>)}</div>}

          <div className="lr-layer-grid">
            {manifest.layers.map((layer) => (
              <LayerReviewCard
                key={layer.layer_key}
                layer={layer}
                dashboardTypes={dashboardTypes}
                busy={savingLayer === layer.layer_key}
                onChange={(patch) => changeLayer(layer.layer_key, patch)}
                onSave={() => void saveLayer(layer)}
              />
            ))}
          </div>
        </>
      ) : dashboard && dashboardRecords ? (
        <ApprovedUniversalDashboard
          manifest={manifest}
          dashboard={dashboard}
          recordResponse={dashboardRecords}
          dataset={selectedDataset}
        />
      ) : dashboard ? (
        <GeneratedDashboard
          dashboard={dashboard}
          dashboardTypes={dashboardTypes}
          activeType={activeType}
          setActiveType={setActiveType}
        />
      ) : (
        <EmptyState title="Dashboard unavailable" description="Return to Layer Review and confirm at least one successfully ingested layer." />
      )}
    </div>
  );
}
