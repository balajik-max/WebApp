import { useMemo } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { AnalyticsSeverityBucket } from "../../lib/workflow";

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

export function AnalyticsSeverityVisualization({ data, activeBucket, onToggleBucket }: Props) {
  const total = useMemo(() => data.reduce((sum, item) => sum + item.value, 0), [data]);

  return (
    <div className="analytics-severity-visualization">
      <div className="analytics-severity-pie-layout">
        <ResponsiveContainer width="100%" height={230}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="45%"
              outerRadius="82%"
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
