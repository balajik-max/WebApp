import type { UrbanFeature } from "./types";

export const TAX_PRINCIPAL_PROP = "__tax_principal";
export const TAX_CLASS_PROP = "__tax_class";
export const TAX_CLASS_SOURCE_PROP = "__tax_class_source";

export const PROPERTY_TAX_CLASSES = [
  { key: "Residential", label: "Residential", color: "#3b82f6" },
  { key: "Commercial", label: "Commercial", color: "#f59e0b" },
  { key: "Mixed Use", label: "Mixed Use", color: "#8b5cf6" },
  { key: "Industrial", label: "Industrial", color: "#64748b" },
  { key: "Public & Semi Public", label: "Public & Semi Public", color: "#14b8a6" },
  { key: "Dilapidated", label: "Dilapidated", color: "#ef4444" },
  { key: "Under Construction", label: "Under Construction", color: "#ec4899" },
  { key: "Other", label: "Other / Miscellaneous", color: "#a16207" },
  { key: "Unclassified", label: "Unclassified", color: "#94a3b8" },
] as const;

export type PropertyTaxClass = (typeof PROPERTY_TAX_CLASSES)[number]["key"];

export interface PropertyTaxClassification {
  isPrincipalBuilding: boolean;
  taxClass: PropertyTaxClass;
  source: string;
}

const USE_FIELD_CANDIDATES = [
  "G_Floor_Information",
  "Ground_Floor_Information",
  "Ground_Floor_Use",
  "GroundFloorUse",
  "Building_Use",
  "Building_Usage",
  "BuildingUse",
  "Property_Use",
  "PropertyUse",
  "Occupancy_Use",
  "OccupancyUse",
  "Current_Use",
  "CurrentUse",
  "Land_Use",
  "LandUse",
  "Use",
  "Usage",
  "Bldg_Use",
  "BldgUse",
  "BLDG_USE",
  "Built_Use",
  "BuiltUse",
  "Use_Class",
  "UseClass",
  "Property_Type",
  "PropertyType",
  "Property_Category",
  "PropertyCategory",
  "Main_Use",
  "MainUse",
  "Actual_Use",
  "ActualUse",
  "Present_Use",
  "PresentUse",
  "Ground_Floor",
  "GroundFloor",
  "G_Floor",
];

const BUILDING_TYPE_FIELD_CANDIDATES = [
  "Type_of_Building",
  "Building_Type",
  "BuildingType",
  "Structure_Type",
  "StructureType",
  "Bldg_Type",
  "BldgType",
  "BLDG_TYPE",
  "BTYPE",
  "Construction_Type",
  "ConstructionType",
];

const AUXILIARY_LAYER_TOKENS = [
  "roofline",
  "roof line",
  "step at gl",
  "step gl",
  "car porch",
  "porch",
  "transformer area",
  "transformer",
  "staircase",
  "balcony",
  "canopy",
  "compound wall",
];

function normalize(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ");
}

