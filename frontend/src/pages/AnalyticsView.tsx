import { useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  Cell,
  Legend,
  PieChart,
  Pie,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { fetchOverview, type AnalyticsOverview, type CategoryBreakdown } from "../lib/workflow";
import { colorForCategory } from "../lib/categoryColors";

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

const CATEGORY_PIE_COLORS = [
  "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7",
  "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#8b5cf6",
  "#eab308", "#6366f1", "#10b981", "#f43f5e", "#84cc16",
  "#0ea5e9", "#d946ef", "#facc15", "#2dd4bf", "#fb923c",
];

function formatNum(n: number | undefined): string {
  if (n == null) return "\u2014";
  return n.toLocaleString();
}

export function AnalyticsView() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchOverview(ctrl.signal)
      .then(setOverview)
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, []);

  const totalSeverity = overview
    ? overview.severity_breakdown.reduce((s, b) => s + b.count, 0)
    : 0;

  const totalCategoryCount = useMemo(
    () => overview ? overview.category_breakdown.reduce((s, c) => s + c.count, 0) : 0,
    [overview],
  );

  return (
    <div className="analytics-page" data-testid="analytics-page">
      <header className="analytics-page__head">
        <div>
          <h2 className="page-title">Analytics & Reports</h2>
          <p className="page-sub">Live aggregates over your PostGIS survey data.</p>
        </div>
        {overview && (
          <span className="page-timestamp" data-testid="analytics-timestamp">
            generated {new Date(overview.generated_at).toLocaleString()}
          </span>
        )}
      </header>

      {error && (
        <div className="analytics-page__error" data-testid="analytics-page-error">
          Live analytics unavailable: {error}
        </div>
      )}

      {/* ── KPI Row ────────────────────────────────────────────── */}
      <section className="kpi-grid" data-testid="kpi-grid">
        <KpiCard icon={<KpiIcon shape="dataset" />} label="Total Surveys" value={overview?.total_datasets} testid="kpi-total-surveys" />
        <KpiCard icon={<KpiIcon shape="check" />} label="Ready" value={overview?.ready_datasets} tone="ok" testid="kpi-ready" />
        <KpiCard icon={<KpiIcon shape="gear" />} label="Processing" value={overview?.processing_datasets} tone="warn" testid="kpi-processing" />
        <KpiCard icon={<KpiIcon shape="alert" />} label="Failed" value={overview?.failed_datasets} tone="danger" testid="kpi-failed" />
        <KpiCard icon={<KpiIcon shape="pin" />} label="Total Features" value={overview?.total_features} accent testid="kpi-features" />
        <KpiCard icon={<KpiIcon shape="review" />} label="Review Items" value={overview?.total_review_items} testid="kpi-reviews" />
        <KpiCard icon={<KpiIcon shape="clock" />} label="Open Reviews" value={overview?.open_reviews} tone="warn" testid="kpi-open" />
        <KpiCard icon={<KpiIcon shape="check" />} label="Resolved" value={overview?.resolved_reviews} tone="ok" testid="kpi-resolved" />
      </section>

      {/* ── Summary Stats Row ──────────────────────────────────── */}
      {overview && (
        <section className="stats-row" data-testid="stats-row">
          <div className="stat-pill">
            <span className="stat-pill__icon" style={{ color: "#3b82f6" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </span>
            <span className="stat-pill__label">Avg Severity</span>
            <span className="stat-pill__value">
              {totalCategoryCount > 0
                ? (overview.category_breakdown.reduce((s, c) => s + c.avg_severity * c.count, 0) / totalCategoryCount).toFixed(2)
                : "—"}
            </span>
          </div>
          <div className="stat-pill">
            <span className="stat-pill__icon" style={{ color: "#22c55e" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22,4 12,14.01 9,11.01" /></svg>
            </span>
            <span className="stat-pill__label">Completion</span>
            <span className="stat-pill__value">
              {overview.total_datasets > 0
                ? `${((overview.ready_datasets / overview.total_datasets) * 100).toFixed(0)}%`
                : "—"}
            </span>
          </div>
          <div className="stat-pill">
            <span className="stat-pill__icon" style={{ color: "#f59e0b" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
            </span>
            <span className="stat-pill__label">Review Rate</span>
            <span className="stat-pill__value">
              {overview.total_features > 0
                ? `${((overview.total_review_items / overview.total_features) * 100).toFixed(1)}%`
                : "—"}
            </span>
          </div>
          <div className="stat-pill">
            <span className="stat-pill__icon" style={{ color: "#a855f7" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
            </span>
            <span className="stat-pill__label">Categories</span>
            <span className="stat-pill__value">{overview.category_breakdown.length}</span>
          </div>
          <div className="stat-pill">
            <span className="stat-pill__icon" style={{ color: "#06b6d4" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></svg>
            </span>
            <span className="stat-pill__label">Wards</span>
            <span className="stat-pill__value">{overview.ward_breakdown.length}</span>
          </div>
        </section>
      )}

      {/* ── Category Pie Chart ─────────────────────────────────── */}
      <article className="chart-card" data-testid="chart-categories-card">
        <div className="chart-card__header">
          <h3 className="chart-card__title">Anomalies by Category</h3>
          <span className="chart-card__badge">
            {overview ? overview.category_breakdown.length : 0} types
          </span>
        </div>
        <div className="chart-card__body chart-card__body--tall">
          {overview && overview.category_breakdown.length > 0 ? (
            <CategoryPie data={overview.category_breakdown} />
          ) : (
            <EmptyState text="Category breakdown will appear once features are ingested." />
          )}
        </div>
      </article>

      {/* ── Middle Row: Leaderboard + Heatmap + Ward ───────────── */}
      <section className="chart-grid chart-grid--3">
        {/* Top 5 Leaderboard */}
        <article className="chart-card" data-testid="chart-leaderboard-card">
          <div className="chart-card__header">
            <h3 className="chart-card__title">Top Categories</h3>
          </div>
          <div className="chart-card__body">
            {overview && overview.category_breakdown.length > 0 ? (
              <TopLeaderboard data={overview.category_breakdown.slice(0, 5)} total={totalCategoryCount} />
            ) : (
              <EmptyState text="No data yet." />
            )}
          </div>
        </article>

        {/* Category Severity Heatmap */}
        <article className="chart-card" data-testid="chart-heatmap-card">
          <div className="chart-card__header">
            <h3 className="chart-card__title">Severity by Category</h3>
          </div>
          <div className="chart-card__body">
            {overview && overview.category_breakdown.length > 0 ? (
              <SeverityHeatmap data={overview.category_breakdown.slice(0, 10)} />
            ) : (
              <EmptyState text="No severity data yet." />
            )}
          </div>
        </article>

        {/* Ward Feature Counts */}
        <article className="chart-card" data-testid="chart-wards-card">
          <div className="chart-card__header">
            <h3 className="chart-card__title">Ward Feature Counts</h3>
          </div>
          <div className="chart-card__body">
            {overview && overview.ward_breakdown.length > 0 ? (
              <WardBar data={overview.ward_breakdown} />
            ) : (
              <EmptyState text="No ward-tagged datasets yet." />
            )}
          </div>
        </article>
      </section>

      {/* ── Bottom Row: Severity + Review + Category Mini Bars ─── */}
      <section className="chart-grid chart-grid--3">
        {/* Severity donut */}
        <article className="chart-card" data-testid="chart-severity-card">
          <div className="chart-card__header">
            <h3 className="chart-card__title">Severity Distribution</h3>
          </div>
          <div className="chart-card__body">
            {overview && totalSeverity > 0 ? (
              <SeverityDonut data={overview.severity_breakdown} total={totalSeverity} />
            ) : (
              <EmptyState text="No severity data yet." />
            )}
          </div>
        </article>

        {/* Review status */}
        <article className="chart-card" data-testid="chart-status-card">
          <div className="chart-card__header">
            <h3 className="chart-card__title">Review Status</h3>
          </div>
          <div className="chart-card__body">
            {overview && overview.status_breakdown.length > 0 ? (
              <ReviewStatusPie data={overview.status_breakdown} />
            ) : (
              <EmptyState text="No review items yet." />
            )}
          </div>
        </article>

        {/* Category Mini Bars */}
        <article className="chart-card" data-testid="chart-catmini-card">
          <div className="chart-card__header">
            <h3 className="chart-card__title">Feature Volume</h3>
          </div>
          <div className="chart-card__body">
            {overview && overview.category_breakdown.length > 0 ? (
              <CategoryMiniBars data={overview.category_breakdown.slice(0, 8)} total={totalCategoryCount} />
            ) : (
              <EmptyState text="No data yet." />
            )}
          </div>
        </article>
      </section>

      {/* ── Category Detail Table ───────────────────────────────── */}
      {overview && overview.category_breakdown.length > 0 && (
        <section className="chart-card" data-testid="category-table-card">
          <div className="chart-card__header">
            <h3 className="chart-card__title">Category Detail</h3>
          </div>
          <div className="chart-card__body">
            <table className="cat-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Category</th>
                  <th>Count</th>
                  <th>Avg Severity</th>
                  <th>% of Total</th>
                </tr>
              </thead>
              <tbody>
                {overview.category_breakdown.map((row) => {
                  const pct = totalCategoryCount > 0 ? ((row.count / totalCategoryCount) * 100) : 0;
                  return (
                    <tr key={row.category}>
                      <td><span className="cat-dot" style={{ background: colorForCategory(row.category) }} /></td>
                      <td className="cat-name">{row.category}</td>
                      <td className="cat-count">{formatNum(row.count)}</td>
                      <td className="cat-sev"><SeverityBar value={row.avg_severity} /></td>
                      <td className="cat-pct">{pct.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

/* ═══════════════════════ Sub-components ═══════════════════════ */

function KpiCard({ icon, label, value, tone, accent, testid }: {
  icon: React.ReactNode; label: string; value: number | undefined;
  tone?: "ok" | "warn" | "danger"; accent?: boolean; testid: string;
}) {
  return (
    <div className={`kpi-card${tone ? ` kpi-card--${tone}` : ""}${accent ? " kpi-card--accent" : ""}`} data-testid={testid}>
      <div className="kpi-card__icon">{icon}</div>
      <div className="kpi-card__content">
        <div className="kpi-card__value">{formatNum(value)}</div>
        <div className="kpi-card__label">{label}</div>
      </div>
    </div>
  );
}

function KpiIcon({ shape }: { shape: string }) {
  const cls = "kpi-icon";
  const p = { className: cls, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor" };
  switch (shape) {
    case "dataset": return <svg {...p} strokeWidth="1.5"><ellipse cx="12" cy="6" rx="9" ry="3" /><path d="M3 6v6c0 1.66 4.03 3 9 3s9-1.34 9-3V6" /><path d="M3 12v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6" /></svg>;
    case "check": return <svg {...p} strokeWidth="2"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "gear": return <svg {...p} strokeWidth="1.5"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>;
    case "alert": return <svg {...p} strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" strokeLinecap="round" strokeLinejoin="round" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
    case "pin": return <svg {...p} strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></svg>;
    case "review": return <svg {...p} strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14,2 14,8 20,8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>;
    case "clock": return <svg {...p} strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>;
    default: return null;
  }
}

/* ── Category Pie Chart with external labels ───────────────────── */
function CategoryPie({ data }: { data: CategoryBreakdown[] }) {
  const pieData = data.map((d) => ({ ...d, name: d.category }));
  const total = pieData.reduce((s, d) => s + d.count, 0);
  return (
    <div className="category-pie-layout">
      <div className="category-pie-chart">
        <ResponsiveContainer width="100%" height={320}>
          <PieChart>
            <Pie
              data={pieData}
              dataKey="count"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius={140}
              innerRadius={55}
              stroke="var(--surface, #fff)"
              strokeWidth={2}
              paddingAngle={1}
            >
              {pieData.map((_, i) => (
                <Cell key={i} fill={CATEGORY_PIE_COLORS[i % CATEGORY_PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "var(--surface-3, #1e293b)",
                border: "1px solid var(--edge-strong, #334155)",
                borderRadius: 8, fontSize: 12,
                color: "var(--ink, #e2e8f0)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              }}
              formatter={(value: number, _n: string, props: { payload?: { category?: string } }) => [
                `${value.toLocaleString()} features`, props.payload?.category ?? "",
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="category-pie-center">
          <div className="category-pie-center-total">{total.toLocaleString()}</div>
          <div className="category-pie-center-sub">features</div>
        </div>
      </div>
      <div className="category-pie-legend">
        {pieData.map((row, i) => {
          const pct = total > 0 ? ((row.count / total) * 100) : 0;
          const color = CATEGORY_PIE_COLORS[i % CATEGORY_PIE_COLORS.length];
          return (
            <div key={row.category} className="category-pie-legend-item">
              <span className="category-pie-legend-dot" style={{ background: color }} />
              <span className="category-pie-legend-name">{row.category}</span>
              <span className="category-pie-legend-count">{row.count.toLocaleString()}</span>
              <span className="category-pie-legend-pct">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Top 5 Leaderboard ────────────────────────────────────────── */
function TopLeaderboard({ data, total }: { data: CategoryBreakdown[]; total: number }) {
  const maxCount = data[0]?.count || 1;
  return (
    <div className="leaderboard">
      {data.map((row, i) => {
        const pct = total > 0 ? ((row.count / total) * 100) : 0;
        const barPct = (row.count / maxCount) * 100;
        const medals = ["", "", ""];
        return (
          <div key={row.category} className="leaderboard__row">
            <div className="leaderboard__rank">
              <span className={`leaderboard__badge leaderboard__badge--${i + 1}`}>{i + 1}</span>
            </div>
            <div className="leaderboard__info">
              <div className="leaderboard__top">
                <span className="leaderboard__name">{row.category}</span>
                <span className="leaderboard__count">{row.count.toLocaleString()}</span>
              </div>
              <div className="leaderboard__bar-track">
                <div
                  className="leaderboard__bar-fill"
                  style={{ width: `${barPct}%`, background: colorForCategory(row.category) }}
                />
              </div>
              <span className="leaderboard__pct">{pct.toFixed(1)}% of total</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Category Severity Heatmap ────────────────────────────────── */
function SeverityHeatmap({ data }: { data: CategoryBreakdown[] }) {
  return (
    <div className="heatmap">
      {data.map((row) => {
        const sev = row.avg_severity;
        let bg = "rgba(34, 197, 94, 0.15)";
        let fg = "#22c55e";
        if (sev >= 0.67) { bg = "rgba(239, 68, 68, 0.15)"; fg = "#ef4444"; }
        else if (sev >= 0.34) { bg = "rgba(245, 158, 11, 0.15)"; fg = "#f59e0b"; }
        return (
          <div key={row.category} className="heatmap__row">
            <span className="heatmap__label">{row.category}</span>
            <div className="heatmap__cell" style={{ background: bg, borderColor: fg }}>
              <span className="heatmap__value" style={{ color: fg }}>{sev.toFixed(2)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Severity Donut ───────────────────────────────────────────── */
function SeverityDonut({ data, total }: { data: { bucket: string; count: number }[]; total: number }) {
  return (
    <div className="severity-donut-wrap">
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data.filter((d) => d.count > 0)}
            dataKey="count" nameKey="bucket"
            cx="50%" cy="50%" innerRadius={65} outerRadius={95}
            stroke="var(--surface, #fff)" strokeWidth={3} paddingAngle={3}
          >
            {data.map((row) => (
              <Cell key={row.bucket} fill={SEVERITY_COLORS[row.bucket]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "var(--surface-3, #1e293b)",
              border: "1px solid var(--edge-strong, #334155)",
              borderRadius: 8, fontSize: 12, color: "var(--ink, #e2e8f0)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            }}
            formatter={(v: number, n: string) => [`${v.toLocaleString()} (${((v / total) * 100).toFixed(1)}%)`, n]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="severity-donut-center">
        <div className="severity-donut-total">{formatNum(total)}</div>
        <div className="severity-donut-sub">features</div>
      </div>
      <div className="severity-legend">
        {data.map((row) => (
          <div key={row.bucket} className="severity-legend-item">
            <span className="severity-dot" style={{ background: SEVERITY_COLORS[row.bucket] }} />
            <span className="severity-label">{row.bucket}</span>
            <span className="severity-count">{row.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Ward Bar Chart ───────────────────────────────────────────── */
function WardBar({ data }: { data: { ward: string; feature_count: number; open_reviews: number; resolved_reviews: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data.slice(0, 12)} margin={{ left: 8, right: 16, top: 12, bottom: 24 }}>
        <defs>
          <linearGradient id="gF" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3b82f6" stopOpacity={0.9} /><stop offset="100%" stopColor="#3b82f6" stopOpacity={0.5} /></linearGradient>
          <linearGradient id="gO" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f59e0b" stopOpacity={0.9} /><stop offset="100%" stopColor="#f59e0b" stopOpacity={0.5} /></linearGradient>
          <linearGradient id="gR" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22c55e" stopOpacity={0.9} /><stop offset="100%" stopColor="#22c55e" stopOpacity={0.5} /></linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--edge, #e2e8f0)" vertical={false} />
        <XAxis dataKey="ward" tick={{ fill: "var(--ink-dim, #64748b)", fontSize: 11 }} axisLine={false} tickLine={false} interval={0} angle={-30} textAnchor="end" height={50} />
        <YAxis tick={{ fill: "var(--ink-dim, #64748b)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip cursor={{ fill: "rgba(127,127,127,0.06)" }} contentStyle={{ background: "var(--surface-3, #1e293b)", border: "1px solid var(--edge-strong, #334155)", borderRadius: 8, fontSize: 12, color: "var(--ink, #e2e8f0)", boxShadow: "0 8px 24px rgba(0,0,0,0.25)" }} />
        <Legend wrapperStyle={{ fontSize: 11, color: "var(--ink-dim, #64748b)" }} iconType="square" />
        <Bar dataKey="feature_count" name="Features" fill="url(#gF)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="open_reviews" name="Open" fill="url(#gO)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="resolved_reviews" name="Resolved" fill="url(#gR)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Review Status Pie ────────────────────────────────────────── */
function ReviewStatusPie({ data }: { data: { status: string; count: number }[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <div className="severity-donut-wrap">
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data} dataKey="count" nameKey="status"
            cx="50%" cy="50%" innerRadius={60} outerRadius={95}
            stroke="var(--surface, #fff)" strokeWidth={3} paddingAngle={2}
          >
            {data.map((row) => (
              <Cell key={row.status} fill={STATUS_COLORS[row.status] ?? "#3b82f6"} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ background: "var(--surface-3, #1e293b)", border: "1px solid var(--edge-strong, #334155)", borderRadius: 8, fontSize: 12, color: "var(--ink, #e2e8f0)", boxShadow: "0 8px 24px rgba(0,0,0,0.25)" }}
            formatter={(v: number, n: string) => [`${v} (${((v / total) * 100).toFixed(1)}%)`, n]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="severity-donut-center">
        <div className="severity-donut-total">{formatNum(total)}</div>
        <div className="severity-donut-sub">reviews</div>
      </div>
      <div className="severity-legend">
        {data.map((row) => (
          <div key={row.status} className="severity-legend-item">
            <span className="severity-dot" style={{ background: STATUS_COLORS[row.status] ?? "#3b82f6" }} />
            <span className="severity-label">{row.status}</span>
            <span className="severity-count">{row.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Category Mini Horizontal Bars ────────────────────────────── */
function CategoryMiniBars({ data, total }: { data: CategoryBreakdown[]; total: number }) {
  const maxCount = data[0]?.count || 1;
  return (
    <div className="mini-bars">
      {data.map((row) => {
        const pct = total > 0 ? ((row.count / total) * 100) : 0;
        return (
          <div key={row.category} className="mini-bars__row">
            <span className="mini-bars__label">{row.category}</span>
            <div className="mini-bars__track">
              <div className="mini-bars__fill" style={{ width: `${(row.count / maxCount) * 100}%`, background: colorForCategory(row.category) }} />
            </div>
            <span className="mini-bars__value">{row.count}</span>
            <span className="mini-bars__pct">{pct.toFixed(0)}%</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Severity mini-bar for table ──────────────────────────────── */
function SeverityBar({ value }: { value: number }) {
  let color = "#22c55e";
  if (value >= 0.67) color = "#ef4444";
  else if (value >= 0.34) color = "#f59e0b";
  return (
    <div className="sev-bar-wrap">
      <div className="sev-bar-track">
        <div className="sev-bar-fill" style={{ width: `${Math.min(value * 100, 100)}%`, background: color }} />
      </div>
      <span className="sev-bar-text">{value.toFixed(2)}</span>
    </div>
  );
}

/* ── Empty state ──────────────────────────────────────────────── */
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
