import { useEffect, useState, useCallback, useRef } from "react";
import { MapCanvas, type MapCanvasHandle } from "../components/MapCanvas";
import { WardReportPanel } from "../components/WardReportPanel";
import { AiAssistant } from "../components/AiAssistant";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { AiHighlight, FeatureFilter, UrbanFeature } from "../lib/types";
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
  const [aiHighlights, setAiHighlights] = useState<AiHighlight[]>([]);
  const [reportPanelCollapsed, setReportPanelCollapsed] = useState(false);
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

  const handleSelect = useCallback((feature: UrbanFeature | null) => {
    setSelected(feature);
  }, []);

  const handleFeatureLocated = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("locateFeature");
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
    </div>
  );
}
