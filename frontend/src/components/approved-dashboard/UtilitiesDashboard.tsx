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
  calculateUtilitiesDashboard,
  prepareUtilityRecords,
  type UtilityGroup,
  type UtilityRecord,
} from "../../lib/approved-dashboard/utilitiesDashboardCalculations";
import type { GisWorkbookData } from "../../lib/approved-dashboard/gisTypes";
import { KpiCard } from "./KpiCard";

type UtilitiesDashboardProps = {
  data: GisWorkbookData;
};

const GROUP_COLOURS = ["#21836d", "#4779a8", "#d39a2e", "#8a67b4"];
const CATEGORY_COLOURS = [
  "#21836d",
  "#4779a8",
  "#d39a2e",
  "#8a67b4",
  "#c35d78",
  "#5c914f",
  "#6d7d91",
];

function formatCountTooltip(value: unknown): [string, string] {
  return [Number(value ?? 0).toLocaleString("en-IN"), "Assets"];
}

function uniqueGroups(records: UtilityRecord[]): UtilityGroup[] {
  return Array.from(new Set(records.map((record) => record.group))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function uniqueCategories(records: UtilityRecord[]): string[] {
  return Array.from(new Set(records.map((record) => record.category))).sort(
    (a, b) => a.localeCompare(b),
  );
}

function groupClass(group: UtilityGroup): string {
  if (group === "Point assets") {
    return "utility-group-badge utility-group-badge--point";
  }

  if (group === "Linear features") {
    return "utility-group-badge utility-group-badge--line";
  }

  if (group === "Buildings & areas") {
    return "utility-group-badge utility-group-badge--area";
  }

  return "utility-group-badge utility-group-badge--landmark";
}

function formatLength(value: number): string {
  if (value <= 0) {
    return "—";
  }

  return value >= 1000
    ? `${(value / 1000).toFixed(2)} km`
    : `${value.toFixed(1)} m`;
}

function formatArea(value: number): string {
  if (value <= 0) {
    return "—";
  }

  return `${value.toLocaleString("en-IN", {
    maximumFractionDigits: 1,
  })} m²`;
}

export function UtilitiesDashboard({ data }: UtilitiesDashboardProps) {
  const allRecords = useMemo(() => prepareUtilityRecords(data), [data]);

  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("All");
  const [category, setCategory] = useState("All");

  const groupOptions = useMemo(() => uniqueGroups(allRecords), [allRecords]);

  const categoryOptions = useMemo(() => {
    const groupFiltered =
      group === "All"
        ? allRecords
        : allRecords.filter((record) => record.group === group);

    return uniqueCategories(groupFiltered);
  }, [allRecords, group]);

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();

    return allRecords.filter((record) => {
      const matchesSearch =
        query.length === 0 ||
        record.category.toLowerCase().includes(query) ||
        record.name.toLowerCase().includes(query) ||
        record.group.toLowerCase().includes(query);

      return (
        matchesSearch &&
        (group === "All" || record.group === group) &&
        (category === "All" || record.category === category)
      );
    });
  }, [allRecords, category, group, search]);

  const dashboard = useMemo(
    () => calculateUtilitiesDashboard(filteredRecords),
    [filteredRecords],
  );

  function clearFilters() {
    setSearch("");
    setGroup("All");
    setCategory("All");
  }

  function changeGroup(nextGroup: string) {
    setGroup(nextGroup);
    setCategory("All");
  }

  const topCategoryMaximum = Math.max(
    ...dashboard.topCategories.map((item) => item.count),
    1,
  );

  return (
    <div className="dashboard-page">
      <section className="dashboard-page-heading">
        <div>
          <span>Utility and public assets</span>
          <h2>Community asset inventory</h2>
          <p>
            Understand what has been mapped across point assets, utility lines,
            buildings, public areas and important community landmarks.
          </p>
        </div>

        <div className="page-record-badge">
          {dashboard.totalRecords.toLocaleString("en-IN")} of{" "}
          {allRecords.length.toLocaleString("en-IN")} records shown
        </div>
      </section>

      <section className="dashboard-filter-panel dashboard-filter-panel--utilities">
        <label>
          <span>Search asset or landmark</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Example: Light Pole, Wall or School"
            type="search"
            value={search}
          />
        </label>

        <label>
          <span>Asset group</span>
          <select onChange={(event) => changeGroup(event.target.value)} value={group}>
            <option value="All">All asset groups</option>
            {groupOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Category</span>
          <select
            onChange={(event) => setCategory(event.target.value)}
            value={category}
          >
            <option value="All">All categories</option>
            {categoryOptions.map((option) => (
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

      {dashboard.totalRecords === 0 ? (
        <section className="empty-result-panel">
          <strong>No utility records match these filters</strong>
          <p>Clear the filters to return to the complete community inventory.</p>
          <button onClick={clearFilters} type="button">
            Show all assets
          </button>
        </section>
      ) : (
        <>
          <section className="utilities-kpi-grid" aria-label="Utility asset totals">
            <KpiCard
              helper="Selected public and built-environment records"
              icon="▦"
              label="Total asset records"
              value={dashboard.totalRecords}
            />
            <KpiCard
              helper="Poles, trees, gates, tanks and other individual assets"
              icon="●"
              label="Point assets"
              value={dashboard.pointAssets}
            />
            <KpiCard
              helper="Walls, power lines, road edges and similar features"
              icon="━"
              label="Linear features"
              value={dashboard.linearFeatures}
            />
            <KpiCard
              helper="Buildings, extensions, sheds and mapped areas"
              icon="▤"
              label="Buildings & areas"
              value={dashboard.buildingsAndAreas}
            />
            <KpiCard
              helper="Named temples, schools, halls and public facilities"
              icon="⌂"
              label="Landmarks"
              value={dashboard.landmarks}
            />
            <KpiCard
              helper="Power, lighting, transformer and related assets"
              icon="ϟ"
              label="Electrical & lighting"
              tone="success"
              value={dashboard.electricalAndLightingAssets}
            />
            <KpiCard
              helper="Trees and planter-related records"
              icon="♣"
              label="Green assets"
              tone="success"
              value={dashboard.greenAssets}
            />
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Asset mix</span>
              <h2>What types of assets are present?</h2>
            </div>
            <p>
              Large categories are shown first so officers and citizens can
              quickly understand the ward’s physical inventory.
            </p>
          </section>

          <section className="dashboard-chart-grid dashboard-chart-grid--wide-left">
            <article className="dashboard-panel">
              <div className="dashboard-panel__heading">
                <div>
                  <span>Most common categories</span>
                  <h3>Top mapped assets</h3>
                </div>
              </div>

              <div className="chart-container chart-container--utilities-category">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart
                    data={dashboard.topCategories}
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
                      width={150}
                    />
                    <Tooltip formatter={formatCountTooltip} />
                    <Bar dataKey="count" name="Assets" radius={[0, 7, 7, 0]}>
                      {dashboard.topCategories.map((item, index) => (
                        <Cell
                          fill={CATEGORY_COLOURS[index % CATEGORY_COLOURS.length]}
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
                  <span>Inventory composition</span>
                  <h3>Records by asset group</h3>
                </div>
              </div>

              <div className="chart-container chart-container--donut">
                <ResponsiveContainer height="100%" width="100%">
                  <PieChart>
                    <Pie
                      cx="50%"
                      cy="48%"
                      data={dashboard.groupDistribution}
                      dataKey="count"
                      innerRadius={78}
                      nameKey="name"
                      outerRadius={120}
                      paddingAngle={2}
                    >
                      {dashboard.groupDistribution.map((item, index) => (
                        <Cell
                          fill={GROUP_COLOURS[index % GROUP_COLOURS.length]}
                          key={item.name}
                        />
                      ))}
                    </Pie>
                    <Tooltip formatter={formatCountTooltip} />
                    <Legend verticalAlign="bottom" />
                  </PieChart>
                </ResponsiveContainer>

                <div className="donut-centre">
                  <strong>{dashboard.totalRecords.toLocaleString("en-IN")}</strong>
                  <span>asset records</span>
                </div>
              </div>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Category details</span>
              <h2>Important inventory findings</h2>
            </div>
            <p>
              These simple highlights identify the most common point, line and
              building categories in the selected data.
            </p>
          </section>

          <section className="insight-grid">
            <article className="insight-card">
              <span>Most common point asset</span>
              <strong>
                {dashboard.largestPointCategory?.count.toLocaleString("en-IN") ?? "—"}
              </strong>
              <p>{dashboard.largestPointCategory?.name ?? "No point assets selected"}</p>
            </article>

            <article className="insight-card">
              <span>Most common linear feature</span>
              <strong>
                {dashboard.largestLineCategory?.count.toLocaleString("en-IN") ?? "—"}
              </strong>
              <p>{dashboard.largestLineCategory?.name ?? "No linear features selected"}</p>
            </article>

            <article className="insight-card">
              <span>Most common building type</span>
              <strong>
                {dashboard.largestAreaCategory?.count.toLocaleString("en-IN") ?? "—"}
              </strong>
              <p>{dashboard.largestAreaCategory?.name ?? "No building areas selected"}</p>
            </article>

            <article className="insight-card insight-card--muted">
              <span>Mapped physical extent</span>
              <strong>{formatLength(dashboard.totalLinearLengthMetres)}</strong>
              <p>
                Linear features · {formatArea(dashboard.totalMappedAreaSquareMetres)} mapped
                building and area footprint
              </p>
            </article>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Category register</span>
              <h2>Easy category-wise summary</h2>
            </div>
            <p>
              Counts are grouped into plain-language asset families. Length and
              area appear only where those measurements apply.
            </p>
          </section>

          <section className="road-table-panel">
            <div className="road-table-scroller">
              <table className="road-table utility-category-table">
                <thead>
                  <tr>
                    <th>Asset group</th>
                    <th>Category</th>
                    <th>Count</th>
                    <th>Share</th>
                    <th>Total length</th>
                    <th>Total area</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.categorySummary.map((item) => (
                    <tr key={`${item.group}-${item.category}`}>
                      <td>
                        <span className={groupClass(item.group)}>{item.group}</span>
                      </td>
                      <td>{item.category}</td>
                      <td>{item.count.toLocaleString("en-IN")}</td>
                      <td>
                        <div className="utility-share-cell">
                          <span>{item.sharePercent.toFixed(1)}%</span>
                          <div className="utility-share-track">
                            <span
                              style={{
                                width: `${Math.max(
                                  (item.count / topCategoryMaximum) * 100,
                                  3,
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>{formatLength(item.totalLengthMetres)}</td>
                      <td>{formatArea(item.totalAreaSquareMetres)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="dashboard-section-heading">
            <div>
              <span>Asset register</span>
              <h2>Individual mapped utilities</h2>
            </div>
            <p>Each row opens the exact surveyed point, line or polygon on the map.</p>
          </section>

          <section className="road-table-panel">
            <div className="road-table-scroller surface-table-scroller">
              <table className="road-table utility-category-table">
                <thead>
                  <tr><th>Asset</th><th>Group</th><th>Category</th><th>Length</th><th>Area</th><th>Map</th></tr>
                </thead>
                <tbody>
                  {dashboard.records.map((record) => (
                    <tr key={`${record.group}-${record.id}`}>
                      <td><strong>{record.name}</strong><small>FID {record.id}</small></td>
                      <td><span className={groupClass(record.group)}>{record.group}</span></td>
                      <td>{record.category}</td>
                      <td>{formatLength(record.lengthMetres)}</td>
                      <td>{formatArea(record.areaSquareMetres)}</td>
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
