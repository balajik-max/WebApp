import { useEffect, useMemo, useState } from "react";
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
import type {
  AnalyticsSeverityBucket,
  SeverityVisualizationType,
} from "../../lib/workflow";

const STORAGE_KEY = "davangere.analytics.severity-visualization.v1";

export interface SeverityVisualizationDatum {
  name: string;
  value: number;
  color: string;
  percentage: string;
}

interface Props {
  data: SeverityVisualizationDatum[];
  activeBucket: AnalyticsSeverityBucket | null;
  onToggleBucket: (bucket: AnalyticsSeverityBucket) => void;
}

function readInitialType(): SeverityVisualizationType {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    if (value === "bar" || value === "pie" || value === "treemap") return value;
  } catch {
    // Ignore storage restrictions and retain the default.
  }
  return "bar";
}

export function AnalyticsSeverityVisualization({ data, activeBucket, onToggleBucket }: Props) {
  const [type, setType] = useState<SeverityVisualizationType>(readInitialType);
  const total = useMemo(() => data.reduce((sum, item) => sum + item.value, 0), [data]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, type);
    } catch {
      // The selector remains fully functional in memory.
    }
  }, [type]);

  function choose(next: SeverityVisualizationType) {
    setType(next);
  }

  return (
    <div className="analytics-severity-visualization">
      <div className="analytics-chart-selector" role="group" aria-label="Severity chart type">
        {(["bar", "pie", "treemap"] as const).map((option) => (
          <button
            type="button"
            key={option}
            className={type === option ? "is-active" : undefined}
            aria-pressed={type === option}
            onClick={() => choose(option)}
          >
            {option === "bar" ? "Bar" : option === "pie" ? "Pie" : "Treemap"}
          </button>
        ))}
      </div>

      {type === "bar" && (
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={data} layout="vertical" margin={{ left: 20, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" horizontal={false} />
            <XAxis type="number" tick={{ fill: "var(--ink-mute)", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fill: "var(--ink-dim)", fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false} width={80} />
            <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
            <Bar dataKey="value" radius={[0, 6, 6, 0]}>
              {data.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={entry.color}
                  opacity={activeBucket && activeBucket !== entry.name.toLowerCase() ? 0.38 : 1}
                  className="analytics-clickable-chart-item"
                  onClick={() => onToggleBucket(entry.name.toLowerCase() as AnalyticsSeverityBucket)}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}

      {type === "pie" && (
        <div className="analytics-severity-pie-layout">
          <ResponsiveContainer width="100%" height={230}>
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={92}
                paddingAngle={2}
                stroke="var(--surface)"
                strokeWidth={3}
              >
                {data.map((entry) => (
                  <Cell
                    key={entry.name}
                    fill={entry.color}
                    opacity={activeBucket && activeBucket !== entry.name.toLowerCase() ? 0.38 : 1}
                    className="analytics-clickable-chart-item"
                    onClick={() => onToggleBucket(entry.name.toLowerCase() as AnalyticsSeverityBucket)}
                  />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--edge)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="analytics-severity-pie-center" aria-hidden="true">
            <strong>{total.toLocaleString()}</strong>
            <span>Features</span>
          </div>
        </div>
      )}

      {type === "treemap" && (
        <div className="analytics-severity-treemap" aria-label="Severity treemap">
          {data.map((item) => {
            const bucket = item.name.toLowerCase() as AnalyticsSeverityBucket;
            const basis = total > 0 ? (item.value / total) * 100 : 0;
            return (
              <button
                type="button"
                key={item.name}
                className={activeBucket === bucket ? "is-active" : undefined}
                style={{
                  background: item.color,
                  flexBasis: `${basis}%`,
                  flexGrow: Math.max(item.value, 0.05),
                  opacity: activeBucket && activeBucket !== bucket ? 0.38 : 1,
                }}
                onClick={() => onToggleBucket(bucket)}
                title={`${item.name}: ${item.value.toLocaleString()} (${item.percentage}%)`}
              >
                <strong>{item.name}</strong>
                <span>{item.value.toLocaleString()}</span>
                <small>{item.percentage}%</small>
              </button>
            );
          })}
        </div>
      )}

      <div className="analytics-severity-summary">
        {data.map((item) => {
          const bucket = item.name.toLowerCase() as AnalyticsSeverityBucket;
          return (
            <button
              type="button"
              key={item.name}
              className={activeBucket === bucket ? "is-active" : undefined}
              onClick={() => onToggleBucket(bucket)}
            >
              <strong style={{ color: item.color }}>{item.value.toLocaleString()}</strong>
              <span>{item.name} ({item.percentage}%)</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
