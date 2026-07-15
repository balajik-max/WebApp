import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Area,
  AreaChart,
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
import {
  fetchCategories,
  fetchDatasets,
  fetchOverview,
  type AnalyticsOverview,
  type CategoryOption,
  type DatasetRow,
  type IngestionTrendPoint,
} from "../lib/workflow";
import { colorForCategory } from "../lib/categoryColors";
import { AnalyticsScopeBar } from "../components/analytics/AnalyticsScopeBar";
import { AnalyticsCategoryMap } from "../components/analytics/AnalyticsCategoryMap";
import { AnalyticsFeatureTable } from "../components/analytics/AnalyticsFeatureTable";
import { AnalyticsAiSummary } from "../components/analytics/AnalyticsAiSummary";
import { ManholeRecommendCard } from "../components/ManholeRecommendCard";
import type { AiAnswer } from "../lib/ai";
import { aiManholeRecommend } from "../lib/ai"; // for the manhole plan API

const STATUS_COLORS: Record<string, string> = {
  open: "#3b82f6",
  reviewing: "#f59e0b",
  in_progress: "#a855f7",
  blocked: "#6b7280",
  resolved: "#22c55e",
  rejected: "#ef4444",
};
const SEVERITY_COLORS: Record<string, string> = {
  low: "#22c55e",
  medium: "#f59e0b",
  high: "#ef4444",
};
const ANALYTICS_SCOPE_STORAGE_KEY = "davangere.analytics.scope.v1";

function formatNum(value: number | undefined): string {
  return value == null ? "—" : value.toLocaleString();
}

function stableValues(values: string[]) {
  return [...new Set(values)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );
}

interface StoredAnalyticsScope {
  draftDatasetIds: string[];
  draftCategories: string[];
  appliedDatasetIds: string[];
  appliedCategories: string[];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return stableValues(value.filter((item): item is string => typeof item === "string" && item.length > 0));
}

function readStoredAnalyticsScope(fallbackDatasetIds: string[]): StoredAnalyticsScope {
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem(ANALYTICS_SCOPE_STORAGE_KEY) ?? "null"
    ) as Partial<StoredAnalyticsScope> | null;
    if (!parsed) throw new Error("No stored Analytics scope");
    return {
      draftDatasetIds: stringArray(parsed.draftDatasetIds),
      draftCategories: stringArray(parsed.draftCategories),
      appliedDatasetIds: stringArray(parsed.appliedDatasetIds),
      appliedCategories: stringArray(parsed.appliedCategories),
    };
  } catch {
    const datasets = stableValues(fallbackDatasetIds);
    return {
      draftDatasetIds: datasets,
      draftCategories: [],
      appliedDatasetIds: datasets,
      appliedCategories: [],
    };
  }
}

interface LayoutCtx {
  selectedDatasets: DatasetRow[];
}

