import { useEffect, useState, useCallback, useRef } from "react";
import { MapCanvas, type AiVerificationContext, type MapCanvasHandle } from "../components/MapCanvas";
import { WardReportPanel } from "../components/WardReportPanel";
import { AiAssistant } from "../components/AiAssistant";
import { PointVerificationPanel } from "../components/PointVerificationPanel";
import { RemediationInbox } from "../components/RemediationInbox";
import { RemediationUpdates } from "../components/RemediationUpdates";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { AiHighlight, FeatureFilter, UrbanFeature } from "../lib/types";
import type { RemediationInboxItem, RemediationUpdateItem } from "../lib/pointVerifications";
import type { DatasetRow } from "../lib/workflow";

interface LayoutCtx {
  filter: FeatureFilter;
  selectedDatasets: DatasetRow[];
  setSelectedDatasets: (rows: DatasetRow[]) => void;
  onMeasureChange: (active: boolean) => void;
  registerMeasure: (api: { toggle: () => void }) => void;
}

export function MapView() {
  const { filter, selectedDatasets, setSelectedDatasets, onMeasureChange, registerMeasure } =
    useOutletContext<LayoutCtx>();
  const [selected, setSelected] = useState<UrbanFeature | null>(null);
  const [verificationTarget, setVerificationTarget] = useState<{ feature: UrbanFeature; ai: AiVerificationContext } | null>(null);
  const [aiHighlights, setAiHighlights] = useState<AiHighlight[]>([]);
  const [reportPanelCollapsed, setReportPanelCollapsed] = useState(false);
  const [pointVerificationRefresh, setPointVerificationRefresh] = useState(0);
  const mapRef = useRef<MapCanvasHandle | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const locateFeatureId = searchParams.get("locateFeature") ?? undefined;

  // Bridge the map's imperative Measure toggle up to the top navigation bar.
  // The sole authoritative Measure state stays inside MapCanvas; this only
  // hands the existing handler to the topbar button.
  useEffect(() => {
    registerMeasure({ toggle: () => mapRef.current?.toggleMeasure() });
    return () => {
      registerMeasure({ toggle: () => {} });
      onMeasureChange(false);
    };
  }, [registerMeasure, onMeasureChange]);

  const handleSelect = useCallback((feature: UrbanFeature | null, aiVerification?: AiVerificationContext | null) => {
    setSelected(feature);
    setVerificationTarget(feature && aiVerification ? { feature, ai: aiVerification } : null);
  }, []);

  const handleFeatureLocated = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("locateFeature");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleRemediationLocate = useCallback((item: RemediationInboxItem) => {
    const next = new URLSearchParams(searchParams);
    next.set("locateFeature", item.feature_id);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleRemediationUpdateLocate = useCallback((item: RemediationUpdateItem) => {
    if (!item.feature_id) return;
    const next = new URLSearchParams(searchParams);
    next.set("locateFeature", item.feature_id);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div
      className={`map-page map-page--triple${reportPanelCollapsed ? " map-page--report-collapsed" : ""}`}
      data-testid="map-page"
    >
      <MapCanvas
        ref={mapRef}
        filter={filter}
        onFeatureSelect={handleSelect}
        initialActiveDatasets={selectedDatasets}
        onActiveDatasetsChange={setSelectedDatasets}
        aiHighlights={aiHighlights}
        focusFeatureId={locateFeatureId}
        onFocusHandled={handleFeatureLocated}
        onMeasureChange={onMeasureChange}
        refreshToken={pointVerificationRefresh}
      />
      <WardReportPanel
        datasets={selectedDatasets}
        collapsed={reportPanelCollapsed}
        onToggleCollapsed={() => setReportPanelCollapsed((v) => !v)}
      />
      <AiAssistant
        filter={filter}
        selectedFeature={selected}
        onAiHighlights={setAiHighlights}
      />
      <PointVerificationPanel
        feature={verificationTarget?.feature ?? null}
        aiVerification={verificationTarget?.ai ?? null}
        onClose={() => setVerificationTarget(null)}
        onUpdated={(updated) => {
          setSelected(updated);
          setVerificationTarget((current) => current ? { ...current, feature: updated } : null);
          setPointVerificationRefresh((value) => value + 1);
        }}
        onQueueChanged={() => setPointVerificationRefresh((value) => value + 1)}
      />
      <RemediationInbox refreshToken={pointVerificationRefresh} onLocate={handleRemediationLocate} />
      <RemediationUpdates refreshToken={pointVerificationRefresh} onLocate={handleRemediationUpdateLocate} />
    </div>
  );
}
