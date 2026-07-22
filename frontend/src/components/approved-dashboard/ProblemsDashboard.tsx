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
  calculateProblemsDashboard,
  prepareProblemRecords,
  type ProblemPriority,
  type ProblemRecordGroup,
} from "../../lib/approved-dashboard/problemsDashboardCalculations";
import type { GisWorkbookData } from "../../lib/approved-dashboard/gisTypes";
import { KpiCard } from "./KpiCard";

type ProblemsDashboardProps = {
  data: GisWorkbookData;
};

const ACTION_COLOURS = ["#d14b4b", "#d99120", "#4779a8", "#21836d"];
const PRIORITY_COLOURS: Record<ProblemPriority, string> = {
  Critical: "#c93e3e",
  High: "#df9220",
  "Survey follow-up": "#6b7b90",
};

function countTooltip(value: unknown): [string, string] {
  return [Number(value ?? 0).toLocaleString("en-IN"), "Affected records"];
}

function uniqueValues<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function priorityClass(priority: ProblemPriority): string {
  if (priority === "Critical") {
    return "problem-priority problem-priority--critical";
  }

  if (priority === "High") {
    return "problem-priority problem-priority--high";
  }

  return "problem-priority problem-priority--follow-up";
}

function groupClass(group: ProblemRecordGroup): string {
  return group === "Known issue"
    ? "problem-group problem-group--issue"
    : "problem-group problem-group--gap";
}

