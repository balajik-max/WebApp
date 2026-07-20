import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type AnalyticsCrossFilters,
  type AnalyticsOverview,
  type AnalyticsSeverityBucket,
  type CategoryOption,
  type DatasetRow,
  type IngestionTrendPoint,
  type ManholeReadinessFieldKey,
  type ManholeReadinessStatus,
} from "../lib/workflow";
import { colorForCategory } from "../lib/categoryColors";
import { AnalyticsScopeBar } from "../components/analytics/AnalyticsScopeBar";
import { AnalyticsCategoryMap } from "../components/analytics/AnalyticsCategoryMap";
import { AnalyticsFeatureTable } from "../components/analytics/AnalyticsFeatureTable";
import { AnalyticsAiSummary } from "../components/analytics/AnalyticsAiSummary";
import { AnalyticsQualityPanel } from "../components/analytics/AnalyticsQualityPanel";
import { AnalyticsExportPanel } from "../components/analytics/AnalyticsExportPanel";
import { AnalyticsManholeReadiness } from "../components/analytics/AnalyticsManholeReadiness";
import { AnalyticsSeverityVisualization } from "../components/analytics/AnalyticsSeverityVisualization";
import { AnalyticsWaterDemandPanel } from "../components/analytics/AnalyticsWaterDemandPanel";
import { useLanguage } from "../context/LanguageContext";

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
const MANHOLE_READINESS_LABELS: Record<ManholeReadinessFieldKey, string> = {
  depth: "analytics.readinessDepth",
  bottom_level: "analytics.readinessBottomLevel",
  top_level: "analytics.readinessTopLevel",
  condition: "analytics.readinessCondition",
  pipe_type: "analytics.readinessPipeType",
  diameter: "analytics.readinessDiameter",
  image_reference: "analytics.readinessImageReference",
};
const MANHOLE_READINESS_KEYS = new Set(Object.keys(MANHOLE_READINESS_LABELS));

function formatNum(value: number | undefined): string {
  return value == null ? "—" : value.toLocaleString();
}

function stableValues(values: string[]) {
  return [...new Set(values)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );
}

function sameValues(a: string[], b: string[]) {
  return stableValues(a).join("\u0000") === stableValues(b).join("\u0000");
}

interface StoredAnalyticsScope {
  draftDatasetIds: string[];
  appliedDatasetIds: string[];
  activeCategory: string | null;
  activeWard: string | null;
  activeSeverityBucket: AnalyticsSeverityBucket | null;
  activeReadinessField: ManholeReadinessFieldKey | null;
  activeReadinessStatus: ManholeReadinessStatus | null;
  /** Phase 4 persisted key retained for one-time migration. */
  activeMissingField?: ManholeReadinessFieldKey | null;
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
      appliedDatasetIds: stringArray(parsed.appliedDatasetIds),
      activeCategory: typeof parsed.activeCategory === "string" ? parsed.activeCategory : null,
      activeWard: typeof parsed.activeWard === "string" ? parsed.activeWard : null,
      activeSeverityBucket:
        parsed.activeSeverityBucket === "low" ||
        parsed.activeSeverityBucket === "medium" ||
        parsed.activeSeverityBucket === "high"
          ? parsed.activeSeverityBucket
          : null,
      activeReadinessField:
        typeof parsed.activeReadinessField === "string" &&
        MANHOLE_READINESS_KEYS.has(parsed.activeReadinessField)
          ? parsed.activeReadinessField as ManholeReadinessFieldKey
          : typeof parsed.activeMissingField === "string" &&
              MANHOLE_READINESS_KEYS.has(parsed.activeMissingField)
            ? parsed.activeMissingField as ManholeReadinessFieldKey
            : null,
      activeReadinessStatus:
        parsed.activeReadinessStatus === "all" ||
        parsed.activeReadinessStatus === "available" ||
        parsed.activeReadinessStatus === "missing"
          ? parsed.activeReadinessStatus
          : parsed.activeMissingField
            ? "missing"
            : null,
    };
  } catch {
    const datasets = stableValues(fallbackDatasetIds);
    return {
      draftDatasetIds: datasets,
      appliedDatasetIds: datasets,
      activeCategory: null,
      activeWard: null,
      activeSeverityBucket: null,
      activeReadinessField: null,
      activeReadinessStatus: null,
    };
  }
}

