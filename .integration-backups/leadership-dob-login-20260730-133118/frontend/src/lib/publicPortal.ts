import { apiGet, apiPost } from "./api";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export class PublicApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface PublicUser {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  username: string;
  created_at: string;
}

export type PublicComplaintStatus =
  | "submitted"
  | "received"
  | "viewed_by_commissioner"
  | "in_review"
  | "resolved";

export interface PublicComplaint {
  id: string;
  title: string;
  description: string;
  status: PublicComplaintStatus;
  latitude: number;
  longitude: number;
  location_accuracy_m: number | null;
  location_label: string | null;
  location_source: "image_exif" | "browser_geolocation" | null;
  image_url: string;
  commissioner_viewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicNotification {
  id: string;
  complaint_id: string | null;
  kind: "complaint_submitted" | "commissioner_viewed" | "status_changed";
  message: string;
  read_at: string | null;
  created_at: string;
}

export interface OfficerPublicComplaintNotification {
  notification_id: string;
  complaint_id: string;
  title: string;
  message: string;
  created_at: string;
  read_at: string | null;
}

export interface OfficerPublicComplaint extends PublicComplaint {
  public_user_name: string;
  public_username: string;
  public_phone: string;
  image_exif_latitude: number | null;
  image_exif_longitude: number | null;
  submitted_ip: string | null;
  submitted_user_agent: string | null;
}

let publicRefreshInFlight: Promise<boolean> | null = null;

function publicRefresh(): Promise<boolean> {
  if (!publicRefreshInFlight) {
    publicRefreshInFlight = fetch(`${API_BASE}/api/public/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        publicRefreshInFlight = null;
      });
  }
  return publicRefreshInFlight;
}

async function parseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? response.json().catch(() => null)
    : response.text().catch(() => null);
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return fallback;
}

async function publicFetch(path: string, init: RequestInit, retry = true): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (
    response.status !== 401 ||
    !retry ||
    path === "/api/public/auth/login" ||
    path === "/api/public/auth/register" ||
    path === "/api/public/auth/request-otp" ||
    path === "/api/public/auth/verify-otp" ||
    path === "/api/public/auth/refresh"
  ) {
    return response;
  }
  if (!(await publicRefresh())) return response;
  return publicFetch(path, init, false);
}

async function publicJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await publicFetch(path, {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
  });
  const body = await parseBody(response);
  if (!response.ok) {
    throw new PublicApiError(
      response.status,
      messageFromBody(body, `${response.status} ${response.statusText}`),
      body,
    );
  }
  return body as T;
}

export function publicAssetUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path}`;
}

export function requestPublicOtp(phone: string, email: string) {
  return publicJson<{
    challenge_id: string;
    expires_at: string;
    resend_after_seconds: number;
    masked_email: string;
    debug_otp: string | null;
  }>("/api/public/auth/request-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, email }),
  });
}

export function verifyPublicOtp(challengeId: string, otp: string) {
  return publicJson<{
    challenge_id: string;
    registration_token: string;
    registration_token_expires_at: string;
    masked_email: string;
  }>("/api/public/auth/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge_id: challengeId, otp }),
  });
}

export function checkPublicUsername(username: string) {
  return publicJson<{ username: string; available: boolean }>(
    `/api/public/auth/username-availability?username=${encodeURIComponent(username)}`,
    { method: "GET" },
  );
}

export interface PublicRegisterPayload {
  challenge_id: string;
  registration_token: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  username: string;
  password: string;
  confirm_password: string;
  screen_width?: number;
  screen_height?: number;
}

export function registerPublicUser(payload: PublicRegisterPayload) {
  return publicJson<{ user: PublicUser }>("/api/public/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function loginPublicUser(username: string, password: string) {
  return publicJson<{ user: PublicUser }>("/api/public/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      screen_width: window.screen?.width,
      screen_height: window.screen?.height,
    }),
  });
}

export function fetchPublicMe() {
  return publicJson<PublicUser>("/api/public/auth/me", { method: "GET" });
}

