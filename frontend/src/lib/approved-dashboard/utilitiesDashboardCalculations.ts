import type { GisRow, GisWorkbookData } from "./gisTypes";
import { featureIdFromRow, featureMapHref } from "./mapLinks";

export type UtilityGroup =
  | "Point assets"
  | "Linear features"
  | "Buildings & areas"
  | "Landmarks";

export type UtilityRecord = {
  id: string;
  featureId: string | null;
  mapHref: string | null;
  group: UtilityGroup;
  category: string;
  name: string;
  lengthMetres: number;
  areaSquareMetres: number;
  source: GisRow;
};

export type UtilityCategorySummary = {
  group: UtilityGroup;
  category: string;
  count: number;
  totalLengthMetres: number;
  totalAreaSquareMetres: number;
  sharePercent: number;
};

export type UtilityDistributionItem = {
  name: string;
  count: number;
};

export type UtilitiesDashboardData = {
  records: UtilityRecord[];
  totalRecords: number;
  pointAssets: number;
  linearFeatures: number;
  buildingsAndAreas: number;
  landmarks: number;
  electricalAndLightingAssets: number;
  greenAssets: number;
  totalLinearLengthMetres: number;
  totalMappedAreaSquareMetres: number;
  groupDistribution: UtilityDistributionItem[];
  topCategories: UtilityDistributionItem[];
  pointDistribution: UtilityDistributionItem[];
  lineDistribution: UtilityDistributionItem[];
  areaDistribution: UtilityDistributionItem[];
  landmarkDistribution: UtilityDistributionItem[];
  categorySummary: UtilityCategorySummary[];
  largestPointCategory: UtilityDistributionItem | null;
  largestLineCategory: UtilityDistributionItem | null;
  largestAreaCategory: UtilityDistributionItem | null;
};

function text(value: unknown, fallback = "Not recorded"): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function numericValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function landmarkCategory(name: string): string {
  const normalized = name.toLowerCase();

  if (normalized.includes("temple")) {
    return "Temple";
  }

  if (normalized.includes("school")) {
    return "School";
  }

  if (normalized.includes("police")) {
    return "Police station";
  }

  if (
    normalized.includes("bhavana") ||
    normalized.includes("sabha") ||
    normalized.includes("samudhaya")
  ) {
    return "Community hall / bhavana";
  }

  return "Other landmark";
}

