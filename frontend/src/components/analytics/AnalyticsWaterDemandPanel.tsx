import { useEffect, useMemo, useState } from "react";
import { fetchWardWaterDemand, type WardWaterDemandReport } from "../../lib/workflow";

interface Props {
  datasetIds: string[];
  ward: string | null;
}

function sourceTone(source: WardWaterDemandReport["census"]["data_source"]) {
  if (source === "live") return "good";
  if (source === "cached") return "warn";
  return "danger";
}

function lpcdInsightText(lpcd: number | null, lpcdSource: string | null): string {
  if (lpcd == null) return "Per-capita allowance unavailable — no water-demand figure resolved yet.";
  const rounded = Math.round(lpcd);
  if (lpcdSource === "Corporation's own published per-capita supply figure") {
    return `Per-capita allowance used: ${rounded} LPCD (Corporation published). Raise to 135 LPCD (CPHEEO) for a stress case.`;
  }
  if (lpcdSource === "CPHEEO Manual planning default") {
    return `Per-capita allowance used: ${rounded} LPCD (CPHEEO Manual default — Corporation's own figure was unavailable).`;
  }
  if (lpcdSource === "manual override") {
    return `Per-capita allowance used: ${rounded} LPCD (manual override).`;
  }
  return `Per-capita allowance used: ${rounded} LPCD (${lpcdSource ?? "unknown source"}).`;
}

function sourceLabel(report: WardWaterDemandReport) {
  const { data_source, source_fetched_at } = report.census;
  if (data_source === "live") return "Live · Davanagere City Corporation";
  if (data_source === "cached") {
    const when = source_fetched_at ? new Date(source_fetched_at).toLocaleString() : "unknown time";
    return `Cached (fetched ${when})`;
  }
  return "Unavailable — enter population manually";
}

function populationSourceLabel(source: WardWaterDemandReport["population_source"]) {
  if (source === "census") return "Census (Davanagere City Corporation)";
  if (source === "manual_override") return "Manual entry";
  return "Unavailable";
}

