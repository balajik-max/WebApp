import { useMemo, useState } from "react";
import {
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
  calculateRoadDashboard,
  prepareRoadRecords,
  type RoadRecord,
} from "../../lib/approved-dashboard/roadDashboardCalculations";
import type { GisWorkbookData } from "../../lib/approved-dashboard/gisTypes";
import { KpiCard } from "./KpiCard";

type RoadDashboardProps = {
  data: GisWorkbookData;
};

const CHART_COLOURS = ["#237b68", "#d59a27", "#4478a8", "#8a66b4"];

function uniqueValues(records: RoadRecord[], key: "surface" | "usage" | "footpath") {
  return Array.from(new Set(records.map((record) => record[key]))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function formatCountTooltip(value: unknown): [string, string] {
  return [Number(value ?? 0).toLocaleString("en-IN"), "Roads"];
}

function formatLengthTooltip(value: unknown): [string, string] {
  return [`${Number(value ?? 0).toLocaleString("en-IN")} m`, "Length"];
}

function displayWidth(width: number | null): string {
  return width === null ? "Not recorded" : `${width.toFixed(1)} m`;
}

export function RoadDashboard({ data }: RoadDashboardProps) {
  const allRecords = useMemo(() => prepareRoadRecords(data.Road_Centerline), [data]);

  const [search, setSearch] = useState("");
  const [surface, setSurface] = useState("All");
  const [usage, setUsage] = useState("All");
  const [footpath, setFootpath] = useState("All");

  const surfaceOptions = useMemo(() => uniqueValues(allRecords, "surface"), [allRecords]);
  const usageOptions = useMemo(() => uniqueValues(allRecords, "usage"), [allRecords]);
  const footpathOptions = useMemo(() => uniqueValues(allRecords, "footpath"), [allRecords]);

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();

    return allRecords.filter((record) => {
      const matchesSearch =
        query.length === 0 ||
        record.name.toLowerCase().includes(query) ||
        record.observation.toLowerCase().includes(query);

      return (
        matchesSearch &&
        (surface === "All" || record.surface === surface) &&
        (usage === "All" || record.usage === usage) &&
        (footpath === "All" || record.footpath === footpath)
      );
    });
  }, [allRecords, footpath, search, surface, usage]);

  const dashboard = useMemo(
    () => calculateRoadDashboard(filteredRecords),
    [filteredRecords],
  );

  function clearFilters() {
    setSearch("");
    setSurface("All");
    setUsage("All");
    setFootpath("All");
  }

  return (
    <div className="dashboard-page">
      <section className="dashboard-page-heading">
        <div>
          <span>Road infrastructure</span>
          <h2>Road network assessment</h2>
          <p>
            Understand road length, width, surface, footpath availability and
            underground-drainage status in simple terms.
          </p>
        </div>

        <div className="page-record-badge">
          Showing {dashboard.totalRoads} of {allRecords.length} roads
        </div>
      </section>

      <section className="dashboard-filter-panel" aria-label="Road filters">
        <label>
          <span>Search road</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Example: Cross Road 18"
            type="search"
            value={search}
          />
        </label>

        <label>
          <span>Road surface</span>
          <select onChange={(event) => setSurface(event.target.value)} value={surface}>
            <option value="All">All surfaces</option>
            {surfaceOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Road usage</span>
          <select onChange={(event) => setUsage(event.target.value)} value={usage}>
            <option value="All">All usage types</option>
            {usageOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Footpath record</span>
          <select onChange={(event) => setFootpath(event.target.value)} value={footpath}>
            <option value="All">All footpath records</option>
            {footpathOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <button className="clear-filter-button" onClick={clearFilters} type="button">
          Clear filters
        </button>
      </section>

      <section className="road-kpi-grid" aria-label="Road summary">
        <KpiCard
          icon="━"
          label="Roads shown"
          value={dashboard.totalRoads}
          helper="Road records matching the current filters"
        />
        <KpiCard
          icon="↔"
          label="Network length"
          value={`${(dashboard.totalLengthMetres / 1000).toFixed(2)} km`}
          helper="Combined surveyed road length"
        />
        <KpiCard
          icon="⇔"
          label="Average width"
          value={`${dashboard.averageWidthMetres.toFixed(1)} m`}
          helper="Average recorded carriageway width"
        />
        <KpiCard
          icon="⚠"
          label="Without footpath"
          value={dashboard.roadsWithoutFootpath}
          helper="Roads recorded without a usable footpath"
          tone="warning"
        />
        <KpiCard
          icon="✓"
          label="UGD complete"
          value={dashboard.ugdComplete}
          helper="Roads marked with complete UGD status"
          tone="success"
        />
        <KpiCard
          icon="★"
          label="Widest road"
          value={displayWidth(dashboard.widestRoad?.width ?? null)}
          helper={dashboard.widestRoad?.name ?? "No width recorded"}
        />
      </section>

      {dashboard.totalRoads === 0 ? (
        <section className="empty-result-panel">
          <strong>No roads match the selected filters</strong>
          <p>Clear one or more filters to display the road analysis again.</p>
          <button onClick={clearFilters} type="button">Reset filters</button>
        </section>
      ) : (
        <>
          <section className="dashboard-section-heading">
            <div>
              <span>Road accessibility</span>
              <h2>Width and footpath availability</h2>
            </div>
            <p>
              These charts quickly show whether roads are wide enough and
              whether a footpath is available for pedestrians.
            </p>
          </section>

          <section className="dashboard-chart-grid">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Carriageway width</span>
                  <h3>Roads grouped by width</h3>
                </div>
              </div>

              <div className="chart-container">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart data={dashboard.widthDistribution} margin={{ top: 8, right: 12, bottom: 10, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" interval={0} tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip formatter={formatCountTooltip} />
                    <Bar dataKey="count" fill="#287d6b" radius={[7, 7, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Pedestrian access</span>
                  <h3>Footpath availability</h3>
                </div>
              </div>

              <div className="chart-container chart-container--donut">
                <ResponsiveContainer height="100%" width="100%">
                  <PieChart>
                    <Pie
                      data={dashboard.footpathDistribution}
                      dataKey="count"
                      nameKey="name"
                      innerRadius={68}
                      outerRadius={106}
                      paddingAngle={2}
                    >
                      {dashboard.footpathDistribution.map((entry, index) => (
                        <Cell key={entry.name} fill={CHART_COLOURS[index % CHART_COLOURS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={formatCountTooltip} />
                    <Legend verticalAlign="bottom" height={42} />
                  </PieChart>
                </ResponsiveContainer>

                <div className="donut-centre" aria-hidden="true">
                  <strong>{dashboard.totalRoads}</strong>
                  <span>roads</span>
                </div>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Network priority</span>
              <h2>Longest surveyed roads</h2>
            </div>
            <p>
              Longer roads generally affect more residents and may need higher
              priority during maintenance planning.
            </p>
          </section>

          <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Top 10</span>
                  <h3>Road length comparison</h3>
                </div>
              </div>

              <div className="chart-container chart-container--road-length">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart
                    data={dashboard.topRoadsByLength}
                    layout="vertical"
                    margin={{ top: 4, right: 20, bottom: 4, left: 18 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis type="number" unit=" m" />
                    <YAxis dataKey="name" type="category" width={118} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={formatLengthTooltip} />
                    <Bar dataKey="length" fill="#4478a8" radius={[0, 7, 7, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="dashboard-panel road-highlight-panel">
              <div>
                <span>Longest road</span>
                <strong>{dashboard.longestRoad?.name ?? "Not available"}</strong>
                <p>
                  {dashboard.longestRoad
                    ? `${dashboard.longestRoad.length.toFixed(1)} metres of surveyed road length.`
                    : "No road length is available."}
                </p>
              </div>

              <div>
                <span>Footpath coverage</span>
                <strong>
                  {dashboard.totalRoads === 0
                    ? "0%"
                    : `${Math.round((dashboard.roadsWithFootpath / dashboard.totalRoads) * 100)}%`}
                </strong>
                <p>
                  {dashboard.roadsWithFootpath} of {dashboard.totalRoads} roads have a recorded footpath.
                </p>
              </div>

              <div>
                <span>UGD coverage</span>
                <strong>
                  {dashboard.totalRoads === 0
                    ? "0%"
                    : `${Math.round((dashboard.ugdComplete / dashboard.totalRoads) * 100)}%`}
                </strong>
                <p>
                  Roads whose underground drainage status is marked complete.
                </p>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Road register</span>
              <h2>Detailed road information</h2>
            </div>
            <p>
              A simple table for reviewing individual roads without opening
              technical GIS fields.
            </p>
          </section>

          <section className="road-table-panel">
            <div className="road-table-scroller">
              <table className="road-table">
                <thead>
                  <tr>
                    <th>Road name</th>
                    <th>Surface</th>
                    <th>Usage</th>
                    <th>Width</th>
                    <th>Length</th>
                    <th>Footpath</th>
                    <th>UGD status</th>
                    <th>Map</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.records.map((record) => (
                    <tr key={record.id}>
                      <td><strong>{record.name}</strong></td>
                      <td>{record.surface}</td>
                      <td>{record.usage}</td>
                      <td>{displayWidth(record.width)}</td>
                      <td>{record.length.toFixed(1)} m</td>
                      <td>
                        <span className={`table-status ${
                          record.footpath.toLowerCase().startsWith("yes")
                            ? "table-status--good"
                            : "table-status--warning"
                        }`}>
                          {record.footpath}
                        </span>
                      </td>
                      <td>
                        <span className="table-status table-status--good">
                          {record.ugdStatus}
                        </span>
                      </td>
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
