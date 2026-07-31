import { apiDelete, apiGet, apiPost, apiPostForm, apiPut, ApiError } from "./api";
import type { UrbanFeature } from "./types";
import { classifyPropertyTaxFeature, type PropertyTaxClass } from "./propertyTax";

export type PropertyTaxAssessmentStatus =
  | "not_assessed"
  | "draft"
  | "verification_pending"
  | "verified"
  | "approved"
  | "demand_generated";

export type PropertyTaxDiscrepancyStatus =
  | "not_reviewed"
  | "no_discrepancy"
  | "verification_required"
  | "under_review"
  | "accepted"
  | "corrected";

export interface FloorTaxLine {
  floor_name: string;
  property_use: string | null;
  area_sqm: number;
  annual_rate_per_sqm: number | null;
  usage_factor: number;
}

export interface SurveyIdentifier {
  label: string;
  value: string;
  source_field: string;
}

export interface SurveyEnrichment {
  building_feature_id: string;
  plot_feature_id: string | null;
  plot_attributes: Record<string, unknown>;
  plot_geometry_area_sqm: number | null;
}

export interface GisTaxSnapshot {
  feature_id: string;
  dataset_id: string;
  label: string;
  tax_class: PropertyTaxClass;
  classification_source: string;
  property_id: string | null;
  assessment_number: string | null;
  owner_name: string | null;
  tax_zone: string | null;
  plot_area_sqm: number | null;
  footprint_area_sqm: number | null;
  built_up_area_sqm: number | null;
  floor_count: number | null;
  construction_type: string | null;
  occupancy_status: string | null;
  floor_assessments: FloorTaxLine[];
  identifiers: SurveyIdentifier[];
  source_fields: Record<string, string>;
  survey_attributes: Record<string, string>;
  populated_field_count: number;
  indicative_rate_per_sqm: number;
  indicative_rate_source: string;
  usage_factor: number;
  zone_factor: number;
  construction_factor: number;
  age_factor: number;
}

