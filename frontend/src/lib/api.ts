/**
 * Thin fetch wrapper.
 * - Reads the API base from Vite env.
 * - Always sends cookies so the JWT auth flow works.
 * - Attaches an AbortSignal per call so callers can cancel in-flight
 *   requests when the map view changes rapidly.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const contentType = res.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body);
  }
  return body as T;
}

export async function apiDelete(path: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    const body: unknown = contentType.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => null);
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body);
  }
}

export async function apiPost<T>(
  path: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body);
  }
  return body as T;
}
