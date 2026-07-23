import type { GisRow } from "./gisTypes";

export function featureIdFromRow(row: GisRow): string | null {
  const value = row.__feature_id;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function featureMapHref(row: GisRow): string | null {
  const featureId = featureIdFromRow(row);
  return featureId ? `/map?locateFeature=${encodeURIComponent(featureId)}&focusMode=isolate` : null;
}
