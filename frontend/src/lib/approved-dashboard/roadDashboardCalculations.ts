import type { GisRow } from "./gisTypes";

export type RoadRecord = {
  id: string;
  name: string;
  surface: string;
  usage: string;
  width: number | null;
  length: number;
  footpath: string;
  divider: string;
  ugdStatus: string;
  swdStatus: string;
  streetLighting: string;
  observation: string;
  source: GisRow;
};

export type RoadCategoryCount = {
  name: string;
  count: number;
};

export type RoadLengthItem = {
  name: string;
  length: number;
};

export type RoadDashboardData = {
  records: RoadRecord[];
  totalRoads: number;
  totalLengthMetres: number;
  averageWidthMetres: number;
  roadsWithoutFootpath: number;
  roadsWithFootpath: number;
  ugdComplete: number;
  widestRoad: RoadRecord | null;
  longestRoad: RoadRecord | null;
  surfaceDistribution: RoadCategoryCount[];
  usageDistribution: RoadCategoryCount[];
  footpathDistribution: RoadCategoryCount[];
  widthDistribution: RoadCategoryCount[];
  topRoadsByLength: RoadLengthItem[];
};

function text(value: unknown, fallback = "Not recorded"): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value === null || value === undefined) {
    return null;
  }

  const match = String(value).replaceAll(",", "").match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function categoryCounts(
  records: RoadRecord[],
  valueGetter: (record: RoadRecord) => string,
): RoadCategoryCount[] {
  const counts = new Map<string, number>();

  for (const record of records) {
    const value = valueGetter(record);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function footpathGroup(value: string): "Available" | "Not available" | "Not recorded" {
  const normalized = value.toLowerCase();

  if (normalized.startsWith("yes") || normalized.includes("available")) {
    return "Available";
  }

  if (normalized === "no" || normalized.includes("without")) {
    return "Not available";
  }

  return "Not recorded";
}

function widthGroup(width: number | null): string {
  if (width === null) {
    return "Not recorded";
  }

  if (width < 2) {
    return "Below 2 m";
  }

  if (width < 3) {
    return "2–2.9 m";
  }

  if (width < 4) {
    return "3–3.9 m";
  }

  return "4 m and above";
}

export function prepareRoadRecords(rows: GisRow[]): RoadRecord[] {
  return rows.map((row, index) => {
    const shapeLength = numberValue(row.SHAPE_Length);
    const statedLength = numberValue(row.Length_M);

    return {
      id: text(row.GDB_FID, `road-${index + 1}`),
      name: text(row.Road_Name, `Unnamed road ${index + 1}`),
      surface: text(row.Type_of_Road),
      usage: text(row.Usage_of_Road),
      width: numberValue(row.Carriage_Way_Width),
      length: statedLength ?? shapeLength ?? 0,
      footpath: text(row.Foot_Path),
      divider: text(row.Divider),
      ugdStatus: text(row.UGD_Status),
      swdStatus: text(row.SWD_Status),
      streetLighting: text(row.Sodium__Solar__LED_Other),
      observation: text(row.Any_Conservancy),
      source: row,
    };
  });
}

export function calculateRoadDashboard(records: RoadRecord[]): RoadDashboardData {
  const totalLengthMetres = records.reduce(
    (total, record) => total + record.length,
    0,
  );

  const widths = records
    .map((record) => record.width)
    .filter((width): width is number => width !== null);

  const averageWidthMetres =
    widths.length === 0
      ? 0
      : widths.reduce((total, width) => total + width, 0) / widths.length;

  const roadsWithFootpath = records.filter(
    (record) => footpathGroup(record.footpath) === "Available",
  ).length;

  const roadsWithoutFootpath = records.filter(
    (record) => footpathGroup(record.footpath) === "Not available",
  ).length;

  const ugdComplete = records.filter((record) =>
    record.ugdStatus.toLowerCase().includes("complete"),
  ).length;

  const widestRoad = [...records]
    .filter((record) => record.width !== null)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0] ?? null;

  const longestRoad = [...records].sort((a, b) => b.length - a.length)[0] ?? null;

  return {
    records,
    totalRoads: records.length,
    totalLengthMetres,
    averageWidthMetres,
    roadsWithoutFootpath,
    roadsWithFootpath,
    ugdComplete,
    widestRoad,
    longestRoad,
    surfaceDistribution: categoryCounts(records, (record) => record.surface),
    usageDistribution: categoryCounts(records, (record) => record.usage),
    footpathDistribution: categoryCounts(records, (record) =>
      footpathGroup(record.footpath),
    ),
    widthDistribution: categoryCounts(records, (record) =>
      widthGroup(record.width),
    ),
    topRoadsByLength: [...records]
      .sort((a, b) => b.length - a.length)
      .slice(0, 10)
      .map((record) => ({
        name: record.name,
        length: Number(record.length.toFixed(2)),
      })),
  };
}
