import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  DashboardLayerSummary,
  UniversalDashboard,
} from "../../lib/workflow";

interface UniversalDashboardExactProps {
  dashboard: UniversalDashboard;
  dashboardTypes: Record<string, string>;
  activeType: string;
  setActiveType: (value: string) => void;
  onReview: () => void;
  onViewMap: () => void;
  onExport: () => void;
  exporting: boolean;
}

const CHART_COLORS = [
  "#1d9b6c",
  "#367fb8",
  "#e5a11b",
  "#8a63bd",
  "#26a6a1",
  "#dc4c4c",
  "#7aa647",
  "#8b95a7",
];

const TYPE_DESCRIPTIONS: Record<
  string,
  { eyebrow: string; title: string; description: string }
> = {
  roads: {
    eyebrow: "ROAD INFRASTRUCTURE",
    title: "Road network assessment",
    description:
      "Understand mapped roads, available measurements, surface categories, condition fields and survey completeness.",
  },
  drainage: {
    eyebrow: "DRAINAGE INFRASTRUCTURE",
    title: "Storm-water drainage assessment",
    description:
      "Review drainage layers, available dimensions, conditions, categories and missing field information.",
  },
  manholes: {
    eyebrow: "MANHOLE INFRASTRUCTURE",
    title: "Manhole network assessment",
    description:
      "Review mapped access structures, condition fields, depth-related measurements and survey completeness.",
  },
  streetlights: {
    eyebrow: "STREET-LIGHTING INFRASTRUCTURE",
    title: "Street-lighting assessment",
    description:
      "Review lighting assets, operational status, technical attributes and survey coverage.",
  },
  water_network: {
    eyebrow: "WATER-SUPPLY INFRASTRUCTURE",
    title: "Water-network assessment",
    description:
      "Review pipelines, valves and hydrants with available material, diameter and condition information.",
  },
  sewer_network: {
    eyebrow: "SEWER INFRASTRUCTURE",
    title: "Sewer and UGD assessment",
    description:
      "Review sewer-network layers, access assets, technical fields and data gaps.",
  },
  buildings: {
    eyebrow: "BUILDING INVENTORY",
    title: "Building and structure assessment",
    description:
      "Review mapped structures, categories, available area fields and attribute completeness.",
  },
  parcels: {
    eyebrow: "PROPERTY INVENTORY",
    title: "Land parcel and property assessment",
    description:
      "Review property layers, identifiers, categories and available ownership or survey fields.",
  },
  vegetation: {
    eyebrow: "GREEN ASSET INVENTORY",
    title: "Trees and vegetation assessment",
    description:
      "Review green assets, species or health fields, measurements and survey gaps.",
  },
  solid_waste: {
    eyebrow: "SOLID-WASTE INFRASTRUCTURE",
    title: "Solid-waste asset assessment",
    description:
      "Review bins, collection points, capacity fields and service-status information.",
  },
  landmarks: {
    eyebrow: "PUBLIC FACILITIES",
    title: "Landmark and public-facility assessment",
    description:
      "Review public facilities, landmark categories and available descriptive information.",
  },
  utilities: {
    eyebrow: "UTILITY INFRASTRUCTURE",
    title: "Utility asset assessment",
    description:
      "Review point, line and area utility assets with categories and technical fields.",
  },
  boundaries: {
    eyebrow: "ADMINISTRATIVE GEOGRAPHY",
    title: "Boundary and zone assessment",
    description:
      "Review ward, zone and administrative layers and their available identifiers.",
  },
  generic_point: {
    eyebrow: "OTHER POINT ASSETS",
    title: "Point-layer assessment",
    description:
      "A safe field-driven analysis generated from the information present in the uploaded point layer.",
  },
  generic_line: {
    eyebrow: "OTHER LINEAR ASSETS",
    title: "Linear-layer assessment",
    description:
      "A safe field-driven analysis generated from the information present in the uploaded line layer.",
  },
  generic_polygon: {
    eyebrow: "OTHER AREA ASSETS",
    title: "Area-layer assessment",
    description:
      "A safe field-driven analysis generated from the information present in the uploaded polygon layer.",
  },
  generic: {
    eyebrow: "OTHER MAPPED LAYERS",
    title: "Generic layer assessment",
    description:
      "A field-driven dashboard generated without making unsupported assumptions about the data.",
  },
};

