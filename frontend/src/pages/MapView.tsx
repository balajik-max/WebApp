import {
  useState, useCallback, useRef, useEffect,
  type MutableRefObject, type CSSProperties,
  type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  MapCanvas,
  type AiVerificationContext,
  type Basemap,
  type RasterDisplaySettings,
} from "../components/MapCanvas";
import { ReportGenerator } from "../components/WardReportPanel";
import { AiAssistant } from "../components/AiAssistant";
import { PointVerificationPanel } from "../components/PointVerificationPanel";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { AiHighlight, FeatureFilter, UrbanFeature } from "../lib/types";
import type { DatasetRow } from "../lib/workflow";
import { useIsMobile } from "../lib/useIsMobile";
import type { QuickAnalysisViewState } from "../lib/quickAnalysisViewState";

type SpatialAuditStatus = "idle" | "running" | "success" | "error";

export interface MapState {
  zoom: number;
  center: [number, number];
  pitch: number;
  bearing: number;
}

// Single source of truth for the left sidebar's width — desktop only (the
// mobile drawer keeps its own fixed width from index.css, see
// `.command-center` under the 768px breakpoint). Widened from the previous
// 340px value to 357px so geometry-group and datasource names have more room
// before truncating.
const SIDEBAR_RAIL_WIDTH = 48;
const DEFAULT_SIDEBAR_WIDTH = 357;
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 520;
const SIDEBAR_KEYBOARD_STEP = 16;
const SIDEBAR_KEYBOARD_STEP_LARGE = 32;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// The sidebar must never eat most of the viewport — cap it at whichever is
// smaller: the absolute max, or 45% of the current window width.
function viewportLimitedMaxWidth(): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.round(window.innerWidth * 0.45));
}

interface LayoutCtx {
  filter: FeatureFilter;
  selectedDatasets: DatasetRow[];
  setSelectedDatasets: (rows: DatasetRow[]) => void;
  rasterSettingsById: Record<string, RasterDisplaySettings>;
  setRasterSettingsById: (settings: Record<string, RasterDisplaySettings>) => void;
  basemap: Basemap;
  setBasemap: (basemap: Basemap) => void;
  mapSelectedDatasets: DatasetRow[];
  setMapSelectedDatasets: (rows: DatasetRow[]) => void;
  commandCenterMobileOpen: boolean;
  setCommandCenterMobileOpen: (open: boolean) => void;
  quickAnalysisViewState: QuickAnalysisViewState;
  setQuickAnalysisViewState: (state: QuickAnalysisViewState) => void;
  spatialAuditRequested: boolean;
  setSpatialAuditRequested: (v: boolean) => void;
  spatialAuditExecutedRef: MutableRefObject<boolean>;
  spatialAuditStatus: SpatialAuditStatus;
  setSpatialAuditStatus: (status: SpatialAuditStatus) => void;
  mapState: MapState;
  setMapState: (state: MapState) => void;
}