export function AnalyticsView() {
  const { selectedDatasets } = useOutletContext<LayoutCtx>();
  const initialDatasetIds = useMemo(
    () => stableValues(selectedDatasets.map((dataset) => dataset.id)),
    // The layout selection is only an initial convenience. Analytics owns
    // its scope after this component mounts, so it never changes the Map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const initialScope = useMemo(
    () => readStoredAnalyticsScope(initialDatasetIds),
    [initialDatasetIds]
  );

  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([]);
  const [draftDatasetIds, setDraftDatasetIds] = useState<string[]>(initialScope.draftDatasetIds);
  const [draftCategories, setDraftCategories] = useState<string[]>(initialScope.draftCategories);
  const [appliedDatasetIds, setAppliedDatasetIds] = useState<string[]>(initialScope.appliedDatasetIds);
  const [appliedCategories, setAppliedCategories] = useState<string[]>(initialScope.appliedCategories);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loadingDatasets, setLoadingDatasets] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [analyzing, setAnalyzing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analysisVersion, setAnalysisVersion] = useState(0);

  const draftDatasetKey = useMemo(
    () => stableValues(draftDatasetIds).join(","),
    [draftDatasetIds]
  );
  const appliedScopeKey = useMemo(
    () => `${stableValues(appliedDatasetIds).join(",")}|${stableValues(appliedCategories).join(",")}`,
    [appliedCategories, appliedDatasetIds]
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(
        ANALYTICS_SCOPE_STORAGE_KEY,
        JSON.stringify({
          draftDatasetIds: stableValues(draftDatasetIds),
          draftCategories: stableValues(draftCategories),
          appliedDatasetIds: stableValues(appliedDatasetIds),
          appliedCategories: stableValues(appliedCategories),
        } satisfies StoredAnalyticsScope)
      );
    } catch {
      // Storage can be disabled by browser policy. In that case the page
      // continues to work normally for the current mounted session.
    }
  }, [appliedCategories, appliedDatasetIds, draftCategories, draftDatasetIds]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingDatasets(true);
    fetchDatasets(controller.signal, 200)
      .then(setDatasets)
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(`Dataset list unavailable: ${caught.message}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDatasets(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingCategories(true);
    fetchCategories(undefined, controller.signal, draftDatasetIds)
      .then((options) => {
        setCategoryOptions(options);
        const available = new Set(options.map((option) => option.category));
        setDraftCategories((current) => current.filter((category) => available.has(category)));
      })
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(`Category list unavailable: ${caught.message}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCategories(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftDatasetKey]);

  useEffect(() => {
    const controller = new AbortController();
    setAnalyzing(true);
    setError(null);
    fetchOverview(appliedDatasetIds, appliedCategories, controller.signal)
      .then(setOverview)
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(`Live analytics unavailable: ${caught.message}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setAnalyzing(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedScopeKey, analysisVersion]);

  function analyze() {
    setAppliedDatasetIds(stableValues(draftDatasetIds));
    setAppliedCategories(stableValues(draftCategories));
    setAnalysisVersion((value) => value + 1);
  }

  function resetScope() {
    setDraftDatasetIds([]);
    setDraftCategories([]);
    setAppliedDatasetIds([]);
    setAppliedCategories([]);
    setAnalysisVersion((value) => value + 1);
  }

  const appliedDatasetNames = useMemo(() => {
    const byId = new Map(datasets.map((dataset) => [dataset.id, dataset.name]));
    return appliedDatasetIds.map((id) => byId.get(id) ?? id);
  }, [appliedDatasetIds, datasets]);

  const totalSeverity = overview
    ? overview.severity_breakdown.reduce((sum, bucket) => sum + bucket.count, 0)
    : 0;
  const totalCategoryCount = overview
    ? overview.category_breakdown.reduce((sum, category) => sum + category.count, 0)
    : 0;
  const healthScore =
    overview && overview.total_review_items > 0
      ? Math.round((overview.resolved_reviews / overview.total_review_items) * 100)
      : null;

  const severityData = overview
    ? overview.severity_breakdown.map((item) => ({
        name: item.bucket.charAt(0).toUpperCase() + item.bucket.slice(1),
        value: item.count,
        color: SEVERITY_COLORS[item.bucket] || "#6b7280",
        percentage: totalSeverity > 0 ? ((item.count / totalSeverity) * 100).toFixed(1) : "0",
      }))
    : [];

  const topCategories = overview?.category_breakdown.slice(0, 12) ?? [];
  const wardData = overview
    ? [...overview.ward_breakdown]
        .sort((a, b) => b.feature_count - a.feature_count)
        .slice(0, 8)
    : [];

  const heatmapData = useMemo(() => {
    if (!overview) return [];
    return overview.category_breakdown.slice(0, 8).map((category) => ({
      category: category.category,
      count: category.count,
      avgSeverity: category.avg_severity,
      severityLevel:
        category.avg_severity >= 0.67
          ? "High"
          : category.avg_severity >= 0.34
            ? "Medium"
            : "Low",
      color:
        category.avg_severity >= 0.67
          ? "#ef4444"
          : category.avg_severity >= 0.34
            ? "#f59e0b"
            : "#22c55e",
    }));
  }, [overview]);

  const trendData = useMemo(() => {
    if (!overview) return [];
    return overview.ingestion_trend.map((point: IngestionTrendPoint) => ({
      date: point.date,
      cumulative: point.cumulative_features,
      added: point.features_added,
    }));
  }, [overview]);

  const reviewStatusData = useMemo(() => {
    if (!overview) return [];
    return overview.status_breakdown.map((item) => ({
      name: item.status.charAt(0).toUpperCase() + item.status.slice(1).replace("_", " "),
      value: item.count,
      color: STATUS_COLORS[item.status] || "#6b7280",
    }));
  }, [overview]);

  return (
    <div className="analytics-page" data-testid="analytics-page">
      <header className="analytics-page__head">
        <div>
          <div className="analytics-page__eyebrow">Analytics</div>
          <h2 className="page-title">Dataset & Category Intelligence</h2>
          <p className="page-sub">
            {appliedDatasetIds.length === 0
              ? "Analyzing all datasets"
              : `Analyzing ${appliedDatasetNames.join(", ")}`}
            {appliedCategories.length === 0
              ? " across all real categories."
              : ` for ${appliedCategories.length} selected categor${appliedCategories.length === 1 ? "y" : "ies"}.`}
          </p>
        </div>
        {overview && (
          <span className="page-timestamp" data-testid="analytics-timestamp">
            generated {new Date(overview.generated_at).toLocaleString()}
          </span>
        )}
      </header>

      <AnalyticsScopeBar
        datasets={datasets}
        categories={categoryOptions}
        draftDatasetIds={draftDatasetIds}
        draftCategories={draftCategories}
        appliedDatasetIds={appliedDatasetIds}
        appliedCategories={appliedCategories}
        loadingDatasets={loadingDatasets}
        loadingCategories={loadingCategories}
        analyzing={analyzing}
        onDatasetChange={setDraftDatasetIds}
        onCategoryChange={setDraftCategories}
        onAnalyze={analyze}
        onReset={resetScope}
      />

      {error && <div className="analytics-page__error">{error}</div>}
      {analyzing && <div className="analytics-page__loading">Calculating the applied scope from PostGIS…</div>}

      <section className="kpi-grid" data-testid="kpi-grid">
        <KpiCard label="Contributing Surveys" value={overview?.total_datasets} icon="dataset" testid="kpi-total-surveys" />
        <KpiCard label="Features Mapped" value={overview?.total_features} icon="map" tone="info" testid="kpi-features" />
        <KpiCard label="Review Items" value={overview?.total_review_items} icon="alert" tone="warn" testid="kpi-review-items" />
        <KpiCard label="Open Reviews" value={overview?.open_reviews} icon="alert" tone="warn" testid="kpi-open-reviews" />
        <KpiCard label="Resolved" value={overview?.resolved_reviews} icon="check" tone="ok" testid="kpi-resolved" />
        <KpiCard label="Health Score" value={healthScore == null ? "N/A" : `${healthScore}%`} icon="health" accent testid="kpi-health" />
        <KpiCard label="Avg Severity" value={overview ? overview.average_severity.toFixed(2) : undefined} icon="severity" testid="kpi-severity" />
      </section>

      <section className="chart-grid chart-grid--2">
        <article className="chart-card" data-testid="chart-trend-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">Trend</div>
              <h3 className="chart-card__title">Scoped Ingestion Growth</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorCumulative" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "var(--ink-mute)" }} />
                  <Area type="monotone" dataKey="cumulative" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorCumulative)" name="Matching features" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState text="No ingestion history exists for the applied scope." />
            )}
          </div>
        </article>

        <article className="chart-card" data-testid="chart-categories-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">Breakdown</div>
              <h3 className="chart-card__title">Top Categories in Scope</h3>
            </div>
            <span className="chart-card__badge">
              {topCategories.length} of {overview?.category_breakdown.length ?? 0}
            </span>
          </div>
          <div className="chart-card__body">
            {topCategories.length > 0 ? (
              <div className="analytics-category-chart">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={topCategories} layout="vertical" margin={{ left: 28, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="category" width={130} tick={{ fill: "var(--ink-dim)", fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                    <Bar dataKey="count" name="Features" radius={[0, 6, 6, 0]}>
                      {topCategories.map((category) => <Cell key={category.category} fill={colorForCategory(category.category)} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState text="No category data exists for the applied scope." />
            )}
          </div>
        </article>
      </section>

      <section className="chart-grid chart-grid--2">
        <article className="chart-card" data-testid="chart-severity-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">Priority overview</div>
              <h3 className="chart-card__title">Features by Severity Level</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {totalSeverity > 0 ? (
              <div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={severityData} layout="vertical" margin={{ left: 20, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: "var(--ink-dim)", fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false} width={80} />
                    <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                      {severityData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="analytics-severity-summary">
                  {severityData.map((item) => (
                    <div key={item.name}>
                      <strong style={{ color: item.color }}>{item.value.toLocaleString()}</strong>
                      <span>{item.name} ({item.percentage}%)</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState text="No severity data exists for the applied scope." />
            )}
          </div>
        </article>

        <article className="chart-card" data-testid="chart-status-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">Status</div>
              <h3 className="chart-card__title">Review Progress</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {reviewStatusData.length > 0 ? (
              <div className="analytics-review-layout">
                <div className="analytics-review-donut">
                  <ResponsiveContainer width={200} height={200}>
                    <PieChart>
                      <Pie data={reviewStatusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={90} stroke="var(--surface)" strokeWidth={3} paddingAngle={2}>
                        {reviewStatusData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                      </Pie>
                      <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="analytics-review-donut__center">
                    <strong>{overview?.total_review_items ?? 0}</strong>
                    <span>Total</span>
                  </div>
                </div>
                <div className="analytics-review-legend">
                  {reviewStatusData.map((item) => (
                    <div key={item.name}>
                      <i style={{ background: item.color }} />
                      <span>{item.name}</span>
                      <b>{item.value.toLocaleString()}</b>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState text="No review items exist for the applied scope." />
            )}
          </div>
        </article>
      </section>

      <section className="chart-grid chart-grid--2">
        <article className="chart-card" data-testid="chart-wards-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">Geographic</div>
              <h3 className="chart-card__title">Features by Ward</h3>
            </div>
            <span className="chart-card__badge">{wardData.length} shown</span>
          </div>
          <div className="chart-card__body">
            {wardData.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={wardData} layout="vertical" margin={{ left: 30, right: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="ward" tick={{ fill: "var(--ink-dim)", fontSize: 11 }} axisLine={false} tickLine={false} width={90} />
                  <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                  <Bar dataKey="feature_count" name="Features" fill="var(--accent)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState text="No ward assignment exists for the applied scope." />
            )}
          </div>
        </article>

        <article className="chart-card" data-testid="chart-heatmap-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">Risk tiles</div>
              <h3 className="chart-card__title">Category Severity Overview</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {heatmapData.length > 0 ? (
              <div className="analytics-risk-grid">
                {heatmapData.map((item) => (
                  <div key={item.category} style={{ background: `${item.color}15`, borderColor: `${item.color}55` }}>
                    <span title={item.category}>{item.category}</span>
                    <strong style={{ color: item.color }}>{item.avgSeverity.toFixed(2)}</strong>
                    <small>{item.severityLevel} · {item.count.toLocaleString()} features</small>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState text="No category severity data exists for the applied scope." />
            )}
          </div>
        </article>
      </section>

      <section className="chart-card" data-testid="chart-insights-card">
        <div className="chart-card__header">
          <div>
            <div className="analytics-card-eyebrow">Summary</div>
            <h3 className="chart-card__title">Verified Scope Highlights</h3>
          </div>
        </div>
        <div className="chart-card__body">
          <div className="analytics-insight-grid">
            <InsightCard title="Most Common Category" value={topCategories[0]?.category || "N/A"} subtitle={`${topCategories[0]?.count ?? 0} matching features`} color="var(--blue)" />
            <InsightCard title="Highest Coverage Ward" value={wardData[0]?.ward || "N/A"} subtitle={`${wardData[0]?.feature_count ?? 0} matching features`} color="var(--danger)" />
            <InsightCard title="Resolution Rate" value={healthScore == null ? "N/A" : `${healthScore}%`} subtitle={`${overview?.resolved_reviews ?? 0} of ${overview?.total_review_items ?? 0} resolved`} color="var(--ok)" />
            <InsightCard title="Urgent Attention" value={String(overview?.severity_breakdown.find((item) => item.bucket === "high")?.count ?? 0)} subtitle="High-severity features" color="var(--warn)" />
          </div>
        </div>
      </section>

      <section className="chart-grid chart-grid--2 analytics-spatial-grid">
        <AnalyticsCategoryMap datasetIds={appliedDatasetIds} categories={appliedCategories} />
        <AnalyticsFeatureTable datasetIds={appliedDatasetIds} categories={appliedCategories} />
      </section>

      {overview && overview.category_breakdown.length > 0 && (
        <section className="chart-card" data-testid="category-table-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">Detailed</div>
              <h3 className="chart-card__title">Complete Category Breakdown</h3>
            </div>
            <span className="chart-card__badge">{overview.category_breakdown.length} categories</span>
          </div>
          <div className="chart-card__body" style={{ padding: 0 }}>
            <div style={{ maxHeight: 440, overflowY: "auto" }}>
              <table className="cat-table">
                <thead className="analytics-sticky-head">
                  <tr>
                    <th style={{ width: 40 }} />
                    <th>Category</th>
                    <th style={{ textAlign: "right" }}>Count</th>
                    <th style={{ textAlign: "right" }}>% of Scope</th>
                    <th style={{ textAlign: "right" }}>Avg Severity</th>
                    <th style={{ width: 180 }}>Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.category_breakdown.map((row) => {
                    const percentage = totalCategoryCount > 0 ? (row.count / totalCategoryCount) * 100 : 0;
                    return (
                      <tr key={row.category}>
                        <td><span className="cat-dot" style={{ background: colorForCategory(row.category) }} /></td>
                        <td className="cat-name">{row.category}</td>
                        <td className="cat-count" style={{ textAlign: "right" }}>{formatNum(row.count)}</td>
                        <td className="cat-pct" style={{ textAlign: "right" }}>{percentage.toFixed(1)}%</td>
                        <td className="cat-pct" style={{ textAlign: "right" }}>{row.avg_severity.toFixed(2)}</td>
                        <td>
                          <div className="analytics-distribution-track">
                            <div style={{ width: `${percentage}%`, background: colorForCategory(row.category) }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {appliedDatasetIds.length > 0 && (
        <section className="chart-card analytics-ai-card" data-testid="manhole-plan-section">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">Planning</div>
              <h3 className="chart-card__title">AI Manhole Plan</h3>
            </div>
          </div>
          <div className="chart-card__body">
            <p className="analytics-ai-card__note">
              AI-driven rehabilitation for the applied scope: all disconnected and blocked/bad-condition manholes are surfaced with exact road-routed pipe routes and GeoJSON export.
            </p>
            {appliedDatasetIds.map((datasetId) => {
              const datasetName = datasets.find((d) => d.id === datasetId)?.name ?? datasetId;
              return (
                <div key={datasetId} style={{ marginTop: 24, borderTop: "1px solid var(--edge)", paddingTop: 24 }}>
                  <div style={{ fontWeight: 600, marginBottom: 12 }}>{datasetName} – Manhole Plan</div>
                  <ManholePlanPanel datasetId={datasetId} />
                </div>
              );
            })}
          </div>
        </section>
      )}

      <AnalyticsAiSummary datasetIds={appliedDatasetIds} categories={appliedCategories} />
    </div>
  );
}

interface ManholePlanPanelProps {
  datasetId: string;
}

function ManholePlanPanel({ datasetId }: ManholePlanPanelProps) {
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const answer = await aiManholeRecommend({ mode: "area", dataset_id: datasetId });
      setAnswer(answer);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="analytics-ai-card__button"
        style={{ marginBottom: open ? 16 : 0, width: "fit-content" }}
        onClick={() => {
          if (!open && !answer) void load();
          setOpen((v) => !v);
        }}
        disabled={loading}
      >
        {loading ? "Planning…" : open ? "Hide Plan" : "Generate AI Manhole Plan"}
      </button>

      {open && (
        <>
          {loading && <div className="analytics-ai-card__loading">Analyzing manhole and drain network…</div>}
          {error && <div className="analytics-inline-error">Failed to load manhole plan: {error}</div>}
          {answer && <ManholeRecommendCard answer={answer} loading={false} error={null} onClose={() => setOpen(false)} />}
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value, icon, tone, accent, testid }: {
  label: string;
  value: number | string | undefined;
  icon: string;
  tone?: "ok" | "warn" | "danger" | "info";
  accent?: boolean;
  testid: string;
}) {
  const iconMap: Record<string, string> = {
    dataset: "M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4",
    map: "M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7",
    alert: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
    check: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    health: "M13 10V3L4 14h7v7l9-11h-7z",
    severity: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  };
  return (
    <div className={`kpi-card${tone ? ` kpi-card--${tone}` : ""}${accent ? " kpi-card--accent" : ""}`} data-testid={testid}>
      <div className="kpi-card__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="22" height="22">
          <path strokeLinecap="round" strokeLinejoin="round" d={iconMap[icon] || iconMap.dataset} />
        </svg>
      </div>
      <div>
        <div className="kpi-card__value">{typeof value === "number" ? formatNum(value) : value ?? "—"}</div>
        <div className="kpi-card__label">{label}</div>
      </div>
    </div>
  );
}

function InsightCard({ title, value, subtitle, color }: { title: string; value: string; subtitle: string; color: string }) {
  return (
    <div className="analytics-insight-card" style={{ borderLeftColor: color }}>
      <div>{title}</div>
      <strong>{value}</strong>
      <span>{subtitle}</span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="chart-empty">
      <svg className="chart-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <p>{text}</p>
    </div>
  );
}
