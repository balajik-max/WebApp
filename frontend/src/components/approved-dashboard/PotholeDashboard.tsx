import { useMemo, useState } from "react";
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
  calculatePotholeDashboard,
  type PotholeDepthBand,
  type PotholeRecord,
} from "../../lib/approved-dashboard/surfaceIssueDashboardCalculations";
import { KpiCard } from "./KpiCard";

const DEPTH_COLOURS: Record<PotholeDepthBand, string> = {
  "Shallow (under 5 cm)": "#2e9b78",
  "Moderate (5–10 cm)": "#dda127",
  "Deep (over 10 cm)": "#d74e4e",
  "Depth unavailable": "#8b95a7",
};

type PotholeDashboardProps = {
  data: GisWorkbookData;
};

function fixed(value: number | null, digits: number, suffix: string): string {
  if (value === null || !Number.isFinite(value)) return "Not available";
  return `${value.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${suffix}`;
}

function compactPoint(record: PotholeRecord): string {
  if (record.startPoint && record.endPoint) {
    return `${record.startPoint.x.toFixed(2)}, ${record.startPoint.y.toFixed(2)} → ${record.endPoint.x.toFixed(2)}, ${record.endPoint.y.toFixed(2)}`;
  }
  if (record.latitude !== null && record.longitude !== null) {
    return `${record.latitude.toFixed(6)}, ${record.longitude.toFixed(6)}`;
  }
  return "Not recorded";
}

function formatAreaTooltip(value: unknown): [string, string] {
  return [`${Number(value ?? 0).toFixed(2)} m²`, "Affected area"];
}

function formatDepthTooltip(value: unknown): [string, string] {
  return [`${Number(value ?? 0).toFixed(2)} cm`, "Depth"];
}

