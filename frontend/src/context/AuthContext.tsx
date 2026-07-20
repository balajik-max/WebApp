/**
 * AuthContext — thin session store backed by /api/auth/me + /api/auth/login.
 *
 * The backend already sets httpOnly cookies on login and reads them on
 * every subsequent request, so we don't have to persist the token in JS.
 * We *do* persist the last-known user object so the UI can render its
 * chrome without a round-trip on cold boot.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, ApiError } from "../lib/api";

export type Role = "commissioner" | "aee" | "ae" | "mla";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  created_at: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const STORAGE_KEY = "davangere.user";

function readCache(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}
function writeCache(u: AuthUser | null) {
  try {
    if (u) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(readCache);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await apiGet<AuthUser>("/api/auth/me");
      setUser(me);
      writeCache(me);
      setError(null);
    } catch (e) {
      // 401 is expected before login — clear cache silently.
      if (e instanceof ApiError && e.status === 401) {
        setUser(null);
        writeCache(null);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    setError(null);
    const res = await apiPost<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      user: AuthUser;
    }>("/api/auth/login", { email, password });
    setUser(res.user);
    writeCache(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiPost<{ ok: boolean }>("/api/auth/logout", {});
    } catch {
      /* ignore — clear session locally either way */
    }
    setUser(null);
    writeCache(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, error, login, logout, refresh }),
    [user, loading, error, login, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
