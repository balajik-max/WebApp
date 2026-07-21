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

import { calculateExecutiveDashboard } from "../../lib/approved-dashboard/dashboardCalculations";
import type { GisWorkbookData } from "../../lib/approved-dashboard/gisTypes";
import { KpiCard } from "./KpiCard";

type ExecutiveDashboardProps = {
  data: GisWorkbookData;
  totalFeatures?: number;
  includedLayers?: number;
};

const CONDITION_COLOURS: Record<string, string> = {
  Good: "#1d9b6c",
  Fair: "#e5a11b",
  "Needs attention": "#dc4c4c",
  "Not recorded": "#8b95a7",
};

function formatTooltipValue(value: unknown): [string, string] {
  const numericValue = typeof value === "number" ? value : Number(value ?? 0);
  return [numericValue.toLocaleString("en-IN"), "Records"];
}

export function ExecutiveDashboard({ data, totalFeatures, includedLayers }: ExecutiveDashboardProps) {
  const dashboard = useMemo(() => calculateExecutiveDashboard(data), [data]);

  return (
    <div className="dashboard-page">

      <section className="executive-hero">
        <div>
          <span className="executive-hero__label">Total mapped features</span>
          <strong>{(totalFeatures ?? dashboard.totalFeatures).toLocaleString("en-IN")}</strong>
          <p>Survey records available across {(includedLayers ?? 8).toLocaleString("en-IN")} reviewed infrastructure layers.</p>
        </div>

        <div className="executive-hero__message">
          <span className="executive-hero__check">✓</span>
          <div>
            <strong>Survey inventory is ready for analysis</strong>
            <p>
              Dashboard values are calculated from the uploaded GDB records and the reviewed layer classifications.
            </p>
          </div>
        </div>
      </section>

      <section className="approved-kpi-grid" aria-label="Key survey totals">
        <KpiCard
          icon="▦"
          label="Buildings & polygons"
          value={dashboard.buildingsAndPolygons}
          helper="Mapped structures and area features"
        />
        <KpiCard
          icon="━"
          label="Roads surveyed"
          value={dashboard.roads}
          helper="Road centerline survey records"
        />
        <KpiCard
          icon="◉"
          label="Manholes"
          value={dashboard.manholes}
          helper="Mapped sewer and drainage manholes"
        />
        <KpiCard
          icon="≋"
          label="Storm-water drains"
          value={dashboard.stormWaterDrains}
          helper="Open and closed drain segments"
        />
        <KpiCard
          icon="⌁"
          label="Utility assets"
          value={dashboard.utilityAssets}
          helper="Point and linear utility features"
        />
        <KpiCard
          icon="⌂"
          label="Landmarks"
          value={dashboard.landmarks}
          helper="Public and community landmarks"
        />
        <KpiCard
          icon="!"
          label="Items needing attention"
          value={dashboard.issuesNeedingAttention}
          helper="Road, manhole and drain issues identified"
          tone="danger"
        />
      </section>

      <section className="dashboard-section-heading">
        <div>
          <span>Survey composition</span>
          <h2>What has been mapped?</h2>
        </div>
        <p>
          Layer counts and the most common asset categories in the current
          ward survey.
        </p>
      </section>

      <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div>
              <span>Layer-wise inventory</span>
              <h3>Records by infrastructure layer</h3>
            </div>
          </div>

          <div className="chart-container chart-container--large">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={dashboard.layerDistribution}
                layout="vertical"
                margin={{ top: 4, right: 18, bottom: 4, left: 16 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={132}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip formatter={formatTooltipValue} />
                <Bar dataKey="count" fill="#267d6b" radius={[0, 7, 7, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div>
              <span>Most common features</span>
              <h3>Top asset categories</h3>
            </div>
          </div>

          <div className="ranked-list">
            {dashboard.topCategories.map((category, index) => {
              const maximum = dashboard.topCategories[0]?.count ?? 1;
              const percentage = Math.round((category.count / maximum) * 100);

              return (
                <div className="ranked-list__item" key={category.name}>
                  <span className="ranked-list__rank">{index + 1}</span>
                  <div className="ranked-list__content">
                    <div className="ranked-list__label">
                      <strong>{category.name}</strong>
                      <span>{category.count.toLocaleString("en-IN")}</span>
                    </div>
                    <div className="ranked-list__track">
                      <span style={{ width: `${percentage}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      </section>

      <section className="dashboard-section-heading">
        <div>
          <span>Infrastructure health</span>
          <h2>Condition and data quality</h2>
        </div>
        <p>
          Manhole and drain observations are grouped into simple condition
          classes for quick understanding.
        </p>
      </section>

      <section className="dashboard-chart-grid">
        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div>
              <span>Combined observations</span>
              <h3>Condition summary</h3>
            </div>
          </div>

          <div className="chart-container chart-container--donut">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={dashboard.conditionSummary}
                  dataKey="count"
                  nameKey="name"
                  innerRadius={72}
                  outerRadius={108}
                  paddingAngle={2}
                >
                  {dashboard.conditionSummary.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={CONDITION_COLOURS[entry.name]}
                    />
                  ))}
                </Pie>
                <Tooltip formatter={formatTooltipValue} />
                <Legend verticalAlign="bottom" height={48} />
              </PieChart>
            </ResponsiveContainer>

            <div className="donut-centre" aria-hidden="true">
              <strong>
                {dashboard.conditionSummary
                  .reduce((total, item) => total + item.count, 0)
                  .toLocaleString("en-IN")}
              </strong>
              <span>observations</span>
            </div>
          </div>
        </article>

        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div>
              <span>Field completeness</span>
              <h3>How much information is available?</h3>
            </div>
          </div>

          <div className="completeness-list">
            {dashboard.completeness.map((item) => (
              <div className="completeness-item" key={item.label}>
                <div className="completeness-item__label">
                  <strong>{item.label}</strong>
                  <span>
                    {item.complete}/{item.total} · {item.percentage}%
                  </span>
                </div>
                <div className="completeness-item__track">
                  <span style={{ width: `${item.percentage}%` }} />
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="dashboard-section-heading">
        <div>
          <span>Quick findings</span>
          <h2>What should an officer notice first?</h2>
        </div>
        <p>
          These indicators highlight easily understandable issues and gaps in
          the available survey data.
        </p>
      </section>

      <section className="insight-grid">
        <article className="insight-card insight-card--warning">
          <span>Road access</span>
          <strong>{dashboard.insights.roadsWithoutFootpath}</strong>
          <p>Surveyed roads are recorded without a footpath.</p>
        </article>

        <article className="insight-card">
          <span>Drain network</span>
          <strong>{dashboard.insights.closedDrains}</strong>
          <p>Storm-water drain segments are recorded as closed drains.</p>
        </article>

        <article className="insight-card insight-card--muted">
          <span>Missing inspection data</span>
          <strong>{dashboard.insights.manholesWithoutCondition}</strong>
          <p>Manholes do not yet have a recorded condition.</p>
        </article>

        <article className="insight-card insight-card--danger">
          <span>Drain attention</span>
          <strong>{dashboard.insights.poorDrainObservations}</strong>
          <p>Drain observations are classified as bad or needing attention.</p>
        </article>
      </section>

    </div>
  );
}
