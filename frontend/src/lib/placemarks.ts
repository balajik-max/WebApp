import { apiDelete, apiGet, apiPatch, apiPost } from "./api";

export type PlacemarkIcon = "pin" | "star" | "flag" | "survey";

export interface Placemark {
  id: string;
  owner_id: string;
  dataset_id: string | null;
  name: string;
  description: string | null;
  category: string | null;
  icon: string;
  longitude: number;
  latitude: number;
  altitude: number | null;
  is_visible: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlacemarkPayload {
  name: string;
  description?: string | null;
  category?: string | null;
  icon?: string;
  longitude: number;
  latitude: number;
  altitude?: number | null;
  dataset_id?: string | null;
  is_visible?: boolean;
}

export interface PlacemarkDraft extends PlacemarkPayload {
  id?: string;
}

export interface ElevationSample {
  elevation: number | null;
  distance_m: number | null;
  source: string | null;
}

export function fetchPlacemarks(signal?: AbortSignal) {
  return apiGet<Placemark[]>("/api/v1/placemarks?include_hidden=true&limit=1000", signal);
}

export function createPlacemark(payload: PlacemarkPayload, signal?: AbortSignal) {
  return apiPost<Placemark>("/api/v1/placemarks", payload, signal);
}

export function updatePlacemark(id: string, payload: Partial<PlacemarkPayload>, signal?: AbortSignal) {
  return apiPatch<Placemark>(`/api/v1/placemarks/${id}`, payload, signal);
}

export function deletePlacemark(id: string, signal?: AbortSignal) {
  return apiDelete(`/api/v1/placemarks/${id}`, signal);
}

export function bulkDeletePlacemarks(ids: string[], signal?: AbortSignal) {
  return apiPost<{ deleted: number }>("/api/v1/placemarks/bulk-delete", { ids }, signal);
}

export function fetchElevationSample(
  datasetId: string,
  longitude: number,
  latitude: number,
  signal?: AbortSignal
) {
  const params = new URLSearchParams({
    dataset_id: datasetId,
    longitude: String(longitude),
    latitude: String(latitude),
  });
  return apiGet<ElevationSample>(`/api/v1/map-context/elevation?${params.toString()}`, signal);
}