export interface MunicipalPropertyRecord {
  id: string;
  dataset_id: string | null;
  feature_id: string | null;
  property_id: string | null;
  assessment_number: string | null;
  sas_number: string | null;
  door_number: string | null;
  owner_name: string | null;
  owner_mobile: string | null;
  address: string | null;
  municipal_use: string | null;
  occupancy_status: string | null;
  construction_type: string | null;
  tax_zone: string | null;
  municipal_plot_area_sqm: number | null;
  municipal_built_up_area_sqm: number | null;
  municipal_floor_count: number | null;
  annual_rate_per_sqm: number | null;
  financial_year: string | null;
  source_latitude: number | null;
  source_longitude: number | null;
  source_name: string;
  source_row_number: number | null;
  match_method: string | null;
  match_confidence: number | null;
  linked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MunicipalRecordImportResult {
  source_name: string;
  imported: number;
  linked: number;
  exact_linked: number;
  spatial_linked: number;
  unlinked: number;
  skipped: number;
  errors: string[];
}

/**
 * The backend column names still contain the legacy `municipal_*` prefix for
 * database compatibility. In the Phase 3 GIS-first interface these values are
 * the editable/verified survey assessment values seeded from the uploaded GIS.
 */
export interface PropertyTaxAssessment {
  id: string;
  feature_id: string;
  dataset_id: string;
  created_by_id: string | null;
  updated_by_id: string | null;
  status: PropertyTaxAssessmentStatus;
  property_id: string | null;
  assessment_number: string | null;
  owner_name: string | null;
  occupancy_status: string | null;
  construction_type: string | null;
  tax_zone: string | null;
  municipal_use: string | null;
  municipal_plot_area_sqm: number | null;
  municipal_built_up_area_sqm: number | null;
  municipal_floor_count: number | null;
  municipal_record_id: string | null;
  financial_year: string;
  discrepancy_status: PropertyTaxDiscrepancyStatus;
  floor_assessments: FloorTaxLine[];
  annual_rate_per_sqm: number | null;
  usage_factor: number;
  zone_factor: number;
  construction_factor: number;
  age_factor: number;
  cess_percent: number;
  service_charge: number;
  rebate_amount: number;
  exemption_amount: number;
  base_annual_tax: number | null;
  estimated_annual_tax: number | null;
  remarks: string | null;
  gis_snapshot: GisTaxSnapshot;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PropertyTaxAssessmentPayload {
  status: PropertyTaxAssessmentStatus;
  property_id: string | null;
  assessment_number: string | null;
  owner_name: string | null;
  occupancy_status: string | null;
  construction_type: string | null;
  tax_zone: string | null;
  municipal_use: string | null;
  municipal_plot_area_sqm: number | null;
  municipal_built_up_area_sqm: number | null;
  municipal_floor_count: number | null;
  municipal_record_id: string | null;
  financial_year: string;
  discrepancy_status: PropertyTaxDiscrepancyStatus;
  floor_assessments: FloorTaxLine[];
  annual_rate_per_sqm: number | null;
  usage_factor: number;
  zone_factor: number;
  construction_factor: number;
  age_factor: number;
  cess_percent: number;
  service_charge: number;
  rebate_amount: number;
  exemption_amount: number;
  base_annual_tax: number | null;
  estimated_annual_tax: number | null;
  remarks: string | null;
  gis_snapshot: GisTaxSnapshot;
}

export interface PropertyTaxAssessmentRevision {
  id: string;
  assessment_id: string;
  feature_id: string;
  dataset_id: string;
  changed_by_id: string | null;
  version: number;
  status: string;
  change_reason: string | null;
  changed_fields: Record<string, { before: unknown; after: unknown }>;
  snapshot: Record<string, unknown>;
  created_at: string;
}

export interface PropertyTaxDemand {
  id: string;
  assessment_id: string;
  feature_id: string;
  dataset_id: string;
  generated_by_id: string | null;
  financial_year: string;
  demand_number: string;
  status: string;
  base_tax: number;
  cess_amount: number;
  service_charge: number;
  rebate_amount: number;
  exemption_amount: number;
  total_demand: number;
  calculation_breakdown: Record<string, unknown>;
  generated_at: string;
  created_at: string;
  updated_at: string;
}

export interface TaxCalculation {
  baseTax: number | null;
  cessAmount: number | null;
  totalTax: number | null;
  calculationMode: "floor_wise" | "whole_building" | "incomplete";
}

export const PROPERTY_TAX_STATUS_OPTIONS: Array<{ value: PropertyTaxAssessmentStatus; label: string }> = [
  { value: "not_assessed", label: "Not assessed" },
  { value: "draft", label: "Draft survey assessment" },
  { value: "verification_pending", label: "Field verification pending" },
  { value: "verified", label: "Survey verified" },
  { value: "approved", label: "Approved provisional assessment" },
  { value: "demand_generated", label: "Provisional demand generated" },
];

export const PROPERTY_TAX_DISCREPANCY_OPTIONS: Array<{ value: PropertyTaxDiscrepancyStatus; label: string }> = [
  { value: "not_reviewed", label: "Not reviewed" },
  { value: "no_discrepancy", label: "Survey data complete" },
  { value: "verification_required", label: "Field verification required" },
  { value: "under_review", label: "Under review" },
  { value: "accepted", label: "Survey value accepted" },
  { value: "corrected", label: "Survey value corrected" },
];

const FIELD_CANDIDATES = {
  propertyId: [
    "Property_ID", "Property ID", "PropertyID", "Existing_PID", "Existing PID", "PID",
    "Premise_Unique_No", "Premise Unique No", "System_Generatd_Premise_ID",
    "System_Generated_Premise_ID", "Premise_ID", "Building_ID", "Building_ID_1",
  ],
  assessmentNumber: [
    "Assessment_No", "Assessment No", "Assessment_Number", "Assessment Number",
    "Assesment_No", "Assmt_No", "SAS_No", "SAS No",
  ],
  ownerName: [
    "Owner_Name", "Owner Name", "Owner", "Property_Owner", "Land_Owner_Name",
    "Developer_Promoter_Architect_Land_Owner_Owners_Details_Name",
  ],
  taxZone: [
    "Tax_Zone", "Tax Zone", "Property_Zone", "Valuation_Zone", "Zone_Name", "Zone",
  ],
  propertyUse: [
    "MIXED_TYPE", "Mixed_Type", "Sub_Uses", "Occupancy_Use", "Building_Use",
    "Property_Use", "Current_Use", "Land_Use", "G_Floor_Information", "Layer",
  ],
  plotArea: [
    "Extent_of_the_Plot_as_per_survey", "Plot_Area", "Plot Area", "PlotArea",
    "Plot_Extent", "Plot_Extent_Sqm", "Site_Area", "Site Area", "Property_Area",
    "Parcel_Area", "Total_Plot_Area", "Surveyed_Plot_Area", "Plot_Geometry_Area_Sqm",
  ],
  footprint: [
    "Coverage_Foot_Print_Sqm", "Coverage Foot Print Sqm", "Building_Footprint",
    "Building_Footprint_Area", "Footprint_Area", "Ground_Coverage", "Building_Area",
    "Shape_Area", "SHAPE_Area", "Shape__Area",
  ],
  builtUp: [
    "Approx_Building_Area_Sqm", "Built_up_Area_sqm", "Built_Up_Area", "Built-up Area",
    "BuiltUpArea", "Total_Built_Up_Area", "Total_Builtup_Area", "Total_Builtup",
    "Buildup_Area", "Builtup_Area", "Documented_Building_Area_Sqm",
  ],
  floors: [
    "No_of_Floors", "No. of Floors", "Number_of_Floors", "Number of Floors",
    "Total_No_of_Floors", "Total_Floors", "Floor_Count", "Floors",
  ],
  construction: [
    "Type_of_Building", "Building_Type", "BuildingType", "Construction_Type",
    "ConstructionType", "Structure_Type", "StructureType", "Roof_Type",
  ],
  occupancy: [
    "Occupancy_Status", "OccupancyStatus", "Occupancy", "Occupancy_Type",
    "Occupancy_Use", "Tenure", "Owner_Occupied", "Rental_Status",
  ],
  annualRate: [
    "Annual_Rate_Per_Sqm", "Annual Rate Per Sqm", "Tax_Rate_Per_Sqm", "Tax Rate Per Sqm",
    "Rate_Per_Sqm", "Rate per sqm", "SR_Rate", "SR Rate", "Unit_Rate", "Property_Tax_Rate",
  ],
  usageFactor: ["Usage_Factor", "Use_Factor", "Property_Use_Factor"],
  zoneFactor: ["Zone_Factor", "Tax_Zone_Factor", "Location_Factor"],
  constructionFactor: ["Construction_Factor", "Building_Type_Factor", "Structure_Factor"],
  ageFactor: ["Age_Factor", "Depreciation_Factor"],
  buildingAge: ["Building_Age", "Age_of_Building", "Building Age", "Age"],
  constructionYear: ["Year_of_Construction", "Construction_Year", "Year Built", "Built_Year"],
  cessPercent: ["Cess_Percent", "Cess", "Tax_Cess_Percent"],
  serviceCharge: ["Service_Charge", "Annual_Service_Charge"],
  buildingName: ["Building_Name", "Building Name", "Premise_Name_No", "Property_Name", "Name"],
  buildingId: ["Building_ID", "Building_ID_1", "Building ID", "Structure_ID"],
  plotId: ["Plot_ID", "Plot ID", "Existing_PID", "Spatial_Plot_Feature_ID"],
  premiseId: ["Premise_ID", "Premise_Unique_No", "System_Generatd_Premise_ID", "System_Generated_Premise_ID"],
  doorNumber: ["Door_No", "Door No", "Door_Number", "House_No", "House Number"],
  sasNumber: ["SAS_No", "SAS No", "SAS_Number"],
  rrNumber: ["RR_No", "RR No", "RR_Number"],
  waterConnection: ["Water_Connection_No", "Water Connection No", "Water_Connection_Number"],
  wardNumber: ["Ward_No", "Ward No", "Ward_Number", "Ward"],
  blockNumber: ["Block_No", "Block No", "Block_Number", "Block"],
  surveyNumber: ["Survey_No", "Survey No", "R_S_No", "T_S_No", "UPOR_No"],
  ownerMobile: ["Owner_Mobile_No", "Owner Mobile No", "Owner_Mobile", "Mobile_No"],
  ownerEmail: ["Owner_Email", "Owner Email", "Email"],
  tenantName: ["Tenant_Name", "Tenant Name"],
  cadText: ["CAD_TEXT", "CAD Text"],
} as const;

const FLOOR_FIELD_DEFINITIONS = [
  { keys: ["B_Floor_Information", "Basement_Floor_Information", "Basement_Use"], name: "Basement" },
  { keys: ["LG_Floor_Information", "Lower_Ground_Floor_Information"], name: "Lower ground floor" },
  { keys: ["UG_Floor_Information", "Upper_Ground_Floor_Information"], name: "Upper ground floor" },
  { keys: ["G_Floor_Information", "Ground_Floor_Information", "Ground_Floor_Use"], name: "Ground floor" },
  { keys: ["FF_Floor_Information", "First_Floor_Information", "First_Floor_Use", "1st_Floor_Information"], name: "First floor" },
  { keys: ["SF_Floor_Information", "Second_Floor_Information", "Second_Floor_Use", "2nd_Floor_Information"], name: "Second floor" },
  { keys: ["TF_Floor_Information", "Third_Floor_Information", "Third_Floor_Use", "3rd_Floor_Information"], name: "Third floor" },
  { keys: ["Fourth_Floor_Information", "Fourth_Floor_Use", "4th_Floor_Information"], name: "Fourth floor" },
  { keys: ["Fifth_Floor_Information", "Fifth_Floor_Use", "5th_Floor_Information"], name: "Fifth floor" },
] as const;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isMeaningful(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const cleaned = String(value).trim().toLowerCase();
  return cleaned !== "" && !["null", "none", "nan", "n/a", "na", "-"].includes(cleaned);
}

function findValue(
  attributes: Record<string, unknown>,
  candidates: readonly string[],
): { value: unknown; key: string } | null {
  const normalized = new Map(Object.keys(attributes).map((key) => [normalizeKey(key), key]));
  for (const candidate of candidates) {
    const key = normalized.get(normalizeKey(candidate));
    if (!key) continue;
    const value = attributes[key];
    if (isMeaningful(value)) return { value, key };
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isMeaningful(value)) return null;
  const cleaned = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!cleaned) return null;
  const parsed = Number(cleaned[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function asText(value: unknown): string | null {
  if (!isMeaningful(value)) return null;
  return String(value).trim();
}

function canonicalConstruction(value: unknown): string | null {
  const raw = asText(value);
  if (!raw) return null;
  const normalized = normalizeKey(raw);
  if (normalized === "p" || normalized.includes("pucca") || normalized.includes("permanent")) return "Pucca";
  if (normalized === "sp" || normalized.includes("semipucca") || normalized.includes("semipermanent")) return "Semi-pucca";
  if (normalized === "k" || normalized.includes("kutcha") || normalized.includes("katcha")) return "Kutcha";
  if (normalized.includes("rcc") || normalized.includes("framed")) return "RCC framed";
  if (normalized.includes("loadbearing")) return "Load bearing";
  if (normalized.includes("sheet") || normalized.includes("tin") || normalized.includes("asbestos")) return "Tin / sheet roof";
  if (normalized.includes("temporary")) return "Temporary";
  if (normalized.includes("dilapidated") || normalized.includes("unsafe")) return "Dilapidated";
  return raw;
}

function canonicalOccupancy(value: unknown): string | null {
  const raw = asText(value);
  if (!raw) return null;
  const normalized = normalizeKey(raw);
  if (normalized.includes("owneroccupied") || normalized.includes("selfoccupied")) return "Owner occupied";
  if (normalized.includes("partiallyrented") || normalized.includes("partlyrented")) return "Partially rented";
  if (normalized.includes("fullyrented")) return "Fully rented";
  if (normalized.includes("tenant") || normalized.includes("rented") || normalized.includes("leased")) return "Tenant occupied";
  if (normalized === "vacant" || normalized.includes("unoccupied")) return "Vacant";
  if (normalized.includes("locked")) return "Locked during survey";
  if (normalized.includes("underconstruction")) return "Under construction";
  if (normalized.includes("abandoned")) return "Abandoned";
  return raw;
}

function asPropertyTaxClass(value: string | null): PropertyTaxClass | null {
  if (!value) return null;
  const allowed: PropertyTaxClass[] = [
    "Residential", "Commercial", "Mixed Use", "Industrial", "Public & Semi Public",
    "Dilapidated", "Under Construction", "Other", "Unclassified",
  ];
  return allowed.includes(value as PropertyTaxClass) ? value as PropertyTaxClass : null;
}

function canonicalUse(value: unknown, fallback: PropertyTaxClass): string | null {
  const raw = asText(value);
  if (!raw) return fallback === "Unclassified" ? null : fallback;
  const normalized = normalizeKey(raw);
  const hasResidential = normalized.includes("residential") || normalized === "r" || normalized === "res";
  const hasCommercial = normalized.includes("commercial") || normalized === "c" || normalized === "com" || normalized.includes("shop");
  if (normalized === "m" || normalized === "cr" || normalized === "rc" || normalized.includes("mixed") || (hasResidential && hasCommercial)) return "Mixed Use";
  if (hasResidential) return "Residential";
  if (hasCommercial) return "Commercial";
  if (normalized === "i" || normalized.includes("industrial") || normalized.includes("factory")) return "Industrial";
  if (normalized === "d" || normalized.includes("dilapidated") || normalized.includes("ruin")) return "Dilapidated";
  if (["p", "psp"].includes(normalized) || normalized.includes("public") || normalized.includes("semipublic") || normalized.includes("institution")) return "Public & Semi Public";
  if (normalized === "tc" || normalized.includes("transportcommunication")) return "Other";
  if (normalized.includes("underconstruction")) return "Under Construction";
  return raw;
}

export const INDICATIVE_PROPERTY_TAX_RATE_SOURCE = "Indicative GIS survey rate schedule 2026-27 · editable · not an official municipal rate";

const INDICATIVE_ANNUAL_RATES: Record<PropertyTaxClass, number> = {
  Residential: 12,
  Commercial: 30,
  "Mixed Use": 22,
  Industrial: 24,
  "Public & Semi Public": 8,
  Dilapidated: 5,
  "Under Construction": 6,
  Other: 10,
  Unclassified: 10,
};

export function indicativeAnnualRate(propertyUse: string | null): number {
  const normalized = canonicalUse(propertyUse, "Unclassified");
  const taxClass = asPropertyTaxClass(normalized) ?? "Unclassified";
  return INDICATIVE_ANNUAL_RATES[taxClass];
}

function floorLevelFactor(floorName: string, index: number): number {
  const normalized = normalizeKey(floorName);
  if (normalized.includes("basement") || normalized.includes("lowerground")) return 0.75;
  if (normalized.includes("ground") || index === 0) return 1;
  if (normalized.includes("first") || index === 1) return 0.9;
  if (normalized.includes("second") || index === 2) return 0.8;
  if (normalized.includes("third") || index === 3) return 0.75;
  return 0.7;
}

function inferConstructionFactor(value: string | null): number {
  const normalized = normalizeKey(value ?? "");
  if (!normalized || normalized.includes("notverified")) return 1;
  if (normalized.includes("rcc") || normalized.includes("pucca")) return 1;
  if (normalized.includes("loadbearing")) return 0.95;
  if (normalized.includes("semipucca")) return 0.8;
  if (normalized.includes("tin") || normalized.includes("sheet")) return 0.65;
  if (normalized.includes("kutcha")) return 0.6;
  if (normalized.includes("temporary")) return 0.5;
  if (normalized.includes("dilapidated")) return 0.4;
  return 1;
}

function inferZoneFactor(value: string | null): number {
  const normalized = normalizeKey(value ?? "");
  if (/^(zone)?a$/.test(normalized)) return 1.2;
  if (/^(zone)?b$/.test(normalized)) return 1;
  if (/^(zone)?c$/.test(normalized)) return 0.85;
  if (/^(zone)?d$/.test(normalized)) return 0.75;
  return 1;
}

function inferAgeFactor(attributes: Record<string, unknown>): { value: number; source: string | null } {
  const explicit = findValue(attributes, FIELD_CANDIDATES.ageFactor);
  const explicitValue = asNumber(explicit?.value);
  if (explicitValue !== null && explicitValue > 0) return { value: explicitValue, source: explicit?.key ?? null };
  const age = findValue(attributes, FIELD_CANDIDATES.buildingAge);
  let years = asNumber(age?.value);
  let source = age?.key ?? null;
  if (years === null) {
    const year = findValue(attributes, FIELD_CANDIDATES.constructionYear);
    const builtYear = asNumber(year?.value);
    if (builtYear !== null && builtYear >= 1800 && builtYear <= 2026) {
      years = 2026 - builtYear;
      source = year?.key ?? null;
    }
  }
  if (years === null) return { value: 1, source: null };
  if (years <= 5) return { value: 1, source };
  if (years <= 15) return { value: 0.95, source };
  if (years <= 30) return { value: 0.85, source };
  if (years <= 50) return { value: 0.75, source };
  return { value: 0.65, source };
}

function parseFloorCount(value: unknown): number | null {
  if (!isMeaningful(value)) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const raw = String(value).trim().toUpperCase().replace(/\s+/g, "");
  if (/^\d+(?:\.0+)?$/.test(raw)) return Math.max(0, Math.round(Number(raw)));

  const tokens = raw.split(/[+,/]/).filter(Boolean);
  let count = 0;
  let recognised = false;
  for (const token of tokens) {
    if (["G", "GF", "GROUND", "B", "BF", "BASEMENT", "LG", "UG"].includes(token)) {
      count += 1;
      recognised = true;
      continue;
    }
    if (["CT", "OT", "T", "TERRACE"].includes(token)) continue;
    const number = token.match(/^\d+$/);
    if (number) {
      count += Number(number[0]);
      recognised = true;
      continue;
    }
    if (/^(FF|FIRST)$/.test(token)) { count += 1; recognised = true; }
    else if (/^(SF|SECOND)$/.test(token)) { count += 1; recognised = true; }
    else if (/^(TF|THIRD)$/.test(token)) { count += 1; recognised = true; }
  }
  if (recognised && count > 0) return count;
  const parsed = asNumber(raw);
  return parsed === null ? null : Math.max(0, Math.round(parsed));
}

function approximateRingAreaSqm(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  const earthRadius = 6_378_137;
  const meanLat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  let twiceArea = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const currentX = earthRadius * (current[0] * Math.PI / 180) * cosLat;
    const currentY = earthRadius * (current[1] * Math.PI / 180);
    const nextX = earthRadius * (next[0] * Math.PI / 180) * cosLat;
    const nextY = earthRadius * (next[1] * Math.PI / 180);
    twiceArea += currentX * nextY - nextX * currentY;
  }
  return Math.abs(twiceArea) / 2;
}

function geometryAreaSqm(feature: UrbanFeature): number | null {
  if (feature.geometry.type === "Polygon") {
    const [outer, ...holes] = feature.geometry.coordinates;
    return Math.max(0, approximateRingAreaSqm(outer) - holes.reduce((sum, ring) => sum + approximateRingAreaSqm(ring), 0));
  }
  if (feature.geometry.type === "MultiPolygon") {
    return feature.geometry.coordinates.reduce((total, polygon) => {
      const [outer, ...holes] = polygon;
      return total + Math.max(0, approximateRingAreaSqm(outer) - holes.reduce((sum, ring) => sum + approximateRingAreaSqm(ring), 0));
    }, 0);
  }
  return null;
}

function inferFloorCount(attributes: Record<string, unknown>): { value: number | null; key: string | null } {
  const explicit = findValue(attributes, FIELD_CANDIDATES.floors);
  const parsed = explicit ? parseFloorCount(explicit.value) : null;
  if (parsed !== null) return { value: parsed, key: explicit?.key ?? null };

  const populated = FLOOR_FIELD_DEFINITIONS.flatMap((definition) => {
    const match = findValue(attributes, definition.keys);
    return match ? [match.key] : [];
  });
  return { value: populated.length || null, key: populated.length ? populated.join(", ") : null };
}

function extractFloorAssessments(
  attributes: Record<string, unknown>,
  footprintArea: number | null,
  builtUpArea: number | null,
  floorCount: number | null,
  fallbackUse: PropertyTaxClass,
): FloorTaxLine[] {
  const lines: FloorTaxLine[] = [];
  for (const definition of FLOOR_FIELD_DEFINITIONS) {
    const match = findValue(attributes, definition.keys);
    if (!match) continue;
    lines.push({
      floor_name: definition.name,
      property_use: canonicalUse(match.value, fallbackUse),
      area_sqm: footprintArea ?? (builtUpArea !== null && floorCount ? builtUpArea / floorCount : 0),
      annual_rate_per_sqm: null,
      usage_factor: 1,
    });
  }

  const upper = findValue(attributes, ["Upper_Floor_Information", "Upper Floor Information"]);
  if (upper && floorCount && lines.length < floorCount) {
    while (lines.length < floorCount) {
      lines.push({
        floor_name: `Floor ${lines.length}`,
        property_use: canonicalUse(upper.value, fallbackUse),
        area_sqm: footprintArea ?? (builtUpArea !== null ? builtUpArea / floorCount : 0),
        annual_rate_per_sqm: null,
        usage_factor: 1,
      });
    }
  }

  if (lines.length === 0 && floorCount && floorCount > 0) {
    const perFloorArea = footprintArea ?? (builtUpArea !== null ? builtUpArea / floorCount : 0);
    for (let index = 0; index < floorCount; index += 1) {
      lines.push({
        floor_name: index === 0 ? "Ground floor" : `Floor ${index}`,
        property_use: fallbackUse === "Unclassified" ? null : fallbackUse,
        area_sqm: perFloorArea,
        annual_rate_per_sqm: null,
        usage_factor: 1,
      });
    }
  }
  return lines.map((line, index) => ({
    ...line,
    area_sqm: Math.round(line.area_sqm * 100) / 100,
    annual_rate_per_sqm: line.annual_rate_per_sqm ?? indicativeAnnualRate(line.property_use),
    usage_factor: floorLevelFactor(line.floor_name, index),
  }));
}

function identifier(
  attributes: Record<string, unknown>,
  label: string,
  candidates: readonly string[],
): SurveyIdentifier | null {
  const match = findValue(attributes, candidates);
  const value = asText(match?.value);
  if (!match || !value) return null;
  return { label, value, source_field: match.key };
}

export function applySurveyEnrichmentToFeature(
  feature: UrbanFeature,
  enrichment: SurveyEnrichment | null,
): UrbanFeature {
  if (!enrichment || Object.keys(enrichment.plot_attributes).length === 0) return feature;
  const buildingAttributes = feature.properties.attributes ?? {};
  const attributes: Record<string, unknown> = { ...buildingAttributes };
  for (const [key, value] of Object.entries(enrichment.plot_attributes)) {
    if (!isMeaningful(value)) continue;
    if (!isMeaningful(attributes[key])) attributes[key] = value;
    else if (String(attributes[key]).trim() !== String(value).trim()) attributes[`Plot_${key}`] = value;
  }
  if (!isMeaningful(attributes.Plot_Geometry_Area_Sqm) && enrichment.plot_geometry_area_sqm !== null) {
    attributes.Plot_Geometry_Area_Sqm = enrichment.plot_geometry_area_sqm;
  }
  if (enrichment.plot_feature_id) attributes.Spatial_Plot_Feature_ID = enrichment.plot_feature_id;
  return { ...feature, properties: { ...feature.properties, attributes } };
}

export function buildGisTaxSnapshot(feature: UrbanFeature): GisTaxSnapshot {
  const attributes = feature.properties.attributes ?? {};
  const classification = classifyPropertyTaxFeature(feature);
  const propertyId = findValue(attributes, FIELD_CANDIDATES.propertyId);
  const assessmentNumber = findValue(attributes, FIELD_CANDIDATES.assessmentNumber);
  const ownerName = findValue(attributes, FIELD_CANDIDATES.ownerName);
  const taxZone = findValue(attributes, FIELD_CANDIDATES.taxZone);
  const surveyedUse = findValue(attributes, FIELD_CANDIDATES.propertyUse);
  const explicitTaxClass = asPropertyTaxClass(canonicalUse(surveyedUse?.value, classification.taxClass));
  const effectiveTaxClass = explicitTaxClass ?? classification.taxClass;
  const plot = findValue(attributes, FIELD_CANDIDATES.plotArea);
  const footprint = findValue(attributes, FIELD_CANDIDATES.footprint);
  const builtUp = findValue(attributes, FIELD_CANDIDATES.builtUp);
  const construction = findValue(attributes, FIELD_CANDIDATES.construction);
  const occupancy = findValue(attributes, FIELD_CANDIDATES.occupancy);
  const rate = findValue(attributes, FIELD_CANDIDATES.annualRate);
  const usageFactorField = findValue(attributes, FIELD_CANDIDATES.usageFactor);
  const zoneFactorField = findValue(attributes, FIELD_CANDIDATES.zoneFactor);
  const constructionFactorField = findValue(attributes, FIELD_CANDIDATES.constructionFactor);
  const cessField = findValue(attributes, FIELD_CANDIDATES.cessPercent);
  const serviceChargeField = findValue(attributes, FIELD_CANDIDATES.serviceCharge);
  const floors = inferFloorCount(attributes);

  const geometryFootprint = geometryAreaSqm(feature);
  const footprintArea = asNumber(footprint?.value) ?? geometryFootprint;
  const floorCount = floors.value;
  const builtUpArea = asNumber(builtUp?.value)
    ?? (footprintArea !== null && floorCount !== null && floorCount > 0 ? footprintArea * floorCount : footprintArea);
  const constructionType = canonicalConstruction(construction?.value);
  const occupancyStatus = canonicalOccupancy(occupancy?.value) ?? "Usage not verified";
  const explicitRate = asNumber(rate?.value);
  const annualRate = explicitRate !== null && explicitRate > 0 ? explicitRate : indicativeAnnualRate(effectiveTaxClass);
  const rateSource = rate?.key ?? INDICATIVE_PROPERTY_TAX_RATE_SOURCE;
  const ageFactor = inferAgeFactor(attributes);
  const usageFactor = asNumber(usageFactorField?.value) ?? 1;
  const zoneFactor = asNumber(zoneFactorField?.value) ?? inferZoneFactor(asText(taxZone?.value));
  const constructionFactor = asNumber(constructionFactorField?.value) ?? inferConstructionFactor(constructionType);

  const sourceFields: Record<string, string> = {
    property_use: surveyedUse?.key ?? classification.source,
  };
  if (propertyId) sourceFields.property_id = propertyId.key;
  if (assessmentNumber) sourceFields.assessment_number = assessmentNumber.key;
  if (ownerName) sourceFields.owner_name = ownerName.key;
  if (taxZone) sourceFields.tax_zone = taxZone.key;
  if (plot) sourceFields.plot_area = plot.key;
  if (footprint) sourceFields.footprint_area = footprint.key;
  else if (geometryFootprint !== null) sourceFields.footprint_area = "calculated from GIS geometry";
  if (builtUp) sourceFields.built_up_area = builtUp.key;
  else if (builtUpArea !== null) sourceFields.built_up_area = "footprint × floor count";
  if (floors.key) sourceFields.floor_count = floors.key;
  if (construction) sourceFields.construction_type = construction.key;
  if (occupancy) sourceFields.occupancy_status = occupancy.key;
  else sourceFields.occupancy_status = "default: Usage not verified";
  sourceFields.annual_rate_per_sqm = rateSource;
  sourceFields.usage_factor = usageFactorField?.key ?? "default: 1.00";
  sourceFields.zone_factor = zoneFactorField?.key ?? (taxZone?.key ? `derived from ${taxZone.key}` : "default: 1.00");
  sourceFields.construction_factor = constructionFactorField?.key ?? (construction?.key ? `derived from ${construction.key}` : "default: 1.00");
  sourceFields.age_factor = ageFactor.source ?? "default: 1.00";
  if (cessField) sourceFields.cess_percent = cessField.key;
  if (serviceChargeField) sourceFields.service_charge = serviceChargeField.key;

  const surveyAttributes = Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => isMeaningful(value))
      .map(([key, value]) => [key, String(value).trim()]),
  );

