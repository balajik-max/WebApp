import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  fetchPublicMe,
  loginPublicUser,
  logoutPublicUser,
  type PublicUser,
} from "../lib/publicPortal";

interface PublicAuthContextValue {
  publicUser: PublicUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<PublicUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setRegisteredUser: (user: PublicUser) => void;
}

const PublicAuthContext = createContext<PublicAuthContextValue | undefined>(undefined);
const STORAGE_KEY = "davangere.public-user";

function readCachedUser(): PublicUser | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PublicUser) : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: PublicUser | null) {
  try {
    if (user) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in hardened/private browser modes.
  }
}

export function PublicAuthProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isPublicRoute =
    location.pathname.startsWith("/public/") ||
    location.pathname === "/create-account";
  const [publicUser, setPublicUser] = useState<PublicUser | null>(readCachedUser);
  const [loading, setLoading] = useState(isPublicRoute);

  const clear = useCallback(() => {
    setPublicUser(null);
    writeCachedUser(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const user = await fetchPublicMe();
      setPublicUser(user);
      writeCachedUser(user);
    } catch {
      clear();
    } finally {
      setLoading(false);
    }
  }, [clear]);

  useEffect(() => {
    if (isPublicRoute) {
      void refresh();
    } else {
      setLoading(false);
    }
  }, [isPublicRoute, refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await loginPublicUser(username, password);
    setPublicUser(result.user);
    writeCachedUser(result.user);
    return result.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutPublicUser();
    } catch {
      // Public sign-out must still clear the isolated local session when the
      // server is unavailable; officer auth state is never touched here.
    } finally {
      clear();
    }
  }, [clear]);

  const setRegisteredUser = useCallback((user: PublicUser) => {
    setPublicUser(user);
    writeCachedUser(user);
  }, []);

  const value = useMemo(
    () => ({ publicUser, loading, login, logout, refresh, setRegisteredUser }),
    [publicUser, loading, login, logout, refresh, setRegisteredUser],
  );

  return <PublicAuthContext.Provider value={value}>{children}</PublicAuthContext.Provider>;
}

export function usePublicAuth() {
  const value = useContext(PublicAuthContext);
  if (!value) throw new Error("usePublicAuth must be used inside PublicAuthProvider");
  return value;
}
