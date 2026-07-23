import type { GisRow, GisWorkbookData } from "./gisTypes";
import { calculatePotholeDashboard, calculateStandingWaterDashboard } from "./surfaceIssueDashboardCalculations";

export type ProblemRecordGroup = "Known issue" | "Data gap";
export type ProblemPriority = "Critical" | "High" | "Survey follow-up";
export type ProblemAssetType =
  | "Road"
  | "Manhole"
  | "Drain observation"
  | "Pothole"
  | "Standing water"
  | "Utility points";

export type ProblemRecord = {
  id: string;
  group: ProblemRecordGroup;
  priority: ProblemPriority;
  assetType: ProblemAssetType;
  location: string;
  issue: string;
  recommendation: string;
  affectedCount: number;
  mapLink: string | null;
  source: GisRow | null;
};

export type ProblemDistributionItem = {
  name: string;
  count: number;
};

export type HotspotItem = {
  name: string;
  count: number;
  critical: number;
};

export type ProblemsDashboardData = {
  records: ProblemRecord[];
  knownIssueRecords: ProblemRecord[];
  dataGapRecords: ProblemRecord[];
  knownActionItems: number;
  criticalItems: number;
  highPriorityItems: number;
  roadsWithoutFootpath: number;
  manholesNeedingAttention: number;
  drainsNeedingAttention: number;
  unassessedManholes: number;
  utilityPointsWithoutCondition: number;
  roadDrainageRiskNotes: number;
  actionDistribution: ProblemDistributionItem[];
  priorityDistribution: ProblemDistributionItem[];
  dataGapDistribution: ProblemDistributionItem[];
  hotspotDistribution: HotspotItem[];
};

function text(value: unknown, fallback = "Not recorded"): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function hasValue(value: unknown): boolean {
  const normalized = text(value, "").toLowerCase();
  return (
    normalized.length > 0 &&
    normalized !== "null" &&
    normalized !== "undefined" &&
    normalized !== "nan" &&
    normalized !== "not recorded" &&
    normalized !== "n/a" &&
    normalized !== "na"
  );
}

function isAttentionCondition(value: unknown): boolean {
  const normalized = text(value, "").toLowerCase();
  return ["bad", "blocked", "damage", "poor", "sludge"].some((keyword) =>
    normalized.includes(keyword),
  );
}

function isCriticalCondition(value: unknown): boolean {
  const normalized = text(value, "").toLowerCase();
  return normalized.includes("blocked");
}

function mapLink(row: GisRow): string | null {
  const value = row["Map Link (click)"];
  return hasValue(value) ? text(value) : null;
}

