import {
  useState, useCallback, useRef, useEffect,
  type MutableRefObject, type CSSProperties,
  type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent,
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
import { DropOverlay } from "../components/DropOverlay";
import { useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import type { AiHighlight, FeatureFilter, UrbanFeature } from "../lib/types";
import type { DatasetRow } from "../lib/workflow";
import { useIsMobile } from "../lib/useIsMobile";
import type { QuickAnalysisViewState } from "../lib/quickAnalysisViewState";
import { logActivity } from "../lib/activityLog";
import { useUploadTransfer } from "../context/UploadTransferContext";
import { collectDroppedFolder, classifyAndZipFolder, type WebkitEntry } from "../lib/datasetFileIntake";
import type { DetectionMode } from "../lib/detectionMode";

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
  detectionMode: DetectionMode;
  setDetectionMode: (mode: DetectionMode) => void;
  aiOverlayEnabled: boolean;
  setAiOverlayEnabled: (enabled: boolean) => void;
  roadInspectionActive: boolean;
  setRoadInspectionActive: (active: boolean) => void;
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
    detectionMode,
    setDetectionMode,
    aiOverlayEnabled,
    setAiOverlayEnabled,
    roadInspectionActive,
    setRoadInspectionActive,
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

  useEffect(() => {
    logActivity("page_viewed", undefined, { page: "map", page_label: "Map" });
  }, []);

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

  // ── Drag a file in from outside the browser -> hand off to Datasets ──────
  // Dropping an external file anywhere on the Map page stages it in
  // UploadTransferContext and redirects to /datasets, where the existing
  // dropzone flow (name/ward fields, shapefile-bundle/photo-batch/OBJ
  // detection) picks it up and finishes the job. A drag counter tracks
  // nested dragenter/dragleave pairs so the overlay doesn't flicker while
  // the pointer crosses child elements. Checking `types.includes("Files")`
  // is what keeps this from reacting to the map's own internal
  // drag-and-drop (layer-group reordering), which never carries a "Files"
  // type.
  const navigate = useNavigate();
  const { stageFilesForUpload } = useUploadTransfer();
  const dragDepthRef = useRef(0);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [folderDropStatus, setFolderDropStatus] = useState<"idle" | "processing">("idle");
  const [dropError, setDropError] = useState<string | null>(null);

  useEffect(() => {
    if (!dropError) return;
    const timer = window.setTimeout(() => setDropError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [dropError]);

  const isExternalFileDrag = (event: ReactDragEvent<HTMLDivElement>) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const handleDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFile(true);
  }, []);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFile(false);
  }, []);

  const handleDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);

    // A dropped folder (e.g. an unzipped .gdb) arrives as a
    // FileSystemEntry via dataTransfer.items, not as a normal File — must
    // be read via webkitGetAsEntry() synchronously, here in the drop
    // handler, before any await (same constraint the Datasets page's own
    // dropzone already works around).
    const item = event.dataTransfer.items?.[0];
    const entry = (item as unknown as { webkitGetAsEntry?: () => WebkitEntry | null })
      ?.webkitGetAsEntry?.();
    if (entry && !entry.isFile) {
      setFolderDropStatus("processing");
      void (async () => {
        try {
          const collected = await collectDroppedFolder(entry);
          const { file } = await classifyAndZipFolder(entry.name, collected);
          stageFilesForUpload([file]);
          navigate("/datasets");
        } catch (err) {
          setDropError((err as Error).message || "Couldn't read that folder.");
        } finally {
          setFolderDropStatus("idle");
        }
      })();
      return;
    }

    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    stageFilesForUpload(files);
    navigate("/datasets");
  }, [navigate, stageFilesForUpload]);

  return (
    <div
      className={`map-page map-page--dual${sidebarCollapsed ? " map-page--sidebar-collapsed" : ""}`}
      data-testid="map-page"
      style={!isMobile ? ({ "--map-sidebar-width": `${sidebarWidth}px` } as CSSProperties) : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropOverlay
        visible={isDraggingFile || folderDropStatus === "processing"}
        state={folderDropStatus === "processing" ? "processing" : "hover"}
      />
      {dropError && (
        <div className="map-drop-error" data-testid="map-drop-error">
          <svg className="map-drop-error__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
          </svg>
          <span>{dropError}</span>
          <button
            type="button"
            className="map-drop-error__dismiss"
            aria-label="Dismiss"
            onClick={() => setDropError(null)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}

      <MapCanvas
        filter={filter}
        onFeatureSelect={handleSelect}
        initialActiveDatasets={mapSelectedDatasets}
        onActiveDatasetsChange={handleActiveDatasetsChange}
        initialRasterSettings={rasterSettingsById}
        onRasterSettingsChange={setRasterSettingsById}
        initialBasemap={basemap}
        onBasemapChange={setBasemap}
        initialDetectionMode={detectionMode}
        onDetectionModeChange={setDetectionMode}
        initialAiOverlayEnabled={aiOverlayEnabled}
        onAiOverlayEnabledChange={setAiOverlayEnabled}
        initialRoadInspectionActive={roadInspectionActive}
        onRoadInspectionActiveChange={setRoadInspectionActive}
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
