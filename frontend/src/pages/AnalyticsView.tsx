import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  BarChart, Bar, Cell, Legend, PieChart, Pie, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, AreaChart, Area,
} from "recharts";
import { fetchOverview, type AnalyticsOverview, type IngestionTrendPoint, type DatasetRow } from "../lib/workflow";
import { colorForCategory } from "../lib/categoryColors";

const STATUS_COLORS: Record<string, string> = { open: "#3b82f6", reviewing: "#f59e0b", in_progress: "#a855f7", blocked: "#6b7280", resolved: "#22c55e", rejected: "#ef4444" };
const SEVERITY_COLORS: Record<string, string> = { low: "#22c55e", medium: "#f59e0b", high: "#ef4444" };
const CATEGORY_PIE_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#8b5cf6", "#eab308", "#6366f1", "#10b981", "#f43f5e", "#84cc16", "#0ea5e9", "#d946ef", "#facc15", "#2dd4bf", "#fb923c"];

function formatNum(n: number | undefined): string { if (n == null) return "\u2014"; return n.toLocaleString(); }

interface LayoutCtx {
  selectedDatasets: DatasetRow[];
  setSelectedDatasets: (rows: DatasetRow[]) => void;
}

export function AnalyticsView() {
  const { selectedDatasets, setSelectedDatasets } = useOutletContext<LayoutCtx>();
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const datasetIds = useMemo(() => selectedDatasets.map((d) => d.id), [selectedDatasets]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchOverview(datasetIds, ctrl.signal).then(setOverview).catch((e: Error) => { if (e.name !== "AbortError") setError(e.message); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetIds.join(",")]);

  const totalSeverity = overview ? overview.severity_breakdown.reduce((s, b) => s + b.count, 0) : 0;
  const totalCategoryCount = useMemo(() => overview ? overview.category_breakdown.reduce((s, c) => s + c.count, 0) : 0, [overview]);
  const avgSeverity = totalCategoryCount > 0 ? (overview!.category_breakdown.reduce((s, c) => s + c.avg_severity * c.count, 0) / totalCategoryCount) : 0;
  const healthScore = overview && overview.total_features > 0 ? Math.round(((overview.resolved_reviews || 0) / Math.max(overview.total_review_items, 1)) * 100) : 0;

  const severityData = overview ? overview.severity_breakdown.map(s => ({
    name: s.bucket.charAt(0).toUpperCase() + s.bucket.slice(1),
    value: s.count,
    color: SEVERITY_COLORS[s.bucket] || "#6b7280",
    percentage: totalSeverity > 0 ? ((s.count / totalSeverity) * 100).toFixed(1) : "0",
  })) : [];

  const topCategories = overview ? overview.category_breakdown.slice(0, 10) : [];
  const wardData = overview ? [...overview.ward_breakdown].sort((a, b) => b.feature_count - a.feature_count).slice(0, 8) : [];

  // Prepare heatmap data: category vs ward
  const heatmapData = useMemo(() => {
    if (!overview) return [];
    // Create a simple heatmap showing category severity distribution
    return overview.category_breakdown.slice(0, 8).map(cat => ({
      category: cat.category,
      count: cat.count,
      avgSeverity: cat.avg_severity,
      severityLevel: cat.avg_severity >= 0.67 ? "High" : cat.avg_severity >= 0.34 ? "Medium" : "Low",
      color: cat.avg_severity >= 0.67 ? "#ef4444" : cat.avg_severity >= 0.34 ? "#f59e0b" : "#22c55e",
    }));
  }, [overview]);

  // Real ingestion growth — each point is an actual day features were
  // added, from their real created_at timestamps (never simulated).
  const trendData = useMemo(() => {
    if (!overview) return [];
    return overview.ingestion_trend.map((p: IngestionTrendPoint) => ({
      date: p.date,
      cumulative: p.cumulative_features,
      added: p.features_added,
    }));
  }, [overview]);

  // Review status data
  const reviewStatusData = useMemo(() => {
    if (!overview) return [];
    return overview.status_breakdown.map(s => ({
      name: s.status.charAt(0).toUpperCase() + s.status.slice(1).replace("_", " "),
      value: s.count,
      color: STATUS_COLORS[s.status] || "#6b7280",
    }));
  }, [overview]);

  return (
    <div className="analytics-page" data-testid="analytics-page">
      <header className="analytics-page__head">
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 4 }}>Analytics</div>
          <h2 className="page-title" style={{ fontSize: 24, marginBottom: 4 }}>Municipal Performance Overview</h2>
          <p className="page-sub">
            {selectedDatasets.length > 0
              ? `Scoped to ${selectedDatasets.length} selected dataset${selectedDatasets.length === 1 ? "" : "s"} — every figure below reflects only ${selectedDatasets.length === 1 ? "it" : "these"}.`
              : "Real-time metrics across wards, categories, and resolution SLAs."}
          </p>
        </div>
        {overview && (
          <span className="page-timestamp" data-testid="analytics-timestamp">
            generated {new Date(overview.generated_at).toLocaleString()}
          </span>
        )}
      </header>

      {selectedDatasets.length > 0 && (
        <div
          data-testid="analytics-dataset-scope"
          style={{
            display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 16,
            padding: "10px 14px", background: "var(--accent-muted)", border: "1px solid var(--accent)",
            borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--accent)",
          }}
        >
          <b>Analyzing:</b>
          {selectedDatasets.map((d) => (
            <span key={d.id} style={{ padding: "2px 8px", background: "var(--surface)", borderRadius: "var(--radius-full)" }}>
              {d.name}
            </span>
          ))}
          <button
            type="button"
            onClick={() => setSelectedDatasets([])}
            data-testid="analytics-clear-scope"
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--accent)", fontWeight: 700, cursor: "pointer", fontSize: 11, textTransform: "uppercase" as const }}
          >
            Show all datasets ✕
          </button>
        </div>
      )}

      {error && (
        <div className="analytics-page__error" data-testid="analytics-page-error">Live analytics unavailable: {error}</div>
      )}

      {/* KPI Cards */}
      <section className="kpi-grid" data-testid="kpi-grid">
        <KpiCard label="Total Surveys" value={overview?.total_datasets} icon="dataset" testid="kpi-total-surveys" />
        <KpiCard label="Features Mapped" value={overview?.total_features} icon="map" tone="info" testid="kpi-features" />
        <KpiCard label="Issues Found" value={overview?.total_review_items} icon="alert" tone="warn" testid="kpi-issues" />
        <KpiCard label="Open Reviews" value={overview?.open_reviews} icon="alert" tone="warn" testid="kpi-open-reviews" />
        <KpiCard label="Resolved" value={overview?.resolved_reviews} icon="check" tone="ok" testid="kpi-resolved" />
        <KpiCard label="Health Score" value={`${healthScore}%`} icon="health" accent testid="kpi-health" />
        <KpiCard label="Avg Severity" value={avgSeverity.toFixed(1)} icon="severity" testid="kpi-severity" />
      </section>

      {/* Row 1: Trend Line Chart + Category Pie */}
      <section className="chart-grid chart-grid--2">
        {/* Trend Line Chart - real ingestion growth, from actual created_at timestamps */}
        <article className="chart-card" data-testid="chart-trend-card">
          <div className="chart-card__header">
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 2 }}>Trend</div>
              <h3 className="chart-card__title">Survey Coverage Growth</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorCumulative" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "var(--ink-mute)" }} />
                  <Area type="monotone" dataKey="cumulative" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorCumulative)" name="Total features surveyed" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState text="No ingestion history yet — upload a dataset to start the trend." />
            )}
          </div>
        </article>

        {/* Category Pie Chart */}
        <article className="chart-card" data-testid="chart-categories-card">
          <div className="chart-card__header">
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 2 }}>Breakdown</div>
              <h3 className="chart-card__title">Top Issue Categories</h3>
            </div>
            <span className="chart-card__badge">{topCategories.length} types</span>
          </div>
          <div className="chart-card__body">
            {overview && topCategories.length > 0 ? (
              <div style={{ display: "flex", gap: 20 }}>
                <div style={{ flex: 1 }}>
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={topCategories} dataKey="count" nameKey="category" cx="50%" cy="50%" outerRadius={100} innerRadius={50} stroke="var(--surface)" strokeWidth={2} paddingAngle={1}>
                        {topCategories.map((_, i) => (<Cell key={i} fill={CATEGORY_PIE_COLORS[i % CATEGORY_PIE_COLORS.length]} />))}
                      </Pie>
                      <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ width: 180, maxHeight: 240, overflowY: "auto" }}>
                  {topCategories.map((row, i) => {
                    const pct = totalCategoryCount > 0 ? ((row.count / totalCategoryCount) * 100) : 0;
                    const color = CATEGORY_PIE_COLORS[i % CATEGORY_PIE_COLORS.length];
                    return (
                      <div key={row.category} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--edge)" }}>
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: 11, color: "var(--ink-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.category}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{row.count}</span>
                        <span style={{ fontSize: 10, color: "var(--ink-mute)", width: 36, textAlign: "right" }}>{pct.toFixed(0)}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <EmptyState text="No category data yet." />
            )}
          </div>
        </article>
      </section>

      {/* Row 2: Severity Distribution + Review Status */}
      <section className="chart-grid chart-grid--2">
        {/* Severity Distribution */}
        <article className="chart-card" data-testid="chart-severity-card">
          <div className="chart-card__header">
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 2 }}>Priority Overview</div>
              <h3 className="chart-card__title">Issues by Severity Level</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {overview && totalSeverity > 0 ? (
              <div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={severityData} layout="vertical" margin={{ left: 20, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: "var(--ink-dim)", fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false} width={80} />
                    <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                      {severityData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 12 }}>
                  {severityData.map((s) => (
                    <div key={s.name} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: s.color, fontFamily: "var(--font-mono)" }}>{s.value}</div>
                      <div style={{ fontSize: 10, color: "var(--ink-mute)", textTransform: "uppercase" as const }}>{s.name} ({s.percentage}%)</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState text="No severity data yet." />
            )}
          </div>
        </article>

        {/* Review Status Donut */}
        <article className="chart-card" data-testid="chart-status-card">
          <div className="chart-card__header">
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 2 }}>Status</div>
              <h3 className="chart-card__title">Review Progress</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {reviewStatusData.length > 0 ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 30 }}>
                <div style={{ position: "relative" }}>
                  <ResponsiveContainer width={200} height={200}>
                    <PieChart>
                      <Pie data={reviewStatusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={90} stroke="var(--surface)" strokeWidth={3} paddingAngle={2}>
                        {reviewStatusData.map((entry, index) => (
                          <Cell key={`status-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", textAlign: "center" }}>
                    <div style={{ fontSize: 24, fontWeight: 800, color: "var(--ink)", fontFamily: "var(--font-mono)" }}>{overview?.total_review_items || 0}</div>
                    <div style={{ fontSize: 10, color: "var(--ink-mute)", textTransform: "uppercase" as const }}>Total</div>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {reviewStatusData.map((s) => (
                    <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: s.color }} />
                      <span style={{ fontSize: 11, color: "var(--ink-dim)", width: 80 }}>{s.name}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{s.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState text="No review data yet. Create reviews to track progress." />
            )}
          </div>
        </article>
      </section>

      {/* Row 3: Ward Distribution + Category Heatmap */}
      <section className="chart-grid chart-grid--2">
        {/* Ward Distribution */}
        <article className="chart-card" data-testid="chart-wards-card">
          <div className="chart-card__header">
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 2 }}>Geographic</div>
              <h3 className="chart-card__title">Issues by Ward (Area)</h3>
            </div>
            {wardData.length > 0 && (
              <span className="chart-card__badge">{wardData.length} ward{wardData.length === 1 ? "" : "s"}</span>
            )}
          </div>
          <div className="chart-card__body">
            {wardData.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={wardData} layout="vertical" margin={{ left: 30, right: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="ward" tick={{ fill: "var(--ink-dim)", fontSize: 11 }} axisLine={false} tickLine={false} width={80} />
                  <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} formatter={(value: number, name: string) => [`${value} issues`, name === "feature_count" ? "Total Issues" : name]} />
                  <Bar dataKey="feature_count" name="Total Issues" fill="var(--accent)" radius={[0, 6, 6, 0]}>
                    {wardData.map((_entry, index) => (
                      <Cell key={`ward-${index}`} fill={index < 3 ? "var(--danger)" : index < 6 ? "var(--warn)" : "var(--accent)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState text="No ward data available. Assign wards to datasets." />
            )}
          </div>
        </article>

        {/* Category Heatmap - Severity by Category */}
        <article className="chart-card" data-testid="chart-heatmap-card">
          <div className="chart-card__header">
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 2 }}>Heatmap</div>
              <h3 className="chart-card__title">Category Severity Heatmap</h3>
            </div>
          </div>
          <div className="chart-card__body">
            {heatmapData.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                {heatmapData.map((item) => (
                  <div
                    key={item.category}
                    style={{
                      padding: 12,
                      background: `${item.color}15`,
                      border: `2px solid ${item.color}40`,
                      borderRadius: "var(--radius-md)",
                      textAlign: "center",
                      transition: "all 0.2s ease",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {item.category}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: item.color, fontFamily: "var(--font-mono)" }}>
                      {item.avgSeverity.toFixed(2)}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--ink-mute)", textTransform: "uppercase" as const, marginTop: 2 }}>
                      {item.severityLevel} · {item.count} issues
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState text="No heatmap data available." />
            )}
          </div>
        </article>
      </section>

      {/* Row 4: Insights Summary */}
      <section className="chart-card" data-testid="chart-insights-card">
        <div className="chart-card__header">
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 2 }}>Summary</div>
            <h3 className="chart-card__title">Key Insights for Decision Making</h3>
          </div>
        </div>
        <div className="chart-card__body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
            <InsightCard 
              title="Most Common Issue"
              value={topCategories[0]?.category || "N/A"}
              subtitle={`${topCategories[0]?.count || 0} occurrences`}
              color="var(--blue)"
            />
            <InsightCard 
              title="Highest Risk Ward"
              value={wardData[0]?.ward || "N/A"}
              subtitle={`${wardData[0]?.feature_count || 0} issues`}
              color="var(--danger)"
            />
            <InsightCard 
              title="Resolution Rate"
              value={overview && overview.total_review_items > 0 
                ? `${((overview.resolved_reviews / overview.total_review_items) * 100).toFixed(0)}%`
                : "N/A"}
              subtitle={`${overview?.resolved_reviews || 0} of ${overview?.total_review_items || 0} resolved`}
              color="var(--ok)"
            />
            <InsightCard 
              title="Urgent Attention"
              value={overview ? String(overview.severity_breakdown.find(s => s.bucket === "high")?.count || 0) : "0"}
              subtitle="High severity issues"
              color="var(--warn)"
            />
          </div>
        </div>
      </section>

      {/* Row 5: Category Detail Table */}
      {overview && overview.category_breakdown.length > 0 && (
        <section className="chart-card" data-testid="category-table-card">
          <div className="chart-card__header">
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 2 }}>Detailed</div>
              <h3 className="chart-card__title">Complete Category Breakdown</h3>
            </div>
            <span className="chart-card__badge">{overview.category_breakdown.length} categories</span>
          </div>
          <div className="chart-card__body" style={{ padding: 0 }}>
            <div style={{ maxHeight: 400, overflowY: "auto" }}>
              <table className="cat-table">
                <thead style={{ position: "sticky", top: 0, background: "var(--surface)", zIndex: 1 }}>
                  <tr>
                    <th style={{ width: 40 }}></th>
                    <th>Category</th>
                    <th style={{ textAlign: "right" }}>Count</th>
                    <th style={{ textAlign: "right" }}>% of Total</th>
                    <th style={{ width: 150 }}>Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.category_breakdown.map((row, _i) => {
                    const pct = totalCategoryCount > 0 ? ((row.count / totalCategoryCount) * 100) : 0;
                    return (
                      <tr key={row.category}>
                        <td><span className="cat-dot" style={{ background: colorForCategory(row.category) }} /></td>
                        <td className="cat-name">{row.category}</td>
                        <td className="cat-count" style={{ textAlign: "right" }}>{formatNum(row.count)}</td>
                        <td className="cat-pct" style={{ textAlign: "right" }}>{pct.toFixed(1)}%</td>
                        <td>
                          <div style={{ height: 8, background: "var(--surface-3)", borderRadius: 4, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${pct}%`, background: colorForCategory(row.category), borderRadius: 4 }} />
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
    </div>
  );
}

function KpiCard({ label, value, icon, tone, accent, testid }: {
  label: string; value: number | string | undefined; icon: string; tone?: "ok" | "warn" | "danger" | "info"; accent?: boolean; testid: string;
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
        <div className="kpi-card__value">{typeof value === "number" ? formatNum(value) : value ?? "\u2014"}</div>
        <div className="kpi-card__label">{label}</div>
      </div>
    </div>
  );
}

function InsightCard({ title, value, subtitle, color }: { title: string; value: string; subtitle: string; color: string }) {
  return (
    <div style={{
      padding: 16, background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: "var(--radius-md)",
      borderLeft: `4px solid ${color}`,
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--ink-mute)", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: "var(--ink)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--ink-mute)" }}>{subtitle}</div>
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