function prepareKnownIssueRecords(data: GisWorkbookData): ProblemRecord[] {
  const records: ProblemRecord[] = [];

  for (const row of data.Road_Centerline) {
    const footpath = text(row.Foot_Path, "").toLowerCase();

    if (footpath === "no" || footpath.includes("without")) {
      const roadName = text(row.Road_Name, `Road ${text(row.GDB_FID)}`);
      const fieldNote = hasValue(row.Any_Conservancy)
        ? ` Field note: ${text(row.Any_Conservancy)}.`
        : "";

      records.push({
        id: `road-${text(row.GDB_FID)}`,
        group: "Known issue",
        priority: "High",
        assetType: "Road",
        location: roadName,
        issue: `No footpath is recorded for this road.${fieldNote}`,
        recommendation:
          "Assess a continuous pedestrian path, remove obstructions and provide a safe walking edge wherever feasible.",
        affectedCount: 1,
        mapLink: mapLink(row),
        source: row,
      });
    }
  }

  for (const row of data.Manhole) {
    if (!isAttentionCondition(row.Condition)) {
      continue;
    }

    const condition = text(row.Condition);
    const roadName = text(row.Road_Name, "Road not recorded");

    records.push({
      id: `manhole-${text(row.GDB_FID)}`,
      group: "Known issue",
      priority: isCriticalCondition(row.Condition) ? "Critical" : "High",
      assetType: "Manhole",
      location: roadName,
      issue: `Manhole ${text(row.GDB_FID)} is recorded as “${condition}”.`,
      recommendation: isCriticalCondition(row.Condition)
        ? "Inspect immediately, remove blockage or sludge, secure the cover and confirm free flow before closing the action."
        : "Schedule inspection and repair, then update condition, depth and photo evidence.",
      affectedCount: 1,
      mapLink: mapLink(row),
      source: row,
    });
  }

  for (const row of data.Drain_Levels) {
    if (!isAttentionCondition(row.Condition)) {
      continue;
    }

    const siltValue = text(row.Silt_Level, "");
    const hasSilt = hasValue(siltValue) && siltValue.toLowerCase() !== "no";
    const location = text(row.Road_Name, "Road not recorded");

    records.push({
      id: `drain-${text(row.GDB_FID)}`,
      group: "Known issue",
      priority: "High",
      assetType: "Drain observation",
      location,
      issue: `Drain observation ${text(row.GDB_FID)} is recorded as “${text(
        row.Condition,
      )}”${hasSilt ? ` with a silt level of ${siltValue}` : ""}.`,
      recommendation:
        "Inspect the drain section, remove silt or blockage, verify levels and record post-maintenance evidence.",
      affectedCount: 1,
      mapLink: mapLink(row),
      source: row,
    });
  }

  const potholes = calculatePotholeDashboard(data.Pothole, data.Pothole_Top);
  for (const pothole of potholes.records) {
    const depthText = pothole.depthCm === null ? "depth not available" : `${pothole.depthCm.toFixed(2)} cm deep`;
    const areaText = pothole.areaSqm === null ? "area not available" : `${pothole.areaSqm.toFixed(2)} m²`;
    records.push({
      id: pothole.id,
      group: "Known issue",
      priority: pothole.depthCm !== null && pothole.depthCm > 10 ? "Critical" : "High",
      assetType: "Pothole",
      location: `Pothole FID ${pothole.sourceFid}`,
      issue: `A mapped pothole is ${depthText} with an affected area of ${areaText}.`,
      recommendation:
        "Inspect the road surface, confirm the repair boundary and depth, remove loose material and complete a suitable pavement repair.",
      affectedCount: 1,
      mapLink: pothole.mapHref,
      source: pothole.source,
    });
  }

  const standingWater = calculateStandingWaterDashboard(data.Standing_Water);
  for (const location of standingWater.records) {
    const areaText = location.areaSqm === null ? "area not available" : `${location.areaSqm.toFixed(2)} m²`;
    records.push({
      id: location.id,
      group: "Known issue",
      priority: location.areaSqm !== null && location.areaSqm > 15 ? "Critical" : "High",
      assetType: "Standing water",
      location: `Standing-water FID ${location.sourceFid}`,
      issue: `Standing water is mapped across ${areaText}.`,
      recommendation:
        "Inspect road levels, inlets and nearby drain connectivity, identify the cause of ponding and record depth and duration during field verification.",
      affectedCount: 1,
      mapLink: location.mapHref,
      source: location.source,
    });
  }

  return records;
}

function missingCount(rows: GisRow[], fieldName: string): number {
  return rows.filter((row) => !hasValue(row[fieldName])).length;
}

function prepareDataGapRecords(data: GisWorkbookData): ProblemRecord[] {
  const gapDefinitions: Array<{
    id: string;
    assetType: ProblemAssetType;
    location: string;
    issue: string;
    recommendation: string;
    count: number;
  }> = [
    {
      id: "gap-manhole-condition",
      assetType: "Manhole",
      location: "Ward-wide manhole register",
      issue: "Manhole condition is not recorded",
      recommendation:
        "Complete condition inspection using Good, Fair, Bad, Blocked or Damaged and attach field evidence.",
      count: missingCount(data.Manhole, "Condition"),
    },
    {
      id: "gap-manhole-bottom-level",
      assetType: "Manhole",
      location: "Ward-wide manhole register",
      issue: "Manhole bottom level is missing",
      recommendation:
        "Capture bottom/invert levels so flow direction and depth can be checked reliably.",
      count: missingCount(data.Manhole, "Bottom_Level"),
    },
    {
      id: "gap-manhole-depth",
      assetType: "Manhole",
      location: "Ward-wide manhole register",
      issue: "Manhole depth is missing",
      recommendation:
        "Measure depth safely and store one consistent unit in the survey database.",
      count: missingCount(data.Manhole, "Depth"),
    },
    {
      id: "gap-manhole-pipe-type",
      assetType: "Manhole",
      location: "Ward-wide manhole register",
      issue: "Connected pipe type is missing",
      recommendation:
        "Record pipe material and diameter during the next field verification cycle.",
      count: missingCount(data.Manhole, "Pipe_Type"),
    },
    {
      id: "gap-drain-dimensions",
      assetType: "Drain observation",
      location: "Drain-level observations",
      issue: "Drain width and depth are missing",
      recommendation:
        "Capture width × depth to support capacity checks and maintenance estimation.",
      count: missingCount(data.Drain_Levels, "WidthXDepth"),
    },
    {
      id: "gap-drain-images",
      assetType: "Drain observation",
      location: "Drain-level observations",
      issue: "Drain inspection image is missing",
      recommendation:
        "Attach a clear geotagged image for each inspection point, especially where defects are reported.",
      count: missingCount(data.Drain_Levels, "Image"),
    },
    {
      id: "gap-point-condition",
      assetType: "Utility points",
      location: "Ward-wide point asset register",
      issue: "Point-asset condition is not recorded",
      recommendation:
        "Add condition status where operational inspection is required; keep non-applicable categories clearly marked.",
      count: missingCount(data.Point, "Condition"),
    },
    {
      id: "gap-point-images",
      assetType: "Utility points",
      location: "Ward-wide point asset register",
      issue: "Point-asset image is not recorded",
      recommendation:
        "Attach photographs for maintainable assets and mark image requirements as not applicable where appropriate.",
      count: missingCount(data.Point, "Image_Number"),
    },
  ];

  return gapDefinitions
    .filter((item) => item.count > 0)
    .map((item) => ({
      ...item,
      group: "Data gap" as const,
      priority: "Survey follow-up" as const,
      affectedCount: item.count,
      mapLink: null,
      source: null,
    }));
}

