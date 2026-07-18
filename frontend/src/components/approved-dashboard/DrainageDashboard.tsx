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
  calculateDrainageDashboard,
  prepareDrainNetworkRecords,
  prepareDrainObservationRecords,
  type DrainConditionGroup,
  type DrainObservationRecord,
} from "../../lib/approved-dashboard/drainageDashboardCalculations";
import type { GisWorkbookData } from "../../lib/approved-dashboard/gisTypes";
import { KpiCard } from "./KpiCard";

type DrainageDashboardProps = {
  data: GisWorkbookData;
};

const NETWORK_COLOURS = ["#3f7cac", "#22a07a"];
const CONDITION_COLOURS: Record<DrainConditionGroup, string> = {
  Good: "#1f9a6d",
  Fair: "#e2a326",
  "Needs attention": "#d84b4b",
  "Not recorded": "#8a95a7",
};

function uniqueValues(
  records: DrainObservationRecord[],
  key: "conditionGroup" | "pipeType",
): string[] {
  return Array.from(new Set(records.map((record) => record[key]))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function formatCountTooltip(value: unknown): [string, string] {
  return [Number(value ?? 0).toLocaleString("en-IN"), "Observations"];
}

function formatLengthTooltip(value: unknown): [string, string] {
  return [`${Number(value ?? 0).toLocaleString("en-IN")} m`, "Drain length"];
}

function statusClass(condition: DrainConditionGroup): string {
  if (condition === "Good") {
    return "table-status table-status--good";
  }

  if (condition === "Needs attention") {
    return "table-status table-status--danger";
  }

  if (condition === "Fair") {
    return "table-status table-status--warning";
  }

  return "table-status";
}

export function DrainageDashboard({ data }: DrainageDashboardProps) {
  const allNetworkRecords = useMemo(
    () => prepareDrainNetworkRecords(data.SWD),
    [data],
  );
  const allObservationRecords = useMemo(
    () => prepareDrainObservationRecords(data.Drain_Levels),
    [data],
  );

  const [search, setSearch] = useState("");
  const [networkType, setNetworkType] = useState("All");
  const [condition, setCondition] = useState("All");
  const [pipeType, setPipeType] = useState("All");

  const networkTypeOptions = useMemo(
    () => Array.from(new Set(allNetworkRecords.map((record) => record.type))).sort(),
    [allNetworkRecords],
  );
  const conditionOptions = useMemo(
    () => uniqueValues(allObservationRecords, "conditionGroup"),
    [allObservationRecords],
  );
  const pipeTypeOptions = useMemo(
    () => uniqueValues(allObservationRecords, "pipeType"),
    [allObservationRecords],
  );

  const filteredNetworkRecords = useMemo(
    () =>
      allNetworkRecords.filter(
        (record) => networkType === "All" || record.type === networkType,
      ),
    [allNetworkRecords, networkType],
  );

  const filteredObservationRecords = useMemo(() => {
    const query = search.trim().toLowerCase();

    return allObservationRecords.filter((record) => {
      const matchesSearch =
        query.length === 0 ||
        record.roadName.toLowerCase().includes(query) ||
        record.condition.toLowerCase().includes(query) ||
        record.widthDepth.toLowerCase().includes(query) ||
        record.pipeDiameter.toLowerCase().includes(query);

      return (
        matchesSearch &&
        (condition === "All" || record.conditionGroup === condition) &&
        (pipeType === "All" || record.pipeType === pipeType)
      );
    });
  }, [allObservationRecords, condition, pipeType, search]);

  const dashboard = useMemo(
    () =>
      calculateDrainageDashboard(
        filteredNetworkRecords,
        filteredObservationRecords,
      ),
    [filteredNetworkRecords, filteredObservationRecords],
  );

  function clearFilters() {
    setSearch("");
    setNetworkType("All");
    setCondition("All");
    setPipeType("All");
  }

  const hasResults =
    dashboard.totalNetworkSegments > 0 || dashboard.totalObservations > 0;

  return (
    <div className="dashboard-page">
      <section className="dashboard-page-heading">
        <div>
          <span>Drainage infrastructure</span>
          <h2>Storm-water drainage assessment</h2>
          <p>
            Review the drain network, open and closed sections, field
            condition, silt observations and missing inspection information.
          </p>
        </div>

        <div className="page-record-badge">
          {dashboard.totalNetworkSegments} drain segments · {dashboard.totalObservations}{" "}
          field observations
        </div>
      </section>

      <section className="dashboard-filter-panel dashboard-filter-panel--drainage" aria-label="Drainage filters">
        <label>
          <span>Search road or observation</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Example: Cross Road 15"
            type="search"
            value={search}
          />
        </label>

        <label>
          <span>Network type</span>
          <select
            onChange={(event) => setNetworkType(event.target.value)}
            value={networkType}
          >
            <option value="All">All drain types</option>
            {networkTypeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Condition</span>
          <select
            onChange={(event) => setCondition(event.target.value)}
            value={condition}
          >
            <option value="All">All conditions</option>
            {conditionOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Pipe type</span>
          <select
            onChange={(event) => setPipeType(event.target.value)}
            value={pipeType}
          >
            <option value="All">All pipe types</option>
            {pipeTypeOptions.map((option) => (
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

      <section className="road-kpi-grid drainage-kpi-grid" aria-label="Drainage summary">
        <KpiCard
          icon="≋"
          label="Drain segments"
          value={dashboard.totalNetworkSegments}
          helper="Open and closed storm-water drain sections"
        />
        <KpiCard
          icon="↔"
          label="Network length"
          value={`${(dashboard.totalNetworkLengthMetres / 1000).toFixed(2)} km`}
          helper="Combined length of the selected drain network"
        />
        <KpiCard
          icon="▤"
          label="Field observations"
          value={dashboard.totalObservations}
          helper="Drain-level condition inspection points"
        />
        <KpiCard
          icon="✓"
          label="Good condition"
          value={dashboard.goodObservations}
          helper="Observations currently recorded as good"
          tone="success"
        />
        <KpiCard
          icon="!"
          label="Needs attention"
          value={dashboard.attentionObservations}
          helper="Bad, blocked or poor-condition observations"
          tone="danger"
        />
        <KpiCard
          icon="≈"
          label="Silt detected"
          value={dashboard.siltPresent}
          helper="Locations with a recorded silt level"
          tone={dashboard.siltPresent > 0 ? "warning" : "success"}
        />
      </section>

      {!hasResults ? (
        <section className="empty-result-panel">
          <strong>No drainage records match the selected filters</strong>
          <p>Clear one or more filters to display the drainage analysis.</p>
          <button onClick={clearFilters} type="button">
            Reset filters
          </button>
        </section>
      ) : (
        <>
          <section className="dashboard-section-heading">
            <div>
              <span>Drain network</span>
              <h2>Open and closed drainage coverage</h2>
            </div>
            <p>
              Closed drains form most of the mapped network. Open drains are
              shown separately because they may need different maintenance and
              safety planning.
            </p>
          </section>

          <section className="dashboard-chart-grid">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Network composition</span>
                  <h3>Drain length by type</h3>
                </div>
              </div>

              <div className="chart-container chart-container--donut">
                <ResponsiveContainer height="100%" width="100%">
                  <PieChart>
                    <Pie
                      data={dashboard.networkTypeDistribution}
                      dataKey="length"
                      nameKey="name"
                      innerRadius={70}
                      outerRadius={108}
                      paddingAngle={2}
                    >
                      {dashboard.networkTypeDistribution.map((entry, index) => (
                        <Cell
                          fill={NETWORK_COLOURS[index % NETWORK_COLOURS.length]}
                          key={entry.name}
                        />
                      ))}
                    </Pie>
                    <Tooltip formatter={formatLengthTooltip} />
                    <Legend verticalAlign="bottom" height={44} />
                  </PieChart>
                </ResponsiveContainer>

                <div className="donut-centre" aria-hidden="true">
                  <strong>
                    {(dashboard.totalNetworkLengthMetres / 1000).toFixed(2)}
                  </strong>
                  <span>km mapped</span>
                </div>
              </div>
            </article>

            <article className="dashboard-panel drainage-network-summary">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Simple network summary</span>
                  <h3>What the survey shows</h3>
                </div>
              </div>

              <div className="drainage-summary-list">
                <div>
                  <span className="drainage-summary-icon drainage-summary-icon--closed">■</span>
                  <p>
                    <strong>{dashboard.closedSegments} closed segments</strong>
                    <span>
                      {(dashboard.closedLengthMetres / 1000).toFixed(2)} km of
                      enclosed drainage network
                    </span>
                  </p>
                </div>

                <div>
                  <span className="drainage-summary-icon drainage-summary-icon--open">═</span>
                  <p>
                    <strong>{dashboard.openSegments} open segments</strong>
                    <span>
                      {(dashboard.openLengthMetres / 1000).toFixed(2)} km of
                      exposed drainage network
                    </span>
                  </p>
                </div>

                <div>
                  <span className="drainage-summary-icon">↔</span>
                  <p>
                    <strong>Longest mapped segment</strong>
                    <span>
                      {dashboard.longestSegment
                        ? `${dashboard.longestSegment.length.toFixed(1)} m · ${dashboard.longestSegment.type}`
                        : "Not available"}
                    </span>
                  </p>
                </div>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Field condition</span>
              <h2>Drain health and priority roads</h2>
            </div>
            <p>
              Condition observations identify roads with good drainage and
              locations that require inspection or cleaning.
            </p>
          </section>

          <section className="dashboard-chart-grid">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Condition classes</span>
                  <h3>Drain observations by condition</h3>
                </div>
              </div>

              <div className="chart-container">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart
                    data={dashboard.conditionDistribution}
                    margin={{ top: 8, right: 12, bottom: 10, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" interval={0} tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip formatter={formatCountTooltip} />
                    <Bar dataKey="count" radius={[7, 7, 0, 0]}>
                      {dashboard.conditionDistribution.map((entry) => (
                        <Cell
                          fill={CONDITION_COLOURS[entry.name as DrainConditionGroup]}
                          key={entry.name}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Road-wise checks</span>
                  <h3>Where observations were recorded</h3>
                </div>
              </div>

              <div className="chart-container chart-container--drain-roads">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart
                    data={dashboard.roadDistribution}
                    layout="vertical"
                    margin={{ top: 4, right: 18, bottom: 4, left: 14 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis allowDecimals={false} type="number" />
                    <YAxis dataKey="name" type="category" width={112} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={formatCountTooltip} />
                    <Legend />
                    <Bar dataKey="count" fill="#3f7cac" name="All observations" radius={[0, 6, 6, 0]} />
                    <Bar dataKey="issues" fill="#d84b4b" name="Needs attention" radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Inspection quality</span>
              <h2>Data completeness and action list</h2>
            </div>
            <p>
              Missing levels, dimensions and photographs should be completed
              before detailed engineering decisions are made.
            </p>
          </section>

          <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Available survey information</span>
                  <h3>Field completeness</h3>
                </div>
              </div>

              <div className="completeness-list">
                {dashboard.completeness.map((item) => (
                  <div className="completeness-item" key={item.label}>
                    <div className="completeness-item__label">
                      <strong>{item.label}</strong>
                      <span>
                        {item.complete}/{item.total} · {item.percentage}%
                      </span>
                    </div>
                    <div className="completeness-item__track">
                      <span style={{ width: `${item.percentage}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="dashboard-panel drainage-action-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Maintenance attention</span>
                  <h3>Locations to check first</h3>
                </div>
              </div>

              {dashboard.attentionRecords.length === 0 ? (
                <div className="drainage-all-clear">
                  <span>✓</span>
                  <strong>No priority drain observations</strong>
                  <p>The filtered records contain no bad condition or silt entry.</p>
                </div>
              ) : (
                <div className="drainage-action-list">
                  {dashboard.attentionRecords.slice(0, 8).map((record) => (
                    <div key={record.id}>
                      <span className="drainage-action-marker">!</span>
                      <p>
                        <strong>{record.roadName}</strong>
                        <span>
                          {record.conditionGroup === "Needs attention"
                            ? record.condition
                            : "Silt level recorded"}
                        </span>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Drain inspection register</span>
              <h2>Detailed field observations</h2>
            </div>
            <p>
              A simplified table showing the information that matters to
              engineers, officers and field teams.
            </p>
          </section>

          <section className="road-table-panel">
            <div className="road-table-scroller">
              <table className="road-table drainage-table">
                <thead>
                  <tr>
                    <th>Road / location</th>
                    <th>Condition</th>
                    <th>Top level</th>
                    <th>Bottom level</th>
                    <th>Silt</th>
                    <th>Width × depth</th>
                    <th>Pipe diameter</th>
                    <th>Pipe type</th>
                    <th>Image</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.observationRecords.map((record) => (
                    <tr key={record.id}>
                      <td><strong>{record.roadName}</strong></td>
                      <td>
                        <span className={statusClass(record.conditionGroup)}>
                          {record.conditionGroup}
                        </span>
                      </td>
                      <td>{record.topLevel}</td>
                      <td>{record.bottomLevel}</td>
                      <td>
                        <span
                          className={
                            record.siltStatus === "Silt present"
                              ? "table-status table-status--warning"
                              : "table-status table-status--good"
                          }
                        >
                          {record.siltStatus}
                        </span>
                      </td>
                      <td>{record.widthDepth}</td>
                      <td>{record.pipeDiameter}</td>
                      <td>{record.pipeType}</td>
                      <td>{record.image}</td>
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