function formatNumber(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatTooltipValue(value: unknown): [string, string] {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return [formatNumber(numeric), "Records"];
}

function displayType(type: string, dashboardTypes: Record<string, string>) {
  return dashboardTypes[type] ?? type.replaceAll("_", " ");
}

function KpiCard({
  icon,
  label,
  value,
  helper,
  tone = "default",
}: {
  icon: string;
  label: string;
  value: string | number;
  helper: string;
  tone?: "default" | "danger" | "warning" | "success";
}) {
  return (
    <article className={`kpi-card kpi-card--${tone}`}>
      <div className="kpi-card__top">
        <span className="kpi-card__icon">{icon}</span>
        <span className="kpi-card__label">{label}</span>
      </div>
      <strong className="kpi-card__value">
        {typeof value === "number" ? formatNumber(value) : value}
      </strong>
      <p className="kpi-card__helper">{helper}</p>
    </article>
  );
}

function completenessForDashboard(dashboard: UniversalDashboard): number {
  if (dashboard.profiled_values <= 0) return 100;
  return Math.max(
    0,
    Math.min(
      100,
      (100 * (dashboard.profiled_values - dashboard.missing_values)) /
        dashboard.profiled_values,
    ),
  );
}

function layerCompletenessRows(layers: DashboardLayerSummary[]) {
  return layers
    .slice()
    .sort((a, b) => b.feature_count - a.feature_count)
    .slice(0, 7)
    .map((layer) => ({
      label: layer.display_name,
      percentage: layer.completeness_percentage,
      complete: Math.round(
        (layer.feature_count * layer.completeness_percentage) / 100,
      ),
      total: layer.feature_count,
    }));
}

function OverviewDashboard({
  dashboard,
  dashboardTypes,
  onSelectType,
}: {
  dashboard: UniversalDashboard;
  dashboardTypes: Record<string, string>;
  onSelectType: (type: string) => void;
}) {
  const completeness = completenessForDashboard(dashboard);
  const sortedLayers = dashboard.layers
    .slice()
    .sort((a, b) => b.feature_count - a.feature_count);
  const typeCounts = dashboard.dashboard_types.slice(0, 8).map((item) => ({
    ...item,
    label: displayType(item.label, dashboardTypes),
  }));
  const completenessRows = layerCompletenessRows(dashboard.layers);

  return (
    <div className="dashboard-page">
      <section className="executive-hero">
        <div>
          <span className="executive-hero__label">Total mapped features</span>
          <strong>{formatNumber(dashboard.total_features)}</strong>
          <p>
            Survey records available across {formatNumber(dashboard.included_layers)} reviewed infrastructure layers.
          </p>
        </div>

        <div className="executive-hero__message">
          <span className="executive-hero__check">✓</span>
          <div>
            <strong>Survey inventory is ready for analysis</strong>
            <p>
              Dashboard values are generated directly from the uploaded GDB. Missing fields are shown as unavailable and are never treated as zero.
            </p>
          </div>
        </div>
      </section>

      <section className="kpi-grid" aria-label="Key survey totals">
        <KpiCard icon="▦" label="Included layers" value={dashboard.included_layers} helper="Reviewed layers used in this dashboard" />
        <KpiCard icon="◉" label="Point features" value={dashboard.point_features} helper="Point and multipoint survey records" />
        <KpiCard icon="━" label="Linear features" value={dashboard.line_features} helper="Roads, drains, pipelines and other lines" />
        <KpiCard icon="▤" label="Area features" value={dashboard.polygon_features} helper="Buildings, parcels, boundaries and areas" />
        <KpiCard icon="✓" label="Data completeness" value={`${completeness.toFixed(1)}%`} helper="Across all profiled attribute fields" tone={completeness < 60 ? "warning" : "success"} />
        <KpiCard icon="!" label="Items needing attention" value={dashboard.issue_count} helper="Features with elevated issue severity" tone={dashboard.issue_count > 0 ? "danger" : "default"} />
        <KpiCard icon="◇" label="Dashboard sections" value={dashboard.dashboard_types.length} helper="Automatically activated analysis categories" />
      </section>

      <section className="dashboard-section-heading">
        <div>
          <span>Survey composition</span>
          <h2>What has been mapped?</h2>
        </div>
        <p>
          Layer counts and the main detected infrastructure categories in the selected uploaded dataset.
        </p>
      </section>

      <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div>
              <span>Layer-wise inventory</span>
              <h3>Records by source layer</h3>
            </div>
          </div>
          <div className="chart-container chart-container--large">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sortedLayers.slice(0, 12)} layout="vertical" margin={{ top: 4, right: 18, bottom: 4, left: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} />
                <YAxis type="category" dataKey="display_name" width={145} tick={{ fontSize: 12 }} />
                <Tooltip formatter={formatTooltipValue} />
                <Bar dataKey="feature_count" fill="#267d6b" radius={[0, 7, 7, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div>
              <span>Detected infrastructure</span>
              <h3>Dashboard categories</h3>
            </div>
          </div>
          <div className="ranked-list">
            {typeCounts.map((category, index) => {
              const maximum = typeCounts[0]?.count ?? 1;
              const percentage = Math.round((category.count / maximum) * 100);
              return (
                <button
                  type="button"
                  className="ranked-list__item ranked-list__item--button"
                  key={category.label}
                  onClick={() => {
                    const source = dashboard.dashboard_types.find(
                      (item) => displayType(item.label, dashboardTypes) === category.label,
                    );
                    if (source) onSelectType(source.label);
                  }}
                >
                  <span className="ranked-list__rank">{index + 1}</span>
                  <div className="ranked-list__content">
                    <div className="ranked-list__label">
                      <strong>{category.label}</strong>
                      <span>{formatNumber(category.count)}</span>
                    </div>
                    <div className="ranked-list__track"><span style={{ width: `${percentage}%` }} /></div>
                  </div>
                </button>
              );
            })}
          </div>
        </article>
      </section>

      <section className="dashboard-section-heading">
        <div>
          <span>Infrastructure health</span>
          <h2>Geometry and data quality</h2>
        </div>
        <p>
          A simple view of how the dataset is represented and how complete the most important layers are.
        </p>
      </section>

      <section className="dashboard-chart-grid">
        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div><span>Geometry mix</span><h3>Point, line and area records</h3></div>
          </div>
          <div className="chart-container chart-container--donut">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={dashboard.geometry_breakdown} dataKey="count" nameKey="label" innerRadius={72} outerRadius={108} paddingAngle={2}>
                  {dashboard.geometry_breakdown.map((entry, index) => <Cell key={entry.label} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={formatTooltipValue} />
                <Legend verticalAlign="bottom" height={48} />
              </PieChart>
            </ResponsiveContainer>
            <div className="donut-centre" aria-hidden="true">
              <strong>{formatNumber(dashboard.total_features)}</strong>
              <span>features</span>
            </div>
          </div>
        </article>

        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div><span>Field completeness</span><h3>How much information is available?</h3></div>
          </div>
          <div className="completeness-list">
            {completenessRows.map((item) => (
              <div className="completeness-item" key={item.label}>
                <div className="completeness-item__label">
                  <strong>{item.label}</strong>
                  <span>{item.percentage.toFixed(0)}%</span>
                </div>
                <div className="completeness-item__track"><span style={{ width: `${item.percentage}%` }} /></div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="dashboard-section-heading">
        <div><span>Quick findings</span><h2>What should an officer notice first?</h2></div>
        <p>Clear indicators from the uploaded GDB without hiding missing or uncertain survey information.</p>
      </section>

      <section className="insight-grid">
        <article className="insight-card"><span>Reviewed layers</span><strong>{dashboard.included_layers}</strong><p>Layers are included in the generated dashboard.</p></article>
        <article className="insight-card insight-card--warning"><span>Missing field values</span><strong>{formatNumber(dashboard.missing_values)}</strong><p>Profiled attribute cells are blank or unavailable.</p></article>
        <article className="insight-card insight-card--danger"><span>Attention items</span><strong>{formatNumber(dashboard.issue_count)}</strong><p>Features carry elevated issue severity.</p></article>
        <article className="insight-card insight-card--muted"><span>Generic-safe analysis</span><strong>{dashboard.layers.filter((layer) => layer.dashboard_type.startsWith("generic")).length}</strong><p>Unfamiliar layers remain usable without unsupported assumptions.</p></article>
      </section>
    </div>
  );
}

function LayerDashboard({ layer }: { layer: DashboardLayerSummary }) {
  const categoryData = layer.category_breakdown.filter((row) => row.count > 0).slice(0, 10);
  const statusData = layer.status_breakdown.filter((row) => row.count > 0).slice(0, 10);
  const availableValues = layer.fields.reduce((sum, field) => sum + field.populated_count, 0);
  const missingValues = layer.fields.reduce((sum, field) => sum + field.missing_count, 0);

  return (
    <section className="exact-layer-section">
      <div className="kpi-grid kpi-grid--six">
        <KpiCard icon="▦" label="Features" value={layer.feature_count} helper="Records available in this source layer" />
        <KpiCard icon="✓" label="Data completeness" value={`${layer.completeness_percentage.toFixed(1)}%`} helper="Across all profiled fields" tone={layer.completeness_percentage < 60 ? "warning" : "success"} />
        <KpiCard icon="!" label="Needs attention" value={layer.issue_count} helper="Features with elevated issue severity" tone={layer.issue_count > 0 ? "danger" : "default"} />
        <KpiCard icon="≡" label="Available fields" value={layer.fields.length} helper="Fields containing at least one usable value" />
        <KpiCard icon="●" label="Populated values" value={availableValues} helper="Non-empty profiled attribute values" />
        <KpiCard icon="○" label="Missing values" value={missingValues} helper="Blank or unavailable profiled values" tone={missingValues > 0 ? "warning" : "default"} />
      </div>

      <section className="dashboard-section-heading">
        <div><span>Layer analysis</span><h2>{layer.display_name}</h2></div>
        <p>{formatNumber(layer.feature_count)} features · {layer.geometry_types.join(", ") || "Geometry not recorded"}</p>
      </section>

      <section className="dashboard-chart-grid">
        <article className="dashboard-panel">
          <div className="dashboard-panel__heading"><div><span>Category distribution</span><h3>Most common recorded values</h3></div></div>
          <div className="chart-container">
            {categoryData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryData} layout="vertical" margin={{ top: 8, right: 18, left: 18, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis type="category" dataKey="label" width={135} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={formatTooltipValue} />
                  <Bar dataKey="count" fill="#267d6b" radius={[0, 7, 7, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="exact-chart-empty">No category values were available in this layer.</div>}
          </div>
        </article>

        <article className="dashboard-panel">
          <div className="dashboard-panel__heading"><div><span>Status and condition</span><h3>{layer.status_field || "Status information not available"}</h3></div></div>
          <div className="chart-container chart-container--donut">
            {statusData.length ? (
              <>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusData} dataKey="count" nameKey="label" innerRadius={72} outerRadius={108} paddingAngle={2}>
                      {statusData.map((entry, index) => <Cell key={entry.label} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={formatTooltipValue} />
                    <Legend verticalAlign="bottom" height={48} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-centre" aria-hidden="true"><strong>{formatNumber(statusData.reduce((sum, item) => sum + item.count, 0))}</strong><span>records</span></div>
              </>
            ) : <div className="exact-chart-empty">This survey does not include a usable condition or status field. No false zero has been shown.</div>}
          </div>
        </article>
      </section>

      {layer.numeric_summaries.length > 0 && (
        <>
          <section className="dashboard-section-heading">
            <div><span>Measured information</span><h2>Available numeric summaries</h2></div>
            <p>Only numeric fields found in the uploaded GDB are presented.</p>
          </section>
          <section className="insight-grid exact-numeric-grid">
            {layer.numeric_summaries.map((summary) => (
              <article className="insight-card" key={summary.field}>
                <span>{summary.field}</span>
                <strong>{summary.average === null ? "N/A" : formatNumber(summary.average)}</strong>
                <p>{summary.minimum === null || summary.maximum === null ? `${summary.count} usable numeric values` : `Range ${formatNumber(summary.minimum)} – ${formatNumber(summary.maximum)} · ${summary.count} values`}</p>
              </article>
            ))}
          </section>
        </>
      )}

      <section className="dashboard-section-heading">
        <div><span>Field report</span><h2>Availability and missing information</h2></div>
        <p>Review the original source fields before using the data for operational decisions.</p>
      </section>
      <article className="dashboard-panel exact-field-panel">
        <div className="exact-field-table">
          <div className="exact-field-table__head"><span>Field</span><span>Type</span><span>Populated</span><span>Missing</span><span>Completeness</span></div>
          {layer.fields.slice(0, 30).map((field) => {
            const total = field.populated_count + field.missing_count;
            const completeness = total ? (field.populated_count / total) * 100 : 0;
            return (
              <div className="exact-field-table__row" key={field.name}>
                <span>{field.name}</span><span>{field.detected_type}</span><span>{formatNumber(field.populated_count)}</span><span>{formatNumber(field.missing_count)}</span>
                <span><i><b style={{ width: `${completeness}%` }} /></i>{completeness.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      </article>
    </section>
  );
}

export function UniversalDashboardExact({
  dashboard,
  dashboardTypes,
  activeType,
  setActiveType,
  onReview,
  onViewMap,
  onExport,
  exporting,
}: UniversalDashboardExactProps) {
  const types = useMemo(
    () => [...new Set(dashboard.layers.map((layer) => layer.dashboard_type))],
    [dashboard.layers],
  );
  const visibleLayers = activeType === "overview"
    ? dashboard.layers
    : dashboard.layers.filter((layer) => layer.dashboard_type === activeType);
  const descriptor = activeType === "overview"
    ? {
        eyebrow: "GENERATED DATASET OVERVIEW",
        title: "Urban Infrastructure Dashboard",
        description:
          "A clear summary generated automatically from the reviewed layers and fields in the uploaded dataset.",
      }
    : TYPE_DESCRIPTIONS[activeType] ?? TYPE_DESCRIPTIONS.generic;

  return (
    <div className="executive-dashboard universal-dashboard-exact">
      <header className="dashboard-titlebar">
        <div>
          <p className="dashboard-kicker">{dashboard.dataset_name}</p>
          <h1>Urban Infrastructure Dashboard</h1>
          <p className="dashboard-subtitle">
            A clear summary of uploaded roads, buildings, drains, utilities and every additional mapped layer detected in the GDB.
          </p>
        </div>
        <div className="exact-title-actions">
          <div className="dashboard-status"><span className="dashboard-status__dot" />GDB survey data connected</div>
          <div className="exact-action-row">
            <button type="button" onClick={onReview}>Layer review</button>
            <button type="button" onClick={onViewMap}>View map</button>
            <button type="button" className="exact-action-row__primary" onClick={onExport} disabled={exporting}>{exporting ? "Preparing…" : "Export Excel"}</button>
          </div>
        </div>
      </header>

      <nav className="dashboard-tabs" aria-label="Generated dashboard sections">
        <button type="button" className={`dashboard-tab ${activeType === "overview" ? "dashboard-tab--active" : ""}`} onClick={() => setActiveType("overview")}>Executive overview</button>
        {types.map((type) => (
          <button type="button" className={`dashboard-tab ${activeType === type ? "dashboard-tab--active" : ""}`} onClick={() => setActiveType(type)} key={type}>{displayType(type, dashboardTypes)}</button>
        ))}
      </nav>

      {activeType !== "overview" && (
        <section className="exact-page-heading">
          <div><p>{descriptor.eyebrow}</p><h1>{descriptor.title}</h1><span>{descriptor.description}</span></div>
          <b>{visibleLayers.reduce((sum, layer) => sum + layer.feature_count, 0).toLocaleString("en-IN")} features</b>
        </section>
      )}

      {activeType === "overview" ? (
        <OverviewDashboard dashboard={dashboard} dashboardTypes={dashboardTypes} onSelectType={setActiveType} />
      ) : visibleLayers.length ? (
        visibleLayers.map((layer) => <LayerDashboard layer={layer} key={layer.layer_key} />)
      ) : (
        <div className="exact-chart-empty exact-chart-empty--page">No included layer is available for this dashboard section.</div>
      )}

      {dashboard.warnings.length > 0 && (
        <section className="exact-dashboard-warnings">
          <strong>Dataset notes</strong>
          {dashboard.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
        </section>
      )}

      <footer className="dashboard-footer">
        <span>Data source: uploaded GDB · {dashboard.dataset_name}</span>
        <span>Universal layer classification · original source fields preserved</span>
      </footer>
    </div>
  );
}