  const identifiers = [
    identifier(attributes, "Building name", FIELD_CANDIDATES.buildingName),
    identifier(attributes, "Building ID", FIELD_CANDIDATES.buildingId),
    identifier(attributes, "Plot ID", FIELD_CANDIDATES.plotId),
    identifier(attributes, "Premise ID", FIELD_CANDIDATES.premiseId),
    identifier(attributes, "Door number", FIELD_CANDIDATES.doorNumber),
    identifier(attributes, "SAS number", FIELD_CANDIDATES.sasNumber),
    identifier(attributes, "RR number", FIELD_CANDIDATES.rrNumber),
    identifier(attributes, "Water connection", FIELD_CANDIDATES.waterConnection),
    identifier(attributes, "Ward number", FIELD_CANDIDATES.wardNumber),
    identifier(attributes, "Block number", FIELD_CANDIDATES.blockNumber),
    identifier(attributes, "Survey number", FIELD_CANDIDATES.surveyNumber),
    identifier(attributes, "Owner mobile", FIELD_CANDIDATES.ownerMobile),
    identifier(attributes, "Owner email", FIELD_CANDIDATES.ownerEmail),
    identifier(attributes, "Tenant name", FIELD_CANDIDATES.tenantName),
    identifier(attributes, "CAD annotation", FIELD_CANDIDATES.cadText),
  ].filter((item): item is SurveyIdentifier => item !== null);

