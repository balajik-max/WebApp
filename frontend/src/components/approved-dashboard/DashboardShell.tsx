import type { ReactNode } from "react";

import type { DashboardSection } from "../../lib/approved-dashboard/dashboardTypes";

type DashboardShellProps = {
  activeSection: DashboardSection;
  onSectionChange: (section: DashboardSection) => void;
  children: ReactNode;
  datasetName: string;
  ward?: string | null;
  availableSections: Record<DashboardSection, boolean>;
  loadedRecords: number;
  totalFeatures: number;
  truncated: boolean;
  actions?: ReactNode;
};

type DashboardTab = {
  id: DashboardSection;
  label: string;
};

const DASHBOARD_TABS: DashboardTab[] = [
  { id: "executive", label: "Executive overview" },
  { id: "roads", label: "Roads" },
  { id: "drainage", label: "Drainage" },
  { id: "potholes", label: "Potholes" },
  { id: "standingWater", label: "Standing water" },
  { id: "manholes", label: "Manholes" },
  { id: "utilities", label: "Utilities" },
  { id: "problems", label: "Problems & gaps" },
];

export function DashboardShell({
  activeSection,
  onSectionChange,
  children,
  datasetName,
  ward,
  availableSections,
  loadedRecords,
  totalFeatures,
  truncated,
  actions,
}: DashboardShellProps) {
  return (
    <div className="executive-dashboard">
      <header className="dashboard-titlebar">
        <div>
          <p className="dashboard-kicker">
            {(ward || datasetName).toUpperCase()}
          </p>
          <h1>Urban Infrastructure Dashboard</h1>
          <p className="dashboard-subtitle">
            A clear summary of surveyed roads, buildings, drains, manholes, potholes,
            standing water and public utility assets.
          </p>
        </div>

        <div className="dashboard-titlebar__side">
          <div className="dashboard-status">
            <span className="dashboard-status__dot" />
            Uploaded GDB data connected
          </div>
          {actions && <div className="approved-dashboard-actions">{actions}</div>}
        </div>
      </header>

      <nav className="dashboard-tabs" aria-label="Dashboard sections">
        {DASHBOARD_TABS.map((tab) => {
          const available = availableSections[tab.id];
          return (
            <button
              className={`dashboard-tab ${
                activeSection === tab.id ? "dashboard-tab--active" : ""
              }`}
              disabled={!available}
              key={tab.id}
              onClick={() => onSectionChange(tab.id)}
              title={available ? tab.label : `${tab.label} data is not available in this GDB`}
              type="button"
            >
              {tab.label}
              {!available && <span className="dashboard-tab__soon">No data</span>}
            </button>
          );
        })}
      </nav>

      {truncated && (
        <div className="approved-dashboard-warning">
          This dataset contains {totalFeatures.toLocaleString("en-IN")} features.
          Detailed filters use the first {loadedRecords.toLocaleString("en-IN")} records,
          while the universal server summary keeps the full dataset totals.
        </div>
      )}

      {children}

      <footer className="dashboard-footer">
        <span>Data source: {datasetName} · uploaded GDB</span>
        <span>{totalFeatures.toLocaleString("en-IN")} mapped features</span>
      </footer>
    </div>
  );
}
