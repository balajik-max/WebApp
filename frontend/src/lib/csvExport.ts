// Standards-compliant CSV generation and download for the Attribute Table.
// No external dependency is required; escaping follows RFC 4180.

function isGeometric(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type === "string" && /point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection/i.test(v.type)) {
    return true;
  }
  if (Array.isArray(v.coordinates)) return true;
  if (typeof v.geometry === "object" && v.geometry !== null) return true;
  if (Array.isArray(v.bbox)) return true;
  return false;
}

// Convert any attribute value into a flat, spreadsheet-safe string.
export function normalizeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    // Geometry objects must never be exported.
    if (isGeometric(value)) return "";
    if (Array.isArray(value)) {
      return value.map((item) => normalizeCsvValue(item)).join("; ");
    }
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? "" : serialized;
    } catch {
      // Circular references or non-serializable objects are omitted.
      return "";
    }
  }
  return String(value);
}

function escapeCsvField(field: string): string {
  if (field === "") return "";
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

// Build a UTF-8 CSV string with a BOM so Excel opens it correctly.
export function buildCsv(headers: string[], rows: string[][]): string {
  const lines: string[] = [];
  lines.push(headers.map((header) => escapeCsvField(normalizeCsvValue(header))).join(","));
  for (const row of rows) {
    lines.push(row.map((cell) => escapeCsvField(cell)).join(","));
  }
  return "﻿" + lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke after the download has had time to start so Blob URLs do not leak.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function sanitizeLayerName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function csvTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
}