  const roundedFootprint = footprintArea !== null ? Math.round(footprintArea * 100) / 100 : null;
  const roundedBuiltUp = builtUpArea !== null ? Math.round(builtUpArea * 100) / 100 : null;

  return {
    feature_id: feature.properties.id,
    dataset_id: feature.properties.dataset_id,
    label: feature.properties.label ?? feature.properties.id.slice(0, 8),
    tax_class: effectiveTaxClass,
    classification_source: surveyedUse ? `attribute:${surveyedUse.key}` : classification.source,
    property_id: asText(propertyId?.value) ?? `GIS-${feature.properties.id.slice(0, 8).toUpperCase()}`,
    assessment_number: asText(assessmentNumber?.value),
    owner_name: asText(ownerName?.value),
    tax_zone: asText(taxZone?.value),
    plot_area_sqm: asNumber(plot?.value),
    footprint_area_sqm: roundedFootprint,
    built_up_area_sqm: roundedBuiltUp,
    floor_count: floorCount,
    construction_type: constructionType,
    occupancy_status: occupancyStatus,
    floor_assessments: extractFloorAssessments(attributes, roundedFootprint, roundedBuiltUp, floorCount, effectiveTaxClass),
    identifiers,
    source_fields: sourceFields,
    survey_attributes: surveyAttributes,
    populated_field_count: Object.keys(surveyAttributes).length,
    indicative_rate_per_sqm: annualRate,
    indicative_rate_source: rateSource,
    usage_factor: usageFactor,
    zone_factor: zoneFactor,
    construction_factor: constructionFactor,
    age_factor: ageFactor.value,
  };
}

export function blankAssessmentPayload(snapshot: GisTaxSnapshot): PropertyTaxAssessmentPayload {
  return {
    status: "not_assessed",
    property_id: snapshot.property_id,
    assessment_number: snapshot.assessment_number,
    owner_name: snapshot.owner_name,
    occupancy_status: snapshot.occupancy_status,
    construction_type: snapshot.construction_type,
    tax_zone: snapshot.tax_zone,
    municipal_use: snapshot.tax_class === "Unclassified" ? null : snapshot.tax_class,
    municipal_plot_area_sqm: snapshot.plot_area_sqm,
    municipal_built_up_area_sqm: snapshot.built_up_area_sqm,
    municipal_floor_count: snapshot.floor_count,
    municipal_record_id: null,
    financial_year: "2026-27",
    discrepancy_status: "not_reviewed",
    floor_assessments: snapshot.floor_assessments,
    annual_rate_per_sqm: snapshot.indicative_rate_per_sqm,
    usage_factor: snapshot.usage_factor,
    zone_factor: snapshot.zone_factor,
    construction_factor: snapshot.construction_factor,
    age_factor: snapshot.age_factor,
    cess_percent: 0,
    service_charge: 0,
    rebate_amount: 0,
    exemption_amount: 0,
    base_annual_tax: null,
    estimated_annual_tax: null,
    remarks: null,
    gis_snapshot: snapshot,
  };
}

export function hydratePayloadFromGisSurvey(
  current: PropertyTaxAssessmentPayload,
  snapshot: GisTaxSnapshot,
): PropertyTaxAssessmentPayload {
  const currentFloorsAreUsable = current.floor_assessments.some((line) => (
    line.area_sqm > 0
    && (
      isMeaningful(line.property_use)
      || (line.annual_rate_per_sqm !== null && line.annual_rate_per_sqm > 0)
    )
  ));
  const surveyUse = snapshot.tax_class === "Unclassified" ? null : snapshot.tax_class;
  const preferText = (currentValue: string | null, surveyValue: string | null) => (
    isMeaningful(currentValue) ? String(currentValue).trim() : surveyValue
  );
  const preferPositive = (currentValue: number | null, surveyValue: number | null) => (
    currentValue !== null && Number.isFinite(currentValue) && currentValue > 0 ? currentValue : surveyValue
  );

  return {
    ...current,
    property_id: preferText(current.property_id, snapshot.property_id),
    assessment_number: preferText(current.assessment_number, snapshot.assessment_number),
    owner_name: preferText(current.owner_name, snapshot.owner_name),
    occupancy_status: preferText(current.occupancy_status, snapshot.occupancy_status),
    construction_type: preferText(current.construction_type, snapshot.construction_type),
    tax_zone: preferText(current.tax_zone, snapshot.tax_zone),
    municipal_use: preferText(current.municipal_use, surveyUse),
    municipal_plot_area_sqm: preferPositive(current.municipal_plot_area_sqm, snapshot.plot_area_sqm),
    municipal_built_up_area_sqm: preferPositive(current.municipal_built_up_area_sqm, snapshot.built_up_area_sqm),
    municipal_floor_count: preferPositive(current.municipal_floor_count, snapshot.floor_count),
    floor_assessments: currentFloorsAreUsable ? current.floor_assessments : snapshot.floor_assessments,
    annual_rate_per_sqm: preferPositive(current.annual_rate_per_sqm, snapshot.indicative_rate_per_sqm),
    usage_factor: current.usage_factor > 0 ? current.usage_factor : snapshot.usage_factor,
    zone_factor: current.zone_factor > 0 ? current.zone_factor : snapshot.zone_factor,
    construction_factor: current.construction_factor > 0 ? current.construction_factor : snapshot.construction_factor,
    age_factor: current.age_factor > 0 ? current.age_factor : snapshot.age_factor,
    municipal_record_id: current.municipal_record_id,
    gis_snapshot: snapshot,
  };
}

export function applyMunicipalRecordToPayload(
  current: PropertyTaxAssessmentPayload,
  record: MunicipalPropertyRecord,
  snapshot: GisTaxSnapshot,
): PropertyTaxAssessmentPayload {
  return hydratePayloadFromGisSurvey({
    ...current,
    status: current.status === "not_assessed" ? "draft" : current.status,
    municipal_record_id: record.id,
    property_id: record.property_id ?? current.property_id,
    assessment_number: record.assessment_number ?? current.assessment_number,
    owner_name: record.owner_name ?? current.owner_name,
    occupancy_status: record.occupancy_status ?? current.occupancy_status,
    construction_type: record.construction_type ?? current.construction_type,
    tax_zone: record.tax_zone ?? current.tax_zone,
    municipal_use: record.municipal_use ?? current.municipal_use,
    municipal_plot_area_sqm: record.municipal_plot_area_sqm ?? current.municipal_plot_area_sqm,
    municipal_built_up_area_sqm: record.municipal_built_up_area_sqm ?? current.municipal_built_up_area_sqm,
    municipal_floor_count: record.municipal_floor_count ?? current.municipal_floor_count,
    annual_rate_per_sqm: record.annual_rate_per_sqm ?? current.annual_rate_per_sqm,
    financial_year: record.financial_year ?? current.financial_year,
    gis_snapshot: snapshot,
  }, snapshot);
}

export function calculatePropertyTax(payload: PropertyTaxAssessmentPayload): TaxCalculation {
  let areaRateBase: number | null = null;
  let mode: TaxCalculation["calculationMode"] = "incomplete";
  const usableFloors = payload.floor_assessments.filter((line) => {
    const rate = line.annual_rate_per_sqm ?? payload.annual_rate_per_sqm;
    return line.area_sqm > 0 && rate !== null;
  });
  if (usableFloors.length > 0) {
    areaRateBase = usableFloors.reduce((sum, line) => {
      const rate = line.annual_rate_per_sqm ?? payload.annual_rate_per_sqm ?? 0;
      return sum + line.area_sqm * rate * line.usage_factor;
    }, 0);
    mode = "floor_wise";
  } else if (payload.municipal_built_up_area_sqm !== null && payload.annual_rate_per_sqm !== null) {
    areaRateBase = payload.municipal_built_up_area_sqm * payload.annual_rate_per_sqm * payload.usage_factor;
    mode = "whole_building";
  }
  if (areaRateBase === null) return { baseTax: null, cessAmount: null, totalTax: null, calculationMode: mode };
  const baseTax = areaRateBase * payload.zone_factor * payload.construction_factor * payload.age_factor;
  const cessAmount = baseTax * payload.cess_percent / 100;
  const totalTax = Math.max(0, baseTax + cessAmount + payload.service_charge - payload.rebate_amount - payload.exemption_amount);
  const round = (value: number) => Math.round(value * 100) / 100;
  return { baseTax: round(baseTax), cessAmount: round(cessAmount), totalTax: round(totalTax), calculationMode: mode };
}

export function calculateEstimatedAnnualTax(payload: PropertyTaxAssessmentPayload): number | null {
  return calculatePropertyTax(payload).totalTax;
}

export async function fetchSurveyEnrichment(featureId: string, signal?: AbortSignal) {
  return apiGet<SurveyEnrichment>(`/api/v1/property-tax/survey-enrichment/${featureId}`, signal);
}

export async function fetchPropertyTaxAssessment(featureId: string, signal?: AbortSignal) {
  return apiGet<PropertyTaxAssessment | null>(`/api/v1/property-tax/assessments/${featureId}`, signal);
}

export async function savePropertyTaxAssessment(featureId: string, payload: PropertyTaxAssessmentPayload, signal?: AbortSignal) {
  return apiPut<PropertyTaxAssessment>(`/api/v1/property-tax/assessments/${featureId}`, payload, signal);
}

export async function fetchPropertyTaxAssessmentHistory(featureId: string, signal?: AbortSignal) {
  return apiGet<PropertyTaxAssessmentRevision[]>(`/api/v1/property-tax/assessments/${featureId}/history`, signal);
}

export async function fetchLinkedMunicipalRecord(featureId: string, signal?: AbortSignal) {
  return apiGet<MunicipalPropertyRecord | null>(`/api/v1/property-tax/municipal-records/linked/${featureId}`, signal);
}

export async function fetchMunicipalRecordSuggestions(featureId: string, signal?: AbortSignal) {
  const result = await apiGet<{ records: MunicipalPropertyRecord[]; count: number }>(`/api/v1/property-tax/municipal-records/suggestions/${featureId}`, signal);
  return result.records;
}

export async function searchMunicipalRecords(datasetId: string, query: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ dataset_id: datasetId, q: query, unlinked_only: "true" });
  const result = await apiGet<{ records: MunicipalPropertyRecord[]; count: number }>(`/api/v1/property-tax/municipal-records/search?${params.toString()}`, signal);
  return result.records;
}