export function MapView() {
  const {
    filter,
    setSelectedDatasets,
    rasterSettingsById,
    setRasterSettingsById,
    basemap,
    setBasemap,
    mapSelectedDatasets,
    setMapSelectedDatasets,
    commandCenterMobileOpen,
    setCommandCenterMobileOpen,
    quickAnalysisViewState,
    setQuickAnalysisViewState,
    spatialAuditRequested,
    setSpatialAuditRequested,
    spatialAuditExecutedRef,
    spatialAuditStatus,
    setSpatialAuditStatus,
    mapState,
    setMapState,
  } = useOutletContext<LayoutCtx>();
  const [selected, setSelected] = useState<UrbanFeature | null>(null);
  const [verificationTarget, setVerificationTarget] = useState<{
    feature: UrbanFeature;
    ai: AiVerificationContext;
  } | null>(null);
  const [aiHighlights, setAiHighlights] = useState<AiHighlight[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [quickAnalysisActive, setQuickAnalysisActive] = useState(
    quickAnalysisViewState.sidebarPanel === "analysis"
  );
  const [pointVerificationRefresh, setPointVerificationRefresh] = useState(0);

  const isMobile = useIsMobile();
  
  // Deliberately not persisted (no localStorage/sessionStorage) — a manual
  // resize only lives for as long as this component stays mounted, and a
  // fresh app load (or a hard refresh) always starts back at the default.
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const resizeStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const pendingWidthRef = useRef<number | null>(null);
  const resizeRafRef = useRef<number | null>(null);

  const clearResizeRaf = useCallback(() => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
  }, []);

  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeStateRef.current) return;
    resizeStateRef.current = null;
    clearResizeRaf();
    pendingWidthRef.current = null;
    document.body.classList.remove("is-resizing-sidebar");
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be gone (pointercancel, or released elsewhere) — harmless.
    }
  }, [clearResizeRaf]);

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-sidebar");
  }, [sidebarWidth]);

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeStateRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = event.clientX - drag.startX;
    const nextWidth = clamp(drag.startWidth + delta, MIN_SIDEBAR_WIDTH, viewportLimitedMaxWidth());
    pendingWidthRef.current = nextWidth;
    if (resizeRafRef.current === null) {
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        if (pendingWidthRef.current !== null) setSidebarWidth(pendingWidthRef.current);
      });
    }
  }, []);

  // Safety net: if this component unmounts mid-drag (e.g. a route change
  // triggered some other way), don't leave the resize cursor/no-select body
  // class stuck or a pending RAF dangling.
  useEffect(() => {
    return () => {
      clearResizeRaf();
      document.body.classList.remove("is-resizing-sidebar");
    };
  }, [clearResizeRaf]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? SIDEBAR_KEYBOARD_STEP_LARGE : SIDEBAR_KEYBOARD_STEP;
    const max = viewportLimitedMaxWidth();
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth((current) => clamp(current - step, MIN_SIDEBAR_WIDTH, max));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((current) => clamp(current + step, MIN_SIDEBAR_WIDTH, max));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(max);
    }
  }, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const locateFeatureId = searchParams.get("locateFeature") ?? undefined;
  const isolateFocusFeature = searchParams.get("focusMode") === "isolate";
  const workflowVerificationId = searchParams.get("workflowVerification");

  const handleSelect = useCallback(
    (
      feature: UrbanFeature | null,
      aiVerification?: AiVerificationContext | null,
    ) => {
      setSelected(feature);
      setVerificationTarget(
        feature && aiVerification ? { feature, ai: aiVerification } : null,
      );
    },
    [],
  );

  const handleFeatureLocated = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("locateFeature");
    next.delete("focusMode");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleActiveDatasetsChange = useCallback((rows: DatasetRow[]) => {
    setMapSelectedDatasets(rows);
    setSelectedDatasets(rows);
  }, [setMapSelectedDatasets, setSelectedDatasets]);

  return (
    <div
      className={`map-page map-page--dual${sidebarCollapsed ? " map-page--sidebar-collapsed" : ""}`}
      data-testid="map-page"
      style={!isMobile ? ({ "--map-sidebar-width": `${sidebarWidth}px` } as CSSProperties) : undefined}
    >
      <MapCanvas
        filter={filter}
        onFeatureSelect={handleSelect}
        initialActiveDatasets={mapSelectedDatasets}
        onActiveDatasetsChange={handleActiveDatasetsChange}
        initialRasterSettings={rasterSettingsById}
        onRasterSettingsChange={setRasterSettingsById}
        initialBasemap={basemap}
        onBasemapChange={setBasemap}
        aiHighlights={aiHighlights}
        focusFeatureId={locateFeatureId}
        isolateFocusFeature={isolateFocusFeature}
        onFocusHandled={handleFeatureLocated}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        onQuickAnalysisActiveChange={setQuickAnalysisActive}
        quickAnalysisViewState={quickAnalysisViewState}
        onQuickAnalysisViewStateChange={setQuickAnalysisViewState}
        refreshToken={pointVerificationRefresh}
        commandCenterMobileOpen={commandCenterMobileOpen}
        onCommandCenterMobileOpenChange={setCommandCenterMobileOpen}
        spatialAuditRequested={spatialAuditRequested}
        setSpatialAuditRequested={setSpatialAuditRequested}
        spatialAuditExecutedRef={spatialAuditExecutedRef}
        spatialAuditStatus={spatialAuditStatus}
        onSpatialAuditStatusChange={setSpatialAuditStatus}
        initialZoom={mapState.zoom}
        initialCenter={mapState.center}
        initialPitch={mapState.pitch}
        initialBearing={mapState.bearing}
        onCameraChange={setMapState}
      />

      {!isMobile && !sidebarCollapsed && (
        <div
          className="map-page__sidebar-resize-handle"
          style={{ left: SIDEBAR_RAIL_WIDTH + sidebarWidth }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize left sidebar"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={viewportLimitedMaxWidth()}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={handleResizeKeyDown}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          data-testid="map-sidebar-resize-handle"
        />
      )}

      {!quickAnalysisActive && <ReportGenerator datasets={mapSelectedDatasets} />}

      {!quickAnalysisActive && (
        <AiAssistant
          filter={filter}
          selectedFeature={selected}
          onAiHighlights={setAiHighlights}
        />
      )}

      <PointVerificationPanel
        feature={verificationTarget?.feature ?? null}
        aiVerification={verificationTarget?.ai ?? null}
        verificationId={workflowVerificationId}
        onClose={() => {
          setVerificationTarget(null);
          const next = new URLSearchParams(searchParams);
          next.delete("workflowVerification");
          next.delete("workflowNotification");
          setSearchParams(next, { replace: true });
        }}
        onUpdated={(updated) => {
          setSelected(updated);
          setVerificationTarget((current) =>
            current ? { ...current, feature: updated } : null,
          );
          setPointVerificationRefresh((value) => value + 1);
        }}
        onQueueChanged={() =>
          setPointVerificationRefresh((value) => value + 1)
        }
      />

    </div>
  );
}
