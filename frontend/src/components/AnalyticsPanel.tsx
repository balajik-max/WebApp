import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { fetchOverview, fetchDatasets } from "../lib/workflow";
import type { AnalyticsOverview, DatasetRow } from "../lib/workflow";

const STATUS_COLORS: Record<string, string> = {
  open: "#3aa1ff",
  reviewing: "#f5c542",
  in_progress: "#c47af5",
  blocked: "#8ea3a0",
  resolved: "#5be08a",
  rejected: "#ff5a3d",
};

export function AnalyticsPanel() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [datasets, setDatasets] = useState<DatasetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([fetchOverview(ctrl.signal), fetchDatasets(ctrl.signal)])
      .then(([o, d]) => {
        setOverview(o);
        setDatasets(d);
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, []);

  return (
    <aside className="analytics" data-testid="analytics-panel">
      <div className="analytics__eyebrow">Data &amp; Analytics</div>

      {error && (
        <div className="analytics__error" data-testid="analytics-error">
          Live analytics unavailable: {error}
        </div>
      )}

      <section className="analytics__kpis" data-testid="analytics-kpis">
        <Kpi label="Total surveys" value={overview?.total_datasets} testid="kpi-total-surveys" />
        <Kpi label="Features" value={overview?.total_features} testid="kpi-total-features" />
        <Kpi
          label="Open"
          value={overview?.open_reviews}
          tone="warn"
          testid="kpi-open-reviews"
        />
        <Kpi
          label="Resolved"
          value={overview?.resolved_reviews}
          tone="ok"
          testid="kpi-resolved-reviews"
        />
      </section>

      <section className="analytics__block">
        <h4 className="analytics__block-title">Review status</h4>
        <div className="analytics__chart" data-testid="chart-status">
          {overview && overview.status_breakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={overview.status_breakdown} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="status"
                  tick={{ fill: "#8ea3a0", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={70}
                />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  contentStyle={{
                    background: "#0b1013",
                    border: "1px solid #2b3a42",
                    borderRadius: 3,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                  {overview.status_breakdown.map((row) => (
                    <Cell key={row.status} fill={STATUS_COLORS[row.status] ?? "#3aa1ff"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="analytics__muted">No review items yet.</p>
          )}
        </div>
      </section>

      <section className="analytics__block">
        <h4 className="analytics__block-title">Ward distribution</h4>
        <div className="analytics__chart" data-testid="chart-wards">
          {overview && overview.ward_breakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={overview.ward_breakdown.slice(0, 8)}
                margin={{ left: 4, right: 8, top: 4, bottom: 20 }}
              >
                <XAxis
                  dataKey="ward"
                  tick={{ fill: "#8ea3a0", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                  angle={-30}
                  textAnchor="end"
                  height={40}
                />
                <YAxis
                  tick={{ fill: "#8ea3a0", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={28}
                />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  contentStyle={{
                    background: "#0b1013",
                    border: "1px solid #2b3a42",
                    borderRadius: 3,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="open_reviews" name="open" stackId="a" fill="#f5c542" />
                <Bar dataKey="resolved_reviews" name="resolved" stackId="a" fill="#5be08a" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="analytics__muted">No ward-tagged datasets yet.</p>
          )}
        </div>
      </section>

      <section className="analytics__block">
        <h4 className="analytics__block-title">Uploaded datasets</h4>
        <ul className="datasets" data-testid="dataset-list">
          {datasets && datasets.length > 0 ? (
            datasets.slice(0, 8).map((d) => (
              <li key={d.id} data-testid={`dataset-row-${d.id}`}>
                <div className="datasets__row">
                  <span className="datasets__name">{d.name}</span>
                  <span className={`badge badge--${d.status}`}>{d.status}</span>
                </div>
                <div className="datasets__meta">
                  {d.ward ? `ward ${d.ward} · ` : ""}
                  {d.file_type} · {formatBytes(d.size_bytes)}
                </div>
              </li>
            ))
          ) : (
            <li className="analytics__muted">No datasets uploaded yet.</li>
          )}
        </ul>
      </section>
    </aside>
  );
}

function Kpi({
  label,
  value,
  tone,
  testid,
}: {
  label: string;
  value: number | undefined;
  tone?: "ok" | "warn";
  testid: string;
}) {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ""}`} data-testid={testid}>
      <div className="kpi__value">{value ?? "—"}</div>
      <div className="kpi__label">{label}</div>
    </div>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
