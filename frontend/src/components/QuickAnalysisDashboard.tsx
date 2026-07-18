import { useEffect, useMemo, useState } from "react";
import type { UrbanFeature } from "../lib/types";
import type { SpatialAnomaly, ManholeReadinessReport } from "../lib/workflow";
import { fetchManholeReadiness } from "../lib/workflow";
import { computeDashboardData, type LegendEntry } from "../lib/quickAnalysisStats";

interface QuickAnalysisDashboardProps {
  cardId: string;
  title: string;
  description: string;
  datasetIds: string[];
  loadedFeatures: UrbanFeature[];
  categoryStats: LegendEntry[];
  anomalies: SpatialAnomaly[];
  auditRunning: boolean;
  onRunAudit: () => void;
  onBack: () => void;
}

export function QuickAnalysisDashboard({
  cardId, title, description, datasetIds, loadedFeatures, categoryStats, anomalies, auditRunning, onRunAudit, onBack,
}: QuickAnalysisDashboardProps) {
  const [readiness, setReadiness] = useState<ManholeReadinessReport | null>(null);

  useEffect(() => {
    if (cardId !== "survey-kpis" || datasetIds.length === 0) return;
    const ctrl = new AbortController();
    fetchManholeReadiness(datasetIds, ctrl.signal).then(setReadiness).catch(() => {});
    return () => ctrl.abort();
  }, [cardId, datasetIds]);

  const data = useMemo(
    () => computeDashboardData(cardId, { loadedFeatures, categoryStats, anomalies, activeDatasetIds: datasetIds, readiness }),
    [cardId, loadedFeatures, categoryStats, anomalies, datasetIds, readiness]
  );

  const maxCount = Math.max(1, ...data.right.map((item) => item.count));
  const showRunAudit = data.right.length === 0 && ["drain-encroachment", "streetlight-spacing", "manhole-hotspots", "road-snapshot", "priority-zones"].includes(cardId);

  return (
    <div className="quick-dash" data-testid="quick-analysis-dashboard">
      <div className="quick-dash__head">
        <button type="button" className="quick-dash__back" onClick={onBack} title="Back to Quick Analysis" aria-label="Back to Quick Analysis">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <div className="quick-dash__title">
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
      </div>
      {data.bottom.length > 0 && (
        <div className="quick-dash__tiles">
          {data.bottom.map((tile) => (
            <div key={tile.label} className="quick-dash-tile">
              <span className="quick-dash-tile__value">{tile.value}</span>
              <span className="quick-dash-tile__label">{tile.label}</span>
            </div>
          ))}
        </div>
      )}
      <div className="quick-dash__section">
        <h3>{data.rightHeading}</h3>
        {data.right.length === 0 ? (
          <div className="quick-dash__empty">
            <p>{data.rightEmptyLabel ?? "No data yet"}</p>
            {showRunAudit && (
              <button type="button" className="quick-dash__run-btn" onClick={onRunAudit} disabled={auditRunning}>
                {auditRunning ? "Running…" : "Run audit"}
              </button>
            )}
          </div>
        ) : (
          <div className="quick-dash__bars">
            {data.right.map((item) => (
              <div key={item.label} className="quick-dash-bar">
                <div className="quick-dash-bar__head">
                  <span>{item.label}</span>
                  <span>{item.count}</span>
                </div>
                <div className="quick-dash-bar__track">
                  <div className="quick-dash-bar__fill" style={{ width: `${(item.count / maxCount) * 100}%`, background: item.color }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