function nonBlank(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function findAttribute(
  attributes: Record<string, unknown>,
  candidates: string[],
): { key: string; value: unknown } | null {
  const direct = new Map(Object.keys(attributes).map((key) => [key.toLowerCase(), key]));
  for (const candidate of candidates) {
    const matchedKey = direct.get(candidate.toLowerCase());
    if (matchedKey && nonBlank(attributes[matchedKey])) {
      return { key: matchedKey, value: attributes[matchedKey] };
    }
  }

  const normalizedCandidates = new Set(candidates.map(normalize));
  for (const [key, value] of Object.entries(attributes)) {
    if (normalizedCandidates.has(normalize(key)) && nonBlank(value)) return { key, value };
  }
  return null;
}

function findUseAttribute(
  attributes: Record<string, unknown>,
): { key: string; value: unknown } | null {
  const exact = findAttribute(attributes, USE_FIELD_CANDIDATES);
  if (exact) return exact;

  // Vendors use many different headings. Prefer fields explicitly describing
  // a building/property/floor use and deliberately avoid generic boundary,
  // road and administrative "type" fields.
  const ranked = Object.entries(attributes)
    .filter(([, value]) => nonBlank(value))
    .map(([key, value]) => {
      const normalizedKey = normalize(key);
      let score = 0;
      if (normalizedKey.includes("building use") || normalizedKey.includes("bldg use")) score += 100;
      if (normalizedKey.includes("property use")) score += 95;
      if (normalizedKey.includes("ground floor") && (normalizedKey.includes("use") || normalizedKey.includes("information"))) score += 90;
      if (normalizedKey.includes("floor use") || normalizedKey.includes("floor information")) score += 85;
      if (normalizedKey.includes("occupancy use") || normalizedKey.includes("current use") || normalizedKey.includes("present use")) score += 80;
      if (normalizedKey === "use" || normalizedKey === "usage") score += 70;
      if (normalizedKey.includes("land use")) score += 45;
      if (normalizedKey.includes("boundary") || normalizedKey.includes("road") || normalizedKey.includes("ward")) score -= 120;
      if (normalizedKey.includes("id") || normalizedKey.includes("number") || normalizedKey.includes("name")) score -= 40;
      return { key, value, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0] ? { key: ranked[0].key, value: ranked[0].value } : null;
}

function classFromText(raw: unknown): PropertyTaxClass | null {
  const value = normalize(raw);
  if (!value) return null;

  // Specific combinations must be resolved before broad single-use matches.
  const hasResidential = /(^|\s)(r|res|residential|house|home|dwelling|flat|apartment)(\s|$)/.test(value);
  const hasCommercial = /(^|\s)(c|com|comm|commercial|shop|office|retail|business|hotel|lodge)(\s|$)/.test(value);

  if (
    value === "m"
    || value === "mix"
    || value.includes("mixed")
    || (hasResidential && hasCommercial)
    || value.includes("commercial and residential")
    || value.includes("residential and commercial")
    || value.includes("shop and residence")
  ) return "Mixed Use";

  if (
    value === "p and sp"
    || value === "psp"
    || value === "p sp"
    || value === "pub"
    || value.includes("public and semi public")
    || value.includes("public semi public")
    || value.includes("semi public")
    || value.includes("government")
    || value.includes("institutional")
    || value.includes("school")
    || value.includes("college")
    || value.includes("religious")
  ) return "Public & Semi Public";

  if (value === "r" || value === "res" || value.includes("residential") || value.includes("dwelling") || value.includes("house") || value.includes("apartment") || value.includes("flat")) {
    return "Residential";
  }
  if (value === "c" || value === "com" || value === "comm" || value.includes("commercial") || value.includes("shop") || value.includes("office") || value.includes("hotel") || value.includes("retail") || value.includes("business")) {
    return "Commercial";
  }
  if (value === "i" || value === "ind" || value.includes("industrial") || value.includes("factory") || value.includes("warehouse") || value.includes("workshop")) {
    return "Industrial";
  }
  if (value === "d" || value.includes("dilapidated") || value.includes("ruin") || value.includes("abandoned")) {
    return "Dilapidated";
  }
  if (value.includes("under construction") || value.includes("construction in progress") || value === "uc") {
    return "Under Construction";
  }
  if (value === "p" || value === "public") return "Public & Semi Public";
  if (value.includes("miscellaneous") || value.includes("misc") || value.includes("other")) return "Other";
  return null;
}

function sourceLayer(feature: UrbanFeature): string {
  const attributes = feature.properties.attributes ?? {};
  // Many municipal GDBs keep all polygons in one physical `Building` layer
  // and store the real class in a `Layer` attribute (for example
  // Commercial_Building, Building_Roofline, Step @ GL). Prefer that semantic
  // value so auxiliary geometry is not mistaken for a taxable structure.
  for (const key of ["Layer", "layer", "Feature_Layer", "FeatureLayer", "Sub_Class", "SubClass"]) {
    if (nonBlank(attributes[key])) return String(attributes[key]);
  }
  const gdbLayer = attributes.gdb_layer;
  if (nonBlank(gdbLayer)) return String(gdbLayer);
  return feature.properties.category ?? "";
}

function isPolygon(feature: UrbanFeature): boolean {
  return feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon";
}

export function classifyPropertyTaxFeature(feature: UrbanFeature): PropertyTaxClassification {
  if (!isPolygon(feature)) {
    return { isPrincipalBuilding: false, taxClass: "Unclassified", source: "non-polygon" };
  }

  const attributes = feature.properties.attributes ?? {};
  const layer = sourceLayer(feature);
  const normalizedLayer = normalize(layer);

  if (AUXILIARY_LAYER_TOKENS.some((token) => normalizedLayer.includes(token))) {
    return { isPrincipalBuilding: false, taxClass: "Unclassified", source: "auxiliary-layer" };
  }

  const buildingType = findAttribute(attributes, BUILDING_TYPE_FIELD_CANDIDATES);
  const useField = findUseAttribute(attributes);
  const layerLooksLikeBuilding = normalizedLayer.includes("building") || normalizedLayer.includes("structure");
  const categoryLooksLikeBuilding = normalize(feature.properties.category).includes("building")
    || normalize(feature.properties.category).includes("structure");
  const canonicalLooksLikeBuilding = normalize(feature.properties.canonical_class) === "building";
  const hasBuildingType = Boolean(buildingType);

  // Principal structures are identified first from the authoritative survey
  // building-type field, then from an actual building/structure source layer.
  // A use value alone is not enough because plot layers can also carry land-use.
  const isPrincipalBuilding = hasBuildingType || layerLooksLikeBuilding || categoryLooksLikeBuilding || canonicalLooksLikeBuilding;
  if (!isPrincipalBuilding) {
    return { isPrincipalBuilding: false, taxClass: "Unclassified", source: "not-building-layer" };
  }

  if (useField) {
    const fromUse = classFromText(useField.value);
    if (fromUse) {
      return { isPrincipalBuilding: true, taxClass: fromUse, source: `attribute:${useField.key}` };
    }
  }

  const fromLayer = classFromText(layer);
  if (fromLayer) {
    return { isPrincipalBuilding: true, taxClass: fromLayer, source: "source-layer" };
  }

  return { isPrincipalBuilding: true, taxClass: "Unclassified", source: "building-unclassified" };
}

export function propertyTaxColor(taxClass: PropertyTaxClass): string {
  return PROPERTY_TAX_CLASSES.find((item) => item.key === taxClass)?.color ?? "#94a3b8";
}

export function propertyTaxStats(features: UrbanFeature[]): {
  total: number;
  classified: number;
  unclassified: number;
  counts: Record<PropertyTaxClass, number>;
} {
  const counts = Object.fromEntries(PROPERTY_TAX_CLASSES.map((item) => [item.key, 0])) as Record<PropertyTaxClass, number>;
  let total = 0;
  for (const feature of features) {
    const result = classifyPropertyTaxFeature(feature);
    if (!result.isPrincipalBuilding) continue;
    total += 1;
    counts[result.taxClass] += 1;
  }
  const unclassified = counts.Unclassified;
  return { total, classified: total - unclassified, unclassified, counts };
}