export function AnalyticsWaterDemandPanel({ datasetIds, ward }: Props) {
  const [report, setReport] = useState<WardWaterDemandReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [floatingPopulation, setFloatingPopulation] = useState<number>(0);
  const [manualPopulation, setManualPopulation] = useState<string>("");
  const [refreshNonce, setRefreshNonce] = useState(0);

  const scopeKey = useMemo(
    () => JSON.stringify({ datasetIds: [...datasetIds].sort(), ward, floatingPopulation, refreshNonce }),
    [datasetIds, ward, floatingPopulation, refreshNonce]
  );

  useEffect(() => {
    if (!ward) {
      setReport(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchWardWaterDemand(ward, datasetIds, controller.signal, { floatingPopulation })
      .then(setReport)
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(caught.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // scopeKey captures the normalized ward/dataset/floating-population/refresh scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  function refresh() {
    if (!ward || loading) return;
    setRefreshNonce((n) => n + 1);
  }

  function submitManualPopulation() {
    const value = Number(manualPopulation);
    if (!ward || !Number.isFinite(value) || value <= 0) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchWardWaterDemand(ward, datasetIds, controller.signal, {
      floatingPopulation,
      populationOverride: Math.round(value),
    })
      .then(setReport)
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setLoading(false));
  }

  if (!ward) {
    return (
      <section className="chart-card analytics-water-demand-card" data-testid="analytics-water-demand">
        <div className="chart-card__header">
          <div>
            <div className="analytics-card-eyebrow">Automatic on ward load</div>
            <h3 className="chart-card__title">Ward Water Demand</h3>
          </div>
        </div>
        <div className="chart-card__body">
          <div className="analytics-quality-empty-state">
            Select a ward in the Ward Coverage chart above to see its live population and estimated water demand.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="chart-card analytics-water-demand-card" data-testid="analytics-water-demand">
      <div className="chart-card__header">
        <div>
          <div className="analytics-card-eyebrow">Automatic on ward load</div>
          <h3 className="chart-card__title">Ward Water Demand</h3>
        </div>
        <div className="analytics-water-demand-header-actions">
          {report && (
            <span className={`analytics-water-demand-badge analytics-water-demand-badge--${sourceTone(report.census.data_source)}`}>
              {sourceLabel(report)}
            </span>
          )}
          <button
            type="button"
            className="ds-refresh-btn"
            onClick={refresh}
            disabled={loading}
            title="Refresh census and water-demand data for this ward"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="chart-card__body">
        {loading && <div className="analytics-page__loading">Resolving ward population and demand…</div>}
        {error && <div className="analytics-inline-error">Water demand unavailable: {error}</div>}

        {!loading && !error && report && (
          <>
            {report.census.match_method === "fuzzy" && (
              <div className="analytics-water-demand-match-warning">
                Matched "{ward}" to census ward "{report.census.ward_name}" (Ward {report.census.ward_no}) at{" "}
                {(report.census.match_confidence * 100).toFixed(0)}% confidence — verify this is the correct ward.
              </div>
            )}
            {report.census.match_method === "none" && report.census.data_source !== "unavailable" && (
              <div className="analytics-water-demand-match-warning">
                No confident census match was found for "{ward}". Enter population manually below.
              </div>
            )}

            <div className="analytics-water-demand-stats">
              <div>
                <span>Males</span>
                <b>{report.census.males?.toLocaleString() ?? "—"}</b>
              </div>
              <div>
                <span>Females</span>
                <b>{report.census.females?.toLocaleString() ?? "—"}</b>
              </div>
              <div>
                <span>Persons</span>
                <b>{report.census.persons?.toLocaleString() ?? "—"}</b>
              </div>
              <div>
                <span>Area</span>
                <b>{report.census.area_sq_km != null ? `${report.census.area_sq_km} km²` : "—"}</b>
              </div>
              <div>
                <span>Density (computed)</span>
                <b>{report.census.population_per_sq_km != null ? `${report.census.population_per_sq_km.toLocaleString()} /km²` : "—"}</b>
              </div>
              <div>
                <span>Buildings surveyed</span>
                <b>{report.building_count_surveyed.toLocaleString()}</b>
              </div>
              <div>
                <span>Population source</span>
                <b>{populationSourceLabel(report.population_source)}</b>
              </div>
            </div>

            {report.total_mld != null ? (
              <>
                <div className="analytics-water-demand-total">
                  <span>Total estimated water demand</span>
                  <b>{report.total_mld.toLocaleString()} MLD</b>
                  <small>{report.total_liters_per_day?.toLocaleString()} litres/day</small>
                </div>

                <div className="analytics-water-demand-bars">
                  {report.line_items.map((item) => {
                    const max = Math.max(...report.line_items.map((i) => i.liters_per_day), 1);
                    return (
                      <div key={item.key} className="analytics-water-demand-bar-row" title={item.explanation}>
                        <span>{item.label}</span>
                        <div className="analytics-readiness-track" aria-hidden="true">
                          <i style={{ width: `${Math.max(2, (item.liters_per_day / max) * 100)}%` }} />
                        </div>
                        <b>{Math.round(item.liters_per_day).toLocaleString()} L</b>
                      </div>
                    );
                  })}
                </div>

                {report.fire_demand_liters != null && (
                  <div className="analytics-water-demand-fire">
                    Fire-fighting provision (not in daily total): {Math.round(report.fire_demand_liters).toLocaleString()} L
                  </div>
                )}

                {report.supply_comparison && (
                  <div className="analytics-water-demand-supply">
                    <h4>Supply vs Demand (City-wide benchmark)</h4>
                    <div className="analytics-water-demand-supply-grid">
                      <div>
                        <span>Ward demand</span>
                        <b>{report.supply_comparison.ward_demand_mld.toLocaleString()} MLD</b>
                      </div>
                      <div>
                        <span>Fair share of city supply</span>
                        <b>{report.supply_comparison.expected_supply_mld.toLocaleString()} MLD</b>
                      </div>
                      <div>
                        <span>Demand vs share</span>
                        <b>{report.supply_comparison.demand_vs_expected_supply_pct.toLocaleString()}%</b>
                      </div>
                    </div>
                    {report.supply_comparison.is_deficit ? (
                      <div className="analytics-water-demand-insight analytics-water-demand-insight--deficit">
                        <strong>⚠ Deficit:</strong> this ward needs{" "}
                        {report.supply_comparison.deficit_mld.toLocaleString()} MLD more than its population-based
                        share of the city's {report.supply_comparison.city_total_supply_mld.toLocaleString()} MLD supply.
                        Prioritize network augmentation, leakage reduction, and equitable zone metering.
                      </div>
                    ) : (
                      <div className="analytics-water-demand-insight analytics-water-demand-insight--surplus">
                        <strong>✓ Headroom:</strong> this ward's demand is{" "}
                        {report.supply_comparison.surplus_mld.toLocaleString()} MLD below its population-based share —
                        supply capacity exists to absorb growth or floating population before augmentation.
                      </div>
                    )}
                    <ul className="analytics-water-demand-actions">
                      <li>{lpcdInsightText(report.lpcd, report.lpcd_source)}</li>
                      <li>Losses assumed at 15% UFW — target ≤10% via pressure management &amp; meter audits.</li>
                      <li>Institutional load at 20% — verify against actual non-domestic connections in the survey.</li>
                      {report.supply_comparison.is_deficit && (
                        <li>Action: model equitable redistribution from surplus wards before new source commissioning.</li>
                      )}
                    </ul>
                    <p className="analytics-water-demand-supply-note">{report.supply_comparison.note}</p>
                  </div>
                )}
              </>
            ) : (
              <div className="analytics-quality-empty-state">
                No population is available yet for this ward. Enter one manually to generate a demand estimate.
              </div>
            )}

            <div className="analytics-water-demand-override">
              <label>
                Floating population (markets, festivals, transient)
                <input
                  type="number"
                  min={0}
                  value={floatingPopulation || ""}
                  placeholder="0"
                  onChange={(e) => setFloatingPopulation(Number(e.target.value) || 0)}
                />
              </label>
              {report.census.data_source === "unavailable" || report.census.match_method === "none" ? (
                <label>
                  Manual population correction
                  <span className="analytics-water-demand-manual-input">
                    <input
                      type="number"
                      min={1}
                      value={manualPopulation}
                      placeholder="Enter population"
                      onChange={(e) => setManualPopulation(e.target.value)}
                    />
                    <button type="button" onClick={submitManualPopulation} disabled={!manualPopulation}>
                      Apply
                    </button>
                  </span>
                </label>
              ) : null}
            </div>

            <details className="analytics-methodology">
              <summary>How this demand estimate is worked out</summary>
              <p>{report.methodology}</p>
              {report.line_items.length > 0 && (
                <ul className="analytics-methodology-breakdown">
                  {report.line_items.map((item) => (
                    <li key={item.key}>
                      <strong>{item.label}:</strong> {item.explanation}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </>
        )}
      </div>
    </section>
  );
}