function distribution(
  records: ProblemRecord[],
  valueGetter: (record: ProblemRecord) => string,
): ProblemDistributionItem[] {
  const counts = new Map<string, number>();

  for (const record of records) {
    const name = valueGetter(record);
    counts.set(name, (counts.get(name) ?? 0) + record.affectedCount);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function hotspotDistribution(records: ProblemRecord[]): HotspotItem[] {
  const counts = new Map<string, HotspotItem>();

  for (const record of records) {
    const current = counts.get(record.location) ?? {
      name: record.location,
      count: 0,
      critical: 0,
    };

    current.count += record.affectedCount;
    if (record.priority === "Critical") {
      current.critical += record.affectedCount;
    }

    counts.set(record.location, current);
  }

  return Array.from(counts.values())
    .sort(
      (a, b) =>
        b.count - a.count || b.critical - a.critical || a.name.localeCompare(b.name),
    )
    .slice(0, 10);
}

export function prepareProblemRecords(data: GisWorkbookData): ProblemRecord[] {
  return [...prepareKnownIssueRecords(data), ...prepareDataGapRecords(data)];
}

export function calculateProblemsDashboard(
  records: ProblemRecord[],
  data: GisWorkbookData,
): ProblemsDashboardData {
  const knownIssueRecords = records.filter((record) => record.group === "Known issue");
  const dataGapRecords = records.filter((record) => record.group === "Data gap");

  const roadsWithoutFootpath = knownIssueRecords.filter(
    (record) => record.assetType === "Road",
  ).length;
  const manholesNeedingAttention = knownIssueRecords.filter(
    (record) => record.assetType === "Manhole",
  ).length;
  const drainsNeedingAttention = knownIssueRecords.filter(
    (record) => record.assetType === "Drain observation",
  ).length;

  const roadDrainageRiskNotes = data.Road_Centerline.filter((row) =>
    hasValue(row.Any_Conservancy),
  ).length;

  return {
    records,
    knownIssueRecords,
    dataGapRecords,
    knownActionItems: knownIssueRecords.reduce(
      (total, record) => total + record.affectedCount,
      0,
    ),
    criticalItems: knownIssueRecords
      .filter((record) => record.priority === "Critical")
      .reduce((total, record) => total + record.affectedCount, 0),
    highPriorityItems: knownIssueRecords
      .filter((record) => record.priority === "High")
      .reduce((total, record) => total + record.affectedCount, 0),
    roadsWithoutFootpath,
    manholesNeedingAttention,
    drainsNeedingAttention,
    unassessedManholes: missingCount(data.Manhole, "Condition"),
    utilityPointsWithoutCondition: missingCount(data.Point, "Condition"),
    roadDrainageRiskNotes,
    actionDistribution: distribution(knownIssueRecords, (record) => record.assetType),
    priorityDistribution: distribution(knownIssueRecords, (record) => record.priority),
    dataGapDistribution: distribution(dataGapRecords, (record) => record.issue),
    hotspotDistribution: hotspotDistribution(knownIssueRecords),
  };
}
