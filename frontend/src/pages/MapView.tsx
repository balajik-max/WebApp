import { useState, useCallback, useRef } from "react";
import { MapCanvas, type MapCanvasHandle } from "../components/MapCanvas";
import { WardReportPanel } from "../components/WardReportPanel";
import { AiAssistant } from "../components/AiAssistant";
import { useOutletContext } from "react-router-dom";
import type { AiHighlight, FeatureFilter, UrbanFeature } from "../lib/types";
import type { DatasetRow } from "../lib/workflow";

interface LayoutCtx {
  filter: FeatureFilter;
  selectedDatasets: DatasetRow[];
  setSelectedDatasets: (rows: DatasetRow[]) => void;
}

export function MapView() {
  const { filter, selectedDatasets, setSelectedDatasets } = useOutletContext<LayoutCtx>();
  const [selected, setSelected] = useState<UrbanFeature | null>(null);
  const [aiHighlights, setAiHighlights] = useState<AiHighlight[]>([]);
  const mapRef = useRef<MapCanvasHandle | null>(null);

  const handleSelect = useCallback((feature: UrbanFeature | null) => {
    setSelected(feature);
  }, []);

  const handleCloseReport = useCallback(() => {
    mapRef.current?.clearDatasets();
  }, []);

  return (
    <div
      className={`map-page${selectedDatasets.length > 0 ? " map-page--triple" : " map-page--dual"}`}
      data-testid="map-page"
    >
      <MapCanvas
        ref={mapRef}
        filter={filter}
        onFeatureSelect={handleSelect}
        initialActiveDatasets={selectedDatasets}
        onActiveDatasetsChange={setSelectedDatasets}
        aiHighlights={aiHighlights}
      />
      {selectedDatasets.length > 0 && (
        <WardReportPanel datasets={selectedDatasets} onClose={handleCloseReport} />
      )}
      <AiAssistant
        filter={filter}
        selectedFeature={selected}
        onAiHighlights={setAiHighlights}
      />
    </div>
  );
}
