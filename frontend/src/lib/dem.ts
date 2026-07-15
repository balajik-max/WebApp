/** Real elevation grid + building-height sampling for the 3D manhole plan
 * view (Phase C). Both come straight from the DTM/DSM GeoTIFFs already
 * uploaded — no synthetic terrain, no guessed storey counts. */
import { apiGet } from "./api";

export interface DemBounds {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

export interface DemGrid {
  bounds: DemBounds;
  resolution: number;
  elevations: (number | null)[][];
}

export const fetchDemGrid = (datasetId: string, resolution = 150) =>
  apiGet<DemGrid>(`/api/v1/datasets/${datasetId}/dem-grid?resolution=${resolution}`);

export interface BuildingHeight {
  height_m: number | null;
  estimated: boolean;
}

export interface BuildingHeights {
  heights: Record<string, BuildingHeight>;
}

export const fetchBuildingHeights = (
  wardDatasetId: string,
  dsmDatasetId: string,
  dtmDatasetId: string
) =>
  apiGet<BuildingHeights>(
    `/api/v1/datasets/building-heights?ward_dataset_id=${wardDatasetId}&dsm_dataset_id=${dsmDatasetId}&dtm_dataset_id=${dtmDatasetId}`
  );