function distribution(
  records: UtilityRecord[],
  valueGetter: (record: UtilityRecord) => string,
): UtilityDistributionItem[] {
  const counts = new Map<string, number>();

  for (const record of records) {
    const value = valueGetter(record);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function isElectricalOrLighting(category: string): boolean {
  const normalized = category.toLowerCase();
  return [
    "power",
    "light",
    "transformer",
    "high mast",
    "solar",
  ].some((keyword) => normalized.includes(keyword));
}

function isGreenAsset(category: string): boolean {
  const normalized = category.toLowerCase();
  return normalized.includes("tree") || normalized.includes("planter");
}

export function prepareUtilityRecords(data: GisWorkbookData): UtilityRecord[] {
  const pointRecords: UtilityRecord[] = data.Point.map((row, index) => {
    const category = text(row.LAYER);

    return {
      id: text(row.GDB_FID, `point-${index + 1}`),
      featureId: featureIdFromRow(row),
      mapHref: featureMapHref(row),
      group: "Point assets",
      category,
      name: category,
      lengthMetres: 0,
      areaSquareMetres: 0,
      source: row,
    };
  });

  const lineRecords: UtilityRecord[] = data.Line.map((row, index) => {
    const category = text(row.LAYER);

    return {
      id: text(row.GDB_FID, `line-${index + 1}`),
      featureId: featureIdFromRow(row),
      mapHref: featureMapHref(row),
      group: "Linear features",
      category,
      name: category,
      lengthMetres: numericValue(row.SHAPE_Length),
      areaSquareMetres: 0,
      source: row,
    };
  });

  const polygonRecords: UtilityRecord[] = data.Polygon.map((row, index) => {
    const category = text(row.LAYER);

    return {
      id: text(row.GDB_FID, `polygon-${index + 1}`),
      featureId: featureIdFromRow(row),
      mapHref: featureMapHref(row),
      group: "Buildings & areas",
      category,
      name: category,
      lengthMetres: 0,
      areaSquareMetres: numericValue(row.SHAPE_Area),
      source: row,
    };
  });

  const landmarkRecords: UtilityRecord[] = data.Landmark.map((row, index) => {
    const name = text(row.Name, `Landmark ${index + 1}`);

    return {
      id: text(row.GDB_FID, `landmark-${index + 1}`),
      featureId: featureIdFromRow(row),
      mapHref: featureMapHref(row),
      group: "Landmarks",
      category: landmarkCategory(name),
      name,
      lengthMetres: 0,
      areaSquareMetres: 0,
      source: row,
    };
  });

  return [
    ...pointRecords,
    ...lineRecords,
    ...polygonRecords,
    ...landmarkRecords,
  ];
}

function categorySummary(records: UtilityRecord[]): UtilityCategorySummary[] {
  const groups = new Map<string, UtilityCategorySummary>();

  for (const record of records) {
    const key = `${record.group}::${record.category}`;
    const existing = groups.get(key);

    if (existing) {
      existing.count += 1;
      existing.totalLengthMetres += record.lengthMetres;
      existing.totalAreaSquareMetres += record.areaSquareMetres;
    } else {
      groups.set(key, {
        group: record.group,
        category: record.category,
        count: 1,
        totalLengthMetres: record.lengthMetres,
        totalAreaSquareMetres: record.areaSquareMetres,
        sharePercent: 0,
      });
    }
  }

  const total = records.length;

  return Array.from(groups.values())
    .map((item) => ({
      ...item,
      totalLengthMetres: Number(item.totalLengthMetres.toFixed(2)),
      totalAreaSquareMetres: Number(item.totalAreaSquareMetres.toFixed(2)),
      sharePercent: total === 0 ? 0 : Number(((item.count / total) * 100).toFixed(1)),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.group.localeCompare(b.group) ||
        a.category.localeCompare(b.category),
    );
}

export function calculateUtilitiesDashboard(
  records: UtilityRecord[],
): UtilitiesDashboardData {
  const pointRecords = records.filter((record) => record.group === "Point assets");
  const lineRecords = records.filter(
    (record) => record.group === "Linear features",
  );
  const areaRecords = records.filter(
    (record) => record.group === "Buildings & areas",
  );
  const landmarkRecords = records.filter((record) => record.group === "Landmarks");

  const pointDistribution = distribution(pointRecords, (record) => record.category);
  const lineDistribution = distribution(lineRecords, (record) => record.category);
  const areaDistribution = distribution(areaRecords, (record) => record.category);
  const landmarkDistribution = distribution(
    landmarkRecords,
    (record) => record.category,
  );

  return {
    records,
    totalRecords: records.length,
    pointAssets: pointRecords.length,
    linearFeatures: lineRecords.length,
    buildingsAndAreas: areaRecords.length,
    landmarks: landmarkRecords.length,
    electricalAndLightingAssets: records.filter((record) =>
      isElectricalOrLighting(record.category),
    ).length,
    greenAssets: records.filter((record) => isGreenAsset(record.category)).length,
    totalLinearLengthMetres: lineRecords.reduce(
      (total, record) => total + record.lengthMetres,
      0,
    ),
    totalMappedAreaSquareMetres: areaRecords.reduce(
      (total, record) => total + record.areaSquareMetres,
      0,
    ),
    groupDistribution: distribution(records, (record) => record.group),
    topCategories: distribution(records, (record) => record.category).slice(0, 12),
    pointDistribution,
    lineDistribution,
    areaDistribution,
    landmarkDistribution,
    categorySummary: categorySummary(records),
    largestPointCategory: pointDistribution[0] ?? null,
    largestLineCategory: lineDistribution[0] ?? null,
    largestAreaCategory: areaDistribution[0] ?? null,
  };
}
