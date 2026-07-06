import { useState } from "react";
import { MapCanvas } from "../components/MapCanvas";
import { ArchitectWorkspace } from "../components/ArchitectWorkspace";
import { AiAssistant } from "../components/AiAssistant";
import { useOutletContext } from "react-router-dom";
import type { FeatureFilter, UrbanFeature } from "../lib/types";

interface LayoutCtx {
  filter: FeatureFilter;
}

export function MapView() {
  const { filter } = useOutletContext<LayoutCtx>();
  const [selected, setSelected] = useState<UrbanFeature | null>(null);

  return (
    <>
      <div
        className={`map-page${selected ? " map-page--triple" : " map-page--dual"}`}
        data-testid="map-page"
      >
        <MapCanvas filter={filter} onFeatureSelect={setSelected} />
        {selected && <ArchitectWorkspace feature={selected} onClose={() => setSelected(null)} />}
      </div>
      <AiAssistant filter={filter} selectedFeature={selected} />
    </>
  );
}
