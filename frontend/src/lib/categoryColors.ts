/**
 * Single source of truth for category → color so the map, the analytics
 * charts, and any future view all render the same category with the same
 * color. Deterministic hash of the category name — independent of load
 * order, viewport, or sort order, so it never drifts between screens.
 */
export const CATEGORY_PALETTE = [
  "#3aa1ff", "#c47af5", "#f5c542", "#5be08a", "#ff5a3d",
  "#4dd0e1", "#f78fb3", "#a3d977", "#ffa552", "#8e7cc3",
  "#54c7c1", "#e0596b",
];

export const UNCATEGORIZED_COLOR = "#8ea3a0";

export function colorForCategory(category: string | null | undefined): string {
  const key = category && category.trim() !== "" ? category : "uncategorized";
  if (key === "uncategorized") return UNCATEGORIZED_COLOR;

  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % CATEGORY_PALETTE.length;
  return CATEGORY_PALETTE[index];
}