export function downloadMunicipalRegisterTemplate(): void {
  const headers = [
    "gis_feature_id", "property_id", "assessment_number", "sas_number", "door_number",
    "owner_name", "owner_mobile", "address", "property_use", "occupancy_status",
    "construction_type", "tax_zone", "plot_area_sqm", "built_up_area_sqm", "floor_count",
    "annual_rate_per_sqm", "financial_year", "latitude", "longitude",
  ];
  const example = [
    "", "PID-EXAMPLE-001", "ASM-EXAMPLE-001", "", "12/A", "Example Owner", "",
    "Example street", "Residential", "Owner occupied", "RCC framed", "A", "120", "180",
    "2", "", "2026-27", "", "",
  ];
  const csv = `${headers.join(",")}\n${example.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "municipal_property_register_template.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function importMunicipalRecords(datasetId: string, file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append("dataset_id", datasetId);
  form.append("file", file);
  return apiPostForm<MunicipalRecordImportResult>("/api/v1/property-tax/municipal-records/import", form, signal);
}

export async function linkMunicipalRecord(recordId: string, featureId: string, signal?: AbortSignal) {
  return apiPut<MunicipalPropertyRecord>(`/api/v1/property-tax/municipal-records/${recordId}/link/${featureId}`, { copy_to_assessment: true }, signal);
}

export async function unlinkMunicipalRecord(recordId: string, signal?: AbortSignal) {
  return apiDelete(`/api/v1/property-tax/municipal-records/${recordId}/link`, signal);
}

export async function fetchPropertyTaxDemand(featureId: string, signal?: AbortSignal) {
  return apiGet<PropertyTaxDemand | null>(`/api/v1/property-tax/demands/${featureId}`, signal);
}

export async function generatePropertyTaxDemand(featureId: string, signal?: AbortSignal) {
  return apiPost<PropertyTaxDemand>(`/api/v1/property-tax/assessments/${featureId}/generate-demand`, {}, signal);
}

const LOCAL_PREFIX = "urban-property-tax-phase3-gis-fallback:";
const LEGACY_LOCAL_PREFIXES = ["urban-property-tax-phase3:", "urban-property-tax-phase2:"];

export function loadLocalPropertyTaxDraft(featureId: string): PropertyTaxAssessmentPayload | null {
  try {
    const keys = [`${LOCAL_PREFIX}${featureId}`, ...LEGACY_LOCAL_PREFIXES.map((prefix) => `${prefix}${featureId}`)];
    const raw = keys.map((key) => window.localStorage.getItem(key)).find(Boolean);
    if (!raw) return null;
    return JSON.parse(raw) as PropertyTaxAssessmentPayload;
  } catch {
    return null;
  }
}

export function saveLocalPropertyTaxDraft(featureId: string, payload: PropertyTaxAssessmentPayload): void {
  try {
    window.localStorage.setItem(`${LOCAL_PREFIX}${featureId}`, JSON.stringify(payload));
  } catch {
    // Local fallback is best-effort only.
  }
}

export function isOfflineAssessmentError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}