export function ProblemsDashboard({ data }: ProblemsDashboardProps) {
  const allRecords = useMemo(() => prepareProblemRecords(data), [data]);

  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("All");
  const [assetType, setAssetType] = useState("All");
  const [priority, setPriority] = useState("All");

  const groupOptions = useMemo(
    () => uniqueValues(allRecords.map((record) => record.group)),
    [allRecords],
  );
  const assetOptions = useMemo(
    () => uniqueValues(allRecords.map((record) => record.assetType)),
    [allRecords],
  );
  const priorityOptions = useMemo(
    () => uniqueValues(allRecords.map((record) => record.priority)),
    [allRecords],
  );

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();

    return allRecords.filter((record) => {
      const matchesSearch =
        query.length === 0 ||
        record.location.toLowerCase().includes(query) ||
        record.issue.toLowerCase().includes(query) ||
        record.recommendation.toLowerCase().includes(query) ||
        record.assetType.toLowerCase().includes(query);

      return (
        matchesSearch &&
        (group === "All" || record.group === group) &&
        (assetType === "All" || record.assetType === assetType) &&
        (priority === "All" || record.priority === priority)
      );
    });
  }, [allRecords, assetType, group, priority, search]);

  const dashboard = useMemo(
    () => calculateProblemsDashboard(filteredRecords, data),
    [data, filteredRecords],
  );
  const completeDashboard = useMemo(
    () => calculateProblemsDashboard(allRecords, data),
    [allRecords, data],
  );

  const actionRecords = filteredRecords.filter(
    (record) => record.group === "Known issue",
  );
  const gapRecords = filteredRecords.filter((record) => record.group === "Data gap");

  function clearFilters() {
    setSearch("");
    setGroup("All");
    setAssetType("All");
    setPriority("All");
  }

  return (
    <div className="dashboard-page">
      <section className="dashboard-page-heading">
        <div>
          <span>Action and verification dashboard</span>
          <h2>Problems, priorities and survey gaps</h2>
          <p>
            Separate known infrastructure issues from missing survey information
            so field teams can act on defects without confusing them with data
            completion work.
          </p>
        </div>

        <div className="page-record-badge">
          {filteredRecords.length.toLocaleString("en-IN")} of{" "}
          {allRecords.length.toLocaleString("en-IN")} issue groups shown
        </div>
      </section>

      <section className="dashboard-filter-panel dashboard-filter-panel--problems">
        <label>
          <span>Search road, issue or action</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Example: Cross Road 18 or blocked"
            type="search"
            value={search}
          />
        </label>

        <label>
          <span>Record group</span>
          <select onChange={(event) => setGroup(event.target.value)} value={group}>
            <option value="All">Known issues and data gaps</option>
            {groupOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Asset type</span>
          <select
            onChange={(event) => setAssetType(event.target.value)}
            value={assetType}
          >
            <option value="All">All asset types</option>
            {assetOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Priority</span>
          <select
            onChange={(event) => setPriority(event.target.value)}
            value={priority}
          >
            <option value="All">All priorities</option>
            {priorityOptions.map((option) => (
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

      {filteredRecords.length === 0 ? (
        <section className="empty-result-panel">
          <strong>No problems or data gaps match these filters</strong>
          <p>Clear the filters to return to the complete action register.</p>
          <button onClick={clearFilters} type="button">
            Show all records
          </button>
        </section>
      ) : (
        <>
          <section className="problems-kpi-grid" aria-label="Problem summary">
            <KpiCard
              helper="Road, manhole and drain records that need action"
              icon="!"
              label="Known action items"
              tone="danger"
              value={dashboard.knownActionItems}
            />
            <KpiCard
              helper="Blocked manholes requiring immediate inspection"
              icon="×"
              label="Critical items"
              tone="danger"
              value={dashboard.criticalItems}
            />
            <KpiCard
              helper="Surveyed roads without a recorded footpath"
              icon="▥"
              label="Roads without footpath"
              tone="warning"
              value={dashboard.roadsWithoutFootpath}
            />
            <KpiCard
              helper="Bad, blocked or sludge-affected manholes"
              icon="◉"
              label="Manholes needing attention"
              tone="warning"
              value={dashboard.manholesNeedingAttention}
            />
            <KpiCard
              helper="Drain observations recorded in bad condition"
              icon="≋"
              label="Drain issues"
              tone="warning"
              value={dashboard.drainsNeedingAttention}
            />
            <KpiCard
              helper="Separate categories of missing survey information"
              icon="?"
              label="Data-gap categories"
              value={dashboard.dataGapRecords.length}
            />
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Action picture</span>
              <h2>Where should attention go first?</h2>
            </div>
            <p>
              Known issues are counted separately from survey gaps. This avoids
              presenting missing information as if it were a confirmed defect.
            </p>
          </section>

          <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Known action items</span>
                  <h3>Issues by infrastructure type</h3>
                </div>
              </div>

              <div className="chart-container chart-container--problem-actions">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart
                    data={dashboard.actionDistribution}
                    layout="vertical"
                    margin={{ bottom: 8, left: 18, right: 22, top: 8 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis allowDecimals={false} type="number" />
                    <YAxis
                      dataKey="name"
                      interval={0}
                      tick={{ fontSize: 12 }}
                      type="category"
                      width={125}
                    />
                    <Tooltip formatter={countTooltip} />
                    <Bar dataKey="count" name="Affected records" radius={[0, 7, 7, 0]}>
                      {dashboard.actionDistribution.map((item, index) => (
                        <Cell
                          fill={ACTION_COLOURS[index % ACTION_COLOURS.length]}
                          key={item.name}
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
                  <span>Urgency</span>
                  <h3>Known issues by priority</h3>
                </div>
              </div>

              <div className="chart-container chart-container--donut">
                <ResponsiveContainer height="100%" width="100%">
                  <PieChart>
                    <Pie
                      cx="50%"
                      cy="48%"
                      data={dashboard.priorityDistribution}
                      dataKey="count"
                      innerRadius={78}
                      nameKey="name"
                      outerRadius={120}
                      paddingAngle={2}
                    >
                      {dashboard.priorityDistribution.map((item) => (
                        <Cell
                          fill={
                            PRIORITY_COLOURS[item.name as ProblemPriority] ?? "#6b7b90"
                          }
                          key={item.name}
                        />
                      ))}
                    </Pie>
                    <Tooltip formatter={countTooltip} />
                    <Legend verticalAlign="bottom" />
                  </PieChart>
                </ResponsiveContainer>

                <div className="donut-centre">
                  <strong>{dashboard.knownActionItems.toLocaleString("en-IN")}</strong>
                  <span>action items</span>
                </div>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Hotspot view</span>
              <h2>Roads with repeated action items</h2>
            </div>
            <p>
              A road receives a higher count when footpath, manhole or drain
              issues are recorded at the same location.
            </p>
          </section>

          <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Location ranking</span>
                  <h3>Top road-level hotspots</h3>
                </div>
              </div>

              <div className="chart-container chart-container--problem-hotspots">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart
                    data={dashboard.hotspotDistribution}
                    layout="vertical"
                    margin={{ bottom: 8, left: 18, right: 22, top: 8 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis allowDecimals={false} type="number" />
                    <YAxis
                      dataKey="name"
                      interval={0}
                      tick={{ fontSize: 11 }}
                      type="category"
                      width={125}
                    />
                    <Tooltip formatter={countTooltip} />
                    <Bar dataKey="count" fill="#d18124" name="Action items" radius={[0, 7, 7, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="dashboard-panel problem-findings-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Field and data findings</span>
                  <h3>Important follow-up numbers</h3>
                </div>
              </div>

              <div className="problem-finding-list">
                <div>
                  <span className="problem-finding-icon">≋</span>
                  <p>
                    <strong>{completeDashboard.roadDrainageRiskNotes}</strong>
                    <span>roads contain a drainage obstruction or uneven-section note</span>
                  </p>
                </div>
                <div>
                  <span className="problem-finding-icon">◉</span>
                  <p>
                    <strong>{completeDashboard.unassessedManholes}</strong>
                    <span>manholes have no recorded condition</span>
                  </p>
                </div>
                <div>
                  <span className="problem-finding-icon">●</span>
                  <p>
                    <strong>{completeDashboard.utilityPointsWithoutCondition}</strong>
                    <span>point assets have no recorded condition status</span>
                  </p>
                </div>
                <div>
                  <span className="problem-finding-icon">▤</span>
                  <p>
                    <strong>
                      {completeDashboard.dataGapRecords.find(
                        (record) => record.id === "gap-drain-images",
                      )?.affectedCount ?? 0}
                    </strong>
                    <span>drain observations do not have an inspection image</span>
                  </p>
                </div>
              </div>
            </article>
          </section>

          {dashboard.dataGapRecords.length > 0 && (
            <>
              <section className="dashboard-section-heading">
                <div>
                  <span>Survey completion</span>
                  <h2>Largest information gaps</h2>
                </div>
                <p>
                  These bars show missing attributes, not confirmed physical
                  failures. The same asset can appear in more than one gap.
                </p>
              </section>

              <section className="dashboard-panel">
                <div className="chart-container chart-container--problem-gaps">
                  <ResponsiveContainer height="100%" width="100%">
                    <BarChart
                      data={dashboard.dataGapDistribution}
                      layout="vertical"
                      margin={{ bottom: 8, left: 18, right: 26, top: 8 }}
                    >
                      <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                      <XAxis allowDecimals={false} type="number" />
                      <YAxis
                        dataKey="name"
                        interval={0}
                        tick={{ fontSize: 11 }}
                        type="category"
                        width={220}
                      />
                      <Tooltip formatter={countTooltip} />
                      <Bar
                        dataKey="count"
                        fill="#6b7b90"
                        name="Missing records"
                        radius={[0, 7, 7, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </>
          )}

          {actionRecords.length > 0 && (
            <>
              <section className="dashboard-section-heading">
                <div>
                  <span>Action register</span>
                  <h2>Known issues requiring field action</h2>
                </div>
                <p>
                  Use the location link to open an individual surveyed feature
                  in Google Maps before assigning inspection or maintenance.
                </p>
              </section>

              <section className="road-table-panel">
                <div className="road-table-scroller">
                  <table className="road-table problems-table">
                    <thead>
                      <tr>
                        <th>Priority</th>
                        <th>Asset</th>
                        <th>Location</th>
                        <th>Issue</th>
                        <th>Recommended action</th>
                        <th>Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actionRecords.map((record) => (
                        <tr key={record.id}>
                          <td>
                            <span className={priorityClass(record.priority)}>
                              {record.priority}
                            </span>
                          </td>
                          <td>{record.assetType}</td>
                          <td>{record.location}</td>
                          <td>{record.issue}</td>
                          <td>{record.recommendation}</td>
                          <td>
                            {record.mapLink ? (
                              <a
                                className="problem-map-link"
                                href={record.mapLink}
                                rel="noreferrer"
                                target="_blank"
                              >
                                Open map
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {gapRecords.length > 0 && (
            <>
              <section className="dashboard-section-heading">
                <div>
                  <span>Data-gap register</span>
                  <h2>Survey information to complete</h2>
                </div>
                <p>
                  Affected counts can overlap because one asset may be missing
                  condition, depth, pipe type and image information together.
                </p>
              </section>

              <section className="road-table-panel">
                <div className="road-table-scroller">
                  <table className="road-table problems-table problems-gap-table">
                    <thead>
                      <tr>
                        <th>Group</th>
                        <th>Asset</th>
                        <th>Scope</th>
                        <th>Missing information</th>
                        <th>Affected records</th>
                        <th>Recommended follow-up</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gapRecords.map((record) => (
                        <tr key={record.id}>
                          <td>
                            <span className={groupClass(record.group)}>
                              {record.group}
                            </span>
                          </td>
                          <td>{record.assetType}</td>
                          <td>{record.location}</td>
                          <td>{record.issue}</td>
                          <td>{record.affectedCount.toLocaleString("en-IN")}</td>
                          <td>{record.recommendation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
