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
  calculateManholeDashboard,
  prepareManholeRecords,
  type ManholeConditionGroup,
  type ManholeRecord,
} from "../../lib/approved-dashboard/manholeDashboardCalculations";
import type { GisWorkbookData } from "../../lib/approved-dashboard/gisTypes";
import { KpiCard } from "./KpiCard";

type ManholeDashboardProps = {
  data: GisWorkbookData;
};

const CONDITION_COLOURS: Record<ManholeConditionGroup, string> = {
  Good: "#1f9a6d",
  Fair: "#e2a326",
  "Needs attention": "#d84b4b",
  "Not recorded": "#8a95a7",
};

const PIPE_COLOURS = [
  "#237b68",
  "#4478a8",
  "#d59a27",
  "#8a66b4",
  "#c45a74",
  "#5b8f4e",
  "#68788d",
];

function uniqueValues(
  records: ManholeRecord[],
  key: "conditionGroup" | "pipeType" | "diameter",
): string[] {
  return Array.from(new Set(records.map((record) => record[key]))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function formatCountTooltip(value: unknown): [string, string] {
  return [Number(value ?? 0).toLocaleString("en-IN"), "Manholes"];
}

function conditionClass(condition: ManholeConditionGroup): string {
  if (condition === "Good") {
    return "table-status table-status--good";
  }

  if (condition === "Fair") {
    return "table-status table-status--warning";
  }

  if (condition === "Needs attention") {
    return "table-status table-status--danger";
  }

  return "table-status";
}

function formatDepth(record: ManholeRecord): string {
  if (record.depth === "Not recorded") {
    return record.depth;
  }

  return record.depthNeedsVerification
    ? `${record.depth} · verify`
    : record.depth;
}

export function ManholeDashboard({ data }: ManholeDashboardProps) {
  const allRecords = useMemo(() => prepareManholeRecords(data.Manhole), [data]);

  const [search, setSearch] = useState("");
  const [condition, setCondition] = useState("All");
  const [pipeType, setPipeType] = useState("All");
  const [diameter, setDiameter] = useState("All");

  const conditionOptions = useMemo(
    () => uniqueValues(allRecords, "conditionGroup"),
    [allRecords],
  );
  const pipeTypeOptions = useMemo(
    () => uniqueValues(allRecords, "pipeType"),
    [allRecords],
  );
  const diameterOptions = useMemo(
    () => uniqueValues(allRecords, "diameter"),
    [allRecords],
  );

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();

    return allRecords.filter((record) => {
      const matchesSearch =
        query.length === 0 ||
        record.roadName.toLowerCase().includes(query) ||
        record.condition.toLowerCase().includes(query) ||
        record.pipeType.toLowerCase().includes(query) ||
        record.diameter.toLowerCase().includes(query) ||
        record.depth.toLowerCase().includes(query) ||
        record.id.toLowerCase().includes(query);

      return (
        matchesSearch &&
        (condition === "All" || record.conditionGroup === condition) &&
        (pipeType === "All" || record.pipeType === pipeType) &&
        (diameter === "All" || record.diameter === diameter)
      );
    });
  }, [allRecords, condition, diameter, pipeType, search]);

  const dashboard = useMemo(
    () => calculateManholeDashboard(filteredRecords),
    [filteredRecords],
  );

  function clearFilters() {
    setSearch("");
    setCondition("All");
    setPipeType("All");
    setDiameter("All");
  }

  return (
    <div className="dashboard-page">
      <section className="dashboard-page-heading">
        <div>
          <span>Underground drainage assets</span>
          <h2>Manhole condition and maintenance dashboard</h2>
          <p>
            Review manhole condition, road-wise concentration, depth, pipe
            details, inspection coverage and locations requiring attention.
          </p>
        </div>

        <div className="page-record-badge">
          {dashboard.totalManholes} manholes shown
        </div>
      </section>

      <section
        aria-label="Manhole filters"
        className="dashboard-filter-panel dashboard-filter-panel--manholes"
      >
        <label>
          <span>Search road or manhole</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Example: Kalikadevi Road"
            type="search"
            value={search}
          />
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

        <label>
          <span>Diameter</span>
          <select
            onChange={(event) => setDiameter(event.target.value)}
            value={diameter}
          >
            <option value="All">All diameters</option>
            {diameterOptions.map((option) => (
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

      <section className="road-kpi-grid manhole-kpi-grid" aria-label="Manhole summary">
        <KpiCard
          helper="Manholes matching the current filters"
          icon="◉"
          label="Manholes shown"
          value={dashboard.totalManholes}
        />
        <KpiCard
          helper="Assets currently recorded in good condition"
          icon="✓"
          label="Good condition"
          tone="success"
          value={dashboard.goodManholes}
        />
        <KpiCard
          helper="Bad, blocked, sludge-affected or poor records"
          icon="!"
          label="Needs attention"
          tone="danger"
          value={dashboard.attentionManholes}
        />
        <KpiCard
          helper="Manholes whose condition has not been entered"
          icon="?"
          label="Not assessed"
          tone="warning"
          value={dashboard.unassessedManholes}
        />
        <KpiCard
          helper="Manholes with a recorded depth value"
          icon="↕"
          label="Depth recorded"
          value={dashboard.depthRecorded}
        />
        <KpiCard
          helper="Manholes linked to a field image number"
          icon="▣"
          label="Images recorded"
          value={dashboard.imagesRecorded}
        />
      </section>

      {dashboard.totalManholes === 0 ? (
        <section className="empty-result-panel">
          <strong>No manholes match the selected filters</strong>
          <p>Clear one or more filters to display the manhole analysis.</p>
          <button onClick={clearFilters} type="button">
            Reset filters
          </button>
        </section>
      ) : (
        <>
          <section className="dashboard-section-heading">
            <div>
              <span>Condition overview</span>
              <h2>What is the present manhole status?</h2>
            </div>
            <p>
              Green records are serviceable, while red records require field
              attention. Grey records have no condition entered yet.
            </p>
          </section>

          <section className="dashboard-chart-grid">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Condition split</span>
                  <h3>Manholes by condition</h3>
                </div>
              </div>

              <div className="chart-container chart-container--donut">
                <ResponsiveContainer height="100%" width="100%">
                  <PieChart>
                    <Pie
                      data={dashboard.conditionDistribution}
                      dataKey="count"
                      innerRadius={70}
                      nameKey="name"
                      outerRadius={108}
                      paddingAngle={2}
                    >
                      {dashboard.conditionDistribution.map((entry) => (
                        <Cell
                          fill={
                            CONDITION_COLOURS[
                              entry.name as ManholeConditionGroup
                            ] ?? "#8a95a7"
                          }
                          key={entry.name}
                        />
                      ))}
                    </Pie>
                    <Tooltip formatter={formatCountTooltip} />
                    <Legend height={44} verticalAlign="bottom" />
                  </PieChart>
                </ResponsiveContainer>

                <div aria-hidden="true" className="donut-centre">
                  <strong>{dashboard.totalManholes}</strong>
                  <span>manholes</span>
                </div>
              </div>
            </article>

            <article className="dashboard-panel manhole-condition-summary">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Immediate reading</span>
                  <h3>Condition summary</h3>
                </div>
              </div>

              <div className="manhole-summary-list">
                <div>
                  <span className="manhole-summary-icon manhole-summary-icon--good">✓</span>
                  <p>
                    <strong>{dashboard.goodManholes} good manholes</strong>
                    <span>Recorded as serviceable during the survey.</span>
                  </p>
                </div>
                <div>
                  <span className="manhole-summary-icon manhole-summary-icon--danger">!</span>
                  <p>
                    <strong>{dashboard.attentionManholes} need attention</strong>
                    <span>Blocked, bad or sludge-affected manholes.</span>
                  </p>
                </div>
                <div>
                  <span className="manhole-summary-icon manhole-summary-icon--unknown">?</span>
                  <p>
                    <strong>{dashboard.unassessedManholes} not assessed</strong>
                    <span>Condition needs to be checked or entered.</span>
                  </p>
                </div>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Location and network</span>
              <h2>Where are manholes concentrated?</h2>
            </div>
            <p>
              Road-wise totals help field teams plan inspections, cleaning and
              maintenance street by street.
            </p>
          </section>

          <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Top roads</span>
                  <h3>Manholes by road</h3>
                </div>
              </div>

              <div className="chart-container chart-container--manhole-roads">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart
                    data={dashboard.roadDistribution.slice(0, 10)}
                    layout="vertical"
                    margin={{ top: 4, right: 20, bottom: 4, left: 18 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis allowDecimals={false} type="number" />
                    <YAxis
                      dataKey="name"
                      tick={{ fontSize: 11 }}
                      type="category"
                      width={120}
                    />
                    <Tooltip formatter={formatCountTooltip} />
                    <Bar dataKey="count" fill="#4478a8" radius={[0, 7, 7, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Pipe connection</span>
                  <h3>Recorded pipe types</h3>
                </div>
              </div>

              <div className="chart-container chart-container--donut">
                <ResponsiveContainer height="100%" width="100%">
                  <PieChart>
                    <Pie
                      data={dashboard.pipeTypeDistribution}
                      dataKey="count"
                      innerRadius={66}
                      nameKey="name"
                      outerRadius={102}
                      paddingAngle={2}
                    >
                      {dashboard.pipeTypeDistribution.map((entry, index) => (
                        <Cell
                          fill={PIPE_COLOURS[index % PIPE_COLOURS.length]}
                          key={entry.name}
                        />
                      ))}
                    </Pie>
                    <Tooltip formatter={formatCountTooltip} />
                    <Legend height={52} verticalAlign="bottom" />
                  </PieChart>
                </ResponsiveContainer>

                <div aria-hidden="true" className="donut-centre">
                  <strong>{dashboard.pipeTypeRecorded}</strong>
                  <span>pipe records</span>
                </div>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Survey completeness</span>
              <h2>Which manhole details are still missing?</h2>
            </div>
            <p>
              These indicators show which fields are ready for analysis and
              which require additional field verification.
            </p>
          </section>

          <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Recorded fields</span>
                  <h3>Data completeness</h3>
                </div>
              </div>

              <div className="manhole-completeness-list">
                {dashboard.completeness.map((item) => (
                  <div key={item.label}>
                    <div>
                      <strong>{item.label}</strong>
                      <span>
                        {item.complete} of {item.total} · {item.percentage}%
                      </span>
                    </div>
                    <div className="manhole-progress-track">
                      <span style={{ width: `${item.percentage}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="dashboard-panel manhole-depth-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Depth review</span>
                  <h3>Recorded depth information</h3>
                </div>
              </div>

              <div className="manhole-depth-stat">
                <span>Average plausible depth</span>
                <strong>{dashboard.averageDepthFeet.toFixed(2)} ft</strong>
                <p>
                  Calculated from positive recorded values up to 25 feet, so a
                  possible typing outlier does not distort the average.
                </p>
              </div>

              <div className="manhole-depth-warning">
                <span>!</span>
                <p>
                  <strong>{dashboard.depthVerificationCount} depth value needs verification</strong>
                  <small>Check unusually large or invalid field entries before final reporting.</small>
                </p>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Maintenance priority</span>
              <h2>Manholes requiring attention</h2>
            </div>
            <p>
              This list brings bad, blocked and sludge-affected records to the
              top for field action.
            </p>
          </section>

          <section className="dashboard-panel manhole-attention-panel">
            {dashboard.attentionRecords.length > 0 ? (
              <div className="manhole-attention-grid">
                {dashboard.attentionRecords.map((record) => (
                  <div key={record.id}>
                    <span className="manhole-attention-marker">!</span>
                    <p>
                      <strong>{record.roadName}</strong>
                      <span>{record.condition}</span>
                      <small>
                        Depth: {formatDepth(record)} · Diameter: {record.diameter}
                      </small>
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="drainage-all-clear">
                <span>✓</span>
                <strong>No attention records in the selected view</strong>
                <p>Change or clear the filters to review other manholes.</p>
              </div>
            )}
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Manhole register</span>
              <h2>Detailed manhole information</h2>
            </div>
            <p>
              Review individual assets in simple language before connecting
              this dashboard to the software map.
            </p>
          </section>

          <section className="road-table-panel">
            <div className="road-table-scroller">
              <table className="road-table manhole-table">
                <thead>
                  <tr>
                    <th>Manhole ID</th>
                    <th>Road</th>
                    <th>Condition</th>
                    <th>Depth</th>
                    <th>Diameter</th>
                    <th>Pipe type</th>
                    <th>Top level</th>
                    <th>Bottom level</th>
                    <th>Image</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.records.map((record) => (
                    <tr key={record.id}>
                      <td><strong>{record.id}</strong></td>
                      <td>{record.roadName}</td>
                      <td>
                        <span className={conditionClass(record.conditionGroup)}>
                          {record.condition}
                        </span>
                      </td>
                      <td>
                        <span
                          className={
                            record.depthNeedsVerification
                              ? "table-status table-status--danger"
                              : ""
                          }
                        >
                          {formatDepth(record)}
                        </span>
                      </td>
                      <td>{record.diameter}</td>
                      <td>{record.pipeType}</td>
                      <td>{record.topLevel}</td>
                      <td>{record.bottomLevel}</td>
                      <td>{record.imageNumber}</td>
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
