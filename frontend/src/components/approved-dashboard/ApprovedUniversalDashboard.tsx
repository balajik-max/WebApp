import { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  DashboardRecordResponse,
  DatasetRow,
  UniversalDashboard,
  VisualizationManifest,
} from "../../lib/workflow";
import { buildApprovedDashboardWorkbook } from "../../lib/approved-dashboard/approvedDashboardAdapter";
import type { DashboardSection } from "../../lib/approved-dashboard/dashboardTypes";
import { DashboardShell } from "./DashboardShell";
import { DrainageDashboard } from "./DrainageDashboard";
import { ExecutiveDashboard } from "./ExecutiveDashboard";
import { ManholeDashboard } from "./ManholeDashboard";
import { ProblemsDashboard } from "./ProblemsDashboard";
import { PotholeDashboard } from "./PotholeDashboard";
import { RoadDashboard } from "./RoadDashboard";
import { StandingWaterDashboard } from "./StandingWaterDashboard";
import { UtilitiesDashboard } from "./UtilitiesDashboard";
import "./approvedDashboard.css";

type ApprovedUniversalDashboardProps = {
  manifest: VisualizationManifest;
  dashboard: UniversalDashboard;
  recordResponse: DashboardRecordResponse;
  dataset: DatasetRow | null;
  actions?: ReactNode;
};

export function ApprovedUniversalDashboard({
  manifest,
  dashboard,
  recordResponse,
  dataset,
  actions,
}: ApprovedUniversalDashboardProps) {
  const workbookData = useMemo(
    () => buildApprovedDashboardWorkbook(manifest, recordResponse.records),
    [manifest, recordResponse.records],
  );

  const availableSections = useMemo<Record<DashboardSection, boolean>>(
    () => ({
      executive: true,
      roads: workbookData.Road_Centerline.length > 0,
      drainage: workbookData.SWD.length > 0 || workbookData.Drain_Levels.length > 0,
      potholes: workbookData.Pothole.length > 0,
      standingWater: workbookData.Standing_Water.length > 0,
      manholes: workbookData.Manhole.length > 0,
      utilities:
        workbookData.Point.length > 0 ||
        workbookData.Line.length > 0 ||
        workbookData.Polygon.length > 0 ||
        workbookData.Landmark.length > 0,
      problems: recordResponse.records.length > 0,
    }),
    [recordResponse.records.length, workbookData],
  );

  const [activeSection, setActiveSection] =
    useState<DashboardSection>("executive");

  useEffect(() => {
    if (!availableSections[activeSection]) {
      setActiveSection("executive");
    }
  }, [activeSection, availableSections]);

  let content = (
    <ExecutiveDashboard
      data={workbookData}
      totalFeatures={dashboard.total_features}
      includedLayers={dashboard.included_layers}
    />
  );

  if (activeSection === "roads") {
    content = <RoadDashboard data={workbookData} />;
  } else if (activeSection === "drainage") {
    content = <DrainageDashboard data={workbookData} />;
  } else if (activeSection === "potholes") {
    content = <PotholeDashboard data={workbookData} />;
  } else if (activeSection === "standingWater") {
    content = <StandingWaterDashboard data={workbookData} />;
  } else if (activeSection === "manholes") {
    content = <ManholeDashboard data={workbookData} />;
  } else if (activeSection === "utilities") {
    content = <UtilitiesDashboard data={workbookData} />;
  } else if (activeSection === "problems") {
    content = <ProblemsDashboard data={workbookData} />;
  }

  return (
    <div className="approved-dashboard-host">
      <DashboardShell
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        datasetName={manifest.dataset_name}
        ward={dataset?.ward}
        availableSections={availableSections}
        loadedRecords={recordResponse.records.length}
        totalFeatures={dashboard.total_features}
        truncated={recordResponse.truncated}
        actions={actions}
      >
        {content}
      </DashboardShell>
    </div>
  );
}
