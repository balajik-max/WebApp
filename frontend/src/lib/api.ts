/**
 * Thin fetch wrapper.
 * - Reads the API base from Vite env.
 * - Always sends cookies so the JWT auth flow works.
 * - Attaches an AbortSignal per call so callers can cancel in-flight
 *   requests when the map view changes rapidly.
 * - On a 401, silently exchanges the httpOnly refresh-token cookie for a
 *   fresh access token (POST /api/auth/refresh) and retries once. The
 *   access token is short-lived (24h); without this, any tab left open
 *   past that window would 401 on every request until a manual re-login.
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

let refreshInFlight: Promise<boolean> | null = null;

function attemptRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function doFetch(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (res.status !== 401 || path === "/api/auth/login" || path === "/api/auth/refresh") {
    return res;
  }
  const refreshed = await attemptRefresh();
  if (!refreshed) return res;
  return fetch(`${API_BASE}${path}`, init);
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await doFetch(path, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body);
  }
  return body as T;
}

export async function apiDelete(path: string, signal?: AbortSignal): Promise<void> {
  const res = await doFetch(path, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    const body = await parseBody(res);
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body);
  }
}

export async function apiPost<T>(
  path: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<T> {
  const res = await doFetch(path, {
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

export async function apiPatch<T>(
  path: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<T> {
  const res = await doFetch(path, {
    method: "PATCH",
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

export async function apiPut<T>(
  path: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<T> {
  const res = await doFetch(path, {
    method: "PUT",
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

export interface ApiDownloadResult {
  blob: Blob;
  filename: string | null;
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].replace(/^"|"$/g, ""));
    } catch {
      return encoded[1].replace(/^"|"$/g, "");
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain?.[1]?.trim() ?? null;
}

export async function apiDownload(
  path: string,
  signal?: AbortSignal
): Promise<ApiDownloadResult> {
  const res = await doFetch(path, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "*/*" },
    signal,
  });
  if (!res.ok) {
    const body = await parseBody(res);
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, body);
  }
  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get("content-disposition")),
  };
}
