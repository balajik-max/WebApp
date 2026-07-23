import { useMemo } from "react";
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

import type { GisWorkbookData } from "../../lib/approved-dashboard/gisTypes";
import {
  calculateStandingWaterDashboard,
  type StandingWaterSizeBand,
} from "../../lib/approved-dashboard/surfaceIssueDashboardCalculations";
import { KpiCard } from "./KpiCard";

const SIZE_COLOURS: Record<StandingWaterSizeBand, string> = {
  "Small (under 5 m²)": "#3f8dbd",
  "Medium (5–15 m²)": "#d5a12d",
  "Large (over 15 m²)": "#cf5555",
  "Area unavailable": "#9ca3af",
};

type StandingWaterDashboardProps = {
  data: GisWorkbookData;
};

function fixed(value: number | null, digits: number, suffix: string): string {
  if (value === null || !Number.isFinite(value)) return "Not available";
  return `${value.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${suffix}`;
}

function formatAreaTooltip(value: unknown): [string, string] {
  return [`${Number(value ?? 0).toFixed(2)} m²`, "Affected area"];
}

export function StandingWaterDashboard({ data }: StandingWaterDashboardProps) {
  const dashboard = useMemo(
    () => calculateStandingWaterDashboard(data.Standing_Water),
    [data.Standing_Water],
  );
  const areaChartData = dashboard.records
    .filter((record) => record.areaSqm !== null)
    .map((record) => ({
      name: `FID ${record.sourceFid}`,
      area: record.areaSqm as number,
      fid: record.sourceFid,
    }));

  return (
    <div className="dashboard-page">
      <section className="dashboard-page-heading">
        <div>
          <span>Surface-water hotspots</span>
          <h2>Standing-water locations</h2>
          <p>
            The dashboard uses the mapped standing-water polygons and their
            survey attributes. Area totals come directly from the GDB; depth
            and volume are shown only when those measurements are supplied.
          </p>
        </div>
        <div className="page-record-badge">
          {dashboard.totalLocations.toLocaleString("en-IN")} mapped locations
        </div>
      </section>

      <section className="surface-kpi-grid" aria-label="Standing-water measurements">
        <KpiCard icon="≈" label="Locations" value={dashboard.totalLocations} helper="Distinct standing-water polygons" />
        <KpiCard icon="▱" label="Affected area" value={fixed(dashboard.totalAreaSqm, 2, "m²")} helper="Combined mapped surface area" />
        <KpiCard icon="◫" label="Largest location" value={fixed(dashboard.largestAreaSqm, 2, "m²")} helper={dashboard.largestLocation ? `Source FID ${dashboard.largestLocation.sourceFid}` : "No area measurement"} tone="danger" />
        <KpiCard icon="÷" label="Average area" value={fixed(dashboard.averageAreaSqm, 2, "m²")} helper="Mean mapped area per location" />
        <KpiCard icon="↕" label="Depth measured" value={`${dashboard.measuredDepthCount}/${dashboard.totalLocations}`} helper="Locations with a supplied water depth" tone={dashboard.measuredDepthCount === dashboard.totalLocations ? "success" : "warning"} />
        <KpiCard icon="◩" label="Measured volume" value={fixed(dashboard.measuredVolumeM3, 3, "m³")} helper="Only supplied or depth-supported volume" />
      </section>

      {dashboard.totalLocations === 0 ? (
        <section className="empty-result-panel">
          <strong>No standing-water layer is available</strong>
          <p>Confirm the source layer in Layer Review or upload a GDB containing standing-water polygons.</p>
        </section>
      ) : (
        <>
          <section className="dashboard-section-heading">
            <div><span>Hotspot comparison</span><h2>Where is the largest affected area?</h2></div>
            <p>The chart ranks every standing-water polygon by its mapped area without inventing depth or flooding duration.</p>
          </section>

          <section className="dashboard-chart-grid">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading"><div><span>Location-wise area</span><h3>Standing-water footprint</h3></div></div>
              {areaChartData.length > 0 ? (
                <div className="chart-container chart-container--surface">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={areaChartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip formatter={formatAreaTooltip} />
                      <Bar dataKey="area" fill="#3f8dbd" radius={[7, 7, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="surface-empty-chart">No valid standing-water area measurement is available.</div>
              )}
            </article>

            <article className="dashboard-panel">
              <div className="dashboard-panel__heading"><div><span>Mapped area bands</span><h3>Hotspot size distribution</h3></div></div>
              <div className="chart-container chart-container--surface-donut">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={dashboard.sizeDistribution} dataKey="count" nameKey="name" innerRadius={66} outerRadius={102} paddingAngle={2}>
                      {dashboard.sizeDistribution.map((item) => <Cell key={item.name} fill={SIZE_COLOURS[item.name]} />)}
                    </Pie>
                    <Tooltip formatter={(value) => [Number(value ?? 0).toLocaleString("en-IN"), "Locations"]} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-centre"><strong>{dashboard.totalLocations}</strong><span>locations</span></div>
              </div>
            </article>
          </section>

          <section className="surface-alert-panel">
            <div className="surface-alert-panel__icon">!</div>
            <div>
              <span>Largest mapped hotspot</span>
              <strong>{dashboard.largestLocation ? `FID ${dashboard.largestLocation.sourceFid} · ${fixed(dashboard.largestLocation.areaSqm, 2, "m²")}` : "Not available"}</strong>
              <p>This identifies the largest mapped footprint only. Duration, cause and water depth require field observations or additional survey attributes.</p>
            </div>
            {dashboard.largestLocation?.mapHref && <a className="dashboard-map-link" href={dashboard.largestLocation.mapHref}>Open hotspot on map</a>}
          </section>

          <section className="dashboard-section-heading">
            <div><span>Detailed register</span><h2>Standing-water measurement table</h2></div>
            <p>All rows preserve source FIDs and remain linked to their actual mapped geometry.</p>
          </section>

          <section className="road-table-panel">
            <div className="road-table-scroller surface-table-scroller">
              <table className="road-table surface-table">
                <thead><tr><th>Location</th><th>Area</th><th>Perimeter</th><th>Area band</th><th>Depth</th><th>Volume</th><th>Coordinates</th><th>Map</th></tr></thead>
                <tbody>
                  {dashboard.records.map((record, index) => (
                    <tr key={record.id}>
                      <td><strong>W{index + 1}</strong><small>FID {record.sourceFid}</small></td>
                      <td>{fixed(record.areaSqm, 3, "m²")}</td>
                      <td>{fixed(record.perimeterM, 3, "m")}</td>
                      <td><span className={`surface-depth-badge surface-depth-badge--${record.sizeBand.startsWith("Large") ? "danger" : record.sizeBand.startsWith("Medium") ? "warning" : record.sizeBand.startsWith("Area") ? "neutral" : "good"}`}>{record.sizeBand}</span></td>
                      <td>{fixed(record.depthM, 3, "m")}</td>
                      <td>{fixed(record.volumeM3, 3, "m³")}</td>
                      <td>{record.latitude !== null && record.longitude !== null ? `${record.latitude.toFixed(6)}, ${record.longitude.toFixed(6)}` : "Not recorded"}</td>
                      <td>{record.mapHref ? <a className="dashboard-map-link" href={record.mapHref}>View on map</a> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
