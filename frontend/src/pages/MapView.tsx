import { useState, useCallback, useRef } from "react";
import { MapCanvas, type MapCanvasHandle } from "../components/MapCanvas";
import { ReportGenerator } from "../components/WardReportPanel";
import { AiAssistant } from "../components/AiAssistant";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { AiHighlight, FeatureFilter, UrbanFeature } from "../lib/types";
import type { DatasetRow } from "../lib/workflow";

interface LayoutCtx {
  filter: FeatureFilter;
  selectedDatasets: DatasetRow[];
  setSelectedDatasets: (rows: DatasetRow[]) => void;
  commandCenterMobileOpen: boolean;
  setCommandCenterMobileOpen: (open: boolean) => void;
}

export function MapView() {
  const {
    filter,
    selectedDatasets,
    setSelectedDatasets,
    commandCenterMobileOpen,
    setCommandCenterMobileOpen,
  } = useOutletContext<LayoutCtx>();
  const [selected, setSelected] = useState<UrbanFeature | null>(null);
  const [aiHighlights, setAiHighlights] = useState<AiHighlight[]>([]);
  const mapRef = useRef<MapCanvasHandle | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const locateFeatureId = searchParams.get("locateFeature") ?? undefined;

  const handleSelect = useCallback((feature: UrbanFeature | null) => {
    setSelected(feature);
  }, []);

  const handleFeatureLocated = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("locateFeature");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div className="map-page map-page--dual" data-testid="map-page">
      <MapCanvas
        ref={mapRef}
        filter={filter}
        onFeatureSelect={handleSelect}
        initialActiveDatasets={selectedDatasets}
        onActiveDatasetsChange={setSelectedDatasets}
        aiHighlights={aiHighlights}
        focusFeatureId={locateFeatureId}
        onFocusHandled={handleFeatureLocated}
        commandCenterMobileOpen={commandCenterMobileOpen}
        onCommandCenterMobileOpenChange={setCommandCenterMobileOpen}
      />
      <ReportGenerator datasets={selectedDatasets} />
      <AiAssistant
        filter={filter}
        selectedFeature={selected}
        onAiHighlights={setAiHighlights}
      />
    </div>
  );
}