interface LayoutCtx {
  selectedDatasets: DatasetRow[];
}

export function AnalyticsView() {
  const { t } = useLanguage();
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
  const [appliedDatasetIds, setAppliedDatasetIds] = useState<string[]>(initialScope.appliedDatasetIds);
  const [activeCategory, setActiveCategory] = useState<string | null>(initialScope.activeCategory);
  const [activeWard, setActiveWard] = useState<string | null>(initialScope.activeWard);
  const [activeSeverityBucket, setActiveSeverityBucket] = useState<AnalyticsSeverityBucket | null>(
    initialScope.activeSeverityBucket
  );
  const [activeReadinessField, setActiveReadinessField] = useState<ManholeReadinessFieldKey | null>(
    initialScope.activeReadinessField
  );
  const [activeReadinessStatus, setActiveReadinessStatus] = useState<ManholeReadinessStatus | null>(
    initialScope.activeReadinessStatus
  );
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loadingDatasets, setLoadingDatasets] = useState(true);
  const [analyzing, setAnalyzing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analysisVersion, setAnalysisVersion] = useState(0);
  const spatialSectionRef = useRef<HTMLElement | null>(null);

  const draftDatasetKey = useMemo(
    () => stableValues(draftDatasetIds).join(","),
    [draftDatasetIds]
  );
  const effectiveCategories = useMemo(
    () => activeCategory ? [activeCategory] : [],
    [activeCategory]
  );
  const effectiveSeverityBuckets = useMemo<AnalyticsSeverityBucket[]>(
    () => activeSeverityBucket ? [activeSeverityBucket] : [],
    [activeSeverityBucket]
  );
  const crossFilters = useMemo<AnalyticsCrossFilters>(
    () => ({
      wards: activeWard ? [activeWard] : [],
      severityBuckets: effectiveSeverityBuckets,
      readinessField: activeReadinessField,
      readinessStatus: activeReadinessStatus,
    }),
    [activeReadinessField, activeReadinessStatus, activeWard, effectiveSeverityBuckets]
  );
  const appliedScopeKey = useMemo(
    () => JSON.stringify({
      datasetIds: stableValues(appliedDatasetIds),
      categories: stableValues(effectiveCategories),
      ward: activeWard,
      severity: activeSeverityBucket,
      readinessField: activeReadinessField,
      readinessStatus: activeReadinessStatus,
    }),
    [activeReadinessField, activeReadinessStatus, activeSeverityBucket, activeWard, appliedDatasetIds, effectiveCategories]
  );
  const scopeDirty = !sameValues(draftDatasetIds, appliedDatasetIds);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        ANALYTICS_SCOPE_STORAGE_KEY,
        JSON.stringify({
          draftDatasetIds: stableValues(draftDatasetIds),
          appliedDatasetIds: stableValues(appliedDatasetIds),
          activeCategory,
          activeWard,
          activeSeverityBucket,
          activeReadinessField,
          activeReadinessStatus,
        } satisfies StoredAnalyticsScope)
      );
    } catch {
      // Storage can be disabled by browser policy. In that case the page
      // continues to work normally for the current mounted session.
    }
  }, [
    activeReadinessField,
    activeReadinessStatus,
    activeCategory,
    activeSeverityBucket,
    activeWard,
    appliedDatasetIds,
    draftDatasetIds,
  ]);

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
    fetchCategories(undefined, controller.signal, draftDatasetIds)
      .then(setCategoryOptions)
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(`Category list unavailable: ${caught.message}`);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftDatasetKey]);

  useEffect(() => {
    const controller = new AbortController();
    setAnalyzing(true);
    setError(null);
    fetchOverview(appliedDatasetIds, effectiveCategories, controller.signal, crossFilters)
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
    setActiveCategory(null);
    setActiveWard(null);
    setActiveSeverityBucket(null);
    setActiveReadinessField(null);
    setActiveReadinessStatus(null);
    setAnalysisVersion((value) => value + 1);
  }

  const toggleCategoryFilter = useCallback((category: string) => {
    setActiveReadinessField(null);
    setActiveReadinessStatus(null);
    setActiveCategory((current) => current === category ? null : category);
  }, []);

  const toggleWardFilter = useCallback((ward: string) => {
    setActiveWard((current) => current === ward ? null : ward);
  }, []);

  const toggleSeverityFilter = useCallback((bucket: AnalyticsSeverityBucket) => {
    setActiveSeverityBucket((current) => current === bucket ? null : bucket);
  }, []);

  const selectManholeReadiness = useCallback((
    field: ManholeReadinessFieldKey,
    _label: string,
    status: ManholeReadinessStatus
  ) => {
    const manholeCategory =
      categoryOptions.find((option) => option.category.trim().toLowerCase() === "manhole")
        ?.category ?? t("analytics.manhole");
    setActiveCategory(manholeCategory);
    setActiveReadinessField(field);
    setActiveReadinessStatus(status);
    window.requestAnimationFrame(() => {
      spatialSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [categoryOptions]);

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

  // Auto-select the first ward if exactly one exists and none is selected
  useEffect(() => {
    if (overview?.ward_breakdown?.length === 1 && activeWard == null) {
      setActiveWard(overview.ward_breakdown[0].ward);
    }
  }, [overview?.ward_breakdown, activeWard]);

  const heatmapData = useMemo(() => {
    if (!overview) return [];
    return overview.category_breakdown.slice(0, 8).map((category) => ({
      category: category.category,
      count: category.count,
      avgSeverity: category.avg_severity,
      severityLevel:
        category.avg_severity >= 0.67
          ? t("analytics.severityHigh")
          : category.avg_severity >= 0.34
            ? t("analytics.severityMedium")
            : t("analytics.severityLow"),
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
      <div className="analytics-page__top">
        <header className="analytics-page__intro">
          <h1 className="analytics-page__intro-title">Dataset & Category Insights</h1>
          <p className="analytics-page__intro-subtitle">Analytics for good understandings</p>
        </header>

        <section className="kpi-grid" data-testid="kpi-grid">
          <KpiCard label="Contributing Surveys" value={overview?.total_datasets} icon="dataset" testid="kpi-total-surveys" />
          <KpiCard label="Features Mapped" value={overview?.total_features} icon="map" tone="info" testid="kpi-features" />
          <KpiCard label="Health Score" value={healthScore == null ? "N/A" : `${healthScore}%`} icon="health" accent testid="kpi-health" />
          <KpiCard label="Avg Severity" value={overview ? overview.average_severity.toFixed(2) : undefined} icon="severity" testid="kpi-severity" />
        </section>
      </div>

      <AnalyticsScopeBar
        datasets={datasets}
        draftDatasetIds={draftDatasetIds}
        appliedDatasetIds={appliedDatasetIds}
        loadingDatasets={loadingDatasets}
        analyzing={analyzing}
        onDatasetChange={setDraftDatasetIds}
        onAnalyze={analyze}
      />

      {error && <div className="analytics-page__error">{error}</div>}
      {analyzing && <div className="analytics-page__loading">Calculating the applied scope from PostGIS…</div>}

      <section className="chart-grid chart-grid--2">
        <article className="chart-card" data-testid="chart-trend-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">{t("analytics.trend")}</div>
              <h3 className="chart-card__title">{t("analytics.scopeGrowth")}</h3>
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
              <EmptyState text={t("analytics.emptyIngestion")} />
            )}
          </div>
        </article>

        <article className="chart-card" data-testid="chart-categories-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">{t("analytics.breakdown")}</div>
              <h3 className="chart-card__title">{t("analytics.topCategories")}</h3>
            </div>
            <span className="chart-card__badge">
              {topCategories.length} {t("analytics.of")} {overview?.category_breakdown.length ?? 0}
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
                     <Bar dataKey="count" name={t("analytics.features")} radius={[0, 6, 6, 0]}>
                      {topCategories.map((category) => (
                        <Cell
                          key={category.category}
                          fill={colorForCategory(category.category)}
                          className="analytics-clickable-chart-item"
                          onClick={() => toggleCategoryFilter(category.category)}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState text={t("analytics.emptyCategory")} />
            )}
          </div>
        </article>
      </section>

      <section className="chart-grid chart-grid--2">
        <article className="chart-card" data-testid="chart-severity-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">{t("analytics.priorityOverview")}</div>
              <h3 className="chart-card__title">{t("analytics.featuresBySeverity")}</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {totalSeverity > 0 ? (
              <AnalyticsSeverityVisualization
                data={severityData}
                activeBucket={activeSeverityBucket}
                onToggleBucket={toggleSeverityFilter}
              />
            ) : (
              <EmptyState text={t("analytics.emptySeverity")} />
            )}
          </div>
        </article>

        <article className="chart-card" data-testid="chart-status-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">{t("analytics.status")}</div>
              <h3 className="chart-card__title">{t("analytics.reviewProgress")}</h3>
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
                    <span>{t("analytics.total")}</span>
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
              <EmptyState text={t("analytics.emptyReview")} />
            )}
          </div>
        </article>
      </section>

      <section className="chart-grid chart-grid--2">
        <article className="chart-card" data-testid="chart-wards-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">{t("analytics.geographic")}</div>
              <h3 className="chart-card__title">{t("analytics.featuresByWard")}</h3>
            </div>
            <span className="chart-card__badge">{wardData.length} {t("analytics.shown")}</span>
          </div>
          <div className="chart-card__body">
            {wardData.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={wardData} layout="vertical" margin={{ left: 30, right: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="ward" tick={{ fill: "var(--ink-dim)", fontSize: 11 }} axisLine={false} tickLine={false} width={90} />
                  <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                   <Bar dataKey="feature_count" name={t("analytics.features")} fill="var(--accent)" radius={[0, 6, 6, 0]}>
                    {wardData.map((item) => (
                      <Cell
                        key={item.ward}
                        className="analytics-clickable-chart-item"
                        onClick={() => toggleWardFilter(item.ward)}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState text={t("analytics.emptyWard")} />
            )}
          </div>
        </article>

        <article className="chart-card" data-testid="chart-heatmap-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">{t("analytics.riskTiles")}</div>
              <h3 className="chart-card__title">{t("analytics.categorySeverity")}</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {heatmapData.length > 0 ? (
              <div className="analytics-risk-grid">
                {heatmapData.map((item) => (
                  <button
                    type="button"
                    key={item.category}
                    style={{ background: `${item.color}15`, borderColor: `${item.color}55` }}
                    onClick={() => toggleCategoryFilter(item.category)}
                  >
                    <span title={item.category}>{item.category}</span>
                    <strong style={{ color: item.color }}>{item.avgSeverity.toFixed(2)}</strong>
                    <small>{item.severityLevel} · {item.count.toLocaleString()} {t("analytics.features")}</small>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState text={t("analytics.emptyCategorySeverity")} />
            )}
          </div>
        </article>
      </section>

      <section className="chart-card" data-testid="chart-insights-card">
        <div className="chart-card__header">
          <div>
              <div className="analytics-card-eyebrow">{t("analytics.summary")}</div>
              <h3 className="chart-card__title">{t("analytics.verifiedScope")}</h3>
            </div>
          </div>
          <div className="analytics-insight-grid">
            <InsightCard title={t("analytics.insightMostCommon")} value={topCategories[0]?.category || t("analytics.na")} subtitle={`${topCategories[0]?.count ?? 0} ${t("analytics.matchingFeatures")}`} color="var(--blue)" />
            <InsightCard title={t("analytics.insightHighestWard")} value={wardData[0]?.ward || t("analytics.na")} subtitle={`${wardData[0]?.feature_count ?? 0} ${t("analytics.matchingFeatures")}`} color="var(--danger)" />
            <InsightCard title={t("analytics.insightResolutionRate")} value={healthScore == null ? t("analytics.na") : `${healthScore}%`} subtitle={`${overview?.resolved_reviews ?? 0} ${t("analytics.of")} ${overview?.total_review_items ?? 0} resolved`} color="var(--ok)" />
            <InsightCard title={t("analytics.insightUrgent")} value={String(overview?.severity_breakdown.find((item) => item.bucket === "high")?.count ?? 0)} subtitle={t("analytics.highSeverityFeatures")} color="var(--warn)" />
          </div>
      </section>

      <AnalyticsManholeReadiness
        datasetIds={appliedDatasetIds}
        filters={{
          wards: activeWard ? [activeWard] : [],
          severityBuckets: effectiveSeverityBuckets,
        }}
        activeField={activeReadinessField}
        activeStatus={activeReadinessStatus}
        onSelect={selectManholeReadiness}
        onClear={() => {
          setActiveReadinessField(null);
          setActiveReadinessStatus(null);
        }}
      />

      <AnalyticsWaterDemandPanel datasetIds={appliedDatasetIds} ward={activeWard} />

      <section ref={spatialSectionRef} className="chart-grid chart-grid--2 analytics-spatial-grid">
        <AnalyticsCategoryMap
          datasetIds={appliedDatasetIds}
          categories={effectiveCategories}
          filters={crossFilters}
          onCategoryFilter={toggleCategoryFilter}
        />
        <AnalyticsFeatureTable
          datasetIds={appliedDatasetIds}
          categories={effectiveCategories}
          filters={crossFilters}
        />
      </section>

      <AnalyticsQualityPanel
        datasetIds={appliedDatasetIds}
        categories={effectiveCategories}
        filters={crossFilters}
        onCategoryFilter={toggleCategoryFilter}
      />

      <AnalyticsExportPanel
        datasetIds={appliedDatasetIds}
        categories={effectiveCategories}
        filters={crossFilters}
        disabledReason={scopeDirty ? t("analytics.exportDisabled") : null}
      />

      {overview && overview.category_breakdown.length > 0 && (
        <section className="chart-card" data-testid="category-table-card">
          <div className="chart-card__header">
            <div>
              <div className="analytics-card-eyebrow">{t("analytics.detailed")}</div>
              <h3 className="chart-card__title">{t("analytics.categoryBreakdown")}</h3>
            </div>
            <span className="chart-card__badge">{overview.category_breakdown.length} {t("analytics.categoriesCount")}</span>
          </div>
          <div className="chart-card__body" style={{ padding: 0 }}>
            <div style={{ maxHeight: 440, overflowY: "auto" }}>
              <table className="cat-table">
                <thead className="analytics-sticky-head">
                  <tr>
                    <th style={{ width: 40 }} />
                    <th>{t("analytics.colCategory")}</th>
                    <th style={{ textAlign: "right" }}>{t("analytics.colCount")}</th>
                    <th style={{ textAlign: "right" }}>{t("analytics.colPctOfScope")}</th>
                    <th style={{ textAlign: "right" }}>{t("analytics.colAvgSeverity")}</th>
                    <th style={{ width: 180 }}>{t("analytics.colDistribution")}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.category_breakdown.map((row) => {
                    const percentage = totalCategoryCount > 0 ? (row.count / totalCategoryCount) * 100 : 0;
                    return (
                      <tr
                        key={row.category}
                        className="analytics-clickable-row"
                        role="button"
                        tabIndex={0}
                        aria-pressed={activeCategory === row.category}
                        onClick={() => toggleCategoryFilter(row.category)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleCategoryFilter(row.category);
                          }
                        }}
                      >
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

      <AnalyticsAiSummary
        datasetIds={appliedDatasetIds}
        datasetNames={appliedDatasetNames}
        categories={effectiveCategories}
        ward={activeWard}
        severityBuckets={effectiveSeverityBuckets}
        disabledReason={
          scopeDirty
            ? t("analytics.aiSummaryDisabled")
            : activeReadinessField
              ? t("analytics.aiSummaryDisabledReadiness")
              : null
        }
      />
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