export function logoutPublicUser() {
  return publicJson<{ ok: boolean }>("/api/public/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export function submitPublicComplaint(form: FormData) {
  return publicJson<PublicComplaint>("/api/public/complaints", {
    method: "POST",
    body: form,
  });
}

export interface PublicImageMetadata {
  filename: string;
  size_bytes: number;
  content_type: string;
  has_geotag: boolean;
  latitude: number | null;
  longitude: number | null;
  captured_at: string | null;
}

export function inspectPublicComplaintImage(image: File) {
  const form = new FormData();
  form.append("image", image);
  return publicJson<PublicImageMetadata>("/api/public/complaints/image-metadata", {
    method: "POST",
    body: form,
  });
}

export function fetchPublicComplaints(signal?: AbortSignal) {
  return publicJson<PublicComplaint[]>("/api/public/complaints", { method: "GET", signal });
}

export function fetchPublicNotifications(signal?: AbortSignal) {
  return publicJson<PublicNotification[]>("/api/public/notifications", { method: "GET", signal });
}

export function markPublicNotificationRead(notificationId: string) {
  return publicJson<{ ok: boolean }>(
    `/api/public/notifications/${encodeURIComponent(notificationId)}/read`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
}

export function fetchOfficerPublicComplaintNotifications(signal?: AbortSignal) {
  return apiGet<OfficerPublicComplaintNotification[]>(
    "/api/public/officer/notifications",
    signal,
  );
}

export function markOfficerPublicComplaintNotificationRead(notificationId: string) {
  return apiPost<{ ok: boolean }>(
    `/api/public/officer/notifications/${encodeURIComponent(notificationId)}/read`,
    {},
  );
}

export function fetchOfficerPublicComplaint(complaintId: string, signal?: AbortSignal) {
  return apiGet<OfficerPublicComplaint>(
    `/api/public/officer/complaints/${encodeURIComponent(complaintId)}`,
    signal,
  );
}

export type PublicDatasetStatus = "uploaded" | "queued" | "processing" | "ready" | "failed";

export interface PublicDataset {
  id: string;
  name: string;
  description: string | null;
  file_type: "geojson" | "shapefile" | "kml" | "csv" | "geotiff" | "las" | "lidar" | "image" | "other";
  status: PublicDatasetStatus;
  size_bytes: number | null;
  processing_error: string | null;
  dataset_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PublicDatasetLayer {
  name: string;
  feature_count: number;
}

export interface PublicDatasetBounds {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

export interface PublicFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id: string;
    geometry: Record<string, unknown> | null;
    properties: {
      id: string;
      dataset_id: string;
      label: string | null;
      category: string;
      source_layer: string;
      attributes: Record<string, unknown>;
    };
  }>;
  count: number;
  limit: number;
  truncated: boolean;
}

export function fetchPublicDatasets(signal?: AbortSignal) {
  return publicJson<PublicDataset[]>("/api/public/datasets", { method: "GET", signal });
}

export function fetchPublicDataset(datasetId: string, signal?: AbortSignal) {
  return publicJson<PublicDataset>(`/api/public/datasets/${encodeURIComponent(datasetId)}`, {
    method: "GET",
    signal,
  });
}

export function uploadPublicDataset(file: File, name: string, description?: string) {
  const form = new FormData();
  form.append("file", file);
  form.append("name", name);
  if (description?.trim()) form.append("description", description.trim());
  return publicJson<{ dataset: PublicDataset; poll_url: string }>("/api/public/datasets/upload", {
    method: "POST",
    body: form,
  });
}

export async function deletePublicDataset(datasetId: string): Promise<void> {
  const response = await publicFetch(
    `/api/public/datasets/${encodeURIComponent(datasetId)}`,
    { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    const body = await parseBody(response);
    throw new PublicApiError(
      response.status,
      messageFromBody(body, `${response.status} ${response.statusText}`),
      body,
    );
  }
}

export function fetchPublicDatasetLayers(datasetId: string, signal?: AbortSignal) {
  return publicJson<PublicDatasetLayer[]>(
    `/api/public/datasets/${encodeURIComponent(datasetId)}/layers`,
    { method: "GET", signal },
  );
}

export function fetchPublicDatasetBounds(datasetId: string, signal?: AbortSignal) {
  return publicJson<PublicDatasetBounds>(
    `/api/public/datasets/${encodeURIComponent(datasetId)}/bounds`,
    { method: "GET", signal },
  );
}

export function fetchPublicDatasetFeatures(
  datasetId: string,
  layers: string[] = [],
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "100000" });
  for (const layer of layers) params.append("layer", layer);
  const query = params.toString();
  return publicJson<PublicFeatureCollection>(
    `/api/public/datasets/${encodeURIComponent(datasetId)}/features${query ? `?${query}` : ""}`,
    { method: "GET", signal },
  );
}