export function PotholeDashboard({ data }: PotholeDashboardProps) {
  const dashboard = useMemo(
    () => calculatePotholeDashboard(data.Pothole, data.Pothole_Top),
    [data.Pothole, data.Pothole_Top],
  );
  const [depthBand, setDepthBand] = useState<"All" | PotholeDepthBand>("All");

  const filteredRecords = useMemo(
    () =>
      depthBand === "All"
        ? dashboard.records
        : dashboard.records.filter((record) => record.depthBand === depthBand),
    [dashboard.records, depthBand],
  );

  const areaChartData = filteredRecords
    .filter((record) => record.areaSqm !== null)
    .map((record) => ({
      name: `FID ${record.sourceFid}`,
      area: record.areaSqm as number,
      fid: record.sourceFid,
    }));
  const depthChartData = filteredRecords
    .filter((record) => record.depthCm !== null)
    .map((record) => ({
      name: `FID ${record.sourceFid}`,
      depth: record.depthCm as number,
      fid: record.sourceFid,
    }));

  return (
    <div className="dashboard-page">
      <section className="dashboard-page-heading">
        <div>
          <span>Road-surface defects</span>
          <h2>Pothole condition and repair quantities</h2>
          <p>
            Pothole boundaries are measured from the bottom surface. Where a
            matching top surface is available, depth is calculated from the
            elevation difference and repair volume is estimated as area × depth.
          </p>
        </div>
        <div className="page-record-badge">
          {filteredRecords.length.toLocaleString("en-IN")} of{" "}
          {dashboard.totalPotholes.toLocaleString("en-IN")} potholes shown
        </div>
      </section>

      <section className="dashboard-filter-panel dashboard-filter-panel--surface-issue">
        <label>
          <span>Depth band</span>
          <select
            value={depthBand}
            onChange={(event) => setDepthBand(event.target.value as "All" | PotholeDepthBand)}
          >
            <option value="All">All potholes</option>
            {dashboard.depthDistribution.map((item) => (
              <option value={item.name} key={item.name}>
                {item.name} ({item.count})
              </option>
            ))}
          </select>
        </label>
        <div className="surface-method-note">
          <strong>Measurement coverage</strong>
          <span>
            Depth available for {dashboard.depthCoverageCount}/{dashboard.totalPotholes};
            volume available for {dashboard.volumeCoverageCount}/{dashboard.totalPotholes}.
          </span>
        </div>
      </section>

      <section className="surface-kpi-grid" aria-label="Pothole measurements">
        <KpiCard icon="●" label="Total potholes" value={dashboard.totalPotholes} helper="Distinct mapped pothole bottom polygons" />
        <KpiCard icon="▱" label="Affected area" value={fixed(dashboard.totalAreaSqm, 2, "m²")} helper="Combined mapped pothole surface area" />
        <KpiCard icon="↕" label="Average depth" value={fixed(dashboard.averageDepthCm, 2, "cm")} helper="Average of potholes with valid depth" />
        <KpiCard icon="↓" label="Maximum depth" value={fixed(dashboard.maximumDepthCm, 2, "cm")} helper="Deepest measured pothole" tone="danger" />
        <KpiCard icon="◫" label="Repair volume" value={fixed(dashboard.totalVolumeM3, 3, "m³")} helper="Surveyed or area × depth volume" tone="warning" />
        <KpiCard
          icon="◎"
          label="Deepest pothole"
          value={dashboard.deepestPothole ? `FID ${dashboard.deepestPothole.sourceFid}` : "Not available"}
          helper={dashboard.deepestPothole ? fixed(dashboard.deepestPothole.depthCm, 2, "cm") : "No depth measurement"}
          tone="danger"
        />
      </section>

      {filteredRecords.length === 0 ? (
        <section className="empty-result-panel">
          <strong>No potholes match the selected depth band</strong>
          <p>Choose another depth band or show all potholes.</p>
          <button type="button" onClick={() => setDepthBand("All")}>Show all potholes</button>
        </section>
      ) : (
        <>
          <section className="dashboard-section-heading">
            <div>
              <span>Measured quantities</span>
              <h2>Area and depth comparison</h2>
            </div>
            <p>Every bar represents one mapped pothole, keeping the comparison readable and traceable to its source FID.</p>
          </section>

          <section className="dashboard-chart-grid">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div><span>Surface footprint</span><h3>Affected area by pothole</h3></div>
              </div>
              {areaChartData.length > 0 ? (
                <div className="chart-container chart-container--surface">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={areaChartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip formatter={formatAreaTooltip} />
                      <Bar dataKey="area" fill="#2b846f" radius={[7, 7, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="surface-empty-chart">No valid pothole area measurement is available for the selected records.</div>
              )}
            </article>

            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div><span>Vertical difference</span><h3>Calculated pothole depth</h3></div>
              </div>
              {depthChartData.length > 0 ? (
                <div className="chart-container chart-container--surface">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={depthChartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip formatter={formatDepthTooltip} />
                      <Bar dataKey="depth" fill="#d55a4f" radius={[7, 7, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="surface-empty-chart">No valid top/bottom elevation pair is available for the selected records.</div>
              )}
            </article>
          </section>

          <section className="dashboard-chart-grid dashboard-chart-grid--surface-summary">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div><span>Depth grouping</span><h3>Mapped depth bands</h3></div>
              </div>
              <div className="chart-container chart-container--surface-donut">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={dashboard.depthDistribution} dataKey="count" nameKey="name" innerRadius={66} outerRadius={102} paddingAngle={2}>
                      {dashboard.depthDistribution.map((item) => <Cell key={item.name} fill={DEPTH_COLOURS[item.name]} />)}
                    </Pie>
                    <Tooltip formatter={(value) => [Number(value ?? 0).toLocaleString("en-IN"), "Potholes"]} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-centre"><strong>{dashboard.totalPotholes}</strong><span>potholes</span></div>
              </div>
            </article>

            <article className="dashboard-panel surface-highlight-panel">
              <span>Calculation quality</span>
              <h3>How these values are produced</h3>
              <div><strong>1</strong><p>Match each pothole bottom polygon with the top/reference surface using the source FID first, then the nearest centroid within 5 metres.</p></div>
              <div><strong>2</strong><p>Use a directly surveyed depth or volume when supplied. Otherwise calculate depth from top elevation − bottom elevation and estimate volume from area × depth.</p></div>
              <div><strong>3</strong><p>Records without enough measurement evidence remain visible and are marked as unavailable rather than guessed.</p></div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div><span>Detailed register</span><h2>Pothole measurement table</h2></div>
            <p>Values retain the source GDB FID so each dashboard row can be audited against the original survey.</p>
          </section>

          <section className="road-table-panel">
            <div className="road-table-scroller surface-table-scroller">
              <table className="road-table surface-table">
                <thead>
                  <tr>
                    <th>Pothole</th><th>Area</th><th>Top elevation</th><th>Bottom elevation</th><th>Depth</th><th>Volume</th><th>Survey span / location</th><th>Map</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecords.map((record, index) => (
                    <tr key={record.id}>
                      <td><strong>P{index + 1}</strong><small>FID {record.sourceFid}</small></td>
                      <td>{fixed(record.areaSqm, 3, "m²")}</td>
                      <td>{fixed(record.topElevationM, 3, "m")}</td>
                      <td>{fixed(record.bottomElevationM, 3, "m")}</td>
                      <td><span className={`surface-depth-badge surface-depth-badge--${record.depthBand.startsWith("Deep") ? "danger" : record.depthBand.startsWith("Moderate") ? "warning" : record.depthBand.startsWith("Depth") ? "neutral" : "good"}`}>{fixed(record.depthCm, 2, "cm")}</span></td>
                      <td>{fixed(record.volumeM3, 3, "m³")}<small>{record.volumeMethod}</small></td>
                      <td>{compactPoint(record)}{record.surveyedLengthM !== null && <small>{fixed(record.surveyedLengthM, 2, "m")} measured span</small>}</td>
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
